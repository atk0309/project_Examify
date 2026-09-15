export { FIXTURE_IDS, FIXTURE_ID_SET, type FixtureId } from './fixtures';
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
export { findRepoRoot, loadIrFiles, resolveIrFiles } from './load';
export { applyEmit, formatEmitPlan, GENERATED_DIR, planEmit, type PlannedFile } from './emit';
export { formatFileDiff, stableJson } from './diff';
export { parseArgs, runCli, USAGE, type CliIo, type ParsedCli } from './cli';
