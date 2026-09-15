'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getRawSession } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { getAuthMode, isTurnstileEnabled } from '@/lib/env';
import { acceptInviteWithPassword as acceptInvite } from '@/lib/households';
import { extractClientIp } from '@/lib/ip';
import { hashPassword, passwordMeetsPolicy } from '@/lib/password';
import { checkRateLimit } from '@/lib/rate-limit';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  inviteToken: z.string().min(1),
  token: z.string().optional(),
});

export type AcceptInvitePasswordState =
  | { status: 'idle' }
  | {
      status: 'error';
      reason: 'invalid' | 'captcha' | 'rate_limited' | 'invite_invalid';
    };

/**
 * Password-mode invite accept. A bad invite URL is `invite_invalid` (the
 * token is already the secret). Email-lock mismatches and already-members
 * stay generic `invalid` so a locked address cannot be enumerated.
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

  const result = acceptInvite({
    inviteToken: parsed.data.inviteToken,
    email: parsed.data.email,
    passwordHash: hashPassword(parsed.data.password),
  });
  if (!result.ok) {
    return {
      status: 'error',
      reason: result.reason === 'invite-invalid' ? 'invite_invalid' : 'invalid',
    };
  }

  const session = await getRawSession();
  session.userId = result.userId;
  session.role = result.role;
  session.email = result.email;
  session.studentMode = false;
  await session.save();

  redirect('/');
}
