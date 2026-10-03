import 'server-only';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import type { loadIrFiles } from 'examify-ingest';
import { isFamilyWritePathSafe } from '@/lib/content-root';

export const MAX_ONBOARDING_IR_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ONBOARDING_IR_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_ONBOARDING_IR_DIRECTORY_ENTRIES = 1024;

type LoadedIrFile = ReturnType<typeof loadIrFiles>[number];
type ReadRoot = { base: string; real: string };
type DirectorySnapshot = { path: string; stats: Stats };

const UNSAFE_PATH =
  'Question drafts must be regular files in real folders inside the family data folder.';
const UNREADABLE =
  'Question drafts could not be read safely. Check the subject files and try again.';
const CHANGED = 'Question drafts changed while being read. Try again.';
const INVALID_JSON = 'A question draft contains invalid JSON. Check the draft and try again.';
const FILE_TOO_LARGE = 'A question draft exceeds the 2 MiB web review limit.';
const TOTAL_TOO_LARGE = 'Question drafts exceed the 8 MiB web review limit.';
const TOO_MANY_ENTRIES = 'The subjects folder contains too many entries for web review.';

/** Only fixed, browser-safe messages may escape this reader, including filesystem failures. */
class OnboardingIrReadError extends Error {}

function fail(message: string): never {
  throw new OnboardingIrReadError(message);
}

function isInside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function checkedStat(root: ReadRoot, target: string, allowMissing = false): Stats | null {
  if (
    realpathSync(root.base) !== root.real ||
    !isInside(root.base, target) ||
    !isFamilyWritePathSafe(root.base, target)
  ) {
    fail(UNSAFE_PATH);
  }
  let stats: Stats;
  try {
    // lstat deliberately distinguishes a missing draft from a dangling link.
    stats = lstatSync(target);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !isInside(root.real, realpathSync(target))) fail(UNSAFE_PATH);
  return stats;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function directory(root: ReadRoot, target: string): DirectorySnapshot | null {
  const stats = checkedStat(root, target, true);
  if (stats === null) return null;
  if (!stats.isDirectory()) fail(UNSAFE_PATH);
  return { path: target, stats };
}

function recheckDirectories(root: ReadRoot, snapshots: readonly DirectorySnapshot[]): void {
  for (const snapshot of snapshots) {
    const current = checkedStat(root, snapshot.path);
    if (!current?.isDirectory() || !unchanged(snapshot.stats, current)) fail(CHANGED);
  }
}

function checkSize(size: number, remainingBytes: number): void {
  if (size > MAX_ONBOARDING_IR_FILE_BYTES) fail(FILE_TOO_LARGE);
  if (size > remainingBytes) fail(TOTAL_TOO_LARGE);
}

function readDraft(
  root: ReadRoot,
  directories: readonly DirectorySnapshot[],
  filePath: string,
  remainingBytes: number,
): { file: LoadedIrFile; bytes: number } | null {
  recheckDirectories(root, directories);
  const before = checkedStat(root, filePath, true);
  if (before === null) {
    recheckDirectories(root, directories);
    return null;
  }
  if (!before.isFile()) fail(UNSAFE_PATH);
  checkSize(before.size, remainingBytes);

  // O_NOFOLLOW protects the final component where supported. O_NONBLOCK avoids
  // hanging on a FIFO swapped in after lstat; fstat rejects every nonregular file.
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  let bytes = 0;
  let raw: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) fail(UNSAFE_PATH);
    checkSize(opened.size, remainingBytes);
    recheckDirectories(root, directories);
    const current = checkedStat(root, filePath);
    if (!current?.isFile() || !unchanged(opened, current)) fail(CHANGED);

    // Read one byte beyond the allowed budget to detect growth without ever
    // allocating or reading an unbounded file. No partial bank is returned.
    const limit = Math.min(MAX_ONBOARDING_IR_FILE_BYTES, remainingBytes);
    raw = Buffer.allocUnsafe(Math.min(opened.size, limit) + 1);
    while (bytes < raw.length) {
      const count = readSync(descriptor, raw, bytes, raw.length - bytes, bytes);
      if (count === 0) break;
      bytes += count;
      checkSize(bytes, remainingBytes);
    }
    if (bytes !== opened.size || !unchanged(opened, fstatSync(descriptor))) fail(CHANGED);
    recheckDirectories(root, directories);
    const after = checkedStat(root, filePath);
    if (!after?.isFile() || !unchanged(opened, after)) fail(CHANGED);
  } finally {
    closeSync(descriptor);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw.subarray(0, bytes).toString('utf8')) as unknown;
  } catch {
    fail(INVALID_JSON);
  }
  return { file: { path: filePath, data }, bytes };
}

/**
 * Read only immediate content/subjects/<directory>/bank.ir.json drafts beneath
 * the already-vetted family root. Missing directories/drafts return no files,
 * preserving the caller's empty-catalog / explicit prune-only handling.
 *
 * Ancestry and inode rechecks reduce path-swap races; portable Node path APIs do
 * not provide a full openat-style, OS-level race-free directory traversal.
 */
export function loadOnboardingIrFiles(root: string): LoadedIrFile[] {
  try {
    const base = path.resolve(root);
    const anchor: ReadRoot = { base, real: realpathSync(base) };
    const content = directory(anchor, path.join(base, 'content'));
    if (content === null) return [];
    const subjects = directory(anchor, path.join(content.path, 'subjects'));
    if (subjects === null) {
      recheckDirectories(anchor, [content]);
      return [];
    }
    const snapshots = [content, subjects];
    recheckDirectories(anchor, snapshots);
    const directoryHandle = opendirSync(subjects.path);
    const names: string[] = [];
    try {
      let entry;
      while ((entry = directoryHandle.readSync()) !== null) {
        if (names.length >= MAX_ONBOARDING_IR_DIRECTORY_ENTRIES) fail(TOO_MANY_ENTRIES);
        // Do not silently skip linked subjects, including dangling links.
        if (entry.isSymbolicLink()) fail(UNSAFE_PATH);
        names.push(entry.name);
      }
    } finally {
      directoryHandle.closeSync();
    }
    recheckDirectories(anchor, snapshots);

    const files: LoadedIrFile[] = [];
    let totalBytes = 0;
    for (const name of names.sort()) {
      const subjectPath = path.join(subjects.path, name);
      const stats = checkedStat(anchor, subjectPath);
      if (!stats?.isDirectory()) continue;
      const subject = { path: subjectPath, stats };
      snapshots.push(subject);
      const loaded = readDraft(
        anchor,
        [content, subjects, subject],
        path.join(subjectPath, 'bank.ir.json'),
        MAX_ONBOARDING_IR_TOTAL_BYTES - totalBytes,
      );
      if (loaded !== null) {
        files.push(loaded.file);
        totalBytes += loaded.bytes;
      }
    }
    recheckDirectories(anchor, snapshots);
    return files;
  } catch (error) {
    if (error instanceof OnboardingIrReadError) throw error;
    fail(UNREADABLE);
  }
}
