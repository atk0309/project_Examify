# Examify

A calm, mobile-first, self-hosted **exam-practice app for families**. Pick a subject,
choose a difficulty, work a short mini exam one question at a time, and get encouraging
feedback at the end — mature, not babyish. Built by a parent for their kid(s); you run
your own instance, and your family's data stays on your own box.

It is intentionally small: a static question bank you edit in code, a four-screen client
flow, passwordless magic-link sign-in gated by a per-family allowlist, and a single
SQLite file. No SaaS, no tracking, no accounts beyond the family you configure.

## Features

- **Magic-link sign-in** (no passwords), role-aware (Student / Parent), protected by
  Cloudflare Turnstile and rate limiting, with no email enumeration.
- **Per-family privacy boundary** — a parent sees only their own child's progress, ever.
- **MCQ + free-text questions** — free-text answers are marked server-side by an LLM
  against a rubric you write, with a bounded, encouraging verdict.
- **Autosave + resume** — reload, close the browser, or lose the tab mid-exam and the
  dashboard offers a "Continue where you left off" card.
- **Progress tracking** — per-subject best / average / latest and a per-question review
  of every attempt.
- **Parent dashboard + student mode** — parents get a side-by-side comparison and an
  "Are you smarter than your kid?" button to take the exams themselves.
- **Three visual themes** (`paper`, `calm`, `focus`) on one token system.

## The flow

1. **`/signin`** — passwordless magic-link login. Pick a role (Student / Parent), enter
   your email, solve the Turnstile, and the app emails a one-time sign-in link **if the
   email is configured for that role** in `FAMILIES`.
2. **Dashboard** — a grid of subjects, each with a soft duotone icon and question count.
   The repo ships with a small hand-authored sample bank (Maths, Computer Science,
   Geography) that you're meant to replace with your own content — see
   [`docs/content-authoring.md`](docs/content-authoring.md).
3. **Difficulty** — Easy / Medium / Hard, one line each.
4. **Exam** — one question per screen, A–D choices or a free-text box, a progress bar. No
   per-question reveal. Your place is **autosaved**: if you reload, close the browser, or
   your phone discards the tab, the dashboard offers a **"Continue where you left off"**
   card to resume the exact exam at the question you'd reached.
5. **Results** — animated score ring, an encouraging verdict, a correct/to-review tally,
   and a full review. Free-text answers are marked server-side. Retry / Choose difficulty /
   Back.
6. **Your progress** — every finished exam is saved. The student gets a progress screen
   (per-subject best / average / latest + a list of recent attempts, each expandable to a
   per-question review).

### Progress tracking & roles

Completed attempts are persisted in the `exam_attempts` table (one row per exam, with a
per-question snapshot) via the `recordAttempt` server action. The score is **re-derived on
the server** from the submitted answers — the browser's total is never trusted.

**In-progress** exams are persisted too, in the `exam_sessions` table (one row per
user + subject + difficulty), so a closed browser or a discarded mobile tab can resume
instead of restarting. The exam autosaves as you answer (and on every Next/Back) via the
`saveExamProgress` action; finishing or discarding clears the draft. Only public question
ids and your own answers are stored — never the answer keys. These drafts never expire.

Roles diverge at `/`: a **student** gets the exam flow + their own progress; a **parent**
gets a dashboard with their child's progress, their own progress, and a side-by-side
comparison. A parent can tap **"Are you smarter than your kid?"** to enter
**student mode** and take the exams themselves — their attempts are tracked under the
parent's own account, so the child's record stays bound to the student no matter who is
signed in. Parent→child linking is per-family — each parent sees **only** the child in
their own family, derived from the `FAMILIES` config (a standalone child with no parents
appears in no dashboard at all).

