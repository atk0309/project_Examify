import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setOnboardingContentRootForTests } from '@/lib/content-root';
import { QUESTIONS, SAMPLE_SUBJECTS, SUBJECTS } from '@/lib/exam/data';
import { scoreAttempt } from '@/lib/exam/score.server';

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'examify-live-bank-'));
}

function seedRuntimeCatalog(root: string) {
  const generated = path.join(root, 'content/generated');
  mkdirSync(path.join(generated, 'questions'), { recursive: true });
  mkdirSync(path.join(generated, 'keys'), { recursive: true });
  writeFileSync(
    path.join(generated, 'subjects.json'),
    JSON.stringify([
      { id: 'runtime-only', label: 'Runtime Only', icon: 'geography', l: 0.6, c: 0.08, h: 40 },
    ]),
  );
  writeFileSync(
    path.join(generated, 'questions', 'runtime-only.json'),
    JSON.stringify({
      easy: [
        {
          id: 'runtime-only-easy-1',
          type: 'mcq',
          q: 'A runtime-only question?',
          choices: ['A', 'B', 'C', 'D'],
          answer: 99,
        },
      ],
      medium: [],
      hard: [],
    }),
  );
  writeFileSync(
    path.join(generated, 'keys', 'runtime-only.json'),
    JSON.stringify({
      'runtime-only-easy-1': {
        type: 'mcq',
        answer: 1,
        provenance: { pdf: 'secret.pdf', locator: 'do-not-leak' },
      },
    }),
  );
}

afterEach(() => {
  setOnboardingContentRootForTests(null);
});

describe('live generated bank', () => {
  it('falls back to bundled generated content when subjects.json is missing', async () => {
    const { loadLivePublicBank } = await import('@/lib/exam/live-bank.server');
    const live = loadLivePublicBank();
    expect(live.subjects.map((subject) => subject.id)).toEqual(
      SUBJECTS.map((subject) => subject.id),
    );
    expect(live.questions.biology?.easy?.map((question) => question.id)).toEqual(
      QUESTIONS.biology?.easy?.map((question) => question.id),
    );
  });

  it('prefers a disk catalog over bundled registrar imports', async () => {
    const { loadLiveAnswerKeys, loadLivePublicBank } = await import('@/lib/exam/live-bank.server');
    const root = tempRoot();
    seedRuntimeCatalog(root);
    setOnboardingContentRootForTests(root);

    const live = loadLivePublicBank(root);
    expect(live.subjects.map((subject) => subject.id)).toEqual([
      ...SAMPLE_SUBJECTS.map((subject) => subject.id),
      'runtime-only',
    ]);
    expect(live.subjects.some((subject) => subject.id === 'biology')).toBe(false);
    expect(SUBJECTS.some((subject) => subject.id === 'biology')).toBe(true);
    expect(SUBJECTS.some((subject) => subject.id === 'runtime-only')).toBe(false);
    expect(live.questions['runtime-only']?.easy?.[0]).toEqual({
      id: 'runtime-only-easy-1',
      type: 'mcq',
      q: 'A runtime-only question?',
      choices: ['A', 'B', 'C', 'D'],
    });
    expect(live.questions.biology).toBeUndefined();

    const keys = loadLiveAnswerKeys(root);
    expect(keys['runtime-only-easy-1']).toEqual({
      type: 'mcq',
      answer: 1,
      provenance: { pdf: 'secret.pdf', locator: 'do-not-leak' },
    });
    expect(keys['biology-easy-1']).toBeUndefined();
  });

  it('treats an empty disk catalog as authoritative (no bundled leftover subjects)', async () => {
    const { loadLivePublicBank } = await import('@/lib/exam/live-bank.server');
    const root = tempRoot();
    mkdirSync(path.join(root, 'content/generated'), { recursive: true });
    writeFileSync(path.join(root, 'content/generated/subjects.json'), '[]');
    setOnboardingContentRootForTests(root);

    const live = loadLivePublicBank(root);
    expect(live.subjects.map((subject) => subject.id)).toEqual(
      SAMPLE_SUBJECTS.map((subject) => subject.id),
    );
    expect(live.questions.biology).toBeUndefined();
  });

  it('scores a subject that exists only in runtime generated JSON', async () => {
    const root = tempRoot();
    seedRuntimeCatalog(root);
    setOnboardingContentRootForTests(root);

    const result = await scoreAttempt({
      subject: 'runtime-only',
      difficulty: 'easy',
      items: [{ type: 'mcq', id: 'runtime-only-easy-1', chosen: 1 }],
    });
    expect(result).toMatchObject({ ok: true, correct: 1, total: 1, scorePct: 100 });
  });
});
