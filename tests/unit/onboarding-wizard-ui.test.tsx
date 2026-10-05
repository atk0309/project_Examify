/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OnboardingAuthorPreview,
  OnboardingDryRun,
  OnboardingSnapshot,
} from '@/lib/onboarding-types';

const applyOnboardingEmitAction = vi.fn();
const previewOnboardingEmitAction = vi.fn();
const setOnboardingAiModeAction = vi.fn();
const setOnboardingAnthropicKeyAction = vi.fn();
const setOnboardingOpenAiKeyAction = vi.fn();
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
  setOnboardingOpenAiKeyAction: (...args: unknown[]) => setOnboardingOpenAiKeyAction(...args),
  setReplaceSampleAction: (...args: unknown[]) => setReplaceSampleAction(...args),
  skipOnboardingAction: vi.fn(),
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
    builtinSubjects: [{ id: 'biology', label: 'Biology' }],
    dataDirDisplay: 'data',
    aiMode: null,
    aiModeFromInstaller: false,
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
    localHttpConfigured: false,
    localModelConfigured: false,
    localCmdConfigured: false,
    claudeCliFound: false,
    codexCliFound: false,
    claudeCliSignIn: 'unknown',
    codexCliSignIn: 'unknown',
    gradingStubActive: false,
    openaiGradingStubActive: false,
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
    setOnboardingAiModeAction.mockReset();
    setOnboardingAnthropicKeyAction.mockReset();
    setOnboardingOpenAiKeyAction.mockReset();
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
    expect(welcome).toHaveTextContent('stays on the computer running Examify');
    expect(welcome).toHaveTextContent(
      'until you choose Generate, which sends it to your selected AI provider',
    );
    expect(welcome).toHaveTextContent('The original files are not included in the practice bank');
    expect(welcome).not.toHaveTextContent('stay on this host');

    fireEvent.click(screen.getByTestId('wizard-get-started'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-files')).toBeVisible();
    expect(screen.getByText(/Your study files are saved here/)).toHaveTextContent(
      'They go to your chosen AI provider only when you select Generate',
    );

    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-ai-sends')).toHaveTextContent(
      'the subject’s source files (PDFs, notes, images) go to the mode you pick',
    );
    // Before a mode is picked, marking falls back to the Anthropic key; the
    // disclosure shows either way and follows the mode once one is picked.
    const grading = screen.getByTestId('wizard-ai-grading');
    expect(grading).toHaveTextContent('Until you pick a mode, marking uses the Anthropic key');
    expect(grading).toHaveTextContent(
      'Written answers are not marked until this server has an Anthropic API key. Until then, exams leave written questions out (a bank with only written questions keeps them), and written answers await marking and are excluded from scores.',
    );

    fireEvent.click(screen.getByTestId('wizard-ai-cloud'));
    await screen.findByTestId('wizard-anthropic-key');
    expect(screen.getAllByTestId('wizard-ai-grading')).toHaveLength(1);
    expect(screen.getByTestId('wizard-ai-grading')).not.toHaveTextContent('Until you pick a mode');
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
    expect(grading).toHaveTextContent('The test stub cannot mark written answers');
    expect(grading).toHaveTextContent('stub full mark and nothing is sent');
    expect(grading).not.toHaveTextContent('are not marked until');
  });

  it.each([
    [
      'cloud-openai',
      { openaiConfigured: true },
      'Written answers are marked by OpenAI: each one is sent with its question and rubric',
    ],
    [
      'claude-cli',
      { claudeCliFound: true },
      'marked by Claude Code while it is signed in as the user that runs Examify',
    ],
    [
      'codex-cli',
      { codexCliFound: true },
      'Signed out, they await marking and are excluded from scores.',
    ],
    [
      'local-agent',
      { localHttpConfigured: true, localModelConfigured: true },
      'marked by your local endpoint (EXAMIFY_LLM_MODEL)',
    ],
    [
      'local-cli',
      { anthropicConfigured: true },
      'Local command cannot mark written answers, so marking uses the Anthropic key. Written answers are marked by Anthropic',
    ],
    [
      'skip-stub',
      { anthropicConfigured: true },
      'The test stub cannot mark written answers, so marking uses the Anthropic key. Written answers are marked by Anthropic',
    ],
    [
      'claude-cli',
      { anthropicConfigured: true },
      'Written answers are not marked until this server has Claude Code installed and signed in as the user that runs Examify',
    ],
    [
      'local-agent',
      { localHttpConfigured: true },
      'Written answers are not marked until this server has EXAMIFY_LLM_BASE_URL (an http or https address) and EXAMIFY_LLM_MODEL set',
    ],
  ] as const)('says who marks written answers in %s mode (%o)', (aiMode, flags, copy) => {
    render(
      <OnboardingWizard
        snapshot={snapshot({ aiMode, ...flags })}
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
    expect(screen.getByTestId('wizard-ai-grading')).toHaveTextContent(copy);
  });

  it.each([
    [true, 'The installer picked Claude Code (your Claude plan) from what it found on this server'],
    [false, null],
  ] as const)(
    "names the installer's pick until the household chooses (%s)",
    (fromInstaller, copy) => {
      render(
        <OnboardingWizard
          snapshot={snapshot({
            aiMode: 'claude-cli',
            aiModeFromInstaller: fromInstaller,
            claudeCliFound: true,
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
      expect(screen.getByTestId('wizard-ai-claude-cli')).toHaveAttribute('aria-checked', 'true');
      if (copy) expect(screen.getByTestId('wizard-ai-installer')).toHaveTextContent(copy);
      else expect(screen.queryByTestId('wizard-ai-installer')).toBeNull();
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
      'You can review the existing draft without generating again.',
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

  it('discards an unsaved key on provider switch and routes Save/Clear to the selected provider', async () => {
    const cloud = snapshot({ aiMode: 'cloud', anthropicLiveTest: false });
    const openai = snapshot({ aiMode: 'cloud-openai' });
    setOnboardingAiModeAction.mockResolvedValue({ ok: true, snapshot: openai });
    setOnboardingOpenAiKeyAction.mockResolvedValue({
      ok: true,
      snapshot: { ...openai, openaiConfigured: true },
    });
    renderAtAiStep(cloud);
    fireEvent.change(screen.getByTestId('wizard-anthropic-key-input'), {
      target: { value: 'unsaved-anthropic-key' },
    });
    fireEvent.click(screen.getByTestId('wizard-ai-cloud-openai'));
    const input = await screen.findByTestId('wizard-openai-key-input');
    expect(input).toHaveValue('');
    expect(screen.queryByTestId('wizard-anthropic-key')).toBeNull();
    fireEvent.change(input, { target: { value: 'new-openai-key' } });
    fireEvent.click(screen.getByTestId('wizard-openai-key-save'));
    await waitFor(() => expect(setOnboardingOpenAiKeyAction).toHaveBeenCalledTimes(1));
    const saved = setOnboardingOpenAiKeyAction.mock.calls[0]![0] as FormData;
    expect(saved.get('intent')).toBe('set');
    expect(saved.get('openaiApiKey')).toBe('new-openai-key');
    expect(saved.get('anthropicApiKey')).toBeNull();
    expect(setOnboardingAnthropicKeyAction).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('wizard-openai-key-clear'));
    await waitFor(() => expect(setOnboardingOpenAiKeyAction).toHaveBeenCalledTimes(2));
    const cleared = setOnboardingOpenAiKeyAction.mock.calls[1]![0] as FormData;
    expect(cleared.get('intent')).toBe('clear');
    expect(cleared.get('openaiApiKey')).toBeNull();
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('Clear the OpenAI API key'),
    );
  });

  it('cancels prune confirm with zero apply writes', async () => {
    window.confirm = vi.fn(() => false);
    previewOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ hasDryRun: true }),
      authorPreview: { subjects: [] },
      dryRun: {
        hash: 'plan-hash',
        questionCount: 1,
        subjectCount: 1,
        collisions: [],
        shadows: [],
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
    previewOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ hasDryRun: true }),
      authorPreview: { subjects: [] },
      dryRun: {
        hash: 'plan-hash',
        questionCount: 6,
        subjectCount: 1,
        collisions: [],
        shadows: [],
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

  it('checks and previews the draft with one Review questions action', async () => {
    previewOnboardingEmitAction.mockResolvedValue(reviewFixture());
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
    expect(screen.getByTestId('wizard-next')).toHaveTextContent('Review questions');
    fireEvent.click(screen.getByTestId('wizard-next'));
    await waitFor(() => expect(screen.getByTestId('wizard-to-apply')).toBeEnabled());
    expect(screen.getByRole('region', { name: 'Draft questions' })).toBeVisible();
    expect(screen.getByText(/Step 5 of 7/)).toBeVisible();
    expect(previewOnboardingEmitAction).toHaveBeenCalledTimes(1);
    expect(applyOnboardingEmitAction).not.toHaveBeenCalled();
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
    previewOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ hasDryRun: true }),
      authorPreview: { subjects: [] },
      dryRun: {
        hash: 'plan-hash',
        questionCount: 6,
        subjectCount: 1,
        collisions: [],
        shadows: [],
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
    expect(screen.getByTestId('wizard-generate-skipped')).toBeVisible();
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
  expect(screen.getByTestId('wizard-ai')).toBeVisible();
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

  it('warns while adding a subject whose id is a built-in subject id', () => {
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
    fireEvent.change(screen.getByTestId('wizard-subject-label'), { target: { value: 'Biology' } });
    expect(screen.getByTestId('wizard-subject-id')).toHaveValue('biology');
    const hint = screen.getByTestId('wizard-subject-id-builtin-hint');
    expect(hint).toHaveTextContent('is the id of the built-in Biology subject');
    expect(hint).toHaveTextContent('replaces it in this installation after Apply');
    expect(hint).toHaveTextContent('biology-2');
    expect(screen.queryByTestId('wizard-subject-id-sample-hint')).toBeNull();
    fireEvent.change(screen.getByTestId('wizard-subject-label'), { target: { value: 'History' } });
    expect(screen.queryByTestId('wizard-subject-id-builtin-hint')).toBeNull();
  });

  it('says uploads stay in the private data folder', () => {
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
    const files = screen.getByTestId('wizard-files');
    expect(files).toHaveTextContent('Uploaded PDFs stay in this server’s private data folder');
    expect(files).not.toHaveTextContent('under source-pdfs');
  });

  it('names built-in replacements on Review and the data folder in CLI hints', async () => {
    const withFolder = snapshot({ dataDirDisplay: '/srv/examify-data' });
    previewOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: { ...withFolder, hasDryRun: true },
      authorPreview: { subjects: [] },
      dryRun: {
        hash: 'plan-hash',
        questionCount: 2,
        subjectCount: 1,
        collisions: [],
        shadows: [{ id: 'biology', label: 'Biology' }],
        replaceSample: false,
        plan: [{ path: 'content/generated/questions/biology.json', action: 'update' }],
        diff: 'would update content/generated/questions/biology.json',
      },
    });
    render(
      <OnboardingWizard
        snapshot={withFolder}
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
    expect(screen.getByTestId('wizard-cli-emit')).toHaveTextContent(
      'pnpm examify-ingest validate /srv/examify-data/content/subjects',
    );
    expect(screen.getByTestId('wizard-cli-emit')).toHaveTextContent(
      'pnpm examify-ingest emit /srv/examify-data/content/subjects --dry-run',
    );
    expect(await screen.findByTestId('wizard-shadows')).toHaveTextContent(
      'Replaces built-in subject: Biology.',
    );
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

describe('OnboardingWizard AI modes: Claude Code, Codex and local', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    setOnboardingAiModeAction.mockReset();
    generateOnboardingSubjectAction.mockReset();
    window.confirm = vi.fn(() => true);
  });

  it('lists Claude Code and Codex with what each can do and whether this server has it', () => {
    renderAtAiStep(
      snapshot({
        aiMode: 'skip-stub',
        subjects: [sourceSubject('alpha', 'Alpha')],
        claudeCliFound: true,
      }),
    );
    expect(screen.getByTestId('wizard-ai-store')).toHaveTextContent(
      'Claude Code found · Codex not found',
    );
    const claude = screen.getByTestId('wizard-ai-claude-cli');
    expect(claude).toHaveTextContent('Claude Code (your Claude plan)');
    expect(claude).toHaveTextContent('Found');
    expect(screen.getByTestId('wizard-ai-claude-cli-caps')).toHaveTextContent(
      'Reads PDFs directly · uses the tool’s own sign-in (your plan), no API key.',
    );
    const codex = screen.getByTestId('wizard-ai-codex-cli');
    expect(codex).toHaveTextContent('Codex (your ChatGPT plan)');
    expect(codex).not.toHaveTextContent('Found');
    expect(screen.getByTestId('wizard-ai-codex-cli-caps')).toHaveTextContent(
      'Reads PDFs as page images (the host needs pdftoppm)',
    );
    expect(screen.getByTestId('wizard-ai-local-agent')).toHaveTextContent('Local endpoint');
    expect(screen.getByTestId('wizard-ai-local-cli')).toHaveTextContent('Local command');
  });

  it('badges only ready modes: Configured for keys and settings, Found for a CLI', () => {
    renderAtAiStep(
      snapshot({
        aiMode: 'skip-stub',
        subjects: [sourceSubject('alpha', 'Alpha')],
        anthropicConfigured: true,
        codexCliFound: true,
        localCmdConfigured: true,
      }),
    );
    const badge = (mode: string) =>
      screen.getByTestId(`wizard-ai-${mode}`).querySelector('.wizard-mode-badge')?.textContent ??
      null;
    expect(badge('cloud')).toBe('Configured');
    expect(badge('cloud-openai')).toBeNull();
    expect(badge('codex-cli')).toBe('Found');
    expect(badge('claude-cli')).toBeNull();
    expect(badge('local-cli')).toBe('Configured');
    expect(badge('local-agent')).toBeNull();
    expect(badge('skip-stub')).toBe('Configured');
  });

  it('says whether each found CLI is signed in, and badges a signed-out one', () => {
    renderAtAiStep(
      snapshot({
        aiMode: 'skip-stub',
        subjects: [sourceSubject('alpha', 'Alpha')],
        claudeCliFound: true,
        claudeCliSignIn: 'signed_out',
        codexCliFound: true,
        codexCliSignIn: 'signed_in',
      }),
    );
    expect(screen.getByTestId('wizard-ai-store')).toHaveTextContent(
      'Claude Code not signed in · Codex signed in · Local endpoint',
    );
    const badge = (mode: string) =>
      screen.getByTestId(`wizard-ai-${mode}`).querySelector('.wizard-mode-badge')?.textContent ??
      null;
    expect(badge('claude-cli')).toBe('Not signed in');
    expect(badge('codex-cli')).toBe('Signed in');
    cleanup();

    // A check with no clear answer keeps "found", as before.
    renderAtAiStep(
      snapshot({
        aiMode: 'skip-stub',
        subjects: [sourceSubject('alpha', 'Alpha')],
        claudeCliFound: true,
        claudeCliSignIn: 'unknown',
      }),
    );
    expect(screen.getByTestId('wizard-ai-store')).toHaveTextContent(
      'Claude Code found · Codex not found',
    );
    expect(badge('claude-cli')).toBe('Found');
    expect(badge('codex-cli')).toBeNull();
  });

  it.each([
    ['claude-cli', { claudeCliFound: true, claudeCliSignIn: 'signed_out' }, 'claude auth login'],
    ['codex-cli', { codexCliFound: true, codexCliSignIn: 'signed_out' }, 'codex login'],
  ] as const)(
    'tells the admin to sign %s in, and that exams leave written questions out',
    (aiMode, flags, command) => {
      renderAtAiStep(snapshot({ aiMode, subjects: [sourceSubject('alpha', 'Alpha')], ...flags }));
      const name = aiMode === 'claude-cli' ? 'Claude Code' : 'Codex';
      expect(screen.getByTestId('wizard-agent-cli-setup')).toHaveTextContent(
        `${name} is installed on this server but not signed in as the user that runs Examify. As that user, run \`${command}\`, then reload this page.`,
      );
      expect(screen.getByTestId('wizard-ai-grading')).toHaveTextContent(
        `Written answers are not marked: ${name} is not signed in as the user that runs Examify. As that user, run \`${command}\`. Until then, exams leave written questions out (a bank with only written questions keeps them), and written answers await marking and are excluded from scores.`,
      );
    },
  );

  it('says a signed-in CLI is ready, and an unchecked one may still need its sign-in', () => {
    renderAtAiStep(
      snapshot({
        aiMode: 'claude-cli',
        subjects: [sourceSubject('alpha', 'Alpha')],
        claudeCliFound: true,
        claudeCliSignIn: 'signed_in',
      }),
    );
    expect(screen.getByTestId('wizard-agent-cli-setup')).toHaveTextContent(
      'Claude Code is installed and signed in on this server.',
    );
    expect(screen.getByTestId('wizard-ai-grading')).toHaveTextContent(
      'Written answers are marked by Claude Code while it is signed in',
    );
    cleanup();
    renderAtAiStep(
      snapshot({
        aiMode: 'claude-cli',
        subjects: [sourceSubject('alpha', 'Alpha')],
        claudeCliFound: true,
        claudeCliSignIn: 'unknown',
      }),
    );
    expect(screen.getByTestId('wizard-agent-cli-setup')).toHaveTextContent(
      'Examify could not tell whether it is signed in',
    );
    expect(screen.getByTestId('wizard-agent-cli-setup')).toHaveTextContent('claude auth login');
    expect(screen.getByTestId('wizard-ai-grading')).toHaveTextContent(
      'Written answers are marked by Claude Code while it is signed in',
    );
  });

  it('tells the admin how to install and sign in when the chosen CLI is missing', () => {
    renderAtAiStep(snapshot({ aiMode: 'claude-cli', subjects: [sourceSubject('alpha', 'Alpha')] }));
    expect(screen.getByTestId('wizard-agent-cli-setup')).toHaveTextContent(
      'Claude Code was not found on this server',
    );
    expect(screen.getByTestId('wizard-agent-cli-setup')).toHaveTextContent('EXAMIFY_CLAUDE_BIN');
    expect(screen.getByTestId('wizard-cli-generate')).toHaveTextContent('--provider claude-cli');
  });

  it.each([
    ['local-agent', 'endpoint'],
    ['local-cli', 'command'],
  ] as const)('shows %s’s transport in the power-user generate command', (aiMode, transport) => {
    renderAtAiStep(snapshot({ aiMode, subjects: [sourceSubject('alpha', 'Alpha')] }));
    expect(screen.getByTestId('wizard-cli-generate')).toHaveTextContent(
      `--provider local --local-transport ${transport}`,
    );
  });

  it('asks for the model name when Local endpoint has a URL but no EXAMIFY_LLM_MODEL', () => {
    renderAtAiStep(
      snapshot({
        aiMode: 'local-agent',
        subjects: [sourceSubject('alpha', 'Alpha')],
        localHttpConfigured: true,
      }),
    );
    expect(screen.getByTestId('wizard-local-setup')).toHaveTextContent('EXAMIFY_LLM_MODEL');
    expect(screen.getByTestId('wizard-ai-local-agent')).not.toHaveTextContent('Configured');
  });

  it('names the CLI and its sign-in in generate failures instead of API-key copy', async () => {
    const snap = snapshot({
      aiMode: 'codex-cli',
      subjects: [sourceSubject('alpha', 'Alpha')],
      codexCliFound: true,
    });
    const copy: [string, RegExp][] = [
      ['provider_auth', /Codex is not signed in[\s\S]*codex login/],
      ['missing_cli', /Codex was not found on this server/],
      ['provider_timeout', /did not answer within 10 minutes/],
      ['provider_rate_limited', /hit its plan’s usage limit/],
    ];
    renderAtAiStep(snap);
    for (const [reason, text] of copy) {
      generateOnboardingSubjectAction.mockResolvedValueOnce({ ok: false, reason });
      await waitFor(() => expect(screen.getByTestId('wizard-generate-alpha')).toBeEnabled());
      fireEvent.click(screen.getByTestId('wizard-generate-alpha'));
      await waitFor(() => expect(screen.getByTestId('wizard-error')).toHaveTextContent(text));
      expect(screen.getByTestId('wizard-error')).not.toHaveTextContent('API key');
    }
  });
});

function reviewFixture(hash = 'displayed-plan-hash') {
  const authorPreview: OnboardingAuthorPreview = {
    subjects: [
      {
        id: 'demo',
        label: 'Generate demo',
        difficulties: [
          {
            difficulty: 'easy',
            questions: [
              {
                id: 'demo-easy-1',
                type: 'mcq',
                q: '<img src=x onerror="alert(1)"> Which answer?',
                choices: [
                  '<script>alert(1)</script>',
                  'Second choice',
                  'Third choice',
                  'Fourth choice',
                ],
                answer: 1,
              },
            ],
          },
          {
            difficulty: 'hard',
            questions: [
              {
                id: 'demo-hard-1',
                type: 'free',
                q: 'Explain your reasoning.\nUse your source material.',
                rubric:
                  '<a href="javascript:alert(1)">Award credit</a> for a supported explanation.',
                maxScore: 5,
              },
            ],
          },
        ],
      },
    ],
  };
  const dryRun: OnboardingDryRun = {
    hash,
    questionCount: 2,
    subjectCount: 1,
    collisions: [],
    shadows: [],
    replaceSample: false,
    plan: [{ path: 'content/generated/questions/demo.json', action: 'add' }],
    diff: 'would add content/generated/questions/demo.json',
  };
  return { ok: true as const, snapshot: snapshot({ hasDryRun: true }), dryRun, authorPreview };
}

async function renderAtReviewStep(initial = snapshot()) {
  renderAtAiStep(initial);
  fireEvent.click(screen.getByTestId('wizard-next'));
}

async function showAuthorPreview() {
  await waitFor(() => expect(screen.getByTestId('wizard-to-apply')).toBeEnabled());
}

describe('OnboardingWizard author question review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewOnboardingEmitAction.mockReset().mockResolvedValue(reviewFixture());
    applyOnboardingEmitAction.mockReset();
    setReplaceSampleAction.mockReset();
    generateOnboardingSubjectAction.mockReset();
    window.confirm = vi.fn(() => true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows grouped MCQ and written-answer text without executing HTML or creating answer inputs', async () => {
    const store = vi.spyOn(Storage.prototype, 'setItem');
    await renderAtReviewStep();
    await showAuthorPreview();
    const preview = screen.getByRole('region', { name: 'Draft questions' });
    expect(within(preview).getByRole('heading', { name: 'Generate demo' })).toBeVisible();
    expect(within(preview).getByRole('heading', { name: 'easy' })).toBeVisible();
    expect(within(preview).getByRole('heading', { name: 'hard' })).toBeVisible();
    const choices = within(preview).getAllByRole('listitem');
    expect(choices).toHaveLength(4);
    expect(choices[0]).toHaveTextContent('<script>alert(1)</script>');
    expect(choices[1]).toHaveTextContent('Second choice');
    expect(choices[1]).toHaveTextContent('Correct choice');
    expect(within(preview).getAllByText('Correct choice')).toHaveLength(1);
    expect(preview).toHaveTextContent('<img src=x onerror="alert(1)"> Which answer?');
    expect(preview).toHaveTextContent('<a href="javascript:alert(1)">Award credit</a>');
    expect(within(preview).getByRole('heading', { name: 'Marking guidance' })).toBeVisible();
    expect(preview).toHaveTextContent('Maximum score: 5');
    expect(preview.querySelector('script, img, a, input, textarea, button')).toBeNull();
    expect(store).not.toHaveBeenCalled();
    expect(screen.getByTestId('wizard-preview-missing-subjects')).toHaveTextContent('Biology');
    expect(applyOnboardingEmitAction).not.toHaveBeenCalled();
  });

  it('never treats persisted hasDryRun alone as a reviewed author preview', async () => {
    const loading = deferred<ReturnType<typeof reviewFixture>>();
    previewOnboardingEmitAction.mockReturnValueOnce(loading.promise);
    await renderAtReviewStep(snapshot({ hasDryRun: true }));
    expect(screen.queryByRole('region', { name: 'Draft questions' })).toBeNull();
    expect(screen.getByTestId('wizard-to-apply')).toBeDisabled();
    expect(previewOnboardingEmitAction).toHaveBeenCalledTimes(1);
    await act(async () => loading.resolve(reviewFixture()));
    await showAuthorPreview();
    expect(applyOnboardingEmitAction).not.toHaveBeenCalled();
  });

  it('sends exactly the displayed hash when Apply is confirmed', async () => {
    applyOnboardingEmitAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ hasApplied: true }),
      written: 2,
      questionCount: 2,
      subjectCount: 1,
    });
    await renderAtReviewStep();
    await showAuthorPreview();
    fireEvent.click(screen.getByTestId('wizard-to-apply'));
    fireEvent.click(screen.getByTestId('wizard-apply-confirm'));
    await screen.findByTestId('wizard-applied');
    expect(applyOnboardingEmitAction).toHaveBeenCalledTimes(1);
    const data = applyOnboardingEmitAction.mock.calls[0]![0] as FormData;
    expect(data.get('expectedHash')).toBe('displayed-plan-hash');
    expect([...data.keys()]).toEqual(['expectedHash']);
  });

  it('clears preview and approval on Back from Apply and requires a new review', async () => {
    await renderAtReviewStep();
    await showAuthorPreview();
    fireEvent.click(screen.getByTestId('wizard-to-apply'));
    fireEvent.click(screen.getByTestId('wizard-back'));
    expect(screen.queryByRole('region', { name: 'Draft questions' })).toBeNull();
    expect(screen.getByTestId('wizard-to-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('wizard-preview'));
    await showAuthorPreview();
    expect(previewOnboardingEmitAction).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'AI setup' }));
    expect(screen.queryByRole('region', { name: 'Draft questions' })).toBeNull();
    fireEvent.click(screen.getByTestId('wizard-next'));
    expect(screen.getByTestId('wizard-to-apply')).toBeDisabled();
    await showAuthorPreview();
    expect(previewOnboardingEmitAction).toHaveBeenCalledTimes(3);
  });

  it('keeps approval unavailable when the initial draft check fails and allows a fresh review', async () => {
    previewOnboardingEmitAction.mockResolvedValueOnce({
      ok: false,
      reason: 'invalid',
      issues: [{ file: 'content/subjects/demo/bank.ir.json', message: 'Missing question text.' }],
    });
    await renderAtReviewStep();
    await screen.findByTestId('wizard-error');
    expect(screen.getByTestId('wizard-issues')).toHaveTextContent('Missing question text.');
    expect(screen.getByTestId('wizard-to-apply')).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Draft questions' })).toBeNull();
    expect(screen.queryByTestId('wizard-apply-confirm')).toBeNull();
    expect(applyOnboardingEmitAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh review' }));
    await showAuthorPreview();
    expect(previewOnboardingEmitAction).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('wizard-error')).toBeNull();
  });

  it('ignores an initial review response after a queued Back navigation', async () => {
    const initial = deferred<ReturnType<typeof reviewFixture>>();
    previewOnboardingEmitAction.mockReturnValueOnce(initial.promise);
    renderAtAiStep(snapshot());
    // Both events may arrive before pending locks navigation.
    act(() => {
      screen.getByTestId('wizard-next').click();
      screen.getByTestId('wizard-back').click();
    });
    await act(async () => initial.resolve(reviewFixture('obsolete-initial-hash')));
    expect(screen.getByTestId('wizard-files')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Draft questions' })).toBeNull();
    expect(applyOnboardingEmitAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('wizard-next'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    await showAuthorPreview();
    expect(previewOnboardingEmitAction).toHaveBeenCalledTimes(2);
  });

  it.each(['failure', 'exception'])(
    'clears a prior preview before a re-review %s',
    async (outcome) => {
      await renderAtReviewStep();
      await showAuthorPreview();
      if (outcome === 'failure') {
        previewOnboardingEmitAction.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
      } else {
        previewOnboardingEmitAction.mockRejectedValueOnce(new Error('failed'));
      }
      fireEvent.click(screen.getByTestId('wizard-preview'));
      expect(screen.queryByRole('region', { name: 'Draft questions' })).toBeNull();
      await screen.findByTestId('wizard-error');
      expect(screen.getByTestId('wizard-to-apply')).toBeDisabled();
      expect(screen.queryByTestId('wizard-dry-run-summary')).toBeNull();
    },
  );

  it('clears the displayed preview immediately when replacement settings change, even if saving fails', async () => {
    const saving = deferred<{ ok: false; reason: 'disk' }>();
    setReplaceSampleAction.mockReturnValue(saving.promise);
    await renderAtReviewStep();
    await showAuthorPreview();
    fireEvent.click(screen.getByTestId('wizard-replace-sample'));
    expect(screen.queryByRole('region', { name: 'Draft questions' })).toBeNull();
    expect(screen.getByTestId('wizard-to-apply')).toBeDisabled();
    await act(async () => saving.resolve({ ok: false, reason: 'disk' }));
    expect(screen.getByTestId('wizard-error')).toHaveTextContent('Could not write the file');
    expect(screen.getByTestId('wizard-to-apply')).toBeDisabled();
  });

  it('ignores an older preview response after a queued input change invalidates it', async () => {
    const old = deferred<ReturnType<typeof reviewFixture>>();
    setReplaceSampleAction.mockResolvedValue({
      ok: true,
      snapshot: snapshot({ replaceSample: true }),
    });
    await renderAtReviewStep();
    await showAuthorPreview();
    previewOnboardingEmitAction.mockReturnValueOnce(old.promise);
    // Browser events may queue together before pending disables the controls.
    act(() => {
      screen.getByTestId('wizard-preview').click();
      screen.getByTestId('wizard-replace-sample').click();
    });
    await waitFor(() => expect(setReplaceSampleAction).toHaveBeenCalledTimes(1));
    await act(async () => old.resolve(reviewFixture('obsolete-hash')));
    expect(screen.queryByRole('region', { name: 'Draft questions' })).toBeNull();
    expect(screen.getByTestId('wizard-to-apply')).toBeDisabled();
    expect(screen.getByTestId('wizard-replace-sample')).toBeChecked();
  });

  it('ignores a refreshed preview after a queued forward navigation to Apply', async () => {
    await renderAtReviewStep();
    await showAuthorPreview();
    const refresh = deferred<ReturnType<typeof reviewFixture>>();
    previewOnboardingEmitAction.mockReturnValueOnce(refresh.promise);
    act(() => {
      screen.getByTestId('wizard-preview').click();
      screen.getByTestId('wizard-to-apply').click();
    });
    await act(async () => refresh.resolve(reviewFixture('unseen-refreshed-hash')));
    expect(screen.getByTestId('wizard-apply-confirm')).toBeDisabled();
    expect(applyOnboardingEmitAction).not.toHaveBeenCalled();
  });

  it('does not restore a cancelled generation response after leaving and returning to AI setup', async () => {
    const snap = snapshot({ aiMode: 'skip-stub', subjects: [sourceSubject('alpha', 'Alpha')] });
    const old = deferred<ReturnType<typeof generated>>();
    generateOnboardingSubjectAction.mockReturnValueOnce(old.promise);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
    );
    renderAtAiStep(snap);
    fireEvent.click(screen.getByTestId('wizard-generate-alpha'));
    await screen.findByTestId('wizard-generate-progress-alpha');
    fireEvent.click(screen.getByTestId('wizard-generate-cancel'));
    await waitFor(() => expect(screen.getByTestId('wizard-back')).toBeEnabled());
    fireEvent.click(screen.getByTestId('wizard-back'));
    fireEvent.click(screen.getByTestId('wizard-next'));
    await act(async () => old.resolve(generated(snap, 'alpha')));
    expect(screen.queryByTestId('wizard-generate-run-alpha')).toBeNull();
    expect(screen.queryByTestId('wizard-ir-ready')).toBeNull();
    expect(screen.getByTestId('wizard-generate-cancelled')).toHaveTextContent('Generate cancelled');
    expect(screen.queryByTestId('wizard-error')).toBeNull();
  });

  it('clears approval after a stale Apply response and permits review again through Back', async () => {
    applyOnboardingEmitAction.mockResolvedValue({ ok: false, reason: 'stale_preview' });
    await renderAtReviewStep();
    await showAuthorPreview();
    fireEvent.click(screen.getByTestId('wizard-to-apply'));
    fireEvent.click(screen.getByTestId('wizard-apply-confirm'));
    await screen.findByTestId('wizard-apply-error');
    fireEvent.click(screen.getByTestId('wizard-back'));
    expect(screen.getByTestId('wizard-to-apply')).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Draft questions' })).toBeNull();
    fireEvent.click(screen.getByTestId('wizard-preview'));
    await showAuthorPreview();
  });
});
