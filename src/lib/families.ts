import { z } from 'zod';

/**
 * Optional one-shot importer for leftover `FAMILIES` env JSON.
 *
 * Access is now invite-only households in SQLite. This parser stays so an
 * existing Railway / env-JSON deploy can be imported once when the DB has
 * no households (`importLegacyFamiliesIfNeeded` in `src/lib/households.ts`).
 * New installs should leave `FAMILIES` unset and use first-run bootstrap.
 *
 * Still parsed strictly: a duplicated child, an email used as both child and
 * parent, or a parent shared across families is rejected so a mis-grouping
 * cannot leak one household's child into another.
 *
 * This module is pure: it does NOT import `@/lib/env` or the database.
 */
export type Family = {
  /** The student's email. Required, unique across all families. */
  child: string;
  /** The parent email(s) who may view this child. `[]` is parse-valid (legacy
   * standalone child) but is **not** imported — it would create an orphan
   * household with no admin. */
  parents: string[];
};

/** Normalise an email the same way everywhere: trimmed + lowercased. */
function normalise(email: string): string {
  return email.trim().toLowerCase();
}

const emailSchema = z.string().transform(normalise).pipe(z.string().email());

const familySchema = z.object({
  child: emailSchema,
  // Missing/`null` parents default to [] (legacy standalone child).
  parents: z.array(emailSchema).default([]),
});

const familiesArraySchema = z.array(familySchema);

export type ParseFamiliesResult = { ok: true; families: Family[] } | { ok: false; error: string };

/**
 * Parse + validate the raw `FAMILIES` JSON string into normalised families.
 *
 * Strict by design (this is the privacy boundary):
 * - empty/whitespace input ⇒ `[]` (fails closed — nobody can sign in);
 * - malformed JSON or an invalid email ⇒ `{ ok: false }` with a readable error;
 * - every email is trimmed + lowercased; duplicate parents *within* a family are
 *   de-duped silently;
 * - a child email appearing in two families, an email used as both a child and a
 *   parent, or a parent shared across families are all *rejected* — these are
 *   ambiguous groupings that could leak cross-family, and the one-child dashboard
 *   can't represent them anyway.
 */
export function parseFamilies(raw: string): ParseFamiliesResult {
  if (raw.trim() === '') return { ok: true, families: [] };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }

  const parsed = familiesArraySchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
    return { ok: false, error: `${issue?.message ?? 'invalid shape'}${where}` };
  }

  // De-dupe parents within each family, preserving config order.
  const families: Family[] = parsed.data.map((f) => ({
    child: f.child,
    parents: Array.from(new Set(f.parents)),
  }));

  // Ambiguity checks across families.
  const seenChildren = new Set<string>();
  const seenParents = new Set<string>();
  for (const family of families) {
    if (seenChildren.has(family.child)) {
      return { ok: false, error: `duplicate child email "${family.child}"` };
    }
    seenChildren.add(family.child);
  }
  for (const family of families) {
    for (const parent of family.parents) {
      if (seenChildren.has(parent)) {
        return { ok: false, error: `email "${parent}" is used as both a child and a parent` };
      }
      if (seenParents.has(parent)) {
        return {
          ok: false,
          error: `parent "${parent}" appears in more than one family (unsupported)`,
        };
      }
      seenParents.add(parent);
    }
  }

  return { ok: true, families };
}

/** The student sign-in allowlist: every child email, de-duped, config order. */
export function studentEmails(families: Family[]): string[] {
  return Array.from(new Set(families.map((f) => f.child)));
}

/** The parent sign-in allowlist: every parent email across all families. */
export function parentEmails(families: Family[]): string[] {
  return Array.from(new Set(families.flatMap((f) => f.parents)));
}

/**
 * The child email(s) a given parent may view — the `child` of each family whose
 * `parents` includes this email. Empty for an unknown parent or a standalone
 * child's family (which has no parents). Drives `resolveChildren()`.
 */
export function childEmailsForParent(families: Family[], parentEmail: string): string[] {
  const normalised = normalise(parentEmail);
  if (!normalised) return [];
  return families.filter((f) => f.parents.includes(normalised)).map((f) => f.child);
}
