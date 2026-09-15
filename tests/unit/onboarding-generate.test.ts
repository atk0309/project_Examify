import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ONBOARDING_INGEST_CLI,
  onboardingGenerateAndEmitCli,
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
  setOnboardingContentRootForTests(null);
});

describe('onboarding generate mapping', () => {
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
});

describe('onboarding generate graph', () => {
  it('keeps generateSubject off the Phase 0 emit module', () => {
    const emit = readFileSync(path.join(process.cwd(), 'src/lib/onboarding.ts'), 'utf8');
    expect(emit).not.toMatch(/examify-ingest\/generate/);
    expect(emit).not.toMatch(/generateSubject/);
    const generate = readFileSync(
      path.join(process.cwd(), 'src/lib/onboarding-generate.ts'),
      'utf8',
    );
    expect(generate).toMatch(/from 'examify-ingest\/generate'/);
    expect(generate).toMatch(/generateSubject/);
    expect(generate).not.toMatch(/applyEmit|planEmit|applyOnboardingEmit/);
    const wizard = readFileSync(
      path.join(process.cwd(), 'src/components/exam/OnboardingWizard.tsx'),
      'utf8',
    );
    expect(wizard).not.toMatch(/examify-ingest\/generate/);
    expect(wizard).not.toMatch(/generateSubject/);
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

    const result = await generateOnboardingSubject({
      subjectId: 'history',
      provider: 'test',
      seed: 0,
      root,
    });
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
