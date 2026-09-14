'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { verifyTurnstile } from '@/lib/captcha';
import { isTurnstileEnabled } from '@/lib/env';
import { bootstrapHousehold, HOUSEHOLD_NAME_MAX } from '@/lib/households';
import { extractClientIp } from '@/lib/ip';
import { checkRateLimit } from '@/lib/rate-limit';

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  householdName: z.string().trim().min(1).max(HOUSEHOLD_NAME_MAX),
  token: z.string().optional(),
});

export type BootstrapState =
  | { status: 'idle' }
  | { status: 'error'; reason: 'invalid' | 'already_setup' | 'captcha' | 'rate_limited' };

/**
 * First-run: create the initial household + admin when none exists.
 * The host is at the keyboard, so we establish the session here (no
 * magic-link round-trip). After a household exists this action fails closed.
 */
export async function bootstrapHouseholdAction(
  _prev: BootstrapState,
  formData: FormData,
): Promise<BootstrapState> {
  const rawToken = formData.get('cf-turnstile-response');
  const token = typeof rawToken === 'string' ? rawToken : '';

  const parsed = inputSchema.safeParse({
    email: formData.get('email'),
    householdName: formData.get('householdName'),
    token: token || undefined,
  });
  if (!parsed.success) return { status: 'error', reason: 'invalid' };

  const ip = extractClientIp(await headers());
  if (isTurnstileEnabled() && !token) return { status: 'error', reason: 'invalid' };
  const captcha = await verifyTurnstile(token, ip);
  if (!captcha.ok) return { status: 'error', reason: 'captcha' };

  const limit = checkRateLimit(ip, 'signin');
  if (!limit.ok) return { status: 'error', reason: 'rate_limited' };

  const result = bootstrapHousehold({
    email: parsed.data.email,
    householdName: parsed.data.householdName,
  });
  if (!result.ok) return { status: 'error', reason: result.reason };

  const session = await getSession();
  session.userId = result.userId;
  session.role = 'parent';
  session.email = result.email;
  session.studentMode = false;
  await session.save();

  redirect('/');
}
