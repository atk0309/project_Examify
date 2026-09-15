import 'server-only';

/**
 * Additive generated answer keys. Written by examify-ingest emit --apply.
 * Import only from server-only modules.
 */
import biologyKeys from '../../../content/generated/keys/biology.json';
import type { AnswerKey } from './answer-key-types';

export const GENERATED_KEYS: Record<string, AnswerKey> = {
  ...biologyKeys,
} as Record<string, AnswerKey>;
