/**
 * Additive generated public bank. `examify-ingest emit --apply` writes
 * `content/generated/questions/<id>.json`; register a new subject here
 * (never import `content/generated/keys/` from this module).
 */
import generatedSubjects from '../../../content/generated/subjects.json';
import biologyQuestions from '../../../content/generated/questions/biology.json';
import type { DifficultyId, Question, QuestionBank, Subject } from './data';

export const GENERATED_SUBJECTS: Subject[] = generatedSubjects;

export const GENERATED_QUESTIONS: QuestionBank = {
  biology: biologyQuestions as Partial<Record<DifficultyId, Question[]>>,
};
