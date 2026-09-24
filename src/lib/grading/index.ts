import 'server-only';

/* ============================================================================
   EXAMIFY — FREE-TEXT GRADING (server-only)
   ----------------------------------------------------------------------------
   Marks a child's short free-text answers against server-only rubrics with
   the household's AI (`gradeAnswers`; `markingBackendForAiMode` maps the
   wizard's mode): OpenAI, Local endpoint, Claude Code and Codex live in
   `./backends.ts`; Anthropic, below, is also the path for Local command, the
   test stub and a household with no mode. The Anthropic paths:
   - live `ANTHROPIC_API_KEY === 'test'` (process.env only, never the boot-frozen
     `env.ts` snapshot) → a deterministic full-score stub, no network — but
     only when `gradingStubAllowed()`: outside production, or in production
     with `GRADING_STUB=1` (Playwright's `next start`). A production host that
     kept the install.sh sentinel gets `needs_review`, never free full marks.
     Blank / missing / whitespace are not `test`. Mirrors the Resend outbox
     stub so `pnpm dev`, unit tests and Playwright never hit the API.
   - live key missing / empty / whitespace (wizard clear) → `{ status: 'needs_review' }`
     fail-closed. No stub. Same “usable?” rule as the wizard Configured badge.
   - otherwise → a single `fetch` to the Anthropic Messages API.

   Fail-safe (I4): any failure — network error, timeout, non-2xx, unparseable
   or malformed JSON — resolves to `{ status: 'needs_review' }` rather than
   throwing, so an attempt is never lost. Nothing re-grades it later: the item
   is stored unmarked and counts as not correct. Each such outcome logs one
   `[grading]` warning with a short reason code only — never the answer, the
   question, the rubric, the key, an error message (a JSON.parse message can
   quote model text), or any user identifier.

   Only the bounded `Verdict` fields ever leave this module; the rubric and the
   raw model text are never returned to callers (and so never reach the client).
   ========================================================================== */
import { ANTHROPIC_ENV_KEY, envStoreSecretConfigured } from '@/lib/env-store';
import type { MarkingBackend } from '@/lib/onboarding-types';
import {
  gradeViaAgentCli,
  gradeViaLocalEndpoint,
  gradeViaOpenAi,
  markingHostEnv,
} from './backends';
import {
  API_GRADING_TIMEOUT_MS,
  gradingStubAllowed,
  needsReview,
  stubGrade,
  systemPrompt,
  thrownReason,
  toVerdict,
  userPrompt,
  type GradeArgs,
  type GradeResult,
} from './shared';

export {
  clampScore,
  gradingStubAllowed,
  type GradeArgs,
  type GradeResult,
  type NeedsReviewReason,
} from './shared';

const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Wizard / install writes update `process.env` and `.env`. Computed
 * `process.env[ANTHROPIC_ENV_KEY]` so Next cannot inline a boot snapshot.
 * Never read env.ts — after clear that would stub on leftover `test`.
 * Same usable-key rule as the wizard Configured badge (`anthropicConfigured`).
 */
function liveAnthropicApiKey(): string | undefined {
  const live = process.env[ANTHROPIC_ENV_KEY];
  if (typeof live !== 'string') return undefined;
  const trimmed = live.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Grade one free-text answer. Returns `{ status: 'graded', verdict }` on success
 * or `{ status: 'needs_review' }` on any failure (never throws).
 */
export async function gradeFreeText(args: GradeArgs): Promise<GradeResult> {
  const apiKey = liveAnthropicApiKey();
  // Deterministic stub only when the live store still holds the sentinel and
  // the stub is allowed here (never a silent full-marks default in production).
  if (apiKey === 'test') {
    if (!gradingStubAllowed()) return needsReview('stub_disabled_in_production');
    return stubGrade(args);
  }
  if (!envStoreSecretConfigured('ANTHROPIC_API_KEY') || !apiKey) {
    return needsReview('no_key');
  }

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: systemPrompt(),
        messages: [{ role: 'user', content: userPrompt(args) }],
      }),
      signal: AbortSignal.timeout(API_GRADING_TIMEOUT_MS),
    });
    if (!res.ok) return needsReview(`http_${res.status}`);

    const data: unknown = await res.json();
    const text = firstTextBlock(data);
    if (text === null) return needsReview('bad_shape');

    const verdict = toVerdict(JSON.parse(text), args.maxScore);
    if (verdict === null) return needsReview('bad_shape');
    return { status: 'graded', verdict };
  } catch (error) {
    // Network error, deadline, non-JSON body, or JSON.parse throwing → not
    // marked. Classify by type/name only; the message may quote model text.
    return needsReview(thrownReason(error));
  }
}

/**
 * Mark every written answer of an attempt with the household's backend
 * (`markingBackendForAiMode`), in order. Anthropic keeps the per-answer path
 * above; the others live in `./backends.ts`. Never throws: anything
 * unexpected leaves every answer unmarked (`internal_error`).
 */
export async function gradeAnswers(
  tasks: readonly GradeArgs[],
  backend: MarkingBackend = 'anthropic',
): Promise<GradeResult[]> {
  if (tasks.length === 0) return [];
  try {
    switch (backend) {
      case 'anthropic':
        return await Promise.all(tasks.map((task) => gradeFreeText(task)));
      case 'openai':
        return await gradeViaOpenAi(tasks);
      case 'local-endpoint':
        return await gradeViaLocalEndpoint(tasks, markingHostEnv());
      case 'claude-cli':
        return await gradeViaAgentCli(tasks, 'claude', markingHostEnv());
      case 'codex-cli':
        return await gradeViaAgentCli(tasks, 'codex', markingHostEnv());
    }
  } catch {
    return tasks.map(() => needsReview('internal_error', backend));
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
