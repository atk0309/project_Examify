# CLAUDE.md

Working agreement for AI assistants (and humans) editing this repo. Read this before
making any change — it encodes invariants that are easy to miss from the diff alone.

`AGENTS.md` and `CLAUDE.md` are paired guidance documents:

- `AGENTS.md` is the canonical quick-operating guide for coding agents.
- `CLAUDE.md` remains the detailed architecture, invariants, and rationale reference.
- If overlapping guidance changes, update both files in the same PR and keep the stricter interpretation.

## Project snapshot

`project_Examify` is a calm, mobile-first **exam-prep app** a parent self-hosts for
their kid(s). It turns content (optionally sourced from the family's own study PDFs,
added by hand to a static data file) into short practice exams. It is intentionally
small: a static question bank, a four-screen client flow, magic-link sign-in gated by
an email allowlist, and SQLite in a single file on runtime-mounted persistent storage.

Surface:

- **`/`** — the app. A server gate: no session → redirect to `/signin`. A `student`
  session renders the client `ExamApp` (dashboard → difficulty → exam → results, plus
  a "Your progress" screen); a `parent` session renders `ParentDashboard` (the child's
  progress, the parent's own progress, and a parent-vs-child comparison). A parent can
  enter **student mode** ("Are you smarter than your kid?") to get the full
  `ExamApp` themselves; their attempts persist under the parent's own account, never the
  child's.
- **`/signin`** — magic-link login with a Student/Parent role control.
- **`/signin/verify`** — a **Route Handler** (`route.ts`, not a page): consumes the one-time
  token, establishes the session, redirects to `/`. It must be a route handler because
  clicking the email link is a GET that **writes** the session cookie, and cookie mutation is
  illegal during a Server Component render (Next.js 16). Failures redirect to its sibling page.
- **`/signin/verify/error`** — a read-only page that renders the human-readable failure copy
  for an invalid/expired/used/missing token, keyed off a `?reason=` query param.
- **`/api/health`** — lightweight platform healthcheck.
- **`/robots.txt`** — disallow-all (this is a private, allowlisted app).

There is **no blog, no MDX, no admin panel, no public marketing page** — the first screen
is the usable login, and the screen after it is the usable dashboard.

## Stack and pinned versions

Latest stable of each, exact-pinned in `package.json` (no `^`/`~`). Bumps land via the
grouped weekly Dependabot PRs in `.github/dependabot.yml`.

| Layer       | Choice                                                                       |
| ----------- | ---------------------------------------------------------------------------- |
| Runtime     | Node 22 LTS (`engines`, `.nvmrc`), pnpm 10                                   |
| Framework   | Next.js 16 (App Router, Turbopack), React 19.2, TypeScript 6 strict          |
| Styling     | Tailwind v4 with a CSS-first `@theme` token block, three `data-theme` moods  |
| DB          | SQLite on runtime-mounted storage, accessed through Drizzle + better-sqlite3 |
| Auth        | Homegrown magic-link (Resend) + iron-session cookies, role-gated by env      |
| Captcha     | Cloudflare Turnstile, server-verified on the login submit                    |
| Email       | Resend SDK, with a `tests/.tmp/outbox/*.json` short-circuit when key=test    |
| Tests       | Vitest (unit), Playwright (e2e), Cloudflare dummy test keys                  |
| Lint/Format | ESLint 9.39 (Next 16 plugin set) + Prettier + Tailwind plugin                |

**Why ESLint 9, not 10?** `eslint-plugin-react@7.x` doesn't support ESLint 10 yet, and
`eslint-config-next@16` pulls it in transitively. Move both together later.

## Commands cheat-sheet

| Command             | What it does                                       |
| ------------------- | -------------------------------------------------- |
| `pnpm dev`          | Next.js dev server with Turbopack                  |
| `pnpm build`        | Production build                                   |
| `pnpm start`        | Run the production build (`PORT` defaults to 3000) |
| `pnpm lint`         | ESLint flat-config across the repo                 |
| `pnpm format`       | Prettier write                                     |
| `pnpm format:check` | Prettier dry-run (CI guard)                        |
| `pnpm typecheck`    | `tsc --noEmit`                                     |
| `pnpm test`         | Vitest unit suite                                  |
| `pnpm test:e2e`     | Playwright e2e (requires `pnpm test:e2e:install`)  |
| `pnpm db:generate`  | Generate a new Drizzle migration from schema diffs |
| `pnpm db:migrate`   | Apply pending migrations to `DATABASE_URL`         |
| `pnpm db:studio`    | Drizzle Studio against the local DB                |

## Branch + PR rules

- All development lands on a feature branch.
- **Never push directly to `main`**. Every change opens a PR.
- PR body lists routes touched and tests added (the `PULL_REQUEST_TEMPLATE.md` enforces this).
- Don't merge with a red CI. Don't merge bypassing required reviews.

## End-of-session ritual (every session)

1. **Docs pass** — update `README.md`, `CLAUDE.md`, and `.env.example` for anything that
   changed (new env var, new route, new script, behaviour invariant).
2. **Test expansion pass** —
   - any new page route gets a Playwright smoke (200 + title) and is covered by the link-crawl;
   - any new server action or route handler gets at least one happy + one failure test;
   - any new helper in `src/lib/` gets a Vitest unit test.
3. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (and `pnpm test:e2e` when
   possible) — paste the green summary in the PR body.

## Architecture

```
src/
  app/                  # routes (App Router)
    api/health/         # platform healthcheck
    signin/             # magic-link login (page); verify (route.ts) + verify/error (page)
    page.tsx            # auth gate -> ExamApp
    layout.tsx          # fonts (Newsreader + Hanken Grotesk via <link>), data-theme
    globals.css         # Tailwind @theme tokens + component layer
    robots.ts           # disallow-all
  actions/              # 'use server' actions (requestMagicLink, signOut, recordAttempt,
                        #   saveExamProgress + discardExamSession = resume an in-progress exam)
  components/
    exam/               # ExamApp (flow), ProgressView, ParentDashboard, LoginForm, icons
    analytics/          # Plausible (opt-in)
  lib/
    exam/data.ts        # SUBJECTS + QUESTIONS bank + accentCSS + buildExam
    exam/attempts.ts    # validate + re-score a submitted attempt; aggregate helpers (pure)
    progress.ts         # persist/read attempts; resolveChildren(parentEmail) per-family (server-only)
    exam-session.ts     # save/list/clear an in-progress exam for resume (server-only)
    families.ts         # FAMILIES config: student/parent allowlists + parent->child visibility (pure)
    allowlist.ts        # isAllowedEmail(role,email), derived from FAMILIES
    auth.ts, db/, email/, captcha.ts, ip.ts, rate-limit.ts, env.ts, site.ts
tests/
  unit/                 # vitest specs
  e2e/                  # playwright specs (setup-db.ts runs pre-Playwright)
  stubs/                # vitest-only stubs (e.g. server-only no-op)
```

`@/*` resolves to `src/*`.

## Adding content

Public question text lives in `src/lib/exam/data.ts`; answers/rubrics live in the
server-only `src/lib/exam/answer-keys.server.ts` (no CMS, no MDX). The two are
keyed by a shared, globally-unique question `id` — **never** put an `answer` or
`rubric` back into `data.ts` (it would ship to the browser; that's the I2 leak):

- **Question:** add the **public** part to `QUESTIONS[subjectId][difficulty]` —
  `{ id, type:'mcq', q, choices }` or `{ id, type:'free', q }` (no answer/rubric) —
  **and** a matching key to `ANSWER_KEYS[id]` in `answer-keys.server.ts`:
  `{ type:'mcq', answer, provenance }` (correct choice index) or
  `{ type:'free', rubric, maxScore, provenance }`. `provenance { pdf, locator }` is
  **mandatory** on every key (enforced by `tests/unit/answer-keys.test.ts`).
- **Subject:** add to `SUBJECTS` (with OKLCH accent parts `{l, c, h}`), add a matching
  `QUESTIONS[id]` bank + `ANSWER_KEYS` entries, and an icon keyed the same in
  `src/components/exam/icons.tsx`.
- **Difficulty:** extend `DIFFICULTIES` + the matching `QUESTIONS` keys.
- **Exam length:** `EXAM_CONFIG.length` (caps at bank size); `shuffle` toggles order.

The shipped bank is a **hand-authored sample** (Maths, Computer Science, Geography —
5 MCQ + 1–2 free-text per difficulty) meant to be replaced with the family's own
content. `docs/content-authoring.md` is the full guide: question/key formats, rubric
style, adding subjects (all 13 original duotone icons remain in `icons.tsx`, reusable),
and the vision-first workflow for generating a grounded bank from source PDFs kept
local-only in the gitignored `content/source-pdfs/`.

## Styling / theming

- Tokens live in the `@theme` block in `globals.css` (type scale, spacing, radii, shadow
  primitives, motion, fonts). Components consume them via a `@layer components` block of
  semantic classes (`.subject-card`, `.btn`, `.choice`, `.score-ring`, the login bits…).
- Three moods under `[data-theme="paper" | "calm" | "focus"]` on `<html>` (paper is the
  default). Each theme redefines **only** surface/text/border/shadow colour tokens.
- Per-subject accents are stored as OKLCH parts and applied at runtime as inline style
  from `accentCSS(subject, sat)` (sets `--accent` / `--accent-ink` / `--accent-tint` /
  `--accent-soft`). `sat` is a single chroma multiplier so the palette re-tones at once.
- Screen-entry animations are **transform-only on purpose**: a throttled/inactive tab
  pauses an animation at 0%, so animating opacity from 0 would hold content invisible.
  Don't reintroduce `opacity` into the screen keyframes.
- Fonts (Newsreader display + Hanken Grotesk UI) are loaded via a stylesheet `<link>` in
  the root layout rather than `next/font/google`, so the production build never has to
  reach the Google Fonts CDN at build time.

## Auth + rate-limit invariants

These are non-negotiable. Don't "fix" them out.

- **Roles come from the `FAMILIES` config.** The single JSON env var `FAMILIES`
  (`src/lib/families.ts`) is the credential store — same runtime-config pattern as `SITE_URL`.
  Each entry is `{ child, parents[] }`; the student allowlist is every `child`, the parent
  allowlist is every `parents[]` entry. An email may request a link for a role only if `FAMILIES`
  lists it in that role (`isAllowedEmail`, `src/lib/allowlist.ts`). There is no password and no
  DB-backed admin. `FAMILIES` is parsed **strictly** at boot (`parseFamilies`) — a duplicate child,
  an email used as both child and parent, or a parent shared across families is rejected, because
  it's the privacy boundary (see "Linking is per-family" below), not just a list.
- **No enumeration.** `requestMagicLink` always returns the generic `sent` state once
  Turnstile + rate-limit pass; it only issues + emails a link when the email is allowed.
  Don't add a branch that reveals whether an email is configured. (Practical
  consequence: a student login only delivers a link if the address is a `child` in
  `FAMILIES` — a missing email looks identical to a non-configured one.)
- **The "sent" screen resets via client state, not navigation.** `LoginForm` lives on
  `/signin`, so "Use a different email" can't be a `<Link href="/signin">` — that's a
  same-route soft nav that never remounts the component, leaving `useActionState` at
  `status: 'sent'` (the button looked dead). It toggles a local `dismissed` flag back to
  the form; the `submit` wrapper clears `dismissed` so a fresh send re-shows the screen.
- Turnstile is **never** bypassed server-side. The login action calls `verifyTurnstile()`
  with the client's token before issuing anything.
- IP extraction always goes through `src/lib/ip.ts`, which prefers `cf-connecting-ip` →
  `x-real-ip` → the **last** entry of `x-forwarded-for`. The first XFF entry is
  client-controllable; don't read `x-forwarded-for` directly in handlers.
- Rate-limit windows are tracked in `rate_limit_events`. Sign-in uses a **single**
  `signin` bucket (10/IP/hour by default) for every request, regardless of whether a user
  row exists — a per-state threshold would leak whether an email is a returning/approved
  user even behind the generic "sent" copy. Don't split it back into signup/login.
- Magic-link tokens are stored **hashed** at rest (`sha256`), single-use (a `consumed_at`
  timestamp marks them spent inside the same transaction that resolves the user), and 15
  minutes long. The token carries the **role** so verify can set `session.role` without
  re-checking env.
- Sessions store `{ userId, role, email, studentMode? }` (`role` is `student | parent`).
  `studentMode` is parent-only: when `true`, a parent gets the full `ExamApp` (the "Are you
  smarter than your kid?" flow). It's set by `setStudentMode`
  (`src/actions/toggleStudentMode.ts`, parent-only) and **reset to `false` on every verified
  sign-in** (`/signin/verify`), so a returning parent always lands on the dashboard. `signOut`
  (`src/actions/signOut.ts`) destroys the session and returns to `/signin`.

## Progress tracking + roles

State-bearing, unlike the rest of the app. Don't undo these in the name of "keeping it
stateless".

- **`exam_attempts`** (`src/lib/db/schema.ts`): one row per completed mini exam, owned by
  `user_id → users.id` (the student who sat it, **or** a parent in student mode — always the
  caller's own id). Aggregate columns (`total` / `correct` / `score_pct`) are
  denormalised for cheap per-subject roll-ups, plus an `items` JSON column holding the
  per-question snapshot — a discriminated union by `type`: MCQ `{ type:'mcq', id, q, choices,
chosen, answer }`, free-text `{ type:'free', id, q, response, maxScore, score, status, verdict }`
  — so the review survives later edits to the question bank. Rows persisted before free-text
  existed carry no `type`; treat an absent `type` as `'mcq'` via `normalizeAttemptItem`. The
  JSON shape is a TS-level `$type<>()` change only — no SQL migration. Migration runs at runtime.
- **`exam_sessions`** (`src/lib/db/schema.ts`): the **in-progress** counterpart — one
  autosaved row per `(user_id, subject, difficulty)` (unique index) so a reload, a closed
  browser, or a discarded mobile tab can **resume** mid-exam instead of restarting. It stores
  only the public `question_ids` (the exact ordered paper — resume rebuilds and validates the
  questions via `resolveExamPaper`, never a re-shuffled `buildExam`) plus the user's own `answers` and
  `current_index`. **No answer keys** ever land here (same I2 rule as `data.ts`). Owned by the
  caller's own `user_id` (student, or parent in student mode), like `exam_attempts`. Helpers
  live in `src/lib/exam-session.ts` (`server-only`): `saveExamSession` upserts (used to **create**
  the draft on start), `updateExamSession` is **update-only** (the autosave path — it never inserts,
  so a debounced save still in flight when the exam is finished/discarded can't resurrect a cleared
  row), `getExamSessions` lists newest-first, `clearExamSession` deletes one combo. The
  `beginExamSession` action creates the draft on start; `saveExamProgress` autosaves (debounced on
  typing, flushed on Next/Back, update-only); `discardExamSession` abandons one; `recordAttempt`
  **clears** the finished combo on success so a completed exam stops being resumable. Sessions
  **never expire** — only finishing or an explicit discard removes them. Resume is a dashboard
  "Continue where you left off" prompt (`ExamApp` fetches `resumable` server-side via `page.tsx`),
  not an auto-jump; the in-memory live card is keyed to the _active exam's_ subject (`examSubject`),
  not the navigation `subject`, so browsing other tiles can't mis-label a draft.
- **Never trust the client's score.** `scoreAttempt` (`src/lib/exam/score.server.ts`,
  **server-only** — it reads the answer keys) re-derives `correct`/`score_pct` from the submitted
  items. The client submits only `{ type, id, chosen|response }`; the scorer resolves each item by
  `id` against the public bank (`./data`) for its snapshot and the server-only keys
  (`./answer-keys.server`) for the correct index / rubric (item must exist; `chosen` in range;
  ids must be unique; and the payload must contain exactly the number of questions
  `buildExam()` returns for that bank). The same public-paper validation guards resumable
  drafts, including answer type/range and current-index checks. `saveAttempt`
  (`src/lib/progress.ts`, now async) persists only what the scorer returns and returns the
  inserted `AttemptRecord`.
- **Write path: own id only.** The `recordAttempt` action (`src/actions/recordAttempt.ts`)
  accepts a `student`, **or** a `parent` with `session.studentMode === true`, and writes for
  `session.userId` only — never a client-supplied id, never the child's. This is the one
  deliberate softening of the old "student-only" rule: a parent in student mode is a first-class
  writer **of their own** attempts. A parent **without** student mode is still read-only. Keep
  the strict `=== true` check in both the action and the `/` gate so a malformed session can't
  route a parent into the exam UI behind a write the action would reject.
- **The child stays bound to their family.** A parent's child is resolved from `FAMILIES` via
  `resolveChildren(parentEmail)`, independent of who is signed in. A parent playing in student mode
  never reassigns the child's attempts — ownership is structural (`user_id`), so the child's record
  is sacrosanct. Existing progress survives a `FAMILIES` config change as long as the `child` email
  matches the child's existing `users.email` — it's a config change, **not** a DB migration (never
  rewrite `exam_attempts` / `exam_sessions`).
- **Linking is per-family (the privacy boundary).** `resolveChildren(parentEmail)`
  (`src/lib/progress.ts`) returns the `child` of every family in `FAMILIES` whose `parents[]`
  contains that parent's email — and **nothing else**. A parent sees only their own child; a
  standalone child (`parents: []`) belongs to no family here and never surfaces in any parent
  dashboard; one family can never see another's. This is the one read path that crosses user ids, so
  keep it isolated. `page.tsx` passes `session.email` and still renders a single child
  (`resolveChildren(...)[0]`) — multi-child UI stays out of scope, which is why `parseFamilies`
  rejects a parent shared across families rather than half-supporting it.
- **Comparison.** `ComparisonView` (`src/components/exam/ComparisonView.tsx`) shows parent
  vs child: totals + per-subject averages + a "score by attempt number" progression. Totals
  and the progression use `getScoreHistory()` (`src/lib/progress.ts`, **uncapped**,
  oldest-first `scorePct`) so attempt #1 is the true first attempt; the per-subject panel
  composes the 50-capped `ProgressData` and is labelled "recent". Pure helpers
  `scoreSequence` / `overallAverage` live in `src/lib/exam/attempts.ts`.
- The progress UI (`ProgressView`, `ComparisonView`) reuses the existing token system +
  component classes (`.review`, `.subject-card`, `.compare-*`, accent vars via `accentCSS`);
  progress/parent views are authenticated-only, so they have no public-route Playwright smoke.

## Content + grading invariants

These are non-negotiable. Don't "fix" them out.

- **Answer keys are server-only.** The public bank `src/lib/exam/data.ts` carries no answers or
  rubrics — only `{ id, type, q, choices? }`. The correct MCQ index and every free-text rubric +
  `maxScore` live in `src/lib/exam/answer-keys.server.ts` (`import 'server-only'`), keyed by `id`.
  `buildExam()` runs in the client, so anything it returns ships in the bundle; never put an
  `answer` or `rubric` back into `data.ts`. The guard in `tests/unit/answer-keys.test.ts` asserts
  the no-leak rule, the `id`↔key bijection (ids are globally unique), type-match, key ranges, and
  the mandatory-provenance rule below.
- **Every key carries `provenance { pdf, locator }`.** Each key records where the item came
  from: a source document (`pdf` = filename, `locator` = page/section — PDFs stay local-only
  in the gitignored `content/source-pdfs/`) or the `'hand-authored'` convention the sample
  bank uses. The type makes `provenance` required — `McqKey` and `FreeKey` both have a
  non-optional `provenance` — and the guard asserts both fields are non-empty on every key.
  `provenance` is server-only metadata; it is never rendered.
- **`attempts.ts` stays client-safe.** `ComparisonView` imports `overallAverage` from it as a
  value, so `attempts.ts` is in the client graph: keep it free of `server-only`, the answer keys,
  and the grader. The validate+score+grade pass lives in `score.server.ts`, not here.
- **Free-text is graded server-side, fail-safe.** `gradeFreeText` (`src/lib/grading/index.ts`,
  server-only) returns `{ status:'graded', verdict } | { status:'needs_review' }` and **never
  throws** — the request has a 15-second deadline, and any timeout/fetch error, non-2xx, or
  malformed/unparseable model JSON falls to `needs_review` so an attempt is never lost.
  `ANTHROPIC_API_KEY === 'test'` (dev/test default) uses a deterministic full-score stub, no
  network — same pattern as the Resend outbox stub.
- **A free-text item is "correct" at `PASS_THRESHOLD` (0.6).** `isFreePass(score, maxScore)`
  (`attempts.ts`, the shared constant — not an inline literal) decides the ring/tally. A
  `needs_review` item persists `score: null, verdict: null` and counts as incorrect.
- **Render only the bounded verdict.** The UI shows only `Verdict` fields (`score`, `verdict`,
  `gotRight`, `toReview`, `spelling`) — never the rubric, never raw model text. `needs_review`
  renders "Saved for review".
- **Results are server-driven.** Because the client holds no answer keys, it can't self-score:
  on finish `ExamApp` submits, shows a "Marking…" state, and renders from the returned
  `AttemptRecord` (or an error/retry screen). Every `ExamApp` instance can submit (the `/` gate
  only renders it for a student or a parent in student mode), so there is no `canRecord` prop.

## Environment

Defined and validated by zod in `src/lib/env.ts`. **Fails closed in production:** dev
defaults attach only when `NODE_ENV !== 'production'` (and during `next build`, which Next
distinguishes via `NEXT_PHASE=phase-production-build`). The production server boots under
`NEXT_PHASE=phase-production-server` and `NODE_ENV=production`, so a missing `AUTH_SECRET`,
`TURNSTILE_SECRET_KEY`, etc. crashes boot with a readable zod error (and fails the platform
healthcheck). Don't add dev defaults to security-critical vars without weighing that. `FAMILIES`
is parsed to a typed `Family[]` by a zod transform (`parseFamilies`): empty/unset defaults to `[]`
in production (fail closed: nobody can sign in until set), but malformed JSON or an invalid email
**crashes boot** with a readable zod error.

Required in production: `SITE_URL`, `AUTH_SECRET`, `DATABASE_URL`, `RESEND_API_KEY`,
`RESEND_FROM`, `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`.
`ANTHROPIC_API_KEY` (free-text grading) follows the `RESEND_API_KEY` pattern: a `test`
sentinel routes the grader to a deterministic stub; a missing key fails closed in prod.
`FAMILIES` is optional-but-empty-fails-closed. See `.env.example` for the canonical list.

## Testing rules

- Every public page route gets a Playwright smoke in `tests/e2e/pages.spec.ts` and is
  covered by the internal link-crawl in `tests/e2e/links.spec.ts`.
- Every server action / route handler that mutates state has at least one happy + one
  failure path test.
- Lib helpers (`src/lib/*`) get Vitest unit tests against fixtures, not the app server.
- Cloudflare Turnstile dummy keys: `1x00000000000000000000AA` / `1x00…AA` always pass;
  `2x00000000000000000000AB` / `2x00…AA` always fail. Tests inject
  `cf-turnstile-response="test-bypass-token"` when the widget can't load.
- The Playwright config uses an isolated SQLite at `tests/.tmp/e2e.db`;
  `tests/e2e/setup-db.ts` wipes and re-migrates it via `pnpm test:e2e:prepare`, which
  `pnpm test:e2e` runs _before_ `playwright test`.
- Sign-in e2e uses the documented always-pass Turnstile dummy key. The widget owns the
  single `cf-turnstile-response` field in production; never add a second fallback field
  with that name, because `FormData.get()` can select the empty duplicate instead of the
  valid widget response. When the widget CDN is unavailable, the Playwright helper injects
  that same field and submits it in one browser task. Happy-path, uniform rate-limit, and
  empty-token failure coverage all run without bypassing `verifyTurnstile`.

## Dependency policy

- Exact versions in `package.json`. No `^`, no `~`.
- Bumps land via grouped Dependabot PRs weekly.
- Manual upgrades: bump, re-run `pnpm install`, run the full test suite, commit on a
  branch, PR.

## Out of scope (confirm with the user before building)

- Streaks, leaderboards, or rich profiles. (Per-student attempt history **is** shipped —
  see "Progress tracking + roles" — but gamification beyond that is not.)
- Multi-child parent UI (the single-family linking seam is in place; the UI is not).
- Comments, social features, payments.
- An admin UI / content CMS (questions are edited in `src/lib/exam/data.ts`).
- OAuth providers (magic-link only, by design).
- Image uploads / asset pipeline; PDF parsing (questions are added by hand).

## Known platform notes

- Some sandbox environments block the Playwright browser CDN (`cdn.playwright.dev`) and
  Cloudflare's Turnstile siteverify endpoint. E2E runs cleanly in GitHub Actions — don't
  burn time trying to make Playwright run where the CDN is blocked.
- Next.js 16 + Turbopack is the build path; there is no MDX pipeline.
