import 'server-only';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from './db';
import { labelFromEmail, studentEmailsForParent } from './households';
import {
  summariseAttempts,
  type AttemptInput,
  type AttemptRecord,
  type ProgressData,
} from './exam/attempts';
import { scoreAttempt } from './exam/score.server';
import type { DifficultyId } from './exam/data';

/** Cap on how many attempts a progress view loads. */
const ATTEMPT_LIMIT = 50;

export type SaveAttemptResult =
  | { ok: true; scorePct: number; attempt: AttemptRecord }
  | { ok: false; reason: 'invalid_subject' | 'invalid_difficulty' | 'invalid_items' };

/**
 * Validate + score a submitted attempt and persist it for `userId` (the student
 * who sat it, or a parent in student mode — always the caller's own id). The
 * score is re-derived from the items here (the client's totals are ignored), so
 * a caller can pass straight-through whatever the browser sent. Free-text items
 * are graded server-side, so this is async. Returns the freshly-inserted
 * attempt so the caller can render results without a re-read.
 */
export async function saveAttempt(userId: number, input: AttemptInput): Promise<SaveAttemptResult> {
  const scored = await scoreAttempt(input);
  if (!scored.ok) return scored;

  const row = db
    .insert(schema.examAttempts)
    .values({
      userId,
      subject: scored.subject,
      difficulty: scored.difficulty,
      total: scored.total,
      correct: scored.correct,
      scorePct: scored.scorePct,
      items: scored.items,
    })
    .returning()
    .get();

  return { ok: true, scorePct: scored.scorePct, attempt: toRecord(row) };
}

function toRecord(row: schema.ExamAttempt): AttemptRecord {
  return {
    id: row.id,
    subject: row.subject,
    difficulty: row.difficulty as DifficultyId,
    total: row.total,
    correct: row.correct,
    scorePct: row.scorePct,
    createdAt: row.createdAt.getTime(),
    items: row.items,
  };
}

/** All progress (recent attempts + per-subject summaries) for one user. */
export function getProgressForUser(userId: number): ProgressData {
  const rows = db
    .select()
    .from(schema.examAttempts)
    .where(eq(schema.examAttempts.userId, userId))
    .orderBy(desc(schema.examAttempts.createdAt), desc(schema.examAttempts.id))
    .limit(ATTEMPT_LIMIT)
    .all();

  const attempts = rows.map(toRecord);
  return { attempts, subjects: summariseAttempts(attempts) };
}

/**
 * Full chronological (oldest-first) `scorePct` series for one user — uncapped,
 * unlike `getProgressForUser` which loads only the most recent {@link ATTEMPT_LIMIT}.
 * Selects just `scorePct` (no `items` JSON), so it stays cheap to plot "score by
 * attempt number" where attempt #1 must be the user's *true* first attempt.
 */
export function getScoreHistory(userId: number): number[] {
  const rows = db
    .select({ scorePct: schema.examAttempts.scorePct })
    .from(schema.examAttempts)
    .where(eq(schema.examAttempts.userId, userId))
    .orderBy(asc(schema.examAttempts.createdAt), asc(schema.examAttempts.id))
    .all();
  return rows.map((r) => r.scorePct);
}

export type Child = { id: number; email: string; label: string };

/**
 * Resolve which children a parent may view — their own household's
 * student(s) only. This is the privacy boundary: a parent/admin never
 * sees another household's child. A student with no parent/admin in
 * their household appears in no dashboard.
 *
 * Only students who have a `users` row resolve. Ownership stays
 * structural via `users.id`.
 */
export function resolveChildren(parentEmail: string): Child[] {
  const childEmails = studentEmailsForParent(parentEmail);
  if (childEmails.length === 0) return [];
  const rows = db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.email, childEmails))
    .all();
  const byEmail = new Map(rows.map((row) => [row.email, row]));
  return childEmails.flatMap((email) => {
    const row = byEmail.get(email);
    return row ? [{ id: row.id, email: row.email, label: labelFromEmail(row.email) }] : [];
  });
}
