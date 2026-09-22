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

export type CompletePasswordInviteState =
  { status: 'idle' } | { status: 'error'; reason: 'invalid' | 'captcha' | 'rate_limited' };

/**
 * Password-mode invite accept, step 2: consume the mailbox OTP. The password
 * hash bound to that invite row at issue time is what gets stored — a
 * password field on this request is ignored. Membership and
 * `emailVerifiedAt` are set in the same transaction. The token must carry
 * `magic_tokens.invite_id` and a pending hash. A leftover sign-in OTP is
 * refused. A full guess lock returns `rate_limited`, even for the right code.
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

  const result = consumeLocalOtp(parsed.data.email, parsed.data.role, parsed.data.code, {
    requireInviteId: true,
  });
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
