/* ============================================================================
   EXAMIFY — ATTEMPT TYPES + AGGREGATES (pure, client-safe)
   ----------------------------------------------------------------------------
   This module is in the CLIENT graph (e.g. `ComparisonView` imports
   `overallAverage` as a value), so it must stay free of `server-only`, the
   answer keys, and the grader. The actual validate + score + grade pass lives
   in `./score.server.ts` (server-only), which needs the answer keys. Here we
   keep only pure helpers, shared types, and the free-text pass test.
   ========================================================================== */
import type { AttemptItem, FreeAttemptItem, McqAttemptItem } from '@/lib/db/schema';
import { SUBJECTS, type DifficultyId } from './data';

export type { AttemptItem };

/** A single answer as submitted by the client when an exam finishes. */
export type SubmitMcqItem = { type: 'mcq'; id: string; chosen: number | null };
export type SubmitFreeItem = { type: 'free'; id: string; response: string };
export type SubmitItem = SubmitMcqItem | SubmitFreeItem;

/** Raw input as submitted by the client when an exam finishes. */
export type AttemptInput = {
  subject: string;
  difficulty: string;
  items: SubmitItem[];
};

/** A validated, server-scored attempt ready to persist. */
export type ScoredAttempt = {
  subject: string;
  difficulty: DifficultyId;
  total: number;
  correct: number;
  scorePct: number;
  items: AttemptItem[];
};

export type ValidateResult =
  | ({ ok: true } & ScoredAttempt)
  | { ok: false; reason: 'invalid_subject' | 'invalid_difficulty' | 'invalid_items' };

/**
 * A free-text item counts as "correct" for the ring/tally when the student
 * scored at least this fraction of the available marks. A shared constant (not
 * an inline literal) so the scorer and tests agree.
 */
export const PASS_THRESHOLD = 0.6;

/** Whether a graded free-text score clears {@link PASS_THRESHOLD}. */
export function isFreePass(score: number, maxScore: number): boolean {
  return maxScore > 0 && score / maxScore >= PASS_THRESHOLD;
}

/**
 * Narrow a persisted `AttemptItem` to a discriminated `{ kind, item }`. Rows
 * persisted before free-text existed carry no `type`; they are MCQ, so an
 * absent `type` normalises to `'mcq'`. Renderers branch on `.kind` and read the
 * narrowed `.item` rather than casting on the raw discriminant.
 */
export type NormalizedAttemptItem =
  { kind: 'mcq'; item: McqAttemptItem } | { kind: 'free'; item: FreeAttemptItem };

export function normalizeAttemptItem(item: AttemptItem): NormalizedAttemptItem {
  if (item.type === 'free') return { kind: 'free', item };
  return { kind: 'mcq', item };
}

/* -------------------------------- Aggregates -------------------------------- */

/** A persisted attempt as surfaced to the progress views. */
export type AttemptRecord = {
  id: number;
  subject: string;
  difficulty: DifficultyId;
  total: number;
  correct: number;
  scorePct: number;
  createdAt: number;
  items: AttemptItem[];
};

/** Per-subject roll-up shown at the top of a progress view. */
export type SubjectSummary = {
  subjectId: string;
  attempts: number;
  best: number;
  average: number;
  /** Most recent attempt's score for this subject. */
  last: number;
};

export type ProgressData = {
  attempts: AttemptRecord[];
  subjects: SubjectSummary[];
};

/**
 * Chronological (oldest-first) `scorePct` series from records that arrive
 * newest-first (the order `getProgressForUser` returns). Used to plot "score by
 * attempt number". For the true full series, feed it the uncapped history from
 * `getScoreHistory` rather than the 50-capped `ProgressData.attempts`.
 */
export function scoreSequence(attempts: AttemptRecord[]): number[] {
  return attempts.map((a) => a.scorePct).reverse();
}

/** Rounded mean of a score list (empty → 0). */
export function overallAverage(scores: number[]): number {
  if (scores.length === 0) return 0;
  return Math.round(scores.reduce((n, s) => n + s, 0) / scores.length);
}

/**
 * Roll attempts up per subject. Expects `attempts` newest-first (the order
 * `getProgressForUser` returns), so the first row seen per subject is "last".
 * Summaries are returned in `SUBJECTS` order for stable rendering.
 */
export function summariseAttempts(attempts: AttemptRecord[]): SubjectSummary[] {
  const groups = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    const list = groups.get(a.subject);
    if (list) list.push(a);
    else groups.set(a.subject, [a]);
  }

  const summaries: SubjectSummary[] = [];
  for (const subject of SUBJECTS) {
    const rows = groups.get(subject.id);
    if (!rows || rows.length === 0) continue;
    const scores = rows.map((r) => r.scorePct);
    summaries.push({
      subjectId: subject.id,
      attempts: rows.length,
      best: Math.max(...scores),
      average: Math.round(scores.reduce((n, s) => n + s, 0) / scores.length),
      last: rows[0]!.scorePct,
    });
  }
  return summaries;
}
