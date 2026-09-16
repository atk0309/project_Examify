import 'server-only';

import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  applyEmit,
  collectQuestionIds,
  formatFileDiff,
  isAuthoritativeCatalogInput,
  loadIrFiles,
  planEmit,
  publicQuestionIds,
  resolveIrFiles,
  resolveSubjectSources,
  SUBJECT_ID_RE,
  validateIrCollection,
  type PlannedFile,
  type ValidatedBank,
} from 'examify-ingest';
import { getOnboardingContentRoot } from '@/lib/content-root';
import { db, schema } from '@/lib/db';
import type { HouseholdRole } from '@/lib/db/schema';
import { SAMPLE_QUESTIONS, SAMPLE_SUBJECTS } from '@/lib/exam/data';
import { env } from '@/lib/env';
import { envStoreSecretConfigured, envStoreSecretHostManaged } from '@/lib/env-store';
import { getMembershipForUser } from '@/lib/households';
import {
  EMPTY_AUTHORITATIVE_EMIT,
  ONBOARDING_AI_MODES,
  SUBJECT_ICON_OPTIONS,
  type OnboardingAiMode,
  type OnboardingDryRun,
  type OnboardingIssue,
  type OnboardingPlanAction,
  type OnboardingPlanEntry,
  type OnboardingSnapshot,
  type OnboardingState,
  type OnboardingSubject,
  type SubjectIconOption,
} from '@/lib/onboarding-types';

export {
  EMPTY_AUTHORITATIVE_EMIT,
  ONBOARDING_GENERATE_SEED_DEFAULT,
  ONBOARDING_INGEST_CLI,
  SUBJECT_ICON_OPTIONS,
  confirmOnboardingIrOverwrite,
  generateIrWriteLabel,
  generateIrWriteVerb,
  onboardingGenerateAndEmitCli,
  onboardingGenerateBatchIds,
  onboardingGenerateCli,
  onboardingGenerateOverwriteSubjects,
  onboardingSubjectIrRel,
  providerForOnboardingAiMode,
} from '@/lib/onboarding-types';
export { getOnboardingContentRoot, setOnboardingContentRootForTests } from '@/lib/content-root';

export const SUBJECTS_REL = 'content/subjects';
export const SOURCE_PDFS_REL = 'content/source-pdfs';
export const BANK_IR_FILE = 'bank.ir.json';
export const MAX_SOURCE_PDF_BYTES = 8 * 1024 * 1024;
/** Server Action multipart ceiling — above {@link MAX_SOURCE_PDF_BYTES} plus form fields. */
export const ONBOARDING_ACTION_BODY_LIMIT_BYTES = MAX_SOURCE_PDF_BYTES + 2 * 1024 * 1024;
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

const FROZEN_SAMPLE_IDS = collectQuestionIds(SAMPLE_QUESTIONS);

export function normalizeSubjectId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidSubjectId(id: string): boolean {
  return SUBJECT_ID_RE.test(id);
}

export function resolveOnboardingIcon(raw: string | undefined): SubjectIconOption {
  if (raw && (SUBJECT_ICON_OPTIONS as readonly string[]).includes(raw)) {
    return raw as SubjectIconOption;
  }
  return 'maths';
}

export function isHouseholdAdmin(role: HouseholdRole | null | undefined): boolean {
  return role === 'admin';
}

export function isOnboardingAiMode(value: string): value is OnboardingAiMode {
  return (ONBOARDING_AI_MODES as readonly string[]).includes(value);
}

export function parseOnboardingState(raw: unknown): OnboardingState {
  if (!raw || typeof raw !== 'object') return {};
  const rec = raw as Record<string, unknown>;
  return {
    skipped: rec.skipped === true,
    aiMode:
      typeof rec.aiMode === 'string' && isOnboardingAiMode(rec.aiMode) ? rec.aiMode : undefined,
    dryRunHash: typeof rec.dryRunHash === 'string' ? rec.dryRunHash : undefined,
    applied: rec.applied === true,
    replaceSample: rec.replaceSample === true,
  };
}

