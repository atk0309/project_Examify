import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setOnboardingContentRootForTests } from '@/lib/content-root';
import { SAMPLE_SUBJECTS } from '@/lib/exam/data';
import { GENERATED_KEYS } from '@/lib/exam/generated-keys.server';
import { GENERATED_QUESTIONS, GENERATED_SUBJECTS } from '@/lib/exam/generated-public';
import {
  loadLiveAnswerKeys,
  loadLivePublicBank,
  readGeneratedOverlay,
} from '@/lib/exam/live-bank.server';
import { scoreAttempt } from '@/lib/exam/score.server';

const PROVENANCE = { pdf: 'secret.pdf', locator: 'do-not-leak' };
const SAMPLE_IDS = SAMPLE_SUBJECTS.map((subject) => subject.id);
const COMMITTED_IDS = GENERATED_SUBJECTS.map((subject) => subject.id);
const COMMITTED_BIOLOGY_IDS = Object.values(GENERATED_QUESTIONS.biology ?? {}).flatMap((list) =>
  (list ?? []).map((question) => question.id),
);

type Files = { questions?: unknown; keys?: unknown };

function familyRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'examify-live-bank-'));
}

function row(id: string, label = id) {
  return { id, label, icon: 'geography', l: 0.6, c: 0.08, h: 40 };
}

function write(abs: string, value: unknown): void {
  writeFileSync(abs, typeof value === 'string' ? value : JSON.stringify(value));
}

/** Seed `<root>/content/generated` like a wizard Apply would. */
function seedFamily(root: string, catalog: unknown, files: Record<string, Files> = {}): void {
  const dir = path.join(root, 'content/generated');
  mkdirSync(path.join(dir, 'questions'), { recursive: true });
  mkdirSync(path.join(dir, 'keys'), { recursive: true });
  write(path.join(dir, 'subjects.json'), catalog);
  for (const [id, entry] of Object.entries(files)) {
    if (entry.questions !== undefined) {
      write(path.join(dir, 'questions', `${id}.json`), entry.questions);
    }
    if (entry.keys !== undefined) write(path.join(dir, 'keys', `${id}.json`), entry.keys);
  }
}

function historyFiles(): Files {
  return {
    questions: {
      easy: [
        {
          id: 'history-easy-1',
          type: 'mcq',
          q: 'A family history question?',
          choices: ['A', 'B', 'C', 'D'],
          // Stray public-file field: never reaches the public bank.
          answer: 99,
        },
      ],
      medium: [],
      hard: [],
    },
    keys: { 'history-easy-1': { type: 'mcq', answer: 1, provenance: PROVENANCE } },
  };
}

/** Family biology reusing committed `biology-easy-1` with a different answer. */
function familyBiology() {
  const committed = GENERATED_KEYS['biology-easy-1'];
  if (committed?.type !== 'mcq') throw new Error('fixture: committed biology-easy-1 is mcq');
  const answer = (committed.answer + 1) % 4;
  return {
    answer,
    files: {
      questions: {
        easy: [
          {
            id: 'biology-easy-1',
            type: 'mcq',
            q: 'Family biology?',
            choices: ['A', 'B', 'C', 'D'],
          },
        ],
        medium: [{ id: 'biology-medium-free-1', type: 'free', q: 'Explain osmosis.' }],
      },
      keys: {
        'biology-easy-1': { type: 'mcq', answer, provenance: PROVENANCE },
        'biology-medium-free-1': {
          type: 'free',
          rubric: 'Mentions water and a membrane.',
          maxScore: 2,
          provenance: PROVENANCE,
        },
      },
    } satisfies Files,
  };
}

function silenceWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  setOnboardingContentRootForTests(null);
  vi.restoreAllMocks();
});

