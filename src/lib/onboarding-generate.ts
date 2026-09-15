import 'server-only';

import { randomBytes } from 'node:crypto';
import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
const MAX_CANCEL_TOKENS = 64;

/** Single-flight: one onboarding generate commits at a time in this process. */
let generateChain: Promise<unknown> = Promise.resolve();
let beforeIrCommitForTests: (() => void) | undefined;

export function isOnboardingGenerateCancelToken(token: string): boolean {
  return CANCEL_TOKEN_RE.test(token);
}

export function requestOnboardingGenerateCancel(token: string): void {
  if (!isOnboardingGenerateCancelToken(token)) return;
  cancelledTokens.add(token);
  if (cancelledTokens.size > MAX_CANCEL_TOKENS) {
    const first = cancelledTokens.values().next().value;
    if (first) cancelledTokens.delete(first);
  }
}

export function clearOnboardingGenerateCancel(token: string | undefined): void {
  if (token) cancelledTokens.delete(token);
}

export function setOnboardingGenerateBeforeCommitForTests(fn?: () => void): void {
  beforeIrCommitForTests = fn;
}

export function resetOnboardingGenerateForTests(): void {
  cancelledTokens.clear();
  generateChain = Promise.resolve();
  beforeIrCommitForTests = undefined;
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

/**
 * Atomic IR write that never mkdir-creates a missing subject dir.
 * Ingest `writeFileAtomic` mkdirSyncs and would resurrect a deleted id.
 */
function writeIrIfSubjectDirExists(irPath: string, body: string): void {
  const dir = path.dirname(irPath);
  if (!existsSync(dir)) {
    const error = new Error(`ENOENT: no such directory '${dir}'`);
    (error as NodeJS.ErrnoException).code = 'ENOENT';
    throw error;
  }
  const tmp = path.join(
    dir,
    `.${path.basename(irPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, irPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Temp may already be gone if rename succeeded then a later step failed.
    }
    throw error;
  }
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
 * cancel token / AbortSignal is still clear. Never emit / apply.
 * Cancel is wizard-side only — ingest generate/providers are not aborted.
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

  if (isGenerateCancelled(input.signal, input.cancelToken)) {
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

  try {
    const generated = await ingestGenerate.generateSubject({
      repoRoot: root,
      subject: target.subject,
      subjectDir: target.subjectDir,
      sources: target.sources,
      provider: input.provider,
      seed: input.seed,
      env: ingestGenerate.mergeRepoEnvFiles(root, process.env),
      // Ingest has no cancel hook — preview only; caller owns the IR write.
      dryRunIr: true,
    });
    if (isGenerateCancelled(input.signal, input.cancelToken)) {
      return cancelledResult();
    }
    // Re-check after the provider returns: delete/rename must not be
    // resurrected by a mkdir-creating write.
    if (!catalogHasSubject(root, subjectId) || !existsSync(target.subjectDir)) {
      return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
    }
    beforeIrCommitForTests?.();
    if (!catalogHasSubject(root, subjectId) || !existsSync(target.subjectDir)) {
      return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
    }
    writeIrIfSubjectDirExists(generated.irPath, stableJson(generated.bank));
    if (!catalogHasSubject(root, subjectId)) {
      return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
    }
    clearOnboardingGenerateCancel(input.cancelToken);
    return { ok: true, result: publicGenerateResult(subjectId, root, generated, true) };
  } catch (error) {
    if (isGenerateCancelled(input.signal, input.cancelToken)) {
      return cancelledResult();
    }
    if (isMissingPathError(error) || !catalogHasSubject(root, subjectId)) {
      return { ok: false, reason: 'missing', message: 'Subject is not in the wizard catalog.' };
    }
    return mapGenerateError(error);
  }
}
