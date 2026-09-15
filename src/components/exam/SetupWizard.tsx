'use client';

import { useState, useTransition } from 'react';
import {
  addWizardSubjectAction,
  applyWizardEmitAction,
  attachWizardFileAction,
  deleteWizardSubjectAction,
  detachWizardFileAction,
  finishSetupWizardAction,
  previewWizardEmitAction,
  setWizardAiModeAction,
  type WizardActionError,
} from '@/actions/setupWizard';
import type {
  SetupWizardAiMode,
  WizardPlanEntry,
  WizardSnapshot,
  WizardSubject,
} from '@/lib/setup-wizard-types';
import { EMPTY_CATALOG_EMIT_MESSAGE, SUBJECT_ICON_OPTIONS } from '@/lib/setup-wizard-types';
import { SubjectIcon, UIcon } from './icons';

const STEPS = [
  { id: 'subjects', label: 'Subjects' },
  { id: 'files', label: 'Files' },
  { id: 'ai', label: 'AI mode' },
  { id: 'generate', label: 'Generate' },
  { id: 'ready', label: 'Ready' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const AI_COPY: Record<SetupWizardAiMode, { title: string; body: string }> = {
  sample: {
    title: 'Use the starter bank',
    body: 'Keep the shipped Maths, Computer Science, Geography (and any generated Biology) bank. You can add your own BankIR later from the CLI.',
  },
  'hand-ir': {
    title: 'Hand-authored BankIR',
    body: 'Upload a bank.ir.json under each subject you want in the generated catalog. The next step validates and emits via examify-ingest — dry-run first, then apply.',
  },
  'from-files': {
    title: 'Generate from study files',
    body: 'AI question generation from attached PDFs is not in this release. Files stay local in content/source-pdfs/. Author BankIR by hand, or use pnpm examify-ingest from the CLI.',
  },
};

function errorCopy(error: WizardActionError): string {
  switch (error.reason) {
    case 'forbidden':
      return 'You need a parent session to continue setup.';
    case 'invalid':
      return 'That input is not valid.';
    case 'exists':
      return 'A subject with that id already exists.';
    case 'missing':
      return 'That subject or file is no longer here.';
    case 'sample_id':
      return 'That id belongs to the starter bank and cannot be reused.';
    case 'too_large':
      return 'That file is too large (8 MB max).';
    case 'ir_mismatch':
      return 'bank.ir.json subject.id must match this subject.';
    case 'empty_catalog':
      return error.message ?? EMPTY_CATALOG_EMIT_MESSAGE;
    case 'dry_run_required':
      return 'Run a dry-run preview before applying.';
    case 'stale_preview':
      return 'Subjects or BankIR changed since the last dry-run. Preview again.';
    case 'already_complete':
      return 'Setup is already finished.';
    default:
      return 'Something went wrong.';
  }
}

export function SetupWizard({ snapshot: initial }: { snapshot: WizardSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [step, setStep] = useState<StepId>('subjects');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [plan, setPlan] = useState<WizardPlanEntry[] | null>(null);
  const [applied, setApplied] = useState(false);
  const [pending, startTransition] = useTransition();

  const stepIndex = STEPS.findIndex((entry) => entry.id === step);

  const run = (task: () => Promise<void>) => {
    startTransition(async () => {
      setError(null);
      setIssues([]);
      try {
        await task();
      } catch (caught) {
        if (caught && typeof caught === 'object' && 'digest' in caught) throw caught;
        setError('Something went wrong.');
      }
    });
  };

  const applyResult = (
    result: { ok: true; snapshot: WizardSnapshot } | WizardActionError,
  ): result is { ok: true; snapshot: WizardSnapshot } => {
    if (result.ok) {
      setSnapshot(result.snapshot);
      return true;
    }
    setError(errorCopy(result));
    setIssues(result.issues ?? []);
    if (result.reason === 'empty_catalog' || result.reason === 'dry_run_required') {
      setPlan(null);
      setApplied(false);
    }
    return false;
  };

  return (
    <div className="screen wizard" data-testid="setup-wizard">
      <header className="topbar">
        <span className="topbar-spacer" />
        <span className="topbar-label">First-run setup</span>
        <span className="topbar-spacer" />
      </header>

      <div className="hero">
        <p className="eyebrow">
          Step {stepIndex + 1} of {STEPS.length}
        </p>
        <h1 className="display-title">{STEPS[stepIndex]!.label}</h1>
        <ol className="wizard-steps" aria-label="Setup steps">
          {STEPS.map((entry, index) => (
            <li
              key={entry.id}
              className={index === stepIndex ? 'active' : index < stepIndex ? 'done' : ''}
            >
              {entry.label}
            </li>
          ))}
        </ol>
      </div>

      {step === 'subjects' ? (
        <SubjectsStep
          snapshot={snapshot}
          pending={pending}
          onAdd={(data) =>
            run(async () => {
              const result = await addWizardSubjectAction(data);
              if (applyResult(result)) setPlan(null);
            })
          }
          onDelete={(data) =>
            run(async () => {
              const result = await deleteWizardSubjectAction(data);
              if (applyResult(result)) setPlan(null);
            })
          }
        />
      ) : null}

      {step === 'files' ? (
        <FilesStep
          snapshot={snapshot}
          pending={pending}
          onAttach={(data) =>
            run(async () => {
              applyResult(await attachWizardFileAction(data));
            })
          }
          onDetach={(data) =>
            run(async () => {
              applyResult(await detachWizardFileAction(data));
            })
          }
        />
      ) : null}

      {step === 'ai' ? (
        <AiStep
          snapshot={snapshot}
          pending={pending}
          onSelect={(mode) =>
            run(async () => {
              const data = new FormData();
              data.set('aiMode', mode);
              applyResult(await setWizardAiModeAction(data));
            })
          }
        />
      ) : null}

      {step === 'generate' ? (
        <GenerateStep
          snapshot={snapshot}
          pending={pending}
          plan={plan}
          applied={applied}
          onPreview={() =>
            run(async () => {
              const result = await previewWizardEmitAction();
              if (applyResult(result) && result.ok) {
                setPlan(result.files);
                setApplied(false);
              }
            })
          }
          onApply={() =>
            run(async () => {
              const result = await applyWizardEmitAction();
              if (applyResult(result) && result.ok) {
                setPlan(result.files);
                setApplied(true);
              }
            })
          }
        />
      ) : null}

      {step === 'ready' ? (
        <div className="wizard-panel" data-testid="wizard-ready">
          <p className="subtitle">
            The household is ready. Invite your family from the parent dashboard when you want them
            to join.
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="login-error" role="alert" data-testid="wizard-error">
          {error}
        </p>
      ) : null}
      {issues.length > 0 ? (
        <ul className="wizard-issues" data-testid="wizard-issues">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}

      <div className="action-dock">
        {stepIndex > 0 && step !== 'ready' ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending}
            onClick={() => {
              setError(null);
              setStep(STEPS[stepIndex - 1]!.id);
            }}
          >
            Back
          </button>
        ) : null}
        {step !== 'ready' && step !== 'generate' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            data-testid="wizard-next"
            onClick={() => {
              setError(null);
              setStep(STEPS[stepIndex + 1]!.id);
            }}
          >
            Continue
          </button>
        ) : null}
        {step === 'generate' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            data-testid="wizard-to-ready"
            onClick={() => {
              setError(null);
              setStep('ready');
            }}
          >
            Continue
          </button>
        ) : null}
        {step === 'ready' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            data-testid="wizard-finish"
            onClick={() =>
              run(async () => {
                const result = await finishSetupWizardAction();
                if (result) applyResult(result);
              })
            }
          >
            {pending ? 'Opening…' : 'Go to the dashboard'} {UIcon.arrow}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-quiet"
            disabled={pending}
            data-testid="wizard-skip"
            onClick={() => setStep('ready')}
          >
            Use the starter bank for now
          </button>
        )}
      </div>
    </div>
  );
}

