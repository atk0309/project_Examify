# Examify

A calm, mobile-first, self-hosted **exam-practice app for families**. Pick a subject,
choose a difficulty, work a short mini exam one question at a time, and get encouraging
feedback at the end — mature, not babyish. Built by a parent for their kid(s); you run
your own instance, and your family's data stays on your own box.

It is intentionally small: a static question bank you edit in code, a four-screen client
flow, host-picked sign-in (`password`, `magic-link`, or `local-otp`) gated by
**invite-only households** in SQLite, and a single SQLite file. No SaaS, no tracking,
no env-JSON allowlist to hand-edit.

## Features

- **Host-picked auth** — password (no email service), magic-link (Resend / SMTP /
  local outbox), or a local one-time code for tiny installs. Role-aware
  (Student / Parent), rate-limited, no membership enumeration. Cloudflare
  Turnstile is **optional**.
- **Invite-only households** — first-run bootstrap creates the admin; parents invite
  students and other parents with a link. A parent sees only their own household's
  child(ren).
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

1. **`/setup`** (first run) or **`/signin`** — on a fresh install, the first visitor
   creates the household and becomes admin (and sets a password when `AUTH_MODE=password`).
   After bootstrap, **`/onboarding`** lets the household admin add subjects, attach
   local study PDFs, choose an AI mode, optionally generate BankIR from those
   files, and emit through `examify-ingest` (validate + dry-run HITL, then apply;
   generate never auto-applies; cancel discards an in-flight preview and does
   not replace prior IR; generate is gated to wizard catalog subjects; an empty
   catalog is refused; a changed plan after dry-run is refused). Finish requires
   that confirmed apply; skip-without-emit keeps the sample bank.
   Bootstrap signs in the first household administrator and redirects to
   `/onboarding`. After onboarding, invited users join through `/invite/…` and
   authenticate in the configured mode. Later visits use `/signin`.
2. **Dashboard** — a grid of subjects, each with a soft duotone icon and question count.
   The repo ships with a small hand-authored sample bank (Maths, Computer Science,
   Geography) plus an additive Biology example from BankIR — see
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
signed in. Parent→child linking is per-household — each parent sees **only** the
student(s) in their own household. A student with no parent/admin in that household
appears in no dashboard.

> **Student mode runs the exact same exam code as the student** (same subjects,
> difficulties, and question bank). It is **not a frozen, identical paper**, though:
> `EXAM_CONFIG.shuffle` is `true`, so `buildExam()` reshuffles the bank with an unseeded
> `Math.random()` on **every** attempt — student and parent alike. Two sittings of the
> same subject/difficulty therefore get a different order (and a different subset, if the
> bank ever exceeds `EXAM_CONFIG.length`). For a literally identical parent-vs-child paper
> you'd seed `buildExam()` or set `shuffle: false`.

## Stack

| Layer       | Choice                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------- |
| Runtime     | Node 22 LTS (`>=22.22.2 <23`), pnpm 10                                                    |
| Framework   | Next.js 16 (App Router, Turbopack), React 19.2, TypeScript 6 strict                       |
| Styling     | Tailwind v4 with a CSS-first `@theme` token system; 3 themes                              |
| DB          | SQLite (a single file), via Drizzle ORM + better-sqlite3                                  |
| Auth        | `AUTH_MODE`: password / magic-link / local-otp + iron-session, **invite-only households** |
| Captcha     | Optional Cloudflare Turnstile (off when keys are unset)                                   |
| Email       | Resend, SMTP, or local outbox (`MAIL_TRANSPORT`)                                          |
| Grading     | Anthropic Messages API (free-text), with a `test`-sentinel stub                           |
| Tests       | Vitest (unit), Playwright (e2e)                                                           |
| Lint/Format | ESLint 9 + Prettier + Tailwind plugin                                                     |

## Quick start

### Installer (recommended)

`install.sh` asks a few questions (site URL, secrets, auth mode, optional
Turnstile and email), writes `.env`, installs, migrates, and builds:

```bash
curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash
```

From a clone: `./install.sh`. Non-interactive: `EXAMIFY_NONINTERACTIVE=1 ./install.sh`
(defaults to `AUTH_MODE=password` unless you set the env vars yourself).

Then `pnpm start` (or `pnpm dev`), open `SITE_URL`, and complete **`/setup`**
with the printed setup code.

