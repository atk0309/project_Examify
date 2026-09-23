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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ONBOARDING_INGEST_CLI,
  confirmOnboardingIrOverwrite,
  generateIrWriteLabel,
  generateIrWriteVerb,
  onboardingGenerateAndEmitCli,
  onboardingGenerateBatchIds,
  onboardingGenerateCli,
  onboardingGenerateOverwriteSubjects,
  onboardingIngestCli,
  onboardingShadowNotice,
  onboardingSubjectIrRel,
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
      difficulties: {
        easy: [
          {
            id: 'history-easy-1',
            type: 'mcq',
            q: 'Prior history item?',
            choices: ['A', 'B', 'C', 'D'],
            answer: 0,
            provenance: { pdf: 'hand-authored', locator: 'prior' },
          },
        ],
        medium: [],
        hard: [],
      },
    }),
  );
  writeFileSync(path.join(root, 'content/subjects/history/notes.md'), 'A primary source note.\n');
  writeFileSync(path.join(root, 'content/source-pdfs/history/pack.txt'), 'Study pack text.\n');
  writeFileSync(path.join(root, 'content/source-pdfs/history.pdf'), '%PDF-1.4 standalone\n');
}

/** A fake checkout with no `.env`: generate never reads the developer's real keys. */
function keylessCheckout(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'examify-onboard-gen-checkout-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
  return root;
}

beforeEach(async () => {
  const { setEnvStoreRootForTests } = await import('@/lib/env-store');
  setEnvStoreRootForTests(keylessCheckout());
});

afterEach(async () => {
  const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
  const { resetOnboardingGenerateForTests } = await import('@/lib/onboarding-generate');
  const { setEnvStoreRootForTests } = await import('@/lib/env-store');
  setOnboardingContentRootForTests(null);
  setEnvStoreRootForTests(null);
  resetOnboardingGenerateForTests();
  vi.restoreAllMocks();
});

describe('onboarding generate mapping', () => {
  it('does not treat a failed cancel POST as cancelled', async () => {
    const { postOnboardingGenerateCancel } = await import('@/lib/onboarding-types');
    const rejected = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await postOnboardingGenerateCancel('cancel-token-01', rejected)).toBe('failed');

    const forbidden = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, reason: 'forbidden' }), { status: 403 }),
    );
    expect(await postOnboardingGenerateCancel('cancel-token-01', forbidden)).toBe('failed');

    const conflict = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, reason: 'other' }), { status: 409 }),
    );
    expect(await postOnboardingGenerateCancel('cancel-token-01', conflict)).toBe('failed');

    const committed = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, reason: 'already_committed' }), { status: 409 }),
    );
    expect(await postOnboardingGenerateCancel('cancel-token-01', committed)).toBe(
      'already_committed',
    );

    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await postOnboardingGenerateCancel('cancel-token-01', ok)).toBe('cancelled');
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

  it('names the family data folder in power-user commands', () => {
    expect(onboardingGenerateAndEmitCli('openai', 2, 'data')).toEqual([
      'pnpm examify-ingest generate --provider openai --seed 2 data/content/subjects/<id>',
      'pnpm examify-ingest validate data/content/subjects',
      'pnpm examify-ingest emit data/content/subjects --dry-run',
      'pnpm examify-ingest emit data/content/subjects --apply',
    ]);
    expect(onboardingGenerateCli('test', 0, 'history', '/srv/examify-data')).toBe(
      'pnpm examify-ingest generate --provider test --seed 0 /srv/examify-data/content/subjects/history',
    );
    expect(onboardingIngestCli('/srv/family data')[0]).toBe(
      "pnpm examify-ingest validate '/srv/family data/content/subjects'",
    );
    expect(onboardingIngestCli('.')).toEqual([...ONBOARDING_INGEST_CLI]);
  });

  it('words the built-in replacement notice', () => {
    expect(onboardingShadowNotice([])).toBeNull();
    expect(onboardingShadowNotice([{ label: 'Biology' }])).toBe(
      'Replaces built-in subject: Biology. Your family sees your version after Apply.',
    );
    expect(onboardingShadowNotice([{ label: 'Biology' }, { label: 'Demo' }])).toBe(
      'Replaces built-in subjects: Biology, Demo. Your family sees your version after Apply.',
    );
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

  it('names overwrite the same way CLI dry-run would', () => {
    expect(onboardingSubjectIrRel('history')).toBe('content/subjects/history/bank.ir.json');
    expect(generateIrWriteVerb(false, false)).toBe('would write');
    expect(generateIrWriteVerb(true, false)).toBe('wrote');
    expect(generateIrWriteVerb(false, true)).toBe('would overwrite');
    expect(generateIrWriteVerb(true, true)).toBe('overwrote');
    expect(generateIrWriteLabel('content/subjects/history/bank.ir.json', false, true)).toBe(
      'would overwrite content/subjects/history/bank.ir.json',
    );
  });

  it('confirms one label or a batch count, and decline is skip', () => {
    expect(
      onboardingGenerateOverwriteSubjects(
        [
          { id: 'history', hasIr: true },
          { id: 'civics', hasIr: false },
          { id: 'biology', hasIr: true },
        ],
        ['history', 'civics', 'biology'],
      ).map((row) => row.id),
    ).toEqual(['history', 'biology']);

    const asked: string[] = [];
    expect(
      confirmOnboardingIrOverwrite([{ label: 'History' }], (message) => {
        asked.push(message);
        return true;
      }),
    ).toBe('force');
    expect(asked).toEqual(['Replace existing BankIR for History?']);

    asked.length = 0;
    expect(
      confirmOnboardingIrOverwrite([{ label: 'History' }, { label: 'Biology' }], (message) => {
        asked.push(message);
        return false;
      }),
    ).toBe('skip');
    expect(asked).toEqual(['Replace 2 existing BankIR files (History, Biology)?']);
    expect(confirmOnboardingIrOverwrite([], () => false)).toBe('force');
  });

  it('names leftover prune subjects and cancel copy', async () => {
    const { onboardingPruneConfirmMessage, onboardingPruneEntries, onboardingPruneSubjectIds } =
      await import('@/lib/onboarding-types');
    const plan = [
      { path: 'content/generated/questions/history.json', action: 'add' as const },
      { path: 'content/generated/questions/chemistry.json', action: 'delete' as const },
      { path: 'content/generated/keys/chemistry.json', action: 'delete' as const },
    ];
    const deletes = onboardingPruneEntries(plan);
    expect(onboardingPruneSubjectIds(deletes)).toEqual(['chemistry']);
    expect(onboardingPruneConfirmMessage(deletes)).toMatch(/chemistry/);
    expect(onboardingPruneConfirmMessage(deletes)).toMatch(/Cancel keeps everything/);
    expect(onboardingPruneConfirmMessage([])).toBeNull();
  });
});

