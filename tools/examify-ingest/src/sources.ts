import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { compareCodeUnit, sha256Bytes } from './hash';
import { SUBJECT_ID_RE, subjectSchema, type BankIrSubject } from './schema';

export const SOURCE_PDFS_REL = 'content/source-pdfs';
export const SUBJECTS_REL = 'content/subjects';
export const BANK_IR_FILE = 'bank.ir.json';
export const SUBJECT_META_FILE = 'subject.json';

export const SOURCE_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.md']);
const SKIP_NAMES = new Set([BANK_IR_FILE, SUBJECT_META_FILE]);

export type SourceKind = 'pdf' | 'image' | 'text' | 'other';

export type ResolvedSource = {
  absPath: string;
  relPath: string;
  sha256: string;
  bytes: Buffer;
  kind: SourceKind;
  mediaType: string;
};

export type GenerateTarget = {
  subjectId: string;
  subjectDir: string;
  subject: BankIrSubject;
  sources: ResolvedSource[];
};

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

export function sourceKind(name: string): SourceKind {
  const ext = extOf(name);
  if (ext === '.pdf') return 'pdf';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') return 'image';
  if (ext === '.txt' || ext === '.md') return 'text';
  return 'other';
}

export function sourceMediaType(name: string): string {
  switch (extOf(name)) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.md':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

function titleCaseId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function hueFromId(id: string): number {
  const hex = sha256Bytes(id).slice(0, 8);
  return Number.parseInt(hex, 16) % 360;
}

export function defaultSubjectMeta(id: string): BankIrSubject {
  return {
    id,
    label: titleCaseId(id),
    icon: id,
    l: 0.58,
    c: 0.09,
    h: hueFromId(id),
  };
}

function readJsonIfPresent(absPath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(absPath, 'utf8')) as unknown;
  } catch (error) {
    if (isEnoent(error)) return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${absPath}: ${message}`);
  }
}

export function loadSubjectMeta(subjectDir: string, subjectId: string): BankIrSubject {
  const ir = readJsonIfPresent(path.join(subjectDir, BANK_IR_FILE));
  if (ir && typeof ir === 'object' && ir !== null && 'subject' in ir) {
    const parsed = subjectSchema.safeParse((ir as { subject: unknown }).subject);
    if (parsed.success) {
      if (parsed.data.id !== subjectId) {
        throw new Error(
          `subject id in ${path.join(subjectDir, BANK_IR_FILE)} is "${parsed.data.id}", expected "${subjectId}"`,
        );
      }
      return parsed.data;
    }
  }

  const meta = readJsonIfPresent(path.join(subjectDir, SUBJECT_META_FILE));
  if (meta !== null) {
    const parsed = subjectSchema.safeParse(meta);
    if (!parsed.success) {
      throw new Error(`invalid ${SUBJECT_META_FILE} in ${subjectDir}: ${parsed.error.message}`);
    }
    if (parsed.data.id !== subjectId) {
      throw new Error(
        `subject id in ${path.join(subjectDir, SUBJECT_META_FILE)} is "${parsed.data.id}", expected "${subjectId}"`,
      );
    }
    return parsed.data;
  }

  return defaultSubjectMeta(subjectId);
}

function resolveReal(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    return path.resolve(absPath);
  }
}

function posixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

export function isInsideRepo(repoRoot: string, absPath: string): boolean {
  const rel = posixRel(resolveReal(repoRoot), resolveReal(absPath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isAllowedSourceRel(subjectId: string, rel: string): boolean {
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('\0')) return false;
  const subjectPrefix = `${SUBJECTS_REL}/${subjectId}/`;
  const pdfDirPrefix = `${SOURCE_PDFS_REL}/${subjectId}/`;
  const pdfFilePrefix = `${SOURCE_PDFS_REL}/${subjectId}.`;
  if (rel.startsWith(subjectPrefix) || rel.startsWith(pdfDirPrefix)) return true;
  if (rel.startsWith(pdfFilePrefix) && !rel.slice(pdfFilePrefix.length).includes('/')) return true;
  return false;
}

function relFromRoot(repoRoot: string, absPath: string): string {
  return posixRel(resolveReal(repoRoot), resolveReal(absPath));
}

function addSource(
  collected: Map<string, ResolvedSource>,
  repoRoot: string,
  subjectId: string,
  absPath: string,
): void {
  if (collected.has(absPath)) return;
  const name = path.basename(absPath);
  if (SKIP_NAMES.has(name) || name.startsWith('.')) return;
  if (!SOURCE_EXT.has(extOf(name))) return;
  let stats;
  try {
    stats = statSync(absPath);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (!stats.isFile()) return;
  const relPath = relFromRoot(repoRoot, absPath);
  if (!isAllowedSourceRel(subjectId, relPath)) {
    throw new Error(
      `refusing source outside content/subjects/${subjectId} or content/source-pdfs/${subjectId}: ${relPath}`,
    );
  }
  const bytes = readFileSync(absPath);
  collected.set(path.resolve(absPath), {
    absPath: path.resolve(absPath),
    relPath,
    sha256: sha256Bytes(bytes),
    bytes,
    kind: sourceKind(name),
    mediaType: sourceMediaType(name),
  });
}

function walkFiles(absDir: string, into: string[]): void {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${absDir}: ${message}`, { cause: error });
  }
  for (const entry of entries.sort((a, b) => compareCodeUnit(a.name, b.name))) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, into);
    else if (entry.isFile()) into.push(abs);
  }
}

