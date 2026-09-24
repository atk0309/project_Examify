import 'server-only';

import path from 'node:path';
import * as ingestGenerate from 'examify-ingest/generate';
import { forgetAgentCliSignIn } from '@/lib/agent-cli-sign-in';
import { getOnboardingContentRoot, isFamilyWritePathSafe } from '@/lib/content-root';
import {
  BANK_IR_FILE,
  isSampleSubjectId,
  isValidSubjectId,
  listOnboardingSubjects,
  normalizeSubjectId,
  onboardingHostEnv,
  SUBJECT_LABEL_MAX,
  SUBJECTS_REL,
} from '@/lib/onboarding';
import {
  generateIrWriteLabel,
  type OnboardingGenerateProvider,
  type OnboardingLocalTransport,
  type OnboardingGenerateResult,
  type OnboardingIrOverwriteDecision,
} from '@/lib/onboarding-types';

/**
 * Safe generate reason codes. The action forwards `reason` (and `irRel` for
 * needs_confirm) only; `message` / `status` stay on the server.
 */
export type GenerateOnboardingReason =
  | 'invalid_id'
  | 'missing'
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
  | 'disk'
  | 'unsafe_path'
  | 'generate_failed'
  | 'cancelled'
  | 'skipped'
  | 'needs_confirm';

export type GenerateOnboardingError = {
  ok: false;
  reason: GenerateOnboardingReason;
  message: string;
  irRel?: string;
  /** Provider HTTP status, for the server log only. */
  status?: number;
};

export type GenerateOnboardingSuccess = {
  ok: true;
  result: OnboardingGenerateResult;
};

const CANCEL_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
/**
 * Process-local cancel tokens (insertion-order Set). At 65 the oldest token
 * is evicted (FIFO). Generate is single-flight in this process, so 64 is
 * leftover-token headroom after settle — not a concurrent-tab budget. A
 * second tab shares this Set only if it hits the same Node process; 64
 * in-flight cancel tokens would already imply a stuck process, so we do
 * not raise the cap. Concurrent tabs are not a reason to raise it:
 * generate is still single-flight, and extra tokens are leftovers.
 *
 * This Set skips the wizard IR write. The matching AbortController
 * (when generate is in flight) aborts provider HTTP/CMD via ingest
 * `generateSubject({ signal })`.
 */
const cancelledTokens = new Set<string>();
const committedTokens = new Set<string>();
const abortControllers = new Map<string, AbortController>();
const MAX_CANCEL_TOKENS = 64;

function rememberToken(set: Set<string>, token: string): void {
  set.add(token);
  if (set.size > MAX_CANCEL_TOKENS) {
    const first = set.values().next().value;
    if (first) set.delete(first);
  }
}

/** Single-flight: one onboarding generate commits at a time in this process. */
let generateChain: Promise<unknown> = Promise.resolve();

export function isOnboardingGenerateCancelToken(token: string): boolean {
  return CANCEL_TOKEN_RE.test(token);
}

/**
 * Record a cancel. The token is remembered either way, so any later generate
 * with it (the next subject of a "Generate all" batch) is refused before the
 * provider call. True when that stops work: the in-flight request is aborted,
 * or none has run yet. False when nothing is in flight and this token's last
 * generate already committed IR (`already_committed`) — that subject is kept
 * and cancel must not look like it undid it.
 */
export function requestOnboardingGenerateCancel(token: string): boolean {
  if (!isOnboardingGenerateCancelToken(token)) return false;
  rememberToken(cancelledTokens, token);
  const inFlight = abortControllers.get(token);
  if (inFlight) {
    inFlight.abort();
    return true;
  }
  return !committedTokens.has(token);
}

export function markOnboardingGenerateCommitted(token: string | undefined): void {
  if (!token || !isOnboardingGenerateCancelToken(token)) return;
  cancelledTokens.delete(token);
  rememberToken(committedTokens, token);
}

export function resetOnboardingGenerateForTests(): void {
  cancelledTokens.clear();
  committedTokens.clear();
  abortControllers.clear();
  generateChain = Promise.resolve();
}

function registerGenerateAbort(token: string): AbortController {
  const existing = abortControllers.get(token);
  if (existing) return existing;
  const controller = new AbortController();
  abortControllers.set(token, controller);
  if (cancelledTokens.has(token)) controller.abort();
  return controller;
}

function dropGenerateAbort(token?: string): void {
  if (!token) return;
  abortControllers.delete(token);
}

