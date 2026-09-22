import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `password-signin-${process.pid}.db`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
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

// Default CLIENT_IP_HEADER is the last X-Forwarded-For hop. Cases that
// rotate the client IP (or spoof other headers) overwrite this record.
const requestHeaders = vi.hoisted(() => ({
  current: { 'x-forwarded-for': '203.0.113.44' } as Record<string, string>,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(requestHeaders.current),
}));

vi.mock('@/lib/password', async () => {
  const actual = await vi.importActual<typeof import('@/lib/password')>('@/lib/password');
  return { ...actual, verifyPasswordOrDummy: vi.fn(actual.verifyPasswordOrDummy) };
});

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
  requestHeaders.current = { 'x-forwarded-for': '203.0.113.44' };
  const { verifyPasswordOrDummy } = await import('@/lib/password');
  vi.mocked(verifyPasswordOrDummy).mockClear();
  const { env } = await import('@/lib/env');
  (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'password';
  (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
  (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY = undefined;
});

function form(email: string, password: string, role: 'student' | 'parent' = 'parent'): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  data.set('role', role);
  return data;
}

async function seedAdmin(password = 'correct-horse') {
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

describe('signInWithPassword', () => {
  it('establishes a session for a household member with the right password', async () => {
    await seedAdmin();
    const { signInWithPassword } = await import('@/actions/signInWithPassword');
    await expect(
      signInWithPassword({ status: 'idle' }, form('pat@example.com', 'correct-horse', 'parent')),
    ).rejects.toMatchObject({ url: '/' });
    expect(sessionHolder.current.userId).toBeTypeOf('number');
    expect(sessionHolder.current.role).toBe('parent');
    expect(sessionHolder.current.email).toBe('pat@example.com');
    expect(sessionHolder.current.studentMode).toBe(false);
    expect(sessionHolder.current.save).toHaveBeenCalledOnce();
  });

  it('returns the same invalid error for a wrong password or unknown email', async () => {
    await seedAdmin();
    const { signInWithPassword } = await import('@/actions/signInWithPassword');
    const wrong = await signInWithPassword(
      { status: 'idle' },
      form('pat@example.com', 'not-the-password', 'parent'),
    );
    expect(wrong).toEqual({ status: 'error', reason: 'invalid' });
    const ghost = await signInWithPassword(
      { status: 'idle' },
      form('ghost@example.com', 'correct-horse', 'parent'),
    );
    expect(ghost).toEqual({ status: 'error', reason: 'invalid' });
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
  });

  it('does not sign in when the role does not match', async () => {
    await seedAdmin();
    const { signInWithPassword } = await import('@/actions/signInWithPassword');
    const state = await signInWithPassword(
      { status: 'idle' },
      form('pat@example.com', 'correct-horse', 'student'),
    );
    expect(state).toEqual({ status: 'error', reason: 'invalid' });
  });

  it('does not let a rotating cf-connecting-ip / x-real-ip escape the per-IP bucket', async () => {
    await seedAdmin();
    const { env } = await import('@/lib/env');
    const { signInWithPassword } = await import('@/actions/signInWithPassword');
    const states = [];
    for (let i = 0; i <= env.RATE_LIMIT_SIGNIN_MAX; i++) {
      // A distinct account each time so only the per-IP bucket is in play.
      requestHeaders.current = {
        'x-forwarded-for': '203.0.113.44',
        'cf-connecting-ip': `192.0.2.${i + 1}`,
        'x-real-ip': `198.51.100.${i + 1}`,
      };
      states.push(
        await signInWithPassword({ status: 'idle' }, form(`ghost-${i}@example.com`, 'guess')),
      );
    }
    expect(states.slice(0, -1).every((s) => s.status === 'error' && s.reason === 'invalid')).toBe(
      true,
    );
    expect(states.at(-1)).toEqual({ status: 'error', reason: 'rate_limited' });
  });

  it('locks one account after repeated wrong passwords, even from rotating IPs and roles', async () => {
    await seedAdmin();
    const { PASSWORD_FAILURE_MAX } = await import('@/lib/auth');
    const { signInWithPassword } = await import('@/actions/signInWithPassword');
    for (let i = 0; i < PASSWORD_FAILURE_MAX; i++) {
      requestHeaders.current = { 'x-forwarded-for': `192.0.2.${i + 1}` };
      const role = i % 2 === 0 ? 'parent' : 'student';
      expect(
        await signInWithPassword({ status: 'idle' }, form('Pat@Example.com', `wrong-${i}`, role)),
      ).toEqual({ status: 'error', reason: 'invalid' });
    }
    requestHeaders.current = { 'x-forwarded-for': '192.0.2.200' };
    expect(
      await signInWithPassword({ status: 'idle' }, form('pat@example.com', 'correct-horse')),
    ).toEqual({ status: 'error', reason: 'rate_limited' });
    expect(sessionHolder.current.save).not.toHaveBeenCalled();
  });

  it('locks an unknown email exactly like a real one', async () => {
    await seedAdmin();
    const { PASSWORD_FAILURE_MAX } = await import('@/lib/auth');
    const { signInWithPassword } = await import('@/actions/signInWithPassword');
    const run = async (email: string) => {
      const out = [];
      for (let i = 0; i <= PASSWORD_FAILURE_MAX; i++) {
        requestHeaders.current = { 'x-forwarded-for': `198.51.100.${i + 1}` };
        out.push(await signInWithPassword({ status: 'idle' }, form(email, `wrong-${i}`)));
      }
      return out;
    };
    const known = await run('pat@example.com');
    const ghost = await run('ghost@example.com');
    expect(ghost).toEqual(known);
    expect(known.at(-1)).toEqual({ status: 'error', reason: 'rate_limited' });
  });

  it('skips scrypt while the account is locked', async () => {
    await seedAdmin();
    const { PASSWORD_FAILURE_MAX, recordPasswordFailure } = await import('@/lib/auth');
    const { verifyPasswordOrDummy } = await import('@/lib/password');
    const { signInWithPassword } = await import('@/actions/signInWithPassword');
    // Unlocked: the compare runs (so the spy below is wired to the real path).
    await signInWithPassword({ status: 'idle' }, form('pat@example.com', 'wrong'));
    expect(verifyPasswordOrDummy).toHaveBeenCalledOnce();

    for (let i = 1; i < PASSWORD_FAILURE_MAX; i++) recordPasswordFailure('pat@example.com');
    vi.mocked(verifyPasswordOrDummy).mockClear();
    expect(
      await signInWithPassword({ status: 'idle' }, form('pat@example.com', 'correct-horse')),
    ).toEqual({ status: 'error', reason: 'rate_limited' });
    expect(verifyPasswordOrDummy).not.toHaveBeenCalled();
  });

  it('clears the account bucket on a successful sign-in', async () => {
    await seedAdmin();
    const { PASSWORD_FAILURE_MAX, isPasswordSignInLocked } = await import('@/lib/auth');
    const { signInWithPassword } = await import('@/actions/signInWithPassword');
    for (let i = 0; i < PASSWORD_FAILURE_MAX - 1; i++) {
      requestHeaders.current = { 'x-forwarded-for': `192.0.2.${i + 1}` };
      await signInWithPassword({ status: 'idle' }, form('pat@example.com', `wrong-${i}`));
    }
    requestHeaders.current = { 'x-forwarded-for': '192.0.2.100' };
    await expect(
      signInWithPassword({ status: 'idle' }, form('pat@example.com', 'correct-horse')),
    ).rejects.toMatchObject({ url: '/' });

    const { db, schema } = await import('@/lib/db');
    const { eq } = await import('drizzle-orm');
    expect(
      db
        .select()
        .from(schema.rateLimitEvents)
        .where(eq(schema.rateLimitEvents.ip, 'pw:pat@example.com'))
        .all(),
    ).toHaveLength(0);

    // One more wrong guess after the clear does not trip the lock.
    requestHeaders.current = { 'x-forwarded-for': '192.0.2.101' };
    expect(
      await signInWithPassword({ status: 'idle' }, form('pat@example.com', 'wrong-again')),
    ).toEqual({ status: 'error', reason: 'invalid' });
    expect(isPasswordSignInLocked('pat@example.com')).toBe(false);
  });

  it('lifts the lock once failures age out of the window', async () => {
    const {
      PASSWORD_FAILURE_MAX,
      PASSWORD_FAILURE_WINDOW_MS,
      isPasswordSignInLocked,
      recordPasswordFailure,
    } = await import('@/lib/auth');
    const now = Date.now();
    for (let i = 0; i < PASSWORD_FAILURE_MAX; i++) recordPasswordFailure('pat@example.com', now);
    expect(isPasswordSignInLocked('pat@example.com', now)).toBe(true);
    expect(isPasswordSignInLocked('PAT@example.com ', now)).toBe(true);
    expect(isPasswordSignInLocked('other@example.com', now)).toBe(false);
    expect(isPasswordSignInLocked('pat@example.com', now + PASSWORD_FAILURE_WINDOW_MS + 1)).toBe(
      false,
    );
  });

  it('refuses when AUTH_MODE is not password', async () => {
    await seedAdmin();
    const { env } = await import('@/lib/env');
    (env as { AUTH_MODE: typeof env.AUTH_MODE }).AUTH_MODE = 'magic-link';
    const { signInWithPassword } = await import('@/actions/signInWithPassword');
    const state = await signInWithPassword(
      { status: 'idle' },
      form('pat@example.com', 'correct-horse', 'parent'),
    );
    expect(state).toEqual({ status: 'error', reason: 'invalid' });
  });
});
