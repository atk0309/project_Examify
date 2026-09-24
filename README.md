# Examify

A calm, mobile-first, self-hosted **exam-practice app for families**. Pick a subject,
choose a difficulty, work a short mini exam one question at a time, and get encouraging
feedback at the end — mature, not babyish. Built by a parent for their kid(s); you run
your own instance: accounts, progress and study files are stored on your own server.
Optional AI marking and cloud generate send text or files to the provider you pick (see
[What leaves your server](#what-leaves-your-server)).

It is intentionally small: a static question bank you edit in code, a four-screen client
flow, host-picked sign-in (`password`, `magic-link`, or `local-otp`) gated by
**invite-only households** in SQLite, and one family data folder (the SQLite file plus
uploads and generated questions). No SaaS account, no tracking by default, no env-JSON
allowlist to hand-edit.

## Features

- **Host-picked auth** — password (sign-in needs no email service; invite accept
  still needs mail or an outbox), magic-link (Resend / SMTP / local outbox),
  or a local one-time code for tiny installs. Role-aware
  (Student / Parent), rate-limited, no membership enumeration. Cloudflare
  Turnstile is **optional**.
- **Invite-only households** — first-run bootstrap creates the admin; parents invite
  students and other parents with a link. A parent sees only their own household's
  child(ren).
- **MCQ + free-text questions** — free-text answers are marked server-side by the AI you
  set up (Anthropic or OpenAI key, Claude Code, Codex or a local endpoint) against a rubric
  you write, with a bounded, encouraging verdict.
- **Bring your own AI to build question banks** — from your study PDFs and notes, with an
  Anthropic or OpenAI API key, **Claude Code** or **Codex** already signed in on the
  server (your Claude or ChatGPT plan, no API key), a local OpenAI-compatible endpoint
  (Ollama, LM Studio, …), or your own command. The setup wizard shows which of these this
  server has and what each can read.
- **Autosave + resume** — reload, close the browser, or lose the tab mid-exam and the
  dashboard offers a "Continue where you left off" card. If the finished exam can't reach
  the server, your answers stay on screen with a "Try again".
- **Progress tracking** — per-subject best / average / latest and a per-question review
  of every attempt.
- **Parent dashboard + student mode** — parents get a side-by-side comparison and an
  "Are you smarter than your kid?" button to take the exams themselves.
- **Three visual themes** (`paper`, `calm`, `focus`) on one token system.

## The flow

1. **`/setup`** (first run) or **`/signin`** — on a fresh install, the first visitor
   creates the household and becomes admin (and sets a password when `AUTH_MODE=password`).
   After bootstrap, **`/onboarding`** lets the household admin add subjects, attach
   local study files (PDFs plus notes.txt and other CLI sources), choose an AI mode
   (Anthropic or OpenAI key, Claude Code or Codex with their own sign-in, a local
   endpoint, or a local command; each card says how it reads PDFs and whether this
   server has it; Anthropic / OpenAI keys write the same
   repo-root `.env` as `install.sh` / `examify-ingest generate`; host-injected
   usable keys stay host-managed; a boot `test` sentinel stays “not configured”
   but Clear/Rotate remain available after the first Save), optionally generate BankIR from those
   files, and emit through `examify-ingest` (validate + Review / dry-run HITL, then apply;
   subjects, uploads and generated questions go to the
   [family data folder](#where-your-familys-data-lives), never the checkout; a subject
   with a built-in subject's id is flagged and replaces the built-in one;
   desktop uses a step rail, mobile a compact progress bar; one stage at a time;
   generate never auto-applies; adding a subject does not write empty BankIR;
   real or corrupt BankIR needs a confirm before
   overwrite (preview names `would overwrite`; decline keeps prior IR);
   Apply prune of leftover generated subjects needs a named confirm; Ready
   lists live subject ids/names and question counts;
   cancel POSTs `/api/onboarding/cancel-generate`
   (not a queued Server Action), aborts provider HTTP/CMD via AbortSignal,
   and discards the preview so prior IR is unchanged (the wizard waits for
   an `ok` cancel response before claiming cancelled; during Generate all,
   cancel stops the later subjects and keeps and reports the ones already
   generated; an acknowledged cancel unlocks nav
   while the provider is still unwinding);
   cancelled is a calm status, not an error toast; generate is
   gated to wizard catalog subjects; a subject that reuses a sample subject
   id (`maths`, `computer-science`, `geography`) needs replace-sample, which
   the AI step offers next to Generate; a failed generate shows a specific
   reason and logs `[onboarding] generate failed { reason, subjectId, status }`;
   uploaded PDF names are sanitised, so commas, apostrophes, accents and so
   on are fine (a different file with the same name is stored as ` (2)`); an empty
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
`saveExamProgress` action. The waiting save is also sent when you leave the exam (Home,
another exam, Finish), and best-effort when the tab is hidden or closed. Finishing or
discarding clears the draft. If the finish can't reach the server, your answers stay on
screen with a "Try again" that re-sends them (a retry after a lost reply can save the
attempt twice). Only public question ids and your own answers are stored — never the
answer keys. These drafts never expire.

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
| Grading     | The household's AI mode (Anthropic / OpenAI API, Claude Code, Codex, local endpoint)      |
| Tests       | Vitest (unit), Playwright (e2e)                                                           |
| Lint/Format | ESLint 9 + Prettier + Tailwind plugin                                                     |

## Quick start

### Installer (recommended)

`install.sh` asks a few questions (site URL, family data folder, auth mode, mail for
invite-accept OTP, optional Turnstile, and which AI to use), generates the secrets,
writes `.env`, installs, migrates, and builds. OpenAI, Codex and local-endpoint
generate from PDFs also need `pdftoppm` (from **poppler** / `poppler-utils`) on `PATH`.
To build banks with your Claude or ChatGPT plan instead of an API key, install
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) or Codex **as the user
that runs Examify** and sign in once (`claude auth login`, or `codex login`); the setup
wizard finds it on `PATH` or in `~/.local/bin` (or set `EXAMIFY_CLAUDE_BIN` /
`EXAMIFY_CODEX_BIN`) and says whether it is signed in.

**Which AI.** A new interactive install looks for what this user already has: Claude
Code and Codex (and whether each is signed in) and Ollama (its models, at `OLLAMA_HOST`
or `127.0.0.1:11434`). It lists them and offers them next to an API key or "decide
later", defaulting to a signed-in Claude Code, then a signed-in Codex, then Ollama. The
pick is written as `EXAMIFY_AI_MODE` with what it needs (the CLI's full path when it is
not in `~/.local/bin`; Ollama's address and model). A CLI at a path `.env` cannot hold
(a space, a quote, `$`, `#` or a backslash in it) is listed but not offered, with the
`ln -s` that links it into `~/.local/bin`, where Examify looks for it. A household uses
it for banks and marking until its admin picks another mode in the setup wizard. An
Anthropic or OpenAI key typed at the key questions picks that mode the same way. These
checks only ask each tool whether it is signed in and Ollama for its model list; each is
cut off after 15 seconds. `EXAMIFY_AI_DETECT=0` skips them, and a run that finds an existing `.env`
does not run them.

```bash
curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash
```

From a clone: `./install.sh`. Help: `./install.sh --help` (piped:
`curl -fsSL …/install.sh | bash -s -- --help` — not `bash --help`).
Non-interactive: `EXAMIFY_NONINTERACTIVE=1 ./install.sh` (defaults to
`AUTH_MODE=password`, the family data folder `./data`, and a local outbox at
`<data folder>/outbox` so kid invite accept can deliver the mailbox OTP — only
when this run writes `.env`; set `SMTP_*` / `RESEND_*` for real mail, and
`EXAMIFY_DATA_DIR` or `--data-dir <path>` for another folder). Keep-broken /
keep-good is judged from the on-disk env files (`.env`, `.env.local`,
`.env.production*`, in Next's order), not a transient host env:
`ALLOW_LOCAL_OUTBOX=1` on the installer process does not greenlight a broken
password file. A kept password-mode `.env` with no mail path is refused (not
described as enabled). A host `AUTH_MODE` that differs from effective on-disk
`AUTH_MODE` (`.env.local` wins over `.env`, including an empty `AUTH_MODE=`
that Next treats as the magic-link default) is refused with copy that names
that effective mode, not the host and not `.env` alone when local wins. A host
`EXAMIFY_DATA_DIR` / `DATABASE_URL` or `--data-dir` that differs from the kept
files' data folder or database is refused the same way. `RESEND_API_KEY=test`
is not a mail path. Invite accept never skips that OTP.

The site URL must be the address family devices open (for example
`https://exam.example.com` or `http://192.168.1.20:3000`). `localhost` only works on
the host machine, so the installer warns that invite links will only open there; a
plain-`http` LAN address gets a note that traffic is unencrypted. See
[Deploying with HTTPS](#deploying-with-https).

Then `pnpm start` (or `pnpm dev`), open `SITE_URL`, and complete **`/setup`**
with the printed setup code.

### Manual (developers)

```bash
pnpm install
cp .env.example .env        # AUTH_MODE=magic-link; dev defaults work
pnpm dev                    # http://localhost:3000  -> /setup on a fresh DB
```

Family data (the SQLite database, mail outbox, wizard uploads and generated
questions) goes to `./data`, the default `EXAMIFY_DATA_DIR`. With no Resend key or
SMTP, magic-link / OTP messages are written to the local outbox, `data/outbox/*.json`
(`MAIL_OUTBOX_DIR` if set; `RESEND_API_KEY=test` keeps them in `tests/.tmp/outbox/`).
On a fresh database, visit `/setup`, enter the setup code (`SETUP_BOOTSTRAP_SECRET`;
the dev default works locally), and create the first household. Invite the
student from the dashboard. With `ANTHROPIC_API_KEY=test`, free-text grading
uses a deterministic local stub — no network, no API key needed for development.
The stub is off under `NODE_ENV=production` unless `GRADING_STUB=1` (tests only).

Set `AUTH_MODE=password` in `.env` if you want to develop without a mail
provider. Sign-in needs no mail; invite accept still uses the local
outbox in development (or SMTP / Resend / `ALLOW_LOCAL_OUTBOX=1` in
production). Password sign-in and the invite password step stay
submittable after browser autofill. A short invite password shows a
field error. Joining still waits for the mailbox code.

## Access: invite-only households

Who may sign in is stored in SQLite, not env:

1. **First run** — `/setup` creates the household and the admin (a parent). You must
   enter the deployment `SETUP_BOOTSTRAP_SECRET` (required in production). Your email
   is the required admin account id in every `AUTH_MODE` (including password). No
   email round-trip; you are at the keyboard. The form stays submittable after
   browser autofill, keeps those DOM values if Turnstile remounts, and shows
   field errors (cleared on input) instead of a silent disabled button. Password
   mode asks for the admin password twice; a mismatch is refused before the
   password is hashed, and hashing still waits until the setup secret, Turnstile,
   and the sign-in rate limit have passed.
2. **Invite** — from the parent dashboard, create a student invite (open or
   email-locked) or a parent invite (**email-locked**). Share `/invite/<token>`.
   Revoke unused links; remove a member if they should no longer have access.
   When `AUTH_MODE=password`, that URL is a **secret**: it starts a join
   but does not complete it. The invitee must enter a one-time code sent
   to their email before membership and `emailVerifiedAt` are set. The
   code screen says where to look, matching the transport this host
   actually uses (Resend, this host's mail server, or the local outbox).
   Sending a new code goes back to the password step. An
   email lock only chooses which mailbox we send to (not mailbox proof
   by itself). An open student link lets anyone with the URL start a
   join for an email they control. If no mail transport (or allowed
   outbox) is configured, accept fails closed; a failed send after
   issue also invalidates that unused OTP and clears the scrypt hash stored
   on that row. The password is chosen before the code is sent and is not
   posted again with the code. Complete refuses a code that is not bound to
   the invite, and it ignores any password field on that second request.
   Prefer email-lock
   (already required for parents); never post links publicly. See
   [`SECURITY.md`](SECURITY.md).
3. **Accept** — the invitee opens `/invite/<token>` and finishes in the configured
   auth mode (set a password then enter the mailbox code, click a magic link, or
   enter a local OTP). Success signs them in and opens the app at `/`. Later
   visits use `/signin`. Password sign-in and the invite password step stay
   submittable after browser autofill. Forgot password on `/signin` sends the
   same kind of mailbox code and does not change `password_hash` until that
   code is consumed. Unknown addresses get the same “sent” screen.
4. **Privacy** — a parent/admin only sees students who share their household. One
   household cannot see another.

Challenge modes always show a generic "sent" / "enter your code" screen whether or
not the email is a member (anti-enumeration), including when delivery fails
(logged server-side). Password sign-in always shows one generic "email, password,
or role didn't match" error. Forgot-password uses the same generic sent screen.
A silent non-delivery usually means they have not been invited yet, or mail could not be sent.

### Auth modes

| `AUTH_MODE`  | Sign-in                                  | Mail required                          |
| ------------ | ---------------------------------------- | -------------------------------------- |
| `password`   | Email + password (forgot password: OTP)  | Sign-in: no. Invite + reset: yes (OTP) |
| `magic-link` | One-time URL (Resend, SMTP, or outbox)   | Yes, unless outbox opt-in              |
| `local-otp`  | 6-digit code (outbox, or emailed if set) | Production: `ALLOW_LOCAL_OUTBOX=1`     |

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

Turnstile captcha is **off by default**. Local / LAN / simple self-hosts need no
Cloudflare account. To enable it, set `TURNSTILE_ENABLED=1` and both
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`. Keys alone do not
turn captcha on. Setting exactly one key in production crashes boot so verify
cannot be silently half-configured. `install.sh` asks before writing Turnstile
(default answer: no).

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
stay in lockstep.

Generated subjects come from BankIR (`bank.ir.json`, by hand or
`pnpm examify-ingest generate`) in two layers on top of the sample bank:

- **Family** — what `/onboarding` writes, in the family data folder
  (`data/content/subjects/<id>/`, uploads in `data/content/source-pdfs/<id>/`,
  output in `data/content/generated/`). The app reads it on every request, so an
  Apply shows up without a rebuild. It is never committed.
- **Committed** — the checkout's `content/subjects` (biology, the `demo` fixture),
  emitted into tracked `content/generated/` plus the `src/lib/exam/generated-*.ts`
  registrars that ship with the build.

A family subject with a built-in subject's id replaces it. `examify-ingest` picks
the layer from the path you name. Generate writes IR only; then run
`pnpm examify-ingest validate data/content/subjects`,
`emit data/content/subjects --dry-run` and `emit data/content/subjects --apply`
(`content/subjects` for the committed layer). Hand-authored biology has no source
file (skip generate). A fresh-clone generate fixture is `content/subjects/demo`
(`notes.txt` in the subject folder; generate
also reads `.txt` / `.md` / images there plus PDFs under `content/source-pdfs/<id>/`
of the same layer). A real BankIR with questions needs `--force`; empty /
placeholder IR does not. Corrupt / invalid-schema IR also needs `--force` (named
as corrupt, not empty). Sample-bank ids fail at generate unless
`--replace-sample`. The full guide — adding subjects and difficulties, writing
rubrics the LLM grader marks well, the ingest CLI, and a workflow for
generating a question bank from your own study-material PDFs and notes — is in
[`docs/content-authoring.md`](docs/content-authoring.md) and
[`tools/examify-ingest/README.md`](tools/examify-ingest/README.md).

## Free-text grading

Free-text answers are marked server-side, strictly against the rubric you wrote for that
question, by the AI the household picked in `/onboarding`:

| AI mode                                  | Marks with                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic                                | the Anthropic Messages API (`claude-sonnet-4-6`), one request per answer                                                                      |
| OpenAI                                   | OpenAI Chat Completions (`gpt-4o`, `OPENAI_API_KEY`), one request per answer                                                                  |
| Claude Code / Codex                      | one `claude -p` / `codex exec` run per finished exam, locked down like generate (no tools, private folder, env allowlist); 45 seconds at most |
| Local endpoint                           | `EXAMIFY_LLM_BASE_URL` with `EXAMIFY_LLM_MODEL`; all of an exam's answers share 45 seconds                                                    |
| Local command, test stub, or no mode yet | the Anthropic key, as below (a local command only builds banks)                                                                               |

The wizard's AI step and the parent dashboard say which one marks and what the server still
needs (`EXAMIFY_LLM_BASE_URL` must be an http or https address). Claude Code and Codex mark
only while they are signed in as the user that runs Examify, so Examify asks each one:
`claude auth status` / `codex login status`, run like a marking run (the env allowlist, an
empty private folder, Claude Code without that user's own settings, Codex with a private copy
of its sign-in), cut off after 5 seconds and remembered for a few minutes (a signed-out answer
for 30 seconds; the setup wizard's page always asks again), so a page rarely waits. It first
checks that the CLI's help lists that status command (again every 10 minutes), so an older
Claude Code, which would read `auth status` as a prompt, is never given it. When the answer is "signed out", the
parent dashboard, the setup wizard and the exam say so and name the sign-in command
(`claude auth login` / `codex login`), and papers leave written questions out, as when nothing
can mark them. A check with no clear answer (an older CLI, a timeout) counts as signed in, as
before; signed out after all, written answers are not marked and count as not correct, and
the next page asks again. The "Marking…" screen says written answers can take
up to a minute. Before a paper starts, the student sees who marks written answers. When
nothing on the server can, the paper leaves written questions out and says so; a bank with
only written questions keeps them, with a note under each that it counts as not correct.
The server accepts either paper, so an exam started before marking was set up (or cleared)
can still be finished. The CLI and
local deadlines keep a submit under a reverse proxy's usual 60-second timeout. Each answer
goes to the model between fresh markers, as data to mark, never as instructions.

- Configure `ANTHROPIC_API_KEY` (optional in production — wizard clear +
  restart will not brick boot). The grader reads the live key from
  `process.env` (updated by `/onboarding` set / rotate / clear), never a
  boot-frozen snapshot. The `test` sentinel swaps in a deterministic full-score stub
  with no network calls **only** outside production or when `GRADING_STUB=1` is set
  (the Playwright configs set it). In production without the flag, `test` counts as no
  key — `install.sh` writes it when the Anthropic prompt is left blank — so written
  answers are not marked (exams leave them out; a bank with only written questions keeps
  them), never given free full marks. Clear fails closed
  (`needs_review`, no stub).
- Grading is **fail-safe**: API requests have a 15-second deadline, and any timeout, network
  error, non-2xx, CLI failure, or malformed model output resolves to `needs_review` instead of throwing,
  so a finished exam is never lost. A `needs_review` item is final (nothing re-grades
  it): it shows "We couldn’t mark this one automatically, so it counts as not correct."
  Each one logs a server warning, `[grading] free-text answer not marked`, with a reason
  code (`no_key`, `stub_disabled_in_production`, `http_<status>`, `timeout`,
  `network_error`, `bad_json`, `bad_shape`, `no_cli`, `cli_auth`, `cli_error`, `no_endpoint`,
  `internal_error`), the backend for everything but Anthropic, and never the answer, rubric
  or key. An OpenAI `test` key stubs like the Anthropic one.
- A free-text item counts as "correct" when the score reaches **60%** of `maxScore`
  (`PASS_THRESHOLD` in `src/lib/exam/attempts.ts`).
- The UI renders only the bounded verdict (score, one-line feedback, got-right /
  to-review / spelling lists) — never the rubric, never raw model text.

## What leaves your server

Stored only on your server: household accounts and sessions, exam attempts and progress,
in-progress drafts, uploaded PDFs and notes, generated question banks and answer keys
(all in the [family data folder](#where-your-familys-data-lives)), and the `.env` keys.

Sent to a third party only when you turn the feature on:

- **Free-text marking.** Each free-text answer goes, with its question and rubric, to the
  AI the household picked: the Anthropic or OpenAI API with your key, Claude Code or Codex
  (to Anthropic or OpenAI under your plan), or your local endpoint. No names, emails or user
  ids are sent. Multiple-choice answers are scored on your server. When that AI is not set
  up, nothing is sent: exams leave written questions out (a bank with only written questions
  keeps them, and those answers count as not correct).
- **Cloud generate (Anthropic / OpenAI).** The `/onboarding` cloud modes and
  `examify-ingest generate --provider anthropic|openai` send that subject's source files
  (PDFs or their page images, notes, images) to the provider. Local modes send them to the
  endpoint or command you configure; `--provider test` sends nothing.
- **Claude Code / Codex generate.** The Claude Code and Codex modes
  (`--provider claude-cli|codex-cli`) run `claude -p` / `codex exec` on your server with
  their own sign-in, so the same files go to Anthropic or OpenAI under your plan. They
  run in an empty private folder with no tools (no file reads, commands or web search;
  Codex in its read-only sandbox, with a private copy of its sign-in only, so your
  `AGENTS.md` and skills stay out), save no session, and get only a short allowlist of
  environment variables: none of Examify's secrets or API keys. A failed wizard
  generate shows a specific reason (rejected key, rate limit, timeout, …) and logs only
  the reason code, subject id and provider HTTP status — never the provider's message,
  model text or your files.
- **Mail.** Invite, sign-in and reset codes go through Resend or your SMTP server. The
  local outbox keeps them on disk.
- **Installer checks.** A new interactive install asks Claude Code and Codex (when
  installed) whether they are signed in, and Ollama for its model list. No family data is
  involved; `EXAMIFY_AI_DETECT=0` skips the checks. When `OLLAMA_HOST` (or
  `EXAMIFY_LLM_BASE_URL`) points at another machine, the Ollama option names it: study
  files and written answers then go there.
- **Sign-in checks.** The app asks Claude Code / Codex whether they are signed in, as
  above: the household's own CLI when its pages render, and every installed one whenever
  the setup wizard loads or runs an action, whatever the AI mode. No family data is
  involved, and the answer is never shown or logged beyond "signed in" / "not signed in".
- **Fonts.** Pages load the Newsreader and Hanken Grotesk stylesheet from Google Fonts.
- **Optional:** Cloudflare Turnstile (`TURNSTILE_ENABLED=1`) and Plausible analytics
  (`PLAUSIBLE_DOMAIN`).

## Where your family's data lives

Everything that belongs to your family lives in one **family data folder**, picked in
this order: `EXAMIFY_DATA_DIR`; else the folder of an explicit SQLite `DATABASE_URL`
that is outside the checkout (a mounted volume keeps family content next to its
database); else `./data` inside the checkout (already gitignored). The running app never
writes into tracked checkout content: inside the checkout it writes only `./data` (the
test suites use `tests/.tmp/…`) and `.env` (the API keys the `/onboarding` wizard saves),
so `git pull` never conflicts with your content, and a folder outside the checkout
survives deleting and re-cloning it. The database (`DATABASE_URL`) and the mail outbox
(`MAIL_OUTBOX_DIR`) may live elsewhere, but never inside the checkout outside `./data`:
the app, `pnpm db:migrate` and the installer refuse that.
`pnpm examify:data paths` prints the folder, database and outbox this checkout uses.

| In the data folder                          | Holds                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `app.db` (+ `-wal`, `-shm`)                 | Accounts, households, progress, drafts (unless `DATABASE_URL` is set) |
| `outbox/`                                   | Local mail outbox: sign-in links and codes — **secret**               |
| `content/subjects/<id>/`                    | Wizard subjects: `subject.json`, `bank.ir.json`, notes                |
| `content/source-pdfs/<id>/`                 | Uploaded study PDFs                                                   |
| `content/generated/`                        | Generated questions; `keys/` holds the answer keys — **secret**       |
| `.examify-ingest/`                          | Generate run manifests and caches                                     |
| `backups/`                                  | Backup archives (database, answer keys, `.env`) — **secret**          |
| `migration-conflicts/`, `before-restore-*/` | Only after an upgrade or a forced restore — **secret**                |
| `.examify-data.json`, `.gitignore`          | Marker; `*` so the folder is never committed                          |

`.env` stays in the checkout and holds `AUTH_SECRET`, `SETUP_BOOTSTRAP_SECRET`, API
keys and mail passwords. `pnpm db:migrate` creates the folder `0700`; answer keys,
backups and outbox messages are `0600` (see [`SECURITY.md`](SECURITY.md)).

**Outside the checkout.** If you might ever delete and re-clone the checkout, answer the
installer's "Family data folder" prompt with a folder outside it, such as
`/var/lib/examify` (or run `./install.sh --data-dir /var/lib/examify`). The user that
runs Examify must be able to create it, or own it empty
(`sudo mkdir /var/lib/examify && sudo chown "$USER" /var/lib/examify`). The app refuses
to boot with a folder that overlaps the checkout: a relative path resolves against the
checkout (never the working directory); inside the checkout only `./data` or a folder
under it is allowed; never the checkout itself or a folder that contains it; no leading
`~` (the installer expands it, `.env` does not), quotes, newlines, `$` or ` #` — and the
same goes for `DATABASE_URL` and `MAIL_OUTBOX_DIR` (Next expands `$VAR` in env files, the
command-line tools do not).
`pnpm db:migrate` also refuses an existing folder that holds files that are not
Examify's.

**Moving the folder.** Stop the server and run `pnpm examify:backup`. In `.env`, set
`EXAMIFY_DATA_DIR` to the new folder and delete `DATABASE_URL` (it would keep the
database where it is). Then `pnpm examify:restore <archive>`, `pnpm db:migrate`, and
start the server. Delete the old folder once the app works.

> Never run `git clean -x` / `-X` (for example `git clean -fdx`) or `git stash -a` in the
> checkout: with the default `./data` they delete, or stash away, the database, the
> answer keys and `.env`. Commit local edits instead of stashing them.

## Themes

`data-theme` on `<html>` selects the mood: `paper` (default warm cream), `calm`
(cool neutral), `focus` (dark). Each theme only redefines the surface/text/border/
shadow tokens, so every component re-tones for free. Per-subject accents are OKLCH and
applied at runtime via `accentCSS()`.

## Commands

| Command                             | What it does                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`                          | Dev server (Turbopack)                                                         |
| `pnpm build`                        | Production build                                                               |
| `pnpm start`                        | Run the production build (`PORT` defaults to 3000)                             |
| `pnpm lint`                         | ESLint                                                                         |
| `pnpm typecheck`                    | `tsc --noEmit`                                                                 |
| `pnpm format`                       | Prettier write                                                                 |
| `pnpm test`                         | Vitest unit suite                                                              |
| `pnpm test:e2e`                     | Playwright e2e: seeded, fresh and password suites                              |
| `pnpm db:generate`                  | Generate a Drizzle migration from schema diffs                                 |
| `pnpm db:migrate`                   | Create the family data folder, then apply pending migrations to its database   |
| `pnpm examify-ingest`               | Generate / validate / emit BankIR (`tools/examify-ingest`)                     |
| `pnpm examify:data`                 | Data folder tool: `paths`, `init`, `backup`, `restore`, `verify`, … (`--help`) |
| `pnpm examify:backup`               | Back up the database, family content and `.env` to a `0600` archive            |
| `pnpm examify:restore <archive>`    | Restore a backup (server stopped; `--force`, `--with-env`)                     |
| `./install.sh --upgrade`            | Back up, move old checkout content out, merge upstream, rebuild                |
| `./install.sh --rollback <archive>` | Go back to the version and data in a pre-upgrade backup                        |
| `./install.sh --restore <archive>`  | Set up a new checkout from a backup                                            |

## Environment

Defined and validated by zod in `src/lib/env.ts`; the canonical reference is
`.env.example`. Required in production: `SITE_URL`, `AUTH_SECRET`,
`SETUP_BOOTSTRAP_SECRET`, and `EXAMIFY_DATA_DIR` or `DATABASE_URL` (without either,
boot fails rather than writing to ephemeral disk; so does a data folder that overlaps
the checkout — see [Where your family's data lives](#where-your-familys-data-lives)).
With `EXAMIFY_DATA_DIR` set, `DATABASE_URL` is optional: it defaults to
`<data folder>/app.db`, and older installs keep `file:./data/app.db`.
`ANTHROPIC_API_KEY` is optional (wizard clear +
restart will not brick boot; grading fail-closes without a key). `AUTH_MODE` defaults to
`magic-link`. Documented placeholder `AUTH_SECRET` / `SETUP_BOOTSTRAP_SECRET`
values fail production boot. A leftover `FAMILIES` value that is set but invalid
also crashes production boot. `AUTH_MODE=password` sign-in needs no mail;
invite accept still requires SMTP, Resend, or an allowed outbox (the
installer enables `MAIL_TRANSPORT=outbox` + `ALLOW_LOCAL_OUTBOX=1` when
nothing else is configured).
`MAIL_TRANSPORT=auto` (default) uses SMTP, Resend, or the outbox depending on
what is set. Production with no real mail transport does not write tokens to
disk unless `ALLOW_LOCAL_OUTBOX=1`. `local-otp` and explicit `outbox` require
that opt-in in production. A real Resend key **requires** `RESEND_FROM`.
Turnstile keys are optional when **both** are unset; exactly one key in
production crashes boot. Env validation **fails closed** in production for the
required vars. Access is empty-fail-closed: until someone completes `/setup`
with the bootstrap secret (or a leftover `FAMILIES` import runs), nobody can
sign in. `SITE_URL` also decides the session cookie: `Secure` +
`__Host-examify_session` on https, non-Secure `examify_session` on plain http.
`SESSION_COOKIE_NAME` is optional; a `__Host-` / `__Secure-` name with a non-https
`SITE_URL` fails production boot. `CLIENT_IP_HEADER` names the one header the sign-in
rate limiter trusts for the client IP (see [Deploying with HTTPS](#deploying-with-https)).
Bank-generate settings are all optional: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` for the
cloud modes; `EXAMIFY_CLAUDE_BIN` / `EXAMIFY_CODEX_BIN` (full path when the CLI is not on
the server's `PATH` or in `~/.local/bin`) and `EXAMIFY_CLAUDE_MODEL` /
`EXAMIFY_CODEX_MODEL` (else the CLI's own default) for Claude Code / Codex;
`EXAMIFY_LLM_BASE_URL` + `EXAMIFY_LLM_MODEL` (e.g. `http://127.0.0.1:11434` and a model
`ollama list` shows) for a local endpoint; `EXAMIFY_INGEST_LOCAL_CMD` for your own command.
`EXAMIFY_AI_MODE` (one of the wizard's modes: `cloud`, `cloud-openai`, `claude-cli`,
`codex-cli`, `local-agent`, `local-cli`, `skip-stub`; another value fails boot) is the
mode a household uses until its admin picks one; the installer writes it.

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
pnpm db:migrate && pnpm start    # create the data folder + database, then serve
```

Run `pnpm db:migrate` before `pnpm start` on every deploy — the server does not migrate
itself on boot, and in production it never creates the database: a missing file (say, an
unmounted volume) fails closed instead of serving a fresh, empty instance, and
`GET /api/health` answers 503 with a reason code only (`db_missing`; `unsafe_data_dir`
or `db_error` for the other failures). Put the family data folder on **persistent
storage** and point `EXAMIFY_DATA_DIR` at it — in a container, mount a volume (for
example at `/data`) and set `EXAMIFY_DATA_DIR=/data`. `DATABASE_URL` is optional. Set
the required env vars above (`AUTH_MODE` included), and healthcheck `GET /api/health`.

The checkout holds only code, committed content and `.env`. The wizard saves API keys to
that `.env`; on a host that rebuilds the checkout on every deploy, set them as host env
vars instead. Back up with `pnpm examify:backup` (see
[Backups and restore](#backups-and-restore)).

### Deploying with HTTPS

`SITE_URL` must equal the public origin family devices open (scheme, host and port).
Invite and sign-in links are built from it, and the session cookie follows it. Plain
http works on a home LAN but is unencrypted: passwords, codes and the session cookie
cross the network in clear. Use HTTPS for anything beyond the home network.

**Caddy** (automatic certificates):

```caddy
exam.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Then set `SITE_URL=https://exam.example.com` and restart. **Cloudflare Tunnel** also works
(no open inbound ports): route `exam.example.com` to `http://localhost:3000`.

**nginx** must forward the original host and scheme, or Next.js Server Actions reject
requests and sign-in fails:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

**Client IP for rate limits.** Sign-in limits are keyed by the client IP from one header,
`CLIENT_IP_HEADER`. The default, `x-forwarded-for`, uses the last X-Forwarded-For entry
and suits a single reverse proxy that appends to it (Caddy, Traefik, nginx as above,
most PaaS edges). Set `x-real-ip` only if your proxy overwrites X-Real-IP with the peer
address, and `cf-connecting-ip` only if the origin is reachable **exclusively** through
Cloudflare (a Tunnel, or a firewall that admits only Cloudflare). Don't expose
`next start` directly to the internet: with no proxy, the client controls
X-Forwarded-For. Password sign-in and mailbox codes also have per-account limits that
don't depend on the IP.

## Upgrading

Stop the server, then run this from the checkout as the user that runs Examify:

```bash
./install.sh --upgrade
```

The installer never starts, stops or restarts services. It first checks, changing
nothing, that this is a git checkout on a branch with an upstream, it is configured
(`.env`, `.env.local`, `.env.production` or `.env.production.local` exists),
`node`, `pnpm` and `tar` are installed, the checkout and data belong to you, this Node
meets the upstream's (its `.nvmrc` major and its installer's minimum version), and no
Examify server answers `/api/health` — healthy or not — on the host `PORT`, the `.env`
`PORT`, 3000 or `SITE_URL` (pass `--allow-running` if that is another service).
Uncommitted edits to tracked files outside `content/` and the generated registrars are
refused — commit them (the upgrade merges your commits and never stashes) — and so are
local commits that would conflict, and files the upstream adds that already exist here
untracked or ignored (the merge would refuse or overwrite them; move them away). Then it:

1. writes a pre-upgrade backup (database, family data, `.env`, and everything under the
   checkout's `content/`) to `<data folder>/backups/`, reads it back, and records it in
   `<data folder>/.upgrade-state.json` as the rollback point;
2. moves family content an older version left in the checkout (wizard subjects, uploaded
   PDFs, generated questions and keys, `.examify-ingest/`) into the data folder,
   restores the checkout's tracked files and removes the folders that end up empty;
3. sets the old build aside, merges the upstream branch, and runs the updated installer:
   `pnpm install --frozen-lockfile`, `pnpm db:migrate`, `pnpm build` (skip with
   `--skip-build`) and `node scripts/examify-data.mjs verify`;
4. prints the backup path. Start or restart the server.

If a step fails, the message names the backup and the exact commands: fix the problem
and re-run `./install.sh --upgrade`, or go back with `./install.sh --rollback <archive>`
(a first upgrade that stopped before its merge still has the old `install.sh`, so the
message gives the piped form below instead). A rerun of an upgrade that stopped keeps
its first backup as the rollback point while that is still the way back — after its
merge, or when it had already started moving content out of the checkout — and takes a
fresh one otherwise. A file the
data folder already holds with different contents is kept, and the checkout's copy goes
to `<data folder>/migration-conflicts/<time>/`. A built-in subject deleted in an older
version comes back. Existing installs keep their `DATABASE_URL`; the upgrade does not move
the database (see "Moving the folder" above).

**First upgrade from an older install.** Its `install.sh` has no `--upgrade`, and a plain
`git pull` strands your wizard content in the checkout: this version no longer reads it
there, and `pnpm db:migrate` refuses until it is moved. Run the new installer from inside
the checkout instead:

```bash
cd /path/to/examify    # your checkout
git fetch origin && git show origin/main:install.sh | bash -s -- --upgrade
```

That runs exactly the installer the upgrade moves to (no download; it works for a private
fork too). `curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash -s -- --upgrade`
does the same from the public repo. Stop the server first; without a terminal, add
`--yes` to answer the "is the server stopped?" question. If it stops before the merge,
rerun or roll back the same way (`… | bash -s -- --upgrade`, or
`… | bash -s -- --rollback <archive>`). Later upgrades use `./install.sh --upgrade`.

## Backups and restore

```bash
pnpm examify:backup    # same as: node scripts/examify-data.mjs backup
```

This writes `<data folder>/backups/examify-backup-<time>-<id>.tar.gz` (`0600`): a
consistent snapshot of the database (safe while the server runs), the family content,
generate run manifests, and the checkout's env files (`.env`, `.env.local`,
`.env.production`, `.env.production.local`, whichever exist). It leaves out the mail
outbox, earlier backups and the generate cache (`--include-cache` adds the cache).
`--no-env` leaves out the env files; `--out DIR` writes somewhere else outside the checkout.
Every archive is read back (the whole `tar` stream and its manifest) before it is
reported; one that does not read back is removed and the backup fails. If the wizard
applies new questions while a backup runs, it copies the generated questions and keys
again so they always come from one Apply; if they keep changing it stops
(`content_changing`) and you run it again. It never creates `backups/` in a folder that
holds other software's files.

**An archive holds secrets and answer keys.** Copy it off the machine (another computer,
an encrypted drive) and keep it private: a backup that lives only next to the data does
not survive a lost disk. Nothing deletes old archives.

Nightly, from the crontab of the user that runs Examify (`crontab -e`). Cron starts in
your home folder with a minimal `PATH`, so use absolute paths (`command -v node` prints
node's):

```cron
30 3 * * * /usr/bin/node /home/examify/examify/scripts/examify-data.mjs backup --repo /home/examify/examify >> /home/examify/examify-backup.log 2>&1
```

It reads `EXAMIFY_DATA_DIR` / `DATABASE_URL` from the checkout's env files, like the app.
If your service manager sets them instead, set them on the cron line too.

**Restore on this machine.** Stop the server, then `pnpm examify:restore <archive>`. It
refuses while the server answers, checks every file against the archive's manifest, and
refuses a backup from a newer Examify. When the data folder already holds a database or
content, add `--force`: the current data is moved aside to
`<data folder>/before-restore-<time>/`, never deleted (if the restore fails after that,
the error names that folder). `--with-env` also puts back the archived env files (a
current one is kept as `<name>.before-restore-<time>.local`), and the data then goes to
the folder those restored files name. Then run `pnpm db:migrate` and start the
server.

**Restore on a new machine.** Copy the archive over, then:

```bash
curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash -s -- --restore /path/to/examify-backup-….tar.gz
# or, in a clone: ./install.sh --restore /path/to/examify-backup-….tar.gz
```

The installer clones if needed, installs, restores the database, the family content and
the archived env files (`.env`, `.env.local`, `.env.production*`; or asks for a new
`.env` when the backup has none), then migrates and builds. The data goes to the family
data folder those archived files name (`./data`
unless the old install used another one); if the user that runs Examify cannot create
that folder, create it for them first. Don't set `EXAMIFY_DATA_DIR` / `DATABASE_URL` or
`--data-dir` for such a restore: the restored `.env` decides. Change `SITE_URL` in `.env`
if the new machine has a different address.

**Roll back an upgrade.** `./install.sh --rollback <archive>` takes a pre-upgrade backup
(only those record the version to go back to). With the server stopped, it first checks
the whole archive (every file against its manifest; a damaged or incomplete one changes
nothing), then resets the checkout to that commit (`git reset --keep`, which refuses to overwrite local changes),
restores the database, family content, `.env` and the checkout's content from the
archive — the current data and `.env` are moved aside as above, not deleted — then
reinstalls and puts back the pre-upgrade build, or rebuilds. It checks for a running
server before touching the checkout (`--allow-running` does not skip the local ports:
the restore would refuse them anyway).

## Testing

`pnpm test` runs the Vitest unit suite (content guards, scoring, grading, auth, actions)
against an isolated SQLite file. `pnpm test:e2e` builds the app (`pnpm build`) then runs
three Playwright suites (run `pnpm test:e2e:install` once first):

- **seeded** — public-route smokes, the magic-link happy path, invite accept, the uniform
  sign-in rate limit, and the empty-token failure path with captcha on (Cloudflare's
  always-pass dummy keys);
- **fresh** — first-run bootstrap and the onboarding wizard with Turnstile unset;
- **password** — `AUTH_MODE=password` (the installer default): password sign-in, a whole
  exam (multiple-choice and free-text) through results and progress, resume after a
  reload, a retry after a finish whose submit was dropped, the parent dashboard, and the
  generic wrong-password error.

All suites start with `next start` against the production `.next` and do not create it.
Ports default to 3100 / 3101 / 3102 (`E2E_PORT`, `E2E_FRESH_PORT`, `E2E_PASSWORD_PORT`).
Every run keeps its family data under `tests/.tmp/` (never your `EXAMIFY_DATA_DIR`), and
CI fails when the build or the e2e suites leave any file under `content/`,
`.examify-ingest/` or `src/`.

## Contributing, security, license

- Contributions welcome — start with [`CONTRIBUTING.md`](CONTRIBUTING.md) and
  [`SUPPORT.md`](SUPPORT.md), and follow the
  [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Architecture and invariants live in
  [`CLAUDE.md`](CLAUDE.md) (also the working agreement for AI coding agents, paired with
  [`AGENTS.md`](AGENTS.md)).
- Pull requests get a Codex review (on open, and `@codex review` after later pushes) and
  one CodeRabbit review when they open (`.coderabbit.yaml`).
- Found a vulnerability? Please report it privately — see [`SECURITY.md`](SECURITY.md).
- [MIT](LICENSE).