/** User cancel only — not a bare `AbortError` from the 180s provider timeout. */
function isUserGenerateAbort(error: unknown): boolean {
  return error instanceof ingestGenerate.GenerateAbortedError;
}

function isGenerateCancelled(token?: string): boolean {
  return Boolean(token && cancelledTokens.has(token));
}

function cancelledResult(): GenerateOnboardingError {
  return { ok: false, reason: 'cancelled', message: 'Generate cancelled.' };
}

function sampleCollisionResult(subjectId: string): GenerateOnboardingError {
  return {
    ok: false,
    reason: 'sample_collision',
    message: `${subjectId} has a sample-bank subject id; generated ids would replace sample questions`,
  };
}

function unsafePathResult(): GenerateOnboardingError {
  return {
    ok: false,
    reason: 'unsafe_path',
    message: 'refusing to write through a link inside the family data folder',
  };
}

/** Outcomes the admin chose (or has to confirm) — not failures, so not logged. */
const UNLOGGED_REASONS = new Set<GenerateOnboardingReason>([
  'cancelled',
  'skipped',
  'needs_confirm',
]);

/**
 * One server log line per generate failure: the reason code, the subject id
 * (only when it is a valid kebab id), and a provider HTTP status. Never the
 * message — it can carry paths, env names, or model text — and never keys.
 */
function logGenerateFailure(rawSubjectId: string, result: GenerateOnboardingError): void {
  if (UNLOGGED_REASONS.has(result.reason)) return;
  const subjectId = normalizeSubjectId(rawSubjectId);
  console.warn('[onboarding] generate failed', {
    reason: result.reason,
    ...(isValidSubjectId(subjectId) && subjectId.length <= SUBJECT_LABEL_MAX ? { subjectId } : {}),
    ...(result.status ? { status: result.status } : {}),
  });
}

/** Serialize generate commit with delete/rename so they cannot interleave the IR write. */
export function withOnboardingGenerateLock<T>(task: () => Promise<T>): Promise<T> {
  const run = generateChain.then(task, task);
  generateChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function posixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function needsConfirmResult(irRel: string): GenerateOnboardingError {
  return {
    ok: false,
    reason: 'needs_confirm',
    message: generateIrWriteLabel(irRel, false, true),
    irRel,
  };
}

function skippedResult(irRel: string): GenerateOnboardingError {
  return { ok: false, reason: 'skipped', message: 'Generate skipped.', irRel };
}

function providerFailureReason(
  error: InstanceType<typeof ingestGenerate.ProviderFailureError>,
): GenerateOnboardingReason {
  switch (error.kind) {
    case 'http': {
      const status = error.status ?? 0;
      if (status === 401 || status === 403) return 'provider_auth';
      if (status === 429) return 'provider_rate_limited';
      // 5xx includes Anthropic 529 (overloaded).
      if (status >= 500) return 'provider_unavailable';
      return 'provider_error';
    }
    case 'timeout':
      return 'provider_timeout';
    case 'unreachable':
      return 'provider_unavailable';
    case 'output':
      return 'provider_output_invalid';
    case 'command':
      return 'provider_error';
    case 'auth':
      return 'provider_auth';
  }
}

function isDiskError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EROFS';
}

function mapGenerateError(error: unknown): GenerateOnboardingError {
  if (isUserGenerateAbort(error)) {
    return cancelledResult();
  }
  if (error instanceof ingestGenerate.BankIrOverwriteError) {
    // Calm reason only — never leak CLI `--force` copy to the wizard.
    return needsConfirmResult(error.irPath);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ingestGenerate.CliNotFoundError) {
    return { ok: false, reason: 'missing_cli', message };
  }
  if (error instanceof ingestGenerate.ProviderConfigError) {
    if (message.includes('EXAMIFY_INGEST_LOCAL_CMD') || message.includes('EXAMIFY_LLM_BASE_URL')) {
      return { ok: false, reason: 'missing_local', message };
    }
    return { ok: false, reason: 'missing_key', message };
  }
  if (error instanceof ingestGenerate.SampleIdCollisionError) {
    return { ok: false, reason: 'sample_collision', message };
  }
  if (error instanceof ingestGenerate.UnreadableSourcesError) {
    return { ok: false, reason: 'sources_unreadable', message };
  }
  if (error instanceof ingestGenerate.ProviderFailureError) {
    return {
      ok: false,
      reason: providerFailureReason(error),
      message,
      ...(error.status ? { status: error.status } : {}),
    };
  }
  // A bare timeout / abort that is not the admin's cancel (e.g. the 180s
  // deadline firing while the response body is read) is a timeout.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { ok: false, reason: 'provider_timeout', message };
  }
  if (isDiskError(error)) {
    return { ok: false, reason: 'disk', message };
  }
  if (/no source files/i.test(message)) {
    return { ok: false, reason: 'empty_sources', message };
  }
  if (/path not found|no generate subjects|no subject folder/i.test(message)) {
    return { ok: false, reason: 'missing', message };
  }
  return { ok: false, reason: 'generate_failed', message };
}

