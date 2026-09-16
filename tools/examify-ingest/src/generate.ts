import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildCacheKey, readCachedIr, writeCachedIr, writeRunManifest } from './cache';
import { stableJson } from './diff';
import { sampleBankFrozenIds } from './frozen-ids';
import {
  PAGE_RASTER_PROFILE,
  pageImageHashesOf,
  persistPageImages,
  resolvePageImages,
  type PageImage,
} from './pages';
import { loadGeneratePrompt } from './prompt';
import {
  getProvider,
  hasUsableKey,
  throwIfAborted,
  type ProviderDeps,
  type ProviderEnv,
} from './providers';
import { assertCanWriteBankIr, writeBankIrAtomic } from './write-atomic';
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
  now?: () => Date;
  /** Overwrite an existing `bank.ir.json`. Required for persist when the file exists. */
  force?: boolean;
  /** Allow generated ids that collide with the sample bank (same set as validate/emit). */
  replaceSample?: boolean;
  /** Override the frozen sample-bank id set. Defaults to `sampleBankFrozenIds()`. */
  frozenIds?: Iterable<string>;
  /** Test seam — same hook as `resolvePageImages`. Durable page cache waits for abort. */
  rasterize?: (pdfAbsPath: string, prefix: string) => boolean;
  /**
   * Combined with the 180s provider deadline. Abort writes no IR, IR cache,
   * page-raster cache, or run manifest.
   */
  signal?: AbortSignal;
};

