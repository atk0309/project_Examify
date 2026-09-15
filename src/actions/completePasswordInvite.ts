'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { consumeLocalOtp, getRawSession } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { getAuthMode, isTurnstileEnabled } from '@/lib/env';
import { extractClientIp } from '@/lib/ip';
import { hashPassword, passwordMeetsPolicy } from '@/lib/password';
import { checkRateLimit } from '@/lib/rate-limit';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['student', 'parent']),
  password: z.string().min(1),
  code: z.string().trim(),
  token: z.string().optional(),
});

export type CompletePasswordInviteState =
  { status: 'idle' } | { status: 'error'; reason: 'invalid' | 'captcha' | 'rate_limited' };

/**
 * Password-mode invite accept, step 2: consume the mailbox OTP and persist
 * the password hash in the same transaction that attaches membership and
 * stamps `emailVerifiedAt`, then establish the session.
 */
export async function completePasswordInvite(
  _prev: CompletePasswordInviteState,
  formData: FormData,
): Promise<CompletePasswordInviteState> {
  if (getAuthMode() !== 'password') return { status: 'error', reason: 'invalid' };

  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';

  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
    password: formData.get('password'),
    code: formData.get('code'),
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

  const passwordHash = hashPassword(parsed.data.password);
  const result = consumeLocalOtp(parsed.data.email, parsed.data.role, parsed.data.code, {
    passwordHash,
  });
  if (!result.ok) return { status: 'error', reason: 'invalid' };

  const session = await getRawSession();
  session.userId = result.userId;
  session.role = result.role;
  session.email = result.email;
  session.studentMode = false;
  await session.save();

  redirect('/');
}
