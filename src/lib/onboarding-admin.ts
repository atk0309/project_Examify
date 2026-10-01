import 'server-only';

import { getSession } from '@/lib/auth';
import { adminCanOpenOnboarding, getOnboardingForUser } from '@/lib/onboarding';
import { isSoloMode } from '@/lib/env';
import { getSoloIdentity } from '@/lib/solo';

export type OnboardingAdminGate =
  { ok: true; householdId: number } | { ok: false; reason: 'forbidden' | 'already_complete' };

/** Household first-run admin, or the verified local solo owner managing their content. */
export async function requireOnboardingAdmin(): Promise<OnboardingAdminGate> {
  const session = await getSession();
  if (!session.userId || session.role !== 'parent') {
    return { ok: false, reason: 'forbidden' };
  }
  const info = getOnboardingForUser(session.userId);
  const solo = isSoloMode();
  if (solo) {
    const identity = session.solo === true ? getSoloIdentity() : null;
    if (
      !identity ||
      identity.userId !== session.userId ||
      identity.householdId !== info.householdId
    ) {
      return { ok: false, reason: 'forbidden' };
    }
  }
  if (!adminCanOpenOnboarding({ role: info.role, onboardingComplete: info.complete, solo })) {
    return { ok: false, reason: info.complete ? 'already_complete' : 'forbidden' };
  }
  if (info.householdId == null) return { ok: false, reason: 'forbidden' };
  return { ok: true, householdId: info.householdId };
}
