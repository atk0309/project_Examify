import type { ZodIssue } from 'zod';
import { DIFFICULTIES, type BankIR } from './schema';
import { idPattern } from './validate';

export type OutputDiagnostic = {
  category: 'json' | 'schema' | 'semantic' | 'refusal' | 'incomplete' | 'empty';
  fields: { path: string; code: string }[];
};
const PATH_PARTS = new Set([
  'version',
  'subject',
  'id',
  'label',
  'icon',
  'l',
  'c',
  'h',
  'difficulties',
  'easy',
  'medium',
  'hard',
  'type',
  'q',
  'choices',
  'answer',
  'provenance',
  'pdf',
  'locator',
  'rubric',
  'maxScore',
  'meta',
  'promptVersion',
  'provider',
  'seed',
  'sourceHashes',
]);
const CODES = new Set([
  'invalid_type',
  'invalid_value',
  'too_small',
  'too_big',
  'invalid_format',
  'invalid_union',
  'unrecognized_keys',
  'not_multiple_of',
  'custom',
]);

/** No issue message, received value, unknown property, source name or dynamic record key escapes. */
export function schemaOutputDiagnostic(issues: readonly ZodIssue[]): OutputDiagnostic {
  const fields = issues.slice(0, 6).map((issue) => {
    if (issue.path[0] === 'meta' && issue.path[1] === 'sourceHashes' && issue.path.length > 2) {
      return { path: 'meta.sourceHashes', code: CODES.has(issue.code) ? issue.code : 'invalid' };
    }
    const safe = issue.path.every(
      (part) => typeof part === 'number' || (typeof part === 'string' && PATH_PARTS.has(part)),
    );
    return {
      path:
        safe && issue.path.length
          ? issue.path.map((part) => (typeof part === 'number' ? '[]' : part)).join('.')
          : 'root',
      code: CODES.has(issue.code) ? issue.code : 'invalid',
    };
  });
  return { category: 'schema', fields };
}

/** Fixed field names and codes only; never include the rejected question ID itself. */
export function semanticOutputDiagnostic(bank: BankIR): OutputDiagnostic {
  const fields: OutputDiagnostic['fields'] = [];
  const seen = new Set<string>();
  for (const difficulty of DIFFICULTIES) {
    for (const item of bank.difficulties[difficulty]) {
      const path = `difficulties.${difficulty}.[].id`;
      if (!idPattern(bank.subject.id, difficulty, item.type).test(item.id))
        fields.push({ path, code: 'id_pattern' });
      if (seen.has(item.id)) fields.push({ path, code: 'duplicate_id' });
      seen.add(item.id);
      if (fields.length >= 6) return { category: 'semantic', fields: fields.slice(0, 6) };
    }
  }
  return { category: 'semantic', fields };
}
