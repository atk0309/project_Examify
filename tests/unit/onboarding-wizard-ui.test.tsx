/** @vitest-environment jsdom */

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
    fireEvent.click(screen.getByRole('button', { name: /Biology/ }));
    expect(screen.getByTestId('wizard-files-authored-biology')).toHaveTextContent(
      'Hand-authored BankIR',
    );
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
        anthropicConfigured: false,
      }),
    });
    render(
      <OnboardingWizard
        snapshot={snapshot({
          anthropicPresent: true,
          anthropicLiveTest: false,
          anthropicHostManaged: true,
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
    fireEvent.click(document.querySelector('.wizard-validate-btn')!);
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
    fireEvent.click(document.querySelector('.wizard-validate-btn')!);
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
});