### Manual (developers)

```bash
pnpm install
cp .env.example .env        # AUTH_MODE=magic-link; dev defaults work
pnpm dev                    # http://localhost:3000  -> /setup on a fresh DB
```

With `RESEND_API_KEY=test`, magic-link / OTP messages are written to a local
outbox (`MAIL_OUTBOX_DIR` if set, otherwise `tests/.tmp/outbox/*.json`). On a
fresh database, visit `/setup`, enter the setup code (`SETUP_BOOTSTRAP_SECRET`;
the dev default works locally), and create the first household. Invite the
student from the dashboard. With `ANTHROPIC_API_KEY=test`, free-text grading
uses a deterministic local stub — no network, no API key needed for development.

Set `AUTH_MODE=password` in `.env` if you want to develop without mail.

## Access: invite-only households

Who may sign in is stored in SQLite, not env:

1. **First run** — `/setup` creates the household and the admin (a parent). You must
   enter the deployment `SETUP_BOOTSTRAP_SECRET` (required in production). No email
   round-trip; you are at the keyboard.
2. **Invite** — from the parent dashboard, create a student invite (open or
   email-locked) or a parent invite (**email-locked**). Share `/invite/<token>`.
   Revoke unused links; remove a member if they should no longer have access.
   When `AUTH_MODE=password`, that URL is a **secret**: it starts a join
   but does not complete it. The invitee must enter a one-time code sent
   to their email before membership and `emailVerifiedAt` are set. An
   email lock only chooses which mailbox we send to (not mailbox proof
   by itself). An open student link lets anyone with the URL start a
   join for an email they control. If no mail transport (or allowed
   outbox) is configured, accept fails closed. Prefer email-lock
   (already required for parents); never post links publicly. See
   [`SECURITY.md`](SECURITY.md).
3. **Accept** — the invitee opens `/invite/<token>` and finishes in the configured
   auth mode (set a password then enter the mailbox code, click a magic link, or
   enter a local OTP). Success signs them in and opens the app at `/`. Later
   visits use `/signin`.
4. **Privacy** — a parent/admin only sees students who share their household. One
   household cannot see another.

Challenge modes always show a generic "sent" / "enter your code" screen whether or
not the email is a member (anti-enumeration), including when delivery fails
(logged server-side). Password mode always shows a generic "email or password is
incorrect" error. A silent non-delivery usually means they have not been invited
yet, or mail could not be sent.

### Auth modes

| `AUTH_MODE`  | Sign-in                                  | Mail required                         |
| ------------ | ---------------------------------------- | ------------------------------------- |
| `password`   | Email + password                         | Sign-in: no. Invite accept: yes (OTP) |
| `magic-link` | One-time URL (Resend, SMTP, or outbox)   | Yes, unless outbox opt-in             |
| `local-otp`  | 6-digit code (outbox, or emailed if set) | Production: `ALLOW_LOCAL_OUTBOX=1`    |

