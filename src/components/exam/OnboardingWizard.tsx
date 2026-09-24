'use client';

import { useRef, useState, useTransition } from 'react';
import {
  addOnboardingSubjectAction,
  applyOnboardingEmitAction,
  attachOnboardingPdfAction,
  deleteOnboardingSubjectAction,
  detachOnboardingPdfAction,
  finishOnboardingAction,
  generateOnboardingSubjectAction,
  previewOnboardingEmitAction,
  renameOnboardingSubjectAction,
  setOnboardingAiModeAction,
  setOnboardingAnthropicKeyAction,
  setOnboardingOpenAiKeyAction,
  setReplaceSampleAction,
  skipOnboardingAction,
  validateOnboardingAction,
  type OnboardingActionError,
} from '@/actions/onboarding';
import type { AuthMode } from '@/lib/auth-mode';
import type { HouseholdMemberView, PendingInvite } from '@/lib/household-types';
import {
  EMPTY_AUTHORITATIVE_EMIT,
  ONBOARDING_GENERATE_ALREADY_FINISHED,
  ONBOARDING_GENERATE_SEED_DEFAULT,
  postOnboardingGenerateCancel,
  SUBJECT_ICON_OPTIONS,
  confirmOnboardingIrOverwrite,
  generateIrWriteLabel,
  isOnboardingAgentCliMode,
  localTransportForOnboardingAiMode,
  onboardingAgentCliSetupNote,
  onboardingAiCapabilityLine,
  onboardingGenerateAndEmitCli,
  onboardingGenerateBatchIds,
  onboardingGenerateCancelledNote,
  onboardingGenerateOverwriteSubjects,
  onboardingIngestCli,
  onboardingIrOverwriteConfirmMessage,
  onboardingMarkingCopy,
  onboardingModeErrorCopy,
  onboardingPruneConfirmMessage,
  onboardingPruneEntries,
  onboardingSampleCollisionMessage,
  onboardingSampleIdSubjects,
  onboardingShadowNotice,
  onboardingSourceCountLabel,
  onboardingSourceFileNames,
  onboardingSubjectIrRel,
  providerForOnboardingAiMode,
  type OnboardingAiMode,
  type OnboardingDryRun,
  type OnboardingGenerateResult,
  type OnboardingPlanEntry,
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
  { id: 'dry-run', label: 'Review' },
  { id: 'apply', label: 'Apply' },
  { id: 'ready', label: 'Ready' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const STAGE_HELP: Record<StepId, string> = {
  welcome: '',
  subjects: 'Add the subjects you want in the practice bank. One is enough to continue.',
  files:
    'Study files are stored on this host — PDFs you upload, plus notes.txt and other CLI sources generate already reads. They go to Anthropic or OpenAI only when you generate with that provider, and never enter the question bank.',
  ai: 'Choose how generate talks to a model, then optionally draft BankIR from local sources (PDFs, notes.txt, and other files generate already reads).',
  validate: 'Check BankIR before anything is written to the generated bank.',
  'dry-run': 'Preview the emit plan, including planned deletes. Apply is the only write.',
  apply: 'Confirm the reviewed plan. An empty catalog is refused.',
  ready: 'The sample bank stays available either way.',
};

const AI_COPY: Record<OnboardingAiMode, { title: string; body: string }> = {
  cloud: {
    title: 'Cloud (Anthropic)',
    body: 'Uses ANTHROPIC_API_KEY from the env store (same .env as install.sh). Never NEXT_PUBLIC_*. Generate writes BankIR only.',
  },
  'cloud-openai': {
    title: 'Cloud (OpenAI)',
    body: 'Uses OPENAI_API_KEY from the env store (not Next env.ts). Never NEXT_PUBLIC_*. Generate writes BankIR only.',
  },
  'claude-cli': {
    title: 'Claude Code (your Claude plan)',
    body: 'Runs claude -p on this server with its own sign-in, so no API key. It gets no tools and none of this server’s secrets. Generate writes BankIR only.',
  },
  'codex-cli': {
    title: 'Codex (your ChatGPT plan)',
    body: 'Runs codex exec on this server with its own sign-in, so no API key. Read-only, with commands and web search off, and none of this server’s secrets. Generate writes BankIR only.',
  },
  'local-agent': {
    title: 'Local endpoint',
    body: 'Uses EXAMIFY_LLM_BASE_URL (OpenAI-compatible, e.g. Ollama or LM Studio) and the model named in EXAMIFY_LLM_MODEL. Generate writes BankIR only.',
  },
  'local-cli': {
    title: 'Local command',
    body: 'Uses EXAMIFY_INGEST_LOCAL_CMD: your command reads a JSON request on stdin and prints BankIR. Generate writes BankIR only.',
  },
  'skip-stub': {
    title: 'Skip / test stub',
    body: 'Deterministic fixture provider. No cloud key. Hand-authored BankIR can still skip generate.',
  },
};

function suggestSubjectId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function errorCopy(error: OnboardingActionError, aiMode?: OnboardingAiMode | null): string {
  const modeCopy = onboardingModeErrorCopy(error.reason, aiMode);
  if (modeCopy) return modeCopy;
  switch (error.reason) {
    case 'forbidden':
      return 'Only the household admin can continue content setup.';
    case 'invalid':
      return 'That input is not valid.';
    case 'invalid_id':
      return 'Subject id must be kebab-case (a-z, digits, hyphens) and unique.';
    case 'invalid_type':
      return 'That file is not a PDF. Only PDF files can be uploaded.';
    case 'invalid_name':
      return 'That file name cannot be used. Rename the file and upload it again.';
    case 'duplicate':
      return 'A subject with that id already exists.';
    case 'missing':
      return 'That subject or file is no longer here.';
    case 'too_large':
      return 'That file is too large (8 MB max).';
    case 'disk':
      return 'Could not write the file (disk full or not writable).';
    case 'unsafe_path':
      return 'Nothing was written: a folder or file inside the family data folder is a link to somewhere else. Remove the link on the host, then try again.';
    case 'empty_catalog':
      return error.message ?? EMPTY_AUTHORITATIVE_EMIT;
    case 'dry_run_required':
      return 'Run a dry-run preview before applying.';
    case 'stale_preview':
      return 'Subjects or BankIR changed since the last dry-run. Preview again.';
    case 'prune_confirm_required':
      return error.message ?? 'Confirm the leftover files that Apply will remove.';
    case 'emit_required':
      return 'Confirm apply before opening the dashboard, or skip to keep the sample bank.';
    case 'already_complete':
      return 'Content setup is already finished.';
    case 'missing_provider':
      return 'Choose an AI mode before generating BankIR.';
    case 'missing_key':
      return 'This provider needs a real API key in the env store (fail closed — no stub).';
    case 'missing_local':
      return 'Local generate needs EXAMIFY_INGEST_LOCAL_CMD and/or EXAMIFY_LLM_BASE_URL.';
    case 'missing_cli':
      return 'The AI tool for this mode was not found on this server. Nothing was written.';
    case 'empty_sources':
      return 'No source files for that subject yet. Upload a PDF on the Files step, or add notes.txt to the subject’s folder in this server’s family data folder.';
    case 'sources_unreadable':
      return 'This provider cannot read PDFs directly. Install pdftoppm (poppler-utils) on the host so PDF pages are sent as images, or add a notes.txt for this subject. Nothing was written.';
    case 'sample_collision':
      return onboardingSampleCollisionMessage([]);
    case 'provider_auth':
      return 'The AI provider rejected the API key. Check or replace the key in this step, then generate again. Nothing was written.';
    case 'provider_rate_limited':
      return 'The AI provider is rate-limiting this key, or the account is out of quota. Wait a few minutes or check the account’s usage and billing, then try again. Nothing was written.';
    case 'provider_timeout':
      return 'The AI provider did not answer within 3 minutes. Try again; very large files take longer. Nothing was written.';
    case 'provider_unavailable':
      return 'Could not reach the AI provider, or it is busy right now. Check this host’s network and try again in a few minutes. Nothing was written.';
    case 'provider_error':
      return 'The AI provider returned an error (for example, no credit left on the account, or a model it does not offer). Check the provider account or local command, then try again. Nothing was written.';
    case 'provider_output_invalid':
      return 'The AI replied, but not with questions Examify can use. Try Generate again. Nothing was written.';
    case 'generate_failed':
      return 'Generate failed and nothing was written. Try again, or run the generate command under Power-user commands on the host to see the full error.';
    case 'cancelled':
      return 'Generate cancelled.';
    case 'skipped':
      return 'Generate skipped.';
    case 'needs_confirm':
      return error.irRel
        ? generateIrWriteLabel(error.irRel, false, true)
        : 'Replace the existing BankIR first.';
    case 'already_committed':
      return 'Generate already finished — review the new BankIR.';
    case 'rate_limited':
      return 'Too many key updates. Try again in a bit.';
    case 'host_managed':
      return 'This key is set by the host environment (Docker, systemd, or a parent process). Change it there — a .env write will not survive restart.';
    default:
      return 'Something went wrong.';
  }
}

function modeConfigured(mode: OnboardingAiMode, snapshot: OnboardingSnapshot): boolean {
  switch (mode) {
    case 'cloud':
      return snapshot.anthropicConfigured;
    case 'cloud-openai':
      return snapshot.openaiConfigured;
    case 'claude-cli':
      return snapshot.claudeCliFound;
    case 'codex-cli':
      return snapshot.codexCliFound;
    case 'local-agent':
      return snapshot.localHttpConfigured && snapshot.localModelConfigured;
    case 'local-cli':
      return snapshot.localCmdConfigured;
    case 'skip-stub':
      return true;
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
  const [generateSeed, setGenerateSeed] = useState(ONBOARDING_GENERATE_SEED_DEFAULT);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateNote, setGenerateNote] = useState<string | null>(null);
  const [generateNoteKind, setGenerateNoteKind] = useState<
    'cancelled' | 'skipped' | 'overwrite' | 'finished'
  >('cancelled');
  const [generateCancelAck, setGenerateCancelAck] = useState(false);
  const [irReady, setIrReady] = useState(false);
  const [generateRuns, setGenerateRuns] = useState<Record<string, OnboardingGenerateResult>>({});
  const [activeGenerateId, setActiveGenerateId] = useState<string | null>(null);
  const generateCancelRef = useRef(false);
  const generateCancelTokenRef = useRef<string | null>(null);
  const generateCancellingRef = useRef(false);
  /** Subjects in the running generate, and how many already wrote BankIR (kept on cancel). */
  const generateBatchSizeRef = useRef(0);
  const generateKeptRef = useRef(0);
  const [pending, startTransition] = useTransition();

  const stepIndex = STEPS.findIndex((entry) => entry.id === step);
  const current = STEPS[stepIndex]!;
  const wideStage = step === 'dry-run';
  // Keep Cancel reachable while generate is live. After an acknowledged
  // cancel, do not let the hung Server Action's `pending` freeze the wizard.
  const holdWizard = generateBusy || (pending && !generateCancelAck);
  const navLocked = holdWizard;

  const run = (task: () => Promise<void>) => {
    startTransition(async () => {
      setGenerateCancelAck(false);
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
    if (result.reason === 'cancelled') {
      setGenerateNoteKind('cancelled');
      setGenerateNote('Generate cancelled');
      return false;
    }
    if (result.reason === 'skipped') {
      setGenerateNoteKind('skipped');
      setGenerateNote('Generate skipped');
      return false;
    }
    if (result.reason === 'needs_confirm') {
      return false;
    }
    setError(errorCopy(result, snapshot.aiMode));
    setIssues(result.issues ?? []);
    return false;
  };

  const toggleReplaceSample = (enabled: boolean) =>
    run(async () => {
      const data = new FormData();
      data.set('replaceSample', enabled ? '1' : '0');
      if (applyResult(await setReplaceSampleAction(data))) {
        setValidated(false);
        setDryRun(null);
      }
    });

  const go = (next: StepId) => {
    if (generateBusy) return;
    setError(null);
    setStep(next);
  };

  const skip = () => {
    if (generateBusy) return;
    run(async () => {
      const result = await skipOnboardingAction();
      if (result) applyResult(result);
    });
  };

  return (
    <div className="screen wizard wizard-shell" data-testid="onboarding-wizard">
      <header className="wizard-topbar">
        <p className="wizard-brand">
          Examify <span aria-hidden>·</span> Content setup
        </p>
        {step !== 'welcome' && step !== 'ready' ? (
          <details className="wizard-skip-menu">
            <summary>Skip</summary>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={navLocked}
              data-testid="wizard-skip"
              onClick={skip}
            >
              Skip to dashboard
            </button>
          </details>
        ) : (
          <span className="wizard-topbar-slot" />
        )}
      </header>

      <div className="wizard-body">
        <nav className="wizard-rail" aria-label="Setup steps" data-testid="wizard-rail">
          <ol className="wizard-rail-list">
            {STEPS.map((entry, index) => {
              const state =
                index < stepIndex ? 'done' : index === stepIndex ? 'active' : 'upcoming';
              const clickable = index <= stepIndex && entry.id !== step;
              return (
                <li key={entry.id} className={`wizard-rail-item ${state}`}>
                  <button
                    type="button"
                    className="wizard-rail-btn"
                    aria-current={index === stepIndex ? 'step' : undefined}
                    disabled={!clickable || navLocked}
                    onClick={() => go(entry.id)}
                  >
                    <span className="wizard-rail-index" aria-hidden>
                      {state === 'done' ? UIcon.check : index + 1}
                    </span>
                    <span className="wizard-rail-label">{entry.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="wizard-column">
          {step !== 'welcome' ? (
            <div className="wizard-progress" data-testid="wizard-progress">
              <p className="wizard-progress-label">
                Step {stepIndex + 1} of {STEPS.length} <span aria-hidden>·</span> {current.label}
              </p>
              <div
                className="wizard-progress-track"
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={STEPS.length}
                aria-valuenow={stepIndex + 1}
                aria-label={`${current.label}, step ${stepIndex + 1} of ${STEPS.length}`}
              >
                <span
                  className="wizard-progress-fill"
                  style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
                />
              </div>
            </div>
          ) : null}

          <div
            className={'wizard-stage' + (wideStage ? ' wizard-stage-wide' : '')}
            data-testid="wizard-stage"
          >
            {step !== 'welcome' ? (
              <div className="wizard-stage-head">
                <h1 className="display-title">{current.label}</h1>
                <p className="wizard-help">{STAGE_HELP[step]}</p>
              </div>
            ) : null}

            {step === 'welcome' ? <WelcomeStep /> : null}

            {step === 'subjects' ? (
              <SubjectsStep
                snapshot={snapshot}
                pending={holdWizard}
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
                pending={holdWizard}
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
                pending={holdWizard}
                generateBusy={generateBusy}
                generateSeed={generateSeed}
                generateRuns={generateRuns}
                activeGenerateId={activeGenerateId}
                irReady={irReady}
                onSeed={setGenerateSeed}
                onSelect={(mode) =>
                  run(async () => {
                    const data = new FormData();
                    data.set('aiMode', mode);
                    applyResult(await setOnboardingAiModeAction(data));
                  })
                }
                onAnthropicKey={async (data) => {
                  try {
                    const result = await setOnboardingAnthropicKeyAction(data);
                    return applyResult(result);
                  } catch (caught) {
                    if (caught && typeof caught === 'object' && 'digest' in caught) throw caught;
                    setError('Something went wrong.');
                    return false;
                  }
                }}
                onOpenAiKey={async (data) => {
                  try {
                    const result = await setOnboardingOpenAiKeyAction(data);
                    return applyResult(result);
                  } catch (caught) {
                    if (caught && typeof caught === 'object' && 'digest' in caught) throw caught;
                    setError('Something went wrong.');
                    return false;
                  }
                }}
                onCancel={() => {
                  void (async () => {
                    if (generateCancellingRef.current) return;
                    const token = generateCancelTokenRef.current;
                    if (!token) {
                      setError('Could not cancel generate.');
                      return;
                    }
                    generateCancellingRef.current = true;
                    try {
                      // Await the concurrent route. Do not claim cancelled until it records the token.
                      const outcome = await postOnboardingGenerateCancel(token);
                      if (outcome === 'failed') {
                        setError('Could not cancel generate.');
                        return;
                      }
                      // Recorded either way: the server now refuses any later subject
                      // of this batch, so the loop stops after the current one.
                      generateCancelRef.current = true;
                      if (generateCancelTokenRef.current !== token) return;
                      setError(null);
                      if (outcome === 'already_committed' && generateBatchSizeRef.current <= 1) {
                        // Nothing left to stop: this subject already wrote its BankIR.
                        setGenerateNoteKind('finished');
                        setGenerateNote(ONBOARDING_GENERATE_ALREADY_FINISHED);
                        return;
                      }
                      setGenerateNoteKind('cancelled');
                      setGenerateNote(onboardingGenerateCancelledNote(generateKeptRef.current));
                      setGenerateBusy(false);
                      setGenerateCancelAck(true);
                      setActiveGenerateId(null);
                    } finally {
                      generateCancellingRef.current = false;
                    }
                  })();
                }}
                onGoValidate={() => go('validate')}
                onToggleReplace={toggleReplaceSample}
                onGenerate={(subjectIds) => {
                  if (generateBusy || subjectIds.length === 0) return;
                  const colliding = onboardingGenerateOverwriteSubjects(
                    snapshot.subjects,
                    subjectIds,
                  );
                  if (colliding.length > 0) {
                    setGenerateNoteKind('overwrite');
                    setGenerateNote(
                      colliding
                        .map((subject) =>
                          generateIrWriteLabel(onboardingSubjectIrRel(subject.id), false, true),
                        )
                        .join(' · '),
                    );
                    const decision = confirmOnboardingIrOverwrite(colliding, (message) =>
                      window.confirm(message),
                    );
                    if (decision === 'skip') {
                      setGenerateNoteKind('skipped');
                      setGenerateNote('Generate skipped');
                      return;
                    }
                  }

                  const token = crypto.randomUUID();
                  generateCancelTokenRef.current = token;
                  generateCancelRef.current = false;
                  generateBatchSizeRef.current = subjectIds.length;
                  generateKeptRef.current = 0;
                  // Set outside the transition: React holds updates made inside an
                  // async transition until the whole run settles, which would keep
                  // Cancel and the first subject's progress hidden until the end.
                  setError(null);
                  setGenerateCancelAck(false);
                  setGenerateNote(null);
                  setGenerateBusy(true);
                  setActiveGenerateId(subjectIds[0] ?? null);
                  run(async () => {
                    let kept = 0;
                    let cancelled = false;
                    let failure: OnboardingActionError | null = null;
                    // Sample-id subjects are refused before any provider call, so the
                    // rest of a batch still runs; they are named together at the end.
                    const sampleCollisions: string[] = [];
                    const recordSuccess = (
                      subjectId: string,
                      result: {
                        snapshot: OnboardingSnapshot;
                        result: OnboardingGenerateResult;
                      },
                    ) => {
                      setSnapshot(result.snapshot);
                      setGenerateRuns((currentRuns) => ({
                        ...currentRuns,
                        [subjectId]: result.result,
                      }));
                      setDryRun(null);
                      setValidated(false);
                      if (!result.result.wroteIr) return;
                      kept += 1;
                      if (generateCancelTokenRef.current === token) generateKeptRef.current = kept;
                    };
                    try {
                      for (const subjectId of subjectIds) {
                        // A cancel (or an already-committed ack) stops before the next
                        // subject; the server refuses this token from now on anyway.
                        if (generateCancelRef.current) {
                          cancelled = true;
                          break;
                        }
                        setActiveGenerateId(subjectId);
                        const data = new FormData();
                        data.set('subjectId', subjectId);
                        data.set('seed', String(generateSeed));
                        data.set('cancelToken', token);
                        const subject = snapshot.subjects.find((row) => row.id === subjectId);
                        const label = subject?.label ?? subjectId;
                        if (subject?.hasIr) data.set('force', '1');
                        let result = await generateOnboardingSubjectAction(data);
                        if (!result.ok && result.reason === 'needs_confirm') {
                          const irRel = result.irRel ?? onboardingSubjectIrRel(subjectId);
                          setGenerateNoteKind('overwrite');
                          setGenerateNote(generateIrWriteLabel(irRel, false, true));
                          if (!window.confirm(`Replace existing BankIR for ${label}?`)) {
                            setGenerateNoteKind('skipped');
                            setGenerateNote('Generate skipped');
                            continue;
                          }
                          data.set('force', '1');
                          result = await generateOnboardingSubjectAction(data);
                        }
                        if (result.ok) {
                          recordSuccess(subjectId, result);
                          continue;
                        }
                        if (result.reason === 'cancelled' || generateCancelRef.current) {
                          cancelled = true;
                          break;
                        }
                        if (result.reason === 'skipped') {
                          setGenerateNoteKind('skipped');
                          setGenerateNote('Generate skipped');
                          continue;
                        }
                        if (result.reason === 'sample_collision') {
                          sampleCollisions.push(label);
                          continue;
                        }
                        failure = result;
                        break;
                      }
                      // Keep IR-ready for subjects that already finished (including generate-all cancel).
                      if (kept > 0) setIrReady(true);
                      // After an acknowledged cancel a newer run may own the status line.
                      if (generateCancelTokenRef.current !== token) return;
                      if (cancelled) {
                        setGenerateNoteKind('cancelled');
                        setGenerateNote(onboardingGenerateCancelledNote(kept));
                      } else if (generateCancelRef.current) {
                        // Cancel arrived after the last subject had already written IR.
                        setGenerateNoteKind('finished');
                        setGenerateNote(ONBOARDING_GENERATE_ALREADY_FINISHED);
                      }
                      const messages: string[] = [];
                      if (sampleCollisions.length > 0) {
                        messages.push(onboardingSampleCollisionMessage(sampleCollisions));
                      }
                      if (failure && failure.reason !== 'needs_confirm') {
                        messages.push(errorCopy(failure, snapshot.aiMode));
                      }
                      if (messages.length > 0) setError(messages.join(' '));
                    } finally {
                      if (generateCancelTokenRef.current === token) {
                        generateCancelTokenRef.current = null;
                        generateCancelRef.current = false;
                        setActiveGenerateId(null);
                        setGenerateBusy(false);
                      }
                    }
                  });
                }}
              />
            ) : null}

            {step === 'validate' ? (
              <ValidateStep
                dataDirDisplay={snapshot.dataDirDisplay}
                pending={holdWizard}
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
                pending={holdWizard}
                dryRun={dryRun}
                onToggleReplace={toggleReplaceSample}
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
                pending={holdWizard}
                applyState={applyState}
                hasDryRun={Boolean(snapshot.hasDryRun && dryRun)}
                deletes={dryRun ? onboardingPruneEntries(dryRun.plan) : []}
                onApply={() =>
                  run(async () => {
                    const deletes = dryRun ? onboardingPruneEntries(dryRun.plan) : [];
                    const pruneMessage = onboardingPruneConfirmMessage(deletes);
                    if (pruneMessage && !window.confirm(pruneMessage)) {
                      return;
                    }
                    setApplyState({ status: 'applying' });
                    const data = new FormData();
                    if (deletes.length > 0) data.set('confirmPrune', '1');
                    const result = await applyOnboardingEmitAction(data);
                    if (result.ok) {
                      setSnapshot(result.snapshot);
                      setGenerateNote(null);
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
                snapshot={snapshot}
                applyState={applyState}
                canInvite={canInvite}
                pendingInvites={pendingInvites}
                members={members}
                authMode={authMode}
              />
            ) : null}

            {generateNote ? (
              <p
                className="wizard-callout"
                data-testid={
                  generateNoteKind === 'skipped'
                    ? 'wizard-generate-skipped'
                    : generateNoteKind === 'overwrite'
                      ? 'wizard-generate-overwrite'
                      : generateNoteKind === 'finished'
                        ? 'wizard-generate-finished'
                        : 'wizard-generate-cancelled'
                }
              >
                {generateNote}
              </p>
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
          </div>

          <footer className="wizard-footer" data-testid="wizard-footer">
            <div className="wizard-footer-actions">
              {step !== 'welcome' && step !== 'ready' ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={navLocked}
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
                  disabled={holdWizard}
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
                  disabled={holdWizard || snapshot.subjects.length < 1}
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
                  disabled={navLocked}
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
                  disabled={holdWizard || !validated}
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
                  disabled={holdWizard || !dryRun || !snapshot.hasDryRun}
                  data-testid="wizard-to-apply"
                  onClick={() => {
                    setApplyState({ status: 'idle' });
                    go('apply');
                  }}
                >
                  Looks good
                </button>
              ) : null}

              {step === 'apply' && applyState.status === 'success' ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={holdWizard}
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
                  disabled={holdWizard}
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
              ) : null}
            </div>

            {step === 'welcome' ? (
              <button
                type="button"
                className="btn btn-quiet"
                disabled={navLocked}
                data-testid="wizard-skip"
                onClick={skip}
              >
                Use sample bank for now
              </button>
            ) : null}
          </footer>
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="wizard-welcome" data-testid="wizard-welcome">
      <p className="eyebrow">First-run</p>
      <h1 className="display-title">Set up your family’s content</h1>
      <p className="wizard-help wizard-help-lead">
        Add subjects, store study files on this host, then generate and review BankIR before
        anything is applied. The sample bank stays usable if you skip.
      </p>
      <ul className="wizard-benefits">
        <li>
          <span className="wizard-benefit-icon" aria-hidden>
            <SubjectIcon name="maths" size={26} />
          </span>
          <span>
            <strong>Subjects you choose</strong>
            <span>Build a short family catalog — one subject is enough to start.</span>
          </span>
        </li>
        <li>
          <span className="wizard-benefit-icon" aria-hidden>
            {MailIconDoc}
          </span>
          <span>
            <strong>Local study files</strong>
            <span>
              PDFs you upload, plus notes.txt and other CLI sources generate already reads. Stored
              on this host, sent to Anthropic or OpenAI only when you generate with that provider,
              and never in the public bank.
            </span>
          </span>
        </li>
        <li>
          <span className="wizard-benefit-icon" aria-hidden>
            {UIcon.check}
          </span>
          <span>
            <strong>Generate, then review</strong>
            <span>Draft BankIR, validate, and preview the plan before apply.</span>
          </span>
        </li>
      </ul>
    </div>
  );
}

const MailIconDoc = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="5" y="3.5" width="14" height="17" rx="2.4" fill="var(--accent-soft)" />
    <path d="M8 8h8M8 12h8M8 16h5" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

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
  const [idTouched, setIdTouched] = useState(false);
  const [adding, setAdding] = useState(snapshot.subjects.length === 0);
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editId, setEditId] = useState('');
  const [editIcon, setEditIcon] = useState<SubjectIconOption>('maths');
  const canAdd = id.trim().length > 0 && label.trim().length > 0;
  const sampleMatch = snapshot.sampleSubjects.find(
    (sample) => sample.id === id.trim().toLowerCase(),
  );
  const builtinMatch = snapshot.builtinSubjects.find(
    (builtin) => builtin.id === id.trim().toLowerCase(),
  );

  return (
    <div className="wizard-panel" data-testid="wizard-subjects">
      <div className="wizard-subjects-layout">
        {snapshot.subjects.length === 0 ? (
          <p className="wizard-empty" data-testid="wizard-subjects-empty">
            No subjects yet. Add one to continue — a label is enough; the id is suggested for you.
          </p>
        ) : (
          <ul className="wizard-list">
            {snapshot.subjects.map((subject) => (
              <li key={subject.id} className="wizard-card">
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
                  <span className="wizard-card-copy">
                    <strong>{subject.label}</strong>
                    <span className="invite-meta">{subject.id}</span>
                  </span>
                )}
                {editing === subject.id ? null : (
                  <details className="wizard-card-menu">
                    <summary aria-label={`Actions for ${subject.label}`}>⋯</summary>
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
                        if (
                          !window.confirm(
                            `Delete subject “${subject.label}”? This removes its BankIR and study files. This cannot be undone.`,
                          )
                        ) {
                          return;
                        }
                        const data = new FormData();
                        data.set('id', subject.id);
                        onDelete(data);
                      }}
                    >
                      Delete
                    </button>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}

        {adding ? (
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
              setIdTouched(false);
              if (snapshot.subjects.length > 0) setAdding(false);
            }}
          >
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
                onChange={(event) => {
                  const next = event.target.value;
                  setLabel(next);
                  if (!idTouched) setId(suggestSubjectId(next));
                }}
                data-testid="wizard-subject-label"
              />
            </div>
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
                onChange={(event) => {
                  setIdTouched(true);
                  setId(event.target.value);
                }}
                data-testid="wizard-subject-id"
              />
              {label.trim().length > 0 && id.trim().length === 0 ? (
                <p className="login-fine" data-testid="wizard-subject-id-hint">
                  Could not suggest an id from that label. Type a kebab-case id (a-z, digits,
                  hyphens).
                </p>
              ) : null}
              {sampleMatch ? (
                <p className="login-fine" data-testid="wizard-subject-id-sample-hint">
                  “{sampleMatch.id}” is the id of the sample {sampleMatch.label} subject. Generated
                  questions for it would replace the sample ones, so generate asks you to allow that
                  first. Use another id (for example {sampleMatch.id}-2) to keep both.
                </p>
              ) : null}
              {builtinMatch ? (
                <p className="login-fine" data-testid="wizard-subject-id-builtin-hint">
                  “{builtinMatch.id}” is the id of the built-in {builtinMatch.label} subject. Yours
                  replaces it for your family after Apply. Use another id (for example{' '}
                  {builtinMatch.id}-2) to keep both.
                </p>
              ) : null}
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
            <div className="wizard-add-actions">
              <button
                className="btn btn-ghost"
                type="submit"
                disabled={pending || !canAdd}
                data-testid="wizard-add-subject-submit"
              >
                {pending ? 'Adding…' : 'Add subject'}
              </button>
              {snapshot.subjects.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => setAdding(false)}
                  disabled={pending}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setAdding(true)}>
            Add a subject
          </button>
        )}
      </div>
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
  const [focusId, setFocusId] = useState(snapshot.subjects[0]?.id ?? '');
  const focused =
    snapshot.subjects.find((subject) => subject.id === focusId) ?? snapshot.subjects[0] ?? null;

  if (snapshot.subjects.length === 0 || !focused) {
    return (
      <p className="wizard-empty" data-testid="wizard-files-empty">
        Add a subject first to attach study files. Generate also reads notes.txt and other CLI
        sources already in the subject folder.
      </p>
    );
  }

  return (
    <div className="wizard-panel" data-testid="wizard-files">
      <p className="wizard-path-hint">
        Uploaded PDFs stay in this server’s family data folder. Generate also reads notes.txt and
        other local sources in the subject folder — never the bank.
      </p>
      <div className="wizard-files-layout">
        {snapshot.subjects.length > 1 ? (
          <div className="wizard-files-nav" aria-label="Subjects">
            {snapshot.subjects.map((subject) => {
              const selected = subject.id === focused.id;
              return (
                <button
                  key={subject.id}
                  type="button"
                  aria-pressed={selected}
                  className={'wizard-file-tab' + (selected ? ' selected' : '')}
                  data-testid={`wizard-file-tab-${subject.id}`}
                  onClick={() => setFocusId(subject.id)}
                >
                  {subject.label}
                  <span className="invite-meta">{onboardingSourceCountLabel(subject)}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <SubjectDropzone
          subject={focused}
          pending={pending}
          onAttach={onAttach}
          onDetach={onDetach}
        />
      </div>
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
      {subject.hasIr && subject.generateSources.length === 0 && subject.sourceFiles.length === 0 ? (
        <p className="login-fine" data-testid={`wizard-files-authored-${subject.id}`}>
          Hand-authored BankIR is already here. Generate is optional — add a PDF or a notes.txt if
          you want to draft from sources.
        </p>
      ) : null}
      {onboardingSourceFileNames(subject).length > 0 ? (
        <ul className="wizard-file-chips" data-testid={`wizard-file-sources-${subject.id}`}>
          {onboardingSourceFileNames(subject).map((name) => {
            const uploaded = subject.sourceFiles.includes(name);
            return (
              <li key={name} className="wizard-file-chip">
                <span>{name}</span>
                {uploaded ? (
                  <button
                    type="button"
                    className="btn btn-ghost invite-revoke"
                    disabled={pending}
                    data-testid={`wizard-detach-${subject.id}-${name}`}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Remove “${name}” from ${subject.label}? This cannot be undone.`,
                        )
                      ) {
                        return;
                      }
                      const data = new FormData();
                      data.set('subjectId', subject.id);
                      data.set('filename', name);
                      onDetach(data);
                    }}
                  >
                    Remove
                  </button>
                ) : (
                  <span className="invite-meta">local source</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
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
        {subject.sourceFiles.length === 0 ? 'Drop a PDF here, or choose a file' : 'Add another PDF'}
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

function EnvKeyPanel({
  testId,
  label,
  hostName,
  configured,
  liveTest,
  writeBlocked,
  pending,
  onSave,
  onClear,
}: {
  testId: string;
  label: string;
  hostName: string;
  configured: boolean;
  liveTest: boolean;
  writeBlocked: boolean;
  pending: boolean;
  onSave: (key: string) => Promise<boolean>;
  onClear: () => void;
}) {
  const [rotating, setRotating] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = pending || saving;
  const sentinel = liveTest;
  const locked = writeBlocked;
  const canMutate = !writeBlocked;
  const showField = canMutate && (!configured || rotating);
  const inputId = `${testId}-input`;

  return (
    <div className="wizard-secret" data-testid={testId}>
      <p className="login-fine">
        {locked
          ? `${hostName} is set by the host environment (Docker, systemd, or a parent process). Rotate or clear it there — a .env write will not survive restart.`
          : sentinel
            ? 'A test sentinel is present (not a usable key). Clear it, or save a real key. The value is never shown.'
            : 'Saved on this host in the same .env store as install.sh. The value is never shown again.'}
      </p>
      {locked ? null : showField ? (
        <form
          className="wizard-secret-form"
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              setSaving(true);
              try {
                const ok = await onSave(value);
                if (ok) {
                  setValue('');
                  setRotating(false);
                }
              } finally {
                setSaving(false);
              }
            })();
          }}
        >
          <label className="field-label" htmlFor={inputId}>
            {label}
          </label>
          <input
            id={inputId}
            className="text-input"
            type="password"
            autoComplete="off"
            value={value}
            disabled={busy}
            data-testid={`${testId}-input`}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="wizard-secret-actions" data-testid={`${testId}-actions`}>
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || value.trim().length < 1}
              data-testid={`${testId}-save`}
            >
              Save key
            </button>
            {rotating ? (
              <button
                className="btn btn-ghost"
                type="button"
                disabled={busy}
                data-testid={`${testId}-cancel`}
                onClick={() => {
                  setRotating(false);
                  setValue('');
                }}
              >
                Cancel
              </button>
            ) : null}
            {sentinel ? (
              <button
                className="btn btn-ghost"
                type="button"
                disabled={busy}
                data-testid={`${testId}-rotate`}
                onClick={() => setRotating(true)}
              >
                Rotate
              </button>
            ) : null}
            {sentinel ? (
              <button
                className="btn btn-ghost"
                type="button"
                disabled={busy}
                data-testid={`${testId}-clear`}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Clear the ${label} from this host’s .env store? Generate and grading that need this key fail closed until you set a new one. A restart will not brick the app.`,
                    )
                  ) {
                    return;
                  }
                  onClear();
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="wizard-secret-actions" data-testid={`${testId}-actions`}>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            data-testid={`${testId}-rotate`}
            onClick={() => setRotating(true)}
          >
            Rotate
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            data-testid={`${testId}-clear`}
            onClick={() => {
              if (
                !window.confirm(
                  `Clear the ${label} from this host’s .env store? Generate and grading that need this key fail closed until you set a new one. A restart will not brick the app.`,
                )
              ) {
                return;
              }
              onClear();
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

function AiStep({
  snapshot,
  pending,
  generateBusy,
  generateSeed,
  generateRuns,
  activeGenerateId,
  irReady,
  onSeed,
  onSelect,
  onAnthropicKey,
  onOpenAiKey,
  onGenerate,
  onCancel,
  onGoValidate,
  onToggleReplace,
}: {
  snapshot: OnboardingSnapshot;
  pending: boolean;
  generateBusy: boolean;
  generateSeed: number;
  generateRuns: Record<string, OnboardingGenerateResult>;
  activeGenerateId: string | null;
  irReady: boolean;
  onSeed: (seed: number) => void;
  onSelect: (mode: OnboardingAiMode) => void;
  onAnthropicKey: (data: FormData) => Promise<boolean>;
  onOpenAiKey: (data: FormData) => Promise<boolean>;
  onGenerate: (subjectIds: string[]) => void;
  onCancel: () => void;
  onGoValidate: () => void;
  onToggleReplace: (enabled: boolean) => void;
}) {
  const provider = snapshot.aiMode ? providerForOnboardingAiMode(snapshot.aiMode) : null;
  const busy = pending || generateBusy;

  return (
    <div className="wizard-panel" data-testid="wizard-ai">
      <p className="login-fine" data-testid="wizard-ai-store">
        Anthropic {snapshot.anthropicConfigured ? 'configured' : 'not configured'} · OpenAI{' '}
        {snapshot.openaiConfigured ? 'configured' : 'not configured'} · Claude Code{' '}
        {snapshot.claudeCliFound ? 'found' : 'not found'} · Codex{' '}
        {snapshot.codexCliFound ? 'found' : 'not found'} · Local endpoint{' '}
        {snapshot.localHttpConfigured ? 'configured' : 'not configured'} · Local command{' '}
        {snapshot.localCmdConfigured ? 'configured' : 'not configured'}
      </p>
      <p className="login-fine" data-testid="wizard-ai-sends">
        When you generate, the subject’s source files (PDFs, notes, images) go to the mode you pick:
        Anthropic or OpenAI with an API key, Claude Code or Codex with their own sign-in (they send
        them to Anthropic or OpenAI), or your own endpoint or command for local. The test stub sends
        nothing.
      </p>
      <p className="login-fine" data-testid="wizard-ai-grading">
        {onboardingMarkingCopy(snapshot.aiMode, snapshot)}
      </p>
      <div className="wizard-modes" role="radiogroup" aria-label="AI setup mode">
        {(Object.keys(AI_COPY) as OnboardingAiMode[]).map((mode) => {
          const selected = snapshot.aiMode === mode;
          const configured = modeConfigured(mode, snapshot);
          const agentCli = isOnboardingAgentCliMode(mode);
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              className={'wizard-mode' + (selected ? ' selected' : '')}
              disabled={busy}
              data-testid={`wizard-ai-${mode}`}
              onClick={() => onSelect(mode)}
            >
              <span className="wizard-mode-head">
                <strong>{AI_COPY[mode].title}</strong>
                {configured ? (
                  <span className="wizard-mode-badge">{agentCli ? 'Found' : 'Configured'}</span>
                ) : null}
              </span>
              <span>{AI_COPY[mode].body}</span>
              <span data-testid={`wizard-ai-${mode}-caps`}>{onboardingAiCapabilityLine(mode)}</span>
            </button>
          );
        })}
      </div>

      {snapshot.aiMode === 'cloud' ? (
        <EnvKeyPanel
          testId="wizard-anthropic-key"
          label="Anthropic API key"
          hostName="Anthropic"
          configured={snapshot.anthropicConfigured}
          liveTest={snapshot.anthropicLiveTest}
          writeBlocked={snapshot.anthropicWriteBlocked}
          pending={busy}
          onSave={async (key) => {
            const data = new FormData();
            data.set('intent', 'set');
            data.set('anthropicApiKey', key);
            return onAnthropicKey(data);
          }}
          onClear={() => {
            const data = new FormData();
            data.set('intent', 'clear');
            onAnthropicKey(data);
          }}
        />
      ) : null}

      {isOnboardingAgentCliMode(snapshot.aiMode) ? (
        <p className="wizard-callout" data-testid="wizard-agent-cli-setup">
          {onboardingAgentCliSetupNote(
            snapshot.aiMode,
            snapshot.aiMode === 'claude-cli' ? snapshot.claudeCliFound : snapshot.codexCliFound,
          )}
        </p>
      ) : null}

      {snapshot.aiMode === 'local-agent' &&
      !(snapshot.localHttpConfigured && snapshot.localModelConfigured) ? (
        <p className="wizard-callout" data-testid="wizard-local-setup">
          {onboardingModeErrorCopy('missing_local', 'local-agent')}
        </p>
      ) : null}

      {snapshot.aiMode === 'local-cli' && !snapshot.localCmdConfigured ? (
        <p className="wizard-callout" data-testid="wizard-local-setup">
          {onboardingModeErrorCopy('missing_local', 'local-cli')}
        </p>
      ) : null}

      {snapshot.aiMode === 'cloud-openai' ? (
        <EnvKeyPanel
          testId="wizard-openai-key"
          label="OpenAI API key"
          hostName="OpenAI"
          configured={snapshot.openaiConfigured}
          liveTest={snapshot.openaiLiveTest}
          writeBlocked={snapshot.openaiWriteBlocked}
          pending={busy}
          onSave={async (key) => {
            const data = new FormData();
            data.set('intent', 'set');
            data.set('openaiApiKey', key);
            return onOpenAiKey(data);
          }}
          onClear={() => {
            const data = new FormData();
            data.set('intent', 'clear');
            onOpenAiKey(data);
          }}
        />
      ) : null}

      {provider ? (
        <div className="wizard-generate" data-testid="wizard-generate">
          <h2 className="wizard-subhead">Generate from local sources</h2>
          <GeneratePanel
            snapshot={snapshot}
            provider={provider}
            busy={busy}
            generateBusy={generateBusy}
            generateSeed={generateSeed}
            generateRuns={generateRuns}
            activeGenerateId={activeGenerateId}
            irReady={irReady}
            onSeed={onSeed}
            onGenerate={onGenerate}
            onCancel={onCancel}
            onGoValidate={onGoValidate}
            onToggleReplace={onToggleReplace}
          />
        </div>
      ) : (
        <p className="wizard-callout" data-testid="wizard-generate-choose-mode">
          Choose a mode to generate BankIR, or continue if you already authored IR by hand.
        </p>
      )}
    </div>
  );
}

function GeneratePanel({
  snapshot,
  provider,
  busy,
  generateBusy,
  generateSeed,
  generateRuns,
  activeGenerateId,
  irReady,
  onSeed,
  onGenerate,
  onCancel,
  onGoValidate,
  onToggleReplace,
}: {
  snapshot: OnboardingSnapshot;
  provider: NonNullable<ReturnType<typeof providerForOnboardingAiMode>>;
  busy: boolean;
  generateBusy: boolean;
  generateSeed: number;
  generateRuns: Record<string, OnboardingGenerateResult>;
  activeGenerateId: string | null;
  irReady: boolean;
  onSeed: (seed: number) => void;
  onGenerate: (subjectIds: string[]) => void;
  onCancel: () => void;
  onGoValidate: () => void;
  onToggleReplace: (enabled: boolean) => void;
}) {
  const batchIds = onboardingGenerateBatchIds(snapshot.subjects);
  const batchOverwrites = onboardingGenerateOverwriteSubjects(snapshot.subjects, batchIds);
  const sampleIdSubjects = onboardingSampleIdSubjects(snapshot.subjects, snapshot.sampleSubjects);
  const sampleIdNames = sampleIdSubjects.map((subject) => `${subject.label} (${subject.id})`);
  return (
    <div className="wizard-generate-panel">
      <PowerUserCommands
        testId="wizard-cli-generate"
        commands={onboardingGenerateAndEmitCli(
          provider,
          generateSeed,
          snapshot.dataDirDisplay,
          snapshot.aiMode ? localTransportForOnboardingAiMode(snapshot.aiMode) : null,
        )}
      />
      {sampleIdSubjects.length > 0 ? (
        <div className="wizard-callout wizard-sample-ids" data-testid="wizard-generate-sample-ids">
          <p>
            {snapshot.replaceSample
              ? `Replacing sample-bank questions is on: questions generated for ${sampleIdNames.join(', ')} replace the matching sample questions when you apply.`
              : `${sampleIdNames.join(', ')} ${sampleIdSubjects.length === 1 ? 'uses the same id as a sample-bank subject' : 'use the same ids as sample-bank subjects'}, so generate refuses ${sampleIdSubjects.length === 1 ? 'it' : 'them'}: the questions would replace sample questions. Allow that here, or rename the subject in Subjects to keep both.`}
          </p>
          <ReplaceSampleCheckbox
            enabled={snapshot.replaceSample}
            pending={busy}
            onToggle={onToggleReplace}
            testId="wizard-generate-replace-sample"
          />
        </div>
      ) : null}
      <details className="wizard-details">
        <summary>Advanced</summary>
        <label className="wizard-advanced">
          <span>Seed</span>
          <input
            className="text-input"
            type="number"
            step={1}
            value={generateSeed}
            disabled={busy}
            aria-label="Generate seed"
            data-testid="wizard-generate-seed"
            onChange={(event) => onSeed(Number.parseInt(event.target.value, 10) || 0)}
          />
        </label>
      </details>
      <div className="wizard-generate-actions">
        {batchOverwrites.length > 0 ? (
          <details className="wizard-details" data-testid="wizard-generate-overwrite-batch">
            <summary>
              {onboardingIrOverwriteConfirmMessage(batchOverwrites) ??
                generateIrWriteLabel(onboardingSubjectIrRel(batchOverwrites[0]!.id), false, true)}
            </summary>
            <ul className="wizard-issues">
              {batchOverwrites.map((subject) => (
                <li key={subject.id}>
                  {subject.label} ·{' '}
                  {generateIrWriteLabel(onboardingSubjectIrRel(subject.id), false, true)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || batchIds.length < 1}
          data-testid="wizard-generate-all"
          onClick={() => onGenerate(batchIds)}
        >
          {generateBusy ? 'Generating…' : 'Generate all'}
        </button>
        {generateBusy ? (
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="wizard-generate-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
      </div>

      {snapshot.subjects.length === 0 ? (
        <p className="wizard-empty" data-testid="wizard-generate-empty">
          Add a subject first. Generate reads PDFs, notes.txt, and other local sources.
        </p>
      ) : (
        <ul className="wizard-list">
          {snapshot.subjects.map((subject) => {
            const run = generateRuns[subject.id];
            const active = activeGenerateId === subject.id;
            return (
              <li key={subject.id} className="wizard-generate-row">
                <div className="wizard-card">
                  <span className="wizard-card-copy">
                    <strong>{subject.label}</strong>
                    <span className="invite-meta">{subject.id}</span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy || subject.generateSources.length < 1}
                    data-testid={`wizard-generate-${subject.id}`}
                    onClick={() => onGenerate([subject.id])}
                  >
                    {active ? 'Generating…' : 'Generate BankIR'}
                  </button>
                </div>
                {subject.hasIr ? (
                  <p className="login-fine" data-testid={`wizard-generate-overwrite-${subject.id}`}>
                    {generateIrWriteLabel(onboardingSubjectIrRel(subject.id), false, true)}
                  </p>
                ) : null}
                {subject.generateSources.length === 0 ? (
                  <p
                    className="login-fine"
                    data-testid={`wizard-generate-no-sources-${subject.id}`}
                  >
                    {subject.hasIr
                      ? 'No generate sources yet (PDFs, notes.txt, or other files). Hand-authored BankIR can skip generate.'
                      : 'No generate sources yet. Add a PDF or a notes.txt (or other CLI source) for this subject.'}
                  </p>
                ) : (
                  <div className="wizard-generate-sources">
                    <p className="login-fine">
                      {subject.generateSources.length} source
                      {subject.generateSources.length === 1 ? '' : 's'}
                    </p>
                    <ul
                      className="wizard-issues"
                      data-testid={`wizard-generate-sources-${subject.id}`}
                    >
                      {subject.generateSources.map((rel) => (
                        <li key={rel}>{rel}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {active ? (
                  <p className="login-fine" data-testid={`wizard-generate-progress-${subject.id}`}>
                    {subject.id} · {provider} · seed {generateSeed} ·{' '}
                    {subject.generateSources.length} source
                    {subject.generateSources.length === 1 ? '' : 's'} · calling provider…
                  </p>
                ) : null}
                {run ? <GenerateRunSummary run={run} /> : null}
              </li>
            );
          })}
        </ul>
      )}

      {irReady ? (
        <p className="wizard-callout" data-testid="wizard-ir-ready">
          IR ready — continue to validate{' '}
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="wizard-generate-to-validate"
            onClick={onGoValidate}
          >
            Validate
          </button>
        </p>
      ) : null}
    </div>
  );
}

function GenerateRunSummary({ run }: { run: OnboardingGenerateResult }) {
  const hashes = Object.entries(run.sourceHashes);
  return (
    <div className="wizard-generate-run" data-testid={`wizard-generate-run-${run.subjectId}`}>
      <p className="login-fine">
        {run.subjectId} · {run.provider}/{run.model} · seed {run.seed} · {run.sourceCount} source
        {run.sourceCount === 1 ? '' : 's'} · {run.cacheHit ? 'cache hit' : 'live call'}
        {run.wroteIr ? ` · ${generateIrWriteLabel(run.irRel, true, run.overwrite)}` : ''}
      </p>
      {hashes.length > 0 ? (
        <details className="wizard-details">
          <summary>Source hashes</summary>
          <ul className="wizard-issues">
            {hashes.map(([rel, hash]) => (
              <li key={rel}>
                {rel} · {hash.slice(0, 12)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function PowerUserCommands({ commands, testId }: { commands: readonly string[]; testId: string }) {
  return (
    <details className="wizard-details">
      <summary>Power-user commands</summary>
      <pre className="wizard-cli" data-testid={testId}>
        {commands.join('\n')}
      </pre>
    </details>
  );
}

/** One household setting, shown on AI setup (sample-id subjects) and under Review › Advanced. */
function ReplaceSampleCheckbox({
  enabled,
  pending,
  onToggle,
  testId,
}: {
  enabled: boolean;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  testId: string;
}) {
  return (
    <label className="wizard-advanced">
      <input
        type="checkbox"
        checked={enabled}
        disabled={pending}
        data-testid={testId}
        onChange={(event) => onToggle(event.target.checked)}
      />
      Allow --replace-sample (overwrite colliding sample-bank ids)
    </label>
  );
}

function ReplaceSampleToggle({
  enabled,
  pending,
  onToggle,
}: {
  enabled: boolean;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <details className="wizard-details">
      <summary>Advanced</summary>
      <ReplaceSampleCheckbox
        enabled={enabled}
        pending={pending}
        onToggle={onToggle}
        testId="wizard-replace-sample"
      />
    </details>
  );
}

function ValidateStep({
  dataDirDisplay,
  pending,
  validated,
  onValidate,
}: {
  dataDirDisplay: string;
  pending: boolean;
  validated: boolean;
  onValidate: () => void;
}) {
  return (
    <div className="wizard-panel" data-testid="wizard-validate-panel">
      <PowerUserCommands testId="wizard-cli" commands={onboardingIngestCli(dataDirDisplay)} />
      <button
        type="button"
        className="btn btn-primary wizard-validate-btn"
        disabled={pending}
        data-testid="wizard-validate"
        onClick={onValidate}
      >
        {pending ? 'Checking…' : validated ? 'Re-run' : 'Validate'}
      </button>
      {validated ? (
        <p className="wizard-callout" data-testid="wizard-validate-ok">
          BankIR is valid. Continue to review.
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
  const deletes = dryRun?.plan.filter((entry) => entry.action === 'delete') ?? [];
  const shadowNotice = dryRun ? onboardingShadowNotice(dryRun.shadows) : null;

  return (
    <div className="wizard-panel" data-testid="wizard-dry-run">
      <PowerUserCommands
        testId="wizard-cli-emit"
        commands={onboardingIngestCli(snapshot.dataDirDisplay).slice(1)}
      />
      <ReplaceSampleToggle
        enabled={snapshot.replaceSample}
        pending={pending}
        onToggle={onToggleReplace}
      />
      <button
        type="button"
        className="btn btn-ghost"
        disabled={pending}
        data-testid="wizard-preview"
        onClick={onPreview}
      >
        {pending ? 'Previewing…' : dryRun ? 'Re-run review' : 'Review plan'}
      </button>
      {dryRun ? (
        <div data-testid="wizard-dry-run-summary">
          <div className="wizard-summary-card">
            <p>
              <strong>+{dryRun.questionCount}</strong>
              <span>questions</span>
            </p>
            <p>
              <strong>{dryRun.subjectCount}</strong>
              <span>subject{dryRun.subjectCount === 1 ? '' : 's'}</span>
            </p>
            <p>
              <strong>{dryRun.collisions.length}</strong>
              <span>collision{dryRun.collisions.length === 1 ? '' : 's'}</span>
            </p>
          </div>
          {dryRun.collisions.length > 0 ? (
            <ul className="wizard-issues" data-testid="wizard-collisions">
              {dryRun.collisions.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          ) : null}
          {shadowNotice ? (
            <p className="wizard-callout" data-testid="wizard-shadows">
              {shadowNotice}
            </p>
          ) : null}
          {deletes.length > 0 ? (
            <p className="wizard-callout" data-testid="wizard-planned-deletes">
              Planned deletes: {deletes.map((entry) => entry.path).join(', ')}
            </p>
          ) : null}
          <div className="wizard-scroll-panel">
            <ul className="wizard-plan" data-testid="wizard-plan">
              {dryRun.plan.map((entry) => (
                <li key={entry.path}>
                  <span className="wizard-plan-action">{entry.action}</span> {entry.path}
                </li>
              ))}
            </ul>
          </div>
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
  deletes,
  onApply,
}: {
  pending: boolean;
  applyState:
    | { status: 'idle' }
    | { status: 'applying' }
    | { status: 'success'; written: number; questionCount: number; subjectCount: number }
    | { status: 'error'; message: string };
  hasDryRun: boolean;
  deletes: OnboardingPlanEntry[];
  onApply: () => void;
}) {
  return (
    <div className="wizard-panel" data-testid="wizard-apply">
      {deletes.length > 0 && applyState.status === 'idle' ? (
        <p className="wizard-callout" data-testid="wizard-apply-prune">
          Apply will remove leftover generated files:{' '}
          {deletes.map((entry) => entry.path).join(', ')}. Cancel the confirm to keep them.
        </p>
      ) : null}
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
        <p className="wizard-callout" data-testid="wizard-applied">
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
  snapshot,
  applyState,
  canInvite,
  pendingInvites,
  members,
  authMode,
}: {
  snapshot: OnboardingSnapshot;
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
    <div className="wizard-panel wizard-ready" data-testid="wizard-ready">
      <div className="wizard-ready-mark" aria-hidden>
        {UIcon.check}
      </div>
      {snapshot.liveSubjects.length > 0 ? (
        <ul className="wizard-issues" data-testid="wizard-ready-subjects">
          {snapshot.liveSubjects.map((subject) => (
            <li key={subject.id} data-testid={`wizard-ready-subject-${subject.id}`}>
              {subject.label} ({subject.id}) · {subject.questionCount} question
              {subject.questionCount === 1 ? '' : 's'}
            </li>
          ))}
        </ul>
      ) : null}
      {applyState.status === 'success' ? (
        <p className="login-fine" data-testid="wizard-ready-counts">
          {applyState.questionCount} questions across {applyState.subjectCount} generated subject
          {applyState.subjectCount === 1 ? '' : 's'}.
        </p>
      ) : (
        <p className="login-fine">You can finish content setup later from the parent dashboard.</p>
      )}
      {canInvite ? (
        <details className="wizard-details wizard-ready-invite">
          <summary>Invite family</summary>
          <HouseholdInvites pending={pendingInvites} members={members} authMode={authMode} />
        </details>
      ) : null}
    </div>
  );
}
