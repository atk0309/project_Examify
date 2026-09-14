import { isHouseholdEmailAllowed } from './households';

/**
 * Role-gated sign-in, derived from household membership (SQLite).
 * An address may request a magic link for a role only if they belong to a
 * household in that role: a `student` must be a student member; a `parent`
 * must be a parent or admin member. The match is case-insensitive and
 * whitespace-trimmed; an empty household table fails closed (nobody can
 * sign in until first-run bootstrap or an invite accept).
 */
export type Role = 'student' | 'parent';

/** True iff `email` is allowed to sign in for `role`. */
export function isAllowedEmail(role: Role, email: string): boolean {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return false;
  return isHouseholdEmailAllowed(role, normalised);
}
