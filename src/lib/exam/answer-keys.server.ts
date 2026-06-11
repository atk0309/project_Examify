import 'server-only';

/* ============================================================================
   EXAMIFY — SERVER-ONLY ANSWER KEYS
   ----------------------------------------------------------------------------
   The correct-choice index (mcq) and the grading rubric + maxScore (free) for
   every question, keyed by the public question `id` in `./data.ts`. This module
   imports `server-only`, so it NEVER ships to the browser — the public bank in
   `data.ts` carries no answers or rubrics (that was the I2 leak this fixes).

   Invariants (enforced by `tests/unit/answer-keys.test.ts`):
   - Exactly one key per public question id, and vice-versa (bijection).
   - The key's `type` matches the question's `type`.
   - Every McqKey.answer is an in-range integer for that question's choices.
   - Every FreeKey.maxScore > 0.
   - Every key carries a non-empty `provenance { pdf, locator }` so each item
     stays traceable to its source.

   `provenance` records where an item came from: name the source document in
   `pdf` and the page/section in `locator` when content is derived from your
   own material (see docs/content-authoring.md), or use `'hand-authored'` for
   original content — the convention this sample bank uses.
   ========================================================================== */

export type Provenance = { pdf: string; locator: string };

export type McqKey = { type: 'mcq'; answer: number; provenance: Provenance };
export type FreeKey = { type: 'free'; rubric: string; maxScore: number; provenance: Provenance };
export type AnswerKey = McqKey | FreeKey;

