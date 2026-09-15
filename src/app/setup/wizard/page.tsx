import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SetupWizard } from '@/components/exam/SetupWizard';
import { getSession } from '@/lib/auth';
import { getMembershipForUser, hasAnyHousehold } from '@/lib/households';
import { getWizardSnapshot, parentNeedsSetupWizard } from '@/lib/setup-wizard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Set up your subjects',
  description: 'Add subjects, attach study files, and emit the question bank.',
  robots: { index: false, follow: false },
};

export default async function SetupWizardPage() {
  if (!hasAnyHousehold()) redirect('/setup');

  const session = await getSession();
  if (!session.userId || !session.role) redirect('/signin');
  if (session.role !== 'parent' || !parentNeedsSetupWizard(session.userId)) {
    redirect('/');
  }

  const membership = getMembershipForUser(session.userId);
  if (!membership) redirect('/');

  return (
    <div className="stage">
      <div className="app-frame">
        <SetupWizard snapshot={getWizardSnapshot(membership.householdId)} />
      </div>
    </div>
  );
}
