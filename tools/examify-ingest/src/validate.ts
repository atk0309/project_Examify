import { FIXTURE_ID_SET } from './fixtures';
import { bankIrSchema, DIFFICULTIES, type BankIR, type DifficultyId } from './schema';
import type { SplitIr } from './schema';
import { publicQuestionIds, splitIr } from './split';

export type ValidateOptions = {
  replaceSample?: boolean;
};

export type ValidateIssue = {
  path?: string;
  message: string;
};

export type ValidatedBank = {
  sourcePath: string;
  bank: BankIR;
  split: SplitIr;
};

export type ValidateSuccess = { ok: true; banks: ValidatedBank[] };
export type ValidateFailure = { ok: false; errors: ValidateIssue[] };
export type ValidateResult = ValidateSuccess | ValidateFailure;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function idPattern(subjectId: string, difficulty: DifficultyId, type: 'mcq' | 'free'): RegExp {
  const prefix = `${escapeRegExp(subjectId)}-${difficulty}`;
  return type === 'mcq' ? new RegExp(`^${prefix}-\\d+$`) : new RegExp(`^${prefix}-free-\\d+$`);
}

function issuesForBank(
  sourcePath: string,
  data: unknown,
): { bank?: BankIR; errors: ValidateIssue[] } {
  const parsed = bankIrSchema.safeParse(data);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((issue) => ({
        path: sourcePath,
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      })),
    };
  }

  const bank = parsed.data;
  const errors: ValidateIssue[] = [];
  const seen = new Set<string>();
  const subjectId = bank.subject.id;

  for (const difficulty of DIFFICULTIES) {
    for (const item of bank.difficulties[difficulty]) {
      if (!item.id.startsWith(`${subjectId}-`)) {
        errors.push({
          path: sourcePath,
          message: `id ${item.id} must start with subject id "${subjectId}-"`,
        });
      }
      const pattern = idPattern(subjectId, difficulty, item.type);
      if (!pattern.test(item.id)) {
        const expected =
          item.type === 'mcq'
            ? `${subjectId}-${difficulty}-{n}`
            : `${subjectId}-${difficulty}-free-{n}`;
        errors.push({
          path: sourcePath,
          message: `id ${item.id} must match ${expected}`,
        });
      }
      if (seen.has(item.id)) {
        errors.push({
          path: sourcePath,
          message: `duplicate id ${item.id} within this IR file`,
        });
      }
      seen.add(item.id);
    }
  }

  return { bank, errors };
}

/** Validate one or more BankIR documents, including cross-file id uniqueness. */
export function validateIrCollection(
  files: readonly { path: string; data: unknown }[],
  options: ValidateOptions = {},
): ValidateResult {
  const errors: ValidateIssue[] = [];
  const banks: ValidatedBank[] = [];
  const subjectIds = new Map<string, string>();
  const questionIds = new Map<string, string>();

  if (files.length === 0) {
    return { ok: false, errors: [{ message: 'no BankIR files to validate' }] };
  }

  for (const file of files) {
    const { bank, errors: fileErrors } = issuesForBank(file.path, file.data);
    errors.push(...fileErrors);
    if (!bank) continue;

    const existingSubject = subjectIds.get(bank.subject.id);
    if (existingSubject) {
      errors.push({
        path: file.path,
        message: `duplicate subject id "${bank.subject.id}" (also in ${existingSubject})`,
      });
    } else {
      subjectIds.set(bank.subject.id, file.path);
    }

    const split = splitIr(bank);
    for (const id of publicQuestionIds(split)) {
      const existing = questionIds.get(id);
      if (existing) {
        errors.push({
          path: file.path,
          message: `duplicate question id "${id}" (also in ${existing})`,
        });
      } else {
        questionIds.set(id, file.path);
      }

      if (FIXTURE_ID_SET.has(id) && !options.replaceSample) {
        errors.push({
          path: file.path,
          message: `id "${id}" collides with a frozen sample fixture; pass --replace-sample to overwrite`,
        });
      }
    }

    banks.push({ sourcePath: file.path, bank, split });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, banks };
}
