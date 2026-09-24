'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  ANTHROPIC_ENV_KEY,
  OPENAI_ENV_KEY,
  clearEnvStoreSecret,
  setEnvStoreSecret,
  type EnvStoreKey,
} from '@/lib/env-store';
import { extractClientIp } from '@/lib/ip';
import { checkRateLimit } from '@/lib/rate-limit';
import { requireOnboardingAdmin } from '@/lib/onboarding-admin';
import {
  generateOnboardingSubject,
  isOnboardingGenerateCancelToken,
  requestOnboardingGenerateCancel,
  withOnboardingGenerateLock,
} from '@/lib/onboarding-generate';
import {
  addOnboardingSubject,
  applyOnboardingEmit,
  attachSourcePdf,
  clearOnboardingDryRun,
  completeOnboarding,
  deleteOnboardingSubject,
  detachSourcePdf,
  effectiveAiMode,
  getOnboardingSnapshot,
  getHouseholdOnboarding,
  invalidateOnboardingEmit,
  isOnboardingAiMode,
  markOnboardingApplied,
  MAX_SOURCE_PDF_BYTES,
  ONBOARDING_GENERATE_SEED_DEFAULT,
  previewOnboardingEmit,
  localTransportForOnboardingAiMode,
  providerForOnboardingAiMode,
  publicDryRun,
  renameOnboardingSubject,
  saveOnboardingState,
  skipOnboarding,
  SUBJECT_LABEL_MAX,
  validateOnboardingIr,
} from '@/lib/onboarding';
import {
  SUBJECT_ICON_OPTIONS,
  type OnboardingDryRun,
  type OnboardingGenerateResult,
  type OnboardingSnapshot,
} from '@/lib/onboarding-types';

export type OnboardingActionError = {
  ok: false;
  reason:
    | 'forbidden'
    | 'invalid'
    | 'invalid_id'
    | 'invalid_type'
    | 'invalid_name'
    | 'duplicate'
    | 'missing'
    | 'too_large'
    | 'disk'
    | 'unsafe_path'
    | 'empty_catalog'
    | 'dry_run_required'
    | 'stale_preview'
    | 'prune_confirm_required'
    | 'emit_required'
    | 'already_complete'
    | 'missing_provider'
    | 'missing_key'
    | 'missing_local'
    | 'missing_cli'
    | 'empty_sources'
    | 'sources_unreadable'
    | 'sample_collision'
    | 'provider_auth'
    | 'provider_rate_limited'
    | 'provider_timeout'
    | 'provider_unavailable'
    | 'provider_error'
    | 'provider_output_invalid'
    | 'generate_failed'
    | 'cancelled'
    | 'skipped'
    | 'needs_confirm'
    | 'already_committed'
    | 'rate_limited'
    | 'host_managed';
  message?: string;
  irRel?: string;
  issues?: { file: string; message: string }[];
};

function snapshot(householdId: number): OnboardingSnapshot {
  return getOnboardingSnapshot(householdId);
}

const addSchema = z.object({
  id: z.string().trim().toLowerCase().min(1).max(SUBJECT_LABEL_MAX),
  label: z.string().trim().min(1).max(SUBJECT_LABEL_MAX),
  icon: z.enum(SUBJECT_ICON_OPTIONS),
});

export async function addOnboardingSubjectAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const parsed = addSchema.safeParse({
    id: formData.get('id'),
    label: formData.get('label'),
    icon: formData.get('icon'),
  });
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const result = addOnboardingSubject(parsed.data);
  if (!result.ok) return { ok: false, reason: result.reason };
  invalidateOnboardingEmit(gate.householdId);
  return { ok: true, snapshot: snapshot(gate.householdId) };
}

export async function renameOnboardingSubjectAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const parsed = addSchema
    .extend({ nextId: z.string().trim().toLowerCase().optional() })
    .safeParse({
      id: formData.get('id'),
      nextId: formData.get('nextId') || undefined,
      label: formData.get('label'),
      icon: formData.get('icon'),
    });
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  return withOnboardingGenerateLock(async () => {
    const again = await requireOnboardingAdmin();
    if (!again.ok) return again;
    const result = renameOnboardingSubject(parsed.data);
    if (!result.ok) return { ok: false, reason: result.reason };
    invalidateOnboardingEmit(again.householdId);
    return { ok: true, snapshot: snapshot(again.householdId) };
  });
}

export async function deleteOnboardingSubjectAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const id = typeof formData.get('id') === 'string' ? formData.get('id') : '';
  return withOnboardingGenerateLock(async () => {
    const again = await requireOnboardingAdmin();
    if (!again.ok) return again;
    const result = deleteOnboardingSubject(String(id));
    if (!result.ok) return { ok: false, reason: result.reason };
    invalidateOnboardingEmit(again.householdId);
    return { ok: true, snapshot: snapshot(again.householdId) };
  });
}

export async function attachOnboardingPdfAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const subjectId = formData.get('subjectId');
  const file = formData.get('file');
  if (typeof subjectId !== 'string' || !(file instanceof File)) {
    return { ok: false, reason: 'invalid' };
  }
  if (file.size > MAX_SOURCE_PDF_BYTES) return { ok: false, reason: 'too_large' };
  const bytes = Buffer.from(await file.arrayBuffer());
  const result = attachSourcePdf({ subjectId, filename: file.name, bytes });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, snapshot: snapshot(gate.householdId) };
}

export async function detachOnboardingPdfAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const subjectId = formData.get('subjectId');
  const filename = formData.get('filename');
  if (typeof subjectId !== 'string' || typeof filename !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
  const result = detachSourcePdf({ subjectId, filename });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, snapshot: snapshot(gate.householdId) };
}

const generateSeedSchema = z.coerce.number().int();

export async function generateOnboardingSubjectAction(
  formData: FormData,
): Promise<
  | { ok: true; snapshot: OnboardingSnapshot; result: OnboardingGenerateResult }
  | OnboardingActionError
> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const subjectId = formData.get('subjectId');
  if (typeof subjectId !== 'string' || !subjectId.trim()) {
    return { ok: false, reason: 'invalid_id' };
  }
  const rawSeed = formData.get('seed');
  const seedParsed =
    rawSeed == null || rawSeed === ''
      ? { success: true as const, data: ONBOARDING_GENERATE_SEED_DEFAULT }
      : generateSeedSchema.safeParse(rawSeed);
  if (!seedParsed.success) return { ok: false, reason: 'invalid' };
  const rawToken = formData.get('cancelToken');
  const cancelToken =
    typeof rawToken === 'string' && isOnboardingGenerateCancelToken(rawToken)
      ? rawToken
      : undefined;
  const rawForce = formData.get('force');
  const force = rawForce === '1' || rawForce === 'true';
  const rawOverwrite = formData.get('overwrite');
  const overwrite = rawOverwrite === 'skip' || rawOverwrite === 'force' ? rawOverwrite : undefined;

  const state = getHouseholdOnboarding(gate.householdId).state;
  const aiMode = effectiveAiMode(state);
  if (!aiMode) return { ok: false, reason: 'missing_provider' };
  const provider = providerForOnboardingAiMode(aiMode);
  const localTransport = localTransportForOnboardingAiMode(aiMode) ?? undefined;

  const generated = await generateOnboardingSubject({
    subjectId,
    provider,
    localTransport,
    seed: seedParsed.data,
    cancelToken,
    force,
    overwrite,
    // Same household choice validate / preview / apply use (CLI --replace-sample).
    replaceSample: state.replaceSample === true,
  });
  if (!generated.ok) {
    // Safe codes only — never forward raw provider / path / env messages
    // (the lib already logged the reason code server-side).
    // needs_confirm may include the public irRel so the wizard can name
    // the overwrite (same shape as CLI dry-run) before the user confirms.
    if (generated.reason === 'needs_confirm') {
      return { ok: false, reason: 'needs_confirm', irRel: generated.irRel };
    }
    return { ok: false, reason: generated.reason };
  }
  // IR changed — any prior HITL dry-run / apply is stale. Generate never emit/applies.
  invalidateOnboardingEmit(gate.householdId);
  return { ok: true, snapshot: snapshot(gate.householdId), result: generated.result };
}

/** Queued behind generate on the same client — wizard uses the route handler. */
export async function cancelOnboardingGenerateAction(
  formData: FormData,
): Promise<{ ok: true } | OnboardingActionError> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const token = formData.get('cancelToken');
  if (typeof token !== 'string' || !isOnboardingGenerateCancelToken(token)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!requestOnboardingGenerateCancel(token)) {
    return { ok: false, reason: 'already_committed' };
  }
  return { ok: true };
}

