'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { invalidateIssuedToken, issueLocalOtp, issueMagicLink } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { renderMagicLinkEmail, renderOtpEmail, sendEmail } from '@/lib/email';
import { env, getAuthMode, isTurnstileEnabled } from '@/lib/env';
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
 * Issues the configured magic-link or local-OTP challenge for an eligible
 * invite. Verification attaches the new household membership. Invalid invite
 * tokens are reported because the URL is already secret; email-lock mismatches
 * still return `sent` so locked addresses cannot be enumerated.
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

  const mode = getAuthMode();
  if (mode === 'password') return { status: 'error', reason: 'invalid' };

  const { email } = parsed.data;
  if (emailMayAcceptInvite(invite, email)) {
    if (mode === 'local-otp') {
      const { id, code } = issueLocalOtp(email, invite.role, { inviteId: invite.id });
      const rendered = renderOtpEmail({ code, email, siteName: siteConfig.name });
      const result = await sendEmail({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        code,
      });
      if (!result.ok) {
        invalidateIssuedToken(id);
        console.error('[auth] invite local-otp delivery failed', { error: result.error });
      }
    } else {
      const { id, token: magic } = await issueMagicLink(email, invite.role, {
        inviteId: invite.id,
      });
      const url = `${env.SITE_URL}/signin/verify?token=${encodeURIComponent(magic)}`;
      const rendered = renderMagicLinkEmail({ url, email, siteName: siteConfig.name });
      const result = await sendEmail({
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      if (!result.ok) {
        invalidateIssuedToken(id);
        console.error('[auth] invite magic-link delivery failed', { error: result.error });
      }
    }
  }

  return { status: 'sent', email };
}
