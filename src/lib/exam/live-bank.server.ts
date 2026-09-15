import 'server-only';

import { existsSync, readFileSync, statSync } from 'node:fs';
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
  generatedReplacesSample,
  generatedReplacesSampleIds,
  mergeKeys,
  mergeQuestions,
  mergeSubjects,
} from './merge-generated';
import { getOnboardingContentRoot } from '@/lib/content-root';

export const GENERATED_REL = 'content/generated';

const DIFFICULTIES: DifficultyId[] = ['easy', 'medium', 'hard'];

export type LivePublicBank = {
  subjects: Subject[];
  questions: QuestionBank;
};

type GeneratedOverlay = {
  subjects: Subject[];
  questions: QuestionBank;
  keys: Record<string, AnswerKey>;
};

function readJsonFile(abs: string): unknown | undefined {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    return JSON.parse(readFileSync(abs, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function isSubject(value: unknown): value is Subject {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    rec.id.length > 0 &&
    typeof rec.label === 'string' &&
    typeof rec.icon === 'string' &&
    typeof rec.l === 'number' &&
    typeof rec.c === 'number' &&
    typeof rec.h === 'number'
  );
}

function parseQuestion(value: unknown): Question | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== 'string' || typeof rec.q !== 'string') return null;
  if (rec.type === 'mcq') {
    if (!Array.isArray(rec.choices) || !rec.choices.every((choice) => typeof choice === 'string')) {
      return null;
    }
    return { id: rec.id, type: 'mcq', q: rec.q, choices: rec.choices };
  }
  if (rec.type === 'free') return { id: rec.id, type: 'free', q: rec.q };
  return null;
}

function parseQuestionBank(value: unknown): Partial<Record<DifficultyId, Question[]>> {
  if (!value || typeof value !== 'object') return {};
  const rec = value as Record<string, unknown>;
  const out: Partial<Record<DifficultyId, Question[]>> = {};
  for (const difficulty of DIFFICULTIES) {
    const list = rec[difficulty];
    if (!Array.isArray(list)) continue;
    const questions = list
      .map(parseQuestion)
      .filter((question): question is Question => question !== null);
    if (questions.length > 0) out[difficulty] = questions;
  }
  return out;
}

function parseAnswerKey(value: unknown): AnswerKey | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const provenance = rec.provenance;
  if (!provenance || typeof provenance !== 'object') return null;
  const meta = provenance as Record<string, unknown>;
  if (typeof meta.pdf !== 'string' || typeof meta.locator !== 'string') return null;
  if (!meta.pdf || !meta.locator) return null;
  const proven = { pdf: meta.pdf, locator: meta.locator };
  if (rec.type === 'mcq' && typeof rec.answer === 'number' && Number.isInteger(rec.answer)) {
    return { type: 'mcq', answer: rec.answer, provenance: proven };
  }
  if (
    rec.type === 'free' &&
    typeof rec.rubric === 'string' &&
    typeof rec.maxScore === 'number' &&
    rec.maxScore > 0
  ) {
    return { type: 'free', rubric: rec.rubric, maxScore: rec.maxScore, provenance: proven };
  }
  return null;
}

function parseKeys(value: unknown): Record<string, AnswerKey> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, AnswerKey> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = parseAnswerKey(raw);
    if (key) out[id] = key;
  }
  return out;
}

/**
 * Read `content/generated/` from disk. A present, parseable `subjects.json` is
 * authoritative for the generated overlay (including an empty catalog). Missing
 * or unreadable catalog falls back to the build-time registrar imports.
 */
export function readGeneratedOverlay(root = getOnboardingContentRoot()): GeneratedOverlay | null {
  const catalog = readJsonFile(path.join(root, GENERATED_REL, 'subjects.json'));
  if (!Array.isArray(catalog)) return null;

  const subjects: Subject[] = [];
  const questions: QuestionBank = {};
  const keys: Record<string, AnswerKey> = {};

  for (const row of catalog) {
    if (!isSubject(row)) continue;
    subjects.push({
      id: row.id,
      label: row.label,
      icon: row.icon,
      l: row.l,
      c: row.c,
      h: row.h,
    });
    const bank = parseQuestionBank(
      readJsonFile(path.join(root, GENERATED_REL, 'questions', `${row.id}.json`)),
    );
    if (Object.keys(bank).length > 0) questions[row.id] = bank;
    Object.assign(
      keys,
      parseKeys(readJsonFile(path.join(root, GENERATED_REL, 'keys', `${row.id}.json`))),
    );
  }

  return { subjects, questions, keys };
}

function overlayOrFallback(root?: string): GeneratedOverlay {
  return (
    readGeneratedOverlay(root) ?? {
      subjects: GENERATED_SUBJECTS,
      questions: GENERATED_QUESTIONS,
      keys: GENERATED_KEYS,
    }
  );
}

/** Sample + generated public bank, preferring disk over bundled registrar imports. */
export function loadLivePublicBank(root = getOnboardingContentRoot()): LivePublicBank {
  const generated = overlayOrFallback(root);
  return {
    subjects: mergeSubjects(SAMPLE_SUBJECTS, generated.subjects),
    questions: mergeQuestions(
      SAMPLE_QUESTIONS,
      generated.questions,
      generatedReplacesSample(generated.questions, SAMPLE_QUESTIONS),
    ),
  };
}

/** Sample + generated keys. Server-only; never pass this object to a client component. */
export function loadLiveAnswerKeys(root = getOnboardingContentRoot()): Record<string, AnswerKey> {
  const generated = overlayOrFallback(root);
  return mergeKeys(
    SAMPLE_ANSWER_KEYS,
    generated.keys,
    generatedReplacesSampleIds(Object.keys(generated.keys), Object.keys(SAMPLE_ANSWER_KEYS)),
  );
}