export function adminShouldAutoStartOnboarding(input: {
  role: HouseholdRole | null | undefined;
  onboardingComplete: boolean;
  state: OnboardingState;
}): boolean {
  return isHouseholdAdmin(input.role) && !input.onboardingComplete && input.state.skipped !== true;
}

export function adminCanOpenOnboarding(input: {
  role: HouseholdRole | null | undefined;
  onboardingComplete: boolean;
}): boolean {
  return isHouseholdAdmin(input.role) && !input.onboardingComplete;
}

export function adminNeedsOnboardingChip(input: {
  role: HouseholdRole | null | undefined;
  onboardingComplete: boolean;
}): boolean {
  return isHouseholdAdmin(input.role) && !input.onboardingComplete;
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

/** PDF files start with the `%PDF` magic. Extension alone is not enough. */
export function hasPdfMagic(bytes: Buffer): boolean {
  return bytes.byteLength >= 4 && bytes.subarray(0, 4).equals(Buffer.from('%PDF', 'ascii'));
}

function subjectsDir(root = getOnboardingContentRoot()): string {
  return path.join(root, SUBJECTS_REL);
}

function sourcePdfsDir(root = getOnboardingContentRoot()): string {
  return path.join(root, SOURCE_PDFS_REL);
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isDiskError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EROFS';
}

function readJsonUnknown(absPath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(absPath, 'utf8')) as unknown;
  } catch (error) {
    if (isEnoent(error)) return null;
    return null;
  }
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

/** Rel-paths `examify-ingest generate` would read — same resolver as generate. */
export function listOnboardingGenerateSources(
  subjectId: string,
  root = getOnboardingContentRoot(),
): string[] {
  const subjectDir = path.join(subjectsDir(root), subjectId);
  return resolveSubjectSources(root, subjectId, subjectDir).map((source) => source.relPath);
}

