# AGENTS.md

Repository-level guidance for AI coding agents.

## Scope

This file applies to the entire repository.

## Relationship to `CLAUDE.md`

- `AGENTS.md` is the canonical quick-operating guide for coding agents.
- `CLAUDE.md` is the detailed architecture and invariants reference.
- When both documents touch the same rule, keep them consistent and preserve the stricter interpretation.
- If behavior/invariants change, update both files in the same PR.

## Mission

Keep `project_Examify` (a calm, mobile-first exam-prep app) fully cloud-developable (GitHub + PR + CI/CD + Railway deploy) while preserving the security and operational invariants documented in `CLAUDE.md`.

## Progress + roles (current behaviour)

- Completed mini exams are persisted per student in the `exam_attempts` table via
  the `recordAttempt` server action (`src/actions/recordAttempt.ts`). The score is
  **re-derived server-side** by `scoreAttempt` (`src/lib/exam/score.server.ts`,
  server-only) — client totals are never trusted; the client submits only
  `{ type, id, chosen|response }` and never holds the answer keys.
- **In-progress exams resume server-side.** An unfinished exam lives in the
  `exam_sessions` table (one row per `(user, subject, difficulty)`): `beginExamSession`
  creates the draft on start, `saveExamProgress` autosaves it (debounced on typing,
  flushed on Next/Back, **update-only** so a late save can't resurrect a finished/discarded
  draft). The dashboard shows a "Continue where you left off" prompt (`ExamApp.resumable`,
  fetched in `page.tsx`); `discardExamSession` abandons one and `recordAttempt` clears the
  combo on finish. Same write gate + own-id rule as `recordAttempt`; the row stores only
  public question ids + the user's own answers (**no answer keys**). Helpers:
  `src/lib/exam-session.ts` (server-only). Sessions never expire. Resume rebuilds the
  exact paper via `questionsByIds` (no re-shuffle).
- **Answer keys + rubrics are server-only.** The public bank (`src/lib/exam/data.ts`)
  carries no answers/rubrics; they live in `src/lib/exam/answer-keys.server.ts`,
  keyed by question `id`, and every key carries a mandatory `provenance { pdf, locator }`.
  Keep `attempts.ts` client-safe (it's in the client graph).
- **Content is hand-edited.** The shipped bank is a hand-authored 3-subject sample
  meant to be replaced with the family's own content (optionally generated from their
  source PDFs, kept local-only in the gitignored `content/source-pdfs/`); add content
  as `{ id, type, q, choices? }` in `data.ts` **plus** a matching `ANSWER_KEYS[id]`
  (with provenance) in `answer-keys.server.ts`. Guide: `docs/content-authoring.md`.
- **Free-text is LLM-graded server-side** (`src/lib/grading/index.ts`,
  `ANTHROPIC_API_KEY`; `test` → deterministic stub). Grading never throws — failures
  fall to `needs_review`. A free item is "correct" at `PASS_THRESHOLD` (0.6). The UI
  renders only the bounded `Verdict` fields, never the rubric. Results are
  server-driven (a "Marking…" state covers the submit round-trip). Full design:
  the "Content + grading invariants" block in `CLAUDE.md` + `docs/content-authoring.md`.
- Role split at the `/` gate (`src/app/page.tsx`): a `student` gets the exam flow
  plus a "Your progress" screen; a `parent` gets a dashboard with the child's
  progress, the parent's own progress, and a `ComparisonView` (`ParentDashboard`).
- **Parent "student mode"** (the "Are you smarter than your kid?" flow):
  a parent can toggle `session.studentMode` via `setStudentMode`
  (`src/actions/toggleStudentMode.ts`) to get the full `ExamApp`. The write path
  (`recordAttempt`) is open to a `student` **or** a `parent` with `studentMode`,
  and only ever writes the caller's own `session.userId`. A parent's attempts
  accumulate under the parent's account; the student's record is never touched.
  `session.studentMode` is reset to `false` on every verified sign-in.
- Parent→child linking is per-family via the `FAMILIES` config: `resolveChildren(parentEmail)`
  in `src/lib/progress.ts` returns only the `child` of the family the parent is listed in — a
  parent never sees another family's child, and a standalone child (`parents: []`) appears in no
  dashboard. It's the privacy boundary; keep it isolated. The dashboard shows one child
  (`page.tsx` passes `session.email`). The comparison's "score by attempt number" axis uses
  `getScoreHistory()` (uncapped, oldest-first) rather than the 50-capped `getProgressForUser`.

## Workflow expectations

- Work on feature branches and open pull requests.
- Do not push directly to `main`.
- Prefer small, reviewable commits with clear intent.
- Keep docs in sync for any behavior, route, env-var, or script changes (`README.md`, `CLAUDE.md`, `.env.example`).

## Quality gates (target harness)

Before merge, ensure these pass in CI:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`
5. `pnpm test:e2e` (where browser/network constraints permit)

## Test coverage expectations

- New public routes: add Playwright smoke coverage.
- New mutable server handlers/actions: add happy + failure tests.
- New `src/lib/*` helpers: add unit tests.
- Keep link-crawl and feed/health/OG checks green.

## Deployment constraints (Railway)

- SQLite path should remain runtime-mounted (e.g., `file:/data/app.db`).
- Run migrations at startup (runtime), not build-time.
- Keep `/api/health` lightweight and reliable.
- Preserve fail-closed env validation in production.

## Security invariants (do not weaken)

- Never bypass server-side Turnstile verification on mutating actions.
- Keep canonical IP extraction centralized in `src/lib/ip.ts`.
- Preserve rate-limit boundaries and per-kind separation.
- Keep sign-in role-gated by the `FAMILIES` config (student = a `child`, parent = in some `parents[]`), derived via `isAllowedEmail`; never leak whether an email is configured (no enumeration).
- Keep magic-link tokens hashed at rest and single-use; the token carries the role. Token
  verification lives in a **Route Handler** (`src/app/signin/verify/route.ts`), never a
  Server Component page — clicking the email link is a GET that writes the session cookie,
  and cookie mutation is illegal during a render. Failures redirect to `/signin/verify/error`.

## PR checklist

Include in PR body:

- Routes touched.
- Tests added/updated.
- Command output summary for lint, typecheck, unit, build, and e2e (or explicit reason e2e was skipped).
