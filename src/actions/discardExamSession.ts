'use server';

import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { clearExamSession } from '@/lib/exam-session';

const inputSchema = z.object({
  subject: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
});

export type DiscardExamSessionInput = z.infer<typeof inputSchema>;

export type DiscardExamSessionResult =
  | { ok: true }
  | { ok: false; reason: 'forbidden' | 'invalid' };

/**
 * Abandon an in-progress mini exam so it stops being resumable — used when the
 * user leaves an unfinished exam back to the dashboard, or dismisses a resume
 * card. Same gate as `recordAttempt`/`saveExamProgress`; clears only the caller's
 * own `(userId, subject, difficulty)` row. Idempotent.
 */
export async function discardExamSession(
  input: DiscardExamSessionInput,
): Promise<DiscardExamSessionResult> {
  const session = await getSession();
  const canWrite =
    session.role === 'student' || (session.role === 'parent' && session.studentMode === true);
  if (!session.userId || !canWrite) {
    return { ok: false, reason: 'forbidden' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'invalid' };

  clearExamSession(session.userId, parsed.data.subject, parsed.data.difficulty);
  return { ok: true };
}