`MAIL_TRANSPORT=auto` picks SMTP when `SMTP_HOST` is set, else Resend when a real
key is set, else the local outbox. `SMTP_FROM` is required only when SMTP is the
active transport. A leftover `SMTP_HOST` does not fail `resend` / `outbox`.
Plaintext SMTP (no STARTTLS / `SMTP_SECURE`) needs `SMTP_ALLOW_INSECURE=1`.
Hosts already on invite-only households (#56)
keep working: unset `AUTH_MODE` is `magic-link`. Run `pnpm db:migrate` for the
nullable `users.password_hash` column (safe no-op for magic-link-only hosts).

### Migrating from `FAMILIES` env JSON

Older deploys used a `FAMILIES='[{ "child", "parents" }]'` env var. That is **no longer
required**. If the variable is still set and the database has no households yet, the
first request imports it once (one household per family that lists at least one
parent; the first parent becomes admin). Entries with `parents: []` are skipped —
they would create a household nobody can administer; invite that student later.
After a successful import, remove `FAMILIES` from the host. If `FAMILIES` is
set but unparsable, production boot fails — fix the JSON or unset it. New installs
should leave it unset and use `/setup`.

Turnstile is optional: leave `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
unset to skip the captcha. When both are set, sign-in / setup / invite accept verify the
token on the server. Setting exactly one key in production crashes boot so verify cannot
be silently disabled.

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
stay in lockstep. You can also author `content/subjects/<id>/bank.ir.json` (by
hand or `pnpm examify-ingest generate`) and emit the split with
`pnpm examify-ingest emit content/subjects --dry-run` (or `--apply` to write
`content/generated/`). Generate writes IR only — still validate, dry-run, then
`--apply`. The full guide — adding subjects and difficulties, writing
rubrics the LLM grader marks well, the ingest CLI, and a workflow for
generating a question bank from your own study-material PDFs — is in
[`docs/content-authoring.md`](docs/content-authoring.md) and
[`tools/examify-ingest/README.md`](tools/examify-ingest/README.md).

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

| Command               | What it does                                               |
| --------------------- | ---------------------------------------------------------- |
| `pnpm dev`            | Dev server (Turbopack)                                     |
| `pnpm build`          | Production build                                           |
| `pnpm start`          | Run the production build (`PORT` defaults to 3000)         |
| `pnpm lint`           | ESLint                                                     |
| `pnpm typecheck`      | `tsc --noEmit`                                             |
| `pnpm format`         | Prettier write                                             |
| `pnpm test`           | Vitest unit suite                                          |
| `pnpm test:e2e`       | Playwright e2e (needs `pnpm test:e2e:install`)             |
| `pnpm db:generate`    | Generate a Drizzle migration from schema diffs             |
| `pnpm db:migrate`     | Apply pending migrations to `DATABASE_URL`                 |
| `pnpm examify-ingest` | Generate / validate / emit BankIR (`tools/examify-ingest`) |

## Environment

Defined and validated by zod in `src/lib/env.ts`; the canonical reference is
`.env.example`. Required in production: `SITE_URL`, `AUTH_SECRET`, `DATABASE_URL`,
`ANTHROPIC_API_KEY`, `SETUP_BOOTSTRAP_SECRET`. `AUTH_MODE` defaults to
`magic-link`. Documented placeholder `AUTH_SECRET` / `SETUP_BOOTSTRAP_SECRET`
values fail production boot. A leftover `FAMILIES` value that is set but invalid
also crashes production boot. Mail is optional when `AUTH_MODE=password`.
`MAIL_TRANSPORT=auto` (default) uses SMTP, Resend, or the outbox depending on
what is set. Production with no real mail transport does not write tokens to
disk unless `ALLOW_LOCAL_OUTBOX=1`. `local-otp` and explicit `outbox` require
that opt-in in production. A real Resend key **requires** `RESEND_FROM`.
Turnstile keys are optional when **both** are unset; exactly one key in
production crashes boot. Env validation **fails closed** in production for the
required vars. Access is empty-fail-closed: until someone completes `/setup`
with the bootstrap secret (or a leftover `FAMILIES` import runs), nobody can
sign in.

## Deploy

Anywhere Node 22.22.2+ runs. The installer is the supported path:

```bash
curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash
# then: pnpm start   and open SITE_URL/setup
```

Or the manual equivalent:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate && pnpm start    # run migrations at startup, then serve
```

Point `DATABASE_URL` at a file on **persistent storage** so the database survives
deploys, set the required env vars above (`AUTH_MODE` included), and healthcheck
`GET /api/health`.

On hosts with ephemeral filesystems, mount persistent storage (for example at `/data`)
and set `DATABASE_URL=file:/data/app.db`.

## Testing

`pnpm test` runs the Vitest unit suite (content guards, scoring, grading, auth, actions)
against an isolated SQLite file. `pnpm test:e2e` builds the app (`pnpm build`) then runs Playwright smokes for the
public routes plus the magic-link happy path, invite accept, first-run bootstrap
(Turnstile off), uniform sign-in rate limit, and empty-token failure path when
captcha is on (run `pnpm test:e2e:install` once first). Both suites require that
production `.next` — they start with `next start` and do not create it. The
default e2e server uses Cloudflare's always-pass dummy keys; a second fresh-DB
run covers Turnstile unset.

## Contributing, security, license

- Contributions welcome — start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and
  [`SUPPORT.md`](SUPPORT.md), and follow the
  [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Architecture and invariants live in
  [`CLAUDE.md`](CLAUDE.md) (also the working agreement for AI coding agents, paired with
  [`AGENTS.md`](AGENTS.md)).
- Found a vulnerability? Please report it privately — see [`SECURITY.md`](SECURITY.md).
- [MIT](LICENSE).
