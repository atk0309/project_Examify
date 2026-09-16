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

/**
 * Wizard add used to write an empty-difficulties `bank.ir.json`. That
 * placeholder (or a blank file) is not real content — overwrite / confirm
 * must not treat it as existing BankIR.
 */
export function isPlaceholderBankIr(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const difficulties = (value as { difficulties?: unknown }).difficulties;
  if (!difficulties || typeof difficulties !== 'object' || Array.isArray(difficulties)) {
    return false;
  }
  const lists = Object.values(difficulties as Record<string, unknown>);
  if (lists.length === 0) return true;
  return lists.every((list) => Array.isArray(list) && list.length === 0);
}

/** True when `bank.ir.json` has real content that overwrite must protect. */
export function isExistingBankIr(absPath: string): boolean {
  if (!existsSync(absPath)) return false;
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return true;
  }
  if (raw.trim() === '') return false;
  try {
    return !isPlaceholderBankIr(JSON.parse(raw) as unknown);
  } catch {
    return true;
  }
}

/**
 * Shared persist gate for `bank.ir.json`. CLI generate persist uses this.
 * Onboarding IR commit should call writeBankIrAtomic(path, body, { force })
 * with force from user confirm (no confirm UI here). Empty / placeholder
 * IR does not require force.
 */
export function assertCanWriteBankIr(absPath: string, options: WriteBankIrOptions = {}): boolean {
  const existed = isExistingBankIr(absPath);
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
