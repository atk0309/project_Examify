import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `magic-link-${process.pid}.db`);
const OUTBOX = path.join(TMP, 'outbox');
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '203.0.113.88' }),
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
  if (fs.existsSync(OUTBOX)) fs.rmSync(OUTBOX, { recursive: true, force: true });
});

afterEach(async () => {
  const { env } = await import('@/lib/env');
  (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY =
    'unit-test-secret-not-a-cloudflare-dummy-12';
  (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY =
    '1x00000000000000000000AA';
});

async function seedStudent() {
  const { bootstrapHousehold, createHouseholdInvite } = await import('@/lib/households');
  const { consumeMagicToken, issueMagicLink } = await import('@/lib/auth');
  const host = bootstrapHousehold({ email: 'parent@example.com', householdName: 'Ours' });
  if (!host.ok) throw new Error('bootstrap failed');
  const invite = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
  if (!invite.ok) throw new Error('invite failed');
  const { token } = await issueMagicLink('student@example.com', 'student', {
    inviteId: invite.invite.id,
  });
  consumeMagicToken(token);
}

function form(email: string, role: 'student' | 'parent', turnstile?: string): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('role', role);
  if (turnstile !== undefined) data.set('cf-turnstile-response', turnstile);
  return data;
}

async function outboxCount(): Promise<number> {
  if (!fs.existsSync(OUTBOX)) return 0;
  return (await fs.promises.readdir(OUTBOX)).length;
}

describe('requestMagicLink', () => {
  it('does not enumerate unknown emails (generic sent, no mail)', async () => {
    await seedStudent();
    const { env } = await import('@/lib/env');
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY =
      '1x0000000000000000000000000000000AA';

    const state = await requestMagicLink(
      { status: 'idle' },
      form('ghost@example.com', 'student', 'ok'),
    );
    expect(state).toEqual({ status: 'sent', email: 'ghost@example.com' });
    expect(await outboxCount()).toBe(0);
  });

  it('sends a link for a household member in the matching role', async () => {
    await seedStudent();
    const { env } = await import('@/lib/env');
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY =
      '1x0000000000000000000000000000000AA';

    const state = await requestMagicLink(
      { status: 'idle' },
      form('student@example.com', 'student', 'ok'),
    );
    expect(state).toEqual({ status: 'sent', email: 'student@example.com' });
    expect(await outboxCount()).toBe(1);
  });

  it('does not send when the role does not match (still generic sent)', async () => {
    await seedStudent();
    const { env } = await import('@/lib/env');
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY =
      '1x0000000000000000000000000000000AA';

    const state = await requestMagicLink(
      { status: 'idle' },
      form('student@example.com', 'parent', 'ok'),
    );
    expect(state).toEqual({ status: 'sent', email: 'student@example.com' });
    expect(await outboxCount()).toBe(0);
  });

  it('skips captcha when Turnstile keys are unset', async () => {
    await seedStudent();
    const { env } = await import('@/lib/env');
    (env as { TURNSTILE_SECRET_KEY?: string }).TURNSTILE_SECRET_KEY = undefined;
    (env as { NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string }).NEXT_PUBLIC_TURNSTILE_SITE_KEY = undefined;

    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    const state = await requestMagicLink(
      { status: 'idle' },
      form('student@example.com', 'student'),
    );
    expect(state).toEqual({ status: 'sent', email: 'student@example.com' });
    expect(await outboxCount()).toBe(1);
  });

  it('rejects a missing token when Turnstile is enabled', async () => {
    const { requestMagicLink } = await import('@/actions/requestMagicLink');
    const state = await requestMagicLink(
      { status: 'idle' },
      form('student@example.com', 'student'),
    );
    expect(state).toEqual({ status: 'error', reason: 'invalid' });
  });
});
