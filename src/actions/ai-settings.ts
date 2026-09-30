'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  getAiSettingsSnapshot,
  isAiConfigKey,
  requireAiSettingsAdmin,
  validAiConfigValue,
} from '@/lib/ai-settings';
import { clearEnvStoreSecret, setEnvStoreSecret } from '@/lib/env-store';
import { extractClientIp } from '@/lib/ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { isOnboardingAiMode, saveOnboardingState } from '@/lib/onboarding';
import type { AiSettingsResult } from '@/lib/ai-settings-types';

async function writeGate() {
  const gate = await requireAiSettingsAdmin();
  if (!gate.ok) return gate;
  if (!checkRateLimit(extractClientIp(await headers()), 'env_write').ok) {
    return { ok: false as const, reason: 'rate_limited' as const };
  }
  return gate;
}

async function updated(householdId: number): Promise<AiSettingsResult> {
  try {
    revalidatePath('/');
    revalidatePath('/settings/ai');
    return { ok: true, snapshot: await getAiSettingsSnapshot(householdId) };
  } catch {
    return { ok: false, reason: 'disk' };
  }
}

export async function saveAiModeAction(data: FormData): Promise<AiSettingsResult> {
  const gate = await writeGate();
  if (!gate.ok) return gate;
  const mode = data.get('aiMode');
  if (typeof mode !== 'string' || !isOnboardingAiMode(mode))
    return { ok: false, reason: 'invalid' };
  try {
    saveOnboardingState(gate.householdId, { aiMode: mode });
    return updated(gate.householdId);
  } catch {
    return { ok: false, reason: 'disk' };
  }
}

export async function setAiKeyAction(data: FormData): Promise<AiSettingsResult> {
  const gate = await writeGate();
  if (!gate.ok) return gate;
  const provider = data.get('provider');
  if (provider !== 'anthropic' && provider !== 'openai') return { ok: false, reason: 'invalid' };
  const key = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const intent = data.get('intent');
  const value = data.get('apiKey');
  if (intent !== 'clear' && (intent !== 'set' || typeof value !== 'string')) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    const result =
      intent === 'clear' ? clearEnvStoreSecret(key) : setEnvStoreSecret(key, value as string);
    return result.ok ? updated(gate.householdId) : result;
  } catch {
    return { ok: false, reason: 'disk' };
  }
}

export async function setAiConfigAction(data: FormData): Promise<AiSettingsResult> {
  const gate = await writeGate();
  if (!gate.ok) return gate;
  const key = data.get('key');
  const intent = data.get('intent');
  const raw = data.get('value');
  if (!isAiConfigKey(key) || (intent !== 'set' && intent !== 'clear'))
    return { ok: false, reason: 'invalid' };
  if (intent === 'set' && (typeof raw !== 'string' || !validAiConfigValue(key, raw.trim()))) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    const result =
      intent === 'clear'
        ? clearEnvStoreSecret(key)
        : setEnvStoreSecret(key, (raw as string).trim());
    return result.ok ? updated(gate.householdId) : result;
  } catch {
    return { ok: false, reason: 'disk' };
  }
}

/** Configuration and CLI sign-in checks only; never sends study data or a paid model request. */
export async function refreshAiSettingsAction(): Promise<AiSettingsResult> {
  const gate = await writeGate();
  if (!gate.ok) return gate;
  try {
    return { ok: true, snapshot: await getAiSettingsSnapshot(gate.householdId, true) };
  } catch {
    return { ok: false, reason: 'disk' };
  }
}
