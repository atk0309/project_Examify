import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OnboardingWizard } from '@/components/exam/OnboardingWizard';
import { getSession } from '@/lib/auth';
import { getAuthMode } from '@/lib/env';
import {
  canInvite,
  canRemoveMember,
  getMembershipForUser,
  hasAnyHousehold,
  labelFromEmail,
  listHouseholdMembers,
  listPendingInvites,
} from '@/lib/households';
import type { HouseholdMemberView } from '@/lib/household-types';
import {
  adminCanOpenOnboarding,
  getOnboardingForUser,
  getOnboardingSnapshot,
} from '@/lib/onboarding';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Content setup',
  description: 'Add subjects, attach study PDFs, generate BankIR, and emit the question bank.',
  robots: { index: false, follow: false },
};

export default async function OnboardingPage() {
  if (!hasAnyHousehold()) redirect('/setup');

  const session = await getSession();
  if (!session.userId || !session.role) redirect('/signin');

  const info = getOnboardingForUser(session.userId);
  if (!adminCanOpenOnboarding({ role: info.role, onboardingComplete: info.complete })) {
    redirect('/');
  }
  if (info.householdId == null) redirect('/');

  const membership = getMembershipForUser(session.userId);
  const pendingInvites =
    membership && canInvite(session.userId) ? listPendingInvites(membership.householdId) : [];
  const members: HouseholdMemberView[] =
    membership && canInvite(session.userId)
      ? listHouseholdMembers(membership.householdId).map((row) => {
          const target = getMembershipForUser(row.userId);
          return {
            userId: row.userId,
            email: row.email,
            role: row.role,
            label: labelFromEmail(row.email),
            canRemove: Boolean(target && canRemoveMember(membership, target)),
          };
        })
      : [];

  return (
    <div className="stage">
      <div className="app-frame app-frame-wizard">
        <OnboardingWizard
          snapshot={getOnboardingSnapshot(info.householdId)}
          pendingInvites={pendingInvites}
          members={members}
          canInvite={canInvite(session.userId)}
          authMode={getAuthMode()}
        />
      </div>
    </div>
  );
}
