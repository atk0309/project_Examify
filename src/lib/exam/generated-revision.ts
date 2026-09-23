import { createHash } from 'node:crypto';

// Relative imports only and no `server-only`: examify-ingest (tsx) plans
// family emits with this; the live bank checks it on every read.

/**
 * Revision of one family generated subject: sha256 over the exact bytes of
 * `questions/<id>.json`, "\n", then `keys/<id>.json`. A family catalog row
 * carries it as `rev`, so a reader can tell whether the two files it read
 * belong to the same Apply.
 */
export function generatedRevision(questions: string, keys: string): string {
  return createHash('sha256').update(questions).update('\n').update(keys).digest('hex');
}
