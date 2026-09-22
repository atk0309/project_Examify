import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `password-reset-${process.pid}.db`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

const sessionHolder = vi.hoisted(() => ({
  current: {} as SessionData & { save: () => Promise<void> },
}));

const sendEmailMock = vi.hoisted(() =>
  vi.fn<
    (opts: { to: string; code?: string }) => Promise<{ ok: boolean; error?: string; id?: string }>
  >(async () => ({ ok: true, id: 'test' })),
);

vi.mock('@/lib/email', async () => {
  const actual = await vi.importActual<typeof import('@/lib/email')>('@/lib/email');
  return { ...actual, sendEmail: sendEmailMock };
});

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    getRawSession: async () => sessionHolder.current,
    getSession: async () => sessionHolder.current,
  };
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '203.0.113.77' }),
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
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ ok: true, id: 'test' });
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
  (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'password';
  (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
  (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY = undefined;
  sendEmailMock.mockResolvedValue({ ok: true, id: 'test' });
});

async function seedAdmin(password = 'old-password-1') {
  const { hashPassword } = await import('@/lib/password');
  const { bootstrapHousehold } = await import('@/lib/households');
  const host = bootstrapHousehold({
    email: 'pat@example.com',
    householdName: 'Ours',
    passwordHash: hashPassword(password),
  });
  if (!host.ok) throw new Error('bootstrap failed');
  return host;
}

async function userByEmail(email: string) {
  const { db, schema } = await import('@/lib/db');
  return db.select().from(schema.users).where(eq(schema.users.email, email)).get();
}

function requestForm(email: string, role: 'student' | 'parent' = 'parent') {
  const data = new FormData();
  data.set('email', email);
  data.set('role', role);
  return data;
}

function completeForm(email: string, code: string, password: string, confirm = password) {
  const data = new FormData();
  data.set('email', email);
  data.set('role', 'parent');
  data.set('code', code);
  data.set('password', password);
  data.set('confirmPassword', confirm);
  return data;
}

describe('requestPasswordReset', () => {
  it('sends a code for a member and does not change the password yet', async () => {
    await seedAdmin();
    const before = await userByEmail('pat@example.com');
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    expect(await requestPasswordReset({ status: 'idle' }, requestForm('pat@example.com'))).toEqual({
      status: 'sent',
      email: 'pat@example.com',
    });
    expect(sendEmailMock).toHaveBeenCalledOnce();
    expect(sendEmailMock.mock.calls[0]?.[0].code).toMatch(/^\d{6}$/);
    const after = await userByEmail('pat@example.com');
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.emailVerifiedAt?.getTime()).toBe(before?.emailVerifiedAt?.getTime());
  });

  it('returns sent for an unknown email and does not issue a token', async () => {
    await seedAdmin();
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    expect(
      await requestPasswordReset({ status: 'idle' }, requestForm('stranger@example.com')),
    ).toEqual({ status: 'sent', email: 'stranger@example.com' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    const { db, schema } = await import('@/lib/db');
    expect(db.select().from(schema.magicTokens).all()).toHaveLength(0);
  });

  it('returns sent for the wrong role and does not issue a token', async () => {
    await seedAdmin();
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    expect(
      await requestPasswordReset({ status: 'idle' }, requestForm('pat@example.com', 'student')),
    ).toEqual({ status: 'sent', email: 'pat@example.com' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns sent when mail cannot be delivered and invalidates the unused code', async () => {
    await seedAdmin();
    sendEmailMock.mockResolvedValue({ ok: false, error: 'email-not-configured' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await userByEmail('pat@example.com');
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    expect(await requestPasswordReset({ status: 'idle' }, requestForm('pat@example.com'))).toEqual({
      status: 'sent',
      email: 'pat@example.com',
    });
    const code = sendEmailMock.mock.calls[0]?.[0].code ?? '';
    const { db, schema } = await import('@/lib/db');
    const tokens = db.select().from(schema.magicTokens).all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.consumedAt).toBeInstanceOf(Date);
    expect(tokens[0]?.pendingPasswordHash).toBeNull();
    const { completePasswordReset } = await import('@/actions/completePasswordReset');
    expect(
      await completePasswordReset(
        { status: 'idle' },
        completeForm('pat@example.com', code, 'new-password-2'),
      ),
    ).toEqual({ status: 'error', reason: 'invalid' });
    expect((await userByEmail('pat@example.com'))?.passwordHash).toBe(before?.passwordHash);
    for (const args of errorSpy.mock.calls) {
      expect(JSON.stringify(args)).not.toContain('pat@example.com');
    }
    errorSpy.mockRestore();
  });

  it('returns sent and issues nothing when mailbox proof cannot be delivered', async () => {
    await seedAdmin();
    const envMod = await import('@/lib/env');
    const spy = vi.spyOn(envMod, 'canDeliverMailboxProof').mockReturnValue(false);
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    expect(await requestPasswordReset({ status: 'idle' }, requestForm('pat@example.com'))).toEqual({
      status: 'sent',
      email: 'pat@example.com',
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses when AUTH_MODE is not password', async () => {
    const { env } = await import('@/lib/env');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    expect(await requestPasswordReset({ status: 'idle' }, requestForm('pat@example.com'))).toEqual({
      status: 'error',
      reason: 'invalid',
    });
  });
});

describe('completePasswordReset', () => {
  it('replaces the password only after the code matches and does not stamp emailVerifiedAt', async () => {
    await seedAdmin();
    const before = await userByEmail('pat@example.com');
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    await requestPasswordReset({ status: 'idle' }, requestForm('pat@example.com'));
    const code = sendEmailMock.mock.calls[0]?.[0].code ?? '';
    const { completePasswordReset } = await import('@/actions/completePasswordReset');
    await expect(
      completePasswordReset(
        { status: 'idle' },
        completeForm('pat@example.com', code, 'new-password-2'),
      ),
    ).rejects.toMatchObject({ url: '/' });
    const after = await userByEmail('pat@example.com');
    const { verifyPassword } = await import('@/lib/password');
    expect(verifyPassword('new-password-2', after!.passwordHash!)).toBe(true);
    expect(verifyPassword('old-password-1', after!.passwordHash!)).toBe(false);
    expect(after?.emailVerifiedAt?.getTime()).toBe(before?.emailVerifiedAt?.getTime());
    expect(sessionHolder.current.email).toBe('pat@example.com');
    expect(sessionHolder.current.role).toBe('parent');
    expect(sessionHolder.current.studentMode).toBe(false);
  });

  it('does not consume the code or change the hash on a mismatch or a short password', async () => {
    await seedAdmin();
    const before = await userByEmail('pat@example.com');
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    await requestPasswordReset({ status: 'idle' }, requestForm('pat@example.com'));
    const code = sendEmailMock.mock.calls[0]?.[0].code ?? '';
    const { completePasswordReset } = await import('@/actions/completePasswordReset');
    expect(
      await completePasswordReset(
        { status: 'idle' },
        completeForm('pat@example.com', code, 'new-password-2', 'other-password'),
      ),
    ).toEqual({ status: 'error', reason: 'password_mismatch' });
    expect(
      await completePasswordReset(
        { status: 'idle' },
        completeForm('pat@example.com', code, 'short'),
      ),
    ).toEqual({ status: 'error', reason: 'invalid' });
    expect((await userByEmail('pat@example.com'))?.passwordHash).toBe(before?.passwordHash);
    const { db, schema } = await import('@/lib/db');
    expect(db.select().from(schema.magicTokens).all()[0]?.consumedAt).toBeNull();
  });

  it('does not change the hash on a wrong code', async () => {
    await seedAdmin();
    const before = await userByEmail('pat@example.com');
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    await requestPasswordReset({ status: 'idle' }, requestForm('pat@example.com'));
    const { completePasswordReset } = await import('@/actions/completePasswordReset');
    expect(
      await completePasswordReset(
        { status: 'idle' },
        completeForm('pat@example.com', '000000', 'new-password-2'),
      ),
    ).toEqual({ status: 'error', reason: 'invalid' });
    expect((await userByEmail('pat@example.com'))?.passwordHash).toBe(before?.passwordHash);
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
  });

  it('does not let /signin/verify consume a reset code', async () => {
    await seedAdmin();
    const { requestPasswordReset } = await import('@/actions/requestPasswordReset');
    await requestPasswordReset({ status: 'idle' }, requestForm('pat@example.com'));
    const code = sendEmailMock.mock.calls[0]?.[0].code ?? '';
    const { env } = await import('@/lib/env');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    const { consumeMagicToken } = await import('@/lib/auth');
    expect(consumeMagicToken(`reset:pat@example.com:parent:${code}`)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    const { db, schema } = await import('@/lib/db');
    expect(db.select().from(schema.magicTokens).all()[0]?.consumedAt).toBeNull();
  });
});
