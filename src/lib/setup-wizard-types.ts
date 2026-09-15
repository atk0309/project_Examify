/** Client-safe setup-wizard types (no DB / server-only / answer-key imports). */

export const SETUP_WIZARD_AI_MODES = ['sample', 'hand-ir', 'from-files'] as const;
export type SetupWizardAiMode = (typeof SETUP_WIZARD_AI_MODES)[number];

export const SUBJECT_ICON_OPTIONS = [
  'maths',
  'biology',
  'chemistry',
  'physics',
  'computer-science',
  'geography',
  'french',
  'latin',
  'drama',
  'music',
  'food',
  'product-design',
  'textiles',
] as const;
export type SubjectIconOption = (typeof SUBJECT_ICON_OPTIONS)[number];

export type SetupWizardPersistedState = {
  aiMode?: SetupWizardAiMode;
  dryRunHash?: string;
};

export type WizardAttachedFile = {
  name: string;
  kind: 'pdf' | 'ir';
};

export type WizardSubject = {
  id: string;
  label: string;
  icon: string;
  hasBankIr: boolean;
  irInvalid?: boolean;
  files: WizardAttachedFile[];
};

export type WizardSampleSubject = {
  id: string;
  label: string;
};

export type WizardPlanAction = 'create' | 'update' | 'delete' | 'unchanged';

/** Public emit plan row — paths only, never file contents (keys stay server-only). */
export type WizardPlanEntry = {
  relPath: string;
  action: WizardPlanAction;
};

export type WizardSnapshot = {
  subjects: WizardSubject[];
  sampleSubjects: WizardSampleSubject[];
  aiMode: SetupWizardAiMode | null;
  hasDryRun: boolean;
};

export const EMPTY_CATALOG_EMIT_MESSAGE =
  'authoritative emit refused: no BankIR files in the subjects tree (will not wipe generated content)';