/**
 * Generate's environment. Local modes keep only their own transport
 * (`localTransportEnv`, the same filter as the CLI's `--local-transport`): the
 * ingest `local` provider runs `EXAMIFY_INGEST_LOCAL_CMD` whenever it is set.
 */
function onboardingGenerateEnv(
  transport: OnboardingLocalTransport | undefined,
): Record<string, string | undefined> {
  const env = onboardingHostEnv();
  return transport ? ingestGenerate.localTransportEnv(env, transport) : env;
}

function publicGenerateResult(
  subjectId: string,
  root: string,
  generated: Awaited<ReturnType<typeof ingestGenerate.generateSubject>>,
  wroteIr: boolean,
  overwrite: boolean,
): OnboardingGenerateResult {
  return {
    subjectId,
    provider: generated.manifest.provider,
    model: generated.manifest.model,
    seed: generated.manifest.seed,
    cacheHit: generated.cacheHit,
    cacheKey: generated.cacheKey,
    sourceCount: Object.keys(generated.manifest.sourceHashes).length,
    sourceHashes: generated.manifest.sourceHashes,
    wroteIr,
    irRel: posixRel(root, generated.irPath),
    overwrite,
  };
}

/**
 * Draft BankIR for one wizard subject via `examify-ingest/generate`.
 * Preview uses ingest `dryRunIr` so `generateSubject` does not write
 * `bank.ir.json`. Confirm happens before generate so a dry-run never
 * looks finished first. The wizard commits only through shared
 * `writeBankIrAtomic` when the cancel token is still clear **and**
 * an existing IR has `force` (same as CLI `--force`). Never emit / apply.
 * A cancel token mints an AbortController whose signal is passed into
 * ingest generate/providers so Cancel aborts HTTP/CMD, not only the
 * IR write. `GenerateAbortedError` maps to `cancelled` (never raw abort
 * text). A bare `AbortError` (provider 180s timeout) is a real failure,
 * not user cancel (it is `provider_timeout`). Decline / skip keeps prior
 * bytes (`skipped`, not a failure). A sample-bank subject id is refused
 * before the provider call unless `replaceSample` (the household's
 * replace-sample choice, same as CLI `--replace-sample`); with it, generate
 * may write sample ids. Failures map to safe reason codes and log once
 * (reason + subject id). The returned payload is public progress metadata
 * (no answers / keys / IR).
 */
export async function generateOnboardingSubject(input: {
  subjectId: string;
  provider: OnboardingGenerateProvider;
  /** Local modes: the one transport the admin chose (the other setting is hidden). */
  localTransport?: OnboardingLocalTransport;
  seed: number;
  root?: string;
  cancelToken?: string;
  /** Same as CLI `--force` — required to replace an existing `bank.ir.json`. */
  force?: boolean;
  /** Explicit decline — keep prior IR, do not generate. */
  overwrite?: OnboardingIrOverwriteDecision;
  /** Same as CLI `--replace-sample`: allow generated ids that are sample-bank ids. */
  replaceSample?: boolean;
}): Promise<GenerateOnboardingSuccess | GenerateOnboardingError> {
  const result = await withOnboardingGenerateLock(() => generateOnboardingSubjectUnlocked(input));
  if (!result.ok) logGenerateFailure(input.subjectId, result);
  // Claude Code / Codex refused the sign-in: the next page asks it again.
  if (!result.ok && result.reason === 'provider_auth') {
    if (input.provider === 'claude-cli') forgetAgentCliSignIn('claude');
    if (input.provider === 'codex-cli') forgetAgentCliSignIn('codex');
  }
  return result;
}

