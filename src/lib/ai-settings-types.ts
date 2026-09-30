import type { OnboardingSnapshot } from './onboarding-types';

export const AI_CONFIG_KEYS = [
  'EXAMIFY_ANTHROPIC_MODEL',
  'EXAMIFY_OPENAI_MODEL',
  'EXAMIFY_LLM_BASE_URL',
  'EXAMIFY_LLM_MODEL',
  'EXAMIFY_CLAUDE_MODEL',
  'EXAMIFY_CODEX_MODEL',
] as const;
export type AiConfigKey = (typeof AI_CONFIG_KEYS)[number];
export type AiSettingsSnapshot = Omit<
  OnboardingSnapshot,
  | 'subjects'
  | 'sampleSubjects'
  | 'builtinSubjects'
  | 'dataDirDisplay'
  | 'replaceSample'
  | 'hasDryRun'
  | 'hasApplied'
  | 'liveSubjects'
> & { config: Record<AiConfigKey, { configured: boolean; writeBlocked: boolean }> };
export type AiSettingsResult =
  | { ok: true; snapshot: AiSettingsSnapshot }
  | { ok: false; reason: 'forbidden' | 'invalid' | 'rate_limited' | 'host_managed' | 'disk' };
