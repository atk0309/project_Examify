import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `households-${process.pid}.db`);
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
  delete process.env.FAMILIES;
});

async function lib() {
  return import('@/lib/households');
}

function mustOk<T extends { ok: boolean }>(
  result: T,
  label: string,
): asserts result is T & { ok: true } {
  if (!result.ok) throw new Error(label);
}

describe('bootstrapHousehold', () => {
  it('creates the first admin household', async () => {
    const { bootstrapHousehold, hasAnyHousehold, getMembershipForEmail } = await lib();
    const result = bootstrapHousehold({
      email: '  HOST@Example.com ',
      householdName: 'The Stoyanovs',
    });
    mustOk(result, 'bootstrap failed');
    expect(result.email).toBe('host@example.com');
    expect(hasAnyHousehold()).toBe(true);
    const membership = getMembershipForEmail('host@example.com');
    expect(membership?.role).toBe('admin');
  });

  it('rejects a second bootstrap', async () => {
    const { bootstrapHousehold } = await lib();
    expect(bootstrapHousehold({ email: 'a@example.com', householdName: 'One' }).ok).toBe(true);
    expect(bootstrapHousehold({ email: 'b@example.com', householdName: 'Two' })).toEqual({
      ok: false,
      reason: 'already_setup',
    });
  });

  it('rejects an empty name', async () => {
    const { bootstrapHousehold, hasAnyHousehold } = await lib();
    expect(bootstrapHousehold({ email: 'a@example.com', householdName: '   ' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(hasAnyHousehold()).toBe(false);
  });
});

describe('invites + consumeMagicToken', () => {
  it('lets a parent invite a student who then joins on verify', async () => {
    const {
      bootstrapHousehold,
      createHouseholdInvite,
      lookupInvite,
      emailMayAcceptInvite,
      getMembershipForEmail,
    } = await lib();
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    mustOk(host, 'bootstrap failed');

    const created = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
    mustOk(created, 'invite creation failed');

    const invite = lookupInvite(created.token);
    expect(invite?.role).toBe('student');
    expect(emailMayAcceptInvite(invite!, 'alex@example.com')).toBe(true);

    const { consumeMagicToken, issueMagicLink } = await import('@/lib/auth');
    const { token } = await issueMagicLink('alex@example.com', 'student', {
      inviteId: created.invite.id,
    });
    const consumed = consumeMagicToken(token);
    expect(consumed.ok).toBe(true);
    const membership = getMembershipForEmail('alex@example.com');
    expect(membership?.role).toBe('student');
    expect(membership?.householdId).toBe(host.householdId);
    expect(lookupInvite(created.token)).toBeNull();
  });

  it('does not let an email-locked invite leak the locked address', async () => {
    const { bootstrapHousehold, createHouseholdInvite, lookupInvite, emailMayAcceptInvite } =
      await lib();
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    mustOk(host, 'bootstrap failed');
    const created = createHouseholdInvite({
      actorUserId: host.userId,
      role: 'student',
      email: 'alex@example.com',
    });
    mustOk(created, 'invite creation failed');
    const invite = lookupInvite(created.token)!;
    expect(emailMayAcceptInvite(invite, 'stranger@example.com')).toBe(false);
    expect(emailMayAcceptInvite(invite, 'alex@example.com')).toBe(true);
  });

  it('forbids a student from creating invites', async () => {
    const { bootstrapHousehold, createHouseholdInvite, attachMembershipFromInvite } = await lib();
    type Attach = Awaited<ReturnType<typeof attachMembershipFromInvite>>;
    const { db, schema } = await import('@/lib/db');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    mustOk(host, 'bootstrap failed');
    const kid = db
      .insert(schema.users)
      .values({ email: 'kid@example.com', emailVerifiedAt: new Date() })
      .returning()
      .get()!;
    const created = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
    mustOk(created, 'invite creation failed');
    let attached: Attach | undefined;
    db.transaction((tx) => {
      attached = attachMembershipFromInvite(tx, created.invite.id, kid.id, 'kid@example.com');
    });
    expect(attached).toEqual({ ok: true });
    expect(createHouseholdInvite({ actorUserId: kid.id, role: 'parent' })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('rolls back verify when the invite is already consumed', async () => {
    const { bootstrapHousehold, createHouseholdInvite } = await lib();
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    mustOk(host, 'bootstrap failed');
    const created = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
    mustOk(created, 'invite creation failed');

    const { consumeMagicToken, issueMagicLink } = await import('@/lib/auth');
    const first = await issueMagicLink('a@example.com', 'student', { inviteId: created.invite.id });
    expect(consumeMagicToken(first.token).ok).toBe(true);

    const second = await issueMagicLink('b@example.com', 'student', {
      inviteId: created.invite.id,
    });
    const result = consumeMagicToken(second.token);
    expect(result).toEqual({ ok: false, reason: 'invite-invalid' });

    const { db, schema } = await import('@/lib/db');
    const leftover = db.select().from(schema.users).all();
    const emails = leftover.map((u) => u.email);
    expect(emails).toContain('a@example.com');
    expect(emails).not.toContain('b@example.com');
  });

  it('soft-revokes an invite that already has an outstanding magic link', async () => {
    const { bootstrapHousehold, createHouseholdInvite, lookupInvite, revokeHouseholdInvite } =
      await lib();
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    mustOk(host, 'bootstrap failed');
    const created = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
    mustOk(created, 'invite creation failed');

    const { consumeMagicToken, issueMagicLink } = await import('@/lib/auth');
    const { token } = await issueMagicLink('alex@example.com', 'student', {
      inviteId: created.invite.id,
    });

    expect(revokeHouseholdInvite(host.userId, created.invite.id)).toEqual({ ok: true });
    expect(lookupInvite(created.token)).toBeNull();
    expect(consumeMagicToken(token)).toEqual({ ok: false, reason: 'invite-invalid' });

    const { db, schema } = await import('@/lib/db');
    const row = db
      .select()
      .from(schema.householdInvites)
      .where(eq(schema.householdInvites.id, created.invite.id))
      .get();
    expect(row?.revokedAt).toBeTruthy();
    expect(row?.consumedAt).toBeNull();
  });

  it('requires an email lock for parent invites', async () => {
    const { bootstrapHousehold, createHouseholdInvite, emailMayAcceptInvite, lookupInvite } =
      await lib();
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    mustOk(host, 'bootstrap failed');
    expect(createHouseholdInvite({ actorUserId: host.userId, role: 'parent' })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const created = createHouseholdInvite({
      actorUserId: host.userId,
      role: 'parent',
      email: 'other@example.com',
    });
    mustOk(created, 'invite creation failed');
    const invite = lookupInvite(created.token)!;
    expect(emailMayAcceptInvite(invite, 'stranger@example.com')).toBe(false);
    expect(emailMayAcceptInvite(invite, 'other@example.com')).toBe(true);
  });
});

describe('acceptInviteWithPassword', () => {
  it('does not stamp emailVerifiedAt without mailbox proof', async () => {
    const {
      bootstrapHousehold,
      createHouseholdInvite,
      acceptInviteWithPassword,
      getMembershipForEmail,
    } = await lib();
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    mustOk(host, 'bootstrap failed');
    const invite = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
    mustOk(invite, 'invite failed');

    const result = acceptInviteWithPassword({
      inviteToken: invite.token,
      email: 'alex@example.com',
      passwordHash: 'not-a-real-hash',
    });
    mustOk(result, 'accept failed');
    expect(getMembershipForEmail('alex@example.com')?.role).toBe('student');

    const { db, schema } = await import('@/lib/db');
    const user = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'alex@example.com'))
      .get();
    expect(user?.emailVerifiedAt ?? null).toBeNull();
  });
});

describe('removeHouseholdMember', () => {
  it('lets an admin remove a student and blocks self/admin removal', async () => {
    const {
      bootstrapHousehold,
      createHouseholdInvite,
      attachMembershipFromInvite,
      removeHouseholdMember,
      getMembershipForEmail,
      listHouseholdMembers,
    } = await lib();
    const { db, schema } = await import('@/lib/db');
    const host = bootstrapHousehold({ email: 'pat@example.com', householdName: 'Ours' });
    mustOk(host, 'bootstrap failed');
    const kid = db
      .insert(schema.users)
      .values({ email: 'kid@example.com', emailVerifiedAt: new Date() })
      .returning()
      .get()!;
    const created = createHouseholdInvite({ actorUserId: host.userId, role: 'student' });
    mustOk(created, 'invite creation failed');
    db.transaction((tx) => {
      attachMembershipFromInvite(tx, created.invite.id, kid.id, 'kid@example.com');
    });

    expect(removeHouseholdMember(host.userId, host.userId)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(removeHouseholdMember(host.userId, kid.id)).toEqual({ ok: true });
    expect(getMembershipForEmail('kid@example.com')).toBeNull();
    expect(listHouseholdMembers(host.householdId).some((m) => m.userId === kid.id)).toBe(false);
  });
});

describe('importLegacyFamiliesIfNeeded', () => {
  it('imports FAMILIES once when the DB is empty', async () => {
    Reflect.set(
      process.env,
      'FAMILIES',
      JSON.stringify([
        { child: 'alex@example.com', parents: ['pat@example.com'] },
        { child: 'sam@example.com', parents: ['other@example.com'] },
      ]),
    );
    const { importLegacyFamiliesIfNeeded, studentEmailsForParent, getMembershipForEmail } =
      await lib();
    const result = importLegacyFamiliesIfNeeded();
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(getMembershipForEmail('alex@example.com')?.role).toBe('student');
    expect(getMembershipForEmail('pat@example.com')?.role).toBe('admin');
    expect(studentEmailsForParent('pat@example.com')).toEqual(['alex@example.com']);
    expect(studentEmailsForParent('other@example.com')).toEqual(['sam@example.com']);
    expect(studentEmailsForParent('pat@example.com')).not.toContain('sam@example.com');

    const again = importLegacyFamiliesIfNeeded();
    expect(again.imported).toBe(0);
  });

  it('skips a malformed FAMILIES value without crashing in non-prod', async () => {
    Reflect.set(process.env, 'FAMILIES', '{not json');
    const { importLegacyFamiliesIfNeeded, hasAnyHousehold } = await lib();
    const result = importLegacyFamiliesIfNeeded();
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.error).toMatch(/json/i);
    expect(hasAnyHousehold()).toBe(false);
  });

  it('skips a standalone child (parents: []) so no orphan household is created', async () => {
    Reflect.set(
      process.env,
      'FAMILIES',
      JSON.stringify([
        { child: 'alex@example.com', parents: ['pat@example.com'] },
        { child: 'jess@example.com', parents: [] },
      ]),
    );
    const { importLegacyFamiliesIfNeeded, getMembershipForEmail, hasAnyHousehold } = await lib();
    const result = importLegacyFamiliesIfNeeded();
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(getMembershipForEmail('alex@example.com')?.role).toBe('student');
    expect(getMembershipForEmail('pat@example.com')?.role).toBe('admin');
    expect(getMembershipForEmail('jess@example.com')).toBeNull();
    expect(hasAnyHousehold()).toBe(true);
  });

  it('imports nothing when every FAMILIES entry is an orphan child', async () => {
    Reflect.set(
      process.env,
      'FAMILIES',
      JSON.stringify([{ child: 'jess@example.com', parents: [] }]),
    );
    const { importLegacyFamiliesIfNeeded, hasAnyHousehold } = await lib();
    const result = importLegacyFamiliesIfNeeded();
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(hasAnyHousehold()).toBe(false);
  });
});
