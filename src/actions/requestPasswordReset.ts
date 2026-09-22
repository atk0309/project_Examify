'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { invalidateIssuedToken, issuePasswordResetOtp } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { renderPasswordResetEmail, sendEmail } from '@/lib/email';
import { canDeliverMailboxProof, getAuthMode, isTurnstileEnabled } from '@/lib/env';
import { isHouseholdEmailAllowed } from '@/lib/households';
import { extractClientIp } from '@/lib/ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { siteConfig } from '@/lib/site';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['student', 'parent']),
  token: z.string().optional(),
});

export type RequestPasswordResetState =
  | { status: 'idle' }
  | { status: 'sent'; email: string }
  | { status: 'error'; reason: 'invalid' | 'captcha' | 'rate_limited' };

/**
 * Password-mode forgot-password, step 1. After Turnstile (when on) and the
 * uniform sign-in rate limit, every address gets the same `sent` state.
 * A code is issued only for a household member of that role, and only when
 * mail can deliver. Failures are logged as `{ error }` with no address.
 * `password_hash` is not touched here.
 */
export async function requestPasswordReset(
  _prev: RequestPasswordResetState,
  formData: FormData,
): Promise<RequestPasswordResetState> {
  if (getAuthMode() !== 'password') return { status: 'error', reason: 'invalid' };

  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';

  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
    token: token || undefined,
  });
  if (!parsed.success) return { status: 'error', reason: 'invalid' };

  const ip = extractClientIp(await headers());
  if (isTurnstileEnabled() && !token) return { status: 'error', reason: 'invalid' };
  const captcha = await verifyTurnstile(token, ip);
  if (!captcha.ok) return { status: 'error', reason: 'captcha' };

  const limit = checkRateLimit(ip, 'signin');
  if (!limit.ok) return { status: 'error', reason: 'rate_limited' };

  const { email, role } = parsed.data;
  if (canDeliverMailboxProof() && isHouseholdEmailAllowed(role, email)) {
    const { id, code } = issuePasswordResetOtp(email, role);
    const rendered = renderPasswordResetEmail({ code, siteName: siteConfig.name });
    const result = await sendEmail({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      code,
    });
    if (!result.ok) {
      invalidateIssuedToken(id);
      console.error('[auth] password-reset delivery failed', { error: result.error });
    }
  }

  return { status: 'sent', email };
}
