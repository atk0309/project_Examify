import type { DifficultyId, Question, QuestionBank, Subject } from './data';

const DIFFICULTIES: DifficultyId[] = ['easy', 'medium', 'hard'];

type QuestionBucket = { subjectId: string; difficulty: DifficultyId };

function indexQuestionIds(bank: QuestionBank): Map<string, QuestionBucket> {
  const index = new Map<string, QuestionBucket>();
  for (const [subjectId, byDiff] of Object.entries(bank)) {
    for (const difficulty of DIFFICULTIES) {
      for (const question of byDiff?.[difficulty] ?? []) {
        index.set(question.id, { subjectId, difficulty });
      }
    }
  }
  return index;
}

function removeQuestion(
  bank: QuestionBank,
  subjectId: string,
  difficulty: DifficultyId,
  id: string,
): void {
  const bucket = bank[subjectId];
  const list = bucket?.[difficulty];
  if (!bucket || !list) return;
  bucket[difficulty] = list.filter((question) => question.id !== id);
}

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
 * Question ids are unique across the whole bank. Existing sample ids are kept
 * unless `replaceSample` is true (the emit CLI is the gate that sets this);
 * a cross-bucket collision is skipped, or moved when replacement is allowed.
 */
export function mergeQuestions(
  sample: QuestionBank,
  generated: QuestionBank,
  replaceSample = false,
): QuestionBank {
  const out = cloneBank(sample);
  const index = indexQuestionIds(out);

  for (const [subjectId, byDiff] of Object.entries(generated)) {
    const incomingItems: { difficulty: DifficultyId; question: Question }[] = [];
    for (const difficulty of DIFFICULTIES) {
      for (const question of byDiff?.[difficulty] ?? []) {
        incomingItems.push({ difficulty, question });
      }
    }

    const hasCollision = incomingItems.some((item) => index.has(item.question.id));
    if (!out[subjectId] && !hasCollision) {
      out[subjectId] = cloneBank({ [subjectId]: byDiff })[subjectId] ?? {};
      for (const { difficulty, question } of incomingItems) {
        index.set(question.id, { subjectId, difficulty });
      }
      continue;
    }

    if (!out[subjectId]) out[subjectId] = {};

    for (const { difficulty, question } of incomingItems) {
      const existing = index.get(question.id);
      if (existing) {
        if (!replaceSample) continue;
        const sameBucket = existing.subjectId === subjectId && existing.difficulty === difficulty;
        if (sameBucket) {
          const list = out[subjectId][difficulty] ? [...out[subjectId][difficulty]] : [];
          const pos = list.findIndex((item) => item.id === question.id);
          if (pos >= 0) {
            list[pos] = cloneQuestion(question);
            out[subjectId][difficulty] = list;
            continue;
          }
        } else {
          removeQuestion(out, existing.subjectId, existing.difficulty, question.id);
        }
      }
      const list = out[subjectId][difficulty] ? [...out[subjectId][difficulty]] : [];
      list.push(cloneQuestion(question));
      out[subjectId][difficulty] = list;
      index.set(question.id, { subjectId, difficulty });
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
      if (replaceSample) out[id] = key;
      continue;
    }
    out[id] = key;
  }
  return out;
}

/** True when generated content collides with any sample-bank id. */
export function generatedReplacesSample(generated: QuestionBank, sample: QuestionBank): boolean {
  return generatedReplacesSampleIds(questionIds(generated), questionIds(sample));
}

export function generatedReplacesSampleIds(
  ids: Iterable<string>,
  sampleIds: Iterable<string>,
): boolean {
  const frozen = sampleIds instanceof Set ? sampleIds : new Set(sampleIds);
  for (const id of ids) {
    if (frozen.has(id)) return true;
  }
  return false;
}

/** Kebab-case subject id — the same rule as examify-ingest `SUBJECT_ID_RE`. */
export const GENERATED_SUBJECT_ID_RE = /^[a-z][a-z0-9-]*$/;

const OWNED_QUESTION_SUFFIX_RE = /^(?:easy|medium|hard)-(?:free-)?\d+$/;

/**
 * A question id that generated subject `subjectId` may own
 * (`<id>-<difficulty>-N` / `<id>-<difficulty>-free-N`, as validate enforces).
 * Unambiguous across subjects, so two generated subjects never share an id.
 */
export function isSubjectQuestionId(subjectId: string, questionId: string): boolean {
  const prefix = `${subjectId}-`;
  return (
    questionId.startsWith(prefix) && OWNED_QUESTION_SUFFIX_RE.test(questionId.slice(prefix.length))
  );
}

/** One generated layer's public half (committed registrars, or the family data folder). */
export type GeneratedLayer = { subjects: Subject[]; questions: QuestionBank };

/**
 * Committed generated content (build-time registrars) under the family's
 * generated content (data folder, request time). A family subject with a
 * committed subject's id replaces it entirely — its tile keeps the committed
 * position, its questions replace the committed ones — so an upgrade that
 * ships a same-id subject never changes what the family sees. Family-only
 * subjects append. `shadowed` lists the replaced committed ids.
 */
export function composeGeneratedLayers(
  committed: GeneratedLayer,
  family: GeneratedLayer | null,
): GeneratedLayer & { shadowed: string[] } {
  if (!family) {
    return {
      subjects: [...committed.subjects],
      questions: { ...committed.questions },
      shadowed: [],
    };
  }
  const familyById = new Map(family.subjects.map((subject) => [subject.id, subject]));
  const committedIds = new Set([
    ...committed.subjects.map((subject) => subject.id),
    ...Object.keys(committed.questions),
  ]);
  const subjects = [
    ...committed.subjects.map((subject) => familyById.get(subject.id) ?? subject),
    ...family.subjects.filter((subject) => !committedIds.has(subject.id)),
  ];
  const questions: QuestionBank = {};
  for (const [subjectId, bank] of Object.entries(committed.questions)) {
    if (!familyById.has(subjectId)) questions[subjectId] = bank;
  }
  for (const subject of family.subjects) {
    const bank = family.questions[subject.id];
    if (bank) questions[subject.id] = bank;
  }
  const shadowed = [...familyById.keys()].filter((subjectId) => committedIds.has(subjectId));
  return { subjects, questions, shadowed };
}

/**
 * Keys twin of {@link composeGeneratedLayers}: drop every committed key of a
 * shadowed subject (its committed question ids, plus any id it could own),
 * then add the family keys.
 */
export function composeGeneratedKeys<T>(
  committedKeys: Record<string, T>,
  committedQuestions: QuestionBank,
  familyKeys: Record<string, T>,
  shadowed: readonly string[],
): Record<string, T> {
  const dropped = new Set<string>();
  for (const subjectId of shadowed) {
    const bank = committedQuestions[subjectId];
    if (bank) for (const id of questionIds({ [subjectId]: bank })) dropped.add(id);
  }
  const out: Record<string, T> = {};
  for (const [id, key] of Object.entries(committedKeys)) {
    if (dropped.has(id) || shadowed.some((subjectId) => isSubjectQuestionId(subjectId, id))) {
      continue;
    }
    out[id] = key;
  }
  return { ...out, ...familyKeys };
}
