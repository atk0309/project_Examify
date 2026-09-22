/**
 * Seed data shared by `tests/e2e/setup-db.ts` (writer) and the specs that sign
 * in as those people. Kept free of Playwright imports so the unit suite can
 * seed a migrated SQLite with it too.
 */
import type Database from 'better-sqlite3';
import { hashPassword } from '../../src/lib/password';

export const E2E_STUDENT_EMAIL = 'student@example.com';
export const E2E_PARENT_EMAIL = 'parent@example.com';

/**
 * Known credentials for the AUTH_MODE=password suite. Test-only values —
 * they live in a throwaway SQLite under `tests/.tmp/`.
 */
export const E2E_PASSWORD_ACCOUNTS = {
  student: { email: E2E_STUDENT_EMAIL, password: 'e2e-student-password' },
  parent: { email: E2E_PARENT_EMAIL, password: 'e2e-parent-password' },
} as const;

/**
 * One household: the parent is the household admin, the student is its only
 * child. Emails are verified and onboarding is complete, so the parent lands
 * on the dashboard (not `/onboarding`). With `withPasswords`, both users get
 * an scrypt hash from the app's own `hashPassword` so AUTH_MODE=password
 * sign-in works; without it they have no hash (magic-link / OTP seed).
 */
export function seedExampleFamily(
  sqlite: Database.Database,
  { withPasswords = false }: { withPasswords?: boolean } = {},
): void {
  const now = Date.now();
  const insertUser = sqlite.prepare(
    'INSERT INTO users (email, email_verified_at, password_hash, created_at) VALUES (?, ?, ?, ?)',
  );
  const hashFor = (password: string) => (withPasswords ? hashPassword(password) : null);
  const { student: studentAccount, parent: parentAccount } = E2E_PASSWORD_ACCOUNTS;
  const student = insertUser.run(studentAccount.email, now, hashFor(studentAccount.password), now);
  const parent = insertUser.run(parentAccount.email, now, hashFor(parentAccount.password), now);
  const household = sqlite
    .prepare('INSERT INTO households (name, created_at, onboarding_complete) VALUES (?, ?, ?)')
    .run('Example family', now, 1);
  const insertMember = sqlite.prepare(
    'INSERT INTO household_members (household_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
  );
  insertMember.run(household.lastInsertRowid, parent.lastInsertRowid, 'admin', now);
  insertMember.run(household.lastInsertRowid, student.lastInsertRowid, 'student', now);
}
