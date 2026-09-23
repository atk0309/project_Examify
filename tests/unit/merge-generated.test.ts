import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUESTIONS, SAMPLE_QUESTIONS, SAMPLE_SUBJECTS, SUBJECTS } from '@/lib/exam/data';
import { SAMPLE_FIXTURE_IDS } from '@/lib/exam/fixture-ids';
import { GENERATED_QUESTIONS, GENERATED_SUBJECTS } from '@/lib/exam/generated-public';
import {
  GENERATED_SUBJECT_ID_RE,
  composeGeneratedKeys,
  composeGeneratedLayers,
  isSubjectQuestionId,
  mergeKeys,
  mergeQuestions,
  mergeSubjects,
  type GeneratedLayer,
} from '@/lib/exam/merge-generated';
import { SUBJECT_ID_RE } from '../../tools/examify-ingest/src/schema';

const repoRoot = path.resolve(__dirname, '../..');

describe('merge generated content', () => {
  it('adds biology without clobbering sample fixture ids', () => {
    expect(SAMPLE_SUBJECTS.map((subject) => subject.id)).toEqual([
      'maths',
      'computer-science',
      'geography',
    ]);
    expect(SUBJECTS.map((subject) => subject.id)).toEqual([
      'maths',
      'computer-science',
      'geography',
      'biology',
    ]);
    expect(QUESTIONS.biology?.easy?.map((q) => q.id)).toEqual([
      'biology-easy-1',
      'biology-easy-free-1',
    ]);
    expect(SAMPLE_QUESTIONS.maths!.easy![0]!.id).toBe('maths-easy-1');
    expect(QUESTIONS.maths!.easy![0]!.id).toBe('maths-easy-1');
    expect(QUESTIONS.maths!.easy![0]!.q).toBe(SAMPLE_QUESTIONS.maths!.easy![0]!.q);
    for (const id of SAMPLE_FIXTURE_IDS) {
      const all = Object.values(QUESTIONS).flatMap((byDiff) =>
        Object.values(byDiff).flatMap((list) => list ?? []),
      );
      expect(
        all.some((q) => q.id === id),
        `missing fixture ${id}`,
      ).toBe(true);
    }
  });

  it('registers every generated questions/*.json subject', () => {
    const files = readdirSync(path.join(repoRoot, 'content/generated/questions')).filter((name) =>
      name.endsWith('.json'),
    );
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      expect(GENERATED_QUESTIONS[id], `register ${id} in generated-public.ts`).toBeDefined();
      expect(SUBJECTS.some((subject) => subject.id === id)).toBe(true);
    }
    expect(GENERATED_SUBJECTS.map((subject) => subject.id).sort()).toEqual(
      files.map((file) => file.replace(/\.json$/, '')).sort(),
    );
  });

  it('skips a cross-bucket id collision unless replaceSample is set', () => {
    const generated = {
      biology: {
        easy: [
          {
            id: 'maths-easy-2',
            type: 'mcq' as const,
            q: 'CROSS-BUCKET',
            choices: ['A', 'B', 'C', 'D'],
          },
          {
            id: 'biology-easy-new',
            type: 'free' as const,
            q: 'New biology item',
          },
        ],
      },
    };
    const kept = mergeQuestions(SAMPLE_QUESTIONS, generated, false);
    expect(kept.maths!.easy!.some((question) => question.id === 'maths-easy-2')).toBe(true);
    expect(kept.maths!.easy![1]!.q).toBe(SAMPLE_QUESTIONS.maths!.easy![1]!.q);
    expect(kept.biology!.easy!.map((question) => question.id)).toEqual(['biology-easy-new']);

    const replaced = mergeQuestions(SAMPLE_QUESTIONS, generated, true);
    expect(replaced.maths!.easy!.some((question) => question.id === 'maths-easy-2')).toBe(false);
    expect(replaced.biology!.easy!.map((question) => question.id)).toEqual([
      'maths-easy-2',
      'biology-easy-new',
    ]);
    expect(replaced.biology!.easy![0]!.q).toBe('CROSS-BUCKET');
  });

  it('does not replace a sample-bank id unless replaceSample is set', () => {
    const generated = {
      maths: {
        easy: [
          {
            id: 'maths-easy-2',
            type: 'mcq' as const,
            q: 'REPLACED',
            choices: ['A', 'B', 'C', 'D'],
          },
        ],
      },
    };
    const kept = mergeQuestions(SAMPLE_QUESTIONS, generated, false);
    expect(kept.maths!.easy![1]!.q).toBe(SAMPLE_QUESTIONS.maths!.easy![1]!.q);
    const replaced = mergeQuestions(SAMPLE_QUESTIONS, generated, true);
    expect(replaced.maths!.easy![1]!.q).toBe('REPLACED');
  });

  it('keeps sample subject metadata when generated repeats an id', () => {
    const merged = mergeSubjects(SAMPLE_SUBJECTS, [
      { id: 'maths', label: 'Mathematics', icon: 'maths', l: 0, c: 0, h: 0 },
      { id: 'biology', label: 'Biology', icon: 'biology', l: 0.58, c: 0.09, h: 142 },
    ]);
    expect(merged[0]).toEqual(SAMPLE_SUBJECTS[0]);
    expect(merged.at(-1)?.id).toBe('biology');
  });

  it('merges keys additively and protects fixture ids', () => {
    const sample = { 'maths-easy-2': { type: 'mcq' as const, answer: 2 } };
    const generated = {
      'maths-easy-2': { type: 'mcq' as const, answer: 0 },
      'biology-easy-1': { type: 'mcq' as const, answer: 2 },
    };
    expect(mergeKeys(sample, generated, false)['maths-easy-2']!.answer).toBe(2);
    expect(mergeKeys(sample, generated, false)['biology-easy-1']!.answer).toBe(2);
    expect(mergeKeys(sample, generated, true)['maths-easy-2']!.answer).toBe(0);
  });
});

