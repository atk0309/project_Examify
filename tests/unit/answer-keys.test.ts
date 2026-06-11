import { describe, expect, it } from 'vitest';
import { QUESTIONS, type Question } from '@/lib/exam/data';
import { ANSWER_KEYS } from '@/lib/exam/answer-keys.server';

/** Every public question across all subjects + difficulties, flattened. */
function allQuestions(): Question[] {
  return Object.values(QUESTIONS).flatMap((byDiff) =>
    Object.values(byDiff).flatMap((list) => list ?? []),
  );
}

describe('public question bank (I2 leak guard)', () => {
  const questions = allQuestions();

  it('never carries an answer or rubric on a public question', () => {
    for (const q of questions) {
      expect(q, `question ${q.id} must not expose an answer key`).not.toHaveProperty('answer');
      expect(q, `question ${q.id} must not expose a rubric`).not.toHaveProperty('rubric');
    }
  });

  it('uses globally-unique ids', () => {
    const ids = questions.map((q) => q.id);
    expect(new Set(ids).size, 'duplicate question ids would collapse ANSWER_KEYS entries').toBe(
      ids.length,
    );
  });
});

describe('ANSWER_KEYS bijection + well-formedness', () => {
  const questions = allQuestions();
  const questionIds = new Set(questions.map((q) => q.id));
  const keyIds = new Set(Object.keys(ANSWER_KEYS));

  it('has exactly one key per question and vice-versa', () => {
    for (const id of questionIds) expect(keyIds.has(id), `missing key for ${id}`).toBe(true);
    for (const id of keyIds) expect(questionIds.has(id), `orphan key ${id}`).toBe(true);
    expect(keyIds.size).toBe(questionIds.size);
  });

  it('matches each key type to its question type', () => {
    for (const q of questions) {
      expect(ANSWER_KEYS[q.id]!.type, `type mismatch for ${q.id}`).toBe(q.type);
    }
  });

  it('mcq keys are in-range integers; free keys have a positive maxScore', () => {
    for (const q of questions) {
      const key = ANSWER_KEYS[q.id]!;
      if (q.type === 'mcq' && key.type === 'mcq') {
        expect(Number.isInteger(key.answer), `${q.id} answer must be an integer`).toBe(true);
        expect(key.answer).toBeGreaterThanOrEqual(0);
        expect(key.answer).toBeLessThan(q.choices.length);
      } else if (q.type === 'free' && key.type === 'free') {
        expect(key.maxScore, `${q.id} maxScore must be > 0`).toBeGreaterThan(0);
        expect(key.rubric.trim().length, `${q.id} rubric must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('carries a non-empty provenance { pdf, locator } on every key', () => {
    for (const id of keyIds) {
      const { provenance } = ANSWER_KEYS[id]!;
      expect(provenance, `${id} must record provenance`).toBeDefined();
      expect(
        provenance.pdf.trim().length,
        `${id} provenance.pdf must be non-empty`,
      ).toBeGreaterThan(0);
      expect(
        provenance.locator.trim().length,
        `${id} provenance.locator must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });
});
