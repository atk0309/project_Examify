import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ONBOARDING_INGEST_CLI,
  onboardingGenerateAndEmitCli,
  onboardingGenerateBatchIds,
  providerForOnboardingAiMode,
} from '@/lib/onboarding-types';

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'examify-onboard-gen-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  mkdirSync(path.join(root, 'content/subjects/history'), { recursive: true });
  mkdirSync(path.join(root, 'content/source-pdfs/history'), { recursive: true });
  mkdirSync(path.join(root, 'content/generated/questions'), { recursive: true });
  mkdirSync(path.join(root, 'content/generated/keys'), { recursive: true });
  writeFileSync(
    path.join(root, 'content/generated/subjects.json'),
    `${JSON.stringify([{ id: 'biology', label: 'Biology', icon: 'biology', l: 0.5, c: 0.1, h: 140 }])}\n`,
  );
  writeFileSync(path.join(root, 'content/generated/questions/biology.json'), '{}\n');
  writeFileSync(path.join(root, 'content/generated/keys/biology.json'), '{secret:true}\n');
  return root;
}

function seedSubject(root: string) {
  writeFileSync(
    path.join(root, 'content/subjects/history/bank.ir.json'),
    JSON.stringify({
      version: 1,
      subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
      difficulties: { easy: [], medium: [], hard: [] },
    }),
  );
  writeFileSync(path.join(root, 'content/subjects/history/notes.md'), 'A primary source note.\n');
  writeFileSync(path.join(root, 'content/source-pdfs/history/pack.txt'), 'Study pack text.\n');
  writeFileSync(path.join(root, 'content/source-pdfs/history.pdf'), '%PDF-1.4 standalone\n');
}

afterEach(async () => {
  const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
  const { resetOnboardingGenerateForTests } = await import('@/lib/onboarding-generate');
  setOnboardingContentRootForTests(null);
  resetOnboardingGenerateForTests();
  vi.restoreAllMocks();
});

describe('onboarding generate mapping', () => {
  it('does not treat a failed cancel POST as cancelled', async () => {
    const { postOnboardingGenerateCancel } = await import('@/lib/onboarding-types');
    const rejected = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await postOnboardingGenerateCancel('cancel-token-01', rejected)).toBe(false);

    const forbidden = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, reason: 'forbidden' }), { status: 403 }),
    );
    expect(await postOnboardingGenerateCancel('cancel-token-01', forbidden)).toBe(false);

    const committed = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, reason: 'already_committed' }), { status: 409 }),
    );
    expect(await postOnboardingGenerateCancel('cancel-token-01', committed)).toBe(false);

    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await postOnboardingGenerateCancel('cancel-token-01', ok)).toBe(true);
    expect(ok).toHaveBeenCalledWith(
      '/api/onboarding/cancel-generate',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
  });

  it('maps wizard modes to ingest providers', () => {
    expect(providerForOnboardingAiMode('cloud')).toBe('anthropic');
    expect(providerForOnboardingAiMode('cloud-openai')).toBe('openai');
    expect(providerForOnboardingAiMode('local-agent')).toBe('local');
    expect(providerForOnboardingAiMode('local-cli')).toBe('local');
    expect(providerForOnboardingAiMode('skip-stub')).toBe('test');
  });

  it('shows generate then the existing HITL emit CLI', () => {
    expect(onboardingGenerateAndEmitCli('test', 0)).toEqual([
      'pnpm examify-ingest generate --provider test --seed 0 content/subjects/<id>',
      ...ONBOARDING_INGEST_CLI,
    ]);
  });

  it('builds generate-all from source-backed subjects only', () => {
    expect(
      onboardingGenerateBatchIds([
        { id: 'biology', generateSources: [] },
        { id: 'history', generateSources: ['content/source-pdfs/history/notes.txt'] },
        { id: 'civics', generateSources: [] },
      ]),
    ).toEqual(['history']);
  });
});