function SubjectsStep({
  snapshot,
  pending,
  onAdd,
  onDelete,
}: {
  snapshot: WizardSnapshot;
  pending: boolean;
  onAdd: (data: FormData) => void;
  onDelete: (data: FormData) => void;
}) {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState<(typeof SUBJECT_ICON_OPTIONS)[number]>('maths');

  return (
    <div className="wizard-panel" data-testid="wizard-subjects">
      <p className="subtitle">
        Add the subjects you want in the generated catalog. The starter bank stays available and
        cannot be overwritten from here.
      </p>
      {snapshot.sampleSubjects.length > 0 ? (
        <p className="login-fine">
          Starter bank: {snapshot.sampleSubjects.map((subject) => subject.label).join(', ')}.
        </p>
      ) : null}

      {snapshot.subjects.length === 0 ? (
        <p className="wizard-empty" data-testid="wizard-subjects-empty">
          No generated subjects yet. Add one below, or keep the starter bank.
        </p>
      ) : (
        <ul className="wizard-list">
          {snapshot.subjects.map((subject) => (
            <li key={subject.id} className="wizard-row">
              <span className="wizard-row-icon" aria-hidden>
                <SubjectIcon name={subject.icon} size={28} />
              </span>
              <span>
                <strong>{subject.label}</strong>
                <span className="invite-meta">{subject.id}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost invite-revoke"
                disabled={pending}
                data-testid={`wizard-delete-subject-${subject.id}`}
                onClick={() => {
                  const data = new FormData();
                  data.set('id', subject.id);
                  onDelete(data);
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="wizard-add"
        data-testid="wizard-add-subject"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onAdd(data);
          setId('');
          setLabel('');
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="wizard-subject-id">
            Subject id
          </label>
          <input
            id="wizard-subject-id"
            name="id"
            className="text-input"
            required
            maxLength={40}
            placeholder="history"
            value={id}
            onChange={(event) => setId(event.target.value)}
            data-testid="wizard-subject-id"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="wizard-subject-label">
            Label
          </label>
          <input
            id="wizard-subject-label"
            name="label"
            className="text-input"
            required
            maxLength={40}
            placeholder="History"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            data-testid="wizard-subject-label"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="wizard-subject-icon">
            Icon
          </label>
          <select
            id="wizard-subject-icon"
            name="icon"
            className="text-input"
            value={icon}
            onChange={(event) =>
              setIcon(event.target.value as (typeof SUBJECT_ICON_OPTIONS)[number])
            }
            data-testid="wizard-subject-icon"
          >
            {SUBJECT_ICON_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <button
          className="btn btn-ghost"
          type="submit"
          disabled={pending}
          data-testid="wizard-add-subject-submit"
        >
          {pending ? 'Adding…' : 'Add subject'}
        </button>
      </form>
    </div>
  );
}

function FilesStep({
  snapshot,
  pending,
  onAttach,
  onDetach,
}: {
  snapshot: WizardSnapshot;
  pending: boolean;
  onAttach: (data: FormData) => void;
  onDetach: (data: FormData) => void;
}) {
  if (snapshot.subjects.length === 0) {
    return (
      <p className="wizard-empty" data-testid="wizard-files-empty">
        Add a subject first to attach study PDFs or a BankIR file.
      </p>
    );
  }

  return (
    <div className="wizard-panel" data-testid="wizard-files">
      <p className="subtitle">
        PDFs stay local under content/source-pdfs/. A bank.ir.json belongs in the subject folder and
        is what examify-ingest reads.
      </p>
      {snapshot.subjects.map((subject) => (
        <SubjectFiles
          key={subject.id}
          subject={subject}
          pending={pending}
          onAttach={onAttach}
          onDetach={onDetach}
        />
      ))}
    </div>
  );
}

function SubjectFiles({
  subject,
  pending,
  onAttach,
  onDetach,
}: {
  subject: WizardSubject;
  pending: boolean;
  onAttach: (data: FormData) => void;
  onDetach: (data: FormData) => void;
}) {
  return (
    <section className="wizard-subject-files" data-testid={`wizard-files-${subject.id}`}>
      <h2 className="wizard-subhead">{subject.label}</h2>
      {subject.files.length === 0 ? (
        <p className="wizard-empty">No files attached.</p>
      ) : (
        <ul className="wizard-list">
          {subject.files.map((file) => (
            <li key={file.name} className="wizard-row">
              <span>
                <strong>{file.name}</strong>
                <span className="invite-meta">{file.kind === 'ir' ? 'BankIR' : 'Study PDF'}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost invite-revoke"
                disabled={pending}
                data-testid={`wizard-detach-${subject.id}-${file.name}`}
                onClick={() => {
                  const data = new FormData();
                  data.set('subjectId', subject.id);
                  data.set('filename', file.name);
                  onDetach(data);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="wizard-upload"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          data.set('subjectId', subject.id);
          onAttach(data);
          event.currentTarget.reset();
        }}
      >
        <input
          className="text-input"
          type="file"
          name="file"
          accept=".pdf,.json,application/pdf,application/json"
          required
          data-testid={`wizard-file-${subject.id}`}
        />
        <button className="btn btn-ghost" type="submit" disabled={pending}>
          Attach
        </button>
      </form>
    </section>
  );
}

function AiStep({
  snapshot,
  pending,
  onSelect,
}: {
  snapshot: WizardSnapshot;
  pending: boolean;
  onSelect: (mode: SetupWizardAiMode) => void;
}) {
  return (
    <div className="wizard-panel" data-testid="wizard-ai">
      <p className="subtitle">Choose how this instance should treat question-bank generation.</p>
      <div className="wizard-modes" role="radiogroup" aria-label="AI setup mode">
        {(Object.keys(AI_COPY) as SetupWizardAiMode[]).map((mode) => {
          const selected = snapshot.aiMode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              className={'wizard-mode' + (selected ? ' selected' : '')}
              disabled={pending}
              data-testid={`wizard-ai-${mode}`}
              onClick={() => onSelect(mode)}
            >
              <strong>{AI_COPY[mode].title}</strong>
              <span>{AI_COPY[mode].body}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GenerateStep({
  snapshot,
  pending,
  plan,
  applied,
  onPreview,
  onApply,
}: {
  snapshot: WizardSnapshot;
  pending: boolean;
  plan: WizardPlanEntry[] | null;
  applied: boolean;
  onPreview: () => void;
  onApply: () => void;
}) {
  const hasIr = snapshot.subjects.some((subject) => subject.hasBankIr);
  const fromFiles = snapshot.aiMode === 'from-files';

  return (
    <div className="wizard-panel" data-testid="wizard-generate">
      <p className="subtitle">
        Emit uses the subjects directory only (`content/subjects`). Dry-run first; apply writes
        public questions and server-only keys. Sample-bank ids stay frozen.
      </p>
      {fromFiles ? (
        <p className="wizard-callout" data-testid="wizard-generate-coming">
          AI generate from attached files is coming. Use the CLI (`pnpm examify-ingest`) or upload
          BankIR and preview that catalog. This step will not invent questions.
        </p>
      ) : null}
      {!hasIr ? (
        <p className="wizard-empty" data-testid="wizard-generate-empty">
          No BankIR files in the subjects tree. An empty emit is refused and will not wipe generated
          content.
        </p>
      ) : null}

      <button
        type="button"
        className="btn btn-ghost"
        disabled={pending}
        data-testid="wizard-dry-run"
        onClick={onPreview}
      >
        {pending ? 'Previewing…' : 'Dry-run preview'}
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending || !snapshot.hasDryRun || !plan}
        data-testid="wizard-apply"
        onClick={onApply}
      >
        {pending ? 'Applying…' : 'Apply emit'}
      </button>

      {plan ? (
        <ul className="wizard-plan" data-testid="wizard-plan">
          {plan.map((entry) => (
            <li key={entry.relPath}>
              <span className="wizard-plan-action">{entry.action}</span> {entry.relPath}
            </li>
          ))}
        </ul>
      ) : null}
      {applied ? (
        <p className="login-fine" data-testid="wizard-applied">
          Emit applied. Keys stayed server-only.
        </p>
      ) : null}
    </div>
  );
}
