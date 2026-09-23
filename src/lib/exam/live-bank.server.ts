import 'server-only';

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { SAMPLE_ANSWER_KEYS } from './answer-keys.server';
import type { AnswerKey } from './answer-key-types';
import {
  SAMPLE_QUESTIONS,
  SAMPLE_SUBJECTS,
  type DifficultyId,
  type Question,
  type QuestionBank,
  type Subject,
} from './data';
import { GENERATED_QUESTIONS, GENERATED_SUBJECTS } from './generated-public';
import { GENERATED_KEYS } from './generated-keys.server';
import {
  GENERATED_SUBJECT_ID_RE,
  composeGeneratedKeys,
  composeGeneratedLayers,
  generatedReplacesSample,
  generatedReplacesSampleIds,
  isSubjectQuestionId,
  mergeKeys,
  mergeQuestions,
  mergeSubjects,
  type GeneratedLayer,
} from './merge-generated';
import { getOnboardingContentRoot } from '@/lib/content-root';

export const GENERATED_REL = 'content/generated';

const DIFFICULTIES: DifficultyId[] = ['easy', 'medium', 'hard'];

export type LivePublicBank = {
  subjects: Subject[];
  questions: QuestionBank;
};

/** The family data folder's generated layer, keys limited to its own question ids. */
export type FamilyGeneratedLayer = GeneratedLayer & { keys: Record<string, AnswerKey> };

/** Why a family catalog row was left out. Logged as this code only (never a path). */
export type FamilySubjectDropReason =
  /** Not a subject row, or its id is not kebab-case. */
  | 'invalid_row'
  | 'duplicate_id'
  /** `questions/<id>.json` missing, unreadable or not JSON. */
  | 'questions_unreadable'
  /** A malformed question, an id the subject cannot own, a repeat, or no questions. */
  | 'questions_invalid'
  /** `keys/<id>.json` missing, unreadable or not a JSON object. */
  | 'keys_unreadable'
  /** A public question has no usable key of its own type. */
  | 'keys_incomplete';

const COMMITTED: GeneratedLayer = { subjects: GENERATED_SUBJECTS, questions: GENERATED_QUESTIONS };

type JsonRead = { ok: true; value: unknown } | { ok: false; missing: boolean };

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function readJson(abs: string): JsonRead {
  let raw: string;
  try {
    // Regular files only: a FIFO or device would block the request.
    if (!statSync(abs).isFile()) return { ok: false, missing: false };
    raw = readFileSync(abs, 'utf8');
  } catch (error) {
    return { ok: false, missing: isEnoent(error) };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, missing: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseSubject(value: unknown): Subject | null {
  if (!isRecord(value)) return null;
  const { id, label, icon, l, c, h } = value;
  if (typeof id !== 'string' || !GENERATED_SUBJECT_ID_RE.test(id)) return null;
  if (typeof label !== 'string' || !label || typeof icon !== 'string') return null;
  if (typeof l !== 'number' || typeof c !== 'number' || typeof h !== 'number') return null;
  return { id, label, icon, l, c, h };
}

function parseQuestion(value: unknown): Question | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.q !== 'string') return null;
  if (value.type === 'mcq') {
    const choices = value.choices;
    if (!Array.isArray(choices) || !choices.every((choice) => typeof choice === 'string')) {
      return null;
    }
    return { id: value.id, type: 'mcq', q: value.q, choices };
  }
  if (value.type === 'free') return { id: value.id, type: 'free', q: value.q };
  return null;
}

/** Public fields only; any malformed item, foreign id or repeat rejects the whole file. */
function parseSubjectQuestions(
  subjectId: string,
  value: unknown,
): Partial<Record<DifficultyId, Question[]>> | null {
  if (!isRecord(value)) return null;
  const out: Partial<Record<DifficultyId, Question[]>> = {};
  const seen = new Set<string>();
  for (const difficulty of DIFFICULTIES) {
    const list = value[difficulty];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return null;
    const questions: Question[] = [];
    for (const item of list) {
      const question = parseQuestion(item);
      if (!question || seen.has(question.id) || !isSubjectQuestionId(subjectId, question.id)) {
        return null;
      }
      seen.add(question.id);
      questions.push(question);
    }
    if (questions.length > 0) out[difficulty] = questions;
  }
  return seen.size > 0 ? out : null;
}

function parseAnswerKey(value: unknown): AnswerKey | null {
  if (!isRecord(value)) return null;
  const provenance = value.provenance;
  if (!isRecord(provenance)) return null;
  if (typeof provenance.pdf !== 'string' || typeof provenance.locator !== 'string') return null;
  if (!provenance.pdf || !provenance.locator) return null;
  const proven = { pdf: provenance.pdf, locator: provenance.locator };
  if (value.type === 'mcq' && typeof value.answer === 'number' && Number.isInteger(value.answer)) {
    return { type: 'mcq', answer: value.answer, provenance: proven };
  }
  if (
    value.type === 'free' &&
    typeof value.rubric === 'string' &&
    typeof value.maxScore === 'number' &&
    value.maxScore > 0
  ) {
    return { type: 'free', rubric: value.rubric, maxScore: value.maxScore, provenance: proven };
  }
  return null;
}

