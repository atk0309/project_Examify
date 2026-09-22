'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { consumePasswordReset, getRawSession } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { getAuthMode, isTurnstileEnabled } from '@/lib/env';
import { extractClientIp } from '@/lib/ip';
import { passwordMeetsPolicy } from '@/lib/password';
import { checkRateLimit } from '@/lib/rate-limit';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['student', 'parent']),
  password: z.string().min(1),
  confirmPassword: z.string().optional(),
  code: z.string().trim(),
  token: z.string().optional(),
});

export type CompletePasswordResetState =
  | { status: 'idle' }
  | {
      status: 'error';
      reason: 'invalid' | 'captcha' | 'rate_limited' | 'password_mismatch';
    };

/**
 * Password-mode forgot-password, step 2. The new password is hashed only
 * after the reset code matches, inside the same transaction that consumes
 * it. A mismatch or a short password does not consume the code. Unknown
 * codes, wrong roles, and non-members all surface as `invalid`. A full reset
 * guess lock returns `rate_limited`, even for the right code — requesting a
 * new code does not lift it.
 */
export async function completePasswordReset(
  _prev: CompletePasswordResetState,
  formData: FormData,
): Promise<CompletePasswordResetState> {
  if (getAuthMode() !== 'password') return { status: 'error', reason: 'invalid' };

  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';
  const rawConfirm = formData.get('confirmPassword');

  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    role: formData.get('role'),
    password: formData.get('password'),
    confirmPassword: typeof rawConfirm === 'string' ? rawConfirm : undefined,
    code: formData.get('code'),
    token: token || undefined,
  });
  if (!parsed.success) return { status: 'error', reason: 'invalid' };
  if (!passwordMeetsPolicy(parsed.data.password)) {
    return { status: 'error', reason: 'invalid' };
  }
  if ((parsed.data.confirmPassword ?? '') !== parsed.data.password) {
    return { status: 'error', reason: 'password_mismatch' };
  }

  const ip = extractClientIp(await headers());
  if (isTurnstileEnabled() && !token) return { status: 'error', reason: 'invalid' };
  const captcha = await verifyTurnstile(token, ip);
  if (!captcha.ok) return { status: 'error', reason: 'captcha' };

  const limit = checkRateLimit(ip, 'signin');
  if (!limit.ok) return { status: 'error', reason: 'rate_limited' };

  const result = consumePasswordReset(
    parsed.data.email,
    parsed.data.role,
    parsed.data.code,
    parsed.data.password,
  );
  if (!result.ok) {
    return { status: 'error', reason: result.reason === 'locked' ? 'rate_limited' : 'invalid' };
  }

  const session = await getRawSession();
  session.userId = result.userId;
  session.role = result.role;
  session.email = result.email;
  session.studentMode = false;
  await session.save();

  redirect('/');
}