export function listOnboardingSubjects(root = getOnboardingContentRoot()): OnboardingSubject[] {
  const dir = subjectsDir(root);
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidSubjectId(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  return names.map((id) => {
    const irPath = path.join(dir, id, BANK_IR_FILE);
    const raw = readJsonUnknown(irPath);
    const hasIr = existsSync(irPath);
    let label = id;
    let icon: string = 'maths';
    if (raw && typeof raw === 'object') {
      const subject = (raw as { subject?: { label?: unknown; icon?: unknown } }).subject;
      if (typeof subject?.label === 'string' && subject.label.trim()) label = subject.label.trim();
      icon = resolveOnboardingIcon(typeof subject?.icon === 'string' ? subject.icon : undefined);
    }
    return {
      id,
      label,
      icon,
      hasIr,
      sourceFiles: listPdfNames(id, root),
      generateSources: listOnboardingGenerateSources(id, root),
    };
  });
}

export function getHouseholdOnboarding(householdId: number): {
  complete: boolean;
  state: OnboardingState;
} {
  const row = db
    .select({
      complete: schema.households.onboardingComplete,
      state: schema.households.onboardingState,
    })
    .from(schema.households)
    .where(eq(schema.households.id, householdId))
    .get();
  return {
    complete: row?.complete === true,
    state: parseOnboardingState(row?.state),
  };
}

export function getOnboardingForUser(userId: number): {
  householdId: number | null;
  role: HouseholdRole | null;
  complete: boolean;
  state: OnboardingState;
} {
  const membership = getMembershipForUser(userId);
  if (!membership) {
    return { householdId: null, role: null, complete: true, state: {} };
  }
  const household = getHouseholdOnboarding(membership.householdId);
  return {
    householdId: membership.householdId,
    role: membership.role,
    complete: household.complete,
    state: household.state,
  };
}

export function saveOnboardingState(
  householdId: number,
  patch: Partial<OnboardingState>,
): OnboardingState {
  const current = getHouseholdOnboarding(householdId);
  const next: OnboardingState = { ...current.state, ...patch };
  db.update(schema.households)
    .set({ onboardingState: next })
    .where(eq(schema.households.id, householdId))
    .run();
  return next;
}

export function clearOnboardingDryRun(householdId: number): void {
  const current = getHouseholdOnboarding(householdId);
  if (!current.state.dryRunHash) return;
  const { dryRunHash: _dropped, ...rest } = current.state;
  db.update(schema.households)
    .set({ onboardingState: rest })
    .where(eq(schema.households.id, householdId))
    .run();
}

/** Catalog mutations drop both the HITL hash and the finish-after-apply flag. */
export function invalidateOnboardingEmit(householdId: number): void {
  const current = getHouseholdOnboarding(householdId);
  if (!current.state.dryRunHash && !current.state.applied) return;
  const { dryRunHash: _hash, applied: _applied, ...rest } = current.state;
  db.update(schema.households)
    .set({ onboardingState: rest })
    .where(eq(schema.households.id, householdId))
    .run();
}

/** Confirmed apply: keep finish eligible, drop the used dry-run hash. */
export function markOnboardingApplied(householdId: number): void {
  const current = getHouseholdOnboarding(householdId);
  const { dryRunHash: _dropped, ...rest } = current.state;
  db.update(schema.households)
    .set({ onboardingState: { ...rest, applied: true } })
    .where(eq(schema.households.id, householdId))
    .run();
}

export function skipOnboarding(householdId: number): void {
  const current = getHouseholdOnboarding(householdId);
  db.update(schema.households)
    .set({
      onboardingComplete: false,
      onboardingState: { ...current.state, skipped: true },
    })
    .where(eq(schema.households.id, householdId))
    .run();
}

export function completeOnboarding(householdId: number): void {
  const current = getHouseholdOnboarding(householdId);
  db.update(schema.households)
    .set({
      onboardingComplete: true,
      onboardingState: { ...current.state, skipped: false },
    })
    .where(eq(schema.households.id, householdId))
    .run();
}

function aiFlags(): {
  anthropicConfigured: boolean;
  openaiConfigured: boolean;
  openaiHostManaged: boolean;
  localAgentConfigured: boolean;
} {
  return {
    anthropicConfigured: envStoreSecretConfigured('ANTHROPIC_API_KEY', {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    }),
    // OPENAI_API_KEY is not in env.ts / never NEXT_PUBLIC_*. Wizard + install.sh
    // write the same repo-root `.env` (findRepoRoot) and update process.env.
    openaiConfigured: envStoreSecretConfigured('OPENAI_API_KEY'),
    openaiHostManaged: envStoreSecretHostManaged('OPENAI_API_KEY'),
    localAgentConfigured: Boolean(
      env.EXAMIFY_LLM_BASE_URL || process.env.EXAMIFY_INGEST_LOCAL_CMD?.trim(),
    ),
  };
}

export function getOnboardingSnapshot(
  householdId: number,
  root = getOnboardingContentRoot(),
): OnboardingSnapshot {
  const state = getHouseholdOnboarding(householdId).state;
  return {
    subjects: listOnboardingSubjects(root),
    sampleSubjects: SAMPLE_SUBJECTS.map((subject) => ({ id: subject.id, label: subject.label })),
    aiMode: state.aiMode ?? null,
    replaceSample: state.replaceSample === true,
    hasDryRun: Boolean(state.dryRunHash),
    hasApplied: state.applied === true,
    ...aiFlags(),
  };
}

export type AddSubjectResult =
  { ok: true; subject: OnboardingSubject } | { ok: false; reason: 'invalid_id' | 'duplicate' };

export function addOnboardingSubject(
  input: { id: string; label: string; icon?: string },
  root = getOnboardingContentRoot(),
): AddSubjectResult {
  const id = normalizeSubjectId(input.id);
  const label = input.label.trim();
  const icon = resolveOnboardingIcon(input.icon);
  if (!isValidSubjectId(id) || id.length > SUBJECT_LABEL_MAX) {
    return { ok: false, reason: 'invalid_id' };
  }
  if (!label || label.length > SUBJECT_LABEL_MAX) return { ok: false, reason: 'invalid_id' };

  const dir = path.join(subjectsDir(root), id);
  if (existsSync(dir)) return { ok: false, reason: 'duplicate' };

  mkdirSync(dir, { recursive: true });
  const ir = {
    version: 1 as const,
    subject: { id, label, icon, ...ICON_ACCENTS[icon] },
    difficulties: { easy: [], medium: [], hard: [] },
  };
  writeFileSync(path.join(dir, BANK_IR_FILE), `${JSON.stringify(ir, null, 2)}\n`, 'utf8');
  return { ok: true, subject: listOnboardingSubjects(root).find((row) => row.id === id)! };
}

export type RenameSubjectResult =
  | { ok: true; subject: OnboardingSubject }
  | { ok: false; reason: 'invalid_id' | 'duplicate' | 'missing' | 'disk' };

/** Wizard actions wait on `withOnboardingGenerateLock` so rename cannot race an IR commit. */
export function renameOnboardingSubject(
  input: { id: string; nextId?: string; label: string; icon?: string },
  root = getOnboardingContentRoot(),
): RenameSubjectResult {
  const id = normalizeSubjectId(input.id);
  if (!isValidSubjectId(id)) return { ok: false, reason: 'invalid_id' };
  const irPath = path.join(subjectsDir(root), id, BANK_IR_FILE);
  const raw = readJsonUnknown(irPath);
  if (!raw || typeof raw !== 'object') {
    if (!existsSync(path.join(subjectsDir(root), id))) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'missing' };
  }

  const current = raw as {
    version: 1;
    subject: {
      id: string;
      label: string;
      icon: string;
      l: number;
      c: number;
      h: number;
    };
    difficulties: unknown;
    meta?: unknown;
  };
  const label = input.label.trim() || current.subject.label || id;
  if (!label || label.length > SUBJECT_LABEL_MAX) return { ok: false, reason: 'invalid_id' };
  const icon = resolveOnboardingIcon(input.icon ?? current.subject.icon);
  const nextId = input.nextId ? normalizeSubjectId(input.nextId) : id;
  if (!isValidSubjectId(nextId) || nextId.length > SUBJECT_LABEL_MAX) {
    return { ok: false, reason: 'invalid_id' };
  }

  let workingId = id;
  if (nextId !== id) {
    const fromIr = path.join(subjectsDir(root), id);
    const destIr = path.join(subjectsDir(root), nextId);
    const fromPdf = path.join(sourcePdfsDir(root), id);
    const destPdf = path.join(sourcePdfsDir(root), nextId);
    // Check both destinations before moving anything so a PDF clash cannot
    // leave the IR dir half-renamed.
    if (existsSync(destIr)) return { ok: false, reason: 'duplicate' };
    const movePdfs = existsSync(fromPdf);
    if (movePdfs && existsSync(destPdf)) return { ok: false, reason: 'duplicate' };

    mkdirSync(subjectsDir(root), { recursive: true });
    try {
      renameSync(fromIr, destIr);
    } catch (error) {
      if (isDiskError(error)) return { ok: false, reason: 'disk' };
      throw error;
    }

    if (movePdfs) {
      try {
        mkdirSync(sourcePdfsDir(root), { recursive: true });
        renameSync(fromPdf, destPdf);
      } catch (error) {
        try {
          if (existsSync(destIr) && !existsSync(fromIr)) {
            renameSync(destIr, fromIr);
          }
        } catch {
          // Best-effort IR rollback; still report the PDF-move failure.
        }
        if (isDiskError(error)) return { ok: false, reason: 'disk' };
        throw error;
      }
    }
    workingId = nextId;
  }

  const destIr = path.join(subjectsDir(root), workingId, BANK_IR_FILE);
  const next = {
    ...current,
    version: 1 as const,
    subject: {
      ...current.subject,
      id: workingId,
      label,
      icon,
      ...ICON_ACCENTS[icon],
    },
    difficulties:
      workingId !== id
        ? rewriteOnboardingQuestionIds(current.difficulties, id, workingId)
        : current.difficulties,
  };
  writeFileSync(destIr, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    subject: listOnboardingSubjects(root).find((row) => row.id === workingId)!,
  };
}

