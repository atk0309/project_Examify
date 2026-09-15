import 'server-only';

import path from 'node:path';
import * as ingestGenerate from 'examify-ingest/generate';
import { getOnboardingContentRoot } from '@/lib/content-root';
import {
  isValidSubjectId,
  listOnboardingSubjects,
  normalizeSubjectId,
  SUBJECTS_REL,
} from '@/lib/onboarding';
import type { OnboardingGenerateProvider, OnboardingGenerateResult } from '@/lib/onboarding-types';

export type GenerateOnboardingError = {
  ok: false;
  reason:
    | 'invalid_id'
    | 'missing'
    | 'missing_key'
    | 'missing_local'
    | 'empty_sources'
    | 'invalid'
    | 'cancelled';
  message: string;
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

/** False when this token already committed IR — cancel must not look successful. */
export function requestOnboardingGenerateCancel(token: string): boolean {
  if (!isOnboardingGenerateCancelToken(token)) return false;
  if (committedTokens.has(token)) return false;
  rememberToken(cancelledTokens, token);
  abortControllers.get(token)?.abort();
  return true;
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

function isGenerateAbort(error: unknown): boolean {
  if (error instanceof ingestGenerate.GenerateAbortedError) return true;
  return ingestGenerate.isAbortError(error);
}

function isGenerateCancelled(token?: string): boolean {
  return Boolean(token && cancelledTokens.has(token));
}

function cancelledResult(): GenerateOnboardingError {
  return { ok: false, reason: 'cancelled', message: 'Generate cancelled.' };
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

function mapGenerateError(error: unknown): GenerateOnboardingError {
  if (isGenerateAbort(error)) {
    return cancelledResult();
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ingestGenerate.ProviderConfigError) {
    if (message.includes('EXAMIFY_INGEST_LOCAL_CMD') || message.includes('EXAMIFY_LLM_BASE_URL')) {
      return { ok: false, reason: 'missing_local', message };
    }
    return { ok: false, reason: 'missing_key', message };
  }
  if (/no source files/i.test(message)) {
    return { ok: false, reason: 'empty_sources', message };
  }
  if (/path not found|no generate subjects|no subject folder/i.test(message)) {
    return { ok: false, reason: 'missing', message };
  }
  return { ok: false, reason: 'invalid', message };
}

function publicGenerateResult(
  subjectId: string,
  root: string,
  generated: Awaited<ReturnType<typeof ingestGenerate.generateSubject>>,
  wroteIr: boolean,
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
  };
}

/**
 * Draft BankIR for one wizard subject via `examify-ingest/generate`.
 * Preview uses ingest `dryRunIr` so `generateSubject` does not write
 * `bank.ir.json`. The wizard path commits that file only if the
 * cancel token is still clear. Never emit / apply.
 * A cancel token mints an AbortController whose signal is passed into
 * ingest generate/providers so Cancel aborts HTTP/CMD, not only the
 * IR write. Abort and `GenerateAbortedError` map to `cancelled` (never
 * raw abort text). The returned payload is public progress metadata
 * (no answers / keys / IR).
 */
export async function generateOnboardingSubject(input: {
  subjectId: string;
  provider: OnboardingGenerateProvider;
  seed: number;
  root?: string;
  cancelToken?: string;
}): Promise<GenerateOnboardingSuccess | GenerateOnboardingError> {
  return withOnboardingGenerateLock(() => generateOnboardingSubjectUnlocked(input));
}

async function generateOnboardingSubjectUnlocked(input: {
  subjectId: string;
  provider: OnboardingGenerateProvider;
  seed: number;
  root?: string;
  cancelToken?: string;
}): Promise<GenerateOnboardingSuccess | GenerateOnboardingError> {
  const subjectId = normalizeSubjectId(input.subjectId);
  if (!isValidSubjectId(subjectId)) {
    return { ok: false, reason: 'invalid_id', message: 'Subject id must be kebab-case.' };
  }

  const root = input.root ?? getOnboardingContentRoot();
  if (!listOnboardingSubjects(root).some((row) => row.id === subjectId)) {
    return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
  }

  if (isGenerateCancelled(input.cancelToken)) {
    return cancelledResult();
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
      env: ingestGenerate.mergeRepoEnvFiles(root, process.env),
      // Preview only — wizard owns the IR write after cancel + catalog checks.
      dryRunIr: true,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (isGenerateCancelled(token)) {
      return cancelledResult();
    }
    // #65: re-check after the provider returns so a delete/rename during
    // generateSubject is not resurrected by writeFileAtomic's mkdirSync.
    if (!listOnboardingSubjects(root).some((row) => row.id === subjectId)) {
      return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
    }
    ingestGenerate.writeFileAtomic(generated.irPath, stableJson(generated.bank));
    markOnboardingGenerateCommitted(token);
    return { ok: true, result: publicGenerateResult(subjectId, root, generated, true) };
  } catch (error) {
    if (isGenerateCancelled(token) || isGenerateAbort(error)) {
      return cancelledResult();
    }
    return mapGenerateError(error);
  } finally {
    dropGenerateAbort(token);
  }
}
