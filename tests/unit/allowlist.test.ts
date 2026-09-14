import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `allowlist-${process.pid}.db`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

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
  db.delete(schema.magicTokens).run();
  db.delete(schema.householdInvites).run();
  db.delete(schema.householdMembers).run();
  db.delete(schema.households).run();
  db.delete(schema.users).run();
  resetLegacyImportLatch();
});

async function seedPair() {
  const { bootstrapHousehold, createHouseholdInvite } = await import('@/lib/households');
  const { consumeMagicToken, issueMagicLink } = await import('@/lib/auth');
  const host = bootstrapHousehold({ email: 'mum@example.com', householdName: 'Ours' });
  if (!host.ok) throw new Error('bootstrap failed');
  const invite = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
  if (!invite.ok) throw new Error('invite failed');
  const { token } = await issueMagicLink('kid@example.com', 'student', {
    inviteId: invite.invite.id,
  });
  consumeMagicToken(token);
}

describe('isAllowedEmail', () => {
  it('matches case-insensitively for the right role', async () => {
    const { isAllowedEmail } = await import('@/lib/allowlist');
    await seedPair();
    expect(isAllowedEmail('student', 'KID@example.com')).toBe(true);
    expect(isAllowedEmail('parent', '  mum@example.com ')).toBe(true);
  });

  it('does not let a role use the other role’s list', async () => {
    const { isAllowedEmail } = await import('@/lib/allowlist');
    await seedPair();
    expect(isAllowedEmail('parent', 'kid@example.com')).toBe(false);
    expect(isAllowedEmail('student', 'mum@example.com')).toBe(false);
  });

  it('fails closed on an empty household table or empty email', async () => {
    const { isAllowedEmail } = await import('@/lib/allowlist');
    expect(isAllowedEmail('student', 'kid@example.com')).toBe(false);
    expect(isAllowedEmail('parent', 'mum@example.com')).toBe(false);
    await seedPair();
    expect(isAllowedEmail('student', '')).toBe(false);
    expect(isAllowedEmail('parent', '   ')).toBe(false);
  });

  it('does not allow an unknown email', async () => {
    const { isAllowedEmail } = await import('@/lib/allowlist');
    await seedPair();
    expect(isAllowedEmail('student', 'stranger@example.com')).toBe(false);
    expect(isAllowedEmail('parent', 'stranger@example.com')).toBe(false);
  });
});