describe('onboarding generate graph', () => {
  it('keeps generateSubject off the Phase 0 emit module', () => {
    const emit = readFileSync(path.join(process.cwd(), 'src/lib/onboarding.ts'), 'utf8');
    expect(emit).not.toMatch(/examify-ingest\/generate/);
    expect(emit).not.toMatch(/generateSubject/);
    expect(emit).toMatch(/hasExistingBankIr/);
    expect(emit).not.toMatch(/existsSync\(irPath\)/);
    expect(emit).toMatch(/resolveSubjectSources/);
    const generate = readFileSync(
      path.join(process.cwd(), 'src/lib/onboarding-generate.ts'),
      'utf8',
    );
    expect(generate).toMatch(/from 'examify-ingest\/generate'/);
    expect(generate).toMatch(/generateSubject/);
    expect(generate).toMatch(/dryRunIr: true/);
    expect(generate).toMatch(/needs_confirm/);
    expect(generate).toMatch(/overwrite === 'skip'/);
    expect(generate).toMatch(/hasExistingBankIr/);
    expect(generate).not.toMatch(/existsSync\(/);
    expect(generate).not.toMatch(/isExistingBankIr|isPlaceholderBankIr/);
    expect(generate).toMatch(/writeBankIrAtomic/);
    expect(generate).toMatch(/assertCanWriteBankIr/);
    expect(generate).toMatch(/BankIrOverwriteError/);
    expect(generate).not.toMatch(/writeFileAtomic\(/);
    expect(generate).toMatch(/never leak CLI `--force`/);
    expect(generate).toMatch(/signal: controller\.signal/);
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
    expect(wizard).toMatch(/case 'skipped':\n      return 'Generate skipped\.'/);
    expect(wizard).toMatch(/case 'needs_confirm':/);
    expect(wizard).toMatch(/case 'rate_limited':/);
    expect(wizard).toMatch(/Clear the \$\{label\} from this host/);
    expect(wizard).toContain('label="Anthropic API key"');
    expect(wizard).toContain('label="OpenAI API key"');
    expect(wizard).toMatch(/Replace existing BankIR for \$\{/);
    expect(wizard).toMatch(/wizard-generate-skipped/);
    expect(wizard).toMatch(/data-testid="wizard-generate-overwrite-batch"/);
    expect(wizard).toMatch(/Generate from local sources/);
    expect(wizard).not.toMatch(/Generate from PDFs/);
    expect(wizard).toMatch(/notes\.txt/);
    expect(wizard).toMatch(/wizard-ready-subjects/);
    expect(wizard).toMatch(/wizard-apply-prune/);
    expect(wizard).toMatch(/confirmPrune/);
    expect(wizard).toMatch(/A test sentinel is present/);
    expect(wizard).toMatch(/data\.set\('force', '1'\)/);
    expect(wizard).toMatch(/data-testid="wizard-validate-panel"/);
    expect(
      [...wizard.matchAll(/data-testid="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((id) => id === 'wizard-validate'),
    ).toHaveLength(1);
    expect(wizard).toMatch(/setGenerateNote\(null\)/);
    expect(wizard).not.toMatch(/hasExistingIr \?/);
    expect(wizard).toMatch(/<h2 className="wizard-subhead">Generate from local sources<\/h2>/);
    expect(wizard).toMatch(/wizard-generate-sources/);
    expect(wizard).toMatch(/confirmOnboardingIrOverwrite/);
    const types = readFileSync(path.join(process.cwd(), 'src/lib/onboarding-types.ts'), 'utf8');
    expect(types).toMatch(/Replace existing BankIR for \$\{colliding\[0\]!\.label\}\?/);
    expect(types).toMatch(
      /Replace \$\{colliding\.length\} existing BankIR files \(\$\{names\}\)\?/,
    );
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
    // The badge renders only for a configured mode; CLI modes say "Found".
    expect(wizard).toMatch(
      /\{configured \? \(\s*<span className="wizard-mode-badge">\{agentCli \? 'Found' : 'Configured'\}<\/span>\s*\) : null\}/,
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
    expect(flags).toMatch(/anthropicPresent: envStoreSecretPresent\('ANTHROPIC_API_KEY'\)/);
    expect(flags).toMatch(/anthropicLiveTest: envStoreSecretLiveTest\('ANTHROPIC_API_KEY'\)/);
    expect(flags).toMatch(/anthropicHostManaged: envStoreSecretHostManaged\('ANTHROPIC_API_KEY'\)/);
    expect(flags).toMatch(
      /anthropicWriteBlocked: envStoreSecretWriteBlocked\('ANTHROPIC_API_KEY'\)/,
    );
    expect(wizard).toMatch(/liveTest=\{snapshot\.anthropicLiveTest\}/);
    expect(wizard).toMatch(/writeBlocked=\{snapshot\.anthropicWriteBlocked\}/);
    expect(wizard).not.toMatch(/present && !configured/);
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
    expect(wizard).toMatch(/wizard-generate-cancelled/);
    expect(wizard).toMatch(/wizard-generate-skipped/);
    expect(wizard).toMatch(/wizard-generate-overwrite/);
    expect(wizard).toMatch(
      /if \(result\.reason === 'cancelled'\) \{\s*setGenerateNoteKind\('cancelled'\);\s*setGenerateNote\('Generate cancelled'\)/,
    );
    expect(wizard).toMatch(
      /if \(result\.reason === 'cancelled' \|\| generateCancelRef\.current\) \{\s*cancelled = true;/,
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
      force: true,
    });
    expect(generateSpy).toHaveBeenCalledWith(expect.objectContaining({ dryRunIr: true }));
    expect(generateSpy.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected generate');
    expect(result.result.wroteIr).toBe(true);
    expect(result.result.overwrite).toBe(true);
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

  it('refuses to generate or commit BankIR through a link into the checkout', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const ingest = await import('examify-ingest/generate');
    // A fake checkout that holds a history subject (the link target) …
    const checkout = tempRoot();
    seedSubject(checkout);
    const trackedIr = path.join(checkout, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(trackedIr, 'utf8');
    const linkSubjects = (family: string) => {
      rmSync(path.join(family, 'content/subjects'), { recursive: true, force: true });
      symlinkSync(path.join(checkout, 'content/subjects'), path.join(family, 'content/subjects'));
    };

    // … linked before Generate: refused before the provider call.
    const linked = tempRoot();
    linkSubjects(linked);
    const original = ingest.generateSubject;
    const generateSpy = vi.spyOn(ingest, 'generateSubject');
    expect(
      await generateOnboardingSubject({
        subjectId: 'history',
        provider: 'test',
        seed: 0,
        root: linked,
        force: true,
      }),
    ).toMatchObject({ ok: false, reason: 'unsafe_path' });
    expect(generateSpy).not.toHaveBeenCalled();

    // … or swapped in while the provider runs: refused right before the write.
    const swapped = tempRoot();
    seedSubject(swapped);
    generateSpy.mockImplementationOnce(async (request) => {
      const generated = await original(request);
      linkSubjects(swapped);
      return generated;
    });
    expect(
      await generateOnboardingSubject({
        subjectId: 'history',
        provider: 'test',
        seed: 0,
        root: swapped,
        force: true,
      }),
    ).toMatchObject({ ok: false, reason: 'unsafe_path' });
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(readFileSync(trackedIr, 'utf8')).toBe(prior);
  });

  it('does not write over existing IR without confirm', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const ingest = await import('examify-ingest/generate');
    const root = tempRoot();
    seedSubject(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(irPath, 'utf8');
    const writeSpy = vi.spyOn(ingest, 'writeBankIrAtomic');
    const generateSpy = vi.spyOn(ingest, 'generateSubject');

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected needs_confirm');
    expect(result.reason).toBe('needs_confirm');
    expect(result.reason).not.toBe('invalid');
    expect(result.message).toBe('would overwrite content/subjects/history/bank.ir.json');
    expect(result.message).not.toMatch(/--force/);
    expect(result.irRel).toBe('content/subjects/history/bank.ir.json');
    expect(generateSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('does not require overwrite confirm for empty or placeholder BankIR', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { listOnboardingSubjects, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    writeFileSync(path.join(root, 'content/subjects/history/notes.txt'), 'A source note.\n');
    writeFileSync(
      path.join(root, 'content/subjects/history/subject.json'),
      JSON.stringify({
        id: 'history',
        label: 'History',
        icon: 'geography',
        l: 0.6,
        c: 0.08,
        h: 40,
      }),
    );
    expect(listOnboardingSubjects(root)[0]?.hasIr).toBe(false);

    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    writeFileSync(irPath, '');
    expect(listOnboardingSubjects(root)[0]?.hasIr).toBe(false);
    const empty = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) throw new Error('expected generate over empty IR');
    expect(empty.result.overwrite).toBe(false);
    rmSync(irPath);

    writeFileSync(
      irPath,
      JSON.stringify({
        version: 1,
        subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
        difficulties: { easy: [], medium: [], hard: [] },
      }),
    );
    expect(listOnboardingSubjects(root)[0]?.hasIr).toBe(false);

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected generate without confirm');
    expect(result.result.wroteIr).toBe(true);
    expect(result.result.overwrite).toBe(false);
    expect(listOnboardingSubjects(root)[0]?.hasIr).toBe(true);
  });

  it('requires overwrite confirm for corrupt BankIR and keeps bytes on skip', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { listOnboardingSubjects, setOnboardingContentRootForTests } =
      await import('@/lib/onboarding');
    const ingest = await import('examify-ingest/generate');
    const root = tempRoot();
    setOnboardingContentRootForTests(root);
    writeFileSync(path.join(root, 'content/subjects/history/notes.txt'), 'A source note.\n');
    writeFileSync(
      path.join(root, 'content/subjects/history/subject.json'),
      JSON.stringify({
        id: 'history',
        label: 'History',
        icon: 'geography',
        l: 0.6,
        c: 0.08,
        h: 40,
      }),
    );
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = 'not-json{\n';
    writeFileSync(irPath, prior);
    expect(listOnboardingSubjects(root)[0]?.hasIr).toBe(true);

    const writeSpy = vi.spyOn(ingest, 'writeBankIrAtomic');
    const generateSpy = vi.spyOn(ingest, 'generateSubject');
    const refused = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected needs_confirm for corrupt IR');
    expect(refused.reason).toBe('needs_confirm');
    expect(refused.message).toBe('would overwrite content/subjects/history/bank.ir.json');
    expect(refused.message).not.toMatch(/--force/);
    expect(generateSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(irPath, 'utf8')).toBe(prior);

    const skipped = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      overwrite: 'skip',
    });
    expect(skipped.ok).toBe(false);
    if (skipped.ok) throw new Error('expected skipped for corrupt IR');
    expect(skipped.reason).toBe('skipped');
    expect(generateSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(irPath, 'utf8')).toBe(prior);
    writeSpy.mockRestore();
    generateSpy.mockRestore();

    const forced = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      force: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) throw new Error('expected generate over corrupt IR with force');
    expect(forced.result.wroteIr).toBe(true);
    expect(forced.result.overwrite).toBe(true);
    expect(JSON.parse(readFileSync(irPath, 'utf8')).difficulties.easy[0]?.id).toBe(
      'history-easy-1',
    );
  });

  it('writes over existing IR when confirm/force is set', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(irPath, 'utf8');

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      force: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected generate');
    expect(result.result.wroteIr).toBe(true);
    expect(result.result.overwrite).toBe(true);
    expect(result.result.irRel).toBe('content/subjects/history/bank.ir.json');
    const after = readFileSync(irPath, 'utf8');
    expect(after).not.toBe(prior);
    expect(JSON.parse(after).difficulties.easy[0]?.id).toBe('history-easy-1');
  });

  it('keeps prior IR bytes when overwrite is declined', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const ingest = await import('examify-ingest/generate');
    const root = tempRoot();
    seedSubject(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(irPath, 'utf8');
    const writeSpy = vi.spyOn(ingest, 'writeBankIrAtomic');
    const generateSpy = vi.spyOn(ingest, 'generateSubject');

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      overwrite: 'skip',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected skipped');
    expect(result.reason).toBe('skipped');
    expect(result.reason).not.toBe('invalid');
    expect(result.message).toBe('Generate skipped.');
    expect(generateSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readFileSync(irPath, 'utf8')).toBe(prior);
  });

  it('writes BankIR without force when no file exists yet', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    rmSync(irPath);

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected generate');
    expect(result.result.wroteIr).toBe(true);
    expect(result.result.overwrite).toBe(false);
    expect(existsSync(irPath)).toBe(true);
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
      force: true,
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
        force: true,
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
        force: true,
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
      force: true,
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
      force: true,
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
      force: true,
    });
    await vi.waitFor(() => {
      expect(firstInFlight).toBe(true);
    });
    const second = generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 1,
      root,
      force: true,
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
      force: true,
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
    const writeSpy = vi.spyOn(ingest, 'writeBankIrAtomic');
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
      force: true,
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
    const writeSpy = vi.spyOn(ingest, 'writeBankIrAtomic');
    vi.spyOn(ingest, 'generateSubject').mockRejectedValue(
      new ingest.GenerateAbortedError('raw abort internals'),
    );

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      force: true,
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

  it('maps a bare AbortError timeout to provider_timeout, not cancelled', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const prior = readFileSync(irPath, 'utf8');
    const writeSpy = vi.spyOn(ingest, 'writeBankIrAtomic');
    const timeout = new DOMException('The operation was aborted due to timeout', 'AbortError');
    vi.spyOn(ingest, 'generateSubject').mockRejectedValue(timeout);

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      force: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).not.toBe('cancelled');
    expect(result.reason).toBe('provider_timeout');
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
      force: true,
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
      force: true,
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

  it('re-checks existing IR at commit and maps BankIrOverwriteError without --force copy', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const { setOnboardingContentRootForTests } = await import('@/lib/onboarding');
    const root = tempRoot();
    seedSubject(root);
    setOnboardingContentRootForTests(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    rmSync(irPath);
    const sneaked = `${JSON.stringify({
      version: 1,
      subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
      difficulties: {
        easy: [
          {
            id: 'history-easy-1',
            type: 'mcq',
            q: 'Sneaked in during generate?',
            choices: ['A', 'B', 'C', 'D'],
            answer: 0,
            provenance: { pdf: 'hand-authored', locator: 'toctou' },
          },
        ],
        medium: [],
        hard: [],
      },
    })}\n`;
    const { generateSubject: actualGenerateSubject } =
      await vi.importActual<typeof ingest>('examify-ingest/generate');
    vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      const generated = await actualGenerateSubject(request);
      writeFileSync(irPath, sneaked);
      return generated;
    });

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected needs_confirm after TOCTOU');
    expect(result.reason).toBe('needs_confirm');
    expect(result.message).toBe('would overwrite content/subjects/history/bank.ir.json');
    expect(result.message).not.toMatch(/--force/);
    expect(readFileSync(irPath, 'utf8')).toBe(sneaked);
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
        force: true,
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

function seedNotesSubject(root: string, id: string) {
  mkdirSync(path.join(root, 'content/subjects', id), { recursive: true });
  mkdirSync(path.join(root, 'content/source-pdfs', id), { recursive: true });
  writeFileSync(path.join(root, 'content/source-pdfs', id, 'notes.txt'), `${id} study notes.\n`);
}

function irPathFor(root: string, id: string): string {
  return path.join(root, 'content/subjects', id, 'bank.ir.json');
}

describe('generateOnboardingSubject sample-bank ids (C09)', () => {
  it('refuses a sample subject id before any provider call unless replace-sample is on', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedNotesSubject(root, 'maths');
    const generateSpy = vi.spyOn(ingest, 'generateSubject');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const refused = await generateOnboardingSubject({
      subjectId: 'maths',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected sample_collision');
    expect(refused.reason).toBe('sample_collision');
    expect(generateSpy).not.toHaveBeenCalled();
    expect(existsSync(irPathFor(root, 'maths'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[onboarding] generate failed', {
      reason: 'sample_collision',
      subjectId: 'maths',
    });

    const allowed = await generateOnboardingSubject({
      subjectId: 'maths',
      provider: 'test',
      seed: 0,
      root,
      replaceSample: true,
    });
    expect(allowed.ok).toBe(true);
    expect(generateSpy).toHaveBeenCalledWith(expect.objectContaining({ replaceSample: true }));
    const ir = JSON.parse(readFileSync(irPathFor(root, 'maths'), 'utf8')) as {
      difficulties: { easy: { id: string }[] };
    };
    expect(ir.difficulties.easy[0]?.id).toBe('maths-easy-1');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('maps a sample-bank freeze from generate to sample_collision, not a generic failure', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(ingest, 'generateSubject').mockRejectedValue(
      new ingest.SampleIdCollisionError('history', ['maths-easy-1'], 'raw freeze text'),
    );

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      force: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected sample_collision');
    expect(result.reason).toBe('sample_collision');
  });
});

describe('generateOnboardingSubject provider failures (C10)', () => {
  const KEY = 'sk-ant-unit-never-logged';
  const MODEL_TEXT = 'I am sorry, I cannot help with that request.';

  function historyBank() {
    return {
      version: 1,
      subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
      difficulties: {
        easy: [
          {
            id: 'history-easy-1',
            type: 'mcq',
            q: 'Generated?',
            choices: ['A', 'B', 'C', 'D'],
            answer: 0,
            provenance: { pdf: 'notes.txt', locator: 'p1' },
          },
        ],
        medium: [],
        hard: [],
      },
    };
  }

  const cases: {
    name: string;
    fetch: () => Promise<Response>;
    reason: string;
    status?: number;
  }[] = [
    {
      name: '401',
      fetch: async () => new Response('{}', { status: 401 }),
      reason: 'provider_auth',
      status: 401,
    },
    {
      name: '403',
      fetch: async () => new Response('{}', { status: 403 }),
      reason: 'provider_auth',
      status: 403,
    },
    {
      name: '429',
      fetch: async () => new Response('{}', { status: 429 }),
      reason: 'provider_rate_limited',
      status: 429,
    },
    {
      name: '529 overloaded',
      fetch: async () => new Response('{}', { status: 529 }),
      reason: 'provider_unavailable',
      status: 529,
    },
    {
      name: '400 (e.g. no credit)',
      fetch: async () => new Response('{}', { status: 400 }),
      reason: 'provider_error',
      status: 400,
    },
    {
      name: 'network failure',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      reason: 'provider_unavailable',
    },
    {
      name: 'deadline',
      fetch: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      reason: 'provider_timeout',
    },
    {
      name: 'prose instead of JSON',
      fetch: async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: MODEL_TEXT }] }), {
          status: 200,
        }),
      reason: 'provider_output_invalid',
    },
    {
      name: 'JSON that is not BankIR',
      fetch: async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify({ hello: MODEL_TEXT }) }],
          }),
          { status: 200 },
        ),
      reason: 'provider_output_invalid',
    },
  ];

  for (const row of cases) {
    it(`maps ${row.name} to ${row.reason}, writes nothing, and logs the code only`, async () => {
      const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
      const root = tempRoot();
      seedNotesSubject(root, 'history');
      const previous = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = KEY;
      const fetchSpy = vi.fn(row.fetch);
      vi.stubGlobal('fetch', fetchSpy);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await generateOnboardingSubject({
          subjectId: 'history',
          provider: 'anthropic',
          seed: 0,
          root,
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected failure');
        expect(result.reason).toBe(row.reason);
        expect(existsSync(irPathFor(root, 'history'))).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('[onboarding] generate failed', {
          reason: row.reason,
          subjectId: 'history',
          ...(row.status ? { status: row.status } : {}),
        });
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).not.toContain(KEY);
        expect(logged).not.toContain(MODEL_TEXT);
        expect(logged).not.toMatch(/returned HTTP|fetch failed|not a JSON object/);
      } finally {
        vi.unstubAllGlobals();
        if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previous;
      }
    });
  }

  it('still succeeds on a usable provider answer and logs nothing', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedNotesSubject(root, 'history');
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = KEY;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(historyBank()) }] }),
            { status: 200 },
          ),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await generateOnboardingSubject({
        subjectId: 'history',
        provider: 'anthropic',
        seed: 0,
        root,
      });
      expect(result.ok).toBe(true);
      expect(existsSync(irPathFor(root, 'history'))).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('maps a PDF-only source the provider cannot read to sources_unreadable', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(ingest, 'generateSubject').mockRejectedValue(
      new ingest.UnreadableSourcesError('cannot read PDF bytes'),
    );
    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'openai',
      seed: 0,
      root,
      force: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('sources_unreadable');
  });

  it('does not log cancel, skip, or overwrite-confirm outcomes as failures', async () => {
    const { generateOnboardingSubject, requestOnboardingGenerateCancel } =
      await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const confirm = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
    expect(confirm.ok ? null : confirm.reason).toBe('needs_confirm');
    const skipped = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      overwrite: 'skip',
    });
    expect(skipped.ok ? null : skipped.reason).toBe('skipped');
    requestOnboardingGenerateCancel('cancel-token-quiet');
    const cancelled = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
      force: true,
      cancelToken: 'cancel-token-quiet',
    });
    expect(cancelled.ok ? null : cancelled.reason).toBe('cancelled');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('generate-all cancel (C11)', () => {
  it('refuses the next subject of a batch once cancel lands after an earlier commit', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject, requestOnboardingGenerateCancel } =
      await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedNotesSubject(root, 'alpha');
    seedNotesSubject(root, 'beta');
    const generateSpy = vi.spyOn(ingest, 'generateSubject');
    const token = 'batch-token-01';

    const first = await generateOnboardingSubject({
      subjectId: 'alpha',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: token,
    });
    expect(first.ok).toBe(true);
    // Nothing in flight and alpha already wrote IR: that subject is kept.
    expect(requestOnboardingGenerateCancel(token)).toBe(false);

    const second = await generateOnboardingSubject({
      subjectId: 'beta',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: token,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected cancelled');
    expect(second.reason).toBe('cancelled');
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(irPathFor(root, 'alpha'))).toBe(true);
    expect(existsSync(irPathFor(root, 'beta'))).toBe(false);
  });

  it('aborts the in-flight subject of a batch after an earlier subject committed', async () => {
    const ingest = await import('examify-ingest/generate');
    const { generateOnboardingSubject, requestOnboardingGenerateCancel } =
      await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedNotesSubject(root, 'alpha');
    seedNotesSubject(root, 'beta');
    const token = 'batch-token-02';
    const first = await generateOnboardingSubject({
      subjectId: 'alpha',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: token,
    });
    expect(first.ok).toBe(true);
    const alphaIr = readFileSync(irPathFor(root, 'alpha'), 'utf8');

    let seenSignal: AbortSignal | undefined;
    vi.spyOn(ingest, 'generateSubject').mockImplementation(
      (request) =>
        new Promise<never>((_resolve, reject) => {
          seenSignal = request.signal;
          request.signal?.addEventListener(
            'abort',
            () => reject(new ingest.GenerateAbortedError()),
            { once: true },
          );
        }),
    );
    const pending = generateOnboardingSubject({
      subjectId: 'beta',
      provider: 'test',
      seed: 0,
      root,
      cancelToken: token,
    });
    await vi.waitFor(() => expect(seenSignal).toBeInstanceOf(AbortSignal));
    expect(requestOnboardingGenerateCancel(token)).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    const second = await pending;
    expect(second.ok ? null : second.reason).toBe('cancelled');
    expect(existsSync(irPathFor(root, 'beta'))).toBe(false);
    expect(readFileSync(irPathFor(root, 'alpha'), 'utf8')).toBe(alphaIr);
  });
});

