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
  const bank = QUESTIONS.maths!.easy!.filter((q) => q.type === 'mcq');
  return bank.map((q, idx) => {
    const answer = (ANSWER_KEYS[q.id] as { answer: number }).answer;
    const len = q.type === 'mcq' ? q.choices.length : 0;
    return {
      type: 'mcq' as const,
      id: q.id,
      chosen: idx < correctCount ? answer : (answer + 1) % len,
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
    expect(res.correct).toBe(3);
    expect(res.scorePct).toBe(Math.round((3 / items.length) * 100));
    // The persisted snapshot carries the bank's question text + correct index.
    expect(res.items[0]).toMatchObject({ type: 'mcq', id: 'maths-easy-1' });
  });

  it('counts a blank (null) answer as incorrect', async () => {
    const items = mathsEasyItems(1);
    (items[0] as { chosen: number | null }).chosen = null; // was the one correct answer
    const res = await scoreAttempt({ subject: 'maths', difficulty: 'easy', items });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.correct).toBe(0);
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
});

describe('scoreAttempt — free-text (test sentinel stub → full marks)', () => {
  it('grades a free item, persists the verdict, and counts it correct', async () => {
    const res = await scoreAttempt({
      subject: 'geography',
      difficulty: 'medium',
      items: [
        {
          type: 'free',
          id: 'geography-medium-free-1',
          response: 'Weather is the day-to-day conditions; climate is the long-term pattern.',
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.correct).toBe(1);
    expect(res.scorePct).toBe(100);
    const item = res.items[0]!;
    expect(item.type).toBe('free');
    if (item.type !== 'free') return;
    expect(item.status).toBe('graded');
    expect(item.score).toBe(item.maxScore);
    expect(item.verdict).not.toBeNull();
    expect(item.response).toContain('climate');
  });

  it('scores a mixed mcq + free exam', async () => {
    const mcqAnswer = (ANSWER_KEYS['geography-medium-1'] as { answer: number }).answer;
    const res = await scoreAttempt({
      subject: 'geography',
      difficulty: 'medium',
      items: [
        { type: 'mcq', id: 'geography-medium-1', chosen: mcqAnswer },
        {
          type: 'free',
          id: 'geography-medium-free-2',
          response: 'Cities grew near rivers for fresh water and for moving goods by boat.',
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.total).toBe(2);
    expect(res.correct).toBe(2);
  });

  it('rejects a blank free-text response', async () => {
    const res = await scoreAttempt({
      subject: 'geography',
      difficulty: 'medium',
      items: [{ type: 'free', id: 'geography-medium-free-1', response: '   ' }],
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });

  it('rejects an mcq payload pointed at a free question (type mismatch)', async () => {
    const res = await scoreAttempt({
      subject: 'geography',
      difficulty: 'medium',
      items: [{ type: 'mcq', id: 'geography-medium-free-1', chosen: 0 }],
    });
    expect(res).toEqual({ ok: false, reason: 'invalid_items' });
  });
});
