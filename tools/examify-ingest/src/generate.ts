import path from 'node:path';
import { buildCacheKey, readCachedIr, writeCachedIr, writeRunManifest } from './cache';
import { stableJson } from './diff';
import { PAGE_RASTER_PROFILE, pageImageHashesOf, resolvePageImages, type PageImage } from './pages';
import { loadGeneratePrompt } from './prompt';
import {
  getProvider,
  hasUsableKey,
  throwIfAborted,
  type ProviderDeps,
  type ProviderEnv,
} from './providers';
import { writeFileAtomic } from './write-atomic';
import {
  GENERATE_TEMPERATURE,
  bankIrSchema,
  runManifestSchema,
  type BankIR,
  type BankIrSubject,
  type GenerateProviderId,
  type RunManifest,
} from './schema';
import { BANK_IR_FILE, sourceHashesOf, type GenerateTarget, type ResolvedSource } from './sources';
import { publicQuestionIds, splitIr } from './split';
import { validateIrCollection } from './validate';

export const NEXT_INGEST_COMMANDS = [
  'pnpm examify-ingest validate content/subjects',
  'pnpm examify-ingest emit content/subjects --dry-run',
  'pnpm examify-ingest emit content/subjects --apply',
] as const;

export type GenerateRequest = {
  repoRoot: string;
  subject: BankIrSubject;
  subjectDir: string;
  sources: readonly ResolvedSource[];
  provider: GenerateProviderId;
  model?: string;
  seed: number;
  dryRunIr?: boolean;
  env?: ProviderEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
};

export type GenerateSubjectResult = {
  bank: BankIR;
  cacheKey: string;
  cacheHit: boolean;
  manifest: RunManifest;
  manifestPath: string | null;
  irPath: string;
  wroteIr: boolean;
};

function attachMeta(
  bank: BankIR,
  request: GenerateRequest,
  sourceHashes: Record<string, string>,
  promptVersion: string,
): BankIR {
  return bankIrSchema.parse({
    ...bank,
    subject: request.subject,
    meta: {
      promptVersion,
      provider: request.provider,
      seed: request.seed,
      sourceHashes,
    },
  });
}

function assertValidBank(bank: BankIR, label: string): BankIR {
  const parsed = bankIrSchema.safeParse(bank);
  if (!parsed.success) {
    throw new Error(`${label} is not valid BankIR: ${parsed.error.message}`);
  }
  const result = validateIrCollection([{ path: label, data: parsed.data }]);
  if (!result.ok) {
    throw new Error(
      `${label} failed BankIR validate: ${result.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export async function generateSubject(request: GenerateRequest): Promise<GenerateSubjectResult> {
  if (request.sources.length === 0) {
    throw new Error(
      `no source files for ${request.subject.id} (looked in ${request.subjectDir} and content/source-pdfs/${request.subject.id})`,
    );
  }

  const env = request.env ?? {};
  const adapter = getProvider(request.provider);
  const persist = request.dryRunIr !== true;
  throwIfAborted(request.signal);

  const prompt = loadGeneratePrompt();
  const sourceHashes = sourceHashesOf(request.sources);
  const model = request.model?.trim() || adapter.defaultModel;
  const pageImages = resolvePageImages(request.repoRoot, request.sources, { persist });
  assertReadableProviderInput(request.provider, env, request.sources, pageImages);
  const pageImageHashes = pageImageHashesOf(pageImages);
  const cacheKey = buildCacheKey({
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    provider: request.provider,
    model,
    seed: request.seed,
    sourceHashes,
    subject: request.subject,
    pageImageHashes,
    pageRasterProfile: PAGE_RASTER_PROFILE,
  });

  let bank = readCachedIr(request.repoRoot, cacheKey);
  let cacheHit = bank !== null;
  if (bank) {
    bank = attachMeta(bank, request, sourceHashes, prompt.version);
    try {
      bank = assertValidBank(bank, `cached IR ${cacheKey}`);
    } catch {
      bank = null;
      cacheHit = false;
    }
  }

  if (!bank) {
    throwIfAborted(request.signal);
    adapter.requireReady(env);
    const deps: ProviderDeps = { env, fetch: request.fetch, signal: request.signal };
    const raw = await adapter.generate(
      {
        provider: request.provider,
        model,
        seed: request.seed,
        temperature: 0,
        prompt: prompt.text,
        promptVersion: prompt.version,
        subject: request.subject,
        sources: request.sources,
        pageImages,
      },
      deps,
    );
    bank = assertValidBank(
      attachMeta(raw, request, sourceHashes, prompt.version),
      `${request.provider} output`,
    );
    if (persist) writeCachedIr(request.repoRoot, cacheKey, bank);
  }

  const now = request.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const manifest = runManifestSchema.parse({
    provider: request.provider,
    model,
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    seed: request.seed,
    temperature: GENERATE_TEMPERATURE,
    sourceHashes,
    cacheKey,
    timestamp,
    subjectIds: [request.subject.id],
    cacheHit,
    hasApiKey: adapter.keyEnv ? hasUsableKey(env, adapter.keyEnv) : false,
    keyEnv: adapter.keyEnv,
    seedHonored: adapter.seedHonored,
  });

  throwIfAborted(request.signal);

  const irPath = path.join(request.subjectDir, BANK_IR_FILE);
  const wroteIr = persist;
  let manifestPath: string | null = null;
  if (persist) {
    manifestPath = writeRunManifest(request.repoRoot, cacheKey, timestamp, stableJson(manifest));
    writeFileAtomic(irPath, stableJson(bank));
  }

  return { bank, cacheKey, cacheHit, manifest, manifestPath, irPath, wroteIr };
}

/**
 * OpenAI-compatible chat cannot inline raw PDF bytes. Fail closed when the
 * only sources are PDFs and no page images (or text/image) are available.
 * Anthropic inlines PDFs; local CMD sends raw bytes; `--provider test` does not read files.
 */
export function assertReadableProviderInput(
  provider: GenerateProviderId,
  env: ProviderEnv,
  sources: readonly ResolvedSource[],
  pageImages: readonly PageImage[],
): void {
  if (provider === 'test' || provider === 'anthropic') return;
  if (pageImages.length > 0) return;
  if (sources.some((source) => source.kind === 'text' || source.kind === 'image')) return;
  if (provider === 'local' && (env.EXAMIFY_INGEST_LOCAL_CMD?.trim() ?? '')) return;
  throw new Error(
    'OpenAI-compatible generate cannot read PDF bytes; install pdftoppm so pages rasterize, or add a .txt/.md/.png source',
  );
}

export async function generateTargets(
  targets: readonly GenerateTarget[],
  options: Omit<GenerateRequest, 'subject' | 'subjectDir' | 'sources'> & {
    dryRunIr?: boolean;
  },
): Promise<GenerateSubjectResult[]> {
  const results: GenerateSubjectResult[] = [];
  for (const target of targets) {
    results.push(
      await generateSubject({
        ...options,
        subject: target.subject,
        subjectDir: target.subjectDir,
        sources: target.sources,
      }),
    );
  }
  return results;
}

/** Public split of generated IR — answers/rubrics/provenance stay out. */
export function publicSplitHasNoSecrets(bank: BankIR): boolean {
  const split = splitIr(bank);
  const publicJson = JSON.stringify(split.questions);
  return (
    !publicJson.includes('"answer"') &&
    !publicJson.includes('"rubric"') &&
    !publicJson.includes('"maxScore"') &&
    !publicJson.includes('"provenance"') &&
    publicQuestionIds(split).length > 0
  );
}
