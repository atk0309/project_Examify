import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { formatFileDiff, stableJson } from './diff';
import { renderGeneratedKeys, renderGeneratedPublic } from './registrars';
import { SUBJECT_ID_RE, subjectSchema, type BankIrSubject } from './schema';
import type { ValidatedBank } from './validate';
import { writeFileAtomic } from './write-atomic';

export const GENERATED_DIR = 'content/generated';
const CATALOG_REL = `${GENERATED_DIR}/subjects.json`;
const KEYS_DIR_REL = `${GENERATED_DIR}/keys`;
/** Answer keys are secrets: owner-only files in an owner-only folder. */
const KEYS_FILE_MODE = 0o600;
const KEYS_DIR_MODE = 0o700;

export type PlannedFile = {
  relPath: string;
  absPath: string;
  contents: string;
  existing: string | null;
  /** When true, `--apply` unlinks the file instead of writing `contents`. */
  delete?: boolean;
};

export type PlanEmitOptions = {
  /**
   * When true, this run's IR banks are the authoritative generated catalog.
   * Leftover `questions/<id>.json` / `keys/<id>.json` (and their `subjects.json`
   * rows) for ids absent from this run are planned for delete.
   * Default false: upsert this run and keep other generated subjects.
   */
  pruneMissing?: boolean;
  /**
   * When true (and `src/lib/exam/generated-*.ts` exist under the root), also
   * rewrite the build-time registrars. Only the committed layer (a checkout
   * emit from the CLI) has registrars; the family data folder never does.
   * Default false.
   */
  registrars?: boolean;
};

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function readExisting(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function readJsonSubjectStems(absDir: string, label: string): string[] {
  let names: string[];
  try {
    names = readdirSync(absDir);
  } catch (error) {
    if (isEnoent(error)) return [];
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${label}: ${message}`, { cause: error });
  }
  const stems: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (SUBJECT_ID_RE.test(id)) stems.push(id);
  }
  return stems;
}

/**
 * Subject ids already present under `content/generated` (catalog rows plus
 * `questions/<id>.json` / `keys/<id>.json` stems). Sample-bank subjects are
 * not stored here.
 */
export function collectGeneratedSubjectIds(repoRoot: string): Set<string> {
  const ids = new Set<string>();
  for (const subject of readGeneratedSubjects(repoRoot)) {
    ids.add(subject.id);
  }
  const questionsDir = path.join(repoRoot, GENERATED_DIR, 'questions');
  const keysDir = path.join(repoRoot, GENERATED_DIR, 'keys');
  for (const id of readJsonSubjectStems(questionsDir, `${GENERATED_DIR}/questions`)) {
    ids.add(id);
  }
  for (const id of readJsonSubjectStems(keysDir, `${GENERATED_DIR}/keys`)) {
    ids.add(id);
  }
  return ids;
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

/**
 * Merge this run's subjects, then optionally drop catalog rows that are not in
 * the run (whole-tree emit). Partial emit keeps leftover rows.
 */
export function reconcileGeneratedSubjects(
  existing: readonly BankIrSubject[],
  incoming: readonly BankIrSubject[],
  pruneMissing: boolean,
): BankIrSubject[] {
  const merged = mergeGeneratedSubjects(existing, incoming);
  if (!pruneMissing) return merged;
  const keep = new Set(incoming.map((subject) => subject.id));
  return merged.filter((subject) => keep.has(subject.id));
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

function pushDelete(files: PlannedFile[], repoRoot: string, relPath: string): void {
  const absPath = path.join(repoRoot, relPath);
  const existing = readExisting(absPath);
  if (existing === null) return;
  files.push({
    relPath,
    absPath,
    contents: '',
    existing,
    delete: true,
  });
}

function planOrphanDeletes(
  files: PlannedFile[],
  repoRoot: string,
  keepIds: ReadonlySet<string>,
): void {
  const leftover = [...collectGeneratedSubjectIds(repoRoot)]
    .filter((id) => !keepIds.has(id))
    .sort();
  for (const id of leftover) {
    pushDelete(files, repoRoot, `${GENERATED_DIR}/questions/${id}.json`);
    pushDelete(files, repoRoot, `${GENERATED_DIR}/keys/${id}.json`);
  }
}

/** Plan the public/server-only JSON files for a validated IR collection. */
export function planEmit(
  banks: readonly ValidatedBank[],
  repoRoot: string,
  options: PlanEmitOptions = {},
): PlannedFile[] {
  const incoming = banks.map((entry) => entry.split.subject);
  const pruneMissing = options.pruneMissing === true;
  const subjects = reconcileGeneratedSubjects(
    readGeneratedSubjects(repoRoot),
    incoming,
    pruneMissing,
  );
  const files: PlannedFile[] = [];

  pushFile(files, repoRoot, CATALOG_REL, stableJson(subjects));

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
  if (options.registrars === true && (existsSync(publicRegistrar) || existsSync(keysRegistrar))) {
    pushFile(files, repoRoot, 'src/lib/exam/generated-public.ts', renderGeneratedPublic(subjects));
    pushFile(
      files,
      repoRoot,
      'src/lib/exam/generated-keys.server.ts',
      renderGeneratedKeys(subjects),
    );
  }

  if (pruneMissing) {
    planOrphanDeletes(files, repoRoot, new Set(incoming.map((subject) => subject.id)));
  }

  return files;
}

export function formatEmitPlan(files: readonly PlannedFile[]): string {
  return files
    .map((file) =>
      file.delete
        ? `would delete ${file.relPath}`
        : formatFileDiff(file.relPath, file.existing, file.contents),
    )
    .join('\n\n');
}

function isKeysFile(file: PlannedFile): boolean {
  return file.relPath.startsWith(`${KEYS_DIR_REL}/`);
}

/** Best effort: a folder or file this user does not own keeps its mode. */
function tighten(absPath: string, mode: number): void {
  try {
    chmodSync(absPath, mode);
  } catch {
    // not ours to change
  }
}

function applyOne(file: PlannedFile): PlannedFile | null {
  if (file.delete) {
    if (file.existing === null) return null;
    try {
      unlinkSync(file.absPath);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    return file;
  }
  const secret = isKeysFile(file);
  if (secret) {
    const dir = path.dirname(file.absPath);
    mkdirSync(dir, { recursive: true, mode: KEYS_DIR_MODE });
    tighten(dir, KEYS_DIR_MODE);
  }
  if (file.existing === file.contents) {
    if (secret) tighten(file.absPath, KEYS_FILE_MODE);
    return null;
  }
  writeFileAtomic(file.absPath, file.contents, secret ? { mode: KEYS_FILE_MODE } : {});
  return file;
}

/** Questions + keys, then registrars, then the catalog (the commit point). */
function writeRank(file: PlannedFile): number {
  if (file.relPath === CATALOG_REL) return 2;
  return file.relPath.startsWith(`${GENERATED_DIR}/`) ? 0 : 1;
}

/**
 * Apply in a fixed order, independent of `planEmit`: every file is written
 * atomically (temp + rename), questions + keys first, registrars next,
 * `subjects.json` last — the live bank reads the catalog first, so a crash
 * never lists a subject whose files are not there yet — and unlinks after
 * every write, so registrar imports never point at deleted JSON. Keys files
 * are 0600 in a 0700 folder.
 */
export function applyEmit(files: readonly PlannedFile[]): PlannedFile[] {
  const written: PlannedFile[] = [];
  // Array#sort is stable: plan order holds within a rank.
  const writes = files.filter((file) => !file.delete).sort((a, b) => writeRank(a) - writeRank(b));
  const deletes = files.filter((file) => file.delete === true);
  for (const file of [...writes, ...deletes]) {
    const applied = applyOne(file);
    if (applied) written.push(applied);
  }
  return written;
}
