import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `invite-password-${process.pid}.db`);
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

describe('acceptInviteWithPassword', () => {
  it('joins a student and establishes a session', async () => {
    const { bootstrapHousehold, createHouseholdInvite } = await import('@/lib/households');
    const host = bootstrapHousehold({
      email: 'pat@example.com',
      householdName: 'Ours',
    });
    if (!host.ok) throw new Error('bootstrap failed');
    const invite = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
    if (!invite.ok) throw new Error('invite failed');

    const { acceptInviteWithPassword } = await import('@/actions/acceptInviteWithPassword');
    const data = new FormData();
    data.set('email', 'alex@example.com');
    data.set('password', 'student-pass');
    data.set('inviteToken', invite.token);

    await expect(acceptInviteWithPassword({ status: 'idle' }, data)).rejects.toMatchObject({
      url: '/',
    });
    expect(sessionHolder.current.email).toBe('alex@example.com');
    expect(sessionHolder.current.role).toBe('student');
    expect(sessionHolder.current.save).toHaveBeenCalledOnce();
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
});
