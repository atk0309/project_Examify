import type { Metadata } from 'next';
import { InviteAcceptForm } from '@/components/exam/InviteAcceptForm';
import {
  env,
  getAuthMode,
  isTurnstileEnabled,
  mailboxDelivery,
  resolveMailTransport,
} from '@/lib/env';
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
              <p className="sent-note">
                This invite is invalid or has expired. Ask a parent for a new link.
              </p>
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
          authMode={getAuthMode()}
          mailboxDelivery={mailboxDelivery()}
          codeDelivery={resolveMailTransport()}
          siteKey={isTurnstileEnabled() ? env.NEXT_PUBLIC_TURNSTILE_SITE_KEY : undefined}
        />
      </div>
    </div>
  );
}
