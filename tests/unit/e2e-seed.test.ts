import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2E_PASSWORD_ACCOUNTS, seedExampleFamily } from '../e2e/seed';

const TMP = path.join(process.cwd(), 'tests', '.tmp');
const DB_PATH = path.join(TMP, `e2e-seed-${process.pid}.db`);
Reflect.set(process.env, 'DATABASE_URL', `file:${DB_PATH}`);
delete process.env.FAMILIES;

const { student: STUDENT, parent: PARENT } = E2E_PASSWORD_ACCOUNTS;

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
  for (const file of [DB_PATH, `${DB_PATH}-shm`, `${DB_PATH}-wal`]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

/** Reset to an empty migrated DB, then seed the way `setup-db.ts` does. */
async function reseed(opts: { withPasswords?: boolean }) {
  const { resetLegacyImportLatch } = await import('@/lib/households');
  const sqlite = new Database(DB_PATH);
  sqlite.pragma('foreign_keys = ON');
  for (const table of [
    'exam_sessions',
    'exam_attempts',
    'rate_limit_events',
    'magic_tokens',
    'household_invites',
    'household_members',
    'households',
    'users',
  ]) {
    sqlite.prepare(`DELETE FROM ${table}`).run();
  }
  seedExampleFamily(sqlite, opts);
  sqlite.close();
  resetLegacyImportLatch();
}

function userId(email: string): number {
  const sqlite = new Database(DB_PATH, { readonly: true });
  const row = sqlite.prepare('SELECT id FROM users WHERE email = ?').get(email) as
    { id: number } | undefined;
  sqlite.close();
  if (!row) throw new Error(`no seeded user ${email}`);
  return row.id;
}

describe('seedExampleFamily (e2e seed)', () => {
  it('with passwords, both seeded accounts sign in with their known password and role', async () => {
    await reseed({ withPasswords: true });
    const { authenticatePassword } = await import('@/lib/auth');
    expect(authenticatePassword(STUDENT.email, STUDENT.password, 'student')).toMatchObject({
      ok: true,
      role: 'student',
      email: STUDENT.email,
    });
    expect(authenticatePassword(PARENT.email, PARENT.password, 'parent')).toMatchObject({
      ok: true,
      role: 'parent',
      email: PARENT.email,
    });
  });

  it('with passwords, a wrong password, swapped password, or wrong role is refused', async () => {
    await reseed({ withPasswords: true });
    const { authenticatePassword } = await import('@/lib/auth');
    expect(authenticatePassword(STUDENT.email, 'not-the-password', 'student')).toEqual({
      ok: false,
    });
    expect(authenticatePassword(STUDENT.email, PARENT.password, 'student')).toEqual({ ok: false });
    expect(authenticatePassword(STUDENT.email, STUDENT.password, 'parent')).toEqual({ ok: false });
    expect(authenticatePassword(PARENT.email, PARENT.password, 'student')).toEqual({ ok: false });
  });

  it('without passwords (magic-link seed), nobody has a hash so password sign-in fails', async () => {
    await reseed({});
    const { authenticatePassword } = await import('@/lib/auth');
    const { isHouseholdEmailAllowed } = await import('@/lib/households');
    expect(authenticatePassword(STUDENT.email, STUDENT.password, 'student')).toEqual({ ok: false });
    expect(authenticatePassword(PARENT.email, PARENT.password, 'parent')).toEqual({ ok: false });
    // Membership is still seeded for the magic-link suite.
    expect(isHouseholdEmailAllowed('student', STUDENT.email)).toBe(true);
    expect(isHouseholdEmailAllowed('parent', PARENT.email)).toBe(true);
  });

  it('makes the parent a verified household admin past onboarding, with the student as child', async () => {
    await reseed({ withPasswords: true });
    const { adminShouldAutoStartOnboarding, getOnboardingForUser } =
      await import('@/lib/onboarding');
    const { resolveChildren } = await import('@/lib/progress');
    const onboarding = getOnboardingForUser(userId(PARENT.email));
    expect(onboarding.role).toBe('admin');
    expect(onboarding.complete).toBe(true);
    expect(
      adminShouldAutoStartOnboarding({
        role: onboarding.role,
        onboardingComplete: onboarding.complete,
        state: onboarding.state,
      }),
    ).toBe(false);
    expect(resolveChildren(PARENT.email).map((child) => child.email)).toEqual([STUDENT.email]);

    const sqlite = new Database(DB_PATH, { readonly: true });
    const unverified = sqlite
      .prepare('SELECT COUNT(*) AS n FROM users WHERE email_verified_at IS NULL')
      .get() as { n: number };
    sqlite.close();
    expect(unverified.n).toBe(0);
  });
});