describe('live bank: committed layer', () => {
  it('is sample + committed generated when the family folder has no catalog', () => {
    const warn = silenceWarnings();
    const root = familyRoot();
    const live = loadLivePublicBank(root);
    expect(live.subjects.map((subject) => subject.id)).toEqual([...SAMPLE_IDS, ...COMMITTED_IDS]);
    expect(live.questions.biology).toEqual(GENERATED_QUESTIONS.biology);
    expect(readGeneratedOverlay(root)).toBeNull();
    const keys = loadLiveAnswerKeys(root);
    for (const id of COMMITTED_BIOLOGY_IDS) expect(keys[id]).toEqual(GENERATED_KEYS[id]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('live bank: family layer', () => {
  it('appends a family-only subject after the committed ones', () => {
    const root = familyRoot();
    seedFamily(root, [row('history', 'History')], { history: historyFiles() });

    const live = loadLivePublicBank(root);
    expect(live.subjects.map((subject) => subject.id)).toEqual([
      ...SAMPLE_IDS,
      ...COMMITTED_IDS,
      'history',
    ]);
    expect(live.questions.biology).toEqual(GENERATED_QUESTIONS.biology);
    expect(live.questions.history?.easy?.[0]).toEqual({
      id: 'history-easy-1',
      type: 'mcq',
      q: 'A family history question?',
      choices: ['A', 'B', 'C', 'D'],
    });
    const keys = loadLiveAnswerKeys(root);
    expect(keys['history-easy-1']).toEqual({ type: 'mcq', answer: 1, provenance: PROVENANCE });
    expect(keys['biology-easy-1']).toEqual(GENERATED_KEYS['biology-easy-1']);
  });

  it('replaces a same-id committed subject entirely; the tile keeps its position', () => {
    const root = familyRoot();
    const biology = familyBiology();
    seedFamily(root, [row('history', 'History'), row('biology', 'Our Biology')], {
      history: historyFiles(),
      biology: biology.files,
    });

    const live = loadLivePublicBank(root);
    expect(live.subjects.map((subject) => subject.id)).toEqual([
      ...SAMPLE_IDS,
      'biology',
      'history',
    ]);
    expect(live.subjects.find((subject) => subject.id === 'biology')?.label).toBe('Our Biology');
    expect(live.questions.biology).toEqual({
      easy: [
        { id: 'biology-easy-1', type: 'mcq', q: 'Family biology?', choices: ['A', 'B', 'C', 'D'] },
      ],
      medium: [{ id: 'biology-medium-free-1', type: 'free', q: 'Explain osmosis.' }],
    });

    const keys = loadLiveAnswerKeys(root);
    for (const id of COMMITTED_BIOLOGY_IDS.filter((id) => id !== 'biology-easy-1')) {
      expect(keys[id], id).toBeUndefined();
    }
    expect(keys['biology-easy-1']).toEqual({
      type: 'mcq',
      answer: biology.answer,
      provenance: PROVENANCE,
    });
    expect(keys['biology-medium-free-1']?.type).toBe('free');
  });

  it('keeps sample subject metadata when a family row reuses a sample id', () => {
    const root = familyRoot();
    const sample = SAMPLE_SUBJECTS[0]!;
    seedFamily(root, [row(sample.id, 'Family label')], {
      [sample.id]: {
        questions: {
          easy: [{ id: `${sample.id}-easy-1`, type: 'mcq', q: 'REPLACED', choices: ['A', 'B'] }],
        },
        keys: { [`${sample.id}-easy-1`]: { type: 'mcq', answer: 0, provenance: PROVENANCE } },
      },
    });
    const live = loadLivePublicBank(root);
    expect(live.subjects.filter((subject) => subject.id === sample.id)).toEqual([sample]);
  });

  it('scores a family-only subject and a replaced subject with the family keys', async () => {
    const root = familyRoot();
    const biology = familyBiology();
    seedFamily(root, [row('history'), row('biology')], {
      history: historyFiles(),
      biology: biology.files,
    });
    setOnboardingContentRootForTests(root);

    expect(
      await scoreAttempt({
        subject: 'history',
        difficulty: 'easy',
        items: [{ type: 'mcq', id: 'history-easy-1', chosen: 1 }],
      }),
    ).toMatchObject({ ok: true, correct: 1, total: 1, scorePct: 100 });
    expect(
      await scoreAttempt({
        subject: 'biology',
        difficulty: 'easy',
        items: [{ type: 'mcq', id: 'biology-easy-1', chosen: biology.answer }],
      }),
    ).toMatchObject({ ok: true, correct: 1, total: 1 });
  });

  it('never puts answers, rubrics or provenance in the public bank', () => {
    const root = familyRoot();
    seedFamily(root, [row('history'), row('biology')], {
      history: historyFiles(),
      biology: familyBiology().files,
    });
    const text = JSON.stringify(loadLivePublicBank(root));
    expect(text).not.toContain('"answer"');
    expect(text).not.toContain('rubric');
    expect(text).not.toContain('provenance');
    expect(text).not.toContain('do-not-leak');
  });
});

describe('live bank: broken family content', () => {
  it('treats an unreadable catalog as no family layer, with one warning and no path', () => {
    const warn = silenceWarnings();
    for (const catalog of ['{not json', '{"id":"history"}']) {
      const root = familyRoot();
      seedFamily(root, catalog, { history: historyFiles() });
      const live = loadLivePublicBank(root);
      expect(live.subjects.map((subject) => subject.id)).toEqual([...SAMPLE_IDS, ...COMMITTED_IDS]);
      expect(loadLiveAnswerKeys(root)['history-easy-1']).toBeUndefined();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(root);
    }
    expect(warn.mock.calls).toEqual([
      ['[live-bank] family catalog unreadable'],
      ['[live-bank] family catalog unreadable'],
    ]);
  });

  it('drops an incomplete family subject and keeps the committed subject it would replace', () => {
    const warn = silenceWarnings();
    const root = familyRoot();
    const biology = familyBiology().files;
    seedFamily(root, [row('biology', 'Our Biology'), row('history')], {
      biology: { ...biology, keys: { 'biology-easy-1': biology.keys['biology-easy-1'] } },
      history: historyFiles(),
    });

    const live = loadLivePublicBank(root);
    expect(live.subjects.map((subject) => subject.id)).toEqual([
      ...SAMPLE_IDS,
      'biology',
      'history',
    ]);
    expect(live.subjects.find((subject) => subject.id === 'biology')?.label).toBe('Biology');
    expect(live.questions.biology).toEqual(GENERATED_QUESTIONS.biology);
    const keys = loadLiveAnswerKeys(root);
    expect(keys['biology-easy-1']).toEqual(GENERATED_KEYS['biology-easy-1']);
    expect(keys['biology-medium-free-1']).toBeUndefined();

    // Two loads of the same broken state: still one warning.
    expect(warn.mock.calls).toEqual([
      ['[live-bank] family subject dropped', { reason: 'keys_incomplete', subjectId: 'biology' }],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(root);
  });

  const HISTORY = historyFiles();
  const cases: {
    name: string;
    catalog: unknown[];
    files: Record<string, Files>;
    warning: object;
  }[] = [
    {
      name: 'a missing questions file',
      catalog: [row('history')],
      files: { history: { keys: HISTORY.keys } },
      warning: { reason: 'questions_unreadable', subjectId: 'history' },
    },
    {
      name: 'a questions file that is not JSON',
      catalog: [row('history')],
      files: { history: { questions: '{nope', keys: HISTORY.keys } },
      warning: { reason: 'questions_unreadable', subjectId: 'history' },
    },
    {
      name: 'a question id another subject owns',
      catalog: [row('history')],
      files: {
        history: {
          questions: { easy: [{ id: 'biology-easy-1', type: 'mcq', q: 'X?', choices: ['A'] }] },
          keys: { 'biology-easy-1': { type: 'mcq', answer: 0, provenance: PROVENANCE } },
        },
      },
      warning: { reason: 'questions_invalid', subjectId: 'history' },
    },
    {
      name: 'a malformed question',
      catalog: [row('history')],
      files: {
        history: {
          questions: { easy: [{ id: 'history-easy-1', type: 'mcq', q: 'No choices?' }] },
          keys: HISTORY.keys,
        },
      },
      warning: { reason: 'questions_invalid', subjectId: 'history' },
    },
    {
      name: 'no questions at all',
      catalog: [row('history')],
      files: { history: { questions: { easy: [], medium: [], hard: [] }, keys: {} } },
      warning: { reason: 'questions_invalid', subjectId: 'history' },
    },
    {
      name: 'a missing keys file',
      catalog: [row('history')],
      files: { history: { questions: HISTORY.questions } },
      warning: { reason: 'keys_unreadable', subjectId: 'history' },
    },
    {
      name: 'a key of the wrong type',
      catalog: [row('history')],
      files: {
        history: {
          questions: HISTORY.questions,
          keys: {
            'history-easy-1': { type: 'free', rubric: 'r', maxScore: 1, provenance: PROVENANCE },
          },
        },
      },
      warning: { reason: 'keys_incomplete', subjectId: 'history' },
    },
    {
      name: 'an MCQ answer outside the choices',
      catalog: [row('history')],
      files: {
        history: {
          questions: HISTORY.questions,
          keys: { 'history-easy-1': { type: 'mcq', answer: 4, provenance: PROVENANCE } },
        },
      },
      warning: { reason: 'keys_incomplete', subjectId: 'history' },
    },
    {
      name: 'a catalog id that is not kebab-case',
      catalog: [row('../history')],
      files: {},
      warning: { reason: 'invalid_row' },
    },
  ];

  for (const entry of cases) {
    it(`drops a family subject with ${entry.name}`, () => {
      const warn = silenceWarnings();
      const root = familyRoot();
      seedFamily(root, entry.catalog, entry.files);
      const live = loadLivePublicBank(root);
      expect(live.subjects.map((subject) => subject.id)).toEqual([...SAMPLE_IDS, ...COMMITTED_IDS]);
      expect(Object.keys(loadLiveAnswerKeys(root))).not.toContain('history-easy-1');
      expect(warn.mock.calls).toEqual([['[live-bank] family subject dropped', entry.warning]]);
    });
  }

  it('keeps the first of two catalog rows with the same id', () => {
    const warn = silenceWarnings();
    const root = familyRoot();
    seedFamily(root, [row('history', 'History'), row('history', 'Again')], {
      history: historyFiles(),
    });
    const live = loadLivePublicBank(root);
    expect(live.subjects.filter((subject) => subject.id === 'history')).toEqual([
      row('history', 'History'),
    ]);
    expect(warn.mock.calls).toEqual([
      ['[live-bank] family subject dropped', { reason: 'duplicate_id', subjectId: 'history' }],
    ]);
  });
});
