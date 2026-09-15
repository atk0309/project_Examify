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
small: a static question bank, a four-screen client flow, host-picked sign-in
(`password`, `magic-link`, or `local-otp`) gated by invite-only households in SQLite,
and a single file on runtime-mounted persistent storage.

Surface:

- **`/`** — the app. A server gate: no session → redirect to `/signin`. A `student`
  session renders the client `ExamApp` (dashboard → difficulty → exam → results, plus
  a "Your progress" screen); a `parent` session renders `ParentDashboard` (the child's
  progress, the parent's own progress, and a parent-vs-child comparison). A parent can
  enter **student mode** ("Are you smarter than your kid?") to get the full
  `ExamApp` themselves; their attempts persist under the parent's own account, never the
  child's.
- **`/setup`** — first-run household bootstrap (only when no household exists).
- **`/onboarding`** — post-bootstrap content wizard (household **admin** only, while
  `onboarding_complete` is false). Welcome → subjects → PDF dropzones → AI setup
  (optional `examify-ingest generate` after files + mode) → validate → Review
  (dry-run HITL) → apply → ready. The wizard is one stage at a time: desktop
  (≥900px) uses a left step rail + stage + sticky footer; mobile uses compact
  “Step N of M · Label” progress and a sticky bottom bar. Generate writes BankIR
  only and never auto-applies.
  Cancel discards an in-flight preview and does not replace prior IR; generate
  is gated to wizard catalog subjects (`listOnboardingSubjects`).
  Finish (“Open dashboard”) requires
  a confirmed apply of that dry-run; a changed plan is refused (`stale_preview`).
  Skip-without-emit is Welcome “Use sample bank for now” / later “Skip to
  dashboard” — same skip semantics, sample bank stays usable, parent-dashboard
  “Finish content setup” chip remains. Invited students and parents never see
  it. Directory-only `examify-ingest` emit (dry-run before apply, empty catalog
  refused). Delete removes IR/source dirs only; prune of leftover generated JSON
  waits for confirmed directory apply (#62). Not a replacement for `install.sh`
  auth-mode picking. Existing households are backfilled complete.
  `/setup/wizard` redirects here.
- **`/invite/[token]`** — accept a household invite (password, magic-link, or local OTP).
  In `AUTH_MODE=password` the URL is a secret that starts a join; membership and
  `emailVerifiedAt` wait for a mailbox OTP (`completePasswordInvite`). Fail closed
  if mail cannot be delivered. See `SECURITY.md`.
- **`/signin`** — sign-in UI for the configured `AUTH_MODE` (password, magic-link, or
  local OTP) with a Student/Parent role control. Redirects to
  `/setup` when the instance has no household yet.
- **`/signin/verify`** — a **Route Handler** (`route.ts`, not a page): consumes the one-time
  token, establishes the session, redirects to `/`. It must be a route handler because
  clicking the email link is a GET that **writes** the session cookie, and cookie mutation is
  illegal during a Server Component render (Next.js 16). Failures redirect to its sibling page.
  **Magic-link only:** the handler and `consumeMagicToken` refuse the consume when
  `AUTH_MODE !== 'magic-link'`, and they refuse `otp:` bearers (local OTP is
  `verifyLocalOtp` only, with the 5-guess lock). Leftover magic-link tokens are
  ignored after a mode switch.
- **`/signin/verify/error`** — a read-only page that renders the human-readable failure copy
  for an invalid/expired/used/missing token, keyed off a `?reason=` query param.
- **`/signin/invalidate`** — a **Route Handler** that destroys a stale session cookie
  and redirects to `/signin`. `getSession` sends the browser here when membership
  no longer matches (cookie writes are illegal in a Server Component render).
- **`/api/health`** — lightweight platform healthcheck.
- **`/robots.txt`** — disallow-all (this is a private, allowlisted app).

There is **no blog, no MDX, no admin panel, no public marketing page** — the first screen
is the usable login, and the screen after it is the usable dashboard.

## Stack and pinned versions

Latest stable of each, exact-pinned in `package.json` (no `^`/`~`). Bumps land via the
grouped weekly Dependabot PRs in `.github/dependabot.yml`.

| Layer       | Choice                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Runtime     | Node 22 LTS (`>=22.22.2 <23`, `.nvmrc`), pnpm 10                                                  |
| Framework   | Next.js 16 (App Router, Turbopack), React 19.2, TypeScript 6 strict                               |
| Styling     | Tailwind v4 with a CSS-first `@theme` token block, three `data-theme` moods                       |
| DB          | SQLite on runtime-mounted storage, accessed through Drizzle + better-sqlite3                      |
| Auth        | Host-picked mode (`password` / `magic-link` / `local-otp`) + iron-session, invite-only households |
| Captcha     | Optional Cloudflare Turnstile (off when keys unset; server-verified when set)                     |
| Email       | Resend, SMTP, or local outbox (`MAIL_TRANSPORT`); outbox gated in production                      |
| Tests       | Vitest (unit), Playwright (e2e), Cloudflare dummy test keys                                       |
| Lint/Format | ESLint 9.39 (Next 16 plugin set) + Prettier + Tailwind plugin                                     |

**Why ESLint 9, not 10?** `eslint-plugin-react@7.x` doesn't support ESLint 10 yet, and
`eslint-config-next@16` pulls it in transitively. Move both together later.

## Commands cheat-sheet

| Command               | What it does                                               |
| --------------------- | ---------------------------------------------------------- |
| `pnpm dev`            | Next.js dev server with Turbopack                          |
| `pnpm build`          | Production build                                           |
| `pnpm start`          | Run the production build (`PORT` defaults to 3000)         |
| `pnpm lint`           | ESLint flat-config across the repo                         |
| `pnpm format`         | Prettier write                                             |
| `pnpm format:check`   | Prettier dry-run (CI guard)                                |
| `pnpm typecheck`      | `tsc --noEmit`                                             |
| `pnpm test`           | Vitest unit suite                                          |
| `pnpm test:e2e`       | Playwright e2e (`pnpm build` then both suites)             |
| `pnpm db:generate`    | Generate a new Drizzle migration from schema diffs         |
| `pnpm db:migrate`     | Apply pending migrations to `DATABASE_URL`                 |
| `pnpm db:studio`      | Drizzle Studio against the local DB                        |
| `pnpm examify-ingest` | Generate / validate / emit BankIR (`tools/examify-ingest`) |
| `./install.sh`        | Interactive self-host install (env + migrate + build)      |

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
    setup/              # household bootstrap (page); leftover /setup/wizard → /onboarding
    onboarding/         # admin-only content wizard (BankIR validate / dry-run / apply)
    signin/             # login (page); magic-link verify (route.ts) + verify/error (page)
    page.tsx            # auth gate -> ExamApp
    layout.tsx          # fonts (Newsreader + Hanken Grotesk via <link>), data-theme
    globals.css         # Tailwind @theme tokens + component layer
    robots.ts           # disallow-all
  actions/              # 'use server' actions (requestMagicLink, signInWithPassword,
                        #   verifyLocalOtp, acceptInviteWithPassword, completePasswordInvite,
                        #   bootstrapHousehold,
                        #   onboarding (subjects/PDFs/AI mode + generate + ingest validate/dry-run/apply),
                        #   createInvite / revokeInvite / requestInviteLink, signOut,
                        #   recordAttempt, saveExamProgress + discardExamSession)
  components/
    exam/               # ExamApp (flow), ProgressView, ParentDashboard, OnboardingWizard, LoginForm, icons
    analytics/          # Plausible (opt-in)
  lib/
    exam/data.ts        # SAMPLE + generated SUBJECTS/QUESTIONS + accentCSS + buildExam
    exam/attempts.ts    # validate + re-score a submitted attempt; aggregate helpers (pure)
    progress.ts         # persist/read attempts; resolveChildren(parentEmail) per-family (server-only)
    exam-session.ts     # save/list/clear an in-progress exam for resume (server-only)
    households.ts       # bootstrap, invites, membership, optional FAMILIES import (server-only)
    household-types.ts  # client-safe PendingInvite type
    onboarding.ts       # first-run subjects/PDFs + examify-ingest emit (server-only)
    onboarding-generate.ts # AI-step generateSubject bridge (preview then commit if !cancelled)
    onboarding-types.ts # client-safe wizard snapshot / AI mode types
    families.ts         # leftover FAMILIES JSON parser (optional one-shot import only)
    allowlist.ts        # isAllowedEmail(role,email), derived from household membership
    auth-mode.ts        # AUTH_MODE types + helpers (password / magic-link / local-otp)
    password.ts         # scrypt hash/verify (server); password-policy.ts is client-safe
    auth.ts, db/, email/, captcha.ts, ip.ts, rate-limit.ts, env.ts, site.ts
tests/
  unit/                 # vitest specs
  e2e/                  # playwright specs (setup-db.ts runs pre-Playwright)
  stubs/                # vitest-only stubs (e.g. server-only no-op)
tools/
  examify-ingest/       # BankIR generate + validate + emit (generate writes IR only)
content/
  subjects/             # BankIR sources (*/bank.ir.json)
  generated/            # public subjects/questions + server-only keys (committed)
  source-pdfs/          # gitignored local PDFs
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
5 MCQ + 1–2 free-text per difficulty) plus an additive **Biology** example emitted
from `content/subjects/biology/bank.ir.json`. `docs/content-authoring.md` is the
full guide: question/key formats, rubric style, the `examify-ingest` generate →
validate → emit path, adding subjects (all 13 original duotone icons remain in
`icons.tsx`, reusable), and the vision-first workflow for generating a grounded
bank from source PDFs kept local-only in the gitignored `content/source-pdfs/`.

Automated path: author or `pnpm examify-ingest generate` a
`content/subjects/<id>/bank.ir.json`, then `pnpm examify-ingest validate`,
`emit --dry-run`, and only afterward `emit --apply`
(or use `/onboarding` after first-run bootstrap — AI-step generate is optional,
then the same directory emit, HITL dry-run before apply, empty tree refused).
Generate never auto-applies; it writes IR + gitignored `.examify-ingest/`
run/cache files only. Cloud
providers fail closed without an env key (generate also fills unset keys from
repo `.env` / `.env.local`); `--provider test` is the CI
fixture. OpenAI-compatible generate fails closed when the only sources are
PDFs and no page images were rasterized. `emit` is dry-run by default;
`--apply` writes `content/generated/` (public
subjects/questions + server-only keys). The running app reads that JSON at
request time (`src/lib/exam/live-bank.server.ts`) and merges it onto the
sample bank, so Apply → dashboard shows new subjects without a rebuild.
Registrars (`generated-public.ts` / `generated-keys.server.ts`) stay as the
committed / missing-catalog fallback. Keys stay server-only. Any id already in
the sample bank is refused unless
`--replace-sample`. A partial emit (explicit IR files or mixed file+directory
argv) merges `subjects.json` by id and leaves other generated subject files in
place. A whole-tree emit of subjects directories only (`content/subjects`) is
authoritative for generated subjects: leftover `questions/<id>.json` /
`keys/<id>.json` (and the `subjects.json` row) for an id with no IR in that
tree are deleted. `--apply` rewrites catalog and registrars before unlinking
leftovers. The sample bank is never touched.

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

- **Roles come from household membership.** SQLite tables `households`,
  `household_members`, and `household_invites` are the credential store. An email
  may request a magic link for a role only if they belong to a household in that
  role (`isAllowedEmail` → `isHouseholdEmailAllowed`). Session roles stay
  `student | parent`; household `admin` is a membership flag on the first-run host
  (they sign in as a parent). Auth _method_ is `AUTH_MODE` (`password`,
  `magic-link`, or `local-otp`); membership is still the access boundary. A leftover `FAMILIES` env JSON
  is imported **once** when the DB has no households (`importLegacyFamiliesIfNeeded`);
  it is not required. Set-but-invalid JSON **crashes production boot**. Entries
  with `parents: []` parse (legacy standalone child) but are **skipped** on import
  so we never create an unadministrable household.
- **Password-mode invite accept requires mailbox proof.** `/invite/<token>` is a
  secret that starts a join. `acceptInviteWithPassword` issues a one-time code
  (local OTP + mail transport); `completePasswordInvite` consumes it, attaches
  membership, stamps `emailVerifiedAt`, and stores the password hash. Email-lock
  only chooses which mailbox we send to. Missing mail transport fails closed
  (`send_failed`) instead of trusting the URL. Parent invites stay email-locked;
  do not post links publicly. See `SECURITY.md`.
- **No enumeration.** Challenge modes (`magic-link`, `local-otp`): `requestMagicLink`
  always returns the generic `sent` state once Turnstile (when enabled) + rate-limit
  pass; it only issues a link/code when the email is a household member for that
  role. Don't add a branch that reveals whether an email has been invited —
  including delivery failure (log server-side, still return `sent`). Email-locked
  invites use the same generic `sent` copy when the address does not match.
  Password mode: `signInWithPassword` always returns generic `invalid` for unknown
  email, wrong password, wrong role, or a user with no hash (after a dummy scrypt).
- **The "sent" screen resets via client state, not navigation.** `LoginForm` lives on
  `/signin`, so "Use a different email" can't be a `<Link href="/signin">` — that's a
  same-route soft nav that never remounts the component, leaving `useActionState` at
  `status: 'sent'` (the button looked dead). It toggles a local `dismissed` flag back to
  the form; the `submit` wrapper clears `dismissed` so a fresh send re-shows the screen.
- Turnstile is **never** bypassed server-side **when either key is set**. Both
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` must be present to
  enable captcha; when both are unset, the widget is omitted and `verifyTurnstile`
  returns ok. Exactly one key in production crashes boot. When either key is set,
  `verifyTurnstile()` never short-circuits to ok (partial config fails closed).
  The login / setup / invite-accept actions still call `verifyTurnstile()` with
  the client's token before issuing anything.
- IP extraction always goes through `src/lib/ip.ts`, which prefers `cf-connecting-ip` →
  `x-real-ip` → the **last** entry of `x-forwarded-for`. The first XFF entry is
  client-controllable; don't read `x-forwarded-for` directly in handlers.
- Rate-limit windows are tracked in `rate_limit_events`. Sign-in uses a **single**
  `signin` bucket (10/IP/hour by default) for every request, regardless of whether a user
  row exists — a per-state threshold would leak whether an email is a returning/approved
  user even behind the generic "sent" copy. Don't split it back into signup/login.
  Local OTP also records well-formed wrong 6-digit guesses under a synthetic
  `ip` of `otp:{email}:{role}` (same table, no migration). After 5 failures the
  outstanding challenge is consumed. Non-6-digit input does not count.
- `/setup` (`bootstrapHouseholdAction`) may do the cheap password-policy check
  early, but `hashPassword` (scrypt) runs only after Turnstile, the sign-in
  rate-limit, and `SETUP_BOOTSTRAP_SECRET` all pass.
- Magic-link tokens are stored **hashed** at rest (`sha256`), single-use (a `consumed_at`
  timestamp marks them spent inside the same transaction that resolves the user), and 15
  minutes long. The token carries the **role** so verify can set `session.role` without
  re-checking env. `/signin/verify` and `consumeMagicToken` only succeed when
  `AUTH_MODE` is `magic-link`. They refuse `otp:` bearers (those are
  `verifyLocalOtp` only). After a mode switch, leftover magic-link tokens are
  ignored, not consumed.
- Sessions store `{ userId, role, email, studentMode? }` (`role` is `student | parent`).
  `studentMode` is parent-only: when `true`, a parent gets the full `ExamApp` (the "Are you
  smarter than your kid?" flow). It's set by `setStudentMode`
  (`src/actions/toggleStudentMode.ts`, parent-only) and **reset to `false` on every verified
  sign-in** (`/signin/verify`), so a returning parent always lands on the dashboard. `signOut`
  (`src/actions/signOut.ts`) destroys the session and returns to `/signin`.
  `getSession` re-checks household membership + role on every load; a removed
  member (or role mismatch) redirects to `/signin/invalidate` so the sealed
  cookie is actually cleared. Verify/bootstrap write via `getRawSession` so a
  stale cookie cannot intercept a new sign-in. Parents/admins can remove members
  via `removeMember` (cannot remove self or the household admin).

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
- **The child stays bound to their household.** A parent's child is resolved from
  household membership via `resolveChildren(parentEmail)`, independent of who is
  signed in. A parent playing in student mode never reassigns the child's attempts —
  ownership is structural (`user_id`), so the child's record is sacrosanct. Existing
  progress survives a leftover `FAMILIES` import as long as the child's email matches
  an existing `users.email` — never rewrite `exam_attempts` / `exam_sessions`.
- **Linking is per-household (the privacy boundary).** `resolveChildren(parentEmail)`
  (`src/lib/progress.ts`) returns student members of the same household — and
  **nothing else**. A parent sees only their own household's child; a student with no
  parent/admin in that household never surfaces in any parent dashboard; one household
  can never see another's. This is the one read path that crosses user ids, so keep it
  isolated. `page.tsx` passes every student from `resolveChildren()`; the parent
  dashboard lists each child's progress and compares against a selected student.
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
`DATABASE_URL`, etc. crashes boot with a readable zod error (and fails the platform
healthcheck). Don't add dev defaults to security-critical vars without weighing that.
Access is DB-backed: empty households fail closed (nobody can sign in until `/setup`
or a leftover `FAMILIES` import). A leftover `FAMILIES` value that is set but
unparsable **crashes production boot**. `/setup` itself is gated by
`SETUP_BOOTSTRAP_SECRET` (required in production, min 16, not a documented
placeholder); captcha is not identity. Documented placeholder `AUTH_SECRET` /
`SETUP_BOOTSTRAP_SECRET` values also fail production boot.

Required in production: `SITE_URL`, `AUTH_SECRET`, `DATABASE_URL`, `ANTHROPIC_API_KEY`,
`SETUP_BOOTSTRAP_SECRET`. `AUTH_MODE` defaults to `magic-link` (existing #56 hosts
keep working). `password` sign-in needs no mail; password-mode invite accept
sends a mailbox OTP and fails closed without a transport. `local-otp` in production requires
`ALLOW_LOCAL_OUTBOX=1`. `MAIL_TRANSPORT` is `auto` (SMTP if `SMTP_HOST`, else
Resend if a real key, else outbox). Explicit `MAIL_TRANSPORT=smtp` needs
`SMTP_HOST` + `SMTP_FROM`; `auto` + `SMTP_HOST` also needs `SMTP_FROM`. A
leftover `SMTP_HOST` does not fail `resend` / `outbox`. SMTP AUTH/DATA on a
connection that never upgraded to TLS is refused unless `SMTP_ALLOW_INSECURE=1`.
`resend` needs a real key + `RESEND_FROM`; `outbox`
in production needs `ALLOW_LOCAL_OUTBOX=1`. Production with no real mail
transport does not write bearer tokens to `data/outbox` unless
`ALLOW_LOCAL_OUTBOX=1`. Turnstile keys are optional (both unset →
captcha off; exactly one key in production crashes boot).
The OTP step after a `sent` screen mounts Turnstile with an explicit
`turnstile.render()` (`ExplicitTurnstile`) because the implicit scanner
already ran on the first form.
`ANTHROPIC_API_KEY` still fails closed in prod when missing; the `test` sentinel
routes the grader to a deterministic stub. See `.env.example` for the canonical list.

## Testing rules

- Every public page route gets a Playwright smoke in `tests/e2e/pages.spec.ts` and is
  covered by the internal link-crawl in `tests/e2e/links.spec.ts`.
- Every server action / route handler that mutates state has at least one happy + one
  failure path test.
- Lib helpers (`src/lib/*`) get Vitest unit tests against fixtures, not the app server.
- Cloudflare Turnstile is optional. Dummy keys: `1x00000000000000000000AA` / `1x00…AA`
  always pass; `2x00000000000000000000AB` / `2x00…AA` always fail. Tests inject
  `cf-turnstile-response="test-bypass-token"` when the widget is rendered but its
  CDN can't load. When keys are unset, the widget is omitted and submit works
  without a token.
- The Playwright config uses an isolated SQLite at `tests/.tmp/e2e.db`;
  `tests/e2e/setup-db.ts` wipes and re-migrates it via `pnpm test:e2e:prepare`, which
  `pnpm test:e2e` runs _before_ `pnpm build` and `playwright test`. Both Playwright
  configs require an existing `.next` (they start with `next start`; they do not
  create the production build).
- Default sign-in e2e uses the documented always-pass Turnstile dummy key. The widget
  owns the single `cf-turnstile-response` field when captcha is on; never add a second
  fallback field with that name. When the widget CDN is unavailable, the Playwright
  helper injects that same field and submits it in one browser task. A second
  Playwright config (`playwright.fresh.config.ts`) covers first-run bootstrap and
  Turnstile-off sign-in. Happy-path, invite accept, uniform rate-limit, and
  empty-token (captcha on) coverage all run without bypassing `verifyTurnstile`
  when it is enabled.

## Dependency policy

- Exact versions in `package.json`. No `^`, no `~`.
- Bumps land via grouped Dependabot PRs weekly.
- Manual upgrades: bump, re-run `pnpm install`, run the full test suite, commit on a
  branch, PR.

## Out of scope (confirm with the user before building)

- Streaks, leaderboards, or rich profiles. (Per-student attempt history **is** shipped —
  see "Progress tracking + roles" — but gamification beyond that is not.)
- Extra per-child settings / profiles. The parent dashboard already lists every
  household student and compares against a selected child.
- Comments, social features, payments.
- An admin UI / content CMS (questions are edited in `src/lib/exam/data.ts`).
- OAuth providers (password / magic-link / local-otp only, by design).
- Image uploads / asset pipeline; PDF parsing (questions are added by hand).

## Known platform notes

- Some sandbox environments block the Playwright browser CDN (`cdn.playwright.dev`) and
  Cloudflare's Turnstile siteverify endpoint. E2E runs cleanly in GitHub Actions — don't
  burn time trying to make Playwright run where the CDN is blocked.
- Next.js 16 + Turbopack is the build path; there is no MDX pipeline.
