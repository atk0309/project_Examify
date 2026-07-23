import { describe, expect, it } from 'vitest';
import { scoreAttempt } from '@/lib/exam/score.server';
import { ANSWER_KEYS } from '@/lib/exam/answer-keys.server';
import type { AttemptInput } from '@/lib/exam/attempts';
import { QUESTIONS } from '@/lib/exam/data';

/**
 * Build MCQ submit items from the maths/easy bank, choosing `correctCount`
 * right. The correct index comes from the server-only ANSWER_KEYS (the client
 * never holds it), so the test mirrors the real submit payload: `{type,id,chosen}`.
 */
function mathsEasyItems(correctCount: number): AttemptInput['items'] {
  const bank = QUESTIONS.maths!.easy!;
  let mcqIndex = 0;
  return bank.map((q) => {
    if (q.type === 'free') {
      return { type: 'free' as const, id: q.id, response: 'A complete worked explanation.' };
    }
    const answer = (ANSWER_KEYS[q.id] as { answer: number }).answer;
    const chosen = mcqIndex < correctCount ? answer : (answer + 1) % q.choices.length;
    mcqIndex += 1;
    return {
      type: 'mcq' as const,
      id: q.id,
      chosen,
    };
  });
}

describe('scoreAttempt — mcq', () => {
  it('re-derives correct + scorePct from the items (ignoring any client total)', async () => {
    const items = mathsEasyItems(3);
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.total).toBe(items.length);
    // Three MCQs + the deterministic full-score free-text stub.
    expect(res.correct).toBe(4);
    expect(res.scorePct).toBe(Math.round((4 / items.length) * 100));
    // The persisted snapshot carries the bank's question text + correct index.
    expect(res.items[0]).toMatchObject({ type: 'mcq', id: 'maths-easy-1' });
  });

  it('counts a blank (null) answer as incorrect', async () => {
    const items = mathsEasyItems(1);
    (items[0] as { chosen: number | null }).chosen = null; // was the one correct answer
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The free-text item still receives full marks from the test sentinel.
    expect(res.correct).toBe(1);
  });

  it('rejects an unknown subject', async () => {
    const res = await scoreAttempt({
      subject: 'astrology',
      difficulty: 'easy',
      items: mathsEasyItems(1),
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_subject' });
  });

  it('rejects an unknown difficulty', async () => {
    const res = await scoreAttempt({
      subject: 'maths',
      difficulty: 'impossible',
      items: mathsEasyItems(1),
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_difficulty' });
  });

  it('rejects an empty items array', async () => {
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items: [] });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });

  it('rejects a question id that is not in the bank', async () => {
    const items = mathsEasyItems(1);
    (items[0] as { id: string }).id = 'maths-easy-does-not-exist';
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });

  it('rejects an id from a different difficulty bank', async () => {
    const items = mathsEasyItems(1);
    (items[0] as { id: string }).id = 'maths-hard-1'; // exists, but not in easy
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });

  it('rejects an out-of-range chosen index', async () => {
    const items = mathsEasyItems(1);
    (items[0] as { chosen: number | null }).chosen = 99;
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });

  it('rejects more items than the bank holds', async () => {
    const items = [...mathsEasyItems(1), ...mathsEasyItems(1)];
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });

  it('rejects an incomplete paper', async () => {
    const items = mathsEasyItems(1).slice(0, -1);
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });

  it('rejects duplicate question ids', async () => {
    const items = mathsEasyItems(1);
    items[1] = { ...items[1]!, id: items[0]!.id };
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });
});

describe('scoreAttempt — free-text (test sentinel stub → full marks)', () => {
  function geographyMediumItems(): AttemptInput['items'] {
    return QUESTIONS.geography!.medium!.map((q) => {
      if (q.type === 'free') {
        return {
          type: 'free' as const,
          id: q.id,
          response:
            q.id === 'geography-medium-free-1'
              ? 'Weather is day-to-day; climate is the long-term pattern.'
              : 'Cities grew near rivers for fresh water and moving goods by boat.',
        };
      }
      return {
        type: 'mcq' as const,
        id: q.id,
        chosen: (ANSWER_KEYS[q.id] as { answer: number }).answer,
      };
    });
  }

  it('grades a free item, persists the verdict, and counts it correct', async () => {
    const res = await scoreAttempt({
      subject: 'geography',
      difficulty: 'medium',
      items: geographyMediumItems(),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.correct).toBe(QUESTIONS.geography!.medium!.length);
    expect(res.scorePct).toBe(100);
    const item = res.items.find((candidate) => candidate.id === 'geography-medium-free-1')!;
    expect(item.type).toBe('free');
    if (item.type !== 'free') return;
    expect(item.status).toBe('graded');
    expect(item.score).toBe(item.maxScore);
    expect(item.verdict).not.toBeNull();
    expect(item.response).toContain('climate');
  });

  it('scores a mixed mcq + free exam', async () => {
    const items = geographyMediumItems();
    const res = await scoreAttempt({
      subject: 'geography',
      difficulty: 'medium',
      items,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.total).toBe(items.length);
    expect(res.correct).toBe(items.length);
  });

  it('rejects a blank free-text response', async () => {
    const items = geographyMediumItems();
    const index = items.findIndex((item) => item.id === 'geography-medium-free-1');
    items[index] = { type: 'free', id: 'geography-medium-free-1', response: '   ' };
    const res = await scoreAttempt({
      subject: 'geography',
      difficulty: 'medium',
      items,
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });

  it('rejects an mcq payload pointed at a free question (type mismatch)', async () => {
    const items = geographyMediumItems();
    const index = items.findIndex((item) => item.id === 'geography-medium-free-1');
    items[index] = { type: 'mcq', id: 'geography-medium-free-1', chosen: 0 };
    const res = await scoreAttempt({
      subject: 'geography',
      difficulty: 'medium',
      items,
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });
});
