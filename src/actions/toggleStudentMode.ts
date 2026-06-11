'use server';

import { getSession } from '@/lib/auth';

export type SetStudentModeResult = { ok: true } | { ok: false; reason: 'forbidden' };

/**
 * Toggle a parent's "student mode" (the "Are you smarter than your kid?"
 * flow). Only a signed-in parent may set it — a real `userId` is required so a
 * partial/anonymous session is never mutated, matching `recordAttempt`'s guard.
 * The flag only unlocks the exam surface + write path for the parent; attempts
 * still persist under the parent's own id, never the student's.
 */
export async function setStudentMode(on: boolean): Promise<SetStudentModeResult> {
  const session = await getSession();
  if (!session.userId || session.role !== 'parent') {
    return { ok: false, reason: 'forbidden' };
  }

  session.studentMode = on === true;
  await session.save();
  return { ok: true };
}
