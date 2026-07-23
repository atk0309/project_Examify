import 'server-only';

/* ============================================================================
   EXAMIFY — FREE-TEXT GRADING (server-only)
   ----------------------------------------------------------------------------
   Grades a child's short free-text answer against a server-only rubric using
   Claude. Two paths:
   - `ANTHROPIC_API_KEY === 'test'` → a deterministic full-score stub, no
     network. This mirrors the Resend outbox stub so `pnpm dev`, unit tests and
     Playwright (which inject the `test` sentinel) never hit the API.
   - otherwise → a single `fetch` to the Anthropic Messages API.

   Fail-safe (I4): any failure — network error, non-2xx, unparseable or
   malformed JSON — resolves to `{ status: 'needs_review' }` rather than
   throwing, so an attempt is never lost; the item is simply held for review.

   Only the bounded `Verdict` fields ever leave this module; the rubric and the
   raw model text are never returned to callers (and so never reach the client).
   ========================================================================== */
import { env } from '@/lib/env';
import type { Verdict } from '@/lib/db/schema';

export type GradeResult = { status: 'graded'; verdict: Verdict } | { status: 'needs_review' };

export type GradeArgs = {
  question: string;
  rubric: string;
  maxScore: number;
  studentAnswer: string;
};

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GRADING_TIMEOUT_MS = 15_000;

/** Round and clamp a raw model score into `[0, max]`. */
export function clampScore(raw: number, max: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(Math.round(raw), 0), max);
}

/** True for an array whose every element is a string (used to vet list fields). */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Coerce an arbitrary parsed JSON value into a `Verdict`, or `null` if the shape
 * is untrustworthy. A missing/non-string `verdict`, a non-finite `score`, or a
 * present-but-non-array list field all fail to `null` (→ needs_review). Absent
 * list fields default to `[]`.
 */
function toVerdict(value: unknown, maxScore: number): Verdict | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;

  if (typeof o.score !== 'number' || !Number.isFinite(o.score)) return null;
  if (typeof o.verdict !== 'string' || o.verdict.trim() === '') return null;

  const lists: Record<'gotRight' | 'toReview' | 'spelling', string[]> = {
    gotRight: [],
    toReview: [],
    spelling: [],
  };
  for (const key of ['gotRight', 'toReview', 'spelling'] as const) {
    if (o[key] === undefined) continue;
    if (!isStringArray(o[key])) return null;
    lists[key] = o[key];
  }

  return {
    score: clampScore(o.score, maxScore),
    verdict: o.verdict,
    gotRight: lists.gotRight,
    toReview: lists.toReview,
    spelling: lists.spelling,
  };
}

function systemPrompt(): string {
  return [
    "You are marking a child's short free-text exam answer against a rubric.",
    'Be encouraging but fair. Reply with STRICT JSON only — no prose, no code fences —',
    'matching exactly this shape:',
    '{"score": <integer 0..maxScore>, "verdict": "<one short sentence>",',
    ' "gotRight": ["..."], "toReview": ["..."], "spelling": ["..."]}',
    '`gotRight` lists what the answer got right; `toReview` lists what was missed or wrong;',
    '`spelling` lists spelling slips (do not deduct marks for spelling). Keep each item short.',
  ].join('\n');
}

function userPrompt(args: GradeArgs): string {
  return [
    `Question: ${args.question}`,
    '',
    `Maximum score: ${args.maxScore}`,
    '',
    'Rubric:',
    args.rubric,
    '',
    "Student's answer:",
    args.studentAnswer,
  ].join('\n');
}

/**
 * Grade one free-text answer. Returns `{ status: 'graded', verdict }` on success
 * or `{ status: 'needs_review' }` on any failure (never throws).
 */
export async function gradeFreeText(args: GradeArgs): Promise<GradeResult> {
  // Deterministic stub for dev / test — full marks, no network.
  if (env.ANTHROPIC_API_KEY === 'test') {
    return {
      status: 'graded',
      verdict: {
        score: args.maxScore,
        verdict: 'Looks good.',
        gotRight: [],
        toReview: [],
        spelling: [],
      },
    };
  }

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: systemPrompt(),
        messages: [{ role: 'user', content: userPrompt(args) }],
      }),
      signal: AbortSignal.timeout(GRADING_TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'needs_review' };

    const data: unknown = await res.json();
    const text = firstTextBlock(data);
    if (text === null) return { status: 'needs_review' };

    const verdict = toVerdict(JSON.parse(text), args.maxScore);
    if (verdict === null) return { status: 'needs_review' };
    return { status: 'graded', verdict };
  } catch {
    // Network error, non-JSON body, or JSON.parse throwing → hold for review.
    return { status: 'needs_review' };
  }
}

/** Pull the first text block out of an Anthropic Messages API response. */
function firstTextBlock(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}