async function setOnboardingEnvStoreKeyAction(
  key: EnvStoreKey,
  formData: FormData,
  field: 'anthropicApiKey' | 'openaiApiKey',
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const ip = extractClientIp(await headers());
  const limit = checkRateLimit(ip, 'env_write');
  if (!limit.ok) return { ok: false, reason: 'rate_limited' };
  const intent = formData.get('intent');
  if (intent === 'clear') {
    const cleared = clearEnvStoreSecret(key);
    if (!cleared.ok) return { ok: false, reason: cleared.reason };
    return { ok: true, snapshot: snapshot(gate.householdId) };
  }
  if (intent !== 'set') return { ok: false, reason: 'invalid' };
  const raw = formData.get(field);
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' };
  const written = setEnvStoreSecret(key, raw);
  if (!written.ok) return { ok: false, reason: written.reason };
  return { ok: true, snapshot: snapshot(gate.householdId) };
}

export async function setOnboardingAnthropicKeyAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  return setOnboardingEnvStoreKeyAction(ANTHROPIC_ENV_KEY, formData, 'anthropicApiKey');
}

export async function setOnboardingOpenAiKeyAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  return setOnboardingEnvStoreKeyAction(OPENAI_ENV_KEY, formData, 'openaiApiKey');
}

export async function setOnboardingAiModeAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const mode = formData.get('aiMode');
  if (typeof mode !== 'string' || !isOnboardingAiMode(mode)) {
    return { ok: false, reason: 'invalid' };
  }
  saveOnboardingState(gate.householdId, { aiMode: mode });
  return { ok: true, snapshot: snapshot(gate.householdId) };
}

export async function setReplaceSampleAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const enabled = formData.get('replaceSample') === '1';
  saveOnboardingState(gate.householdId, { replaceSample: enabled });
  invalidateOnboardingEmit(gate.householdId);
  return { ok: true, snapshot: snapshot(gate.householdId) };
}

export async function validateOnboardingAction(): Promise<
  { ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError
> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const replaceSample = getHouseholdOnboarding(gate.householdId).state.replaceSample === true;
  const result = validateOnboardingIr(replaceSample);
  if (!result.ok) {
    return { ok: false, reason: 'invalid', issues: result.issues };
  }
  return { ok: true, snapshot: snapshot(gate.householdId) };
}

export async function previewOnboardingEmitAction(): Promise<
  { ok: true; snapshot: OnboardingSnapshot; dryRun: OnboardingDryRun } | OnboardingActionError
> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const replaceSample = getHouseholdOnboarding(gate.householdId).state.replaceSample === true;
  const preview = previewOnboardingEmit(replaceSample);
  if (!preview.ok) {
    clearOnboardingDryRun(gate.householdId);
    return {
      ok: false,
      reason: preview.reason,
      message: preview.message,
      issues: preview.issues,
    };
  }
  saveOnboardingState(gate.householdId, { dryRunHash: preview.dryRun.hash });
  return {
    ok: true,
    snapshot: snapshot(gate.householdId),
    dryRun: publicDryRun(preview),
  };
}

export async function applyOnboardingEmitAction(formData?: FormData): Promise<
  | {
      ok: true;
      snapshot: OnboardingSnapshot;
      written: number;
      questionCount: number;
      subjectCount: number;
    }
  | OnboardingActionError
> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const state = getHouseholdOnboarding(gate.householdId).state;
  if (!state.dryRunHash) return { ok: false, reason: 'dry_run_required' };
  const replaceSample = state.replaceSample === true;
  const confirmPrune = formData?.get('confirmPrune') === '1';
  // Single re-preview lives inside applyOnboardingEmit: hash must match the
  // confirmed dry-run, then that same planned list is applied. A second
  // preview here would race and could apply an unconfirmed plan.
  const applied = applyOnboardingEmit({
    replaceSample,
    expectedHash: state.dryRunHash,
    confirmPrune,
  });
  if (!applied.ok) {
    return { ok: false, reason: applied.reason, message: applied.message, issues: applied.issues };
  }
  markOnboardingApplied(gate.householdId);
  return {
    ok: true,
    snapshot: snapshot(gate.householdId),
    written: applied.written,
    questionCount: applied.questionCount,
    subjectCount: applied.subjectCount,
  };
}

export async function skipOnboardingAction(): Promise<OnboardingActionError | void> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  skipOnboarding(gate.householdId);
  redirect('/');
}

export async function finishOnboardingAction(): Promise<OnboardingActionError | void> {
  const gate = await requireOnboardingAdmin();
  if (!gate.ok) return gate;
  const state = getHouseholdOnboarding(gate.householdId).state;
  if (state.applied !== true) return { ok: false, reason: 'emit_required' };
  completeOnboarding(gate.householdId);
  redirect('/');
}
