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

/**
 * `cancelled`: the route recorded the token and stopped the in-flight / next
 * generate. `already_committed`: that request had already written its IR
 * (kept); the token is still recorded, so a batch's next subject is refused.
 * `failed`: anything else — failures must not look cancelled.
 */
export type OnboardingGenerateCancelOutcome = 'cancelled' | 'already_committed' | 'failed';

export async function postOnboardingGenerateCancel(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OnboardingGenerateCancelOutcome> {
  try {
    const res = await fetchImpl(ONBOARDING_CANCEL_GENERATE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancelToken: token }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: unknown; reason?: unknown } | null;
    if (res.ok && body?.ok === true) return 'cancelled';
    if (res.status === 409 && body?.reason === 'already_committed') return 'already_committed';
    return 'failed';
  } catch {
    return 'failed';
  }
}

export const ONBOARDING_GENERATE_ALREADY_FINISHED =
  'Generate already finished — review the new BankIR.';

/** Honest cancel status: subjects that already wrote BankIR are kept, not undone. */
export function onboardingGenerateCancelledNote(kept: number): string {
  if (kept <= 0) return 'Generate cancelled';
  return `Generate cancelled. Kept ${kept} subject${kept === 1 ? '' : 's'} already generated.`;
}

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

/**
 * Wizard subjects that reuse a sample-bank subject id. Their generated
 * question ids (`maths-easy-1`, …) are frozen sample ids, so generate refuses
 * them unless the household allows replacing sample-bank questions.
 */
export function onboardingSampleIdSubjects<T extends Pick<OnboardingSubject, 'id'>>(
  subjects: readonly T[],
  sampleSubjects: readonly Pick<OnboardingSampleSubject, 'id'>[],
): T[] {
  const sampleIds = new Set(sampleSubjects.map((subject) => subject.id));
  return subjects.filter((subject) => sampleIds.has(subject.id));
}

