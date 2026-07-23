import 'server-only';

/* ============================================================================
   EXAMIFY — ATTEMPT VALIDATION + SCORING (server-only)
   ----------------------------------------------------------------------------
   The score of a finished exam is computed in the browser, so when an attempt
   is persisted we must NOT trust the client's totals. This re-derives `correct`
   / `scorePct` from the submitted items: each item is resolved by `id` against
   the public bank (`./data`) for its snapshot, and against the SERVER-ONLY
   answer keys (`./answer-keys.server`) for the correct index / rubric. MCQ
   items score by index; free-text items are graded by Claude
   (`@/lib/grading`), all concurrently. Returns `{ ok: false }` (never throws)
   on any inconsistency so callers can map it to a clean error.

   This is the server-only successor to the old pure `validateAndScoreAttempt`;
   it lives here (not in `./attempts.ts`) because `attempts.ts` is in the client
   graph and may not import the answer keys.
   ========================================================================== */
import type { AttemptItem, FreeAttemptItem } from '@/lib/db/schema';
import { gradeFreeText } from '@/lib/grading';
import { keyById } from './answer-keys.server';
import { DIFFICULTIES, resolveExamPaper, SUBJECTS, type DifficultyId } from './data';
import { isFreePass, type AttemptInput, type ValidateResult } from './attempts';

const SUBJECT_IDS = new Set<string>(SUBJECTS.map((s) => s.id));
const DIFFICULTY_IDS = new Set<string>(DIFFICULTIES.map((d) => d.id));

/** One resolved item plus whether it counts as correct for the ring/tally. */
type Slot = { item: AttemptItem; correct: boolean };

/**
 * Validate a submitted attempt against the public bank + server-only keys and
 * re-derive its score, grading any free-text items. Never throws.
 */
export async function scoreAttempt(input: AttemptInput): Promise<ValidateResult> {
  if (!SUBJECT_IDS.has(input.subject)) return { ok: false, reason: 'invalid_subject' };
  if (!DIFFICULTY_IDS.has(input.difficulty)) return { ok: false, reason: 'invalid_difficulty' };
  const difficulty = input.difficulty as DifficultyId;

  const items = input.items;
  if (!Array.isArray(items) || items.length === 0) return { ok: false, reason: 'invalid_items' };
  const paper = resolveExamPaper(
    input.subject,
    difficulty,
    items.map((item) => item.id),
  );
  if (paper === null) return { ok: false, reason: 'invalid_items' };

  const slots: (Slot | null)[] = new Array(items.length).fill(null);
  const freeTasks: {
    index: number;
    id: string;
    q: string;
    rubric: string;
    maxScore: number;
    response: string;
  }[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const q = paper[i]!;
    const key = keyById(it.id);
    if (!key) return { ok: false, reason: 'invalid_items' };

    if (it.type === 'mcq') {
      // The question + key must agree this is an MCQ (rejects a mismatched type).
      if (q.type !== 'mcq' || key.type !== 'mcq') return { ok: false, reason: 'invalid_items' };
      if (it.chosen !== null) {
        if (!Number.isInteger(it.chosen) || it.chosen < 0 || it.chosen >= q.choices.length) {
          return { ok: false, reason: 'invalid_items' };
        }
      }
      const correct = it.chosen !== null && it.chosen === key.answer;
      slots[i] = {
        item: {
          type: 'mcq',
          id: q.id,
          q: q.q,
          choices: q.choices,
          chosen: it.chosen,
          answer: key.answer,
        },
        correct,
      };
    } else {
      if (q.type !== 'free' || key.type !== 'free') return { ok: false, reason: 'invalid_items' };
      if (typeof it.response !== 'string' || it.response.trim() === '') {
        return { ok: false, reason: 'invalid_items' };
      }
      freeTasks.push({
        index: i,
        id: q.id,
        q: q.q,
        rubric: key.rubric,
        maxScore: key.maxScore,
        response: it.response,
      });
    }
  }

  // Grade every free-text item concurrently.
  const graded = await Promise.all(
    freeTasks.map((t) =>
      gradeFreeText({
        question: t.q,
        rubric: t.rubric,
        maxScore: t.maxScore,
        studentAnswer: t.response,
      }),
    ),
  );

  freeTasks.forEach((t, gi) => {
    const r = graded[gi]!;
    let item: FreeAttemptItem;
    let correct = false;
    if (r.status === 'graded') {
      correct = isFreePass(r.verdict.score, t.maxScore);
      item = {
        type: 'free',
        id: t.id,
        q: t.q,
        response: t.response,
        maxScore: t.maxScore,
        score: r.verdict.score,
        status: 'graded',
        verdict: r.verdict,
      };
    } else {
      item = {
        type: 'free',
        id: t.id,
        q: t.q,
        response: t.response,
        maxScore: t.maxScore,
        score: null,
        status: 'needs_review',
        verdict: null,
      };
    }
    slots[t.index] = { item, correct };
  });

  const resolved = slots as Slot[];
  const total = resolved.length;
  const correct = resolved.reduce((n, s) => n + (s.correct ? 1 : 0), 0);
  const scorePct = Math.round((correct / total) * 100);
  return {
    ok: true,
    subject: input.subject,
    difficulty,
    total,
    correct,
    scorePct,
    items: resolved.map((s) => s.item),
  };
}
