/**
 * Test-coupled sample ids (must remain in the sample bank).
 * Validate/emit freeze *every* SAMPLE_QUESTIONS id, not only this list.
 */
export const FIXTURE_IDS = [
  'maths-easy-1',
  'maths-hard-1',
  'geography-medium-1',
  'geography-medium-free-1',
  'geography-medium-free-2',
] as const;

export type FixtureId = (typeof FIXTURE_IDS)[number];

export const FIXTURE_ID_SET: ReadonlySet<string> = new Set(FIXTURE_IDS);