/** Calm `sample_collision` copy: names the subjects and both ways out. Nothing was written. */
export function onboardingSampleCollisionMessage(labels: readonly string[]): string {
  const named = labels.map((label) => `“${label}”`);
  const subjects =
    named.length === 0
      ? 'This subject'
      : named.length === 1
        ? named[0]!
        : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  const verb =
    named.length > 1
      ? 'use the same ids as sample-bank subjects'
      : 'uses the same id as a sample-bank subject';
  return `${subjects} ${verb}, so generated questions would replace sample questions. Nothing was generated. Rename the subject id in Subjects, or turn on replacing sample-bank questions here and generate again.`;
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

/** Live bank row shown on Ready — ids + names, not a count alone. */
export type OnboardingLiveSubject = {
  id: string;
  label: string;
  questionCount: number;
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
  /**
   * Family subjects whose id is also a built-in (committed generated) subject.
   * After Apply the family version replaces the built-in one. A notice, not a blocker.
   */
  shadows: OnboardingSampleSubject[];
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
  /** Family subjects only (the data folder); built-in subjects are not edited here. */
  subjects: OnboardingSubject[];
  sampleSubjects: OnboardingSampleSubject[];
  /** Built-in generated subjects shipped in the checkout (biology). A same id replaces one. */
  builtinSubjects: OnboardingSampleSubject[];
  /**
   * The family data folder as CLI hints name it from the checkout root:
   * `data` (default), `data/<sub>`, or an absolute path.
   */
  dataDirDisplay: string;
  aiMode: OnboardingAiMode | null;
  replaceSample: boolean;
  hasDryRun: boolean;
  hasApplied: boolean;
  anthropicConfigured: boolean;
  openaiConfigured: boolean;
  /**
   * Live or `.env` store has a value (including the `test` sentinel).
   * Never the key itself. Clear/Rotate use `*LiveTest`, not this flag.
   */
  anthropicPresent: boolean;
  openaiPresent: boolean;
  /** Live process.env is exactly `test`. Never the value. */
  anthropicLiveTest: boolean;
  openaiLiveTest: boolean;
  /**
   * Host (Docker / systemd / parent exec environ) assigned the key —
   * including empty / `test`. A matching `.env` value is not enough.
   * Wizard write/clear of a usable or empty host key is refused. A boot
   * `test` sentinel (`*LiveTest` or `!*WriteBlocked`) can still be
   * cleared / rotated, including after the first Save.
   */
  anthropicHostManaged: boolean;
  openaiHostManaged: boolean;
  /**
   * True when set / clear is refused (`host_managed`). Inverse of the
   * wizard lock: a boot `test` sentinel stays writable after rotation.
   */
  anthropicWriteBlocked: boolean;
  openaiWriteBlocked: boolean;
  localAgentConfigured: boolean;
  /**
   * Free-text marking currently uses the deterministic `test` stub (full
   * marks, no network): the live key is the sentinel and `gradingStubAllowed()`
   * holds (non-production, or `GRADING_STUB=1`). Never the key itself.
   */
  gradingStubActive: boolean;
  /** Sample + generated live bank (Ready). Silent wrong bank stays visible. */
  liveSubjects: OnboardingLiveSubject[];
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
  /** True when the write replaced an existing `bank.ir.json`. */
  overwrite: boolean;
};

export type OnboardingIrOverwriteDecision = 'force' | 'skip';

/** Repo-relative BankIR path the CLI dry-run names. */
export function onboardingSubjectIrRel(subjectId: string): string {
  return `content/subjects/${subjectId}/bank.ir.json`;
}

/** CLI-shaped generate write verb (`wrote` / `would write` + overwrite). */
export function generateIrWriteVerb(wrote: boolean, overwrite: boolean): string {
  if (overwrite) return wrote ? 'overwrote' : 'would overwrite';
  return wrote ? 'wrote' : 'would write';
}

export function generateIrWriteLabel(irRel: string, wrote: boolean, overwrite: boolean): string {
  return `${generateIrWriteVerb(wrote, overwrite)} ${irRel}`;
}

/** Subjects whose generate would replace an existing `bank.ir.json`. */
export function onboardingGenerateOverwriteSubjects<
  T extends Pick<OnboardingSubject, 'id' | 'hasIr'>,
>(subjects: readonly T[], subjectIds: readonly string[]): T[] {
  const wanted = new Set(subjectIds);
  return subjects.filter((subject) => wanted.has(subject.id) && subject.hasIr);
}

/** Calm confirm copy. Batch names subjects — never an opaque count alone. */
export function onboardingIrOverwriteConfirmMessage(
  colliding: readonly Pick<OnboardingSubject, 'label'>[],
): string | null {
  if (colliding.length === 0) return null;
  if (colliding.length === 1) return `Replace existing BankIR for ${colliding[0]!.label}?`;
  const names = colliding.map((row) => row.label).join(', ');
  return `Replace ${colliding.length} existing BankIR files (${names})?`;
}

/**
 * Calm overwrite confirm. One subject uses the label; generate-all
 * colliding subjects use a named batch. Decline is skip, not invalid.
 */
export function confirmOnboardingIrOverwrite(
  colliding: readonly Pick<OnboardingSubject, 'label'>[],
  ask: (message: string) => boolean,
): OnboardingIrOverwriteDecision {
  const message = onboardingIrOverwriteConfirmMessage(colliding);
  if (!message) return 'force';
  return ask(message) ? 'force' : 'skip';
}

/**
 * `content/subjects` (or one subject in it) under the family data folder, as
 * a shell argument run from the checkout root. No display (or `.`) is the
 * checkout-relative form.
 */
export function onboardingSubjectsArg(dataDirDisplay?: string, subjectId?: string): string {
  const base =
    !dataDirDisplay || dataDirDisplay === '.'
      ? 'content/subjects'
      : `${dataDirDisplay}/content/subjects`;
  const target = subjectId ? `${base}/${subjectId}` : base;
  return /\s/.test(target) ? `'${target}'` : target;
}

/** Power-user validate → dry-run → apply for the family subjects tree. */
export function onboardingIngestCli(dataDirDisplay?: string): string[] {
  const subjects = onboardingSubjectsArg(dataDirDisplay);
  return [
    `pnpm examify-ingest validate ${subjects}`,
    `pnpm examify-ingest emit ${subjects} --dry-run`,
    `pnpm examify-ingest emit ${subjects} --apply`,
  ];
}

export const ONBOARDING_INGEST_CLI: readonly string[] = onboardingIngestCli();

export function onboardingGenerateCli(
  provider: OnboardingGenerateProvider,
  seed = ONBOARDING_GENERATE_SEED_DEFAULT,
  subjectId?: string,
  dataDirDisplay?: string,
): string {
  const target = onboardingSubjectsArg(dataDirDisplay, subjectId ?? '<id>');
  return `pnpm examify-ingest generate --provider ${provider} --seed ${seed} ${target}`;
}

export function onboardingGenerateAndEmitCli(
  provider: OnboardingGenerateProvider,
  seed = ONBOARDING_GENERATE_SEED_DEFAULT,
  dataDirDisplay?: string,
): string[] {
  return [
    onboardingGenerateCli(provider, seed, undefined, dataDirDisplay),
    ...onboardingIngestCli(dataDirDisplay),
  ];
}

/** Review notice for family subjects that replace built-in ones. */
export function onboardingShadowNotice(
  shadows: readonly Pick<OnboardingSampleSubject, 'label'>[],
): string | null {
  if (shadows.length === 0) return null;
  const labels = shadows.map((row) => row.label).join(', ');
  return `Replaces built-in subject${shadows.length === 1 ? '' : 's'}: ${labels}. Your family sees your version after Apply.`;
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

/** Filenames generate already reads (PDFs plus notes.txt / CLI sources). */
export function onboardingSourceFileNames(
  subject: Pick<OnboardingSubject, 'sourceFiles' | 'generateSources'>,
): string[] {
  const names = new Set<string>(subject.sourceFiles);
  for (const rel of subject.generateSources) {
    const base = rel.split('/').pop();
    if (base) names.add(base);
  }
  return [...names].sort();
}

/** Glance-scan Files-tab label. Does not invent uploads that are not there. */
export function onboardingSourceCountLabel(
  subject: Pick<OnboardingSubject, 'sourceFiles' | 'generateSources'> &
    Partial<Pick<OnboardingSubject, 'hasIr'>>,
): string {
  const sources = subject.generateSources.length;
  if (sources > 0) return `${sources} source${sources === 1 ? '' : 's'}`;
  const pdfs = subject.sourceFiles.length;
  if (pdfs > 0) return `${pdfs} PDF${pdfs === 1 ? '' : 's'}`;
  // Hand-authored BankIR with no CLI sources is not an empty subject.
  if (subject.hasIr) return 'Hand-authored';
  return 'No files yet';
}

export function onboardingPruneEntries(
  plan: readonly Pick<OnboardingPlanEntry, 'action' | 'path'>[],
): OnboardingPlanEntry[] {
  return plan
    .filter((entry) => entry.action === 'delete')
    .map((entry) => ({ path: entry.path, action: 'delete' as const }));
}

/** Subject ids named by leftover generated JSON that Apply would delete. */
export function onboardingPruneSubjectIds(
  deletes: readonly Pick<OnboardingPlanEntry, 'path'>[],
): string[] {
  const ids = new Set<string>();
  for (const entry of deletes) {
    const normalized = entry.path.replaceAll('\\', '/');
    const match = /content\/generated\/(?:questions|keys)\/([^/]+)\.json$/.exec(normalized);
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids].sort();
}

/** Calm prune confirm. Names leftovers — never an opaque count alone. Cancel = no apply. */
export function onboardingPruneConfirmMessage(
  deletes: readonly Pick<OnboardingPlanEntry, 'path'>[],
): string | null {
  if (deletes.length === 0) return null;
  const subjects = onboardingPruneSubjectIds(deletes);
  const named =
    subjects.length > 0 ? subjects.join(', ') : deletes.map((row) => row.path).join(', ');
  const files = deletes.map((row) => row.path).join(', ');
  return `Apply will remove leftover generated files for ${named} (${files}). Cancel keeps everything.`;
}