> **Student mode runs the exact same exam code as the student** (same subjects,
> difficulties, and question bank). It is **not a frozen, identical paper**, though:
> `EXAM_CONFIG.shuffle` is `true`, so `buildExam()` reshuffles the bank with an unseeded
> `Math.random()` on **every** attempt — student and parent alike. Two sittings of the
> same subject/difficulty therefore get a different order (and a different subset, if the
> bank ever exceeds `EXAM_CONFIG.length`). For a literally identical parent-vs-child paper
> you'd seed `buildExam()` or set `shuffle: false`.

## Stack

| Layer       | Choice                                                                    |
| ----------- | ------------------------------------------------------------------------- |
| Runtime     | Node 22 LTS, pnpm 10                                                      |
| Framework   | Next.js 16 (App Router, Turbopack), React 19.2, TypeScript 6 strict       |
| Styling     | Tailwind v4 with a CSS-first `@theme` token system; 3 themes              |
| DB          | SQLite (a single file), via Drizzle ORM + better-sqlite3                  |
| Auth        | Magic-link (Resend) + iron-session cookies, **role-gated by env**         |
| Captcha     | Cloudflare Turnstile, server-verified on the login submit                 |
| Email       | Resend SDK, with a `tests/.tmp/outbox/*.json` short-circuit when key=test |
| Grading     | Anthropic Messages API (free-text), with a `test`-sentinel stub           |
| Tests       | Vitest (unit), Playwright (e2e)                                           |
| Lint/Format | ESLint 9 + Prettier + Tailwind plugin                                     |

## Quick start

```bash
pnpm install
cp .env.example .env        # dev defaults work out of the box
pnpm dev                    # http://localhost:3000  -> redirects to /signin
```

With `RESEND_API_KEY=test`, sign-in emails are written to `tests/.tmp/outbox/*.json`
instead of being sent — open the link inside to "click" the magic link locally. Only
emails configured in `FAMILIES` receive a link (the default dev value pairs the child
`student@example.com` with the parent `parent@example.com`). With
`ANTHROPIC_API_KEY=test`, free-text grading uses a deterministic local stub — no
network, no API key needed for development.

## Configuring your family (`FAMILIES`)

One JSON env var is the entire credential store **and** the privacy boundary — there is
no admin UI and no password. Each entry pairs one child with the parents allowed to see
their progress:

```json
[
  { "child": "alex@example.com", "parents": ["pat@example.com", "morgan@example.com"] },
  { "child": "sam@example.com", "parents": ["sam.parent@example.com"] },
  { "child": "jess@example.com", "parents": [] }
]
```

- Every `child` may sign in as a **student**; every email in any `parents[]` may sign in
  as a **parent**. Nobody else can sign in at all.
- A parent sees **only** the child of their own family. A standalone child
  (`"parents": []`) can practise but appears in no parent dashboard.
- Parsed **strictly at boot**: a duplicated child, an email used as both child and
  parent, or a parent shared across families is rejected with a readable error —
  ambiguity could leak one family's child into another's dashboard, so it fails instead.
- Fail-closed: empty/unset `FAMILIES` in production boots, but nobody can sign in.
- The sign-in screen always shows "Check your inbox" whether or not the email is
  configured (anti-enumeration) — a silent non-delivery usually means it isn't.

Set it as a single-line JSON string (see `.env.example` for the full commentary).

## Authoring content

The sample bank is a starter — the app is designed for you to swap in your own
questions. Content lives in two files keyed by a shared, globally-unique question `id`:

- **`src/lib/exam/data.ts`** — the public bank: `{ id, type: 'mcq', q, choices }` or
  `{ id, type: 'free', q }`. This ships to the browser, so it **never** carries an
  answer or rubric.
- **`src/lib/exam/answer-keys.server.ts`** — the server-only keys: the correct MCQ
  index, or the free-text `rubric` + `maxScore`, plus a mandatory `provenance` noting
  where each item came from.

`buildExam()` assembles each mini exam from the bank (`EXAM_CONFIG.length` caps the
paper, `shuffle` randomises order), and a unit-test guard enforces that the two files
stay in lockstep. The full guide — adding subjects and difficulties, writing rubrics the
LLM grader marks well, and a workflow for generating a question bank from your own
study-material PDFs — is in [`docs/content-authoring.md`](docs/content-authoring.md).

