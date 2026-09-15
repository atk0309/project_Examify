import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUESTIONS, SAMPLE_QUESTIONS, SAMPLE_SUBJECTS, SUBJECTS } from '@/lib/exam/data';
import { SAMPLE_FIXTURE_IDS } from '@/lib/exam/fixture-ids';
import { GENERATED_QUESTIONS, GENERATED_SUBJECTS } from '@/lib/exam/generated-public';
import { mergeKeys, mergeQuestions, mergeSubjects } from '@/lib/exam/merge-generated';

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
