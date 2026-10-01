import 'server-only';
import { SAMPLE_ANSWER_KEYS } from './answer-keys.server';
import type { AnswerKey } from './answer-key-types';
import type { QuestionBank } from './data';
import { STARTER_IDS, starterPaper } from './starter';

/** Hide the fixture entry if a deliberately replaced bank changed its public data OR keys. */
export function starterAvailable(bank: QuestionBank, keys: Record<string, AnswerKey>): boolean {
  return (
    starterPaper(bank).length === STARTER_IDS.length &&
    STARTER_IDS.every((id) => {
      const expected = SAMPLE_ANSWER_KEYS[id];
      const actual = keys[id];
      return (
        expected?.type === 'mcq' && actual?.type === 'mcq' && expected.answer === actual.answer
      );
    })
  );
}