export type DeleteSubjectResult = { ok: true } | { ok: false; reason: 'invalid_id' | 'missing' };

/**
 * Remove the subject's IR + source-pdf dirs. Prune of leftover generated JSON
 * happens on the next confirmed directory emit (#62 / HITL) — delete never
 * writes generated files itself. Wizard actions wait on
 * `withOnboardingGenerateLock` so a late generate commit cannot recreate this id.
 */
export function deleteOnboardingSubject(
  subjectId: string,
  root = getOnboardingContentRoot(),
): DeleteSubjectResult {
  const id = normalizeSubjectId(subjectId);
  if (!isValidSubjectId(id)) return { ok: false, reason: 'invalid_id' };
  const dir = path.join(subjectsDir(root), id);
  if (!existsSync(dir)) return { ok: false, reason: 'missing' };
  rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(sourcePdfsDir(root), id), { recursive: true, force: true });
  return { ok: true };
}

export type AttachPdfResult =
  | { ok: true; filename: string }
  | { ok: false; reason: 'invalid_id' | 'invalid_type' | 'too_large' | 'disk' | 'missing' };

export function attachSourcePdf(
  input: { subjectId: string; filename: string; bytes: Buffer },
  root = getOnboardingContentRoot(),
): AttachPdfResult {
  const subjectId = normalizeSubjectId(input.subjectId);
  if (!isValidSubjectId(subjectId)) return { ok: false, reason: 'invalid_id' };
  if (!existsSync(path.join(subjectsDir(root), subjectId))) return { ok: false, reason: 'missing' };
  if (!isSafeUploadName(input.filename) || !input.filename.toLowerCase().endsWith('.pdf')) {
    return { ok: false, reason: 'invalid_type' };
  }
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_SOURCE_PDF_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  if (!hasPdfMagic(input.bytes)) return { ok: false, reason: 'invalid_type' };

  const dest = path.join(sourcePdfsDir(root), subjectId, input.filename);
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, input.bytes);
  } catch (error) {
    if (isDiskError(error)) return { ok: false, reason: 'disk' };
    throw error;
  }
  return { ok: true, filename: input.filename };
}

