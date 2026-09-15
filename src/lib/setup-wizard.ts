import 'server-only';
import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  applyEmit,
  collectQuestionIds,
  findRepoRoot,
  isAuthoritativeCatalogInput,
  loadIrFiles,
  planEmit,
  resolveIrFiles,
  SUBJECT_ID_RE,
  validateIrCollection,
  type PlannedFile,
} from 'examify-ingest';
import { db, schema } from './db';
import { SAMPLE_QUESTIONS, SAMPLE_SUBJECTS } from './exam/data';
import { getMembershipForUser, isParentLike } from './households';
import {
  EMPTY_CATALOG_EMIT_MESSAGE,
  SETUP_WIZARD_AI_MODES,
  SUBJECT_ICON_OPTIONS,
  type SetupWizardAiMode,
  type SetupWizardPersistedState,
  type WizardPlanEntry,
  type WizardSnapshot,
  type WizardSubject,
  type SubjectIconOption,
} from './setup-wizard-types';

export { EMPTY_CATALOG_EMIT_MESSAGE } from './setup-wizard-types';

export const SUBJECTS_REL = 'content/subjects';
export const SOURCE_PDFS_REL = 'content/source-pdfs';
export const SUBJECT_META_FILE = 'subject.json';
export const BANK_IR_FILE = 'bank.ir.json';
export const MAX_WIZARD_UPLOAD_BYTES = 8 * 1024 * 1024;
export const SUBJECT_LABEL_MAX = 40;

const ICON_ACCENTS: Record<SubjectIconOption, { l: number; c: number; h: number }> = {
  maths: { l: 0.585, c: 0.062, h: 156 },
  biology: { l: 0.58, c: 0.09, h: 142 },
  chemistry: { l: 0.6, c: 0.1, h: 30 },
  physics: { l: 0.58, c: 0.08, h: 250 },
  'computer-science': { l: 0.575, c: 0.08, h: 252 },
  geography: { l: 0.645, c: 0.085, h: 82 },
  french: { l: 0.62, c: 0.09, h: 280 },
  latin: { l: 0.6, c: 0.06, h: 50 },
  drama: { l: 0.62, c: 0.1, h: 350 },
  music: { l: 0.6, c: 0.09, h: 310 },
  food: { l: 0.65, c: 0.1, h: 55 },
  'product-design': { l: 0.58, c: 0.07, h: 200 },
  textiles: { l: 0.62, c: 0.08, h: 20 },
};

const SAMPLE_IDS = new Set(SAMPLE_SUBJECTS.map((subject) => subject.id));

type SubjectMeta = {
  id: string;
  label: string;
  icon: string;
  l: number;
  c: number;
  h: number;
};

let contentRootOverride: string | null = null;

/** Tests only — point subject/PDF/ingest I/O at a temp tree. */
export function setWizardContentRootForTests(root: string | null): void {
  contentRootOverride = root;
}

export function getWizardContentRoot(): string {
  return contentRootOverride ?? findRepoRoot(process.cwd());
}

function subjectsDir(root = getWizardContentRoot()): string {
  return path.join(root, SUBJECTS_REL);
}

function sourcePdfsDir(root = getWizardContentRoot()): string {
  return path.join(root, SOURCE_PDFS_REL);
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function readJsonUnknown(absPath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(absPath, 'utf8')) as unknown;
  } catch (error) {
    if (isEnoent(error)) return null;
    return null;
  }
}

export function isSafeUploadName(name: string): boolean {
  const base = path.basename(name);
  return (
    base === name &&
    !base.startsWith('.') &&
    !base.includes('..') &&
    /^[A-Za-z0-9._()[\] -]+$/.test(base)
  );
}

export function parentNeedsSetupWizard(userId: number): boolean {
  const membership = getMembershipForUser(userId);
  if (!membership || !isParentLike(membership.role)) {
    return false;
  }
  const household = db
    .select({
      completedAt: schema.households.setupWizardCompletedAt,
    })
    .from(schema.households)
    .where(eq(schema.households.id, membership.householdId))
    .get();
  return Boolean(household && household.completedAt == null);
}

