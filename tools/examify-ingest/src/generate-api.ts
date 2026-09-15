/** Library + CLI entry for Phase 2 generate. Import from `examify-ingest/generate`. */
export {
  generateSubject,
  generateTargets,
  NEXT_INGEST_COMMANDS,
  publicSplitHasNoSecrets,
  type GenerateRequest,
  type GenerateSubjectResult,
} from './generate';
export { runCliAsync } from './generate-cli';
export { buildCacheKey, ingestStateDir, irCachePath, readCachedIr } from './cache';
export { loadGeneratePrompt, findIngestPackageRoot, generatePromptPath } from './prompt';
export {
  resolveGenerateTargets,
  resolveSubjectSources,
  sourceHashesOf,
  defaultSubjectMeta,
  isAllowedSourceRel,
  SOURCE_PDFS_REL,
  SUBJECTS_REL,
  BANK_IR_FILE,
  type GenerateTarget,
  type ResolvedSource,
} from './sources';
export {
  getProvider,
  ProviderConfigError,
  UNTRUSTED_SOURCE_NOTE,
  splitCommandLine,
} from './providers';
