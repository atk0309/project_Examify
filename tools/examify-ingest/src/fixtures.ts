/** Sample-bank ids frozen by unit-test fixtures. Do not collide unless --replace-sample. */
export const FIXTURE_IDS = [
  'maths-easy-1',
  'maths-hard-1',
  'geography-medium-1',
  'geography-medium-free-1',
  'geography-medium-free-2',
] as const;

export type FixtureId = (typeof FIXTURE_IDS)[number];

export const FIXTURE_ID_SET: ReadonlySet<string> = new Set(FIXTURE_IDS);
