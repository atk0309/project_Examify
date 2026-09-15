'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { consumeLocalOtp, getRawSession } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { getAuthMode, isTurnstileEnabled } from '@/lib/env';
import { extractClientIp } from '@/lib/ip';
import { checkRateLimit } from '@/lib/rate-limit';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['student', 'parent']),
  code: z.string().trim(),
  token: z.string().optional(),
});

export type VerifyLocalOtpState =
  { status: 'idle' } | { status: 'error'; reason: 'invalid' | 'captcha' | 'rate_limited' };

/**
 * Consumes a local OTP and establishes the matching session. Wrong, expired,
 * used, and unissued codes all return `invalid` so the response does not reveal
 * whether a code was issued for the email.
 */
export async function verifyLocalOtp(
  _prev: VerifyLocalOtpState,
  formData: FormData,
): Promise<VerifyLocalOtpState> {
  if (getAuthMode() !== 'local-otp') return { status: 'error', reason: 'invalid' };

  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';

  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
    code: formData.get('code'),
    token: token || undefined,
  });
  if (!parsed.success) return { status: 'error', reason: 'invalid' };

  const ip = extractClientIp(await headers());
  if (isTurnstileEnabled() && !token) return { status: 'error', reason: 'invalid' };
  const captcha = await verifyTurnstile(token, ip);
  if (!captcha.ok) return { status: 'error', reason: 'captcha' };

  const limit = checkRateLimit(ip, 'signin');
  if (!limit.ok) return { status: 'error', reason: 'rate_limited' };

  const result = consumeLocalOtp(parsed.data.email, parsed.data.role, parsed.data.code);
  if (!result.ok) return { status: 'error', reason: 'invalid' };

  const session = await getRawSession();
  session.userId = result.userId;
  session.role = result.role;
  session.email = result.email;
  session.studentMode = false;
  await session.save();

  redirect('/');
}