/** Exactly one usable key of the right type per public question, or null. */
function keysForQuestions(
  bank: Partial<Record<DifficultyId, Question[]>>,
  value: Record<string, unknown>,
): Record<string, AnswerKey> | null {
  const out: Record<string, AnswerKey> = {};
  for (const difficulty of DIFFICULTIES) {
    for (const question of bank[difficulty] ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, question.id)) return null;
      const key = parseAnswerKey(value[question.id]);
      if (!key || key.type !== question.type) return null;
      if (
        key.type === 'mcq' &&
        question.type === 'mcq' &&
        (key.answer < 0 || key.answer >= question.choices.length)
      ) {
        return null;
      }
      out[question.id] = key;
    }
  }
  return out;
}

type FamilyWarning = { reason: FamilySubjectDropReason; subjectId?: string };

/** Last warning set logged per root, so a broken catalog warns once, not on every request. */
const warnedByRoot = new Map<string, string>();

function reportFamilyProblems(
  root: string,
  catalogUnreadable: boolean,
  dropped: readonly FamilyWarning[],
): void {
  const signature = JSON.stringify([catalogUnreadable, dropped]);
  if (warnedByRoot.get(root) === signature) return;
  warnedByRoot.set(root, signature);
  if (catalogUnreadable) console.warn('[live-bank] family catalog unreadable');
  for (const warning of dropped) console.warn('[live-bank] family subject dropped', warning);
}

/**
 * Read the family generated layer (`<familyRoot>/content/generated`) at request
 * time. A missing catalog is no family layer. An unreadable or non-array
 * catalog is also no family layer, with one warning. A catalog row counts
 * only when its id is kebab-case, its questions file parses with ids it may
 * own, and every public question has a key of its type; otherwise that row is
 * dropped with one reason-coded warning (a committed subject it would have
 * replaced stays). Warnings carry a code and subject id, never a path.
 */
export function readGeneratedOverlay(
  root = getOnboardingContentRoot(),
): FamilyGeneratedLayer | null {
  const dir = path.join(root, GENERATED_REL);
  const catalog = readJson(path.join(dir, 'subjects.json'));
  if (!catalog.ok || !Array.isArray(catalog.value)) {
    const unreadable = catalog.ok || !catalog.missing;
    reportFamilyProblems(root, unreadable, []);
    return null;
  }

  const subjects: Subject[] = [];
  const questions: QuestionBank = {};
  const keys: Record<string, AnswerKey> = {};
  const dropped: FamilyWarning[] = [];
  const seen = new Set<string>();

  for (const row of catalog.value) {
    const subject = parseSubject(row);
    if (!subject) {
      dropped.push({ reason: 'invalid_row' });
      continue;
    }
    const subjectId = subject.id;
    if (seen.has(subjectId)) {
      dropped.push({ reason: 'duplicate_id', subjectId });
      continue;
    }
    seen.add(subjectId);

    const rawQuestions = readJson(path.join(dir, 'questions', `${subjectId}.json`));
    if (!rawQuestions.ok) {
      dropped.push({ reason: 'questions_unreadable', subjectId });
      continue;
    }
    const bank = parseSubjectQuestions(subjectId, rawQuestions.value);
    if (!bank) {
      dropped.push({ reason: 'questions_invalid', subjectId });
      continue;
    }
    const rawKeys = readJson(path.join(dir, 'keys', `${subjectId}.json`));
    if (!rawKeys.ok || !isRecord(rawKeys.value)) {
      dropped.push({ reason: 'keys_unreadable', subjectId });
      continue;
    }
    const subjectKeys = keysForQuestions(bank, rawKeys.value);
    if (!subjectKeys) {
      dropped.push({ reason: 'keys_incomplete', subjectId });
      continue;
    }

    subjects.push(subject);
    questions[subjectId] = bank;
    Object.assign(keys, subjectKeys);
  }

  reportFamilyProblems(root, false, dropped);
  return { subjects, questions, keys };
}

function liveLayers(root: string) {
  const family = readGeneratedOverlay(root);
  return { family, layers: composeGeneratedLayers(COMMITTED, family) };
}

/**
 * Sample + committed generated (registrars) + family generated (data folder)
 * public bank. Family subjects replace committed ones with the same id.
 */
export function loadLivePublicBank(root = getOnboardingContentRoot()): LivePublicBank {
  const { layers } = liveLayers(root);
  return {
    subjects: mergeSubjects(SAMPLE_SUBJECTS, layers.subjects),
    questions: mergeQuestions(
      SAMPLE_QUESTIONS,
      layers.questions,
      generatedReplacesSample(layers.questions, SAMPLE_QUESTIONS),
    ),
  };
}

/** Keys twin of {@link loadLivePublicBank}. Server-only; never pass this to a client component. */
export function loadLiveAnswerKeys(root = getOnboardingContentRoot()): Record<string, AnswerKey> {
  const { family, layers } = liveLayers(root);
  const generated = composeGeneratedKeys(
    GENERATED_KEYS,
    GENERATED_QUESTIONS,
    family?.keys ?? {},
    layers.shadowed,
  );
  return mergeKeys(
    SAMPLE_ANSWER_KEYS,
    generated,
    generatedReplacesSampleIds(Object.keys(generated), Object.keys(SAMPLE_ANSWER_KEYS)),
  );
}
