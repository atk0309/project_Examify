'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { issueLocalOtp } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { renderOtpEmail, sendEmail } from '@/lib/email';
import { canDeliverMailboxProof, getAuthMode, isTurnstileEnabled } from '@/lib/env';
import { emailMayAcceptInvite, lookupInvite } from '@/lib/households';
import { extractClientIp } from '@/lib/ip';
import { passwordMeetsPolicy } from '@/lib/password';
import { checkRateLimit } from '@/lib/rate-limit';
import { siteConfig } from '@/lib/site';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  inviteToken: z.string().min(1),
  token: z.string().optional(),
});

export type AcceptInvitePasswordState =
  | { status: 'idle' }
  | { status: 'sent'; email: string }
  | {
      status: 'error';
      reason: 'invalid' | 'captcha' | 'rate_limited' | 'invite_invalid' | 'send_failed';
    };

/**
 * Password-mode invite accept, step 1: validate the invite + password policy
 * and issue a mailbox OTP. Membership and `emailVerifiedAt` wait for
 * `completePasswordInvite`. A bad invite URL is `invite_invalid` (the token
 * is already the secret). Email-lock mismatches stay generic `invalid` so a
 * locked address cannot be enumerated. Missing mail transport fails closed
 * (`send_failed`) instead of trusting the invite URL.
 */
export async function acceptInviteWithPassword(
  _prev: AcceptInvitePasswordState,
  formData: FormData,
): Promise<AcceptInvitePasswordState> {
  if (getAuthMode() !== 'password') return { status: 'error', reason: 'invalid' };

  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';

  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    inviteToken: formData.get('inviteToken'),
    token: token || undefined,
  });
  if (!parsed.success) return { status: 'error', reason: 'invalid' };
  if (!passwordMeetsPolicy(parsed.data.password)) {
    return { status: 'error', reason: 'invalid' };
  }

  const ip = extractClientIp(await headers());
  if (isTurnstileEnabled() && !token) return { status: 'error', reason: 'invalid' };
  const captcha = await verifyTurnstile(token, ip);
  if (!captcha.ok) return { status: 'error', reason: 'captcha' };

  const limit = checkRateLimit(ip, 'signin');
  if (!limit.ok) return { status: 'error', reason: 'rate_limited' };

  const invite = lookupInvite(parsed.data.inviteToken);
  if (!invite) return { status: 'error', reason: 'invite_invalid' };

  if (!canDeliverMailboxProof()) {
    return { status: 'error', reason: 'send_failed' };
  }

  const { email } = parsed.data;
  if (!emailMayAcceptInvite(invite, email)) {
    return { status: 'error', reason: 'invalid' };
  }

  const { code } = issueLocalOtp(email, invite.role, { inviteId: invite.id });
  const rendered = renderOtpEmail({ code, email, siteName: siteConfig.name });
  const result = await sendEmail({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    code,
  });
  if (!result.ok) {
    console.error('[auth] password-invite OTP delivery failed', { error: result.error });
    return { status: 'error', reason: 'send_failed' };
  }

  return { status: 'sent', email };
}
