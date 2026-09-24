/** Client-safe onboarding types (no DB / server-only / answer-key imports). */

export const ONBOARDING_AI_MODES = [
  'cloud',
  'cloud-openai',
  'claude-cli',
  'codex-cli',
  'local-agent',
  'local-cli',
  'skip-stub',
] as const;
export type OnboardingAiMode = (typeof ONBOARDING_AI_MODES)[number];

export const ONBOARDING_GENERATE_PROVIDERS = [
  'anthropic',
  'openai',
  'local',
  'claude-cli',
  'codex-cli',
  'test',
] as const;
export type OnboardingGenerateProvider = (typeof ONBOARDING_GENERATE_PROVIDERS)[number];

/** Claude Code / Codex: the household's own AI plan through its command-line tool. */
export type OnboardingAgentCliMode = Extract<OnboardingAiMode, 'claude-cli' | 'codex-cli'>;

export function isOnboardingAgentCliMode(
  mode: OnboardingAiMode | null | undefined,
): mode is OnboardingAgentCliMode {
  return mode === 'claude-cli' || mode === 'codex-cli';
}

/** Minutes an agent CLI may take (ingest `CLI_PROVIDER_TIMEOUT_MS`); API providers get 3. */
export const ONBOARDING_AGENT_CLI_TIMEOUT_MINUTES = 10;

/**
 * Which local transport a local mode uses (the ingest `LOCAL_TRANSPORTS`). The
 * ingest `local` provider prefers the command when both are set; the wizard
 * passes only the chosen one, and its power-user command says
 * `--local-transport`, so "Local endpoint" never runs the command and vice versa.
 */
export type OnboardingLocalTransport = 'endpoint' | 'command';

export function localTransportForOnboardingAiMode(
  mode: OnboardingAiMode,
): OnboardingLocalTransport | null {
  if (mode === 'local-agent') return 'endpoint';
  if (mode === 'local-cli') return 'command';
  return null;
}

/**
 * What a mode can do, for the AI step. `pdfs`: how study PDFs reach the model
 * (`direct` = as documents; `page-images` = rasterized with pdftoppm, so the
 * host needs poppler-utils; `command` = your command gets the PDF bytes).
 * `signIn`: an API key in the env store, the CLI's own login, host settings,
 * or nothing.
 */
export type OnboardingAiCapabilities = {
  pdfs: 'direct' | 'page-images' | 'command' | 'none';
  signIn: 'api-key' | 'cli-login' | 'host-settings' | 'none';
};

export const ONBOARDING_AI_CAPABILITIES: Record<OnboardingAiMode, OnboardingAiCapabilities> = {
  cloud: { pdfs: 'direct', signIn: 'api-key' },
  'cloud-openai': { pdfs: 'page-images', signIn: 'api-key' },
  'claude-cli': { pdfs: 'direct', signIn: 'cli-login' },
  'codex-cli': { pdfs: 'page-images', signIn: 'cli-login' },
  'local-agent': { pdfs: 'page-images', signIn: 'host-settings' },
  'local-cli': { pdfs: 'command', signIn: 'host-settings' },
  'skip-stub': { pdfs: 'none', signIn: 'none' },
};

const AGENT_CLI_COPY: Record<
  OnboardingAgentCliMode,
  { name: string; signIn: string; binEnv: string }
> = {
  'claude-cli': {
    name: 'Claude Code',
    signIn: 'run `claude` once and sign in',
    binEnv: 'EXAMIFY_CLAUDE_BIN',
  },
  'codex-cli': { name: 'Codex', signIn: 'run `codex login`', binEnv: 'EXAMIFY_CODEX_BIN' },
};

/** AI-step note for Claude Code / Codex: installed here or not, and how it signs in. */
export function onboardingAgentCliSetupNote(mode: OnboardingAgentCliMode, found: boolean): string {
  const cli = AGENT_CLI_COPY[mode];
  return found
    ? `${cli.name} is installed on this server. Generate uses its own sign-in: if it is not signed in yet, ${cli.signIn} as the user that runs Examify.`
    : `${cli.name} was not found on this server (PATH or ~/.local/bin). Install it as the user that runs Examify and ${cli.signIn}, then reload this page, or set ${cli.binEnv} in this host’s .env to its full path.`;
}

/**
 * Generate-failure copy that depends on the mode (which tool to sign in,
 * which setting is missing). Null means the shared copy applies.
 */
