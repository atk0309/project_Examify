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

vi.mock('@/actions/onboarding', () => ({
  addOnboardingSubjectAction: vi.fn(),
  applyOnboardingEmitAction: (...args: unknown[]) => applyOnboardingEmitAction(...args),
  attachOnboardingPdfAction: vi.fn(),
  deleteOnboardingSubjectAction: vi.fn(),
  detachOnboardingPdfAction: vi.fn(),
  finishOnboardingAction: vi.fn(),
  generateOnboardingSubjectAction: vi.fn(),
  previewOnboardingEmitAction: (...args: unknown[]) => previewOnboardingEmitAction(...args),
  renameOnboardingSubjectAction: vi.fn(),
  setOnboardingAiModeAction: (...args: unknown[]) => setOnboardingAiModeAction(...args),
  setOnboardingAnthropicKeyAction: (...args: unknown[]) => setOnboardingAnthropicKeyAction(...args),
  setOnboardingOpenAiKeyAction: vi.fn(),
  setReplaceSampleAction: vi.fn(),
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
  });

  beforeEach(() => {
    applyOnboardingEmitAction.mockReset();
    previewOnboardingEmitAction.mockReset();
    validateOnboardingAction.mockReset();
    setOnboardingAiModeAction.mockReset();
    setOnboardingAnthropicKeyAction.mockReset();
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