export type DetachPdfResult = { ok: true } | { ok: false; reason: 'invalid_id' | 'missing' };

export function detachSourcePdf(
  input: { subjectId: string; filename: string },
  root = getOnboardingContentRoot(),
): DetachPdfResult {
  const subjectId = normalizeSubjectId(input.subjectId);
  if (!isValidSubjectId(subjectId) || !isSafeUploadName(input.filename)) {
    return { ok: false, reason: 'invalid_id' };
  }
  if (!input.filename.toLowerCase().endsWith('.pdf')) return { ok: false, reason: 'invalid_id' };
  const target = path.join(sourcePdfsDir(root), subjectId, input.filename);
  if (!existsSync(target) || !statSync(target).isFile()) return { ok: false, reason: 'missing' };
  rmSync(target);
  return { ok: true };
}

function publicIssueFile(absPath: string | undefined, root: string): string {
  if (!absPath) return '';
  const rel = path.relative(root, absPath);
  return rel.startsWith('..') ? path.basename(absPath) : rel;
}

export function rewriteOnboardingQuestionIds(
  difficulties: unknown,
  fromId: string,
  toId: string,
): unknown {
  if (!difficulties || typeof difficulties !== 'object' || Array.isArray(difficulties)) {
    return difficulties;
  }
  const prefix = `${fromId}-`;
  const out: Record<string, unknown> = {};
  for (const [difficulty, items] of Object.entries(difficulties as Record<string, unknown>)) {
    if (!Array.isArray(items)) {
      out[difficulty] = items;
      continue;
    }
    out[difficulty] = items.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const rec = item as { id?: unknown };
      if (typeof rec.id !== 'string' || !rec.id.startsWith(prefix)) return item;
      return { ...item, id: `${toId}-${rec.id.slice(prefix.length)}` };
    });
  }
  return out;
}

