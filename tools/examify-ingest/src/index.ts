export { FIXTURE_IDS, FIXTURE_ID_SET, type FixtureId } from './fixtures';
export { collectQuestionIds } from './ids';
export {
  bankIrSchema,
  runManifestSchema,
  DIFFICULTIES,
  SUBJECT_ID_RE,
  GENERATE_PROVIDERS,
  DEFAULT_GENERATE_SEED,
  GENERATE_TEMPERATURE,
  PROMPT_VERSION,
  INGEST_STATE_DIR,
  type AnswerKey,
  type BankIR,
  type BankIrItem,
  type DifficultyId,
  type GenerateProviderId,
  type PublicQuestion,
  type PublicQuestionBank,
  type RunManifest,
  type SplitIr,
} from './schema';
export { publicQuestionIds, splitIr } from './split';
export {
  validateIrCollection,
  type ValidateOptions,
  type ValidateResult,
  type ValidatedBank,
} from './validate';
export {
  findRepoRoot,
  isAuthoritativeCatalogInput,
  loadIrFiles,
  resolveIrFiles,
  type ResolveIrOptions,
} from './load';
export {
  applyEmit,
  collectGeneratedSubjectIds,
  formatEmitPlan,
  GENERATED_DIR,
  mergeGeneratedSubjects,
  planEmit,
  readGeneratedSubjects,
  reconcileGeneratedSubjects,
  type PlanEmitOptions,
  type PlannedFile,
} from './emit';
export { formatFileDiff, stableJson } from './diff';
export { parseArgs, runCli, runCliAsync, USAGE, type CliIo, type ParsedCli } from './cli';
export {
  generateSubject,
  generateTargets,
  NEXT_INGEST_COMMANDS,
  publicSplitHasNoSecrets,
  type GenerateRequest,
  type GenerateSubjectResult,
} from './generate';
export { buildCacheKey, ingestStateDir, irCachePath, readCachedIr } from './cache';
export { loadGeneratePrompt, findIngestPackageRoot, generatePromptPath } from './prompt';
export {
  resolveGenerateTargets,
  resolveSubjectSources,
  sourceHashesOf,
  defaultSubjectMeta,
  SOURCE_PDFS_REL,
  SUBJECTS_REL,
  BANK_IR_FILE,
  type GenerateTarget,
  type ResolvedSource,
} from './sources';
export { getProvider, ProviderConfigError } from './providers';
