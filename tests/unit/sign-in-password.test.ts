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

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '203.0.113.44' }),
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
