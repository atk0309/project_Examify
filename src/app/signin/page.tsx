import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/exam/LoginForm';
import { getSession } from '@/lib/auth';
import { env } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in with a one-time email link.',
  robots: { index: false, follow: false },
};

export default async function SignInPage() {
  const session = await getSession();
  if (session.userId && session.role) {
    redirect('/');
  }
  return (
    <div className="stage">
      <div className="app-frame">
        <LoginForm siteKey={env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />
      </div>
    </div>
  );
}