describe('onboarding generate graph', () => {
  it('keeps generateSubject off the Phase 0 emit module', () => {
    const emit = readFileSync(path.join(process.cwd(), 'src/lib/onboarding.ts'), 'utf8');
    expect(emit).not.toMatch(/examify-ingest\/generate/);
    expect(emit).not.toMatch(/generateSubject/);
    expect(emit).toMatch(/resolveSubjectSources/);
    const generate = readFileSync(
      path.join(process.cwd(), 'src/lib/onboarding-generate.ts'),
      'utf8',
    );
    expect(generate).toMatch(/from 'examify-ingest\/generate'/);
    expect(generate).toMatch(/generateSubject/);
    expect(generate).toMatch(/dryRunIr: true/);
    expect(generate).toMatch(/signal: controller\.signal/);
    expect(generate).toMatch(/abortControllers\.get\(token\)\?\.abort\(\)/);
    expect(generate).toMatch(/GenerateAbortedError/);
    expect(generate).not.toMatch(/isAbortError/);
    expect(generate).toMatch(/dropGenerateAbort\(token\)/);
    expect(generate).toMatch(/const MAX_CANCEL_TOKENS = 64/);
    expect(generate).toMatch(/oldest token[\s\S]*evicted \(FIFO\)/);
    expect(generate).not.toMatch(/applyEmit|planEmit|applyOnboardingEmit/);
    const wizard = readFileSync(
      path.join(process.cwd(), 'src/components/exam/OnboardingWizard.tsx'),
      'utf8',
    );
    expect(wizard).not.toMatch(/examify-ingest\/generate/);
    expect(wizard).not.toMatch(/generateSubject/);
    expect(wizard).toMatch(/case 'invalid':\n      return 'That input is not valid\.'/);
    expect(wizard).toMatch(/case 'rate_limited':/);
    expect(wizard).toMatch(/Clear the \$\{label\} from this host/);
    expect(wizard).toContain('label="Anthropic API key"');
    expect(wizard).toContain('label="OpenAI API key"');
  });

  it('locks Anthropic key UI to cloud mode and the OpenAI #69 bars', () => {
    const wizard = readFileSync(
      path.join(process.cwd(), 'src/components/exam/OnboardingWizard.tsx'),
      'utf8',
    );
    const actions = readFileSync(path.join(process.cwd(), 'src/actions/onboarding.ts'), 'utf8');
    const store = readFileSync(path.join(process.cwd(), 'src/lib/env-store.ts'), 'utf8');
    const flags = readFileSync(path.join(process.cwd(), 'src/lib/onboarding.ts'), 'utf8');
    const grading = readFileSync(path.join(process.cwd(), 'src/lib/grading/index.ts'), 'utf8');

    const anthropicPanelAt = wizard.indexOf('testId="wizard-anthropic-key"');
    expect(anthropicPanelAt).toBeGreaterThan(-1);
    const cloudGate = wizard.lastIndexOf("snapshot.aiMode === 'cloud'", anthropicPanelAt);
    expect(cloudGate).toBeGreaterThan(-1);
    expect(wizard.slice(cloudGate, anthropicPanelAt)).not.toMatch(/cloud-openai/);
    expect(wizard).toMatch(/snapshot\.aiMode === 'cloud-openai'/);

    expect(wizard).toMatch(/type="password"/);
    expect(wizard).toMatch(/autoComplete="off"/);
    expect(wizard).toMatch(/window\.confirm\(/);
    expect(wizard).toMatch(
      /Generate and grading that need this key fail closed until you set a new one\. A restart will not brick the app/,
    );
    expect(wizard).toMatch(/className="btn btn-ghost"/);
    expect(wizard).toMatch(/data-testid=\{\`\$\{testId\}-rotate\`\}/);
    expect(wizard).toMatch(/data-testid=\{\`\$\{testId\}-clear\`\}/);
    expect(wizard).toContain(
      '{configured ? <span className="wizard-mode-badge">Configured</span> : null}',
    );
    expect(wizard).not.toMatch(/NEXT_PUBLIC_ANTHROPIC|NEXT_PUBLIC_OPENAI/);

    expect(actions).toMatch(/checkRateLimit\(ip, 'env_write'\)/);
    expect(actions).toMatch(/ANTHROPIC_ENV_KEY/);
    expect(actions).toMatch(/setOnboardingAnthropicKeyAction/);
    expect(actions).not.toMatch(/NEXT_PUBLIC_/);

    expect(store).toMatch(/findRepoRoot/);
    expect(store).toMatch(/Never NEXT_PUBLIC_\*/);
    expect(store).toMatch(/raw\.includes\('\\0'\)/);
    expect(store).toMatch(/envStoreSecretHostManaged/);

    expect(flags).toMatch(/anthropicConfigured: envStoreSecretConfigured\('ANTHROPIC_API_KEY'\)/);
    expect(flags).toMatch(/anthropicHostManaged: envStoreSecretHostManaged\('ANTHROPIC_API_KEY'\)/);
    expect(flags).not.toMatch(/ANTHROPIC_API_KEY: env\.ANTHROPIC_API_KEY/);

    // Grader + Configured badge stay twins: live process.env / env-store, never
    // the boot-frozen env.ts snapshot (clear must fail closed, not restub).
    // OpenAI is not in the Next grader; CLI generate already re-merges .env.
    expect(grading).not.toMatch(/from ['"]@\/lib\/env['"]/);
    expect(grading).not.toMatch(/(?<!process\.)env\.ANTHROPIC_API_KEY/);
    expect(grading).toMatch(/process\.env\[ANTHROPIC_ENV_KEY\]/);
    expect(grading).toMatch(/envStoreSecretConfigured\('ANTHROPIC_API_KEY'\)/);
    expect(grading).not.toMatch(/OPENAI_API_KEY/);
    const generateCli = readFileSync(
      path.join(process.cwd(), 'tools/examify-ingest/src/generate-cli.ts'),
      'utf8',
    );
    expect(generateCli).toMatch(/mergeRepoEnvFiles\(repoRoot, io\.env \?\? process\.env\)/);
    const envSchema = readFileSync(path.join(process.cwd(), 'src/lib/env.ts'), 'utf8');
    expect(envSchema).toMatch(
      /ANTHROPIC_API_KEY: z\.preprocess\(emptyToUndef, z\.string\(\)\.min\(1\)\.optional\(\)\)/,
    );
    expect(envSchema).not.toMatch(/ANTHROPIC_API_KEY:[\s\S]*?\?\? dev\('test'\)/);
    expect(envSchema).not.toMatch(/OPENAI_API_KEY:/);
  });

  it('locks Welcome skip, Back, and rail while generateBusy so Cancel stays reachable', () => {
    const wizard = readFileSync(
      path.join(process.cwd(), 'src/components/exam/OnboardingWizard.tsx'),
      'utf8',
    );
    expect(wizard).toMatch(
      /const holdWizard = generateBusy \|\| \(pending && !generateCancelAck\)/,
    );
    expect(wizard).toMatch(/const navLocked = holdWizard/);
    expect(wizard).toMatch(/const go = \(next: StepId\) => \{\s*if \(generateBusy\) return;/);
    expect(wizard).toMatch(/const skip = \(\) => \{\s*if \(generateBusy\) return;/);
    expect(wizard).toMatch(/disabled=\{!clickable \|\| navLocked\}/);
    expect(wizard).toMatch(/generateCancelRef\.current = true/);
    expect(wizard).toMatch(/generateCancelTokenRef\.current = null/);
    expect(wizard).toMatch(/generateCancelRef\.current = false/);
    expect(wizard).toMatch(/data-testid="wizard-generate-cancelled"/);
    expect(wizard).toMatch(/className="wizard-callout" data-testid="wizard-generate-cancelled"/);
    expect(wizard).toMatch(
      /if \(result\.reason === 'cancelled'\) \{\s*setGenerateNote\('Generate cancelled'\)/,
    );
    expect(wizard).toMatch(
      /if \(result\.reason === 'cancelled' \|\| generateCancelRef\.current\) \{\s*cancelled = true;/,
    );
    expect(wizard).toMatch(
      /const recorded = await postOnboardingGenerateCancel\(token\);\s*if \(!recorded\) \{\s*setError\('Could not cancel generate\.'\)/,
    );
    expect(wizard).toMatch(
      /generateCancelRef\.current = true;\s*if \(generateCancelTokenRef\.current !== token\) return;\s*setError\(null\);\s*setGenerateNote\('Generate cancelled'\);\s*setGenerateBusy\(false\);\s*setGenerateCancelAck\(true\)/,
    );
    expect(wizard).toMatch(/postOnboardingGenerateCancel\(token\)/);
    expect(wizard).not.toMatch(/cancelOnboardingGenerateAction/);
    expect(wizard).toMatch(
      /\} finally \{\s*if \(generateCancelTokenRef\.current === token\) \{\s*generateCancelTokenRef\.current = null;/,
    );
    const welcomeSkipAt = wizard.indexOf('Use sample bank for now');
    expect(welcomeSkipAt).toBeGreaterThan(-1);
    const welcomeSkipDisabled = wizard.lastIndexOf('disabled=', welcomeSkipAt);
    expect(wizard.slice(welcomeSkipDisabled, welcomeSkipAt)).toMatch(/disabled=\{navLocked\}/);

    const backAt = wizard.indexOf('data-testid="wizard-back"');
    expect(backAt).toBeGreaterThan(-1);
    const backDisabled = wizard.lastIndexOf('disabled=', backAt);
    expect(wizard.slice(backDisabled, backAt)).toMatch(/disabled=\{navLocked\}/);
  });

  it('keeps irReady on generate-all cancel after a subject finished', () => {
    const wizard = readFileSync(
      path.join(process.cwd(), 'src/components/exam/OnboardingWizard.tsx'),
      'utf8',
    );
    expect(wizard).toMatch(
      /\/\/ Keep IR-ready for subjects that already finished \(including generate-all cancel\)\./,
    );
    expect(wizard).toMatch(/if \(wroteAny\) setIrReady\(true\)/);
    expect(wizard).toMatch(/if \(cancelled\) setGenerateNote\('Generate cancelled'\)/);
  });

  it('keeps dry-run step id and testids while the rail label is Review', () => {
    const wizard = readFileSync(
      path.join(process.cwd(), 'src/components/exam/OnboardingWizard.tsx'),
      'utf8',
    );
    expect(wizard).toMatch(/\{ id: 'dry-run', label: 'Review' \}/);
    expect(wizard).toContain('data-testid="wizard-dry-run"');
    expect(wizard).toContain('data-testid="wizard-dry-run-summary"');
    expect(wizard).toContain('data-testid="wizard-planned-deletes"');
  });
});

describe('onboarding generate sources', () => {
  it('lists source-pdfs dir, standalone <id>.pdf, and subject-folder files except IR', async () => {
    const { listOnboardingGenerateSources, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    expect(listOnboardingGenerateSources('history', root)).toEqual([
      'content/source-pdfs/history.pdf',
      'content/source-pdfs/history/pack.txt',
      'content/subjects/history/notes.md',
    ]);
  });

  it('refuses preview sources that resolve outside the allowed trees', async () => {
    const { listOnboardingGenerateSources, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    writeFileSync(path.join(root, 'outside.txt'), 'not a generate source\n');
    symlinkSync(
      path.join(root, 'outside.txt'),
      path.join(root, 'content/subjects/history/leak.txt'),
    );
    setOnboardingContentRootForTests(root);
    expect(() => listOnboardingGenerateSources('history', root)).toThrow(/refusing source outside/);
  });
});

describe('generateOnboardingSubject', () => {
  it('writes BankIR only and returns public progress (no answers/keys)', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const generatedBefore = {
      subjects: readFileSync(path.join(root, 'content/generated/subjects.json'), 'utf8'),
      questions: readFileSync(path.join(root, 'content/generated/questions/biology.json'), 'utf8'),
      keys: readFileSync(path.join(root, 'content/generated/keys/biology.json'), 'utf8'),
    };

    const ingest = await import('examify-ingest/generate');
    const generateSpy = vi.spyOn(ingest, 'generateSubject');

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(generateSpy).toHaveBeenCalledWith(expect.objectContaining({ dryRunIr: true }));
    expect(generateSpy.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected generate');
    expect(result.result.wroteIr).toBe(true);
    expect(result.result.provider).toBe('test');
    expect(result.result.seed).toBe(0);
    expect(result.result.sourceCount).toBe(3);
    expect(result.result.irRel).toBe('content/subjects/history/bank.ir.json');
    expect(JSON.stringify(result)).not.toMatch(/"answer"/);
    expect(JSON.stringify(result)).not.toMatch(/"rubric"/);
    expect(JSON.stringify(result)).not.toMatch(/"maxScore"/);
    expect(JSON.stringify(result)).not.toMatch(/provenance/);

    const ir = JSON.parse(
      readFileSync(path.join(root, 'content/subjects/history/bank.ir.json'), 'utf8'),
    ) as { difficulties: { easy: { id: string }[] } };
    expect(ir.difficulties.easy[0]?.id).toBe('history-easy-1');
    expect(existsSync(path.join(root, 'content/generated/questions/history.json'))).toBe(false);
    expect(readFileSync(path.join(root, 'content/generated/subjects.json'), 'utf8')).toBe(
      generatedBefore.subjects,
    );
    expect(readFileSync(path.join(root, 'content/generated/questions/biology.json'), 'utf8')).toBe(
      generatedBefore.questions,
    );
    expect(readFileSync(path.join(root, 'content/generated/keys/biology.json'), 'utf8')).toBe(
      generatedBefore.keys,
    );
  });

  it('fails closed on empty sources without writing IR', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    writeFileSync(
      path.join(root, 'content/subjects/history/bank.ir.json'),
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    const before = readFileSync(path.join(root, 'content/subjects/history/bank.ir.json'), 'utf8');
    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected empty sources');
    expect(result.reason).toBe('empty_sources');
    expect(readFileSync(path.join(root, 'content/subjects/history/bank.ir.json'), 'utf8')).toBe(
      before,
    );
  });

  it('fails closed for openai without a real key (no stub)', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await generateOnboardingSubject({
        subjectId: 'history',
        provider: 'openai',
        seed: 0,
        root,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected missing key');
      expect(result.reason).toBe('missing_key');
      expect(result.message).toMatch(/OPENAI_API_KEY/i);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('fails closed for anthropic without a real key (no stub)', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    try {
      const result = await generateOnboardingSubject({
        subjectId: 'history',
        provider: 'anthropic',
        seed: 0,
        root,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected missing key');
      expect(result.reason).toBe('missing_key');
      expect(result.message).toMatch(/ANTHROPIC_API_KEY|sentinel/i);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('discards the preview and leaves prior IR unchanged when cancel wins before commit', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject, requestOnboardingGenerateCancel } =
      await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = `${JSON.stringify({
      version: 1,
      subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
      difficulties: {
        easy: [
          {
            id: 'history-easy-prior',
            type: 'mcq',
            q: 'Prior IR that cancel must keep?',
            choices: ['A', 'B', 'C', 'D'],
            answer: 0,
            provenance: { pdf: 'hand-authored', locator: 'unit' },
          },
        ],
        medium: [],
        hard: [],
      },
    })}\n`;
    writeFileSync(irPath, prior);

    const token = 'cancel-token-01';
    const actual = ingest.generateSubject;
    const spy = vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      expect(request.dryRunIr).toBe(true);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.signal?.aborted).toBe(false);
      const generated = await actual(request);
      requestOnboardingGenerateCancel(token);
      return generated;
    });

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: token,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected cancelled');
    expect(result.reason).toBe('cancelled');
    expect(readFileSync(irPath, 'utf8')).toBe(prior);
    expect(spy).toHaveBeenCalled();
  });

  it('refuses a kebab-case id that is not in the wizard catalog', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    mkdirSync(path.join(root, 'content/source-pdfs/rogue-id'), { recursive: true });
    writeFileSync(path.join(root, 'content/source-pdfs/rogue-id/notes.txt'), 'foreign source\n');

    const result = await generateOnboardingSubject({
      subjectId: 'rogue-id',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected missing catalog member');
    expect(result.reason).toBe('missing');
    expect(existsSync(path.join(root, 'content/subjects/rogue-id/bank.ir.json'))).toBe(false);
  });

  it('does not resurrect a subject deleted before the IR commit', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const subjectDir = path.join(root, 'content/subjects/history');
    const irPath = path.join(subjectDir, 'bank.ir.json');
    const actual = ingest.generateSubject;
    vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      const generated = await actual(request);
      rmSync(subjectDir, { recursive: true, force: true });
      return generated;
    });

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected missing after delete');
    expect(result.reason).toBe('missing');
    expect(existsSync(irPath)).toBe(false);
    expect(existsSync(subjectDir)).toBe(false);
  });

  it('serializes generate commits on the process-local mutex', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const { generateSubject: actualGenerateSubject } =
      await vi.importActual<typeof ingest>('examify-ingest/generate');
    let firstInFlight = false;
    let secondStartedWhileFirstHeld = false;
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      calls += 1;
      if (calls === 1) {
        firstInFlight = true;
        await firstHold;
        return actualGenerateSubject(request);
      }
      if (firstInFlight) secondStartedWhileFirstHeld = true;
      return actualGenerateSubject(request);
    });

    const first = generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    await vi.waitFor(() => {
      expect(firstInFlight).toBe(true);
    });
    const second = generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 1,
      root,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondStartedWhileFirstHeld).toBe(false);
    expect(calls).toBe(1);
    firstInFlight = false;
    releaseFirst();
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('skips the IR write when cancel lands after generate starts and before commit', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject, requestOnboardingGenerateCancel } =
      await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(irPath, 'utf8');
    const { generateSubject: actualGenerateSubject } =
      await vi.importActual<typeof ingest>('examify-ingest/generate');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      await blocked;
      return actualGenerateSubject(request);
    });

    const token = 'cancel-token-01';
    const pending = generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: token,
    });
    await vi.waitFor(() => {
      expect(ingest.generateSubject).toHaveBeenCalled();
    });
    requestOnboardingGenerateCancel(token);
    release();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected cancelled');
    expect(result.reason).toBe('cancelled');
    expect(readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('aborts the in-flight generateSubject signal and does not write IR', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject, requestOnboardingGenerateCancel } =
      await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(irPath, 'utf8');
    const writeSpy = vi.spyOn(ingest, 'writeFileAtomic');
    let seenSignal: AbortSignal | undefined;
    vi.spyOn(ingest, 'generateSubject').mockImplementation((request) => {
      seenSignal = request.signal;
      expect(request.signal).toBeInstanceOf(AbortSignal);
      return new Promise<never>((_resolve, reject) => {
        if (request.signal?.aborted) {
          reject(new ingest.GenerateAbortedError());
          return;
        }
        request.signal?.addEventListener(
          'abort',
          () => {
            reject(new ingest.GenerateAbortedError());
          },
          { once: true },
        );
      });
    });

    const token = 'cancel-token-01';
    const pending = generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: token,
    });
    await vi.waitFor(() => {
      expect(seenSignal).toBeInstanceOf(AbortSignal);
    });
    expect(seenSignal?.aborted).toBe(false);
    expect(requestOnboardingGenerateCancel(token)).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected cancelled');
    expect(result.reason).toBe('cancelled');
    expect(result.message).toBe('Generate cancelled.');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('maps GenerateAbortedError to cancelled, not invalid', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(irPath, 'utf8');
    const writeSpy = vi.spyOn(ingest, 'writeFileAtomic');
    vi.spyOn(ingest, 'generateSubject').mockRejectedValue(
      new ingest.GenerateAbortedError('raw abort internals'),
    );

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected cancelled');
    expect(result.reason).toBe('cancelled');
    expect(result.reason).not.toBe('invalid');
    expect(result.message).toBe('Generate cancelled.');
    expect(result.message).not.toMatch(/raw abort|generate aborted/i);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('does not treat a bare AbortError timeout as cancelled', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(irPath, 'utf8');
    const writeSpy = vi.spyOn(ingest, 'writeFileAtomic');
    const timeout = new DOMException('The operation was aborted due to timeout', 'AbortError');
    vi.spyOn(ingest, 'generateSubject').mockRejectedValue(timeout);

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).not.toBe('cancelled');
    expect(result.reason).toBe('invalid');
    expect(result.message).not.toBe('Generate cancelled.');
    expect(ingest.isAbortError(timeout)).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('rejects cancel after the IR commit has already won', async () => {
    const { generateOnboardingSubject, requestOnboardingGenerateCancel } =
      await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const token = 'cancel-token-01';
    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: token,
    });
    expect(result.ok).toBe(true);
    expect(requestOnboardingGenerateCancel(token)).toBe(false);
  });

  it('evicts the oldest cancel token at FIFO cap 64', async () => {
    const { generateOnboardingSubject, requestOnboardingGenerateCancel } =
      await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(irPath, 'utf8');

    for (let i = 0; i < 65; i += 1) {
      requestOnboardingGenerateCancel(`tok-${String(i).padStart(6, '0')}`);
    }

    const evicted = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: 'tok-000000',
    });
    expect(evicted.ok).toBe(true);
    if (!evicted.ok) throw new Error('expected evicted token to no longer cancel');

    writeFileSync(irPath, prior);
    const kept = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: 'tok-000064',
    });
    expect(kept.ok).toBe(false);
    if (kept.ok) throw new Error('expected newest token to still cancel');
    expect(kept.reason).toBe('cancelled');
    expect(readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('fails closed for local without CMD or BASE_URL', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    const prevCmd = process.env.EXAMIFY_INGEST_LOCAL_CMD;
    const prevUrl = process.env.EXAMIFY_LLM_BASE_URL;
    delete process.env.EXAMIFY_INGEST_LOCAL_CMD;
    delete process.env.EXAMIFY_LLM_BASE_URL;
    try {
      const result = await generateOnboardingSubject({
        subjectId: 'history',
        provider: 'local',
        seed: 0,
        root,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected missing local');
      expect(result.reason).toBe('missing_local');
    } finally {
      if (prevCmd === undefined) delete process.env.EXAMIFY_INGEST_LOCAL_CMD;
      else process.env.EXAMIFY_INGEST_LOCAL_CMD = prevCmd;
      if (prevUrl === undefined) delete process.env.EXAMIFY_LLM_BASE_URL;
      else process.env.EXAMIFY_LLM_BASE_URL = prevUrl;
    }
  });
});
