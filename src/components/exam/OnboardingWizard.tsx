'use client';

import { useState, useTransition } from 'react';
import {
  addOnboardingSubjectAction,
  applyOnboardingEmitAction,
  attachOnboardingPdfAction,
  deleteOnboardingSubjectAction,
  detachOnboardingPdfAction,
  finishOnboardingAction,
  previewOnboardingEmitAction,
  renameOnboardingSubjectAction,
  setOnboardingAiModeAction,
  setReplaceSampleAction,
  skipOnboardingAction,
  validateOnboardingAction,
  type OnboardingActionError,
} from '@/actions/onboarding';
import type { AuthMode } from '@/lib/auth-mode';
import type { HouseholdMemberView, PendingInvite } from '@/lib/household-types';
import {
  EMPTY_AUTHORITATIVE_EMIT,
  ONBOARDING_INGEST_CLI,
  SUBJECT_ICON_OPTIONS,
  type OnboardingAiMode,
  type OnboardingDryRun,
  type OnboardingSnapshot,
  type OnboardingSubject,
  type SubjectIconOption,
} from '@/lib/onboarding-types';
import { HouseholdInvites } from './HouseholdInvites';
import { SubjectIcon, UIcon } from './icons';

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'subjects', label: 'Subjects' },
  { id: 'files', label: 'Files' },
  { id: 'ai', label: 'AI setup' },
  { id: 'validate', label: 'Validate' },
  { id: 'dry-run', label: 'Dry-run' },
  { id: 'apply', label: 'Apply' },
  { id: 'ready', label: 'Ready' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const AI_COPY: Record<OnboardingAiMode, { title: string; body: string }> = {
  cloud: {
    title: 'Cloud API',
    body: 'Anthropic or OpenAI keys stay in the existing env store. Phase 0 emit does not call them. Generate adapters arrive later.',
  },
  'local-agent': {
    title: 'Local agent',
    body: 'Point EXAMIFY_LLM_BASE_URL at a local endpoint when generate lands. Phase 0 validate / emit needs no URL.',
  },
  'local-cli': {
    title: 'Local CLI / lib',
    body: 'Coming. Author BankIR by hand or use pnpm examify-ingest from the host. No second secret store.',
  },
  'skip-stub': {
    title: 'Skip / test stub',
    body: 'Use the sample bank and the ANTHROPIC_API_KEY=test grader stub. No generate step in this release.',
  },
};

function errorCopy(error: OnboardingActionError): string {
  switch (error.reason) {
    case 'forbidden':
      return 'Only the household admin can continue content setup.';
    case 'invalid':
      return 'That input is not valid.';
    case 'invalid_id':
      return 'Subject id must be kebab-case (a-z, digits, hyphens) and unique.';
    case 'invalid_type':
      return 'Only PDF files can be uploaded, and they stay under content/source-pdfs/.';
    case 'duplicate':
      return 'A subject with that id already exists.';
    case 'missing':
      return 'That subject or file is no longer here.';
    case 'too_large':
      return 'That file is too large (8 MB max).';
    case 'disk':
      return 'Could not write the file (disk full or not writable).';
    case 'empty_catalog':
      return error.message ?? EMPTY_AUTHORITATIVE_EMIT;
    case 'dry_run_required':
      return 'Run a dry-run preview before applying.';
    case 'stale_preview':
      return 'Subjects or BankIR changed since the last dry-run. Preview again.';
    case 'emit_required':
      return 'Confirm apply before opening the dashboard, or skip to keep the sample bank.';
    case 'already_complete':
      return 'Content setup is already finished.';
    default:
      return 'Something went wrong.';
  }
}

export function OnboardingWizard({
  snapshot: initial,
  pendingInvites,
  members,
  canInvite,
  authMode,
}: {
  snapshot: OnboardingSnapshot;
  pendingInvites: PendingInvite[];
  members: HouseholdMemberView[];
  canInvite: boolean;
  authMode: AuthMode;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [step, setStep] = useState<StepId>('welcome');
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ file: string; message: string }[]>([]);
  const [validated, setValidated] = useState(false);
  const [dryRun, setDryRun] = useState<OnboardingDryRun | null>(null);
  const [applyState, setApplyState] = useState<
    | { status: 'idle' }
    | { status: 'applying' }
    | { status: 'success'; written: number; questionCount: number; subjectCount: number }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
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
    result: { ok: true; snapshot: OnboardingSnapshot } | OnboardingActionError,
  ): result is { ok: true; snapshot: OnboardingSnapshot } => {
    if (result.ok) {
      setSnapshot(result.snapshot);
      return true;
    }
    setError(errorCopy(result));
    setIssues(result.issues ?? []);
    return false;
  };

  const go = (next: StepId) => {
    setError(null);
    setStep(next);
  };

  return (
    <div className="screen wizard" data-testid="onboarding-wizard">
      <header className="topbar">
        <span className="topbar-spacer" />
        <span className="topbar-label">Content setup</span>
        <span className="topbar-spacer" />
      </header>

      {step !== 'welcome' ? (
        <div className="hero">
          <p className="eyebrow">
            Step {stepIndex} of {STEPS.length - 1}
          </p>
          <h1 className="display-title">{STEPS[stepIndex]!.label}</h1>
          <ol className="wizard-steps" aria-label="Setup steps">
            {STEPS.filter((entry) => entry.id !== 'welcome').map((entry, index) => (
              <li
                key={entry.id}
                className={index + 1 === stepIndex ? 'active' : index + 1 < stepIndex ? 'done' : ''}
              >
                {entry.label}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {step === 'welcome' ? <WelcomeStep /> : null}

      {step === 'subjects' ? (
        <SubjectsStep
          snapshot={snapshot}
          pending={pending}
          onAdd={(data) =>
            run(async () => {
              if (applyResult(await addOnboardingSubjectAction(data))) {
                setDryRun(null);
                setValidated(false);
              }
            })
          }
          onRename={(data) =>
            run(async () => {
              if (applyResult(await renameOnboardingSubjectAction(data))) {
                setDryRun(null);
                setValidated(false);
              }
            })
          }
          onDelete={(data) =>
            run(async () => {
              if (applyResult(await deleteOnboardingSubjectAction(data))) {
                setDryRun(null);
                setValidated(false);
              }
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
              applyResult(await attachOnboardingPdfAction(data));
            })
          }
          onDetach={(data) =>
            run(async () => {
              applyResult(await detachOnboardingPdfAction(data));
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
              applyResult(await setOnboardingAiModeAction(data));
            })
          }
        />
      ) : null}

      {step === 'validate' ? (
        <ValidateStep
          pending={pending}
          validated={validated}
          onValidate={() =>
            run(async () => {
              const result = await validateOnboardingAction();
              if (applyResult(result)) {
                setValidated(true);
                setDryRun(null);
              } else {
                setValidated(false);
              }
            })
          }
        />
      ) : null}

      {step === 'dry-run' ? (
        <DryRunStep
          snapshot={snapshot}
          pending={pending}
          dryRun={dryRun}
          onToggleReplace={(enabled) =>
            run(async () => {
              const data = new FormData();
              data.set('replaceSample', enabled ? '1' : '0');
              if (applyResult(await setReplaceSampleAction(data))) {
                setDryRun(null);
              }
            })
          }
          onPreview={() =>
            run(async () => {
              const result = await previewOnboardingEmitAction();
              if (applyResult(result) && result.ok) {
                setDryRun(result.dryRun);
              } else {
                setDryRun(null);
              }
            })
          }
        />
      ) : null}

      {step === 'apply' ? (
        <ApplyStep
          pending={pending}
          applyState={applyState}
          hasDryRun={Boolean(snapshot.hasDryRun && dryRun)}
          onApply={() =>
            run(async () => {
              setApplyState({ status: 'applying' });
              const result = await applyOnboardingEmitAction();
              if (result.ok) {
                setSnapshot(result.snapshot);
                setApplyState({
                  status: 'success',
                  written: result.written,
                  questionCount: result.questionCount,
                  subjectCount: result.subjectCount,
                });
              } else {
                setError(errorCopy(result));
                setIssues(result.issues ?? []);
                setApplyState({ status: 'error', message: errorCopy(result) });
              }
            })
          }
        />
      ) : null}

      {step === 'ready' ? (
        <ReadyStep
          applyState={applyState}
          canInvite={canInvite}
          pendingInvites={pendingInvites}
          members={members}
          authMode={authMode}
        />
      ) : null}

      {error ? (
        <p className="login-error" role="alert" data-testid="wizard-error">
          {error}
        </p>
      ) : null}
      {issues.length > 0 ? (
        <ul className="wizard-issues" data-testid="wizard-issues">
          {issues.map((issue) => (
            <li key={`${issue.file}:${issue.message}`}>
              {issue.file ? `${issue.file}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="action-dock">
        {step !== 'welcome' && step !== 'ready' ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending}
            data-testid="wizard-back"
            onClick={() => go(STEPS[stepIndex - 1]!.id)}
          >
            Back
          </button>
        ) : null}

        {step === 'welcome' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            data-testid="wizard-get-started"
            onClick={() => go('subjects')}
          >
            Get started {UIcon.arrow}
          </button>
        ) : null}

        {step === 'subjects' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || snapshot.subjects.length < 1}
            data-testid="wizard-next"
            onClick={() => go('files')}
          >
            Next
          </button>
        ) : null}

        {step === 'files' || step === 'ai' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            data-testid="wizard-next"
            onClick={() => go(STEPS[stepIndex + 1]!.id)}
          >
            Next
          </button>
        ) : null}

        {step === 'validate' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || !validated}
            data-testid="wizard-next"
            onClick={() => go('dry-run')}
          >
            Next
          </button>
        ) : null}

        {step === 'dry-run' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || !dryRun || !snapshot.hasDryRun}
            data-testid="wizard-to-apply"
            onClick={() => {
              setApplyState({ status: 'idle' });
              go('apply');
            }}
          >
            Apply
          </button>
        ) : null}

        {step === 'apply' && applyState.status === 'success' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            data-testid="wizard-to-ready"
            onClick={() => go('ready')}
          >
            Next
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
                const result = await finishOnboardingAction();
                if (result) applyResult(result);
              })
            }
          >
            {pending ? 'Opening…' : 'Open dashboard'} {UIcon.arrow}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-quiet"
            disabled={pending}
            data-testid="wizard-skip"
            onClick={() =>
              run(async () => {
                const result = await skipOnboardingAction();
                if (result) applyResult(result);
              })
            }
          >
            {step === 'welcome' ? 'Use sample bank for now' : 'Skip to dashboard'}
          </button>
        )}
      </div>
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="hero" data-testid="wizard-welcome">
      <p className="eyebrow">First-run</p>
      <h1 className="display-title">Set up your content</h1>
      <p className="subtitle">
        Add subjects, keep study PDFs local, then validate and emit BankIR through examify-ingest.
        The sample bank stays usable if you skip.
      </p>
    </div>
  );
}

function SubjectsStep({
  snapshot,
  pending,
  onAdd,
  onRename,
  onDelete,
}: {
  snapshot: OnboardingSnapshot;
  pending: boolean;
  onAdd: (data: FormData) => void;
  onRename: (data: FormData) => void;
  onDelete: (data: FormData) => void;
}) {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState<SubjectIconOption>('maths');
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editId, setEditId] = useState('');
  const [editIcon, setEditIcon] = useState<SubjectIconOption>('maths');
  const canAdd = id.trim().length > 0 && label.trim().length > 0;

  return (
    <div className="wizard-panel" data-testid="wizard-subjects">
      <p className="subtitle">
        Add, rename, or delete generated subjects. Ids are kebab-case and unique.
      </p>
      {snapshot.subjects.length === 0 ? (
        <p className="wizard-empty" data-testid="wizard-subjects-empty">
          No subjects yet…
        </p>
      ) : (
        <ul className="wizard-list">
          {snapshot.subjects.map((subject) => (
            <li key={subject.id} className="wizard-row">
              <span className="wizard-row-icon" aria-hidden>
                <SubjectIcon name={subject.icon} size={28} />
              </span>
              {editing === subject.id ? (
                <form
                  className="wizard-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData();
                    data.set('id', subject.id);
                    data.set('nextId', editId.trim());
                    data.set('label', editLabel.trim());
                    data.set('icon', editIcon);
                    onRename(data);
                    setEditing(null);
                  }}
                >
                  <input
                    className="text-input"
                    value={editId}
                    onChange={(event) => setEditId(event.target.value)}
                    aria-label="Subject id"
                    data-testid={`wizard-rename-id-${subject.id}`}
                  />
                  <input
                    className="text-input"
                    value={editLabel}
                    onChange={(event) => setEditLabel(event.target.value)}
                    aria-label="Label"
                    data-testid={`wizard-rename-label-${subject.id}`}
                  />
                  <select
                    className="text-input"
                    value={editIcon}
                    onChange={(event) => setEditIcon(event.target.value as SubjectIconOption)}
                    aria-label="Icon"
                  >
                    {SUBJECT_ICON_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-ghost" type="submit" disabled={pending}>
                    Save
                  </button>
                </form>
              ) : (
                <span>
                  <strong>{subject.label}</strong>
                  <span className="invite-meta">{subject.id}</span>
                </span>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending}
                data-testid={`wizard-rename-subject-${subject.id}`}
                onClick={() => {
                  setEditing(subject.id);
                  setEditId(subject.id);
                  setEditLabel(subject.label);
                  setEditIcon(resolveIcon(subject.icon));
                }}
              >
                Rename
              </button>
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
          if (!canAdd) return;
          const data = new FormData();
          data.set('id', id.trim());
          data.set('label', label.trim());
          data.set('icon', icon);
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
            className="text-input"
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
            className="text-input"
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
            className="text-input"
            value={icon}
            onChange={(event) => setIcon(event.target.value as SubjectIconOption)}
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
          disabled={pending || !canAdd}
          data-testid="wizard-add-subject-submit"
        >
          {pending ? 'Adding…' : 'Add subject'}
        </button>
      </form>
    </div>
  );
}

function resolveIcon(raw: string): SubjectIconOption {
  return (SUBJECT_ICON_OPTIONS as readonly string[]).includes(raw)
    ? (raw as SubjectIconOption)
    : 'maths';
}

function FilesStep({
  snapshot,
  pending,
  onAttach,
  onDetach,
}: {
  snapshot: OnboardingSnapshot;
  pending: boolean;
  onAttach: (data: FormData) => void;
  onDetach: (data: FormData) => void;
}) {
  if (snapshot.subjects.length === 0) {
    return (
      <p className="wizard-empty" data-testid="wizard-files-empty">
        Add a subject first to attach study PDFs.
      </p>
    );
  }

  return (
    <div className="wizard-panel" data-testid="wizard-files">
      <p className="subtitle">
        Uploads land only in content/source-pdfs/&lt;subject&gt;/. PDFs never go under
        content/subjects/ or content/generated/.
      </p>
      {snapshot.subjects.map((subject) => (
        <SubjectDropzone
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

function SubjectDropzone({
  subject,
  pending,
  onAttach,
  onDetach,
}: {
  subject: OnboardingSubject;
  pending: boolean;
  onAttach: (data: FormData) => void;
  onDetach: (data: FormData) => void;
}) {
  const [status, setStatus] = useState<'idle' | 'uploading' | 'fail'>('idle');
  const [failReason, setFailReason] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  const sendFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setStatus('fail');
      setFailReason('type');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setStatus('fail');
      setFailReason('size');
      return;
    }
    const data = new FormData();
    data.set('subjectId', subject.id);
    data.set('file', file);
    setStatus('uploading');
    setFailReason(null);
    onAttach(data);
    setStatus('idle');
  };

  return (
    <section className="wizard-subject-files" data-testid={`wizard-files-${subject.id}`}>
      <h2 className="wizard-subhead">{subject.label}</h2>
      {subject.sourceFiles.length === 0 ? (
        <p className="wizard-empty">No PDFs yet.</p>
      ) : (
        <ul className="wizard-list">
          {subject.sourceFiles.map((name) => (
            <li key={name} className="wizard-row">
              <span>
                <strong>{name}</strong>
                <span className="invite-meta">Study PDF</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost invite-revoke"
                disabled={pending}
                data-testid={`wizard-detach-${subject.id}-${name}`}
                onClick={() => {
                  const data = new FormData();
                  data.set('subjectId', subject.id);
                  data.set('filename', name);
                  onDetach(data);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <label
        className={'wizard-dropzone' + (active ? ' active' : '')}
        data-testid={`wizard-dropzone-${subject.id}`}
        onDragOver={(event) => {
          event.preventDefault();
          setActive(true);
        }}
        onDragLeave={() => setActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setActive(false);
          sendFile(event.dataTransfer.files[0]);
        }}
      >
        <input
          className="sr-only"
          type="file"
          accept="application/pdf,.pdf"
          data-testid={`wizard-file-${subject.id}`}
          onChange={(event) => {
            sendFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
        Drop a PDF here, or choose a file
      </label>
      {status === 'uploading' || pending ? (
        <p className="login-fine" data-testid={`wizard-upload-progress-${subject.id}`}>
          Uploading…
        </p>
      ) : null}
      {status === 'fail' ? (
        <p className="login-error" data-testid={`wizard-upload-fail-${subject.id}`}>
          {failReason === 'size'
            ? 'That file is too large (8 MB max).'
            : 'Only PDF files can be uploaded.'}
        </p>
      ) : null}
    </section>
  );
}

function AiStep({
  snapshot,
  pending,
  onSelect,
}: {
  snapshot: OnboardingSnapshot;
  pending: boolean;
  onSelect: (mode: OnboardingAiMode) => void;
}) {
  return (
    <div className="wizard-panel" data-testid="wizard-ai">
      <p className="subtitle">
        Choose where a later generate step would talk to a model. Phase 0 validate / emit needs no
        keys. Secrets stay in the existing env store — never NEXT_PUBLIC_*.
      </p>
      <p className="login-fine" data-testid="wizard-ai-store">
        Anthropic {snapshot.anthropicConfigured ? 'configured' : 'not configured'} · Local agent{' '}
        {snapshot.localAgentConfigured ? 'configured' : 'not configured'}
      </p>
      <div className="wizard-modes" role="radiogroup" aria-label="AI setup mode">
        {(Object.keys(AI_COPY) as OnboardingAiMode[]).map((mode) => {
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
      <p className="wizard-callout" data-testid="wizard-generate-coming">
        Question generation from files is coming. This step does not invent questions or write a
        second secret store.
      </p>
    </div>
  );
}

function ValidateStep({
  pending,
  validated,
  onValidate,
}: {
  pending: boolean;
  validated: boolean;
  onValidate: () => void;
}) {
  return (
    <div className="wizard-panel" data-testid="wizard-validate">
      <p className="subtitle">
        Server-only call to the shared examify-ingest lib, targeting content/subjects. Fix issues
        and re-run. Power users can use the same CLI:
      </p>
      <pre className="wizard-cli" data-testid="wizard-cli">
        {ONBOARDING_INGEST_CLI.join('\n')}
      </pre>
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending}
        data-testid="wizard-validate"
        onClick={onValidate}
      >
        {pending ? 'Checking…' : validated ? 'Re-run' : 'Validate'}
      </button>
      {validated ? (
        <p className="login-fine" data-testid="wizard-validate-ok">
          BankIR is valid. Continue to the dry-run.
        </p>
      ) : null}
    </div>
  );
}

function DryRunStep({
  snapshot,
  pending,
  dryRun,
  onToggleReplace,
  onPreview,
}: {
  snapshot: OnboardingSnapshot;
  pending: boolean;
  dryRun: OnboardingDryRun | null;
  onToggleReplace: (enabled: boolean) => void;
  onPreview: () => void;
}) {
  return (
    <div className="wizard-panel" data-testid="wizard-dry-run">
      <p className="subtitle">
        Mandatory HITL preview — the same dry-run as `pnpm examify-ingest emit content/subjects
        --dry-run`. Includes planned deletes. Apply is the only write. Additive by default.
      </p>
      <pre className="wizard-cli" data-testid="wizard-cli-emit">
        {ONBOARDING_INGEST_CLI.slice(1).join('\n')}
      </pre>
      <label className="wizard-advanced">
        <input
          type="checkbox"
          checked={snapshot.replaceSample}
          disabled={pending}
          data-testid="wizard-replace-sample"
          onChange={(event) => onToggleReplace(event.target.checked)}
        />
        Advanced: allow --replace-sample (overwrite colliding sample-bank ids)
      </label>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={pending}
        data-testid="wizard-preview"
        onClick={onPreview}
      >
        {pending ? 'Previewing…' : dryRun ? 'Re-run dry-run' : 'Dry-run preview'}
      </button>
      {dryRun ? (
        <div data-testid="wizard-dry-run-summary">
          <p className="login-fine">
            +{dryRun.questionCount} questions across {dryRun.subjectCount} subject
            {dryRun.subjectCount === 1 ? '' : 's'}
            {dryRun.collisions.length > 0
              ? ` · ${dryRun.collisions.length} sample-id collision${dryRun.collisions.length === 1 ? '' : 's'}`
              : ''}
          </p>
          {dryRun.collisions.length > 0 ? (
            <ul className="wizard-issues" data-testid="wizard-collisions">
              {dryRun.collisions.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          ) : null}
          {dryRun.plan.some((entry) => entry.action === 'delete') ? (
            <p className="login-fine" data-testid="wizard-planned-deletes">
              Planned deletes:{' '}
              {dryRun.plan
                .filter((entry) => entry.action === 'delete')
                .map((entry) => entry.path)
                .join(', ')}
            </p>
          ) : null}
          <ul className="wizard-plan" data-testid="wizard-plan">
            {dryRun.plan.map((entry) => (
              <li key={entry.path}>
                <span className="wizard-plan-action">{entry.action}</span> {entry.path}
              </li>
            ))}
          </ul>
          <pre className="wizard-diff" data-testid="wizard-diff">
            {dryRun.diff}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ApplyStep({
  pending,
  applyState,
  hasDryRun,
  onApply,
}: {
  pending: boolean;
  applyState:
    | { status: 'idle' }
    | { status: 'applying' }
    | { status: 'success'; written: number; questionCount: number; subjectCount: number }
    | { status: 'error'; message: string };
  hasDryRun: boolean;
  onApply: () => void;
}) {
  return (
    <div className="wizard-panel" data-testid="wizard-apply">
      <p className="subtitle">
        Apply writes the directory emit of content/subjects only. An empty catalog is refused and
        will not wipe generated content.
      </p>
      {applyState.status === 'idle' ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending || !hasDryRun}
          data-testid="wizard-apply-confirm"
          onClick={onApply}
        >
          Confirm apply
        </button>
      ) : null}
      {applyState.status === 'applying' ? (
        <p className="login-fine" data-testid="wizard-applying">
          Applying…
        </p>
      ) : null}
      {applyState.status === 'success' ? (
        <p className="login-fine" data-testid="wizard-applied">
          Applied {applyState.written} file{applyState.written === 1 ? '' : 's'} ·{' '}
          {applyState.questionCount} questions · {applyState.subjectCount} subjects. Keys stayed
          server-only.
        </p>
      ) : null}
      {applyState.status === 'error' ? (
        <p className="login-error" data-testid="wizard-apply-error">
          {applyState.message}
        </p>
      ) : null}
    </div>
  );
}

function ReadyStep({
  applyState,
  canInvite,
  pendingInvites,
  members,
  authMode,
}: {
  applyState:
    | { status: 'idle' }
    | { status: 'applying' }
    | { status: 'success'; written: number; questionCount: number; subjectCount: number }
    | { status: 'error'; message: string };
  canInvite: boolean;
  pendingInvites: PendingInvite[];
  members: HouseholdMemberView[];
  authMode: AuthMode;
}) {
  return (
    <div className="wizard-panel" data-testid="wizard-ready">
      <p className="subtitle">
        The household is ready. The sample bank stays available either way.
      </p>
      {applyState.status === 'success' ? (
        <p className="login-fine" data-testid="wizard-ready-counts">
          {applyState.questionCount} questions across {applyState.subjectCount} generated subject
          {applyState.subjectCount === 1 ? '' : 's'}.
        </p>
      ) : (
        <p className="login-fine">You can finish content setup later from the parent dashboard.</p>
      )}
      {canInvite ? (
        <HouseholdInvites pending={pendingInvites} members={members} authMode={authMode} />
      ) : null}
    </div>
  );
}
