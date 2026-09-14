import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SetupForm } from '@/components/exam/SetupForm';
import { getSession } from '@/lib/auth';
import { isTurnstileEnabled, env } from '@/lib/env';
import { hasAnyHousehold } from '@/lib/households';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Set up Examify',
  description: 'Create the first household for this Examify instance.',
  robots: { index: false, follow: false },
};

export default async function SetupPage() {
  if (hasAnyHousehold()) {
    const session = await getSession();
    if (session.userId && session.role) redirect('/');
    redirect('/signin');
  }

  return (
    <div className="stage">
      <div className="app-frame">
        <SetupForm
          siteKey={isTurnstileEnabled() ? env.NEXT_PUBLIC_TURNSTILE_SITE_KEY : undefined}
        />
      </div>
    </div>
  );
}