async function generateOnboardingSubjectUnlocked(input: {
  subjectId: string;
  provider: OnboardingGenerateProvider;
  localTransport?: OnboardingLocalTransport;
  seed: number;
  root?: string;
  cancelToken?: string;
  force?: boolean;
  overwrite?: OnboardingIrOverwriteDecision;
  replaceSample?: boolean;
}): Promise<GenerateOnboardingSuccess | GenerateOnboardingError> {
  const subjectId = normalizeSubjectId(input.subjectId);
  if (!isValidSubjectId(subjectId)) {
    return { ok: false, reason: 'invalid_id', message: 'Subject id must be kebab-case.' };
  }

  const root = input.root ?? getOnboardingContentRoot();
  const existingIrPath = path.join(root, SUBJECTS_REL, subjectId, BANK_IR_FILE);
  // Before a (possibly paid) provider call, and again right before the write.
  if (!isFamilyWritePathSafe(root, existingIrPath)) return unsafePathResult();
  if (!listOnboardingSubjects(root).some((row) => row.id === subjectId)) {
    return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
  }

  if (isGenerateCancelled(input.cancelToken)) {
    return cancelledResult();
  }

  const existingIrRel = posixRel(root, existingIrPath);
  const force = input.force === true || input.overwrite === 'force';
  // Shared empty≠existing predicate — never existsSync on the IR path.
  // Corrupt IR is existing (confirm / force); empty + zero-item are not.
  if (ingestGenerate.hasExistingBankIr(existingIrPath) && input.overwrite === 'skip') {
    return skippedResult(existingIrRel);
  }
  // Its questions would be `<id>-easy-1`… — frozen sample ids. Refuse before
  // a (possibly paid) provider call rather than after it.
  const replaceSample = input.replaceSample === true;
  if (!replaceSample && isSampleSubjectId(subjectId)) {
    return sampleCollisionResult(subjectId);
  }
  // Confirm before generate: existing IR without force never starts a
  // provider dry-run that already looks done. Shared helper, same as CLI.
  if (!force) {
    try {
      ingestGenerate.assertCanWriteBankIr(existingIrPath, {
        force: false,
        displayPath: existingIrRel,
      });
    } catch (error) {
      if (error instanceof ingestGenerate.BankIrOverwriteError) {
        return needsConfirmResult(existingIrRel);
      }
      return mapGenerateError(error);
    }
  }

  // Keys live in the checkout `.env` (env store), not the family data folder.
  const env = onboardingGenerateEnv(input.localTransport);
  if (input.localTransport === 'endpoint' && !env[ingestGenerate.LOCAL_MODEL_ENV]?.trim()) {
    return {
      ok: false,
      reason: 'missing_local',
      message: `local endpoint needs ${ingestGenerate.LOCAL_MODEL_ENV}`,
    };
  }

  const subjectInput = path.join(SUBJECTS_REL, subjectId);
  let target;
  try {
    const targets = ingestGenerate.resolveGenerateTargets([subjectInput], root, root, subjectId);
    target = targets[0];
  } catch (error) {
    return mapGenerateError(error);
  }
  if (!target) {
    return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
  }

  const token = input.cancelToken;
  const controller =
    token && isOnboardingGenerateCancelToken(token) ? registerGenerateAbort(token) : undefined;
  try {
    if (isGenerateCancelled(token)) {
      return cancelledResult();
    }
    const generated = await ingestGenerate.generateSubject({
      repoRoot: root,
      subject: target.subject,
      subjectDir: target.subjectDir,
      sources: target.sources,
      provider: input.provider,
      seed: input.seed,
      env,
      replaceSample,
      // Preview only — wizard owns the IR write after cancel + catalog checks.
      dryRunIr: true,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (isGenerateCancelled(token)) {
      return cancelledResult();
    }
    if (!isFamilyWritePathSafe(root, generated.irPath)) return unsafePathResult();
    // #65: re-check after the provider returns so a delete/rename during
    // generateSubject is not resurrected by writeBankIrAtomic's mkdirSync.
    if (!listOnboardingSubjects(root).some((row) => row.id === subjectId)) {
      return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
    }
    const irRel = posixRel(root, generated.irPath);
    // TOCTOU: re-check existence at commit via the shared persist gate.
    const written = ingestGenerate.writeBankIrAtomic(generated.irPath, stableJson(generated.bank), {
      force,
      displayPath: irRel,
    });
    markOnboardingGenerateCommitted(token);
    return {
      ok: true,
      result: publicGenerateResult(subjectId, root, generated, true, written.existed),
    };
  } catch (error) {
    if (isGenerateCancelled(token) || isUserGenerateAbort(error)) {
      return cancelledResult();
    }
    return mapGenerateError(error);
  } finally {
    dropGenerateAbort(token);
  }
}
