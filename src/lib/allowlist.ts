import { env } from './env';
import { parentEmails, studentEmails } from './families';

/**
 * Role-gated sign-in, derived from the `FAMILIES` config (`src/lib/families.ts`).
 * Examify has no DB-backed accounts and no admin — the `FAMILIES` env var IS the
 * credential store (same runtime-config pattern as `SITE_URL`).
 *
 * An address may request a magic link for a role only if `FAMILIES` lists it in
 * that role: a `student` must appear as some family's `child`; a `parent` must
 * appear in some family's `parents[]`. The match is case-insensitive and
 * whitespace-trimmed; an empty config fails closed (nobody can sign in).
 */
export type Role = 'student' | 'parent';

/** True iff `email` is allowed to sign in for `role`. */
export function isAllowedEmail(role: Role, email: string): boolean {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return false;
  const allowed = role === 'student' ? studentEmails(env.FAMILIES) : parentEmails(env.FAMILIES);
  return allowed.includes(normalised);
}
