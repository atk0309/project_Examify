import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatFileDiff, stableJson } from './diff';
import { renderGeneratedKeys, renderGeneratedPublic } from './registrars';
import { subjectSchema, type BankIrSubject } from './schema';
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

export function readGeneratedSubjects(repoRoot: string): BankIrSubject[] {
  const raw = readExisting(path.join(repoRoot, GENERATED_DIR, 'subjects.json'));
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read generated subject catalog: ${message}`);
  }
  const result = subjectSchema.array().safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid generated subject catalog: ${result.error.message}`);
  }
  return result.data;
}

/** Upsert this run's subjects; keep on-disk subjects that are not in this run. */
export function mergeGeneratedSubjects(
  existing: readonly BankIrSubject[],
  incoming: readonly BankIrSubject[],
): BankIrSubject[] {
  const incomingById = new Map(incoming.map((subject) => [subject.id, subject]));
  const out: BankIrSubject[] = [];
  const seen = new Set<string>();
  for (const subject of existing) {
    out.push(incomingById.get(subject.id) ?? subject);
    seen.add(subject.id);
  }
  for (const subject of incoming) {
    if (seen.has(subject.id)) continue;
    out.push(subject);
    seen.add(subject.id);
  }
  return out;
}

function pushFile(files: PlannedFile[], repoRoot: string, relPath: string, contents: string): void {
  const absPath = path.join(repoRoot, relPath);
  files.push({
    relPath,
    absPath,
    contents,
    existing: readExisting(absPath),
  });
}

/** Plan the public/server-only JSON files for a validated IR collection. */
export function planEmit(banks: readonly ValidatedBank[], repoRoot: string): PlannedFile[] {
  const incoming = banks.map((entry) => entry.split.subject);
  const subjects = mergeGeneratedSubjects(readGeneratedSubjects(repoRoot), incoming);
  const files: PlannedFile[] = [];

  pushFile(files, repoRoot, `${GENERATED_DIR}/subjects.json`, stableJson(subjects));

  for (const entry of banks) {
    const id = entry.split.subject.id;
    pushFile(
      files,
      repoRoot,
      `${GENERATED_DIR}/questions/${id}.json`,
      stableJson(entry.split.questions),
    );
    pushFile(files, repoRoot, `${GENERATED_DIR}/keys/${id}.json`, stableJson(entry.split.keys));
  }

  const publicRegistrar = path.join(repoRoot, 'src/lib/exam/generated-public.ts');
  const keysRegistrar = path.join(repoRoot, 'src/lib/exam/generated-keys.server.ts');
  if (existsSync(publicRegistrar) || existsSync(keysRegistrar)) {
    pushFile(files, repoRoot, 'src/lib/exam/generated-public.ts', renderGeneratedPublic(subjects));
    pushFile(
      files,
      repoRoot,
      'src/lib/exam/generated-keys.server.ts',
      renderGeneratedKeys(subjects),
    );
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
