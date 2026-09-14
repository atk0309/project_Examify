import type { Metadata } from 'next';
import Link from 'next/link';
import { InviteAcceptForm } from '@/components/exam/InviteAcceptForm';
import { env, isTurnstileEnabled } from '@/lib/env';
import { lookupInvite } from '@/lib/households';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Join household',
  description: 'Accept a household invite.',
  robots: { index: false, follow: false },
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = lookupInvite(token);

  if (!invite) {
    return (
      <div className="stage">
        <div className="app-frame">
          <div className="login">
            <div className="sent-state">
              <h1 className="sent-title">Invite invalid</h1>
              <p className="sent-note">This invite is invalid or has expired.</p>
              <div className="mt-6 flex flex-col gap-[var(--sp-2)]">
                <Link className="btn btn-primary" href="/signin">
                  Sign in
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stage">
      <div className="app-frame">
        <InviteAcceptForm
          inviteToken={token}
          role={invite.role}
          lockedEmail={invite.email}
          siteKey={isTurnstileEnabled() ? env.NEXT_PUBLIC_TURNSTILE_SITE_KEY : undefined}
        />
      </div>
    </div>
  );
}
