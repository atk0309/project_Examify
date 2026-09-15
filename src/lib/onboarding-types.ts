/** Client-safe onboarding types (no DB / server-only / answer-key imports). */

export const ONBOARDING_AI_MODES = ['cloud', 'local-agent', 'local-cli', 'skip-stub'] as const;
export type OnboardingAiMode = (typeof ONBOARDING_AI_MODES)[number];

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
  replaceSample?: boolean;
};

export type OnboardingSubject = {
  id: string;
  label: string;
  icon: string;
  hasIr: boolean;
  sourceFiles: string[];
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
  anthropicConfigured: boolean;
  localAgentConfigured: boolean;
};

export const ONBOARDING_INGEST_CLI = [
  'pnpm examify-ingest validate content/subjects',
  'pnpm examify-ingest emit content/subjects --dry-run',
  'pnpm examify-ingest emit content/subjects --apply',
] as const;

export const EMPTY_AUTHORITATIVE_EMIT =
  'authoritative emit refused: no BankIR files in the subjects tree (will not wipe generated content)';
