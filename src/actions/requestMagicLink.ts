'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { isAllowedEmail } from '@/lib/allowlist';
import { issueMagicLink } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { renderMagicLinkEmail, sendEmail } from '@/lib/email';
import { env } from '@/lib/env';
import { extractClientIp } from '@/lib/ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { siteConfig } from '@/lib/site';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['student', 'parent']),
  token: z.string().min(1),
});

export type RequestMagicLinkState =
  | { status: 'idle' }
  | { status: 'sent'; email: string }
  | { status: 'error'; reason: 'invalid' | 'captcha' | 'rate_limited' | 'send_failed' };

export async function requestMagicLink(
  _prev: RequestMagicLinkState,
  formData: FormData,
): Promise<RequestMagicLinkState> {
  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
    token: formData.get('cf-turnstile-response'),
  });
  if (!parsed.success) return { status: 'error', reason: 'invalid' };

  const { email, role } = parsed.data;
  const ip = extractClientIp(await headers());

  const captcha = await verifyTurnstile(parsed.data.token, ip);
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
    if (!result.ok) return { status: 'error', reason: 'send_failed' };
  }

  return { status: 'sent', email };
}