export function onboardingModeErrorCopy(
  reason: string,
  mode: OnboardingAiMode | null | undefined,
): string | null {
  if (isOnboardingAgentCliMode(mode)) {
    const cli = AGENT_CLI_COPY[mode];
    switch (reason) {
      case 'missing_cli':
        return `${cli.name} was not found on this server. Install it as the user that runs Examify and ${cli.signIn}, or set ${cli.binEnv} in this host’s .env to its full path. Nothing was written.`;
      case 'provider_auth':
        return `${cli.name} is not signed in for the user that runs Examify, or its sign-in was refused. As that user, ${cli.signIn}, then generate again. Nothing was written.`;
      case 'provider_rate_limited':
        return `${cli.name} hit its plan’s usage limit, or is being rate-limited. Wait a while, then try again. Nothing was written.`;
      case 'provider_timeout':
        return `${cli.name} did not answer within ${ONBOARDING_AGENT_CLI_TIMEOUT_MINUTES} minutes. Try again; very large files take longer. Nothing was written.`;
      case 'provider_error':
        return `${cli.name} reported an error (for example, a model its plan does not include, or a version too old for Examify). Run the generate command under Power-user commands on the host to see it. Nothing was written.`;
    }
  }
  if (reason === 'missing_local') {
    if (mode === 'local-agent') {
      return 'Local endpoint needs EXAMIFY_LLM_BASE_URL and EXAMIFY_LLM_MODEL (the model’s name; for Ollama, one that `ollama list` shows) in this host’s .env.';
    }
    if (mode === 'local-cli')
      return 'Local command needs EXAMIFY_INGEST_LOCAL_CMD in this host’s .env.';
  }
  return null;
}

/** One line under each mode: how it reads PDFs and how it signs in. */
export function onboardingAiCapabilityLine(mode: OnboardingAiMode): string {
  const caps = ONBOARDING_AI_CAPABILITIES[mode];
  const pdfs = {
    direct: 'Reads PDFs directly',
    'page-images': 'Reads PDFs as page images (the host needs pdftoppm)',
    command: 'Your command gets the PDFs, images and notes',
    none: 'Reads no sources: fixture questions only',
  }[caps.pdfs];
  const signIn = {
    'api-key': 'uses an API key',
    'cli-login': 'uses the tool’s own sign-in (your plan), no API key',
    'host-settings': 'set up on this host',
    none: 'nothing to set up',
  }[caps.signIn];
  return `${pdfs} · ${signIn}.`;
}

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

/** Which AI marks a household's written (free-text) answers. */
export const MARKING_BACKENDS = [
  'anthropic',
  'openai',
  'claude-cli',
  'codex-cli',
  'local-endpoint',
] as const;
export type MarkingBackend = (typeof MARKING_BACKENDS)[number];

/**
 * The saved AI mode marks written answers when it can: Anthropic / OpenAI with
 * their API keys, Claude Code / Codex with their own sign-in, Local endpoint
 * with its model. Local command speaks the BankIR contract only and the test
 * stub is not an AI, so they (and a household with no mode yet) keep the
 * Anthropic key path the app always had.
 */
export function markingBackendForAiMode(mode: OnboardingAiMode | null | undefined): MarkingBackend {
  switch (mode) {
    case 'cloud-openai':
      return 'openai';
    case 'claude-cli':
      return 'claude-cli';
    case 'codex-cli':
      return 'codex-cli';
    case 'local-agent':
      return 'local-endpoint';
    default:
      return 'anthropic';
  }
}

/** The host facts marking needs: the snapshot's configured / found flags. */
export type MarkingFlags = Pick<
  OnboardingSnapshot,
  | 'anthropicConfigured'
  | 'gradingStubActive'
  | 'openaiConfigured'
  | 'openaiGradingStubActive'
  | 'claudeCliFound'
  | 'codexCliFound'
  | 'localHttpConfigured'
  | 'localModelConfigured'
>;

/**
 * `ready`: it marks. `stub`: the `test` key gives full marks. `not_ready`:
 * answers stay unmarked. Claude Code / Codex are `ready` once found: their
 * sign-in is only known when they run, so their copy says marking needs it.
 */
export type MarkingReadiness = 'ready' | 'stub' | 'not_ready';

/** Whether this host can mark with `backend`, from the wizard snapshot's setup flags. */
export function markingReadiness(backend: MarkingBackend, flags: MarkingFlags): MarkingReadiness {
  switch (backend) {
    case 'anthropic':
      return flags.anthropicConfigured ? 'ready' : flags.gradingStubActive ? 'stub' : 'not_ready';
    case 'openai':
      return flags.openaiConfigured
        ? 'ready'
        : flags.openaiGradingStubActive
          ? 'stub'
          : 'not_ready';
    case 'claude-cli':
      return flags.claudeCliFound ? 'ready' : 'not_ready';
    case 'codex-cli':
      return flags.codexCliFound ? 'ready' : 'not_ready';
    case 'local-endpoint':
      return flags.localHttpConfigured && flags.localModelConfigured ? 'ready' : 'not_ready';
  }
}

const MARKING_LABEL: Record<MarkingBackend, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex',
  'local-endpoint': 'your local endpoint',
};

/** What this server needs before a backend marks anything. */
const MARKING_SETUP: Record<MarkingBackend, string> = {
  anthropic: 'an Anthropic API key',
  openai: 'an OpenAI API key',
  'claude-cli': 'Claude Code installed and signed in as the user that runs Examify',
  'codex-cli': 'Codex installed and signed in as the user that runs Examify',
  'local-endpoint': 'EXAMIFY_LLM_BASE_URL (an http or https address) and EXAMIFY_LLM_MODEL set',
};

