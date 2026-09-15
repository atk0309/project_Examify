import type { AnswerKey, BankIR, DifficultyId, PublicQuestion, SplitIr } from './schema';
import { DIFFICULTIES } from './schema';

/** Split a BankIR document into a public subject/bank and server-only keys. */
export function splitIr(bank: BankIR): SplitIr {
  const questions: Record<DifficultyId, PublicQuestion[]> = {
    easy: [],
    medium: [],
    hard: [],
  };
  const keys: Record<string, AnswerKey> = {};

  for (const difficulty of DIFFICULTIES) {
    for (const item of bank.difficulties[difficulty]) {
      if (item.type === 'mcq') {
        questions[difficulty].push({
          id: item.id,
          type: 'mcq',
          q: item.q,
          choices: [...item.choices],
        });
        keys[item.id] = {
          type: 'mcq',
          answer: item.answer,
          provenance: { pdf: item.provenance.pdf, locator: item.provenance.locator },
        };
      } else {
        questions[difficulty].push({
          id: item.id,
          type: 'free',
          q: item.q,
        });
        keys[item.id] = {
          type: 'free',
          rubric: item.rubric,
          maxScore: item.maxScore,
          provenance: { pdf: item.provenance.pdf, locator: item.provenance.locator },
        };
      }
    }
  }

  return {
    subject: { ...bank.subject },
    questions,
    keys,
  };
}

export function publicQuestionIds(split: SplitIr): string[] {
  return DIFFICULTIES.flatMap((difficulty) => split.questions[difficulty].map((q) => q.id));
}
