/**
 * Sample-bank ids frozen by unit-test fixtures.
 * Keep in lockstep with `FIXTURE_IDS` in `tools/examify-ingest`.
 */
export const SAMPLE_FIXTURE_IDS = [
  'maths-easy-1',
  'maths-hard-1',
  'geography-medium-1',
  'geography-medium-free-1',
  'geography-medium-free-2',
] as const;

export const SAMPLE_FIXTURE_ID_SET: ReadonlySet<string> = new Set(SAMPLE_FIXTURE_IDS);