export function validateOnboardingIr(
  replaceSample = false,
  root = getOnboardingContentRoot(),
): { ok: true } | { ok: false; issues: OnboardingIssue[] } {
  const loaded = loadSubjectsTree(root);
  if (!loaded.ok) {
    return {
      ok: false,
      issues: [{ file: SUBJECTS_REL, message: loaded.message }],
    };
  }
  const result = validateIrCollection(loaded.files, {
    replaceSample,
    frozenIds: FROZEN_SAMPLE_IDS,
  });
  if (result.ok) return { ok: true };
  return {
    ok: false,
    issues: result.errors.map((issue) => ({
      file: publicIssueFile(issue.path, root),
      message: issue.message,
    })),
  };
}

function loadSubjectsTree(
  root: string,
):
  | { ok: true; files: ReturnType<typeof loadIrFiles>; pruneMissing: boolean }
  | { ok: false; reason: 'invalid' | 'empty_catalog'; message: string } {
  const inputs = [SUBJECTS_REL];
  let pruneMissing = false;
  try {
    pruneMissing = isAuthoritativeCatalogInput(inputs, root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'invalid', message };
  }
  if (!pruneMissing) {
    const abs = path.resolve(root, SUBJECTS_REL);
    if (!existsSync(abs)) {
      return { ok: false, reason: 'empty_catalog', message: EMPTY_AUTHORITATIVE_EMIT };
    }
    return {
      ok: false,
      reason: 'invalid',
      message: 'onboarding emit must target the subjects directory only',
    };
  }

  let files;
  try {
    const paths = resolveIrFiles(inputs, root, { allowEmptyDirectory: true });
    files = loadIrFiles(paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'invalid', message };
  }

  if (files.length === 0) {
    return { ok: false, reason: 'empty_catalog', message: EMPTY_AUTHORITATIVE_EMIT };
  }
  return { ok: true, files, pruneMissing };
}

function toPublicPlan(files: readonly PlannedFile[]): OnboardingPlanEntry[] {
  return files.map((file) => {
    let action: OnboardingPlanAction = 'update';
    if (file.delete) action = 'delete';
    else if (file.existing === null) action = 'add';
    else if (file.existing === file.contents) action = 'unchanged';
    return { path: file.relPath, action };
  });
}

function isSecretPlanPath(relPath: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  return (
    normalized.includes('/keys/') ||
    normalized.endsWith('/keys') ||
    normalized.endsWith('generated-keys.server.ts')
  );
}

/**
 * Same shape as CLI `formatEmitPlan`, but key-file bodies never leave the server.
 * Planned deletes stay visible (`would delete …`) so HITL can confirm prune.
 */
