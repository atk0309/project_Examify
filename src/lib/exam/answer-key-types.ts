/** Client-safe key *types* only — never import key values from this module. */
export type Provenance = { pdf: string; locator: string };

export type McqKey = { type: 'mcq'; answer: number; provenance: Provenance };
export type FreeKey = { type: 'free'; rubric: string; maxScore: number; provenance: Provenance };
export type AnswerKey = McqKey | FreeKey;
