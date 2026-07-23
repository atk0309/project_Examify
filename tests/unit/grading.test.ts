import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampScore, gradeFreeText } from '@/lib/grading';
import { env } from '@/lib/env';

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

describe('gradeFreeText (live API path)', () => {
  const originalKey = env.ANTHROPIC_API_KEY;
  const args = {
    question: 'What is a metaphor?',
    rubric: 'Award up to 3 marks.',
    maxScore: 3,
    studentAnswer: 'A comparison that says one thing is another.',
  };

  beforeEach(() => {
    (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = 'live-test-key';
  });

  afterEach(() => {
    (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('sends a bounded request and returns only the validated verdict', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                score: 2,
                verdict: 'A sound answer.',
                gotRight: ['Identifies a comparison'],
                toReview: [],
                spelling: [],
              }),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await gradeFreeText(args);
    expect(result).toEqual({
      status: 'graded',
      verdict: {
        score: 2,
        verdict: 'A sound answer.',
        gotRight: ['Identifies a comparison'],
        toReview: [],
        spelling: [],
      },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
  });

  it('falls back to needs_review when the request fails or the response is malformed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('timeout'));
    await expect(gradeFreeText(args)).resolves.toEqual({ status: 'needs_review' });

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'not-json' }] }), {
        status: 200,
      }),
    );
    await expect(gradeFreeText(args)).resolves.toEqual({ status: 'needs_review' });
  });
});
