/** Library + CLI entry for Phase 2 generate. Import from `examify-ingest/generate`. */
export {
  assertGenerateTargetsCanPersist,
  assertGenerateTargetsHaveSources,
  assertReadableProviderInput,
  generateSubject,
  generateTargets,
  NEXT_INGEST_COMMANDS,
  publicSplitHasNoSecrets,
  sourcelessGenerateTargetIds,
  type GenerateRequest,
  type GenerateSubjectResult,
} from './generate';
export { runCliAsync } from './generate-cli';
export { buildCacheKey, ingestStateDir, irCachePath, readCachedIr } from './cache';
export { extractJsonObject } from './json';
export {
  PAGE_RASTER_PROFILE,
  pageImageHashesOf,
  persistPageImages,
  resolvePageImages,
} from './pages';
export { sortRecord } from './hash';
export {
  assertCanWriteBankIr,
  BankIrOverwriteError,
  writeBankIrAtomic,
  writeFileAtomic,
  type WriteBankIrOptions,
} from './write-atomic';
export { mergeRepoEnvFiles, parseEnvFile } from './repo-env';
export { loadGeneratePrompt, findIngestPackageRoot, generatePromptPath } from './prompt';
export { sampleBankFrozenIds } from './frozen-ids';
export {
  resolveGenerateTargets,
  resolveSubjectSources,
  sourceHashesOf,
  defaultSubjectMeta,
  isAllowedSourceRel,
  hasStandaloneSourceFile,
  SOURCE_EXT,
  SOURCE_PDFS_REL,
  SUBJECTS_REL,
  BANK_IR_FILE,
  type GenerateTarget,
  type ResolvedSource,
} from './sources';
export {
  getProvider,
  GenerateAbortedError,
  PROVIDER_TIMEOUT_MS,
  ProviderConfigError,
  UNTRUSTED_SOURCE_NOTE,
  isAbortError,
  providerRequestSignal,
  throwIfAborted,
  splitCommandLine,
} from './providers';
