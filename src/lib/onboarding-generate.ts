import 'server-only';

import { existsSync } from 'node:fs';
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
const cancelledTokens = new Set<string>();
const abortControllers = new Map<string, AbortController>();
const MAX_CANCEL_TOKENS = 64;

/** Single-flight: one onboarding generate commits at a time in this process. */
let generateChain: Promise<unknown> = Promise.resolve();

export function isOnboardingGenerateCancelToken(token: string): boolean {
  return CANCEL_TOKEN_RE.test(token);
}

export function requestOnboardingGenerateCancel(token: string): void {
  if (!isOnboardingGenerateCancelToken(token)) return;
  cancelledTokens.add(token);
  abortControllers.get(token)?.abort();
  if (cancelledTokens.size > MAX_CANCEL_TOKENS) {
    const first = cancelledTokens.values().next().value;
    if (first) {
      cancelledTokens.delete(first);
      abortControllers.get(first)?.abort();
      abortControllers.delete(first);
    }
  }
}

export function clearOnboardingGenerateCancel(token: string | undefined): void {
  if (!token) return;
  cancelledTokens.delete(token);
  abortControllers.delete(token);
}

export function resetOnboardingGenerateForTests(): void {
  cancelledTokens.clear();
  for (const controller of abortControllers.values()) controller.abort();
  abortControllers.clear();
  generateChain = Promise.resolve();
}

function isGenerateCancelled(signal?: AbortSignal, token?: string): boolean {
  return Boolean(signal?.aborted || (token && cancelledTokens.has(token)));
}

function cancelledResult(): GenerateOnboardingError {
  return { ok: false, reason: 'cancelled', message: 'Generate cancelled.' };
}

/** Serialize generate commit with delete/rename so a late write cannot resurrect an id. */
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function mapGenerateError(error: unknown): GenerateOnboardingError {
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

function catalogHasSubject(root: string, subjectId: string): boolean {
  return listOnboardingSubjects(root).some((row) => row.id === subjectId);
}

/**
 * Draft BankIR for one wizard subject via `examify-ingest/generate`.
 * Preview uses ingest `dryRunIr` so `generateSubject` does not write
 * `bank.ir.json`. The wizard path commits that file only if the
 * AbortSignal / cancel token is still clear. Never emit / apply.
 * The returned payload is public progress metadata (no answers / keys / IR).
 */
export async function generateOnboardingSubject(input: {
  subjectId: string;
  provider: OnboardingGenerateProvider;
  seed: number;
  root?: string;
  signal?: AbortSignal;
  cancelToken?: string;
}): Promise<GenerateOnboardingSuccess | GenerateOnboardingError> {
  return withOnboardingGenerateLock(() => generateOnboardingSubjectUnlocked(input));
}

async function generateOnboardingSubjectUnlocked(input: {
  subjectId: string;
  provider: OnboardingGenerateProvider;
  seed: number;
  root?: string;
  signal?: AbortSignal;
  cancelToken?: string;
}): Promise<GenerateOnboardingSuccess | GenerateOnboardingError> {
  const subjectId = normalizeSubjectId(input.subjectId);
  if (!isValidSubjectId(subjectId)) {
    return { ok: false, reason: 'invalid_id', message: 'Subject id must be kebab-case.' };
  }

  const root = input.root ?? getOnboardingContentRoot();
  if (!catalogHasSubject(root, subjectId)) {
    return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
  }

  const controller = new AbortController();
  if (input.cancelToken) abortControllers.set(input.cancelToken, controller);
  const userSignal = input.signal;
  const providerSignal = userSignal
    ? AbortSignal.any([userSignal, controller.signal])
    : controller.signal;

  try {
    if (isGenerateCancelled(userSignal, input.cancelToken)) {
      controller.abort();
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

    const generated = await ingestGenerate.generateSubject({
      repoRoot: root,
      subject: target.subject,
      subjectDir: target.subjectDir,
      sources: target.sources,
      provider: input.provider,
      seed: input.seed,
      env: ingestGenerate.mergeRepoEnvFiles(root, process.env),
      signal: providerSignal,
      dryRunIr: true,
    });
    if (isGenerateCancelled(userSignal, input.cancelToken) || controller.signal.aborted) {
      return cancelledResult();
    }
    // Re-check after the provider returns: delete/rename must not be
    // resurrected by writeFileAtomic's mkdirSync.
    if (!catalogHasSubject(root, subjectId) || !existsSync(target.subjectDir)) {
      return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
    }
    ingestGenerate.writeFileAtomic(generated.irPath, stableJson(generated.bank), { mkdir: false });
    if (!catalogHasSubject(root, subjectId)) {
      return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
    }
    return { ok: true, result: publicGenerateResult(subjectId, root, generated, true) };
  } catch (error) {
    if (isGenerateCancelled(userSignal, input.cancelToken) || controller.signal.aborted) {
      return cancelledResult();
    }
    if (isMissingPathError(error) || !catalogHasSubject(root, subjectId)) {
      return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
    }
    return mapGenerateError(error);
  } finally {
    clearOnboardingGenerateCancel(input.cancelToken);
  }
}
