import type { BankIrSubject } from './schema';

function importAlias(subjectId: string, suffix: 'Questions' | 'Keys'): string {
  const camel = subjectId.replace(/-([a-z0-9])/gi, (_, ch: string) => ch.toUpperCase());
  return `${camel}${suffix}`;
}

/** Rewrite `generated-public.ts` from the merged generated subject catalog. */
export function renderGeneratedPublic(subjects: readonly BankIrSubject[]): string {
  const imports = subjects
    .map((subject) => {
      const alias = importAlias(subject.id, 'Questions');
      return `import ${alias} from '../../../content/generated/questions/${subject.id}.json';`;
    })
    .join('\n');
  const entries =
    subjects.length === 0
      ? ''
      : subjects
          .map((subject) => {
            const alias = importAlias(subject.id, 'Questions');
            const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(subject.id)
              ? subject.id
              : JSON.stringify(subject.id);
            return `  ${key}: ${alias} as Partial<Record<DifficultyId, Question[]>>,`;
          })
          .join('\n');

  return `/**
 * Additive generated public bank. Written by examify-ingest emit --apply.
 * Do not import content/generated/keys/ from this module.
 */
import generatedSubjects from '../../../content/generated/subjects.json';
${imports ? `${imports}\n` : ''}import type { DifficultyId, Question, QuestionBank, Subject } from './data';

export const GENERATED_SUBJECTS: Subject[] = generatedSubjects;

export const GENERATED_QUESTIONS: QuestionBank = {
${entries}
};
`;
}

/** Rewrite `generated-keys.server.ts` from the merged generated subject catalog. */
export function renderGeneratedKeys(subjects: readonly BankIrSubject[]): string {
  const imports = subjects
    .map((subject) => {
      const alias = importAlias(subject.id, 'Keys');
      return `import ${alias} from '../../../content/generated/keys/${subject.id}.json';`;
    })
    .join('\n');
  const spreads =
    subjects.length === 0
      ? ''
      : subjects.map((subject) => `  ...${importAlias(subject.id, 'Keys')},`).join('\n');

  return `import 'server-only';

/**
 * Additive generated answer keys. Written by examify-ingest emit --apply.
 * Import only from server-only modules.
 */
${imports ? `${imports}\n` : ''}import type { AnswerKey } from './answer-key-types';

export const GENERATED_KEYS: Record<string, AnswerKey> = {
${spreads}
} as Record<string, AnswerKey>;
`;
}
