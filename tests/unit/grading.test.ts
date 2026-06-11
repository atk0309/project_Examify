import { describe, expect, it } from 'vitest';
import { clampScore, gradeFreeText } from '@/lib/grading';

describe('clampScore', () => {
  it('rounds and clamps into [0, max]', () => {
    expect(clampScore(2.4, 3)).toBe(2);
    expect(clampScore(2.6, 3)).toBe(3);
    expect(clampScore(-5, 3)).toBe(0);
    expect(clampScore(99, 3)).toBe(3);
  });

  it('treats a non-finite score as 0', () => {
    expect(clampScore(NaN, 3)).toBe(0);
    expect(clampScore(Infinity, 3)).toBe(0);
  });
});

describe('gradeFreeText (test sentinel)', () => {
  it('returns a full-score graded verdict with no network', async () => {
    const res = await gradeFreeText({
      question: 'What is a metaphor?',
      rubric: 'Award up to 3 marks…',
      maxScore: 3,
      studentAnswer: 'A comparison that says one thing is another.',
    });
    expect(res.status).toBe('graded');
    if (res.status !== 'graded') return;
    expect(res.verdict.score).toBe(3);
    expect(typeof res.verdict.verdict).toBe('string');
    expect(Array.isArray(res.verdict.gotRight)).toBe(true);
    expect(Array.isArray(res.verdict.toReview)).toBe(true);
    expect(Array.isArray(res.verdict.spelling)).toBe(true);
  });
});
