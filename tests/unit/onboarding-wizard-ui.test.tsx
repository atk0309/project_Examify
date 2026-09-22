/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingSnapshot } from '@/lib/onboarding-types';

const applyOnboardingEmitAction = vi.fn();
const previewOnboardingEmitAction = vi.fn();
const validateOnboardingAction = vi.fn();
const setOnboardingAiModeAction = vi.fn();
const setOnboardingAnthropicKeyAction = vi.fn();
const generateOnboardingSubjectAction = vi.fn();
const setReplaceSampleAction = vi.fn();
const attachOnboardingPdfAction = vi.fn();

vi.mock('@/actions/onboarding', () => ({
  addOnboardingSubjectAction: vi.fn(),
  applyOnboardingEmitAction: (...args: unknown[]) => applyOnboardingEmitAction(...args),
  attachOnboardingPdfAction: (...args: unknown[]) => attachOnboardingPdfAction(...args),
  deleteOnboardingSubjectAction: vi.fn(),
  detachOnboardingPdfAction: vi.fn(),
  finishOnboardingAction: vi.fn(),
  generateOnboardingSubjectAction: (...args: unknown[]) => generateOnboardingSubjectAction(...args),
  previewOnboardingEmitAction: (...args: unknown[]) => previewOnboardingEmitAction(...args),
  renameOnboardingSubjectAction: vi.fn(),
  setOnboardingAiModeAction: (...args: unknown[]) => setOnboardingAiModeAction(...args),
  setOnboardingAnthropicKeyAction: (...args: unknown[]) => setOnboardingAnthropicKeyAction(...args),
  setOnboardingOpenAiKeyAction: vi.fn(),
  setReplaceSampleAction: (...args: unknown[]) => setReplaceSampleAction(...args),
  skipOnboardingAction: vi.fn(),
  validateOnboardingAction: (...args: unknown[]) => validateOnboardingAction(...args),
}));

import { OnboardingWizard } from '@/components/exam/OnboardingWizard';
import {
  evaluateSecretActionClearance,
  isEmptyLayoutBox,
  type LayoutBox,
} from '../helpers/wizard-footer-clearance';

function toLayoutBox(rect: DOMRect): LayoutBox {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function snapshot(overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    subjects: [
      {
        id: 'demo',
        label: 'Generate demo',
        icon: 'biology',
        hasIr: false,
        sourceFiles: [],
        generateSources: ['content/subjects/demo/notes.txt'],
      },
      {
        id: 'biology',
        label: 'Biology',
        icon: 'biology',
        hasIr: true,
        sourceFiles: [],
        generateSources: [],
      },
    ],
    sampleSubjects: [{ id: 'maths', label: 'Maths' }],
    aiMode: null,
    replaceSample: false,
    hasDryRun: false,
    hasApplied: false,
    anthropicConfigured: false,
    openaiConfigured: false,
    anthropicPresent: true,
    openaiPresent: false,
    anthropicLiveTest: true,
    openaiLiveTest: false,
    anthropicHostManaged: true,
    openaiHostManaged: false,
    anthropicWriteBlocked: false,
    openaiWriteBlocked: false,
    localAgentConfigured: false,
    gradingStubActive: false,
    liveSubjects: [
      { id: 'maths', label: 'Maths', questionCount: 12 },
      { id: 'biology', label: 'Biology', questionCount: 6 },
    ],
    ...overrides,
  };
}

