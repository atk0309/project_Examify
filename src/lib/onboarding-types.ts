/** Client-safe onboarding types (no DB / server-only / answer-key imports). */

export const ONBOARDING_AI_MODES = [
  'cloud',
  'cloud-openai',
  'local-agent',
  'local-cli',
  'skip-stub',
] as const;
export type OnboardingAiMode = (typeof ONBOARDING_AI_MODES)[number];

export const ONBOARDING_GENERATE_PROVIDERS = ['anthropic', 'openai', 'local', 'test'] as const;
export type OnboardingGenerateProvider = (typeof ONBOARDING_GENERATE_PROVIDERS)[number];

export const ONBOARDING_GENERATE_SEED_DEFAULT = 0;

/**
 * Concurrent generate-cancel. Next.js queues Server Actions from the same
 * client, so Cancel cannot be another action behind generate.
 */
export const ONBOARDING_CANCEL_GENERATE_PATH = '/api/onboarding/cancel-generate';

export function providerForOnboardingAiMode(mode: OnboardingAiMode): OnboardingGenerateProvider {
  switch (mode) {
    case 'cloud':
      return 'anthropic';
    case 'cloud-openai':
      return 'openai';
    case 'local-agent':
    case 'local-cli':
      return 'local';
    case 'skip-stub':
      return 'test';
  }
}

export const SUBJECT_ICON_OPTIONS = [
  'maths',
  'biology',
  'chemistry',
  'physics',
  'computer-science',
  'geography',
  'french',
  'latin',
  'drama',
  'music',
  'food',
  'product-design',
  'textiles',
] as const;
export type SubjectIconOption = (typeof SUBJECT_ICON_OPTIONS)[number];

export type OnboardingState = {
  skipped?: boolean;
  aiMode?: OnboardingAiMode;
  dryRunHash?: string;
  /** Set after a confirmed HITL apply. Finish requires this; skip does not. */
  applied?: boolean;
  replaceSample?: boolean;
};

export type OnboardingSubject = {
  id: string;
  label: string;
  icon: string;
  hasIr: boolean;
  /** PDF filenames under content/source-pdfs/<id>/ (Files step). */
  sourceFiles: string[];
  /**
   * Rel-paths generate would read: source-pdfs/<id>/…, standalone
   * source-pdfs/<id>.<ext>, and source-like files in the subject folder
   * except bank.ir.json / subject.json.
   */
  generateSources: string[];
};

export type OnboardingIssue = {
  file: string;
  message: string;
};

export type OnboardingPlanAction = 'add' | 'update' | 'unchanged' | 'delete';

/** Public emit plan row — paths + action. Key file bodies never ship. */
export type OnboardingPlanEntry = {
  path: string;
  action: OnboardingPlanAction;
};

export type OnboardingDryRun = {
  hash: string;
  questionCount: number;
  subjectCount: number;
  collisions: string[];
  replaceSample: boolean;
  plan: OnboardingPlanEntry[];
  /** CLI-shaped dry-run (`formatEmitPlan`), with keys/ bodies redacted. */
  diff: string;
};

export type OnboardingSampleSubject = {
  id: string;
  label: string;
};

export type OnboardingSnapshot = {
  subjects: OnboardingSubject[];
  sampleSubjects: OnboardingSampleSubject[];
  aiMode: OnboardingAiMode | null;
  replaceSample: boolean;
  hasDryRun: boolean;
  hasApplied: boolean;
  anthropicConfigured: boolean;
  openaiConfigured: boolean;
  /**
   * Host (Docker / systemd / parent exec environ) assigned the key —
   * including empty / `test`. A matching `.env` value is not enough.
   * Wizard write/clear refused.
   */
  openaiHostManaged: boolean;
  localAgentConfigured: boolean;
};

/** Public generate progress — never includes BankIR / answers / keys. */
export type OnboardingGenerateResult = {
  subjectId: string;
  provider: OnboardingGenerateProvider;
  model: string;
  seed: number;
  cacheHit: boolean;
  cacheKey: string;
  sourceCount: number;
  sourceHashes: Record<string, string>;
  wroteIr: boolean;
  irRel: string;
};

export const ONBOARDING_INGEST_CLI = [
  'pnpm examify-ingest validate content/subjects',
  'pnpm examify-ingest emit content/subjects --dry-run',
  'pnpm examify-ingest emit content/subjects --apply',
] as const;

export function onboardingGenerateCli(
  provider: OnboardingGenerateProvider,
  seed = ONBOARDING_GENERATE_SEED_DEFAULT,
  subjectId?: string,
): string {
  const target = subjectId ? `content/subjects/${subjectId}` : 'content/subjects/<id>';
  return `pnpm examify-ingest generate --provider ${provider} --seed ${seed} ${target}`;
}

export function onboardingGenerateAndEmitCli(
  provider: OnboardingGenerateProvider,
  seed = ONBOARDING_GENERATE_SEED_DEFAULT,
): string[] {
  return [onboardingGenerateCli(provider, seed), ...ONBOARDING_INGEST_CLI];
}

/** Generate-all targets: skip hand-authored / source-less catalog rows. */
export function onboardingGenerateBatchIds(
  subjects: readonly Pick<OnboardingSubject, 'id' | 'generateSources'>[],
): string[] {
  return subjects
    .filter((subject) => subject.generateSources.length > 0)
    .map((subject) => subject.id);
}

export const EMPTY_AUTHORITATIVE_EMIT =
  'authoritative emit refused: no BankIR files in the subjects tree (will not wipe generated content)';
