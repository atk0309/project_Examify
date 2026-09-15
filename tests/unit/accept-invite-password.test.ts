import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `invite-password-${process.pid}.db`);
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
  return {
    ...actual,
    sendEmail: sendEmailMock,
  };
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
  headers: async () => new Headers({ 'x-real-ip': '203.0.113.66' }),
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

async function seedOpenStudentInvite() {
  const { bootstrapHousehold, createHouseholdInvite } = await import('@/lib/households');
  const host = bootstrapHousehold({
    email: 'pat@example.com',
    householdName: 'Ours',
  });
  if (!host.ok) throw new Error('bootstrap failed');
  const invite = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
  if (!invite.ok) throw new Error('invite failed');
  return invite;
}

async function userByEmail(email: string) {
  const { db, schema } = await import('@/lib/db');
  return db.select().from(schema.users).where(eq(schema.users.email, email)).get();
}

describe('acceptInviteWithPassword', () => {
  it('issues a mailbox OTP and does not join or stamp emailVerifiedAt', async () => {
    const invite = await seedOpenStudentInvite();
    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const data = new FormData();
    data.set('email', 'alex@example.com');
    data.set('password', 'student-pass');
    data.set('inviteToken', invite.token);

    expect(await acceptInviteWithPassword({ status: 'idle' }, data)).toEqual({
      status: 'sent',
      email: 'alex@example.com',
    });
    expect(sendEmailMock).toHaveBeenCalledOnce();
    expect(sendEmailMock.mock.calls[0]?.[0].code).toMatch(/^\d{6}$/);

    const { getMembershipForEmail } = await import('@/lib/households');
    expect(getMembershipForEmail('alex@example.com')).toBeNull();
    expect(await userByEmail('alex@example.com')).toBeUndefined();
  });

  it('reports an invalid invite token', async () => {
    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const data = new FormData();
    data.set('email', 'alex@example.com');
    data.set('password', 'student-pass');
    data.set('inviteToken', 'not-a-real-token');
    expect(await acceptInviteWithPassword({ status: 'idle' }, data)).toEqual({
      status: 'error',
      reason: 'invite_invalid',
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns generic invalid when the email does not match the lock', async () => {
    const { bootstrapHousehold, createHouseholdInvite } = await import('@/lib/households');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    if (!host.ok) throw new Error('bootstrap failed');
    const invite = createHouseholdInvite({
      actorUserId: host.userId,
      role: 'student',
      email: 'alex@example.com',
    });
    if (!invite.ok) throw new Error('invite failed');

    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const data = new FormData();
    data.set('email', 'stranger@example.com');
    data.set('password', 'student-pass');
    data.set('inviteToken', invite.token);
    expect(await acceptInviteWithPassword({ status: 'idle' }, data)).toEqual({
      status: 'error',
      reason: 'invalid',
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('rejects a short password', async () => {
    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const data = new FormData();
    data.set('email', 'alex@example.com');
    data.set('password', 'short');
    data.set('inviteToken', 'anything');
    expect(await acceptInviteWithPassword({ status: 'idle' }, data)).toEqual({
      status: 'error',
      reason: 'invalid',
    });
  });

  it('fails closed when mailbox proof cannot be delivered', async () => {
    const invite = await seedOpenStudentInvite();
    const envMod = await import('@/lib/env');
    const spy = vi.spyOn(envMod, 'canDeliverMailboxProof').mockReturnValue(false);
    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const data = new FormData();
    data.set('email', 'alex@example.com');
    data.set('password', 'student-pass');
    data.set('inviteToken', invite.token);
    expect(await acceptInviteWithPassword({ status: 'idle' }, data)).toEqual({
      status: 'error',
      reason: 'send_failed',
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fails closed when mail cannot be delivered', async () => {
    const invite = await seedOpenStudentInvite();
    sendEmailMock.mockResolvedValue({ ok: false, error: 'email-not-configured' });
    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const data = new FormData();
    data.set('email', 'alex@example.com');
    data.set('password', 'student-pass');
    data.set('inviteToken', invite.token);
    expect(await acceptInviteWithPassword({ status: 'idle' }, data)).toEqual({
      status: 'error',
      reason: 'send_failed',
    });

    const { getMembershipForEmail } = await import('@/lib/households');
    expect(getMembershipForEmail('alex@example.com')).toBeNull();
    expect(await userByEmail('alex@example.com')).toBeUndefined();

    const code = sendEmailMock.mock.calls[0]?.[0].code;
    expect(code).toMatch(/^\d{6}$/);
    const { db, schema } = await import('@/lib/db');
    const tokens = db.select().from(schema.magicTokens).all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.consumedAt).toBeInstanceOf(Date);

    const { completePasswordInvite } = await import('@/actions/completePasswordInvite');
    const finish = new FormData();
    finish.set('email', 'alex@example.com');
    finish.set('role', 'student');
    finish.set('password', 'student-pass');
    finish.set('code', code!);
    expect(await completePasswordInvite({ status: 'idle' }, finish)).toEqual({
      status: 'error',
      reason: 'invalid',
    });
  });
});

describe('requestInviteLink local-otp', () => {
  it('invalidates the issued OTP when mail cannot be delivered', async () => {
    const { env } = await import('@/lib/env');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'local-otp';
    const invite = await seedOpenStudentInvite();
    sendEmailMock.mockResolvedValue({ ok: false, error: 'email-not-configured' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { requestInviteLink } = await import('@/actions/requestInviteLink');
    const data = new FormData();
    data.set('email', 'alex@example.com');
    data.set('inviteToken', invite.token);
    expect(await requestInviteLink({ status: 'idle' }, data)).toEqual({
      status: 'sent',
      email: 'alex@example.com',
    });

    const code = sendEmailMock.mock.calls[0]?.[0].code;
    expect(code).toMatch(/^\d{6}$/);
    const { db, schema } = await import('@/lib/db');
    const tokens = db.select().from(schema.magicTokens).all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.consumedAt).toBeInstanceOf(Date);

    const { consumeLocalOtp } = await import('@/lib/auth');
    expect(consumeLocalOtp('alex@example.com', 'student', code!).ok).toBe(false);
    errorSpy.mockRestore();
  });

  it('does not log the email (or other identifiers) when send fails', async () => {
    const { env } = await import('@/lib/env');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'local-otp';
    const invite = await seedOpenStudentInvite();
    sendEmailMock.mockResolvedValue({ ok: false, error: 'email-not-configured' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { requestInviteLink } = await import('@/actions/requestInviteLink');
    const data = new FormData();
    data.set('email', 'alex@example.com');
    data.set('inviteToken', invite.token);
    expect(await requestInviteLink({ status: 'idle' }, data)).toEqual({
      status: 'sent',
      email: 'alex@example.com',
    });

    expect(errorSpy).toHaveBeenCalled();
    for (const args of errorSpy.mock.calls) {
      expect(JSON.stringify(args)).not.toContain('alex@example.com');
      expect(JSON.stringify(args)).not.toMatch(/"email"\s*:/);
    }
    const payload = errorSpy.mock.calls.find((args) =>
      args.some(
        (arg) => typeof arg === 'string' && arg.includes('invite local-otp delivery failed'),
      ),
    );
    expect(payload?.[1]).toEqual({ error: 'email-not-configured' });
    errorSpy.mockRestore();
  });
});

describe('requestInviteLink magic-link', () => {
  it('does not log the email (or other identifiers) when send fails', async () => {
    const { env } = await import('@/lib/env');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    const invite = await seedOpenStudentInvite();
    sendEmailMock.mockResolvedValue({ ok: false, error: 'email-not-configured' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { requestInviteLink } = await import('@/actions/requestInviteLink');
    const data = new FormData();
    data.set('email', 'alex@example.com');
    data.set('inviteToken', invite.token);
    expect(await requestInviteLink({ status: 'idle' }, data)).toEqual({
      status: 'sent',
      email: 'alex@example.com',
    });

    expect(errorSpy).toHaveBeenCalled();
    for (const args of errorSpy.mock.calls) {
      expect(JSON.stringify(args)).not.toContain('alex@example.com');
      expect(JSON.stringify(args)).not.toMatch(/"email"\s*:/);
    }
    const payload = errorSpy.mock.calls.find((args) =>
      args.some(
        (arg) => typeof arg === 'string' && arg.includes('invite magic-link delivery failed'),
      ),
    );
    expect(payload?.[1]).toEqual({ error: 'email-not-configured' });
    errorSpy.mockRestore();
  });
});

describe('completePasswordInvite', () => {
  it('joins after a valid OTP and stamps emailVerifiedAt', async () => {
    const invite = await seedOpenStudentInvite();
    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const start = new FormData();
    start.set('email', 'alex@example.com');
    start.set('password', 'student-pass');
    start.set('inviteToken', invite.token);
    expect(await acceptInviteWithPassword({ status: 'idle' }, start)).toMatchObject({
      status: 'sent',
    });
    const code = sendEmailMock.mock.calls[0]?.[0].code;
    expect(code).toMatch(/^\d{6}$/);

    const { completePasswordInvite } = await import('@/actions/completePasswordInvite');
    const finish = new FormData();
    finish.set('email', 'alex@example.com');
    finish.set('role', 'student');
    finish.set('password', 'student-pass');
    finish.set('code', code!);

    await expect(completePasswordInvite({ status: 'idle' }, finish)).rejects.toMatchObject({
      url: '/',
    });
    expect(sessionHolder.current.email).toBe('alex@example.com');
    expect(sessionHolder.current.role).toBe('student');
    expect(sessionHolder.current.save).toHaveBeenCalledOnce();

    const { getMembershipForEmail } = await import('@/lib/households');
    expect(getMembershipForEmail('alex@example.com')?.role).toBe('student');
    const user = await userByEmail('alex@example.com');
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user?.passwordHash).toBeTruthy();
  });

  it('rolls back verification, membership, and password when the invite is revoked', async () => {
    const {
      bootstrapHousehold,
      createHouseholdInvite,
      revokeHouseholdInvite,
      getMembershipForEmail,
    } = await import('@/lib/households');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    if (!host.ok) throw new Error('bootstrap failed');
    const invite = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
    if (!invite.ok) throw new Error('invite failed');

    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const start = new FormData();
    start.set('email', 'alex@example.com');
    start.set('password', 'student-pass');
    start.set('inviteToken', invite.token);
    await acceptInviteWithPassword({ status: 'idle' }, start);
    const code = sendEmailMock.mock.calls[0]?.[0].code;
    expect(code).toMatch(/^\d{6}$/);

    expect(revokeHouseholdInvite(host.userId, invite.invite.id)).toEqual({ ok: true });

    const { completePasswordInvite } = await import('@/actions/completePasswordInvite');
    const finish = new FormData();
    finish.set('email', 'alex@example.com');
    finish.set('role', 'student');
    finish.set('password', 'student-pass');
    finish.set('code', code!);
    expect(await completePasswordInvite({ status: 'idle' }, finish)).toEqual({
      status: 'error',
      reason: 'invalid',
    });

    expect(getMembershipForEmail('alex@example.com')).toBeNull();
    expect(await userByEmail('alex@example.com')).toBeUndefined();
    const { db, schema } = await import('@/lib/db');
    const tokens = db.select().from(schema.magicTokens).all();
    expect(tokens.every((row) => row.consumedAt == null)).toBe(true);
  });

  it('does not stamp emailVerifiedAt or attach membership on a wrong code', async () => {
    const invite = await seedOpenStudentInvite();
    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const start = new FormData();
    start.set('email', 'alex@example.com');
    start.set('password', 'student-pass');
    start.set('inviteToken', invite.token);
    await acceptInviteWithPassword({ status: 'idle' }, start);

    const { completePasswordInvite } = await import('@/actions/completePasswordInvite');
    const finish = new FormData();
    finish.set('email', 'alex@example.com');
    finish.set('role', 'student');
    finish.set('password', 'student-pass');
    finish.set('code', '000000');
    expect(await completePasswordInvite({ status: 'idle' }, finish)).toEqual({
      status: 'error',
      reason: 'invalid',
    });

    const { getMembershipForEmail } = await import('@/lib/households');
    expect(getMembershipForEmail('alex@example.com')).toBeNull();
    expect(await userByEmail('alex@example.com')).toBeUndefined();
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
  });

  it('refuses complete when the OTP has no inviteId', async () => {
    const { issueLocalOtp } = await import('@/lib/auth');
    const issued = issueLocalOtp('alex@example.com', 'student');

    const { completePasswordInvite } = await import('@/actions/completePasswordInvite');
    const finish = new FormData();
    finish.set('email', 'alex@example.com');
    finish.set('role', 'student');
    finish.set('password', 'student-pass');
    finish.set('code', issued.code);
    expect(await completePasswordInvite({ status: 'idle' }, finish)).toEqual({
      status: 'error',
      reason: 'invalid',
    });

    const { getMembershipForEmail } = await import('@/lib/households');
    expect(getMembershipForEmail('alex@example.com')).toBeNull();
    expect(await userByEmail('alex@example.com')).toBeUndefined();
    expect(sessionHolder.current.save).not.toHaveBeenCalled();

    const { db, schema } = await import('@/lib/db');
    const tokens = db.select().from(schema.magicTokens).all();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.inviteId).toBeNull();
    expect(tokens[0]?.consumedAt).toBeNull();
  });
});