export type GenerateSubjectResult = {
  bank: BankIR;
  cacheKey: string;
  cacheHit: boolean;
  manifest: RunManifest;
  manifestPath: string | null;
  irPath: string;
  wroteIr: boolean;
  irExisted: boolean;
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

function pathFromRoot(repoRoot: string, absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join('/') || absPath;
}

function assertNotFrozenSampleIds(bank: BankIR, label: string, request: GenerateRequest): void {
  const result = validateIrCollection([{ path: label, data: bank }], {
    replaceSample: request.replaceSample === true,
    frozenIds: request.frozenIds ?? sampleBankFrozenIds(),
  });
  if (!result.ok) {
    throw new Error(
      `${label} failed sample-bank freeze: ${result.errors.map((error) => error.message).join('; ')}`,
    );
  }
}

async function checkpointAbort(signal?: AbortSignal): Promise<void> {
  if (signal) await Promise.resolve();
  throwIfAborted(signal);
}

export async function generateSubject(request: GenerateRequest): Promise<GenerateSubjectResult> {
  await checkpointAbort(request.signal);
  if (request.sources.length === 0) {
    throw new Error(
      `no source files for ${request.subject.id} (looked in ${request.subjectDir} and content/source-pdfs/${request.subject.id})`,
    );
  }

  const env = request.env ?? {};
  const adapter = getProvider(request.provider);
  const persist = request.dryRunIr !== true;
  const irPath = path.join(request.subjectDir, BANK_IR_FILE);
  const displayPath = pathFromRoot(request.repoRoot, irPath);
  const irExisted = existsSync(irPath);
  if (persist) {
    assertCanWriteBankIr(irPath, { force: request.force === true, displayPath });
  }

  const prompt = loadGeneratePrompt();
  const sourceHashes = sourceHashesOf(request.sources);
  const model = request.model?.trim() || adapter.defaultModel;
  // Rasterize in temp (or reuse existing page cache). Durable page writes wait
  // for the same final abort gate as IR / IR cache / manifest.
  const pageImages = resolvePageImages(request.repoRoot, request.sources, {
    persist: false,
    rasterize: request.rasterize,
  });
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

  await checkpointAbort(request.signal);

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

  await checkpointAbort(request.signal);

  if (!bank) {
    adapter.requireReady(env);
    const deps: ProviderDeps = { env, fetch: request.fetch, signal: request.signal };
    let raw;
    try {
      raw = await adapter.generate(
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
    } catch (error) {
      throwIfAborted(request.signal);
      throw error;
    }
    await checkpointAbort(request.signal);
    bank = assertValidBank(
      attachMeta(raw, request, sourceHashes, prompt.version),
      `${request.provider} output`,
    );
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

  await checkpointAbort(request.signal);
  assertNotFrozenSampleIds(bank, pathFromRoot(request.repoRoot, irPath), request);
  const wroteIr = persist;
  let manifestPath: string | null = null;
  if (persist) {
    persistPageImages(request.repoRoot, request.sources, pageImages);
    writeCachedIr(request.repoRoot, cacheKey, bank);
    manifestPath = writeRunManifest(request.repoRoot, cacheKey, timestamp, stableJson(manifest));
    writeBankIrAtomic(irPath, stableJson(bank), {
      force: request.force === true,
      displayPath,
    });
  }

  return { bank, cacheKey, cacheHit, manifest, manifestPath, irPath, wroteIr, irExisted };
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

/** Subject ids in this run that have no generate sources. */
export function sourcelessGenerateTargetIds(
  targets: readonly Pick<GenerateTarget, 'subjectId' | 'sources'>[],
): string[] {
  return targets.filter((target) => target.sources.length === 0).map((target) => target.subjectId);
}

/**
 * Preflight every target for sources before any IR write. Tree generate of
 * A/B/C plus empty sibling D must fail closed and write nothing.
 */
export function assertGenerateTargetsHaveSources(
  targets: readonly Pick<GenerateTarget, 'subjectId' | 'sources'>[],
): void {
  const missing = sourcelessGenerateTargetIds(targets);
  if (missing.length === 0) return;
  throw new Error(
    `no source files for ${missing.join(', ')} (looked in each subject folder and content/source-pdfs/<id>); no BankIR written`,
  );
}

/** Persist-only: existing IR without force fails before any generate write. */
export function assertGenerateTargetsCanPersist(
  repoRoot: string,
  targets: readonly GenerateTarget[],
  force: boolean,
): void {
  if (force) return;
  const existing = targets
    .filter((target) => existsSync(path.join(target.subjectDir, BANK_IR_FILE)))
    .map((target) => pathFromRoot(repoRoot, path.join(target.subjectDir, BANK_IR_FILE)));
  if (existing.length === 0) return;
  throw new Error(
    `refusing to overwrite existing ${existing.join(', ')}; pass --force to replace it; no BankIR written`,
  );
}

function commitGeneratedDraft(
  draft: GenerateSubjectResult,
  target: GenerateTarget,
  options: Omit<GenerateRequest, 'subject' | 'subjectDir' | 'sources'>,
): GenerateSubjectResult {
  const pageImages = resolvePageImages(options.repoRoot, target.sources, {
    persist: true,
    rasterize: options.rasterize,
  });
  persistPageImages(options.repoRoot, target.sources, pageImages);
  writeCachedIr(options.repoRoot, draft.cacheKey, draft.bank);
  const manifestPath = writeRunManifest(
    options.repoRoot,
    draft.cacheKey,
    draft.manifest.timestamp,
    stableJson(draft.manifest),
  );
  writeBankIrAtomic(draft.irPath, stableJson(draft.bank), {
    force: options.force === true,
    displayPath: pathFromRoot(options.repoRoot, draft.irPath),
  });
  return { ...draft, wroteIr: true, manifestPath };
}

/**
 * Tree generate is all-or-nothing for BankIR: sources + overwrite preflight,
 * then every subject is drafted (`dryRunIr`) so SAMPLE freeze / provider
 * failures happen before the first IR write. Only then are IRs committed.
 */
export async function generateTargets(
  targets: readonly GenerateTarget[],
  options: Omit<GenerateRequest, 'subject' | 'subjectDir' | 'sources'> & {
    dryRunIr?: boolean;
  },
): Promise<GenerateSubjectResult[]> {
  assertGenerateTargetsHaveSources(targets);
  if (options.dryRunIr !== true) {
    assertGenerateTargetsCanPersist(options.repoRoot, targets, options.force === true);
  }

  const drafts: GenerateSubjectResult[] = [];
  for (const target of targets) {
    drafts.push(
      await generateSubject({
        ...options,
        subject: target.subject,
        subjectDir: target.subjectDir,
        sources: target.sources,
        dryRunIr: true,
      }),
    );
  }

  if (options.dryRunIr === true) {
    return drafts;
  }

  const committed: GenerateSubjectResult[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    await checkpointAbort(options.signal);
    committed.push(commitGeneratedDraft(drafts[i]!, targets[i]!, options));
  }
  return committed;
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