/** Why a mode with no marking path of its own uses the Anthropic key. */
function markingFallbackNote(mode: OnboardingAiMode | null | undefined): string {
  if (mode === 'local-cli')
    return 'Local command cannot mark written answers, so marking uses the Anthropic key. ';
  if (mode === 'skip-stub')
    return 'The test stub cannot mark written answers, so marking uses the Anthropic key. ';
  if (!mode) return 'Until you pick a mode, marking uses the Anthropic key. ';
  return '';
}

/**
 * The AI step's marking line: who marks written answers for this mode, what is
 * sent, and what is missing. Never promises marking later: an answer that is
 * not marked counts as not correct.
 */
export function onboardingMarkingCopy(
  mode: OnboardingAiMode | null | undefined,
  flags: MarkingFlags,
): string {
  const backend = markingBackendForAiMode(mode);
  const label = MARKING_LABEL[backend];
  const note = markingFallbackNote(mode);
  switch (markingReadiness(backend, flags)) {
    case 'stub':
      return `${note}The ${label} key is the test placeholder, so written answers get a stub full mark and nothing is sent. Set a real key before real use.`;
    case 'not_ready':
      return `${note}Written answers are saved but not marked until this server has ${MARKING_SETUP[backend]}: until then they count as not correct.`;
    case 'ready':
      if (backend === 'claude-cli' || backend === 'codex-cli') {
        return `Written answers are marked by ${label} while it is signed in as the user that runs Examify: one run marks all of an exam’s written answers, each sent with its question and rubric, and can take up to a minute. Signed out, they are not marked and count as not correct.`;
      }
      if (backend === 'local-endpoint') {
        return 'Written answers are marked by your local endpoint (EXAMIFY_LLM_MODEL), each sent with its question and rubric. A slow model can leave answers unmarked: all of an exam’s answers share a 45-second limit.';
      }
      return `${note}Written answers are marked by ${label}: each one is sent with its question and rubric.`;
  }
}

/** The parent dashboard's one line on marking. */
export function parentMarkingLine(backend: MarkingBackend, readiness: MarkingReadiness): string {
  const label = MARKING_LABEL[backend];
  switch (readiness) {
    case 'ready':
      if (backend === 'claude-cli' || backend === 'codex-cli') {
        return `Written answers are marked by ${label} while it is signed in on this server. Signed out, they count as not correct.`;
      }
      return `Written answers are marked by ${label}.`;
    case 'stub':
      return `Written answers get a test full mark: the ${label} key is a placeholder.`;
    case 'not_ready':
      return `Written answers are not marked: this server needs ${MARKING_SETUP[backend]}. Until then they count as not correct.`;
  }
}

export function providerForOnboardingAiMode(mode: OnboardingAiMode): OnboardingGenerateProvider {
  switch (mode) {
    case 'cloud':
      return 'anthropic';
    case 'cloud-openai':
      return 'openai';
    case 'claude-cli':
      return 'claude-cli';
    case 'codex-cli':
      return 'codex-cli';
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
  /** `EXAMIFY_LLM_BASE_URL` is set to an http(s) address (Local endpoint mode). */
  localHttpConfigured: boolean;
  /** `EXAMIFY_LLM_MODEL` is set — the model name the local endpoint gets. */
  localModelConfigured: boolean;
  /** `EXAMIFY_INGEST_LOCAL_CMD` is set (Local command mode). */
  localCmdConfigured: boolean;
  /**
   * Claude Code / Codex binary found on this server (`EXAMIFY_CLAUDE_BIN` /
   * `EXAMIFY_CODEX_BIN`, PATH, `~/.local/bin`). Not whether it is signed in —
   * generate says so. Never the path.
   */
  claudeCliFound: boolean;
  codexCliFound: boolean;
  /**
   * Free-text marking currently uses the deterministic `test` stub (full
   * marks, no network): the live key is the sentinel and `gradingStubAllowed()`
   * holds (non-production, or `GRADING_STUB=1`). Never the key itself.
   */
  gradingStubActive: boolean;
  /** The same for the OpenAI key (a household whose mode is OpenAI marks with it). */
  openaiGradingStubActive: boolean;
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

/**
 * The generate command for a mode. Local modes add `--local-transport`, so the
 * command uses the same transport as the wizard even when the host sets both.
 */
export function onboardingGenerateCli(
  provider: OnboardingGenerateProvider,
  seed = ONBOARDING_GENERATE_SEED_DEFAULT,
  subjectId?: string,
  dataDirDisplay?: string,
  localTransport?: OnboardingLocalTransport | null,
): string {
  const target = onboardingSubjectsArg(dataDirDisplay, subjectId ?? '<id>');
  const transport =
    provider === 'local' && localTransport ? ` --local-transport ${localTransport}` : '';
  return `pnpm examify-ingest generate --provider ${provider}${transport} --seed ${seed} ${target}`;
}

export function onboardingGenerateAndEmitCli(
  provider: OnboardingGenerateProvider,
  seed = ONBOARDING_GENERATE_SEED_DEFAULT,
  dataDirDisplay?: string,
  localTransport?: OnboardingLocalTransport | null,
): string[] {
  return [
    onboardingGenerateCli(provider, seed, undefined, dataDirDisplay, localTransport),
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
