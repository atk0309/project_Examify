'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { isAllowedEmail } from '@/lib/allowlist';
import { issueMagicLink } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { renderMagicLinkEmail, sendEmail } from '@/lib/email';
import { env, isTurnstileEnabled } from '@/lib/env';
import { extractClientIp } from '@/lib/ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { siteConfig } from '@/lib/site';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['student', 'parent']),
  token: z.string().optional(),
});

export type RequestMagicLinkState =
  | { status: 'idle' }
  | { status: 'sent'; email: string }
  | { status: 'error'; reason: 'invalid' | 'captcha' | 'rate_limited' | 'send_failed' };

export async function requestMagicLink(
  _prev: RequestMagicLinkState,
  formData: FormData,
): Promise<RequestMagicLinkState> {
  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';

  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
    token: token || undefined,
  });
  if (!parsed.success) return { status: 'error', reason: 'invalid' };

  const { email, role } = parsed.data;
  const ip = extractClientIp(await headers());

  // When Turnstile is on, a missing token is a form error (same as today)
  // so the empty-token e2e stays `invalid`. When off, skip verification.
  if (isTurnstileEnabled() && !token) return { status: 'error', reason: 'invalid' };
  const captcha = await verifyTurnstile(token, ip);
  if (!captcha.ok) return { status: 'error', reason: 'captcha' };

  // One uniform per-IP bucket for every sign-in request. We deliberately do
  // NOT vary the limit by whether a user already exists: a differing
  // threshold would let an attacker tell approved/returning emails apart from
  // unknown ones (the rate_limited vs sent response would leak it) even though
  // the success copy is generic.
  const limit = checkRateLimit(ip, 'signin');
  if (!limit.ok) return { status: 'error', reason: 'rate_limited' };

  // Allowlist gate. We only issue + send a link when the email is approved
  // for the chosen role, but we always return the generic `sent` state so an
  // attacker can't enumerate which emails are on the allowlist.
  if (isAllowedEmail(role, email)) {
    const { token } = await issueMagicLink(email, role);
    const url = `${env.SITE_URL}/signin/verify?token=${encodeURIComponent(token)}`;

    const rendered = renderMagicLinkEmail({ url, email, siteName: siteConfig.name });
    const result = await sendEmail({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (!result.ok) {
      console.error('[auth] magic-link delivery failed', { email, error: result.error });
    }
  }

  return { status: 'sent', email };
}
