import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@/lib/auth';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `bootstrap-actions-${process.pid}.db`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

const sessionHolder = vi.hoisted(() => ({
  current: {} as SessionData & { save: () => Promise<void> },
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    getSession: async () => sessionHolder.current,
  };
});

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '203.0.113.21' }),
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
  (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
  (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY = undefined;
});

describe('bootstrapHouseholdAction', () => {
  it('creates the first admin and establishes a parent session', async () => {
    const { bootstrapHouseholdAction } = await import('@/actions/bootstrapHousehold');
    const data = new FormData();
    data.set('email', 'host@example.com');
    data.set('householdName', 'Our family');
    await expect(bootstrapHouseholdAction({ status: 'idle' }, data)).rejects.toMatchObject({
      url: '/',
    });
    expect(sessionHolder.current.userId).toBeTypeOf('number');
    expect(sessionHolder.current.role).toBe('parent');
    expect(sessionHolder.current.email).toBe('host@example.com');
    expect(sessionHolder.current.save).toHaveBeenCalledOnce();
  });

  it('rejects a second setup', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    bootstrapHousehold({ email: 'a@example.com', householdName: 'One' });
    const { bootstrapHouseholdAction } = await import('@/actions/bootstrapHousehold');
    const data = new FormData();
    data.set('email', 'b@example.com');
    data.set('householdName', 'Two');
    const state = await bootstrapHouseholdAction({ status: 'idle' }, data);
    expect(state).toEqual({ status: 'error', reason: 'already_setup' });
  });
});

describe('createInvite + requestInviteLink', () => {
  it('lets a parent mint an invite that a student can accept', async () => {
    const { bootstrapHousehold } = await import('@/lib/households');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    if (!host.ok) throw new Error('bootstrap failed');
    sessionHolder.current.userId = host.userId;
    sessionHolder.current.role = 'parent';
    sessionHolder.current.email = host.email;

    const { createInvite } = await import('@/actions/createInvite');
    const createdForm = new FormData();
    createdForm.set('role', 'student');
    const created = await createInvite(createdForm);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.url).toContain('/invite/');

    const token = created.url.split('/invite/')[1]!;
    const { requestInviteLink } = await import('@/actions/requestInviteLink');
    const accept = new FormData();
    accept.set('email', 'alex@example.com');
    accept.set('inviteToken', decodeURIComponent(token));
    const state = await requestInviteLink({ status: 'idle' }, accept);
    expect(state).toEqual({ status: 'sent', email: 'alex@example.com' });
  });

  it('reports an invalid invite token', async () => {
    const { requestInviteLink } = await import('@/actions/requestInviteLink');
    const accept = new FormData();
    accept.set('email', 'alex@example.com');
    accept.set('inviteToken', 'not-a-real-token');
    const state = await requestInviteLink({ status: 'idle' }, accept);
    expect(state).toEqual({ status: 'error', reason: 'invite_invalid' });
  });
});
