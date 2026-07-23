import { describe, expect, it } from 'vitest';
import {
  accentCSS,
  buildExam,
  countQuestions,
  EXAM_CONFIG,
  QUESTIONS,
  resolveExamPaper,
  SUBJECTS,
  shuffle,
} from '@/lib/exam/data';

describe('countQuestions', () => {
  it('sums every difficulty bank for a subject', () => {
    const bank = QUESTIONS.maths!;
    const expected =
      (bank.easy?.length ?? 0) + (bank.medium?.length ?? 0) + (bank.hard?.length ?? 0);
    expect(countQuestions('maths')).toBe(expected);
  });

  it('returns 0 for an unknown subject', () => {
    expect(countQuestions('nope')).toBe(0);
  });
});

describe('buildExam', () => {
  it('caps at the smaller of EXAM_CONFIG.length and the bank size', () => {
    const bankSize = QUESTIONS.maths!.easy!.length;
    const exam = buildExam('maths', 'easy');
    expect(exam.length).toBe(Math.min(EXAM_CONFIG.length, bankSize));
  });

  it('only returns questions drawn from the requested bank', () => {
    const bank = QUESTIONS.maths!.medium!;
    const exam = buildExam('maths', 'medium');
    for (const q of exam) expect(bank).toContain(q);
  });

  it('returns an empty list for an unknown subject', () => {
    expect(buildExam('nope', 'easy')).toEqual([]);
  });
});

describe('resolveExamPaper', () => {
  const bank = QUESTIONS.maths!.easy!;
  const ids = bank.map((q) => q.id);

  it('resolves one complete, ordered paper from the selected bank', () => {
    const ordered = ids.slice().reverse();
    expect(resolveExamPaper('maths', 'easy', ordered)?.map((q) => q.id)).toEqual(ordered);
  });

  it('rejects incomplete, duplicate, unknown, and cross-difficulty papers', () => {
    expect(resolveExamPaper('maths', 'easy', ids.slice(0, -1))).toBeNull();
    expect(resolveExamPaper('maths', 'easy', [...ids.slice(0, -1), ids[0]!])).toBeNull();
    expect(resolveExamPaper('maths', 'easy', [...ids.slice(0, -1), 'missing'])).toBeNull();
    expect(
      resolveExamPaper('maths', 'easy', [...ids.slice(0, -1), QUESTIONS.maths!.hard![0]!.id]),
    ).toBeNull();
  });
});

describe('shuffle', () => {
  it('keeps the same multiset of elements', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffle(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual([...input].sort());
  });
});

describe('accentCSS', () => {
  it('produces the four scoped accent custom properties as OKLCH', () => {
    const subject = SUBJECTS[0]!;
    const css = accentCSS(subject, 1) as Record<string, string>;
    expect(Object.keys(css).sort()).toEqual(
      ['--accent', '--accent-ink', '--accent-soft', '--accent-tint'].sort(),
    );
    expect(css['--accent']).toContain('oklch(');
  });

  it('scales chroma by the saturation multiplier', () => {
    const subject = SUBJECTS[0]!;
    const muted = accentCSS(subject, 0.62) as Record<string, string>;
    const vivid = accentCSS(subject, 1.6) as Record<string, string>;
    expect(muted['--accent']).not.toEqual(vivid['--accent']);
  });
});