export function getWizardState(householdId: number): SetupWizardPersistedState {
  const row = db
    .select({ state: schema.households.setupWizardState })
    .from(schema.households)
    .where(eq(schema.households.id, householdId))
    .get();
  return row?.state ?? {};
}

export function saveWizardState(
  householdId: number,
  patch: Partial<SetupWizardPersistedState>,
): SetupWizardPersistedState {
  const next = { ...getWizardState(householdId), ...patch };
  db.update(schema.households)
    .set({ setupWizardState: next })
    .where(eq(schema.households.id, householdId))
    .run();
  return next;
}

export function clearWizardDryRun(householdId: number): void {
  const current = getWizardState(householdId);
  if (!current.dryRunHash) return;
  const { dryRunHash: _dropped, ...rest } = current;
  db.update(schema.households)
    .set({ setupWizardState: rest })
    .where(eq(schema.households.id, householdId))
    .run();
}

export function completeSetupWizard(householdId: number, now = Date.now()): void {
  db.update(schema.households)
    .set({ setupWizardCompletedAt: new Date(now) })
    .where(eq(schema.households.id, householdId))
    .run();
}

function listPdfNames(subjectId: string, root: string): string[] {
  const dir = path.join(sourcePdfsDir(root), subjectId);
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.pdf') && isSafeUploadName(name))
      .sort();
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

function readSubjectMeta(dir: string, fallbackId: string): SubjectMeta | null {
  const raw = readJsonUnknown(path.join(dir, SUBJECT_META_FILE));
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string' || !SUBJECT_ID_RE.test(rec.id)) return null;
  if (typeof rec.label !== 'string' || rec.label.trim().length === 0) return null;
  if (typeof rec.icon !== 'string' || rec.icon.length === 0) return null;
  if (rec.id !== fallbackId) return null;
  const l = typeof rec.l === 'number' ? rec.l : 0.58;
  const c = typeof rec.c === 'number' ? rec.c : 0.08;
  const h = typeof rec.h === 'number' ? rec.h : 160;
  return { id: rec.id, label: rec.label.trim(), icon: rec.icon, l, c, h };
}

function readIrSubjectPublic(
  dir: string,
  expectedId: string,
): { label: string; icon: string; invalid: boolean } | null {
  const raw = readJsonUnknown(path.join(dir, BANK_IR_FILE));
  if (raw === null && !existsSync(path.join(dir, BANK_IR_FILE))) return null;
  if (!raw || typeof raw !== 'object')
    return { label: expectedId, icon: expectedId, invalid: true };
  const subject = (raw as { subject?: unknown }).subject;
  if (!subject || typeof subject !== 'object') {
    return { label: expectedId, icon: expectedId, invalid: true };
  }
  const rec = subject as Record<string, unknown>;
  if (rec.id !== expectedId || typeof rec.label !== 'string' || typeof rec.icon !== 'string') {
    return { label: expectedId, icon: expectedId, invalid: true };
  }
  return { label: rec.label, icon: rec.icon, invalid: false };
}

export function listWizardSubjects(root = getWizardContentRoot()): WizardSubject[] {
  const dir = subjectsDir(root);
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SUBJECT_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  return names.map((id) => {
    const subjectDir = path.join(dir, id);
    const ir = readIrSubjectPublic(subjectDir, id);
    const meta = readSubjectMeta(subjectDir, id);
    const label = ir?.label ?? meta?.label ?? id;
    const icon = ir?.icon ?? meta?.icon ?? id;
    const files: WizardSubject['files'] = listPdfNames(id, root).map((name) => ({
      name,
      kind: 'pdf',
    }));
    if (ir || existsSync(path.join(subjectDir, BANK_IR_FILE))) {
      files.unshift({ name: BANK_IR_FILE, kind: 'ir' });
    }
    return {
      id,
      label,
      icon,
      hasBankIr: Boolean(ir) || existsSync(path.join(subjectDir, BANK_IR_FILE)),
      irInvalid: ir?.invalid,
      files,
    };
  });
}

export function getWizardSnapshot(
  householdId: number,
  root = getWizardContentRoot(),
): WizardSnapshot {
  const state = getWizardState(householdId);
  return {
    subjects: listWizardSubjects(root),
    sampleSubjects: SAMPLE_SUBJECTS.map((subject) => ({ id: subject.id, label: subject.label })),
    aiMode: state.aiMode ?? null,
    hasDryRun: Boolean(state.dryRunHash),
  };
}

export type AddSubjectResult =
  { ok: true; subject: WizardSubject } | { ok: false; reason: 'invalid' | 'exists' | 'sample_id' };

export function addWizardSubject(
  input: { id: string; label: string; icon: string },
  root = getWizardContentRoot(),
): AddSubjectResult {
  const id = input.id.trim().toLowerCase();
  const label = input.label.trim();
  const icon = input.icon.trim();
  if (!SUBJECT_ID_RE.test(id) || id.length > SUBJECT_LABEL_MAX) {
    return { ok: false, reason: 'invalid' };
  }
  if (!label || label.length > SUBJECT_LABEL_MAX) return { ok: false, reason: 'invalid' };
  if (!(SUBJECT_ICON_OPTIONS as readonly string[]).includes(icon)) {
    return { ok: false, reason: 'invalid' };
  }
  if (SAMPLE_IDS.has(id)) return { ok: false, reason: 'sample_id' };

  const dir = path.join(subjectsDir(root), id);
  if (existsSync(dir)) return { ok: false, reason: 'exists' };

  mkdirSync(dir, { recursive: true });
  const accent = ICON_ACCENTS[icon as SubjectIconOption];
  const meta: SubjectMeta = { id, label, icon, ...accent };
  writeFileSync(path.join(dir, SUBJECT_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return { ok: true, subject: listWizardSubjects(root).find((row) => row.id === id)! };
}

export type DeleteSubjectResult = { ok: true } | { ok: false; reason: 'invalid' | 'missing' };

export function deleteWizardSubject(
  subjectId: string,
  root = getWizardContentRoot(),
): DeleteSubjectResult {
  const id = subjectId.trim().toLowerCase();
  if (!SUBJECT_ID_RE.test(id) || SAMPLE_IDS.has(id)) return { ok: false, reason: 'invalid' };
  const dir = path.join(subjectsDir(root), id);
  if (!existsSync(dir)) return { ok: false, reason: 'missing' };
  rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(sourcePdfsDir(root), id), { recursive: true, force: true });
  return { ok: true };
}

export type AttachFileResult =
  | { ok: true; name: string; kind: 'pdf' | 'ir' }
  | { ok: false; reason: 'invalid' | 'missing_subject' | 'too_large' | 'ir_mismatch' };

export function attachWizardFile(
  input: { subjectId: string; filename: string; bytes: Buffer },
  root = getWizardContentRoot(),
): AttachFileResult {
  const subjectId = input.subjectId.trim().toLowerCase();
  if (!SUBJECT_ID_RE.test(subjectId)) return { ok: false, reason: 'invalid' };
  const subjectDir = path.join(subjectsDir(root), subjectId);
  if (!existsSync(subjectDir)) return { ok: false, reason: 'missing_subject' };
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_WIZARD_UPLOAD_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  if (!isSafeUploadName(input.filename)) return { ok: false, reason: 'invalid' };

  const lower = input.filename.toLowerCase();
  if (lower === BANK_IR_FILE || lower.endsWith('.json')) {
    if (input.filename !== BANK_IR_FILE) return { ok: false, reason: 'invalid' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.bytes.toString('utf8')) as unknown;
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    const id =
      parsed && typeof parsed === 'object'
        ? (parsed as { subject?: { id?: unknown } }).subject?.id
        : undefined;
    if (id !== subjectId) return { ok: false, reason: 'ir_mismatch' };
    writeFileSync(path.join(subjectDir, BANK_IR_FILE), input.bytes);
    return { ok: true, name: BANK_IR_FILE, kind: 'ir' };
  }

  if (!lower.endsWith('.pdf')) return { ok: false, reason: 'invalid' };
  const destDir = path.join(sourcePdfsDir(root), subjectId);
  mkdirSync(destDir, { recursive: true });
  writeFileSync(path.join(destDir, input.filename), input.bytes);
  return { ok: true, name: input.filename, kind: 'pdf' };
}

export type DetachFileResult = { ok: true } | { ok: false; reason: 'invalid' | 'missing' };

export function detachWizardFile(
  input: { subjectId: string; filename: string },
  root = getWizardContentRoot(),
): DetachFileResult {
  const subjectId = input.subjectId.trim().toLowerCase();
  if (!SUBJECT_ID_RE.test(subjectId) || !isSafeUploadName(input.filename)) {
    return { ok: false, reason: 'invalid' };
  }
  const target =
    input.filename === BANK_IR_FILE
      ? path.join(subjectsDir(root), subjectId, BANK_IR_FILE)
      : path.join(sourcePdfsDir(root), subjectId, input.filename);
  if (!existsSync(target) || !statSync(target).isFile()) return { ok: false, reason: 'missing' };
  rmSync(target);
  return { ok: true };
}

export function isWizardAiMode(value: string): value is SetupWizardAiMode {
  return (SETUP_WIZARD_AI_MODES as readonly string[]).includes(value);
}

function toPublicPlan(files: readonly PlannedFile[]): WizardPlanEntry[] {
  return files.map((file) => {
    let action: WizardPlanEntry['action'] = 'update';
    if (file.delete) action = 'delete';
    else if (file.existing === null) action = 'create';
    else if (file.existing === file.contents) action = 'unchanged';
    return { relPath: file.relPath, action };
  });
}

function hashPlan(files: readonly PlannedFile[]): string {
  const material = files
    .map((file) => {
      const digest = crypto.createHash('sha256').update(file.contents).digest('hex');
      return `${file.delete ? 'D' : 'W'}:${file.relPath}:${digest}`;
    })
    .join('\n');
  return crypto.createHash('sha256').update(material).digest('hex');
}

export type CatalogEmitPreview =
  | { ok: true; files: WizardPlanEntry[]; hash: string; planned: PlannedFile[] }
  | { ok: false; reason: 'empty_catalog' | 'invalid'; message: string; issues?: string[] };

/**
 * Authoritative directory emit of `content/subjects` — the same contract as
 * `pnpm examify-ingest emit content/subjects`. Never enables `--replace-sample`.
 * Planned file contents stay on the server (`planned`); `files` is paths only.
 */
export function previewCatalogEmit(root = getWizardContentRoot()): CatalogEmitPreview {
  const inputs = [SUBJECTS_REL];
  let pruneMissing = false;
  try {
    pruneMissing = isAuthoritativeCatalogInput(inputs, root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'invalid', message };
  }

  let loaded;
  try {
    const paths = resolveIrFiles(inputs, root, { allowEmptyDirectory: pruneMissing });
    loaded = loadIrFiles(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'invalid', message };
  }

  if (pruneMissing && loaded.length === 0) {
    return { ok: false, reason: 'empty_catalog', message: EMPTY_CATALOG_EMIT_MESSAGE };
  }

  const result = validateIrCollection(loaded, {
    replaceSample: false,
    frozenIds: collectQuestionIds(SAMPLE_QUESTIONS),
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: 'invalid',
      message: `validate failed (${result.errors.length} issue${result.errors.length === 1 ? '' : 's'})`,
      issues: result.errors.map((issue) =>
        issue.path ? `${path.basename(issue.path)}: ${issue.message}` : issue.message,
      ),
    };
  }

  const planned = planEmit(result.banks, root, { pruneMissing });
  return {
    ok: true,
    files: toPublicPlan(planned),
    hash: hashPlan(planned),
    planned,
  };
}

export type CatalogEmitApply =
  | { ok: true; files: WizardPlanEntry[] }
  | { ok: false; reason: 'empty_catalog' | 'invalid'; message: string; issues?: string[] };

export function applyCatalogEmit(root = getWizardContentRoot()): CatalogEmitApply {
  const preview = previewCatalogEmit(root);
  if (!preview.ok) return preview;
  applyEmit(preview.planned);
  return { ok: true, files: preview.files };
}

export function publicPreviewPayload(preview: Extract<CatalogEmitPreview, { ok: true }>): {
  files: WizardPlanEntry[];
  hash: string;
} {
  return { files: preview.files, hash: preview.hash };
}
