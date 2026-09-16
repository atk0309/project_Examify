import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scoreAttempt } from '@/lib/exam/score.server';
import { ANSWER_KEYS } from '@/lib/exam/answer-keys.server';
import type { AttemptInput } from '@/lib/exam/attempts';
import { QUESTIONS } from '@/lib/exam/data';
import { env } from '@/lib/env';

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

describe('scoreAttempt — wizard write, no restart', () => {
  const stubVerdict = 'Looks good.';
  const liveVerdict = 'Live path, not stub.';

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

  afterEach(async () => {
    const { setEnvStoreRootForTests } = await import('@/lib/env-store');
    setEnvStoreRootForTests(null);
    vi.restoreAllMocks();
  });

  it('boot ANTHROPIC_API_KEY=test then wizard set is not the stub path; clear fails closed', async () => {
    expect(env.ANTHROPIC_API_KEY).toBe('test');
    const {
      setEnvStoreRootForTests,
      setEnvStoreSecret,
      clearEnvStoreSecret,
      envStoreSecretConfigured,
    } = await import('@/lib/env-store');
    const root = mkdtempSync(path.join(tmpdir(), 'examify-score-live-'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'project-examify' }));
    setEnvStoreRootForTests(root);
    const secret = 'sk-anth-score-boot-set-never-echo';
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    const okBody = JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            score: 1,
            verdict: liveVerdict,
            gotRight: [],
            toReview: [],
            spelling: [],
          }),
        },
      ],
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(okBody, { status: 200 }));
    try {
      const items = geographyMediumItems();
      const stubbed = await scoreAttempt({
        subject: 'geography',
        difficulty: 'medium',
        items,
      });
      expect(stubbed.ok).toBe(true);
      if (!stubbed.ok) return;
      const stubItem = stubbed.items.find(
        (candidate) => candidate.id === 'geography-medium-free-1',
      );
      expect(stubItem).toMatchObject({
        type: 'free',
        status: 'graded',
        verdict: { verdict: stubVerdict },
      });
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(setEnvStoreSecret('ANTHROPIC_API_KEY', secret, root)).toEqual({ ok: true });
      expect(env.ANTHROPIC_API_KEY).toBe('test');
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(true);

      const written = await scoreAttempt({
        subject: 'geography',
        difficulty: 'medium',
        items,
      });
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      const liveItem = written.items.find(
        (candidate) => candidate.id === 'geography-medium-free-1',
      );
      expect(liveItem).toMatchObject({
        type: 'free',
        status: 'graded',
        score: 1,
        verdict: { verdict: liveVerdict },
      });
      expect(liveItem && liveItem.type === 'free' && liveItem.verdict?.verdict).not.toBe(
        stubVerdict,
      );
      expect(fetchSpy).toHaveBeenCalled();
      expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
        'x-api-key': secret,
      });
      const fetchCountAfterSet = fetchSpy.mock.calls.length;

      expect(clearEnvStoreSecret('ANTHROPIC_API_KEY', root)).toEqual({ ok: true });
      expect(env.ANTHROPIC_API_KEY).toBe('test');
      expect(envStoreSecretConfigured('ANTHROPIC_API_KEY')).toBe(false);
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

      const cleared = await scoreAttempt({
        subject: 'geography',
        difficulty: 'medium',
        items,
      });
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) return;
      const clearedItem = cleared.items.find(
        (candidate) => candidate.id === 'geography-medium-free-1',
      );
      expect(clearedItem).toMatchObject({
        type: 'free',
        status: 'needs_review',
        score: null,
        verdict: null,
      });
      expect(clearedItem).not.toMatchObject({
        status: 'graded',
        verdict: { verdict: stubVerdict },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(fetchCountAfterSet);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
