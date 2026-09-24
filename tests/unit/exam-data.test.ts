import { describe, expect, it } from 'vitest';
import {
  accentCSS,
  buildExam,
  countQuestions,
  difficultiesWithQuestions,
  EXAM_CONFIG,
  examPool,
  QUESTIONS,
  type Question,
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

  it('lists only difficulties that have questions', () => {
    const custom = {
      demo: {
        easy: [{ id: 'demo-easy-1', type: 'free' as const, q: 'Runtime?' }],
        medium: [],
      },
    };
    expect(difficultiesWithQuestions('demo', custom)).toEqual(['easy']);
    expect(difficultiesWithQuestions('nope', custom)).toEqual([]);
  });

  it('uses an injected question bank when provided', () => {
    const custom = {
      demo: {
        easy: [{ id: 'demo-easy-1', type: 'free' as const, q: 'Runtime?' }],
      },
    };
    expect(countQuestions('demo', custom)).toBe(1);
    expect(countQuestions('maths', custom)).toBe(0);
    expect(resolveExamPaper('demo', 'easy', ['demo-easy-1'], custom)?.[0]?.id).toBe('demo-easy-1');
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

  it('leaves written questions out when told nothing can mark them', () => {
    const bank = QUESTIONS.maths!.easy!;
    expect(bank.some((q) => q.type === 'free')).toBe(true);
    const exam = buildExam('maths', 'easy', QUESTIONS, { written: false });
    expect(exam.length).toBe(bank.filter((q) => q.type === 'mcq').length);
    expect(exam.every((q) => q.type === 'mcq')).toBe(true);
    // The default keeps them.
    expect(buildExam('maths', 'easy', QUESTIONS, {}).length).toBe(bank.length);
  });

  it('keeps written questions for a bank that has nothing else', () => {
    const custom = { essay: { easy: [free('e1'), free('e2')] } };
    expect(
      buildExam('essay', 'easy', custom, { written: false })
        .map((q) => q.id)
        .sort(),
    ).toEqual(['e1', 'e2']);
  });
});

const mcq = (id: string): Question => ({ id, type: 'mcq', q: id, choices: ['a', 'b'] });
function free(id: string): Question {
  return { id, type: 'free', q: id };
}

describe('examPool', () => {
  const mixed = [mcq('m1'), free('f1'), mcq('m2')];

  it('keeps every question when written answers get marked', () => {
    expect(examPool(mixed, true)).toBe(mixed);
  });

  it('keeps only multiple choice otherwise, unless that leaves nothing', () => {
    expect(examPool(mixed, false).map((q) => q.id)).toEqual(['m1', 'm2']);
    const written = [free('f1'), free('f2')];
    expect(examPool(written, false)).toBe(written);
    expect(examPool([], false)).toEqual([]);
  });
});

describe('resolveExamPaper', () => {
  const bank = QUESTIONS.maths!.easy!;
  const ids = bank.map((q) => q.id);

  it('resolves one complete, ordered paper from the selected bank', () => {
    const ordered = ids.slice().reverse();
    expect(resolveExamPaper('maths', 'easy', ordered)?.map((q) => q.id)).toEqual(ordered);
  });

  it('accepts the paper without written questions, whatever marks answers now', () => {
    const choiceOnly = bank.filter((q) => q.type === 'mcq').map((q) => q.id);
    expect(choiceOnly.length).toBeLessThan(ids.length);
    expect(resolveExamPaper('maths', 'easy', choiceOnly)?.map((q) => q.id)).toEqual(choiceOnly);
  });

  it('refuses a short paper that keeps a written question in place of a choice', () => {
    const choiceOnly = bank.filter((q) => q.type === 'mcq').map((q) => q.id);
    const written = bank.find((q) => q.type === 'free')!.id;
    expect(resolveExamPaper('maths', 'easy', [...choiceOnly.slice(0, -1), written])).toBeNull();
  });

  it('caps both papers at EXAM_CONFIG.length', () => {
    const many = Array.from({ length: EXAM_CONFIG.length + 5 }, (_, i) => mcq(`m${i}`));
    const custom = { big: { easy: [...many, free('f1'), free('f2')] } };
    const firstChoices = many.slice(0, EXAM_CONFIG.length).map((q) => q.id);
    expect(resolveExamPaper('big', 'easy', firstChoices, custom)).not.toBeNull();
    // A full-length paper may carry a written question too.
    const withWritten = [...firstChoices.slice(0, -1), 'f1'];
    expect(resolveExamPaper('big', 'easy', withWritten, custom)).not.toBeNull();
    expect(resolveExamPaper('big', 'easy', firstChoices.slice(0, -1), custom)).toBeNull();
  });

  it('rejects incomplete, duplicate, unknown, and cross-difficulty papers', () => {
    // Short by a multiple-choice question: neither the full paper nor one without written questions.
    const firstChoice = bank.find((q) => q.type === 'mcq')!.id;
    expect(
      resolveExamPaper(
        'maths',
        'easy',
        ids.filter((id) => id !== firstChoice),
      ),
    ).toBeNull();
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
