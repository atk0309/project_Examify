import { SAMPLE_QUESTIONS, type McqQuestion, type QuestionBank } from './data';

/** Versioned, fixed public starter fixture. No answers or provider configuration here. */
export const STARTER_IDS = [
  'maths-easy-1',
  'maths-easy-2',
  'maths-easy-3',
  'maths-easy-4',
  'maths-easy-5',
] as const;

export function starterPaper(bank: QuestionBank): McqQuestion[] {
  const live = bank.maths?.easy ?? [];
  const original = SAMPLE_QUESTIONS.maths?.easy ?? [];
  const result: McqQuestion[] = [];
  for (const id of STARTER_IDS) {
    const question = live.find((item) => item.id === id);
    const fixture = original.find((item) => item.id === id);
    if (
      !question ||
      question.type !== 'mcq' ||
      !fixture ||
      fixture.type !== 'mcq' ||
      question.q !== fixture.q ||
      JSON.stringify(question.choices) !== JSON.stringify(fixture.choices)
    )
      return [];
    result.push({ ...question, choices: [...question.choices] });
  }
  return result;
}
