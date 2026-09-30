'use server';

import { getSession } from '@/lib/auth';
import { getProgressForUser, retrySavedAttempt } from '@/lib/progress';
import type { RecordAttemptResult } from './recordAttempt';

/** Explicit recovery for the caller's own saved answers; never writes a child's work. */
export async function retryAttemptGrading(attemptId: number): Promise<RecordAttemptResult> {
  const session = await getSession();
  const canWrite =
    session.role === 'student' || (session.role === 'parent' && session.studentMode === true);
  if (!session.userId || !canWrite) return { ok: false, reason: 'forbidden' };
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) return { ok: false, reason: 'invalid' };
  const result = await retrySavedAttempt(session.userId, attemptId);
  if (!result.ok) return { ok: false, reason: result.reason === 'busy' ? 'busy' : 'invalid' };
  return { ...result, progress: getProgressForUser(session.userId) };
}
