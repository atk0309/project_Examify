'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { constantTimeEqual, getRawSession } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { env, getAuthMode, isTurnstileEnabled } from '@/lib/env';
import { bootstrapHousehold, HOUSEHOLD_NAME_MAX } from '@/lib/households';
import { extractClientIp } from '@/lib/ip';
import { hashPassword, passwordMeetsPolicy } from '@/lib/password';
import { checkRateLimit } from '@/lib/rate-limit';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  householdName: z.string().trim().min(1).max(HOUSEHOLD_NAME_MAX),
  setupSecret: z.string().optional(),
  password: z.string().optional(),
  token: z.string().optional(),
});

export type BootstrapState =
  | { status: 'idle' }
  | {
      status: 'error';
      reason: 'invalid' | 'already_setup' | 'captcha' | 'rate_limited' | 'forbidden';
    };

/**
 * First-run: create the initial household + admin when none exists.
 * The host is at the keyboard, so we establish the session here (no
 * magic-link round-trip). Password mode also requires and stores the admin's
 * password. After a household exists this action fails closed.
 */
export async function bootstrapHouseholdAction(
  _prev: BootstrapState,
  formData: FormData,
): Promise<BootstrapState> {
  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';

  const rawSecret = formData.get('setupSecret');
  const rawPassword = formData.get('password');
  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    householdName: formData.get('householdName'),
    setupSecret: typeof rawSecret === 'string' ? rawSecret : undefined,
    password: typeof rawPassword === 'string' ? rawPassword : undefined,
    token: token || undefined,
  });
  if (!parsed.success) return { status: 'error', reason: 'invalid' };

  const mode = getAuthMode();
  if (mode === 'password' && !passwordMeetsPolicy(parsed.data.password ?? '')) {
    return { status: 'error', reason: 'invalid' };
  }

  const ip = extractClientIp(await headers());
  if (isTurnstileEnabled() && !token) return { status: 'error', reason: 'invalid' };
  const captcha = await verifyTurnstile(token, ip);
  if (!captcha.ok) return { status: 'error', reason: 'captcha' };

  const limit = checkRateLimit(ip, 'signin');
  if (!limit.ok) return { status: 'error', reason: 'rate_limited' };

  // CAPTCHA is not identity. A deployment-provided secret must match before
  // anyone can claim /setup on a fresh instance.
  const expected = env.SETUP_BOOTSTRAP_SECRET;
  const submitted = parsed.data.setupSecret ?? '';
  if (!expected || !constantTimeEqual(submitted, expected)) {
    return { status: 'error', reason: 'forbidden' };
  }

  // scrypt is expensive — only hash after captcha, rate-limit, and the
  // setup secret have all passed.
  const passwordHash = mode === 'password' ? hashPassword(parsed.data.password ?? '') : undefined;

  const result = bootstrapHousehold({
    email: parsed.data.email,
    householdName: parsed.data.householdName,
    passwordHash,
  });
  if (!result.ok) return { status: 'error', reason: result.reason };

  const session = await getRawSession();
  session.userId = result.userId;
  session.role = 'parent';
  session.email = result.email;
  session.studentMode = false;
  await session.save();

  redirect('/');
}
