'use server';

import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { getProgressForUser, saveAttempt } from '@/lib/progress';
import { clearExamSession } from '@/lib/exam-session';
import type { AttemptRecord, ProgressData } from '@/lib/exam/attempts';
import type { DifficultyId } from '@/lib/exam/data';

// The client submits only what it legitimately knows: the question `id` and the
// student's answer. The question snapshot, the correct index and the rubric are
// resolved server-side by `id` (the client never holds the answer key).
const mcqItemSchema = z.object({
  type: z.literal('mcq'),
  id: z.string().min(1),
  chosen: z.number().int().nullable(),
});

const freeItemSchema = z.object({
  type: z.literal('free'),
  id: z.string().min(1),
  response: z.string().trim().min(1).max(4000),
});

const itemSchema = z.discriminatedUnion('type', [mcqItemSchema, freeItemSchema]);

const inputSchema = z.object({
  subject: z.string().min(1),
  difficulty: z.string().min(1),
  items: z.array(itemSchema).min(1),
});

export type RecordAttemptInput = z.infer<typeof inputSchema>;

export type RecordAttemptResult =
  | { ok: true; scorePct: number; attempt: AttemptRecord; progress: ProgressData }
  | { ok: false; reason: 'forbidden' | 'invalid' };

/**
 * Persist a completed mini exam. The write path is open to a `student`, or to a
 * `parent` who has explicitly entered student mode (`session.studentMode`) — the
 * "Are you smarter than your kid?" flow. Either way it writes only for
 * the caller's own `session.userId`: a parent's attempts accumulate under the
 * parent's id, never the student's, and a client-supplied id is never honoured.
 * The score is re-derived server-side in `saveAttempt`.
 */
export async function recordAttempt(input: RecordAttemptInput): Promise<RecordAttemptResult> {
  const session = await getSession();
  const canWrite =
    session.role === 'student' || (session.role === 'parent' && session.studentMode === true);
  if (!session.userId || !canWrite) {
    return { ok: false, reason: 'forbidden' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid' };

  const result = await saveAttempt(session.userId, parsed.data);
  if (!result.ok) return { ok: false, reason: 'invalid' };

  // The exam is finished — drop any in-progress session for this combo so it no
  // longer shows up as resumable (server-side, not reliant on the client).
  clearExamSession(session.userId, parsed.data.subject, parsed.data.difficulty as DifficultyId);

  return {
    ok: true,
    scorePct: result.scorePct,
    attempt: result.attempt,
    progress: getProgressForUser(session.userId),
  };
}
