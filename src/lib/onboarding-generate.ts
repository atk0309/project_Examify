import 'server-only';

import path from 'node:path';
import {
  generateSubject,
  mergeRepoEnvFiles,
  ProviderConfigError,
  resolveGenerateTargets,
} from 'examify-ingest/generate';
import { getOnboardingContentRoot } from '@/lib/content-root';
import { isValidSubjectId, normalizeSubjectId, SUBJECTS_REL } from '@/lib/onboarding';
import type { OnboardingGenerateProvider, OnboardingGenerateResult } from '@/lib/onboarding-types';

export type GenerateOnboardingError = {
  ok: false;
  reason: 'invalid_id' | 'missing' | 'missing_key' | 'missing_local' | 'empty_sources' | 'invalid';
  message: string;
};

export type GenerateOnboardingSuccess = {
  ok: true;
  result: OnboardingGenerateResult;
};

function posixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

function mapGenerateError(error: unknown): GenerateOnboardingError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderConfigError) {
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
  generated: Awaited<ReturnType<typeof generateSubject>>,
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
    wroteIr: generated.wroteIr,
    irRel: posixRel(root, generated.irPath),
  };
}

/**
 * Draft BankIR for one subject via `examify-ingest/generate`.
 * Writes `content/subjects/<id>/bank.ir.json` only — never emit / apply.
 * The returned payload is public progress metadata (no answers / keys / IR).
 */
export async function generateOnboardingSubject(input: {
  subjectId: string;
  provider: OnboardingGenerateProvider;
  seed: number;
  root?: string;
}): Promise<GenerateOnboardingSuccess | GenerateOnboardingError> {
  const subjectId = normalizeSubjectId(input.subjectId);
  if (!isValidSubjectId(subjectId)) {
    return { ok: false, reason: 'invalid_id', message: 'Subject id must be kebab-case.' };
  }

  const root = input.root ?? getOnboardingContentRoot();
  const subjectInput = path.join(SUBJECTS_REL, subjectId);
  let target;
  try {
    const targets = resolveGenerateTargets([subjectInput], root, root, subjectId);
    target = targets[0];
  } catch (error) {
    return mapGenerateError(error);
  }
  if (!target) return { ok: false, reason: 'missing', message: `no generate subject ${subjectId}` };

  try {
    const generated = await generateSubject({
      repoRoot: root,
      subject: target.subject,
      subjectDir: target.subjectDir,
      sources: target.sources,
      provider: input.provider,
      seed: input.seed,
      env: mergeRepoEnvFiles(root, process.env),
    });
    return { ok: true, result: publicGenerateResult(subjectId, root, generated) };
  } catch (error) {
    return mapGenerateError(error);
  }
}
