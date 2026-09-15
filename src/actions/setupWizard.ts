'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { getMembershipForUser, isParentLike } from '@/lib/households';
import {
  addWizardSubject,
  applyCatalogEmit,
  attachWizardFile,
  clearWizardDryRun,
  completeSetupWizard,
  deleteWizardSubject,
  detachWizardFile,
  getWizardSnapshot,
  getWizardState,
  isWizardAiMode,
  MAX_WIZARD_UPLOAD_BYTES,
  parentNeedsSetupWizard,
  previewCatalogEmit,
  publicPreviewPayload,
  saveWizardState,
  SUBJECT_LABEL_MAX,
} from '@/lib/setup-wizard';
import { SUBJECT_ICON_OPTIONS, type WizardSnapshot } from '@/lib/setup-wizard-types';

export type WizardActionError = {
  ok: false;
  reason:
    | 'forbidden'
    | 'invalid'
    | 'exists'
    | 'missing'
    | 'sample_id'
    | 'too_large'
    | 'ir_mismatch'
    | 'empty_catalog'
    | 'dry_run_required'
    | 'stale_preview'
    | 'already_complete';
  message?: string;
  issues?: string[];
};

async function requirePendingParent(): Promise<
  { ok: true; householdId: number } | WizardActionError
> {
  const session = await getSession();
  if (!session.userId || session.role !== 'parent') {
    return { ok: false, reason: 'forbidden' };
  }
  const membership = getMembershipForUser(session.userId);
  if (!membership || !isParentLike(membership.role)) {
    return { ok: false, reason: 'forbidden' };
  }
  if (!parentNeedsSetupWizard(session.userId)) {
    return { ok: false, reason: 'already_complete' };
  }
  return { ok: true, householdId: membership.householdId };
}

const addSchema = z.object({
  id: z.string().trim().toLowerCase().min(1).max(SUBJECT_LABEL_MAX),
  label: z.string().trim().min(1).max(SUBJECT_LABEL_MAX),
  icon: z.enum(SUBJECT_ICON_OPTIONS),
});

export async function addWizardSubjectAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: WizardSnapshot } | WizardActionError> {
  const gate = await requirePendingParent();
  if (!gate.ok) return gate;
  const parsed = addSchema.safeParse({
    id: formData.get('id'),
    label: formData.get('label'),
    icon: formData.get('icon'),
  });
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const result = addWizardSubject(parsed.data);
  if (!result.ok) return result;
  clearWizardDryRun(gate.householdId);
  return { ok: true, snapshot: getWizardSnapshot(gate.householdId) };
}

export async function deleteWizardSubjectAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: WizardSnapshot } | WizardActionError> {
  const gate = await requirePendingParent();
  if (!gate.ok) return gate;
  const id = typeof formData.get('id') === 'string' ? formData.get('id') : '';
  const result = deleteWizardSubject(String(id));
  if (!result.ok) return result;
  clearWizardDryRun(gate.householdId);
  return { ok: true, snapshot: getWizardSnapshot(gate.householdId) };
}

export async function attachWizardFileAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: WizardSnapshot } | WizardActionError> {
  const gate = await requirePendingParent();
  if (!gate.ok) return gate;
  const subjectId = formData.get('subjectId');
  const file = formData.get('file');
  if (typeof subjectId !== 'string' || !(file instanceof File)) {
    return { ok: false, reason: 'invalid' };
  }
  if (file.size > MAX_WIZARD_UPLOAD_BYTES) return { ok: false, reason: 'too_large' };
  const bytes = Buffer.from(await file.arrayBuffer());
  const result = attachWizardFile({ subjectId, filename: file.name, bytes });
  if (!result.ok) return result;
  if (result.kind === 'ir') clearWizardDryRun(gate.householdId);
  return { ok: true, snapshot: getWizardSnapshot(gate.householdId) };
}

export async function detachWizardFileAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: WizardSnapshot } | WizardActionError> {
  const gate = await requirePendingParent();
  if (!gate.ok) return gate;
  const subjectId = formData.get('subjectId');
  const filename = formData.get('filename');
  if (typeof subjectId !== 'string' || typeof filename !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
  const result = detachWizardFile({ subjectId, filename });
  if (!result.ok) return result;
  if (filename === 'bank.ir.json') clearWizardDryRun(gate.householdId);
  return { ok: true, snapshot: getWizardSnapshot(gate.householdId) };
}

export async function setWizardAiModeAction(
  formData: FormData,
): Promise<{ ok: true; snapshot: WizardSnapshot } | WizardActionError> {
  const gate = await requirePendingParent();
  if (!gate.ok) return gate;
  const mode = formData.get('aiMode');
  if (typeof mode !== 'string' || !isWizardAiMode(mode)) {
    return { ok: false, reason: 'invalid' };
  }
  saveWizardState(gate.householdId, { aiMode: mode });
  return { ok: true, snapshot: getWizardSnapshot(gate.householdId) };
}

export async function previewWizardEmitAction(): Promise<
  | { ok: true; snapshot: WizardSnapshot; files: ReturnType<typeof publicPreviewPayload>['files'] }
  | WizardActionError
> {
  const gate = await requirePendingParent();
  if (!gate.ok) return gate;
  const preview = previewCatalogEmit();
  if (!preview.ok) {
    clearWizardDryRun(gate.householdId);
    return {
      ok: false,
      reason: preview.reason,
      message: preview.message,
      issues: preview.issues,
    };
  }
  saveWizardState(gate.householdId, { dryRunHash: preview.hash });
  const publicPlan = publicPreviewPayload(preview);
  return {
    ok: true,
    snapshot: getWizardSnapshot(gate.householdId),
    files: publicPlan.files,
  };
}

export async function applyWizardEmitAction(): Promise<
  | { ok: true; snapshot: WizardSnapshot; files: ReturnType<typeof publicPreviewPayload>['files'] }
  | WizardActionError
> {
  const gate = await requirePendingParent();
  if (!gate.ok) return gate;
  const state = getWizardState(gate.householdId);
  if (!state.dryRunHash) return { ok: false, reason: 'dry_run_required' };
  const preview = previewCatalogEmit();
  if (!preview.ok) {
    return {
      ok: false,
      reason: preview.reason,
      message: preview.message,
      issues: preview.issues,
    };
  }
  if (preview.hash !== state.dryRunHash) return { ok: false, reason: 'stale_preview' };
  const applied = applyCatalogEmit();
  if (!applied.ok) {
    return { ok: false, reason: applied.reason, message: applied.message, issues: applied.issues };
  }
  clearWizardDryRun(gate.householdId);
  return { ok: true, snapshot: getWizardSnapshot(gate.householdId), files: applied.files };
}

export async function finishSetupWizardAction(): Promise<WizardActionError | void> {
  const gate = await requirePendingParent();
  if (!gate.ok) return gate;
  completeSetupWizard(gate.householdId);
  redirect('/');
}