describe('OnboardingWizard majors UI', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    applyOnboardingEmitAction.mockReset();
    previewOnboardingEmitAction.mockReset();
    validateOnboardingAction.mockReset();
    setOnboardingAiModeAction.mockReset();
    setOnboardingAnthropicKeyAction.mockReset();
    generateOnboardingSubjectAction.mockReset();
    setReplaceSampleAction.mockReset();
    attachOnboardingPdfAction.mockReset();
    window.confirm = vi.fn(() => true);
  });

  it('shows notes.txt sources instead of a 0 PDFs dead-end', () => {
    render(
      <OnboardingWizard
        snapshot={snapshot()}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-files')).toBeVisible();
    expect(screen.getByTestId('wizard-files')).toHaveTextContent('notes.txt');
    expect(screen.getByTestId('wizard-files')).toHaveTextContent('1 source');
    expect(screen.getByTestId('wizard-files')).not.toHaveTextContent('0 PDFs');
    expect(screen.getByTestId('wizard-file-sources-demo')).toHaveTextContent('notes.txt');
    expect(screen.getByTestId('wizard-file-tab-demo')).toHaveTextContent('1 source');
    expect(screen.getByTestId('wizard-file-tab-biology')).toHaveTextContent('Hand-authored');
    expect(screen.getByTestId('wizard-file-tab-biology')).not.toHaveTextContent('No files yet');
    fireEvent.click(screen.getByTestId('wizard-file-tab-biology'));
    expect(screen.getByTestId('wizard-files-authored-biology')).toHaveTextContent(
      'Hand-authored BankIR',
    );
    expect(screen.queryByTestId('wizard-file-sources-biology')).toBeNull();
  });

  it('says honestly what leaves the host: files on generate, answers for marking', async () => {
    setOnboardingAiModeAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ aiMode: 'cloud' }),
    });
    render(
      <OnboardingWizard
        snapshot={snapshot()}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    const welcome = screen.getByTestId('wizard-welcome');
    expect(welcome).toHaveTextContent('Stored on this host');
    expect(welcome).toHaveTextContent(
      'sent to Anthropic or OpenAI only when you generate with that provider',
    );
    expect(welcome).toHaveTextContent('never in the public bank');
    expect(welcome).not.toHaveTextContent('stay on this host');

    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-files')).toBeVisible();
    expect(screen.getByText(/Study files are stored on this host/)).toHaveTextContent(
      'They go to Anthropic or OpenAI only when you generate with that provider',
    );

    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-ai-sends')).toHaveTextContent(
      'the subject’s source files (PDFs, notes, images) go to the mode you pick',
    );
    // Marking uses the Anthropic key whatever generate mode is picked, so the
    // disclosure shows before (and independent of) any mode choice.
    const grading = screen.getByTestId('wizard-ai-grading');
    expect(grading).toHaveTextContent('Marking is separate from generate');
    expect(grading).toHaveTextContent('saved but not marked (they count as not correct)');
    expect(grading).toHaveTextContent('sent to Anthropic with its question and rubric');

    fireEvent.click(screen.getByTestId('wizard-ai-cloud'));
    await screen.findByTestId('wizard-anthropic-key');
    expect(screen.getAllByTestId('wizard-ai-grading')).toHaveLength(1);
  });

  it('says the test placeholder stub-marks answers when that stub is active', () => {
    render(
      <OnboardingWizard
        snapshot={snapshot({ aiMode: 'skip-stub', gradingStubActive: true })}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    const grading = screen.getByTestId('wizard-ai-grading');
    expect(grading).toHaveTextContent('local stub full mark and nothing is sent');
    expect(grading).not.toHaveTextContent('saved but not marked');
  });

  it.each(['cloud-openai', 'local-agent', 'skip-stub'] as const)(
    'discloses marking via Anthropic in %s mode when the key is configured',
    (aiMode) => {
      render(
        <OnboardingWizard
          snapshot={snapshot({ aiMode, anthropicConfigured: true })}
          pendingInvites={[]}
          members={[]}
          canInvite={false}
          authMode="magic-link"
        />,
      );
      fireEvent.click(screen.getByTestId('wizard-get-started'));
      fireEvent.click(screen.getByTestId('wizard-next'));
      fireEvent.click(screen.getByTestId('wizard-next'));
      expect(screen.queryByTestId('wizard-anthropic-key')).toBeNull();
      expect(screen.getByTestId('wizard-ai-grading')).toHaveTextContent(
        'each free-text answer is sent to Anthropic with its question and rubric, whichever mode you pick here',
      );
    },
  );

  it('keeps Clear and Rotate visible for a boot test sentinel', async () => {
    setOnboardingAiModeAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ aiMode: 'cloud' }),
    });
    render(
      <OnboardingWizard
        snapshot={snapshot()}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-ai-cloud'));
    expect(await screen.findByTestId('wizard-ai-store')).toHaveTextContent('not configured');
    expect(screen.getByTestId('wizard-anthropic-key-clear')).toBeVisible();
    expect(screen.getByTestId('wizard-anthropic-key-rotate')).toBeVisible();
    expect(screen.getByTestId('wizard-anthropic-key')).toHaveTextContent('test sentinel');
    expect(screen.getByTestId('wizard-anthropic-key')).not.toHaveTextContent('ANTHROPIC_API_KEY=');
    expect(screen.getByTestId('wizard-generate')).toHaveTextContent('Generate from local sources');
    expect(screen.getByTestId('wizard-generate-sources-demo')).toHaveTextContent('notes.txt');
    expect(screen.getByTestId('wizard-generate-no-sources-biology')).toHaveTextContent(
      'Hand-authored BankIR can skip generate',
    );
  });

  it('does not treat a host-empty key with a stored fallback as a mutable sentinel', async () => {
    setOnboardingAiModeAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        aiMode: 'cloud',
        anthropicPresent: true,
        anthropicLiveTest: false,
        anthropicHostManaged: true,
        anthropicWriteBlocked: true,
        anthropicConfigured: false,
      }),
    });
    render(
      <OnboardingWizard
        snapshot={snapshot({
          anthropicPresent: true,
          anthropicLiveTest: false,
          anthropicHostManaged: true,
          anthropicWriteBlocked: true,
          anthropicConfigured: false,
        })}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-ai-cloud'));
    expect(await screen.findByTestId('wizard-anthropic-key')).toHaveTextContent(
      'set by the host environment',
    );
    expect(screen.queryByTestId('wizard-anthropic-key-clear')).toBeNull();
    expect(screen.queryByTestId('wizard-anthropic-key-rotate')).toBeNull();
    expect(screen.getByTestId('wizard-anthropic-key')).not.toHaveTextContent('test sentinel');
  });

  it('keeps Clear and Rotate after replacing a boot test sentinel', async () => {
    setOnboardingAiModeAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        aiMode: 'cloud',
        anthropicConfigured: true,
        anthropicPresent: true,
        anthropicLiveTest: false,
        anthropicHostManaged: true,
        anthropicWriteBlocked: false,
      }),
    });
    render(
      <OnboardingWizard
        snapshot={snapshot({
          anthropicConfigured: true,
          anthropicPresent: true,
          anthropicLiveTest: false,
          anthropicHostManaged: true,
          anthropicWriteBlocked: false,
        })}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-ai-cloud'));
    expect(await screen.findByTestId('wizard-ai-store')).toHaveTextContent('configured');
    expect(screen.getByTestId('wizard-anthropic-key-clear')).toBeVisible();
    expect(screen.getByTestId('wizard-anthropic-key-rotate')).toBeVisible();
    expect(screen.getByTestId('wizard-anthropic-key')).toHaveTextContent(
      'Saved on this host in the same .env store',
    );
    expect(screen.getByTestId('wizard-anthropic-key')).not.toHaveTextContent(
      'set by the host environment',
    );
    expect(screen.getByTestId('wizard-anthropic-key')).not.toHaveTextContent('test sentinel');
  });

  it('cancels prune confirm with zero apply writes', async () => {
    window.confirm = vi.fn(() => false);
    validateOnboardingAction.mockResolvedValue({ ok: true, snapshot: snapshot() });
    previewOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ hasDryRun: true }),
      dryRun: {
        hash: 'plan-hash',
        questionCount: 1,
        subjectCount: 1,
        collisions: [],
        replaceSample: false,
        plan: [
          { path: 'content/generated/questions/history.json', action: 'add' },
          { path: 'content/generated/questions/chemistry.json', action: 'delete' },
          { path: 'content/generated/keys/chemistry.json', action: 'delete' },
        ],
        diff: 'would delete content/generated/questions/chemistry.json',
      },
    });
    render(
      <OnboardingWizard
        snapshot={snapshot()}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-validate'));
    await waitFor(() => expect(screen.getByTestId('wizard-next')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(await screen.findByTestId('wizard-preview'));
    await waitFor(() => expect(screen.getByTestId('wizard-to-apply')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wizard-to-apply'));
    expect(screen.getByTestId('wizard-apply-prune')).toHaveTextContent('chemistry.json');
    fireEvent.click(screen.getByTestId('wizard-apply-confirm'));
    expect(window.confirm).toHaveBeenCalled();
    expect(String((window.confirm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toMatch(
      /chemistry/,
    );
    expect(applyOnboardingEmitAction).not.toHaveBeenCalled();
  });

  it('shows live bank subject names on Ready', async () => {
    validateOnboardingAction.mockResolvedValue({ ok: true, snapshot: snapshot() });
    previewOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ hasDryRun: true }),
      dryRun: {
        hash: 'plan-hash',
        questionCount: 6,
        subjectCount: 1,
        collisions: [],
        replaceSample: false,
        plan: [{ path: 'content/generated/questions/biology.json', action: 'update' }],
        diff: 'would update content/generated/questions/biology.json',
      },
    });
    applyOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ hasApplied: true, hasDryRun: false }),
      written: 1,
      questionCount: 6,
      subjectCount: 1,
    });
    render(
      <OnboardingWizard
        snapshot={snapshot()}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-validate'));
    await waitFor(() => expect(screen.getByTestId('wizard-next')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(await screen.findByTestId('wizard-preview'));
    await waitFor(() => expect(screen.getByTestId('wizard-to-apply')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wizard-to-apply'));
    fireEvent.click(screen.getByTestId('wizard-apply-confirm'));
    await waitFor(() => expect(screen.getByTestId('wizard-to-ready')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wizard-to-ready'));
    expect(screen.getByTestId('wizard-ready-subjects')).toHaveTextContent('Maths (maths)');
    expect(screen.getByTestId('wizard-ready-subject-biology')).toHaveTextContent(
      'Biology (biology) · 6 questions',
    );
  });

  it('reserves sticky-footer clearance for AI secret actions', () => {
    // Structure only — live 1100×800 boxes are asserted in tests/e2e/fresh.spec.ts.
    const css = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toMatch(/--wizard-footer-clearance:/);
    expect(css).toMatch(/\.wizard-stage \{[\s\S]*overflow-y: auto;/);
    expect(css).toMatch(
      /\.wizard-secret \{[\s\S]*scroll-margin-bottom: var\(--wizard-footer-clearance\)/,
    );
    expect(css).toMatch(
      /\.wizard-secret-actions \{[\s\S]*position: sticky;[\s\S]*scroll-margin-bottom: var\(--wizard-footer-clearance\)/,
    );
    expect(css).toMatch(/\.wizard-footer \{[\s\S]*flex: none;/);
    expect(css).toMatch(
      /@media \(min-width: 540px\) \{[\s\S]*\.app-frame-wizard \{[\s\S]*max-height: calc\(100dvh - \(2 \* var\(--sp-8\)\)\)/,
    );
    expect(css).toMatch(
      /@media \(min-width: 900px\) \{[\s\S]*\.app-frame-wizard \{[\s\S]*max-height: calc\(100dvh - \(2 \* var\(--sp-6\)\)\)/,
    );
  });

  it('keeps AI secret actions in the footer-clearance slot', async () => {
    setOnboardingAiModeAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ aiMode: 'cloud' }),
    });
    render(
      <OnboardingWizard
        snapshot={snapshot()}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-ai-cloud'));
    expect(await screen.findByTestId('wizard-anthropic-key-actions')).toBeVisible();
    expect(screen.getByTestId('wizard-anthropic-key-actions')).toHaveClass('wizard-secret-actions');
    expect(screen.getByTestId('wizard-anthropic-key-save')).toBeVisible();
    expect(screen.getByTestId('wizard-anthropic-key-rotate')).toBeVisible();
    expect(screen.getByTestId('wizard-anthropic-key-clear')).toBeVisible();
    expect(screen.getByTestId('wizard-footer')).toBeVisible();
    expect(screen.getByTestId('wizard-anthropic-key')).not.toHaveTextContent('ANTHROPIC_API_KEY=');

    const footerBox = toLayoutBox(screen.getByTestId('wizard-footer').getBoundingClientRect());
    const viewport = { width: window.innerWidth || 1100, height: window.innerHeight || 800 };
    for (const id of [
      'wizard-anthropic-key-save',
      'wizard-anthropic-key-rotate',
      'wizard-anthropic-key-clear',
    ] as const) {
      const controlBox = toLayoutBox(screen.getByTestId(id).getBoundingClientRect());
      const proof = evaluateSecretActionClearance({
        control: controlBox,
        footer: footerBox,
        viewport,
        hitIsControl: true,
      });
      // Fail closed: empty jsdom rects are unproven and must not pass.
      // A layout engine that supplies real boxes must still clear the footer.
      expect(proof.unproven).toBe(isEmptyLayoutBox(controlBox) || isEmptyLayoutBox(footerBox));
      expect(proof.ok).toBe(!proof.unproven);
      expect(proof.ok && proof.unproven).toBe(false);
      if (proof.unproven) {
        expect(proof.ok).toBe(false);
      } else {
        expect(proof).toMatchObject({
          ok: true,
          unproven: false,
          overlap: false,
          aboveFooter: true,
        });
      }
    }
  });

  it('fails closed when mounted AI secret-action rects are empty', async () => {
    setOnboardingAiModeAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ aiMode: 'cloud' }),
    });
    render(
      <OnboardingWizard
        snapshot={snapshot()}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-ai-cloud'));
    const footerBox = toLayoutBox(
      (await screen.findByTestId('wizard-footer')).getBoundingClientRect(),
    );
    const viewport = { width: window.innerWidth || 1100, height: window.innerHeight || 800 };
    const proofs = (
      [
        'wizard-anthropic-key-save',
        'wizard-anthropic-key-rotate',
        'wizard-anthropic-key-clear',
      ] as const
    ).map((id) => {
      const controlBox = toLayoutBox(screen.getByTestId(id).getBoundingClientRect());
      return evaluateSecretActionClearance({
        control: controlBox,
        footer: footerBox,
        viewport,
        hitIsControl: true,
      });
    });
    expect(proofs.length).toBe(3);
    expect(proofs.every((proof) => proof.ok === false)).toBe(true);
    expect(proofs.some((proof) => proof.ok)).toBe(false);
    expect(proofs.every((proof) => proof.unproven)).toBe(true);
  });

  it('uses one wizard-validate testid on the Validate button', () => {
    render(
      <OnboardingWizard
        snapshot={snapshot()}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-validate-panel')).toBeVisible();
    expect(screen.getAllByTestId('wizard-validate')).toHaveLength(1);
    expect(screen.getByTestId('wizard-validate')).toHaveTextContent('Validate');
    expect(screen.getByTestId('wizard-validate')).toHaveClass('wizard-validate-btn');
  });

  it('keeps generate and notes.txt visible when BankIR already exists', async () => {
    setOnboardingAiModeAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        aiMode: 'skip-stub',
        subjects: [
          {
            id: 'demo',
            label: 'Generate demo',
            icon: 'biology',
            hasIr: true,
            sourceFiles: [],
            generateSources: ['content/subjects/demo/notes.txt'],
          },
          {
            id: 'biology',
            label: 'Biology',
            icon: 'biology',
            hasIr: true,
            sourceFiles: [],
            generateSources: [],
          },
        ],
      }),
    });
    render(
      <OnboardingWizard
        snapshot={snapshot({
          subjects: [
            {
              id: 'demo',
              label: 'Generate demo',
              icon: 'biology',
              hasIr: true,
              sourceFiles: [],
              generateSources: ['content/subjects/demo/notes.txt'],
            },
            {
              id: 'biology',
              label: 'Biology',
              icon: 'biology',
              hasIr: true,
              sourceFiles: [],
              generateSources: [],
            },
          ],
        })}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-ai-skip-stub'));
    expect(
      await screen.findByRole('heading', { name: 'Generate from local sources' }),
    ).toBeVisible();
    expect(screen.getByTestId('wizard-generate-sources-demo').closest('details')).toBeNull();
    expect(screen.getByTestId('wizard-generate-sources-demo')).toBeVisible();
    expect(screen.getByTestId('wizard-generate-sources-demo')).toHaveTextContent('notes.txt');
    expect(screen.getByTestId('wizard-generate-demo')).toBeVisible();
    expect(screen.getByTestId('wizard-generate-overwrite-demo')).toHaveTextContent(
      'would overwrite content/subjects/demo/bank.ir.json',
    );
    window.confirm = vi.fn(() => false);
    await waitFor(() => expect(screen.getByTestId('wizard-generate-demo')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wizard-generate-demo'));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(String((window.confirm as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toMatch(
      /Replace existing BankIR for Generate demo/,
    );
    await waitFor(() =>
      expect(screen.getByTestId('wizard-generate-skipped')).toHaveTextContent('Generate skipped'),
    );
  });

  it('clears the Generate skipped chip after a successful apply', async () => {
    setOnboardingAiModeAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({
        aiMode: 'skip-stub',
        subjects: [
          {
            id: 'demo',
            label: 'Generate demo',
            icon: 'biology',
            hasIr: true,
            sourceFiles: [],
            generateSources: ['content/subjects/demo/notes.txt'],
          },
        ],
      }),
    });
    validateOnboardingAction.mockResolvedValue({ ok: true, snapshot: snapshot() });
    previewOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ hasDryRun: true }),
      dryRun: {
        hash: 'plan-hash',
        questionCount: 6,
        subjectCount: 1,
        collisions: [],
        replaceSample: false,
        plan: [{ path: 'content/generated/questions/biology.json', action: 'update' }],
        diff: 'would update content/generated/questions/biology.json',
      },
    });
    applyOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ hasApplied: true, hasDryRun: false }),
      written: 1,
      questionCount: 6,
      subjectCount: 1,
    });
    render(
      <OnboardingWizard
        snapshot={snapshot({
          subjects: [
            {
              id: 'demo',
              label: 'Generate demo',
              icon: 'biology',
              hasIr: true,
              sourceFiles: [],
              generateSources: ['content/subjects/demo/notes.txt'],
            },
          ],
        })}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-ai-skip-stub'));
    await screen.findByTestId('wizard-generate-demo');
    window.confirm = vi.fn(() => false);
    await waitFor(() => expect(screen.getByTestId('wizard-generate-demo')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wizard-generate-demo'));
    await waitFor(() =>
      expect(screen.getByTestId('wizard-generate-skipped')).toHaveTextContent('Generate skipped'),
    );
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getAllByTestId('wizard-validate')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('wizard-validate'));
    await waitFor(() => expect(screen.getByTestId('wizard-next')).toBeEnabled());
    expect(screen.getByTestId('wizard-generate-skipped')).toBeVisible();
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(await screen.findByTestId('wizard-preview'));
    await waitFor(() => expect(screen.getByTestId('wizard-to-apply')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wizard-to-apply'));
    fireEvent.click(screen.getByTestId('wizard-apply-confirm'));
    await waitFor(() => expect(screen.getByTestId('wizard-to-ready')).toBeEnabled());
    expect(screen.queryByTestId('wizard-generate-skipped')).toBeNull();
    fireEvent.click(screen.getByTestId('wizard-to-ready'));
    expect(screen.queryByTestId('wizard-generate-skipped')).toBeNull();
    expect(screen.getByTestId('wizard-ready-subjects')).toBeVisible();
  });
});

