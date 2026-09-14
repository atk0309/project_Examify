import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/exam/LoginForm';
import { getSession } from '@/lib/auth';
import { env, isTurnstileEnabled } from '@/lib/env';
import { hasAnyHousehold } from '@/lib/households';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in with a one-time email link.',
  robots: { index: false, follow: false },
};

export default async function SignInPage() {
  if (!hasAnyHousehold()) {
    redirect('/setup');
  }
  const session = await getSession();
  if (session.userId && session.role) {
    redirect('/');
  }
  return (
    <div className="stage">
      <div className="app-frame">
        <LoginForm
          siteKey={isTurnstileEnabled() ? env.NEXT_PUBLIC_TURNSTILE_SITE_KEY : undefined}
        />
      </div>
    </div>
  );
}
