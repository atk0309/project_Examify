import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatFileDiff, stableJson } from './diff';
import type { ValidatedBank } from './validate';

export const GENERATED_DIR = 'content/generated';

export type PlannedFile = {
  relPath: string;
  absPath: string;
  contents: string;
  existing: string | null;
};

function readExisting(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Plan the public/server-only JSON files for a validated IR collection. */
export function planEmit(banks: readonly ValidatedBank[], repoRoot: string): PlannedFile[] {
  const subjects = banks.map((entry) => entry.split.subject);
  const files: PlannedFile[] = [];

  const push = (relPath: string, value: unknown) => {
    const absPath = path.join(repoRoot, relPath);
    files.push({
      relPath,
      absPath,
      contents: stableJson(value),
      existing: readExisting(absPath),
    });
  };

  push(`${GENERATED_DIR}/subjects.json`, subjects);

  for (const entry of banks) {
    const id = entry.split.subject.id;
    push(`${GENERATED_DIR}/questions/${id}.json`, entry.split.questions);
    push(`${GENERATED_DIR}/keys/${id}.json`, entry.split.keys);
  }

  return files;
}

export function formatEmitPlan(files: readonly PlannedFile[]): string {
  return files
    .map((file) => formatFileDiff(file.relPath, file.existing, file.contents))
    .join('\n\n');
}

export function applyEmit(files: readonly PlannedFile[]): PlannedFile[] {
  const written: PlannedFile[] = [];
  for (const file of files) {
    if (file.existing === file.contents) continue;
    mkdirSync(path.dirname(file.absPath), { recursive: true });
    writeFileSync(file.absPath, file.contents, 'utf8');
    written.push(file);
  }
  return written;
}
