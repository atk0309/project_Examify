import 'server-only';

/**
 * Additive generated answer keys. Import only from server-only modules.
 * Register each `content/generated/keys/<id>.json` here after emit --apply.
 */
import biologyKeys from '../../../content/generated/keys/biology.json';
import type { AnswerKey } from './answer-key-types';

export const GENERATED_KEYS: Record<string, AnswerKey> = biologyKeys as Record<string, AnswerKey>;
