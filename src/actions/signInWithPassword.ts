'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { authenticatePassword, getRawSession } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { getAuthMode, isTurnstileEnabled } from '@/lib/env';
import { extractClientIp } from '@/lib/ip';
import { checkRateLimit } from '@/lib/rate-limit';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  role: z.enum(['student', 'parent']),
  token: z.string().optional(),
});

export type SignInPasswordState =
  { status: 'idle' } | { status: 'error'; reason: 'invalid' | 'captcha' | 'rate_limited' };

/**
 * Password sign-in. After Turnstile (when on) + the uniform sign-in
 * rate-limit, every failure — unknown email, wrong password, wrong role,
 * no password set — is `invalid`. Do not split those.
 */
export async function signInWithPassword(
  _prev: SignInPasswordState,
  formData: FormData,
): Promise<SignInPasswordState> {
  if (getAuthMode() !== 'password') return { status: 'error', reason: 'invalid' };

  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';

  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
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

  const result = authenticatePassword(parsed.data.email, parsed.data.password, parsed.data.role);
  if (!result.ok) return { status: 'error', reason: 'invalid' };

  const session = await getRawSession();
  session.userId = result.userId;
  session.role = result.role;
  session.email = result.email;
  session.studentMode = false;
  await session.save();

  redirect('/');
}
