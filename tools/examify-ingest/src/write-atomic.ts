import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * Shared persist gate for `bank.ir.json`. CLI generate persist uses this.
 * Onboarding IR commit should call writeBankIrAtomic(path, body, { force })
 * with force from user confirm (no confirm UI here).
 */
export function assertCanWriteBankIr(absPath: string, options: WriteBankIrOptions = {}): boolean {
  const existed = existsSync(absPath);
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
