import 'server-only';
import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { db, schema } from './db';
import { labelFromEmail, studentEmailsForParent } from './households';
import {
  summariseAttempts,
  pendingCount,
  summarizeScore,
  type AttemptInput,
  type AttemptRecord,
  type ProgressData,
} from './exam/attempts';
import { prepareAttempt, gradePreparedItems } from './exam/score.server';
import type { DifficultyId } from './exam/data';
import { loadLivePublicBank } from './exam/live-bank.server';
import { markingBackendForUser } from './onboarding';
import type { MarkingBackend } from './onboarding-types';

/** Cap on how many attempts a progress view loads. */
const ATTEMPT_LIMIT = 50;

export type SaveAttemptResult =
  | { ok: true; scorePct: number; attempt: AttemptRecord }
  | { ok: false; reason: 'invalid_subject' | 'invalid_difficulty' | 'invalid_items' | 'busy' };

/**
 * Validate + score a submitted attempt and persist it for `userId` (the student
 * who sat it, or a parent in student mode — always the caller's own id). The
 * score is re-derived from the items here (the client's totals are ignored), so
 * a caller can pass straight-through whatever the browser sent. Free-text items
 * are marked server-side by the caller's household AI (`markingBackendForUser`),
 * so this is async. Returns the freshly-inserted attempt so the caller can
 * render results without a re-read.
 */
export async function saveAttempt(
  userId: number,
  input: AttemptInput,
  markingBackend: MarkingBackend = markingBackendForUser(userId),
): Promise<SaveAttemptResult> {
  // The action requires a stable ID; direct trusted callers may create fresh exams.
  const submissionId = input.submissionId ?? crypto.randomUUID();
  const submissionHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        subject: input.subject,
        difficulty: input.difficulty,
        items: input.items,
      }),
    )
    .digest('hex');
  const existing = db
    .select()
    .from(schema.examAttempts)
    .where(
      and(
        eq(schema.examAttempts.userId, userId),
        eq(schema.examAttempts.submissionId, submissionId),
      ),
    )
    .get();
  if (existing)
    return existing.submissionHash === submissionHash
      ? savedResult(existing)
      : { ok: false, reason: 'invalid_items' };

  const prepared = prepareAttempt(input);
  if (!prepared.ok) return prepared;
  const row = db.transaction((tx) => {
    const inserted = tx
      .insert(schema.examAttempts)
      .values({
        userId,
        submissionId,
        submissionHash,
        subject: prepared.subject,
        difficulty: prepared.difficulty,
        total: prepared.total,
        correct: prepared.correct,
        scorePct: prepared.scorePct,
        items: prepared.items,
        gradingTasks: prepared.gradingTasks,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (inserted) {
      // Submission freezes the answers. Atomically remove its editable draft so
      // a process crash during marking cannot offer those frozen answers to edit.
      tx.delete(schema.examSessions)
        .where(
          and(
            eq(schema.examSessions.userId, userId),
            eq(schema.examSessions.subject, input.subject),
            eq(schema.examSessions.difficulty, prepared.difficulty),
            eq(schema.examSessions.submissionId, submissionId),
          ),
        )
        .run();
    }
    return inserted;
  });
  if (!row) {
    // A different process reserved this ID between the lookup and insert.
    const winner = db
      .select()
      .from(schema.examAttempts)
      .where(
        and(
          eq(schema.examAttempts.userId, userId),
          eq(schema.examAttempts.submissionId, submissionId),
        ),
      )
      .get();
    return winner?.submissionHash === submissionHash
      ? savedResult(winner)
      : { ok: false, reason: 'invalid_items' };
  }
  return retrySavedAttempt(userId, row.id, markingBackend);
}

function savedResult(row: schema.ExamAttempt): SaveAttemptResult {
  const attempt = toRecord(row);
  return { ok: true, scorePct: attempt.scorePct, attempt };
}

// Provider calls have a <=45s deadline. Two minutes also covers process teardown.
// A crashed process can be retried after this lease; stale workers cannot overwrite
// the winner. Exactly-once provider billing across a crash is not guaranteed.
export const GRADING_LEASE_MS = 120_000;

export async function retrySavedAttempt(
  userId: number,
  attemptId: number,
  markingBackend: MarkingBackend = markingBackendForUser(userId),
): Promise<SaveAttemptResult> {
  const owned = and(eq(schema.examAttempts.id, attemptId), eq(schema.examAttempts.userId, userId));
  const row = db.select().from(schema.examAttempts).where(owned).get();
  if (!row) return { ok: false, reason: 'invalid_items' };
  if (pendingCount(row.items) === 0) return savedResult(row);
  if (!row.gradingTasks?.length) return { ok: false, reason: 'invalid_items' };
  const lease = crypto.randomUUID();
  const claimed = db
    .update(schema.examAttempts)
    .set({
      gradingLease: lease,
      gradingLeaseUntil: Date.now() + GRADING_LEASE_MS,
    })
    .where(
      and(
        owned,
        or(
          isNull(schema.examAttempts.gradingLeaseUntil),
          lt(schema.examAttempts.gradingLeaseUntil, Date.now()),
        ),
      ),
    )
    .returning()
    .get();
  if (!claimed) return { ok: false, reason: 'busy' };

  try {
    const items = await gradePreparedItems(
      claimed.items,
      claimed.gradingTasks ?? [],
      markingBackend,
    );
    db.update(schema.examAttempts)
      .set({
        items,
        ...summarizeScore(items),
        gradingLease: null,
        gradingLeaseUntil: null,
      })
      .where(and(owned, eq(schema.examAttempts.gradingLease, lease)))
      .run();
  } catch {
    // Unexpected failures preserve the durable answers and original rubric snapshot.
    // Do not log provider errors, which may contain student answers or credentials.
    db.update(schema.examAttempts)
      .set({ gradingLease: null, gradingLeaseUntil: null })
      .where(and(owned, eq(schema.examAttempts.gradingLease, lease)))
      .run();
  }
  const latest = db.select().from(schema.examAttempts).where(owned).get();
  return latest ? savedResult(latest) : { ok: false, reason: 'invalid_items' };
}

function toRecord(row: schema.ExamAttempt): AttemptRecord {
  return {
    id: row.id,
    subject: row.subject,
    difficulty: row.difficulty as DifficultyId,
    ...summarizeScore(row.items),
    canRetryGrading: pendingCount(row.items) > 0 && !!row.gradingTasks?.length,
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
  return { attempts, subjects: summariseAttempts(attempts, loadLivePublicBank().subjects) };
}

/**
 * Full chronological (oldest-first) `scorePct` series for one user — uncapped,
 * unlike `getProgressForUser` which loads only the most recent {@link ATTEMPT_LIMIT}.
 * Omits provisional attempts so provider outages cannot distort comparisons.
 * The chart counts only fully marked attempts, oldest first.
 */
export function getScoreHistory(userId: number): number[] {
  const rows = db
    .select({ scorePct: schema.examAttempts.scorePct, items: schema.examAttempts.items })
    .from(schema.examAttempts)
    .where(eq(schema.examAttempts.userId, userId))
    .orderBy(asc(schema.examAttempts.createdAt), asc(schema.examAttempts.id))
    .all();
  return rows.filter((r) => pendingCount(r.items) === 0).map((r) => r.scorePct);
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
