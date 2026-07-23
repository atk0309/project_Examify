'use server';

import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { saveExamSession, updateExamSession } from '@/lib/exam-session';
import { resolveExamPaper } from '@/lib/exam/data';

// The client autosaves the public paper (ordered question ids) + its own answers
// + where it is. No answer keys are involved — this is just the user's own draft.
const inputSchema = z
  .object({
    subject: z.string().min(1),
    difficulty: z.enum(['easy', 'medium', 'hard']),
    questionIds: z.array(z.string().min(1)).min(1).max(50),
    // Parallel to questionIds: mcq index | free text (capped like the textarea) | blank.
    answers: z.array(z.union([z.number().int(), z.string().max(4000), z.null()])),
    currentIndex: z.number().int().min(0),
  })
  // The two arrays must line up; a desynced snapshot is rejected rather than stored.
  .refine((v) => v.answers.length === v.questionIds.length, { path: ['answers'] });

export type SaveExamProgressInput = z.infer<typeof inputSchema>;

export type SaveExamProgressResult = { ok: true } | { ok: false; reason: 'forbidden' | 'invalid' };

const authorize = async () => {
  const session = await getSession();
  const canWrite =
    session.role === 'student' || (session.role === 'parent' && session.studentMode === true);
  return session.userId && canWrite ? session.userId : null;
};

function isValidSnapshot(input: SaveExamProgressInput): boolean {
  const questions = resolveExamPaper(input.subject, input.difficulty, input.questionIds);
  if (questions === null || input.currentIndex >= questions.length) return false;

  return questions.every((question, index) => {
    const answer = input.answers[index]!;
    if (answer === null) return true;
    if (question.type === 'free') return typeof answer === 'string';
    return (
      typeof answer === 'number' &&
      Number.isInteger(answer) &&
      answer >= 0 &&
      answer < question.choices.length
    );
  });
}

/**
 * Create the resumable draft when an exam STARTS. Same write gate as `recordAttempt`:
 * a `student`, or a `parent` in student mode — always the caller's own `session.userId`,
 * never a client-supplied id. Autosaves go through {@link saveExamProgress} (update-only).
 */
export async function beginExamSession(
  input: SaveExamProgressInput,
): Promise<SaveExamProgressResult> {
  const userId = await authorize();
  if (!userId) return { ok: false, reason: 'forbidden' };

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || !isValidSnapshot(parsed.data)) {
    return { ok: false, reason: 'invalid' };
  }

  saveExamSession(userId, parsed.data);
  return { ok: true };
}

/**
 * Autosave (checkpoint) an in-progress mini exam — called debounced on each answer
 * and flushed on every Next/Back. Update-only: it never recreates the row, so a
 * save still in flight when the exam is finished or discarded can't resurrect a
 * cleared draft. Same own-id write gate as {@link beginExamSession}.
 */
export async function saveExamProgress(
  input: SaveExamProgressInput,
): Promise<SaveExamProgressResult> {
  const userId = await authorize();
  if (!userId) return { ok: false, reason: 'forbidden' };

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || !isValidSnapshot(parsed.data)) {
    return { ok: false, reason: 'invalid' };
  }

  updateExamSession(userId, parsed.data);
  return { ok: true };
}