function sourceSubject(id: string, label: string) {
  return {
    id,
    label,
    icon: 'biology',
    hasIr: false,
    sourceFiles: [],
    generateSources: [`content/source-pdfs/${id}/notes.txt`],
  };
}

function generated(snap: OnboardingSnapshot, subjectId: string) {
  return {
    ok: true as const,
    snapshot: snap,
    result: {
      subjectId,
      provider: 'test' as const,
      model: 'fixture-v1',
      seed: 0,
      cacheHit: false,
      cacheKey: `key-${subjectId}`,
      sourceCount: 1,
      sourceHashes: {},
      wroteIr: true,
      irRel: `content/subjects/${subjectId}/bank.ir.json`,
      overwrite: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderAtAiStep(snap: OnboardingSnapshot) {
  render(
    <OnboardingWizard
      snapshot={snap}
      pendingInvites={[]}
      members={[]}
      canInvite={false}
      authMode="magic-link"
    />,
  );
  fireEvent.click(screen.getByTestId('wizard-get-started'));
  fireEvent.click(screen.getByTestId('wizard-next'));
  fireEvent.click(screen.getByTestId('wizard-next'));
  expect(screen.getByTestId('wizard-generate')).toBeVisible();
}

function generatedIds(): string[] {
  return generateOnboardingSubjectAction.mock.calls.map((call) =>
    String((call[0] as FormData).get('subjectId')),
  );
}

describe('OnboardingWizard generate fixes', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    generateOnboardingSubjectAction.mockReset();
    setReplaceSampleAction.mockReset();
    attachOnboardingPdfAction.mockReset();
    window.confirm = vi.fn(() => true);
  });

  const batch = () =>
    snapshot({
      aiMode: 'skip-stub',
      subjects: [
        sourceSubject('alpha', 'Alpha'),
        sourceSubject('beta', 'Beta'),
        sourceSubject('gamma', 'Gamma'),
      ],
    });

  it('stops Generate all when cancel lands just after a subject committed, and keeps it', async () => {
    const snap = batch();
    const beta = deferred<ReturnType<typeof generated>>();
    generateOnboardingSubjectAction.mockImplementation(async (data: FormData) => {
      const id = String(data.get('subjectId'));
      return id === 'beta' ? beta.promise : generated(snap, id);
    });
    const cancelPost = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, reason: 'already_committed' }), { status: 409 }),
    );
    vi.stubGlobal('fetch', cancelPost);
    renderAtAiStep(snap);

    fireEvent.click(screen.getByTestId('wizard-generate-all'));
    await screen.findByTestId('wizard-generate-progress-beta');
    fireEvent.click(screen.getByTestId('wizard-generate-cancel'));
    await waitFor(() => expect(cancelPost).toHaveBeenCalledTimes(1));
    // Acknowledged: calm status, nav unlocked, no error toast.
    await waitFor(() =>
      expect(screen.getByTestId('wizard-generate-cancelled')).toHaveTextContent(
        'Generate cancelled. Kept 1 subject already generated.',
      ),
    );
    expect(screen.getByTestId('wizard-back')).toBeEnabled();

    beta.resolve(generated(snap, 'beta'));
    await waitFor(() =>
      expect(screen.getByTestId('wizard-generate-cancelled')).toHaveTextContent(
        'Generate cancelled. Kept 2 subjects already generated.',
      ),
    );
    expect(generatedIds()).toEqual(['alpha', 'beta']);
    expect(screen.getByTestId('wizard-ir-ready')).toBeVisible();
    expect(screen.queryByTestId('wizard-error')).toBeNull();
  });

  it('aborts the in-flight subject of Generate all and reports what was kept', async () => {
    const snap = batch();
    const beta = deferred<{ ok: false; reason: 'cancelled' }>();
    generateOnboardingSubjectAction.mockImplementation(async (data: FormData) => {
      const id = String(data.get('subjectId'));
      return id === 'beta' ? beta.promise : generated(snap, id);
    });
    const cancelPost = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', cancelPost);
    renderAtAiStep(snap);

    fireEvent.click(screen.getByTestId('wizard-generate-all'));
    await screen.findByTestId('wizard-generate-progress-beta');
    fireEvent.click(screen.getByTestId('wizard-generate-cancel'));
    await waitFor(() =>
      expect(screen.getByTestId('wizard-generate-cancelled')).toHaveTextContent(
        'Generate cancelled. Kept 1 subject already generated.',
      ),
    );
    // Unlocked while the provider is still unwinding.
    expect(screen.getByTestId('wizard-back')).toBeEnabled();
    expect(screen.queryByTestId('wizard-generate-cancel')).toBeNull();

    beta.resolve({ ok: false, reason: 'cancelled' });
    await waitFor(() => expect(screen.getByTestId('wizard-ir-ready')).toBeVisible());
    expect(generatedIds()).toEqual(['alpha', 'beta']);
    expect(screen.getByTestId('wizard-generate-cancelled')).toHaveTextContent(
      'Generate cancelled. Kept 1 subject already generated.',
    );
    expect(screen.queryByTestId('wizard-error')).toBeNull();
  });

  it('does not claim cancelled when the cancel request fails', async () => {
    const snap = batch();
    const beta = deferred<ReturnType<typeof generated>>();
    generateOnboardingSubjectAction.mockImplementation(async (data: FormData) => {
      const id = String(data.get('subjectId'));
      return id === 'beta' ? beta.promise : generated(snap, id);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    renderAtAiStep(snap);

    fireEvent.click(screen.getByTestId('wizard-generate-all'));
    await screen.findByTestId('wizard-generate-progress-beta');
    fireEvent.click(screen.getByTestId('wizard-generate-cancel'));
    await waitFor(() =>
      expect(screen.getByTestId('wizard-error')).toHaveTextContent('Could not cancel generate.'),
    );
    expect(screen.queryByTestId('wizard-generate-cancelled')).toBeNull();
    beta.resolve(generated(snap, 'beta'));
    await waitFor(() => expect(generatedIds()).toEqual(['alpha', 'beta', 'gamma']));
  });

  it('says a single generate already finished when cancel arrives after its commit', async () => {
    const snap = snapshot({ aiMode: 'skip-stub', subjects: [sourceSubject('alpha', 'Alpha')] });
    const alpha = deferred<ReturnType<typeof generated>>();
    generateOnboardingSubjectAction.mockImplementation(() => alpha.promise);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, reason: 'already_committed' }), {
            status: 409,
          }),
      ),
    );
    renderAtAiStep(snap);

    fireEvent.click(screen.getByTestId('wizard-generate-alpha'));
    await screen.findByTestId('wizard-generate-progress-alpha');
    fireEvent.click(screen.getByTestId('wizard-generate-cancel'));
    await waitFor(() =>
      expect(screen.getByTestId('wizard-generate-finished')).toHaveTextContent(
        'Generate already finished — review the new BankIR.',
      ),
    );
    alpha.resolve(generated(snap, 'alpha'));
    await waitFor(() => expect(screen.getByTestId('wizard-generate-run-alpha')).toBeVisible());
    expect(screen.getByTestId('wizard-generate-finished')).toBeVisible();
    expect(screen.queryByTestId('wizard-generate-cancelled')).toBeNull();
    expect(screen.queryByTestId('wizard-error')).toBeNull();
  });

  it('explains provider failures specifically instead of “That input is not valid.”', async () => {
    const snap = snapshot({ aiMode: 'cloud', subjects: [sourceSubject('alpha', 'Alpha')] });
    const copy: [string, RegExp][] = [
      ['provider_auth', /rejected the API key/],
      ['provider_rate_limited', /rate-limiting this key, or the account is out of quota/],
      ['provider_timeout', /did not answer within 3 minutes/],
      ['provider_unavailable', /Could not reach the AI provider/],
      ['provider_error', /returned an error/],
      ['provider_output_invalid', /not with questions Examify can use/],
      ['sources_unreadable', /cannot read PDFs directly/],
      ['generate_failed', /run the generate command under Power-user commands/],
    ];
    renderAtAiStep(snap);
    for (const [reason, text] of copy) {
      generateOnboardingSubjectAction.mockResolvedValueOnce({ ok: false, reason });
      await waitFor(() => expect(screen.getByTestId('wizard-generate-alpha')).toBeEnabled());
      fireEvent.click(screen.getByTestId('wizard-generate-alpha'));
      await waitFor(() => expect(screen.getByTestId('wizard-error')).toHaveTextContent(text));
      expect(screen.getByTestId('wizard-error')).not.toHaveTextContent('That input is not valid.');
    }
  });

  it('offers the replace-sample choice on AI setup for a sample-id subject', async () => {
    const snap = snapshot({
      aiMode: 'skip-stub',
      sampleSubjects: [
        { id: 'maths', label: 'Maths' },
        { id: 'geography', label: 'Geography' },
      ],
      subjects: [sourceSubject('maths', 'Maths'), sourceSubject('history', 'History')],
    });
    setReplaceSampleAction.mockResolvedValue({
      ok: true,
      snapshot: { ...snap, replaceSample: true },
    });
    renderAtAiStep(snap);

    const notice = screen.getByTestId('wizard-generate-sample-ids');
    expect(notice).toHaveTextContent('Maths (maths) uses the same id as a sample-bank subject');
    expect(notice).not.toHaveTextContent('History');
    const toggle = screen.getByTestId('wizard-generate-replace-sample');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(setReplaceSampleAction).toHaveBeenCalledTimes(1));
    expect((setReplaceSampleAction.mock.calls[0]?.[0] as FormData).get('replaceSample')).toBe('1');
    await waitFor(() =>
      expect(screen.getByTestId('wizard-generate-sample-ids')).toHaveTextContent(
        'Replacing sample-bank questions is on',
      ),
    );
    expect(screen.getByTestId('wizard-generate-replace-sample')).toBeChecked();
  });

  it('keeps Generate all going past a sample-id subject and names it', async () => {
    const snap = snapshot({
      aiMode: 'skip-stub',
      subjects: [sourceSubject('maths', 'Maths'), sourceSubject('history', 'History')],
    });
    generateOnboardingSubjectAction.mockImplementation(async (data: FormData) => {
      const id = String(data.get('subjectId'));
      return id === 'maths' ? { ok: false, reason: 'sample_collision' } : generated(snap, id);
    });
    renderAtAiStep(snap);

    fireEvent.click(screen.getByTestId('wizard-generate-all'));
    await waitFor(() => expect(screen.getByTestId('wizard-generate-run-history')).toBeVisible());
    expect(generatedIds()).toEqual(['maths', 'history']);
    const error = screen.getByTestId('wizard-error');
    expect(error).toHaveTextContent('“Maths” uses the same id as a sample-bank subject');
    expect(error).toHaveTextContent('Rename the subject id in Subjects');
    expect(error).not.toHaveTextContent('That input is not valid.');
    expect(screen.getByTestId('wizard-ir-ready')).toBeVisible();
  });

  it('warns while adding a subject whose id is a sample-bank subject id', () => {
    render(
      <OnboardingWizard
        snapshot={snapshot({ subjects: [] })}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.change(screen.getByTestId('wizard-subject-label'), { target: { value: 'Maths' } });
    expect(screen.getByTestId('wizard-subject-id')).toHaveValue('maths');
    expect(screen.getByTestId('wizard-subject-id-sample-hint')).toHaveTextContent(
      'is the id of the sample Maths subject',
    );
    fireEvent.change(screen.getByTestId('wizard-subject-label'), { target: { value: 'History' } });
    expect(screen.queryByTestId('wizard-subject-id-sample-hint')).toBeNull();
  });

  it('names the upload problem instead of “Only PDF files” for a bad name', async () => {
    attachOnboardingPdfAction.mockResolvedValue({ ok: false, reason: 'invalid_name' });
    render(
      <OnboardingWizard
        snapshot={snapshot()}
        pendingInvites={[]}
        members={[]}
        canInvite={false}
        authMode="magic-link"
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.change(screen.getByTestId('wizard-file-demo'), {
      target: { files: [new File(['%PDF-1.4'], 'Unit 2.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() =>
      expect(screen.getByTestId('wizard-error')).toHaveTextContent(
        'That file name cannot be used. Rename the file and upload it again.',
      ),
    );
    expect(screen.getByTestId('wizard-error')).not.toHaveTextContent('Only PDF files');
  });
});
