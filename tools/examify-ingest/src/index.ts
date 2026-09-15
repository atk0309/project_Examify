export { FIXTURE_IDS, FIXTURE_ID_SET, type FixtureId } from './fixtures';
export { collectQuestionIds } from './ids';
export {
  bankIrSchema,
  DIFFICULTIES,
  SUBJECT_ID_RE,
  type AnswerKey,
  type BankIR,
  type BankIrItem,
  type DifficultyId,
  type PublicQuestion,
  type PublicQuestionBank,
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
export { parseArgs, runCli, USAGE, type CliIo, type ParsedCli } from './cli';