## Free-text grading

Free-text answers are graded server-side by the Anthropic Messages API
(`claude-sonnet-4-6`), strictly against the rubric you wrote for that question:

- Configure `ANTHROPIC_API_KEY`. The `test` sentinel (the dev default) swaps in a
  deterministic full-score stub with no network calls — the same pattern as the Resend
  email outbox.
- Grading is **fail-safe**: requests have a 15-second deadline, and any timeout, network
  error, non-2xx, or malformed model output resolves to `needs_review` instead of throwing,
  so a finished exam is never lost. A `needs_review` item renders as "Saved for review" and
  counts as incorrect.
- A free-text item counts as "correct" when the score reaches **60%** of `maxScore`
  (`PASS_THRESHOLD` in `src/lib/exam/attempts.ts`).
- The UI renders only the bounded verdict (score, one-line feedback, got-right /
  to-review / spelling lists) — never the rubric, never raw model text.

## Themes

`data-theme` on `<html>` selects the mood: `paper` (default warm cream), `calm`
(cool neutral), `focus` (dark). Each theme only redefines the surface/text/border/
shadow tokens, so every component re-tones for free. Per-subject accents are OKLCH and
applied at runtime via `accentCSS()`.

## Commands

| Command            | What it does                                       |
| ------------------ | -------------------------------------------------- |
| `pnpm dev`         | Dev server (Turbopack)                             |
| `pnpm build`       | Production build                                   |
| `pnpm start`       | Run the production build (`PORT` defaults to 3000) |
| `pnpm lint`        | ESLint                                             |
| `pnpm typecheck`   | `tsc --noEmit`                                     |
| `pnpm format`      | Prettier write                                     |
| `pnpm test`        | Vitest unit suite                                  |
| `pnpm test:e2e`    | Playwright e2e (needs `pnpm test:e2e:install`)     |
| `pnpm db:generate` | Generate a Drizzle migration from schema diffs     |
| `pnpm db:migrate`  | Apply pending migrations to `DATABASE_URL`         |

## Environment

Defined and validated by zod in `src/lib/env.ts`; the canonical reference is
`.env.example`. Required in production: `SITE_URL`, `AUTH_SECRET`, `DATABASE_URL`,
`FAMILIES` (the single JSON sign-in + visibility config), `RESEND_API_KEY`, `RESEND_FROM`,
`ANTHROPIC_API_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`. Env
validation **fails closed** in production — a missing required var crashes boot (so your
platform's healthcheck catches it); an empty `FAMILIES` boots but lets nobody sign in,
while malformed `FAMILIES` JSON crashes boot.

## Deploy

Examify is a standard Next.js server + one SQLite file — anywhere Node 22 runs works:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate && pnpm start    # run migrations at startup, then serve
```

Point `DATABASE_URL` at a file on **persistent storage** so the database survives
deploys, set the required env vars above, and healthcheck `GET /api/health`.

On hosts with ephemeral filesystems, mount persistent storage (for example at `/data`)
and set `DATABASE_URL=file:/data/app.db`.

## Testing

`pnpm test` runs the Vitest unit suite (content guards, scoring, grading, auth, actions)
against an isolated SQLite file. `pnpm test:e2e` runs Playwright smokes for the public
routes plus the magic-link happy path, uniform sign-in rate limit, and empty-token
failure path (run `pnpm test:e2e:install` once first). The sign-in tests use Cloudflare's
documented always-pass dummy keys; server-side Turnstile verification still runs.

## Contributing, security, license

- Contributions welcome — start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and
  [`SUPPORT.md`](SUPPORT.md), and follow the
  [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Architecture and invariants live in
  [`CLAUDE.md`](CLAUDE.md) (also the working agreement for AI coding agents, paired with
  [`AGENTS.md`](AGENTS.md)).
- Found a vulnerability? Please report it privately — see [`SECURITY.md`](SECURITY.md).
- [MIT](LICENSE).
