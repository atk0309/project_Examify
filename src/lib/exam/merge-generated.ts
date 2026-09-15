import { SAMPLE_FIXTURE_ID_SET } from './fixture-ids';
import type { DifficultyId, Question, QuestionBank, Subject } from './data';

const DIFFICULTIES: DifficultyId[] = ['easy', 'medium', 'hard'];

function cloneQuestion(question: Question): Question {
  return question.type === 'mcq'
    ? { id: question.id, type: 'mcq', q: question.q, choices: [...question.choices] }
    : { id: question.id, type: 'free', q: question.q };
}

function cloneBank(bank: QuestionBank): QuestionBank {
  const out: QuestionBank = {};
  for (const [subjectId, byDiff] of Object.entries(bank)) {
    const next: Partial<Record<DifficultyId, Question[]>> = {};
    for (const difficulty of DIFFICULTIES) {
      const list = byDiff?.[difficulty];
      if (list) next[difficulty] = list.map(cloneQuestion);
    }
    out[subjectId] = next;
  }
  return out;
}

function questionIds(bank: QuestionBank): Set<string> {
  const ids = new Set<string>();
  for (const byDiff of Object.values(bank)) {
    for (const list of Object.values(byDiff ?? {})) {
      for (const question of list ?? []) ids.add(question.id);
    }
  }
  return ids;
}

/**
 * Append generated subjects that are not already in the sample list.
 * Existing sample subject metadata is never replaced.
 */
export function mergeSubjects(
  sample: readonly Subject[],
  generated: readonly Subject[],
): Subject[] {
  const seen = new Set(sample.map((subject) => subject.id));
  return [...sample, ...generated.filter((subject) => !seen.has(subject.id))];
}

/**
 * Additive merge of generated question banks onto the sample.
 * Existing sample ids are kept. Frozen fixture ids are replaced only when
 * `replaceSample` is true (the emit CLI is the gate that sets this).
 */
export function mergeQuestions(
  sample: QuestionBank,
  generated: QuestionBank,
  replaceSample = false,
): QuestionBank {
  const out = cloneBank(sample);
  for (const [subjectId, byDiff] of Object.entries(generated)) {
    if (!out[subjectId]) {
      out[subjectId] = cloneBank({ [subjectId]: byDiff })[subjectId] ?? {};
      continue;
    }
    for (const difficulty of DIFFICULTIES) {
      const incoming = byDiff?.[difficulty] ?? [];
      if (incoming.length === 0) continue;
      const existing = out[subjectId][difficulty] ? [...out[subjectId][difficulty]] : [];
      const existingIds = new Set(existing.map((question) => question.id));
      for (const question of incoming) {
        if (!existingIds.has(question.id)) {
          existing.push(cloneQuestion(question));
          existingIds.add(question.id);
          continue;
        }
        if (replaceSample && SAMPLE_FIXTURE_ID_SET.has(question.id)) {
          const index = existing.findIndex((item) => item.id === question.id);
          if (index >= 0) existing[index] = cloneQuestion(question);
        }
      }
      out[subjectId][difficulty] = existing;
    }
  }
  return out;
}

/** Same additive / fixture rules as `mergeQuestions`, for server-only keys. */
export function mergeKeys<T>(
  sample: Record<string, T>,
  generated: Record<string, T>,
  replaceSample = false,
): Record<string, T> {
  const out: Record<string, T> = { ...sample };
  for (const [id, key] of Object.entries(generated)) {
    if (id in out) {
      if (replaceSample && SAMPLE_FIXTURE_ID_SET.has(id)) out[id] = key;
      continue;
    }
    out[id] = key;
  }
  return out;
}

/** True when generated content includes a frozen fixture id (emit --replace-sample). */
export function generatedReplacesSample(generated: QuestionBank): boolean {
  return generatedReplacesSampleIds(questionIds(generated));
}

export function generatedReplacesSampleIds(ids: Iterable<string>): boolean {
  for (const id of ids) {
    if (SAMPLE_FIXTURE_ID_SET.has(id)) return true;
  }
  return false;
}
