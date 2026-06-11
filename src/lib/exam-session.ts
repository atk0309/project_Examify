import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from './db';
import type { DifficultyId } from './exam/data';

/**
 * Persist + resume an IN-PROGRESS mini exam (the `exam_sessions` table). Always
 * keyed by `userId` — the caller's own id, resolved server-side — so a malformed
 * or client-supplied id can never read or write another person's session. Stores
 * only public question ids + the user's own answers; no answer keys (see schema).
 */

/** An autosaved answer, parallel to `questionIds`: mcq index | free text | blank. */
export type SessionAnswer = number | string | null;

export type ExamSessionInput = {
  subject: string;
  difficulty: DifficultyId;
  /** The exact ordered paper (public question ids). */
  questionIds: string[];
  /** Answers parallel to `questionIds`. */
  answers: SessionAnswer[];
  /** The question the user was on. */
  currentIndex: number;
};

export type ResumableSession = ExamSessionInput & { startedAt: number; updatedAt: number };

/**
 * Create (or replace) the active session for `(userId, subject, difficulty)`.
 * Used once when an exam STARTS; autosaves use {@link updateExamSession} instead.
 * Re-starting the same combo replaces the prior row.
 */
export function saveExamSession(userId: number, input: ExamSessionInput): void {
  const now = new Date();
  db.insert(schema.examSessions)
    .values({
      userId,
      subject: input.subject,
      difficulty: input.difficulty,
      questionIds: input.questionIds,
      answers: input.answers,
      currentIndex: input.currentIndex,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.examSessions.userId,
        schema.examSessions.subject,
        schema.examSessions.difficulty,
      ],
      set: {
        questionIds: input.questionIds,
        answers: input.answers,
        currentIndex: input.currentIndex,
        updatedAt: now,
      },
    })
    .run();
}

/**
 * Checkpoint an in-progress exam — the autosave path. Unlike {@link saveExamSession}
 * this is **update-only**: it never inserts, so a debounced save still in flight when
 * the exam is finished (`recordAttempt` clears the row) or discarded can't resurrect
 * the deleted draft — the late UPDATE simply matches zero rows. Returns whether a
 * live row was actually updated. Full snapshot, so an out-of-order write among live
 * checkpoints only rewrites the whole row (last arrival wins).
 */
export function updateExamSession(userId: number, input: ExamSessionInput): boolean {
  const res = db
    .update(schema.examSessions)
    .set({
      questionIds: input.questionIds,
      answers: input.answers,
      currentIndex: input.currentIndex,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.examSessions.userId, userId),
        eq(schema.examSessions.subject, input.subject),
        eq(schema.examSessions.difficulty, input.difficulty),
      ),
    )
    .run();
  return res.changes > 0;
}

/** All active in-progress exams for a user, newest-first (for the resume list). */
export function getExamSessions(userId: number): ResumableSession[] {
  const rows = db
    .select()
    .from(schema.examSessions)
    .where(eq(schema.examSessions.userId, userId))
    .orderBy(desc(schema.examSessions.updatedAt), desc(schema.examSessions.id))
    .all();
  return rows.map((row) => ({
    subject: row.subject,
    difficulty: row.difficulty as DifficultyId,
    questionIds: row.questionIds,
    answers: row.answers,
    currentIndex: row.currentIndex,
    startedAt: row.startedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  }));
}

/** Delete the session matching `(userId, subject, difficulty)`. Idempotent. */
export function clearExamSession(userId: number, subject: string, difficulty: DifficultyId): void {
  db.delete(schema.examSessions)
    .where(
      and(
        eq(schema.examSessions.userId, userId),
        eq(schema.examSessions.subject, subject),
        eq(schema.examSessions.difficulty, difficulty),
      ),
    )
    .run();
}
