import 'server-only';

import { getSession } from '@/lib/auth';
import { getMembershipForUser } from '@/lib/households';
import { getOnboardingAiSnapshot, onboardingHostEnv } from '@/lib/onboarding';
import { envStoreSecretWriteBlocked } from '@/lib/env-store';
import { AI_CONFIG_KEYS, type AiConfigKey, type AiSettingsSnapshot } from './ai-settings-types';

/** A live household admin; content onboarding completion is deliberately irrelevant. */
export async function requireAiSettingsAdmin(): Promise<
  { ok: true; householdId: number } | { ok: false; reason: 'forbidden' }
> {
  const session = await getSession();
  if (!session.userId || session.role !== 'parent') return { ok: false, reason: 'forbidden' };
  const membership = getMembershipForUser(session.userId);
  if (!membership || membership.role !== 'admin') return { ok: false, reason: 'forbidden' };
  return { ok: true, householdId: membership.householdId };
}

export function isAiConfigKey(key: unknown): key is AiConfigKey {
  return typeof key === 'string' && (AI_CONFIG_KEYS as readonly string[]).includes(key);
}

/** Reject credential-bearing URLs and .env interpolation/control syntax. No shell commands. */
export function validAiConfigValue(key: AiConfigKey, value: string): boolean {
  if (!value || value.length > 256 || /[\s\x00-\x1f\x7f$#'"`\\]/.test(value)) return false;
  if (key !== 'EXAMIFY_LLM_BASE_URL') return /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(value);
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function getAiSettingsSnapshot(
  householdId: number,
  recheckSignIn = false,
): Promise<AiSettingsSnapshot> {
  const ai = await getOnboardingAiSnapshot(householdId, recheckSignIn);
  const env = onboardingHostEnv();
  const config = Object.fromEntries(
    AI_CONFIG_KEYS.map((key) => [
      key,
      {
        configured: Boolean(env[key]?.trim()),
        writeBlocked: envStoreSecretWriteBlocked(key),
      },
    ]),
  ) as AiSettingsSnapshot['config'];
  // Neither credentials nor potentially credential-bearing host URLs are serialized.
  return { ...ai, config };
}
