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
  constructor(irPath: string, message?: string) {
    super(message ?? `refusing to overwrite existing ${irPath}; pass --force to replace it`);
    this.name = 'BankIrOverwriteError';
    this.irPath = irPath;
  }
}

/** Corrupt / unreadable IR is overwrite-protected; message names corruption. */
export class BankIrCorruptError extends BankIrOverwriteError {
  readonly reason: BankIrCorruptReason;
  constructor(irPath: string, reason: BankIrCorruptReason) {
    super(
      irPath,
      `refusing to overwrite corrupt ${irPath} (${reason}); pass --force to replace it`,
    );
    this.name = 'BankIrCorruptError';
    this.reason = reason;
  }
}

export type WriteBankIrOptions = {
  force?: boolean;
  /** Path shown in the overwrite error (repo-relative when the caller has it). */
  displayPath?: string;
};

export const BANK_IR_CORRUPT_REASONS = [
  'unreadable',
  'unparseable JSON',
  'invalid BankIR schema',
] as const;
export type BankIrCorruptReason = (typeof BANK_IR_CORRUPT_REASONS)[number];

export type BankIrPresence =
  | { kind: 'missing' }
  | { kind: 'placeholder' }
  | { kind: 'existing' }
  | { kind: 'corrupt'; reason: BankIrCorruptReason };

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Classify `bank.ir.json` for the overwrite gate.
 * Empty file / valid zero-item IR → placeholder (non-existing).
 * Unreadable / unparseable / invalid schema → corrupt (requires --force).
 * Schema-valid IR with questions → existing (requires --force).
 * Onboarding should use this (or assertCanWriteBankIr) instead of existsSync.
 */
export function classifyBankIr(absPath: string): BankIrPresence {
  if (!existsSync(absPath)) return { kind: 'missing' };
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return { kind: 'missing' };
    return { kind: 'corrupt', reason: 'unreadable' };
  }
  if (raw.trim() === '') return { kind: 'placeholder' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'corrupt', reason: 'unparseable JSON' };
  }
  const result = bankIrSchema.safeParse(parsed);
  if (!result.success) return { kind: 'corrupt', reason: 'invalid BankIR schema' };
  const hasItems = DIFFICULTIES.some(
    (difficulty) => result.data.difficulties[difficulty].length > 0,
  );
  return hasItems ? { kind: 'existing' } : { kind: 'placeholder' };
}

/**
 * True when the overwrite gate treats the path as present (real IR or corrupt).
 * Empty / placeholder IR is false so first generate does not need `--force`.
 */
export function hasExistingBankIr(absPath: string): boolean {
  const kind = classifyBankIr(absPath).kind;
  return kind === 'existing' || kind === 'corrupt';
}

/**
 * Shared persist gate for `bank.ir.json`. CLI generate persist uses this.
 * Onboarding IR commit should call writeBankIrAtomic(path, body, { force })
 * with force from user confirm (no confirm UI here).
 */
export function assertCanWriteBankIr(absPath: string, options: WriteBankIrOptions = {}): boolean {
  const presence = classifyBankIr(absPath);
  const existed = presence.kind === 'existing' || presence.kind === 'corrupt';
  if (existed && options.force !== true) {
    const display = options.displayPath ?? absPath;
    if (presence.kind === 'corrupt') {
      throw new BankIrCorruptError(display, presence.reason);
    }
    throw new BankIrOverwriteError(display);
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
