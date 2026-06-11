import { describe, expect, it } from 'vitest';
import {
  isFreePass,
  normalizeAttemptItem,
  overallAverage,
  PASS_THRESHOLD,
  scoreSequence,
  summariseAttempts,
  type AttemptRecord,
} from '@/lib/exam/attempts';
import type { AttemptItem } from '@/lib/db/schema';

describe('isFreePass', () => {
  it('passes at or above the threshold and fails below it', () => {
    expect(PASS_THRESHOLD).toBe(0.6);
    expect(isFreePass(3, 3)).toBe(true); // 1.0
    expect(isFreePass(2, 3)).toBe(true); // 0.67 >= 0.6
    expect(isFreePass(1, 3)).toBe(false); // 0.33 < 0.6
  });

  it('treats exactly the threshold as a pass and guards maxScore 0', () => {
    expect(isFreePass(3, 5)).toBe(true); // 0.6 >= 0.6 exactly
    expect(isFreePass(0, 0)).toBe(false); // no marks available → never a pass
  });
});

describe('normalizeAttemptItem', () => {
  it('narrows a free item to kind "free"', () => {
    const free: AttemptItem = {
      type: 'free',
      id: 'q1',
      q: 'Explain X',
      response: 'because',
      maxScore: 3,
      score: 2,
      status: 'graded',
      verdict: { score: 2, verdict: 'ok', gotRight: [], toReview: [], spelling: [] },
    };
    const n = normalizeAttemptItem(free);
    expect(n.kind).toBe('free');
    if (n.kind === 'free') expect(n.item.response).toBe('because');
  });

  it('treats an item with explicit mcq type as kind "mcq"', () => {
    const mcq: AttemptItem = {
      type: 'mcq',
      id: 'q2',
      q: 'Q',
      choices: ['a', 'b'],
      chosen: 0,
      answer: 1,
    };
    expect(normalizeAttemptItem(mcq).kind).toBe('mcq');
  });

  it('treats a legacy item with no type as kind "mcq"', () => {
    // Rows persisted before free-text existed carry no `type`.
    const legacy = { q: 'Q', choices: ['a', 'b'], chosen: 1, answer: 1 } as AttemptItem;
    const n = normalizeAttemptItem(legacy);
    expect(n.kind).toBe('mcq');
    if (n.kind === 'mcq') expect(n.item.answer).toBe(1);
  });
});

describe('summariseAttempts', () => {
  const base = { total: 4, correct: 2, items: [] as AttemptRecord['items'] };

  it('rolls up best / average / latest per subject, newest-first input', () => {
    const attempts: AttemptRecord[] = [
      { id: 3, subject: 'maths', difficulty: 'easy', scorePct: 50, createdAt: 300, ...base },
      { id: 2, subject: 'maths', difficulty: 'easy', scorePct: 90, createdAt: 200, ...base },
      { id: 1, subject: 'geography', difficulty: 'easy', scorePct: 70, createdAt: 100, ...base },
    ];
    const summary = summariseAttempts(attempts);
    const maths = summary.find((s) => s.subjectId === 'maths')!;
    expect(maths.attempts).toBe(2);
    expect(maths.best).toBe(90);
    expect(maths.average).toBe(70);
    expect(maths.last).toBe(50); // first row seen for maths = most recent
    const geography = summary.find((s) => s.subjectId === 'geography')!;
    expect(geography.attempts).toBe(1);
  });

  it('returns an empty array when there are no attempts', () => {
    expect(summariseAttempts([])).toEqual([]);
  });
});

describe('scoreSequence', () => {
  const base = { total: 4, correct: 2, subject: 'maths', difficulty: 'easy' as const };

  it('reverses newest-first records into a chronological (oldest-first) score list', () => {
    const attempts: AttemptRecord[] = [
      { id: 3, scorePct: 50, createdAt: 300, items: [], ...base },
      { id: 2, scorePct: 90, createdAt: 200, items: [], ...base },
      { id: 1, scorePct: 70, createdAt: 100, items: [], ...base },
    ];
    expect(scoreSequence(attempts)).toEqual([70, 90, 50]);
  });

  it('is empty for no attempts', () => {
    expect(scoreSequence([])).toEqual([]);
  });
});

describe('overallAverage', () => {
  it('rounds the mean of a score list', () => {
    expect(overallAverage([50, 90, 70])).toBe(70);
    expect(overallAverage([10, 11])).toBe(11); // 10.5 → 11
  });

  it('is 0 for an empty list', () => {
    expect(overallAverage([])).toBe(0);
  });
});