function subject(id: string, label = id) {
  return { id, label, icon: 'biology', l: 0.5, c: 0.1, h: 140 };
}

function mcq(id: string, q = id) {
  return { id, type: 'mcq' as const, q, choices: ['A', 'B'] };
}

const COMMITTED: GeneratedLayer = {
  subjects: [subject('biology', 'Biology'), subject('chemistry', 'Chemistry')],
  questions: {
    biology: { easy: [mcq('biology-easy-1', 'committed')] },
    chemistry: { easy: [mcq('chemistry-easy-1')] },
  },
};

describe('generated layers (committed + family)', () => {
  it('matches the ingest subject id rule', () => {
    for (const id of ['biology', 'a', 'x-1', 'computer-science', 'demo2']) {
      expect(GENERATED_SUBJECT_ID_RE.test(id), id).toBe(SUBJECT_ID_RE.test(id));
      expect(GENERATED_SUBJECT_ID_RE.test(id), id).toBe(true);
    }
    for (const id of ['', 'Biology', '1x', '-x', 'a_b', '../x', 'a/b', 'a b']) {
      expect(GENERATED_SUBJECT_ID_RE.test(id), id).toBe(SUBJECT_ID_RE.test(id));
      expect(GENERATED_SUBJECT_ID_RE.test(id), id).toBe(false);
    }
  });

  it.each([
    ['bio', 'bio-easy-1', true],
    ['bio', 'bio-hard-free-12', true],
    ['bio', 'bio-medium-3', true],
    ['bio', 'bio-easy-easy-1', false],
    ['bio-easy', 'bio-easy-easy-1', true],
    ['bio-easy', 'bio-easy-1', false],
    ['bio', 'biology-easy-1', false],
    ['bio', 'bio-extreme-1', false],
    ['bio', 'bio-easy-1x', false],
    ['bio', 'maths-easy-1', false],
  ])('isSubjectQuestionId(%s, %s) is %s', (subjectId, questionId, expected) => {
    expect(isSubjectQuestionId(subjectId, questionId)).toBe(expected);
  });

  it('keeps the committed layer as-is without a family layer', () => {
    const out = composeGeneratedLayers(COMMITTED, null);
    expect(out.subjects.map((row) => row.id)).toEqual(['biology', 'chemistry']);
    expect(out.questions).toEqual(COMMITTED.questions);
    expect(out.shadowed).toEqual([]);
  });

  it('appends family-only subjects after the committed ones', () => {
    const out = composeGeneratedLayers(COMMITTED, {
      subjects: [subject('history', 'History')],
      questions: { history: { easy: [mcq('history-easy-1')] } },
    });
    expect(out.subjects.map((row) => row.id)).toEqual(['biology', 'chemistry', 'history']);
    expect(out.questions.history?.easy?.[0]?.id).toBe('history-easy-1');
    expect(out.questions.biology).toEqual(COMMITTED.questions.biology);
    expect(out.shadowed).toEqual([]);
  });

  it('replaces a same-id committed subject entirely, keeping its tile position', () => {
    const out = composeGeneratedLayers(COMMITTED, {
      subjects: [subject('history'), subject('biology', 'Our Biology')],
      questions: {
        history: { easy: [mcq('history-easy-1')] },
        biology: { medium: [mcq('biology-medium-1', 'family')] },
      },
    });
    expect(out.subjects.map((row) => [row.id, row.label])).toEqual([
      ['biology', 'Our Biology'],
      ['chemistry', 'Chemistry'],
      ['history', 'history'],
    ]);
    expect(out.questions.biology).toEqual({ medium: [mcq('biology-medium-1', 'family')] });
    expect(out.shadowed).toEqual(['biology']);
  });

  it('drops every committed key of a shadowed subject, then adds the family keys', () => {
    const committedKeys = {
      'biology-easy-1': 'committed-bio',
      'biology-hard-free-9': 'orphan-bio',
      'chemistry-easy-1': 'committed-chem',
    };
    const familyKeys = { 'biology-medium-1': 'family-bio', 'history-easy-1': 'family-history' };
    expect(
      composeGeneratedKeys(committedKeys, COMMITTED.questions, familyKeys, ['biology']),
    ).toEqual({
      'chemistry-easy-1': 'committed-chem',
      'biology-medium-1': 'family-bio',
      'history-easy-1': 'family-history',
    });
    expect(composeGeneratedKeys(committedKeys, COMMITTED.questions, {}, [])).toEqual(committedKeys);
  });
});

describe('generated keys stay server-only', () => {
  it('never imports content/generated/keys from client modules', () => {
    const files = collectSrcFiles(path.join(repoRoot, 'src'));
    for (const file of files) {
      if (file.endsWith('.server.ts')) continue;
      const imports = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^\s*(import|export)\b/.test(line) && line.includes('from'));
      for (const line of imports) {
        expect(line, file).not.toMatch(/content\/generated\/keys/);
        expect(line, file).not.toMatch(/generated-keys\.server/);
      }
    }
  });

  it('never imports live-bank.server from client modules', () => {
    const files = collectSrcFiles(path.join(repoRoot, 'src'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes("'use client'")) continue;
      expect(source, file).not.toMatch(/live-bank\.server/);
      expect(source, file).not.toMatch(/content\/generated\/keys/);
      expect(source, file).not.toMatch(/generated-keys\.server/);
    }
  });
});

function collectSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSrcFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}
