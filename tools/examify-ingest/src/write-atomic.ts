import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { DIFFICULTIES, bankIrSchema } from './schema';

/** Thrown when persist would clobber existing `bank.ir.json` without `force`. */
export class BankIrOverwriteError extends Error {
  readonly irPath: string;
  constructor(irPath: string) {
    super(`refusing to overwrite existing ${irPath}; pass --force to replace it`);
    this.name = 'BankIrOverwriteError';
    this.irPath = irPath;
  }
}

export type WriteBankIrOptions = {
  force?: boolean;
  /** Path shown in the overwrite error (repo-relative when the caller has it). */
  displayPath?: string;
};

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * True only for a schema-valid BankIR that already has at least one question.
 * Empty files, `{}`, schema-fail JSON, and zero-item placeholders are
 * non-existing for the overwrite gate (first real generate must not need
 * `--force`). Unreadable files fail closed (treated as existing).
 * Onboarding should use this (or assertCanWriteBankIr) instead of existsSync.
 */
export function hasExistingBankIr(absPath: string): boolean {
  if (!existsSync(absPath)) return false;
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return false;
    return true;
  }
  if (raw.trim() === '') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  const result = bankIrSchema.safeParse(parsed);
  if (!result.success) return false;
  return DIFFICULTIES.some((difficulty) => result.data.difficulties[difficulty].length > 0);
}

/**
 * Shared persist gate for `bank.ir.json`. CLI generate persist uses this.
 * Onboarding IR commit should call writeBankIrAtomic(path, body, { force })
 * with force from user confirm (no confirm UI here).
 */
export function assertCanWriteBankIr(absPath: string, options: WriteBankIrOptions = {}): boolean {
  const existed = hasExistingBankIr(absPath);
  if (existed && options.force !== true) {
    throw new BankIrOverwriteError(options.displayPath ?? absPath);
  }
  return existed;
}

/** Atomic IR write that refuses to clobber unless `force` is true. */
export function writeBankIrAtomic(
  absPath: string,
  contents: string,
  options: WriteBankIrOptions = {},
): { existed: boolean } {
  const existed = assertCanWriteBankIr(absPath, options);
  writeFileAtomic(absPath, contents);
  return { existed };
}

/** Write `body` via a sibling temp file, then rename over `absPath`. */
export function writeFileAtomic(absPath: string, body: string): void {
  const dir = path.dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(absPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, absPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may already be gone if rename succeeded then a later step failed.
    }
    throw error;
  }
}