describe('onboarding generate keys', () => {
  it('reads API keys from the checkout .env (env store), never the family data folder', async () => {
    const ingest = await import('examify-ingest/generate');
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const checkout = keylessCheckout();
    writeFileSync(path.join(checkout, '.env'), 'OPENAI_API_KEY=sk-from-checkout-env\n');
    setEnvStoreRootForTests(checkout);
    const family = tempRoot();
    seedSubject(family);
    writeFileSync(path.join(family, '.env'), 'OPENAI_API_KEY=sk-from-data-folder\n');

    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const seen: (string | undefined)[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(ingest, 'generateSubject').mockImplementation(async (request) => {
      seen.push(request.env?.OPENAI_API_KEY);
      throw new ingest.ProviderFailureError('http', 'stop here', { status: 401 });
    });
    try {
      const result = await generateOnboardingSubject({
        subjectId: 'history',
        provider: 'openai',
        seed: 0,
        root: family,
        force: true,
      });
      expect(seen).toEqual(['sk-from-checkout-env']);
      expect(result.ok ? null : result.reason).toBe('provider_auth');
      expect(JSON.stringify(result)).not.toContain('sk-from');
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

/** Set process.env keys for one test (undefined deletes), restoring afterwards. */
async function withProcessEnv<T>(
  vars: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function historyBankJson(): string {
  return JSON.stringify({
    version: 1,
    subject: { id: 'history', label: 'History', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
    difficulties: {
      easy: [
        {
          id: 'history-easy-1',
          type: 'mcq',
          q: 'Generated by the CLI?',
          choices: ['Yes', 'No', 'Maybe', 'Never'],
          answer: 0,
          provenance: { pdf: 'notes.md', locator: 'p1' },
        },
      ],
      medium: [],
      hard: [],
    },
  });
}

describe('onboarding generate: Claude Code, Codex and local transports', () => {
  it('generates with Claude Code and never hands it Examify’s keys', async () => {
    const { fakeCli } = await import('../helpers/fake-agent-cli');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    const fake = fakeCli('claude', { mode: 'success', text: historyBankJson() });
    const result = await withProcessEnv(
      { EXAMIFY_CLAUDE_BIN: fake.bin, ANTHROPIC_API_KEY: 'sk-ant-must-not-leak' },
      () =>
        generateOnboardingSubject({
          subjectId: 'history',
          provider: 'claude-cli',
          seed: 0,
          root,
          force: true,
        }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.result.provider).toBe('claude-cli');
    expect(
      readFileSync(path.join(root, 'content/subjects/history/bank.ir.json'), 'utf8'),
    ).toContain('Generated by the CLI?');
    const record = fake.record();
    expect(record.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(record.env).not.toHaveProperty('AUTH_SECRET');
    expect(record.cwd).not.toBe(root);
  });

  it('says missing_cli when Claude Code is not installed, and writes nothing', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    const irPath = path.join(root, 'content/subjects/history/bank.ir.json');
    const before = readFileSync(irPath, 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await withProcessEnv(
      { EXAMIFY_CLAUDE_BIN: path.join(root, 'no-such-claude') },
      () =>
        generateOnboardingSubject({
          subjectId: 'history',
          provider: 'claude-cli',
          seed: 0,
          root,
          force: true,
        }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'missing_cli' });
    expect(readFileSync(irPath, 'utf8')).toBe(before);
    expect(warn).toHaveBeenCalledWith('[onboarding] generate failed', {
      reason: 'missing_cli',
      subjectId: 'history',
    });
  });

  it('maps a Codex that is not signed in to provider_auth', async () => {
    const { fakeCli } = await import('../helpers/fake-agent-cli');
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = fakeCli('codex', { mode: 'not-signed-in' });
    const result = await withProcessEnv({ EXAMIFY_CODEX_BIN: fake.bin }, () =>
      generateOnboardingSubject({
        subjectId: 'history',
        provider: 'codex-cli',
        seed: 0,
        root,
        force: true,
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'provider_auth' });
  });

  it('Local endpoint uses only the URL (never the command) and needs EXAMIFY_LLM_MODEL', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const marker = path.join(root, 'command-ran');
    const command = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], 'x')" ${JSON.stringify(marker)}`;
    const models: string[] = [];
    const fetchStub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      models.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: historyBankJson() } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const vars = {
        EXAMIFY_LLM_BASE_URL: 'http://127.0.0.1:9',
        EXAMIFY_INGEST_LOCAL_CMD: command,
        EXAMIFY_LLM_MODEL: undefined,
      };
      const noModel = await withProcessEnv(vars, () =>
        generateOnboardingSubject({
          subjectId: 'history',
          provider: 'local',
          localTransport: 'http',
          seed: 0,
          root,
          force: true,
        }),
      );
      expect(noModel).toMatchObject({ ok: false, reason: 'missing_local' });
      expect(fetchStub).not.toHaveBeenCalled();

      const ok = await withProcessEnv({ ...vars, EXAMIFY_LLM_MODEL: 'llama3.2-vision' }, () =>
        generateOnboardingSubject({
          subjectId: 'history',
          provider: 'local',
          localTransport: 'http',
          seed: 0,
          root,
          force: true,
        }),
      );
      expect(ok.ok).toBe(true);
      expect(models).toEqual(['llama3.2-vision']);
      expect(existsSync(marker)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Local command uses only the command (never the URL)', async () => {
    const { generateOnboardingSubject } = await import('@/lib/onboarding-generate');
    const root = tempRoot();
    seedSubject(root);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    try {
      const result = await withProcessEnv(
        {
          EXAMIFY_LLM_BASE_URL: 'http://127.0.0.1:9',
          EXAMIFY_LLM_MODEL: 'llama3.2-vision',
          EXAMIFY_INGEST_LOCAL_CMD: undefined,
        },
        () =>
          generateOnboardingSubject({
            subjectId: 'history',
            provider: 'local',
            localTransport: 'cmd',
            seed: 0,
            root,
            force: true,
          }),
      );
      expect(result).toMatchObject({ ok: false, reason: 'missing_local' });
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('onboarding AI modes: providers, transports and copy', () => {
  it('maps every mode to its provider and local transport', async () => {
    const types = await import('@/lib/onboarding-types');
    expect(types.providerForOnboardingAiMode('claude-cli')).toBe('claude-cli');
    expect(types.providerForOnboardingAiMode('codex-cli')).toBe('codex-cli');
    expect(types.localTransportForOnboardingAiMode('local-agent')).toBe('http');
    expect(types.localTransportForOnboardingAiMode('local-cli')).toBe('cmd');
    expect(types.localTransportForOnboardingAiMode('claude-cli')).toBeNull();
    for (const mode of types.ONBOARDING_AI_MODES) {
      expect(types.ONBOARDING_GENERATE_PROVIDERS).toContain(
        types.providerForOnboardingAiMode(mode),
      );
      expect(types.onboardingAiCapabilityLine(mode)).toMatch(/\.$/);
    }
  });

  it('keeps the wizard’s provider list in step with ingest', async () => {
    const types = await import('@/lib/onboarding-types');
    const ingest = await import('examify-ingest');
    expect([...types.ONBOARDING_GENERATE_PROVIDERS].sort()).toEqual(
      [...ingest.GENERATE_PROVIDERS].sort(),
    );
  });

  it('states the agent CLI deadline the provider actually uses', async () => {
    const types = await import('@/lib/onboarding-types');
    const ingest = await import('examify-ingest/generate');
    expect(types.ONBOARDING_AGENT_CLI_TIMEOUT_MINUTES * 60_000).toBe(
      ingest.CLI_PROVIDER_TIMEOUT_MS,
    );
    expect(types.onboardingModeErrorCopy('provider_timeout', 'codex-cli')).toContain(
      `${types.ONBOARDING_AGENT_CLI_TIMEOUT_MINUTES} minutes`,
    );
  });

  it('names the tool and its sign-in in CLI-mode failures; shared copy otherwise', async () => {
    const types = await import('@/lib/onboarding-types');
    expect(types.onboardingModeErrorCopy('missing_cli', 'claude-cli')).toMatch(
      /Claude Code was not found[\s\S]*EXAMIFY_CLAUDE_BIN/,
    );
    expect(types.onboardingModeErrorCopy('provider_auth', 'codex-cli')).toMatch(
      /Codex is not signed in[\s\S]*codex login/,
    );
    expect(types.onboardingModeErrorCopy('provider_auth', 'claude-cli')).not.toMatch(/API key/);
    expect(types.onboardingModeErrorCopy('missing_local', 'local-agent')).toMatch(
      /EXAMIFY_LLM_BASE_URL and EXAMIFY_LLM_MODEL/,
    );
    expect(types.onboardingModeErrorCopy('missing_local', 'local-cli')).toMatch(
      /EXAMIFY_INGEST_LOCAL_CMD/,
    );
    expect(types.onboardingModeErrorCopy('provider_auth', 'cloud')).toBeNull();
    expect(types.onboardingModeErrorCopy('provider_auth', null)).toBeNull();
    expect(types.onboardingAgentCliSetupNote('claude-cli', false)).toMatch(
      /not found on this server[\s\S]*EXAMIFY_CLAUDE_BIN/,
    );
    expect(types.onboardingAgentCliSetupNote('codex-cli', true)).toMatch(
      /installed on this server/,
    );
  });
});
