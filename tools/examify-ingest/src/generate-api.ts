/** Library + CLI entry for Phase 2 generate. Import from `examify-ingest/generate`. */
export {
  assertReadableProviderInput,
  generateSubject,
  generateTargets,
  NEXT_INGEST_COMMANDS,
  publicSplitHasNoSecrets,
  type GenerateRequest,
  type GenerateSubjectResult,
} from './generate';
export { runCliAsync } from './generate-cli';
export {
  buildCacheKey,
  hashPageImageSet,
  ingestStateDir,
  irCachePath,
  readCachedIr,
} from './cache';
export { extractJsonObject } from './json';
export { PAGE_RASTER_PROFILE, pageImageHashesOf, resolvePageImages } from './pages';
export { sortRecord } from './hash';
export { writeFileAtomic } from './write-atomic';
export { mergeRepoEnvFiles, parseEnvFile } from './repo-env';
export { loadGeneratePrompt, findIngestPackageRoot, generatePromptPath } from './prompt';
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
  PROVIDER_TIMEOUT_MS,
  ProviderConfigError,
  UNTRUSTED_SOURCE_NOTE,
  splitCommandLine,
} from './providers';
