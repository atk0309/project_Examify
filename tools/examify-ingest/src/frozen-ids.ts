import { SAMPLE_QUESTIONS } from '../../../src/lib/exam/data';
import { collectQuestionIds } from './ids';

/**
 * Frozen sample-bank ids. Generate, validate, and emit must use this same set
 * so collisions fail at generate instead of being pushed downstream.
 */
export function sampleBankFrozenIds(): string[] {
  return collectQuestionIds(SAMPLE_QUESTIONS);
}
