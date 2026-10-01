import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_QUESTIONS } from '@/lib/exam/data';
import { SAMPLE_ANSWER_KEYS } from '@/lib/exam/answer-keys.server';
import { starterPaper, STARTER_IDS } from '@/lib/exam/starter';
import { starterAvailable } from '@/lib/exam/starter.server';
import { prepareAttempt } from '@/lib/exam/score.server';

const grading = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Starter must not call AI');
  }),
);
vi.mock('@/lib/grading', () => ({ gradeAnswers: grading }));
afterEach(() => vi.restoreAllMocks());

describe('deterministic starter fixture', () => {
  it('always uses the same five MCQs in the same order without randomness', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('No shuffle');
    });
    const first = starterPaper(SAMPLE_QUESTIONS);
    expect(first.map((question) => question.id)).toEqual(STARTER_IDS);
    expect(first.every((question) => question.type === 'mcq')).toBe(true);
    expect(starterPaper(SAMPLE_QUESTIONS)).toEqual(first);
    expect(first.every((question) => !('answer' in question) && !('rubric' in question))).toBe(
      true,
    );
  });

  it('retains fixed correct-choice indices and scores without AI tasks', () => {
    const answers = [2, 2, 3, 1, 1];
    const input = {
      subject: 'maths',
      difficulty: 'easy',
      items: STARTER_IDS.map((id, index) => ({
        type: 'mcq' as const,
        id,
        chosen: answers[index]!,
      })),
    };
    const first = prepareAttempt(input);
    expect(first).toMatchObject({ ok: true, scorePct: 100, correct: 5, gradingTasks: [] });
    expect(prepareAttempt(input)).toEqual(first);
    const wrong = { ...input, items: input.items.map((item) => ({ ...item, chosen: 0 })) };
    expect(prepareAttempt(wrong)).toMatchObject({
      ok: true,
      scorePct: 0,
      correct: 0,
      gradingTasks: [],
    });
    expect(grading).not.toHaveBeenCalled();
  });

  it('does not mislabel replaced content or answer keys as the fixed sample', () => {
    expect(starterAvailable(SAMPLE_QUESTIONS, SAMPLE_ANSWER_KEYS)).toBe(true);
    const changed = structuredClone(SAMPLE_QUESTIONS);
    changed.maths!.easy![0]!.q = 'A different question';
    expect(starterPaper(changed)).toEqual([]);
    expect(starterAvailable(changed, SAMPLE_ANSWER_KEYS)).toBe(false);
    const keys = structuredClone(SAMPLE_ANSWER_KEYS);
    const key = keys['maths-easy-1'];
    if (key?.type === 'mcq') key.answer = 0;
    expect(starterAvailable(SAMPLE_QUESTIONS, keys)).toBe(false);
  });
});