export function formatPublicEmitPlan(files: readonly PlannedFile[]): string {
  return files
    .map((file) => {
      if (file.delete) return `would delete ${file.relPath}`;
      if (isSecretPlanPath(file.relPath)) {
        if (file.existing === null) return `would create ${file.relPath}`;
        if (file.existing === file.contents) return `unchanged ${file.relPath}`;
        return `would update ${file.relPath}`;
      }
      return formatFileDiff(file.relPath, file.existing, file.contents);
    })
    .join('\n\n');
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

function questionIdsFromBanks(banks: readonly ValidatedBank[]): string[] {
  const ids: string[] = [];
  for (const bank of banks) {
    ids.push(...publicQuestionIds(bank.split));
  }
  return ids;
}

function collisionsAgainstSample(ids: readonly string[]): string[] {
  const frozen = new Set(FROZEN_SAMPLE_IDS);
  return [...new Set(ids.filter((id) => frozen.has(id)))].sort();
}

export type CatalogEmitPreview =
  | { ok: true; dryRun: OnboardingDryRun; planned: PlannedFile[] }
  | { ok: false; reason: 'empty_catalog' | 'invalid'; message: string; issues?: OnboardingIssue[] };

/**
 * Authoritative directory emit of `content/subjects` via the same Node package
 * as `pnpm examify-ingest emit content/subjects` (no browser, no shell-out).
 * Planned key-file bodies stay on the server; HITL sees paths, actions, and a
 * redacted CLI-shaped diff (including `would delete`).
 */
export function previewOnboardingEmit(
  replaceSample: boolean,
  root = getOnboardingContentRoot(),
): CatalogEmitPreview {
  const loaded = loadSubjectsTree(root);
  if (!loaded.ok) return loaded;

  const result = validateIrCollection(loaded.files, {
    replaceSample,
    frozenIds: FROZEN_SAMPLE_IDS,
  });
  const ids = result.ok ? questionIdsFromBanks(result.banks) : [];
  const collisions = collisionsAgainstSample(
    result.ok
      ? ids
      : loaded.files.flatMap((file) => {
          const data = file.data as { difficulties?: Record<string, { id?: string }[]> };
          const out: string[] = [];
          for (const list of Object.values(data.difficulties ?? {})) {
            for (const item of list ?? []) {
              if (typeof item.id === 'string') out.push(item.id);
            }
          }
          return out;
        }),
  );

  if (!result.ok) {
    return {
      ok: false,
      reason: 'invalid',
      message: `validate failed (${result.errors.length} issue${result.errors.length === 1 ? '' : 's'})`,
      issues: result.errors.map((issue) => ({
        file: publicIssueFile(issue.path, root),
        message: issue.message,
      })),
    };
  }

  const planned = planEmit(result.banks, root, { pruneMissing: loaded.pruneMissing });
  return {
    ok: true,
    planned,
    dryRun: {
      hash: hashPlan(planned),
      questionCount: ids.length,
      subjectCount: result.banks.length,
      collisions,
      replaceSample,
      plan: toPublicPlan(planned),
      diff: formatPublicEmitPlan(planned),
    },
  };
}

export type CatalogEmitApply =
  | {
      ok: true;
      written: number;
      questionCount: number;
      subjectCount: number;
      plan: OnboardingPlanEntry[];
    }
  | {
      ok: false;
      reason: 'empty_catalog' | 'invalid' | 'stale_preview';
      message: string;
      issues?: OnboardingIssue[];
    };

/**
 * Re-preview the current tree, refuse if the plan hash is not the confirmed
 * dry-run, then `applyEmit` that same planned list. Never apply a newer
 * unconfirmed plan (a concurrent IR change after HITL confirm).
 */
export function applyOnboardingEmit(
  input: { replaceSample: boolean; expectedHash: string },
  root = getOnboardingContentRoot(),
): CatalogEmitApply {
  const preview = previewOnboardingEmit(input.replaceSample, root);
  if (!preview.ok) return preview;
  if (preview.dryRun.hash !== input.expectedHash) {
    return {
      ok: false,
      reason: 'stale_preview',
      message: 'Subjects or BankIR changed since the last dry-run. Preview again.',
    };
  }
  applyEmit(preview.planned);
  return {
    ok: true,
    written: preview.planned.filter((file) => file.delete || file.existing !== file.contents)
      .length,
    questionCount: preview.dryRun.questionCount,
    subjectCount: preview.dryRun.subjectCount,
    plan: preview.dryRun.plan,
  };
}

export function publicDryRun(preview: Extract<CatalogEmitPreview, { ok: true }>): OnboardingDryRun {
  return preview.dryRun;
}
