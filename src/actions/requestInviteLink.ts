'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { issueMagicLink } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { renderMagicLinkEmail, sendEmail } from '@/lib/email';
import { env, isTurnstileEnabled } from '@/lib/env';
import { emailMayAcceptInvite, lookupInvite } from '@/lib/households';
import { extractClientIp } from '@/lib/ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { siteConfig } from '@/lib/site';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  inviteToken: z.string().min(1),
  token: z.string().optional(),
});

export type RequestInviteLinkState =
  | { status: 'idle' }
  | { status: 'sent'; email: string }
  | {
      status: 'error';
      reason: 'invalid' | 'captcha' | 'rate_limited' | 'send_failed' | 'invite_invalid';
    };

/**
 * Accept an invite: issue a magic link that will attach household membership
 * on verify. Invalid invite tokens are reported (the URL is already the
 * secret). Email-lock mismatches still return the generic `sent` copy so
 * locked invites cannot be enumerated.
 */
export async function requestInviteLink(
  _prev: RequestInviteLinkState,
  formData: FormData,
): Promise<RequestInviteLinkState> {
  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';

  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    inviteToken: formData.get('inviteToken'),
    token: token || undefined,
  });
  if (!parsed.success) return { status: 'error', reason: 'invalid' };

  const ip = extractClientIp(await headers());
  if (isTurnstileEnabled() && !token) return { status: 'error', reason: 'invalid' };
  const captcha = await verifyTurnstile(token, ip);
  if (!captcha.ok) return { status: 'error', reason: 'captcha' };

  const limit = checkRateLimit(ip, 'signin');
  if (!limit.ok) return { status: 'error', reason: 'rate_limited' };

  // Look up after Turnstile + the signin bucket so probing tokens still
  // consume rate-limit (and captcha) like every other sign-in request.
  const invite = lookupInvite(parsed.data.inviteToken);
  if (!invite) return { status: 'error', reason: 'invite_invalid' };

  const { email } = parsed.data;
  if (emailMayAcceptInvite(invite, email)) {
    const { token: magic } = await issueMagicLink(email, invite.role, { inviteId: invite.id });
    const url = `${env.SITE_URL}/signin/verify?token=${encodeURIComponent(magic)}`;
    const rendered = renderMagicLinkEmail({ url, email, siteName: siteConfig.name });
    const result = await sendEmail({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (!result.ok) {
      console.error('[auth] invite magic-link delivery failed', { email, error: result.error });
    }
  }

  return { status: 'sent', email };
}
