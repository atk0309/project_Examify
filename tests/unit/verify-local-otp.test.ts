import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `local-otp-${process.pid}.db`);
const OUTBOX = path.join(TMP, `outbox-local-otp-${process.pid}`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
Reflect.set(process.env, 'MAIL_OUTBOX_DIR', OUTBOX);
delete process.env.FAMILIES;

const sessionHolder = vi.hoisted(() => ({
  current: {} as SessionData & { save: () => Promise<void> },
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    getRawSession: async () => sessionHolder.current,
    getSession: async () => sessionHolder.current,
  };
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '203.0.113.55' }),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { url });
  },
}));

beforeAll(() => {
  fs.mkdirSync(TMP, { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  migrate(drizzle(sqlite), {
    migrationsFolder: path.join(process.cwd(), 'src', 'lib', 'db', 'migrations'),
  });
  sqlite.close();
});

afterAll(() => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
});

afterEach(async () => {
  const { env } = await import('@/lib/env');
  (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
});

beforeEach(async () => {
  const { db, schema } = await import('@/lib/db');
  const { resetLegacyImportLatch } = await import('@/lib/households');
  db.delete(schema.rateLimitEvents).run();
  db.delete(schema.magicTokens).run();
  db.delete(schema.householdInvites).run();
  db.delete(schema.householdMembers).run();
  db.delete(schema.households).run();
  db.delete(schema.users).run();
  resetLegacyImportLatch();
  sessionHolder.current = { save: vi.fn(async () => {}) };
  const { env } = await import('@/lib/env');
  (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'local-otp';
  (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
  (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY = undefined;
  if (fs.existsSync(OUTBOX)) fs.rmSync(OUTBOX, { recursive: true, force: true });
});

async function seedParent() {
  const { bootstrapHousehold } = await import('@/lib/households');
  const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
  if (!host.ok) throw new Error('bootstrap failed');
  return host;
}

function requestForm(email: string, role: 'student' | 'parent' = 'parent'): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('role', role);
  return data;
}

function otpForm(email: string, code: string, role: 'student' | 'parent' = 'parent'): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('role', role);
  data.set('code', code);
  return data;
}

async function latestCode(): Promise<string> {
  const files = await fs.promises.readdir(OUTBOX);
  const json = files.filter((name) => name.endsWith('.json')).sort();
  if (json.length === 0) throw new Error('outbox empty');
  const payload = JSON.parse(
    await fs.promises.readFile(path.join(OUTBOX, json.at(-1)!), 'utf8'),
  ) as {
    code?: string;
  };
  if (!payload.code) throw new Error('no code in outbox');
  return payload.code;
}

describe('local-otp auth', () => {
  it('issues a code for a member and verifies it into a session', async () => {
    await seedParent();
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    const { verifyLocalOtp } = await import('@/actions/verifyLocalOtp');

    const sent = await requestMagicLink({ status: 'idle' }, requestForm('pat@example.com'));
    expect(sent).toEqual({ status: 'sent', email: 'pat@example.com' });
    const code = await latestCode();
    expect(code).toMatch(/^\d{6}$/);

    await expect(
      verifyLocalOtp({ status: 'idle' }, otpForm('pat@example.com', code)),
    ).rejects.toMatchObject({ url: '/' });
    expect(sessionHolder.current.email).toBe('pat@example.com');
    expect(sessionHolder.current.role).toBe('parent');
    expect(sessionHolder.current.save).toHaveBeenCalledOnce();
  });

  it('returns generic sent (no outbox write) for an unknown email', async () => {
    await seedParent();
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    const sent = await requestMagicLink({ status: 'idle' }, requestForm('ghost@example.com'));
    expect(sent).toEqual({ status: 'sent', email: 'ghost@example.com' });
    expect(fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).length : 0).toBe(0);
  });

  it('rejects a wrong code without leaking whether one was issued', async () => {
    await seedParent();
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    const { verifyLocalOtp } = await import('@/actions/verifyLocalOtp');
    await requestMagicLink({ status: 'idle' }, requestForm('pat@example.com'));
    const state = await verifyLocalOtp({ status: 'idle' }, otpForm('pat@example.com', '000000'));
    expect(state).toEqual({ status: 'error', reason: 'invalid' });
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
  });

  it('consumes the challenge after five well-formed wrong guesses', async () => {
    await seedParent();
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    const { verifyLocalOtp } = await import('@/actions/verifyLocalOtp');
    const { OTP_GUESS_MAX } = await import('@/lib/auth');
    await requestMagicLink({ status: 'idle' }, requestForm('pat@example.com'));
    const code = await latestCode();
    for (let i = 0; i < OTP_GUESS_MAX; i++) {
      const guess = String(i).padStart(6, '0');
      const wrong = guess === code ? '999999' : guess;
      const state = await verifyLocalOtp({ status: 'idle' }, otpForm('pat@example.com', wrong));
      expect(state).toEqual({ status: 'error', reason: 'invalid' });
    }
    await expect(
      verifyLocalOtp({ status: 'idle' }, otpForm('pat@example.com', code)),
    ).resolves.toEqual({ status: 'error', reason: 'invalid' });
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
  });

  it('does not count a non-six-digit guess toward the lock', async () => {
    await seedParent();
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    const { verifyLocalOtp } = await import('@/actions/verifyLocalOtp');
    const { OTP_GUESS_MAX } = await import('@/lib/auth');
    await requestMagicLink({ status: 'idle' }, requestForm('pat@example.com'));
    const code = await latestCode();
    for (let i = 0; i < OTP_GUESS_MAX; i++) {
      const state = await verifyLocalOtp({ status: 'idle' }, otpForm('pat@example.com', 'abc'));
      expect(state).toEqual({ status: 'error', reason: 'invalid' });
    }
    await expect(
      verifyLocalOtp({ status: 'idle' }, otpForm('pat@example.com', code)),
    ).rejects.toMatchObject({ url: '/' });
  });

  it('revokes the previous unused code when a new one is issued', async () => {
    await seedParent();
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    const { verifyLocalOtp } = await import('@/actions/verifyLocalOtp');
    await requestMagicLink({ status: 'idle' }, requestForm('pat@example.com'));
    const first = await latestCode();
    await requestMagicLink({ status: 'idle' }, requestForm('pat@example.com'));
    const second = await latestCode();
    expect(second).not.toBe(first);
    const stale = await verifyLocalOtp({ status: 'idle' }, otpForm('pat@example.com', first));
    expect(stale).toEqual({ status: 'error', reason: 'invalid' });
    await expect(
      verifyLocalOtp({ status: 'idle' }, otpForm('pat@example.com', second)),
    ).rejects.toMatchObject({ url: '/' });
  });

  it('refuses verify when AUTH_MODE is not local-otp', async () => {
    const { env } = await import('@/lib/env');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    const { verifyLocalOtp } = await import('@/actions/verifyLocalOtp');
    const state = await verifyLocalOtp({ status: 'idle' }, otpForm('pat@example.com', '123456'));
    expect(state).toEqual({ status: 'error', reason: 'invalid' });
  });

  it('invalidates the issued OTP when sendEmail fails after issue', async () => {
    await seedParent();
    const email = await import('@/lib/email');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.spyOn(email, 'sendEmail').mockResolvedValueOnce({ ok: false, error: 'boom' });
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    const { consumeLocalOtp } = await import('@/lib/auth');

    expect(await requestMagicLink({ status: 'idle' }, requestForm('pat@example.com'))).toEqual({
      status: 'sent',
      email: 'pat@example.com',
    });
    expect(errorSpy).toHaveBeenCalled();
    const code = send.mock.calls[0]?.[0].code;
    expect(code).toMatch(/^\d{6}$/);

    const { db, schema } = await import('@/lib/db');
    const tokens = db.select().from(schema.magicTokens).all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.consumedAt).toBeInstanceOf(Date);
    expect(consumeLocalOtp('pat@example.com', 'parent', code!).ok).toBe(false);

    errorSpy.mockRestore();
  });

  it('invalidates only the issued OTP id, not a later unused code', async () => {
    await seedParent();
    const { issueLocalOtp, invalidateIssuedOtp, consumeLocalOtp } = await import('@/lib/auth');
    const first = issueLocalOtp('pat@example.com', 'parent');
    const second = issueLocalOtp('pat@example.com', 'parent');
    invalidateIssuedOtp(first.id);
    expect(consumeLocalOtp('pat@example.com', 'parent', first.code).ok).toBe(false);
    expect(consumeLocalOtp('pat@example.com', 'parent', second.code).ok).toBe(true);
  });

  it('refuses consumeLocalOtp with requireInviteId when the token has none', async () => {
    await seedParent();
    const { issueLocalOtp, consumeLocalOtp } = await import('@/lib/auth');
    const issued = issueLocalOtp('pat@example.com', 'parent');
    expect(
      consumeLocalOtp('pat@example.com', 'parent', issued.code, { requireInviteId: true }),
    ).toEqual({
      ok: false,
      reason: 'invite-invalid',
    });
    expect(consumeLocalOtp('pat@example.com', 'parent', issued.code).ok).toBe(true);
  });

  it('refuses an OTP bearer on the magic-link consume path (verify route)', async () => {
    await seedParent();
    const { issueLocalOtp, consumeMagicToken, consumeLocalOtp } = await import('@/lib/auth');
    const { env } = await import('@/lib/env');
    const issued = issueLocalOtp('pat@example.com', 'parent');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    expect(consumeMagicToken(`otp:pat@example.com:parent:${issued.code}`)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'local-otp';
    expect(consumeLocalOtp('pat@example.com', 'parent', issued.code).ok).toBe(true);
  });

  it('ignores leftover magic-link tokens when AUTH_MODE is not magic-link', async () => {
    await seedParent();
    const { env } = await import('@/lib/env');
    const { issueMagicLink, consumeMagicToken } = await import('@/lib/auth');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    const { token } = await issueMagicLink('pat@example.com', 'parent');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'password';
    expect(consumeMagicToken(token)).toEqual({ ok: false, reason: 'not-found' });
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'local-otp';
    expect(consumeMagicToken(token)).toEqual({ ok: false, reason: 'not-found' });
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    expect(consumeMagicToken(token).ok).toBe(true);
  });
});