export function resolveSubjectSources(
  repoRoot: string,
  subjectId: string,
  subjectDir: string,
): ResolvedSource[] {
  const collected = new Map<string, ResolvedSource>();
  if (existsSync(subjectDir)) {
    if (!isInsideRepo(repoRoot, subjectDir)) {
      throw new Error(`subject directory is outside the repo root: ${subjectDir}`);
    }
    for (const name of readdirSync(subjectDir).sort()) {
      addSource(collected, repoRoot, subjectId, path.join(subjectDir, name));
    }
  }

  const sourceRoot = path.join(repoRoot, SOURCE_PDFS_REL);
  const sourceDir = path.join(sourceRoot, subjectId);
  const nested: string[] = [];
  walkFiles(sourceDir, nested);
  for (const abs of nested) addSource(collected, repoRoot, subjectId, abs);

  for (const ext of SOURCE_EXT) {
    addSource(collected, repoRoot, subjectId, path.join(sourceRoot, `${subjectId}${ext}`));
  }

  return [...collected.values()].sort((a, b) => compareCodeUnit(a.relPath, b.relPath));
}

export function sourceHashesOf(sources: readonly ResolvedSource[]): Record<string, string> {
  return Object.fromEntries(sources.map((source) => [source.relPath, source.sha256]));
}

export function hasStandaloneSourceFile(repoRoot: string, subjectId: string): boolean {
  const sourceRoot = path.join(repoRoot, SOURCE_PDFS_REL);
  for (const ext of SOURCE_EXT) {
    if (existsSync(path.join(sourceRoot, `${subjectId}${ext}`))) return true;
  }
  return false;
}

function isSubjectsTree(absDir: string): boolean {
  if (path.basename(absDir) === 'subjects') return true;
  try {
    return readdirSync(absDir, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        SUBJECT_ID_RE.test(entry.name) &&
        existsSync(path.join(absDir, entry.name, BANK_IR_FILE)),
    );
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isSubjectDir(absDir: string): boolean {
  return SUBJECT_ID_RE.test(path.basename(absDir));
}

function targetFor(repoRoot: string, subjectId: string, subjectDir: string): GenerateTarget {
  if (!SUBJECT_ID_RE.test(subjectId)) {
    throw new Error(`subject id must be kebab-case: ${subjectId}`);
  }
  const resolvedDir = path.resolve(subjectDir);
  const relDir = posixRel(resolveReal(repoRoot), resolvedDir);
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) {
    throw new Error(`subject directory is outside the repo root: ${subjectDir}`);
  }
  return {
    subjectId,
    subjectDir,
    subject: loadSubjectMeta(subjectDir, subjectId),
    sources: resolveSubjectSources(repoRoot, subjectId, subjectDir),
  };
}

/**
 * Resolve generate targets from `content/subjects` or `content/subjects/<id>`.
 * `--subject` filters a tree (and can name a subject that only has source-pdfs).
 */
export function resolveGenerateTargets(
  inputs: readonly string[],
  cwd: string,
  repoRoot: string,
  subjectFilter: string | null,
): GenerateTarget[] {
  if (inputs.length === 0) {
    throw new Error('expected a subjects directory (content/subjects or content/subjects/<id>)');
  }

  const targets: GenerateTarget[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const abs = path.resolve(cwd, input);
    let stats;
    try {
      stats = statSync(abs);
    } catch (error) {
      if (isEnoent(error)) throw new Error(`path not found: ${input}`);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot stat ${input}: ${message}`, { cause: error });
    }

    if (stats.isFile()) {
      throw new Error(
        `generate expects a subjects directory, not a BankIR file (${input}). Pass content/subjects/<id>.`,
      );
    }
    if (!stats.isDirectory()) {
      throw new Error(`not a file or directory: ${input}`);
    }

    if (isSubjectDir(abs) && !isSubjectsTree(abs)) {
      const id = path.basename(abs);
      if (subjectFilter && subjectFilter !== id) {
        throw new Error(`--subject ${subjectFilter} does not match directory ${id}`);
      }
      if (!seen.has(id)) {
        targets.push(targetFor(repoRoot, id, abs));
        seen.add(id);
      }
      continue;
    }

    const childNames = readdirSync(abs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SUBJECT_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareCodeUnit);

    const wanted = subjectFilter ? [subjectFilter] : childNames;
    if (subjectFilter && !childNames.includes(subjectFilter)) {
      const subjectDir = path.join(abs, subjectFilter);
      const sourceDir = path.join(repoRoot, SOURCE_PDFS_REL, subjectFilter);
      if (!existsSync(sourceDir) && !hasStandaloneSourceFile(repoRoot, subjectFilter)) {
        throw new Error(
          `no subject folder or source-pdfs for "${subjectFilter}" (looked in ${path.join(input, subjectFilter)} and ${SOURCE_PDFS_REL}/${subjectFilter})`,
        );
      }
      if (!seen.has(subjectFilter)) {
        targets.push(targetFor(repoRoot, subjectFilter, subjectDir));
        seen.add(subjectFilter);
      }
      continue;
    }

    for (const id of wanted) {
      if (seen.has(id)) continue;
      targets.push(targetFor(repoRoot, id, path.join(abs, id)));
      seen.add(id);
    }
  }

  if (targets.length === 0) {
    throw new Error('no generate subjects found');
  }
  return targets;
}