export const ANSWER_KEYS: Record<string, AnswerKey> = {
  // maths
  'maths-easy-1': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/easy' },
  },
  'maths-easy-2': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/easy' },
  },
  'maths-easy-3': {
    type: 'mcq',
    answer: 3,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/easy' },
  },
  'maths-easy-4': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/easy' },
  },
  'maths-easy-5': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/easy' },
  },
  'maths-easy-free-1': {
    type: 'free',
    maxScore: 3,
    rubric:
      'Award up to 3 marks. 1 mark: a valid method (e.g. 10% of 200 is 20 and 5% is 10, so add them; or multiply 200 by 0.15). 1 mark: the correct answer 30. 1 mark: the steps are explained clearly in order. Accept equivalent wording. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/easy' },
  },
  'maths-medium-1': {
    type: 'mcq',
    answer: 3,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/medium' },
  },
  'maths-medium-2': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/medium' },
  },
  'maths-medium-3': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/medium' },
  },
  'maths-medium-4': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/medium' },
  },
  'maths-medium-5': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/medium' },
  },
  'maths-medium-free-1': {
    type: 'free',
    maxScore: 2,
    rubric:
      'Award up to 2 marks. 1 mark: perimeter is the total distance around the outside (edge) of a shape. 1 mark: area is the amount of surface (space) inside a shape. Accept equivalent wording. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/medium' },
  },
  'maths-hard-1': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/hard' },
  },
  'maths-hard-2': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/hard' },
  },
  'maths-hard-3': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/hard' },
  },
  'maths-hard-4': {
    type: 'mcq',
    answer: 3,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/hard' },
  },
  'maths-hard-5': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/hard' },
  },
  'maths-hard-free-1': {
    type: 'free',
    maxScore: 3,
    rubric:
      'Award up to 3 marks. 1 mark: a valid method (e.g. count on from 09:40 — 20 minutes to 10:00, then 1 hour to 11:00, then 15 minutes to 11:15; or subtract the times). 1 mark: the correct answer 1 hour 35 minutes (95 minutes). 1 mark: clear working shown. Accept equivalent wording. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/hard' },
  },

  // computer science
  'computer-science-easy-1': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/easy' },
  },
  'computer-science-easy-2': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/easy' },
  },
  'computer-science-easy-3': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/easy' },
  },
  'computer-science-easy-4': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/easy' },
  },
  'computer-science-easy-5': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/easy' },
  },
  'computer-science-easy-free-1': {
    type: 'free',
    maxScore: 2,
    rubric:
      'Award up to 2 marks. 1 mark: an algorithm is a sequence of step-by-step instructions for solving a problem or completing a task. 1 mark: any valid everyday example (e.g. a recipe, directions to a place, a morning routine). Accept equivalent wording. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/easy' },
  },
  'computer-science-medium-1': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/medium' },
  },
  'computer-science-medium-2': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/medium' },
  },
  'computer-science-medium-3': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/medium' },
  },
  'computer-science-medium-4': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/medium' },
  },
  'computer-science-medium-5': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/medium' },
  },
  'computer-science-medium-free-1': {
    type: 'free',
    maxScore: 2,
    rubric:
      'Award up to 2 marks. 1 mark: computer hardware is built from components (switches/transistors) that have two reliable states, such as on/off or high/low voltage. 1 mark: those two states map directly onto the two binary digits 0 and 1, which makes data simple and reliable to store and process. Accept equivalent wording. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/medium' },
  },
  'computer-science-hard-1': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/hard' },
  },
  'computer-science-hard-2': {
    type: 'mcq',
    answer: 3,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/hard' },
  },
  'computer-science-hard-3': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/hard' },
  },
  'computer-science-hard-4': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/hard' },
  },
  'computer-science-hard-5': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/hard' },
  },
  'computer-science-hard-free-1': {
    type: 'free',
    maxScore: 3,
    rubric:
      'Award up to 3 marks. 1 mark: hardware is the physical parts of a computer that you can touch. 1 mark: software is the programs (instructions) that run on the hardware. 1 mark: a correct example of each (e.g. hardware: keyboard, CPU, monitor; software: a web browser, a game, an operating system). Accept equivalent wording. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · computer-science/hard' },
  },

  // geography
  'geography-easy-1': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/easy' },
  },
  'geography-easy-2': {
    type: 'mcq',
    answer: 3,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/easy' },
  },
  'geography-easy-3': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/easy' },
  },
  'geography-easy-4': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/easy' },
  },
  'geography-easy-5': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/easy' },
  },
  'geography-easy-free-1': {
    type: 'free',
    maxScore: 3,
    rubric:
      'Award up to 3 marks for naming the seven continents: Africa, Antarctica, Asia, Europe, North America, Oceania (accept Australia/Australasia), South America. 1 mark: 3–4 correct. 2 marks: 5–6 correct. 3 marks: all seven correct. Do not deduct for order. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/easy' },
  },
  'geography-medium-1': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/medium' },
  },
  'geography-medium-2': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/medium' },
  },
  'geography-medium-3': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/medium' },
  },
  'geography-medium-4': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/medium' },
  },
  'geography-medium-5': {
    type: 'mcq',
    answer: 1,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/medium' },
  },
  'geography-medium-free-1': {
    type: 'free',
    maxScore: 2,
    rubric:
      'Award up to 2 marks. 1 mark: weather is the day-to-day (short-term) condition of the atmosphere, e.g. rain, temperature, wind. 1 mark: climate is the average pattern of weather in a place measured over a long period (often around 30 years). Accept equivalent wording. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/medium' },
  },
  'geography-medium-free-2': {
    type: 'free',
    maxScore: 2,
    rubric:
      'Award up to 2 marks — 1 mark per valid reason, up to two. Valid reasons include: a supply of fresh water for drinking and farming; transport and trade routes; fertile soil on the floodplain for growing crops; food from fishing; water power for mills or industry. Accept other reasonable answers. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/medium' },
  },
  'geography-hard-1': {
    type: 'mcq',
    answer: 3,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/hard' },
  },
  'geography-hard-2': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/hard' },
  },
  'geography-hard-3': {
    type: 'mcq',
    answer: 0,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/hard' },
  },
  'geography-hard-4': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/hard' },
  },
  'geography-hard-5': {
    type: 'mcq',
    answer: 2,
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/hard' },
  },
  'geography-hard-free-1': {
    type: 'free',
    maxScore: 2,
    rubric:
      'Award up to 2 marks. 1 mark: one valid advantage (e.g. water supply, fertile soil for farming, transport/trade, recreation). 1 mark: one valid disadvantage (e.g. risk of flooding, erosion of the banks, pollution). Accept other reasonable answers. Do not penalise minor spelling slips; note them separately.',
    provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · geography/hard' },
  },
};

export function keyById(id: string): AnswerKey | undefined {
  return ANSWER_KEYS[id];
}
