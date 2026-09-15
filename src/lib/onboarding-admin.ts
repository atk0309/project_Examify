import 'server-only';

import { getSession } from '@/lib/auth';
import { adminCanOpenOnboarding, getOnboardingForUser } from '@/lib/onboarding';

export type OnboardingAdminGate =
  { ok: true; householdId: number } | { ok: false; reason: 'forbidden' | 'already_complete' };

/** Parent household admin, and onboarding is still open. */
export async function requireOnboardingAdmin(): Promise<OnboardingAdminGate> {
  const session = await getSession();
  if (!session.userId || session.role !== 'parent') {
    return { ok: false, reason: 'forbidden' };
  }
  const info = getOnboardingForUser(session.userId);
  if (!adminCanOpenOnboarding({ role: info.role, onboardingComplete: info.complete })) {
    return { ok: false, reason: info.complete ? 'already_complete' : 'forbidden' };
  }
  if (info.householdId == null) return { ok: false, reason: 'forbidden' };
  return { ok: true, householdId: info.householdId };
}
