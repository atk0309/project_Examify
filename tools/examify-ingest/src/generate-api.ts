/** Library + CLI entry for Phase 2 generate. Import from `examify-ingest/generate`. */
export {
  assertGenerateTargetsCanPersist,
  assertGenerateTargetsHaveSources,
  assertReadableProviderInput,
  generateSubject,
  generateTargets,
  NEXT_INGEST_COMMANDS,
  publicSplitHasNoSecrets,
  SampleIdCollisionError,
  sourcelessGenerateTargetIds,
  UnreadableSourcesError,
  type GenerateRequest,
  type GenerateSubjectResult,
} from './generate';
export { runCliAsync } from './generate-cli';
export { safeTempRoot } from './temp-root';
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
  BankIrCorruptError,
  BankIrOverwriteError,
  classifyBankIr,
  hasExistingBankIr,
  writeBankIrAtomic,
  writeFileAtomic,
  type BankIrPresence,
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
  loadSubjectMeta,
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
  AGENT_CLI_BIN_ENV,
  AGENT_CLI_SIGNIN_TIMEOUT_MS,
  agentCliHome,
  checkAgentCliSignIn,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
  type AgentCliSignIn,
  AGENT_CLI_MODEL_ENV,
  CLI_PROVIDER_TIMEOUT_MS,
  CliNotFoundError,
  GenerateAbortedError,
  LOCAL_MODEL_ENV,
  localTransportEnv,
  PROVIDER_TIMEOUT_MS,
  ProviderConfigError,
  ProviderFailureError,
  UNTRUSTED_SOURCE_NOTE,
  isAbortError,
  providerRequestSignal,
  throwIfAborted,
  resolveAgentCliBinary,
  runClaudeCliText,
  runCodexCliText,
  splitCommandLine,
  type AgentCli,
  type ClaudeCliTextRequest,
  type CodexCliTextRequest,
  type ProviderFailureKind,
} from './providers';
