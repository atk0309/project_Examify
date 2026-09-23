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

Keep `project_Examify` (a calm, mobile-first exam-prep app) fully cloud-developable with GitHub PRs and CI while remaining portable across Node 22 LTS hosts (`>=22.22.2 <23`), preserving the security and operational invariants documented in `CLAUDE.md`.

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
  exact paper via `resolveExamPaper` (no re-shuffle). A waiting debounced autosave is
  sent, not dropped, on Home / starting or resuming another exam / Finish (queued ahead of
  `recordAttempt`) / exit student mode, and best-effort on tab hidden / `pagehide` (a
  Server Action can't use `sendBeacon`). Autosave / discard rejections never crash the
  exam: local state is kept and the next checkpoint re-sends the full snapshot. A failed
  `beginExamSession` is retried (upsert) at the next checkpoint; safe because Next
  dispatches Server Actions one at a time and finish/discard end the retrying;
  `saveExamProgress` stays update-only. In-memory drafts (live, then exams "parked" this
  session, newest first) always beat the page-load `resumable` snapshot of the same combo.
- **Answer keys + rubrics are server-only.** The public bank (`src/lib/exam/data.ts`)
  carries no answers/rubrics; they live in `src/lib/exam/answer-keys.server.ts`,
  keyed by question `id`, and every key carries a mandatory `provenance { pdf, locator }`.
  Keep `attempts.ts` client-safe (it's in the client graph).
- **Completed and resumable papers are validated server-side.** Their public question
  ids must be unique, belong to the selected subject + difficulty, and contain exactly
  the number of questions `buildExam()` returns. Draft answers must match each public
  question's type/range. This validation never reads or exposes answer keys.
- **Content is hand-edited or emitted from BankIR.** The shipped bank is a
  hand-authored 3-subject sample plus additive generated subjects from
  `content/generated/` (biology is the Phase 0 example). Add content as
  `{ id, type, q, choices? }` in `data.ts` **plus** a matching `ANSWER_KEYS[id]`
  (with provenance) in `answer-keys.server.ts`, **or** author
  `content/subjects/<id>/bank.ir.json` (by hand or `pnpm examify-ingest generate`)
  then `pnpm examify-ingest validate content/subjects` →
  `emit content/subjects --dry-run` → `emit content/subjects --apply`
  (emit is dry-run by default; never clobbers any sample-bank id without
  `--replace-sample`; partial emit (explicit IR files or mixed file+dir argv)
  merges `subjects.json`; a whole-tree emit of subjects directories only
  (`content/subjects`) deletes leftover generated subject JSON). **Two generated
  layers:** _committed_ = checkout `content/subjects` → tracked `content/generated/`
  plus the `src/lib/exam/generated-*.ts` registrars, which _are_ that layer (bundled at
  build time; not a fallback); _family_ = the data folder's
  `content/{subjects,source-pdfs,generated}` — what `/onboarding` writes, read per
  request by `live-bank.server.ts` (Apply needs no rebuild), never committed, never
  registrars. A family subject with a committed id replaces it entirely; an incomplete
  family subject (unparseable questions, a question without a key) is dropped with one
  reason-coded `[live-bank]` warning and the committed one stays. Family catalog rows
  carry `rev` (sha256 of the questions + "\n" + keys bytes; family emits and
  `migrate-checkout`'s moved rows only, never the committed layer or registrars): a row whose files do not hash to it serves the last
  consistent copy read in this process, else is dropped (`revision_mismatch`), so an
  Apply mid-write or crashed never pairs new questions with old keys (`examify-data
verify` fails, `revision`, on such a row). The wizard's Apply
  is confined to `<family>/content/generated` on realpaths (a symlink into the checkout
  is refused), re-checked right before each write. The wizard's other writes (add /
  rename / delete a subject, attach / detach a PDF, the generate IR commit) return
  `unsafe_path` when any existing path component below the family root is a symlink
  (`isFamilyWritePathSafe`, `content-root.ts`, lstat right before the write; generate
  also before the provider call). The ingest CLI picks the
  layer from its paths (data folder checked first; outside both or mixed ⇒ error;
  `layer: …` on stderr) and only a committed emit rewrites registrars (`planEmit`
  `registrars` defaults to false). Family CLI work names `data/content/subjects`. A dev
  checkout doing committed CLI work needs `EXAMIFY_IGNORE_LEGACY_CONTENT=1` for
  `db:migrate` (never on a real install). Guide: `docs/content-authoring.md` and
  `tools/examify-ingest/README.md`. Generate writes IR only — still
  `validate content/subjects` → `emit content/subjects --dry-run` →
  `emit content/subjects --apply`. It never auto-applies.
  Hand-authored biology has no source file (skip generate; validate/emit only).
  Fresh-clone generate: `content/subjects/demo/notes.txt`. Generate scans
  notes/text (`.txt` / `.md`) and images in the subject folder plus PDFs
  under `content/source-pdfs/<id>/` (PDF magic-byte checks for actual PDFs
  stay fail-closed). A real BankIR with questions requires `--force`
  (dry-run says **would overwrite**) when `hasExistingBankIr` is true.
  Empty / placeholder IR (empty file, valid zero-item schema) is
  non-existing for that gate. Corrupt / unparseable / invalid-schema IR
  requires `--force` (error names corruption, not empty).
  Frozen sample-bank ids fail at generate unless `--replace-sample` (**no
  BankIR written**; do not imply the file already exists). The wizard passes
  the household replace-sample setting and refuses a subject whose id is a
  sample subject id (`sample_collision`) before calling the provider unless
  that setting is on. Generate
  throws typed errors (`ProviderFailureError` `kind` http / timeout /
  unreachable / output / command + `status`, `SampleIdCollisionError.ids`,
  `UnreadableSourcesError`), including failures while the response body is
  still arriving (the body read is inside `withProviderSignal`); CLI text is
  unchanged except the fetch deadline (`provider request timed out after
180000ms`) and a non-JSON 200 body (`<provider> returned a body that is not
JSON`). Missing cloud
  keys are refused before overwrite messaging when a real key is required;
  `--provider test` still runs without keys. A sourceless sibling blocks
  `generate content/subjects` (hint: `content/subjects/<id>` or
  `--subject <id>`, e.g. demo) — do not invent sources.
  Tree generate drafts every subject before the first IR write (sources,
  overwrite, SAMPLE freeze, provider); a mid-list or persist failure writes
  no BankIR (commit rolls back earlier writes; abort is gated before persist).
  Persist uses shared `writeBankIrAtomic` + `hasExistingBankIr`. Empty /
  placeholder IR does not require force; corrupt IR does. The wizard never silently
  replaces existing `bank.ir.json` (named confirm, or skip/cancel;
  confirm is that same `--force` for the subject).
  `generateSubject` accepts optional `AbortSignal` (forwarded to provider
  HTTP/CMD; abort throws and writes no IR, IR cache, page-raster cache, or
  run manifest). Cloud
  providers fail closed without an env key (generate also reads repo `.env` /
  `.env.local` for unset keys); `--provider test` is the CI
  fixture. OpenAI-compatible generate refuses PDF-only input when no page
  images were rasterized (`pdftoppm` from poppler-utils). Run cache/manifests live under
  the layer's `.examify-ingest/` (gitignored in the checkout).
- **The running app never writes into tracked checkout content.** All runtime state
  (SQLite DB, outbox, wizard subjects / uploads / BankIR / generated questions + keys,
  ingest caches, backups) lives in the family data folder from `src/lib/data-dir.ts`
  (`getDataPaths()`; CLIs use `resolveCliDataPaths()`, repo env files in `next start`
  order via `env-file.ts`). Inside the checkout it writes only `./data` (gitignored),
  `tests/.tmp/…` (the suites) and `.env` via env-store (wizard API keys). Folder =
  `EXAMIFY_DATA_DIR` (relative → checkout root, never cwd) → else the folder of an
  explicit SQLite `DATABASE_URL` outside the checkout → else `./data`. DB = explicit
  `DATABASE_URL`, else `<data>/app.db`. Outbox = `MAIL_OUTBOX_DIR`, else
  `<data>/outbox` (`RESEND_API_KEY=test` → `tests/.tmp/outbox` outside production only).
  `resolveDataPaths` (realpaths): the folder never the checkout or a folder containing it
  and inside it only `data/…` (+ `tests/.tmp/…`); the DB and the outbox never inside the
  checkout outside those (`db_inside_checkout` / `outbox_inside_checkout`, so boot,
  `db:migrate`, `examify-data paths --check` and the ingest CLI all refuse); a leading
  `~`, quotes, backtick, newline, `$` or ` #` in `EXAMIFY_DATA_DIR`, `DATABASE_URL` or
  `MAIL_OUTBOX_DIR` refused (`bad_value`, naming the variable); a data folder that is a
  file or unreadable is `unreadable` (Node's path-bearing errors are mapped; only ENOENT
  counts as "not created yet", never `existsSync`, which is false for EACCES / ELOOP too); messages
  never name the path or value. Production boot needs `EXAMIFY_DATA_DIR` or
  `DATABASE_URL` and a safe, dedicated folder (an unmarked folder holding non-Examify
  files is refused), and production never creates a missing DB
  (`DatabaseMissingError`; `/api/health` → reason codes `unsafe_data_dir` /
  `db_missing` / `db_error` only). `db:migrate` (`initDataFolder`) creates the folder
  `0700` + `.gitignore` `*` + marker, refuses a shared unmarked folder, and refuses while
  older family content is still in the checkout (unless
  `EXAMIFY_IGNORE_LEGACY_CONTENT=1`, dev only).
  `scripts/examify-data.mjs` (`pnpm examify:data` / `examify:backup` /
  `examify:restore`) stays plain ESM on Node builtins + the checkout's better-sqlite3
  (`install.sh --upgrade` runs the upstream copy on the old `node_modules`), mirrors the
  resolver (parity test — change both), and its exit codes (0 ok, 1, 2 usage, 3 unsafe,
  4 legacy, 5 refused, 6 verify failed) are an `install.sh` contract. Writing commands
  (and `verify`) refuse on an owner mismatch unless `--allow-owner-mismatch`. Backups:
  `VACUUM INTO` snapshot + family content + every `next start` env file (`.env`,
  `.env.local`, `.env.production*`; unless `--no-env`), never `outbox/`
  or `backups/`, never `backups/` created in a shared folder, `content/generated` staged
  as one revision (hashed before / after; `content_changing` after 3 tries), archives
  `0600` and read back before they are reported; restore
  refuses while Examify answers `/api/health` (any JSON `{ok:boolean}`), checks the
  MANIFEST sha256s, moves existing data aside only with `--force`, names that folder if
  it fails afterwards, and never fails once everything is placed. `migrate-checkout`
  never moves anything without a backup holding what it reverts (its own
  `--include-checkout` one, or a `--backup` that holds this checkout at `HEAD`, extracted
  and checked against its MANIFEST like a restore, so a truncated archive is refused) and
  prunes emptied folders bottom-up. `install.sh` is `main()`-wrapped; `--upgrade` =
  read-only preflight (an install = any `next start` env file, `.env.local` alone
  included; upstream-added paths that exist untracked / ignored; upstream Node needs) → pre-upgrade backup → `.upgrade-state.json` rollback point →
  `migrate-checkout --backup` → merge → phase 2 (install / `db:migrate` / build /
  `verify`); `--rollback <archive>` (works from the piped upstream installer too; the
  whole archive is verified with `check-archive` before `git reset`) /
  `--restore <archive>`. It never manages services, never stashes or `git clean`s.
  Details: CLAUDE.md "Family data folder invariants".
- **Free-text is LLM-graded server-side** (`src/lib/grading/index.ts`,
  live `ANTHROPIC_API_KEY` from `process.env` only so a wizard set / rotate /
  clear is visible without restart; `test` → deterministic stub only when
  `NODE_ENV !== 'production'` or `GRADING_STUB=1` (Playwright sets it), else
  `needs_review`; missing after clear → `needs_review`, no stub; blank is never treated as `test`;
  same usable-key rule as the Configured badge; optional in `env.ts` so a
  production restart after clear does not brick boot). Grading never throws — failures
  fall to `needs_review`, which is final (nothing re-grades it), counts as not correct,
  renders `NEEDS_REVIEW_COPY` (never promise later marking) and logs one `[grading]`
  warning with a reason code only (no answer / question / rubric / key / user id). A free item is "correct" at `PASS_THRESHOLD` (0.6). The UI
  renders only the bounded `Verdict` fields, never the rubric. Results are
  server-driven (a "Marking…" state covers the submit round-trip). A rejected submit
  (no answer came back) keeps the answers and offers "Try again", which re-sends the
  identical payload (`exam-error-unreachable` / `exam-retry`); an `ok:false` paper
  (`invalid` | `forbidden`) gets a no-retry `exam-error-refused` screen. Next redirect /
  not-found still propagate (`unstable_rethrow`). Known limitation: a retry after a lost
  response can record a duplicate `exam_attempts` row (no idempotency key yet).
  `src/app/error.tsx` is the calm app-level backstop (retry, or full reload to `/`). Full design:
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
- Parent→child linking is per-household in SQLite: `resolveChildren(parentEmail)`
  in `src/lib/progress.ts` returns only students who share that parent's household — a
  parent never sees another household's child. It's the privacy boundary; keep it isolated.
  The dashboard lists every household student and compares against a selected child.
  The comparison's "score by attempt number" axis uses `getScoreHistory()` (uncapped,
  oldest-first) rather than the 50-capped `getProgressForUser`.
- Access is invite-only. First-run `/setup` (`bootstrapHousehold`) creates the admin
  when no household exists, and only after `SETUP_BOOTSTRAP_SECRET` matches (required
  in production; captcha is not identity). `SetupForm` reads submitted FormData
  (autofill-safe), keeps inputs uncontrolled, and re-reads / restores a
  FormData snapshot if a Turnstile remount wipes values. First-paint
  default household name does not seed that snapshot; silent autofill is
  captured so a remount can restore it. A user-cleared password or
  confirmation is never resurrected from an old snapshot. It never silently
  disables Create household. Password mode confirms the admin password;
  a mismatch is refused before scrypt, which still waits for Turnstile,
  the sign-in rate limit, and `SETUP_BOOTSTRAP_SECRET`. Field-level / `aria-invalid` errors drop on the
  next successful edit of that field or on resubmit. Email is the required
  admin account id in every `AUTH_MODE` (including password). After bootstrap, `/onboarding` lets the
  household admin add subjects, attach local study files (PDFs plus notes.txt
  and other CLI sources generate already reads), choose an AI mode, optionally
  run `examify-ingest generate` (BankIR only; never emit/apply; adding a
  subject writes `subject.json` only — no empty/placeholder `bank.ir.json`;
  overwrite / skip / generate use shared `hasExistingBankIr` (empty /
  valid zero-item ≠ existing; corrupt / unparseable / invalid schema is
  existing and needs force; never `existsSync` on the IR path); real
  existing `bank.ir.json` needs a calm confirm — preview names `would overwrite`,
  decline is skipped/cancelled, not a failure, confirm is CLI `--force` for
  that subject; generate-all confirms per colliding subject or one named
  batch; persist is shared `writeBankIrAtomic`; cancel
  POSTs `/api/onboarding/cancel-generate` so the token is not queued
  behind generate, then aborts provider HTTP/CMD via AbortSignal and
  discards the preview (no IR write; prior IR unchanged); the wizard
  waits for an `ok` cancel response before claiming cancelled; cancel records
  the token even after an earlier subject committed, so Generate all still
  stops (next subject refused as `cancelled` before the provider call,
  in-flight subject aborted, committed subjects kept and reported: “Kept N
  subjects already generated”); with nothing in flight and the last generate
  committed the route answers `already_committed` (409) and a single subject
  shows “Generate already finished”; Generate busy state is set outside the
  async transition so Cancel renders; failures return safe reason codes
  (`provider_auth` / `provider_rate_limited` / `provider_timeout` /
  `provider_unavailable` / `provider_error` / `provider_output_invalid` /
  `sources_unreadable` / `sample_collision` / `disk` / `generate_failed`),
  never raw provider text, and log one
  `console.warn('[onboarding] generate failed', { reason, subjectId?, status? })`
  (`subjectId` only when it is a valid kebab id; never message / model text /
  paths / keys; cancel / skip / overwrite-confirm not logged); uploaded PDF
  names are sanitised (`sanitizeUploadName`), not refused: path separator /
  NUL is `invalid_name`, non-`.pdf` / empty / no `%PDF` magic is
  `invalid_type`, over 8 MiB is `too_large`, a same-name different file gets
  ` (2)` via exclusive create (never clobbers, never through a symlink), same
  bytes is a no-op; an acknowledged cancel unlocks nav while
  the provider is still unwinding; cancelled is a
  calm status, not an error toast; delete/rename wait on the generate
  lock and re-check the admin gate after the wait; subject
  ids must be in the wizard catalog; Anthropic / OpenAI modes can set /
  rotate / clear `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the same
  repo-root `.env` as `install.sh` and `examify-ingest generate` (shared
  `findRepoRoot`; never echoed; host-injected usable keys are not rotatable
  in the wizard; a boot `ANTHROPIC_API_KEY=test` sentinel stays “not
  configured” but Clear/Rotate remain available after the first Save);
  skip / Back / desktop rail lock while
  generate is in flight so Cancel stays reachable), and emit
  BankIR via `examify-ingest` (directory-only, Review / dry-run HITL before apply,
  an empty family tree fail-closed except a confirmed prune-only plan when the family
  deleted its last subject; `--replace-sample` only behind an explicit
  toggle — Review › Advanced, and on AI setup next to Generate when a subject
  reuses a sample id; the Subjects add form warns). `/onboarding` is one stage at a time: desktop ≥900px uses a left step
  rail + stage + sticky footer; mobile uses compact “Step N of M · Label”
  progress and a sticky bottom bar.
  Apply re-hashes the current plan and refuses if it differs from the confirmed
  dry-run (never applies an unconfirmed plan). Leftover generated subject files
  need a named prune confirm before Apply deletes them; cancel is zero
  writes. Ready lists live bank subject ids/names and question counts.
  Finish requires that confirmed apply; skip-without-emit matches Welcome skip (sample bank + dashboard chip).
  Delete does not write generated files; prune runs on confirmed apply.
  Invited members never see it.
  Existing households are migrated as already complete.
  Parents/admins mint invite links
  (`createInvite`); accept goes through `/invite/[token]` using the configured
  `AUTH_MODE` (password, magic-link verify, or local OTP). Password sign-in
  and the invite password step read submitted FormData and keep email/password
  uncontrolled (same autofill rule as `SetupForm`): the CTA is not disabled
  from empty React state. A short invite password or a confirmation mismatch
  shows a field error and does not send a code.
  In `password` mode the
  invitee must confirm a mailbox OTP before membership / `emailVerifiedAt`
  (`completePasswordInvite`); the token must carry `invite_id` (also refused
  inside `consumeHashedBearer` when a password is being set), and a failed
  send after issue invalidates the unused OTP and clears `pending_password_hash`.
  The code screen names the effective transport (`resolveMailTransport()`:
  Resend, this host's SMTP, or the local outbox), or none when
  `canDeliverMailboxProof()` is false. A new code is sent from the password
  step again (with a way back to code entry); the join cannot skip the code.
  `invite-invalid` does not burn leftover sign-in OTP guesses. Missing mail fails
  closed. The code form does not resubmit the password; complete ignores a
  client password and stores the hash bound to that invite OTP.
  Treat links as secrets
  and do not post them publicly (`SECURITY.md`). Do not bring back a
  required `FAMILIES` env allowlist. A leftover `FAMILIES` JSON is imported once
  if the DB has no households. Production boot fails if `FAMILIES` is set and invalid.
- **Auth mode** is `AUTH_MODE` (`password` | `magic-link` | `local-otp`, default
  `magic-link`). `install.sh` writes it. Password sign-in needs no mail;
  password-mode invite accept and forgot-password still send a mailbox OTP
  (never skipped). Reset does not change `password_hash` or `emailVerifiedAt`
  until that code is consumed, and it does not reveal whether the address is
  a member.
  Interactive / default `install.sh` prompts for mail or enables a local
  outbox when it writes `.env` so kid invites are not stranded. A kept
  password-mode `.env` with no mail path is refused (judged from the on-disk
  env files in Next's order, not a transient host `ALLOW_LOCAL_OUTBOX`). A
  host `AUTH_MODE` that differs from effective on-disk `AUTH_MODE`
  (`.env.local` wins over `.env`, including an empty `AUTH_MODE=` that
  Next treats as the magic-link default) is refused with copy that names
  that effective mode; so is a host `EXAMIFY_DATA_DIR` / `DATABASE_URL` or
  `--data-dir` that differs from the kept files' data folder / DB. Magic-link /
  local-otp use `MAIL_TRANSPORT` (`auto` / `resend` / `smtp` / `outbox`).
  `pnpm db:migrate` opens the same data folder / DB as the app
  (`resolveCliDataPaths`: repo env files via `findRepoRoot`, never cwd).
  Production `local-otp` or explicit `outbox` requires `ALLOW_LOCAL_OUTBOX=1`.
  SMTP AUTH/DATA requires TLS (STARTTLS or `SMTP_SECURE`) unless
  `SMTP_ALLOW_INSECURE=1`. `SMTP_FROM` is required only when SMTP is the
  active transport. Household membership remains the privacy boundary; every
  mode issues the same session shape. Mailbox codes (local OTP, invite OTP,
  reset) lock after 5 well-formed wrong guesses per 15 min; re-issuing a code
  never resets that lock, and while locked even a correct code is refused.
  Password sign-in also has a per-account `pw:{email}` bucket (10 failures /
  15 min, any email, checked before scrypt, cleared on success or reset).

## Workflow expectations

- Work on feature branches and open pull requests.
- Do not push directly to `main`.
- Prefer small, reviewable commits with clear intent.
- Keep docs in sync for any behavior, route, env-var, or script changes (`README.md`, `CLAUDE.md`, `.env.example`).
- Every PR gets a Codex review: opening it triggers one; after each later push that
  changes code, comment `@codex review` so fix commits are reviewed too. Verify each
  finding and fix the real ones. CodeRabbit reviews each PR to `main` once, when it
  opens (`.coderabbit.yaml`; no re-review per push — it rate-limits, so don't
  re-trigger it after fixes). Both are advisory on top of green CI.

## Quality gates (target harness)

Before merge, ensure these pass in CI:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`
5. `pnpm test:e2e` (where browser/network constraints permit). It runs three
   Playwright suites: seeded magic-link, fresh first-run, and `AUTH_MODE=password` +
   the exam flow. Override ports with `E2E_PORT` / `E2E_FRESH_PORT` /
   `E2E_PASSWORD_PORT` when running alongside other servers.

## Test coverage expectations

- New public routes: add Playwright smoke coverage.
- New mutable server handlers/actions: add happy + failure tests.
- New `src/lib/*` helpers: add unit tests.
- Keep link-crawl and feed/health/OG checks green.
- Changes to sign-in, ExamApp, ProgressView or ParentDashboard must keep
  `tests/e2e/password.spec.ts` green (it includes a finish whose first submit is
  dropped → retry → results); keep its `data-testid` hooks, including
  `exam-error-unreachable` / `exam-error-refused` / `exam-retry`. Each e2e spec
  belongs to exactly one Playwright config (`tests/e2e/suites.ts`).
- Tests never touch a real data folder or the checkout's content: `tests/unit/setup.ts`
  pins `EXAMIFY_DATA_DIR=tests/.tmp/unit-data-<pid>` and `DATABASE_URL` unconditionally;
  each Playwright config sets `EXAMIFY_DATA_DIR=tests/.tmp/e2e-{seeded,fresh,password}-data`
  (wiped + initialised by `setup-db.ts` via `E2E_DATA_DIR`; `--empty` seeds the `demo`
  fixture there). Family-layer tests use a temp family root **and** a separate temp fake
  checkout. CI fails when the build or e2e leave anything under `content/`,
  `.examify-ingest/` or `src/` (`git status --porcelain --ignored=traditional`).

## Deployment constraints

- Put the family data folder on persistent, runtime-mounted storage and set
  `EXAMIFY_DATA_DIR` to it (e.g. `/data`); `DATABASE_URL` is optional (production needs
  one of the two). The checkout needs no persistence beyond `.env`.
- Run `pnpm db:migrate` before `pnpm start` on every deploy (runtime, never
  build-time). The server does not migrate itself on boot, and in production it never
  creates a missing database (an unmounted volume fails closed).
- Upgrades go through `./install.sh --upgrade` (first time on an older install:
  `curl -fsSL …/install.sh | bash -s -- --upgrade` from the checkout), never a plain
  `git pull` over wizard content. Never `git clean -x` / `git stash -a` a checkout
  whose data folder is the default `./data`.
- `SITE_URL` must equal the public origin family devices open (it builds invite
  links and decides the session cookie). Behind a reverse proxy, forward the
  original `Host` and `X-Forwarded-Proto` or Next Server Actions reject requests.
- Keep `/api/health` lightweight and reliable; failures return reason codes only.
- Preserve fail-closed env validation in production.

## Security invariants (do not weaken)

- Never bypass server-side Turnstile verification when captcha is enabled
  (`TURNSTILE_ENABLED=1` and both keys). When the flag is unset, skip the
  widget and verification so sign-in works without Cloudflare. Exactly one
  key in production crashes boot.
- Keep canonical IP extraction centralized in `src/lib/ip.ts`, trusting only the
  header named by `CLIENT_IP_HEADER` (default: rightmost X-Forwarded-For).
  `x-real-ip` / `cf-connecting-ip` are client-settable unless configured.
- Keep the session cookie derived from `SITE_URL` via `sessionCookieConfig()`:
  `Secure` only on https; never key it off `NODE_ENV` or hard-code `__Host-`.
- Credential forms that submit through a JS `onSubmit` keep `method="post"` so a
  pre-hydration submit never puts a password in the URL.
- The running app never writes into tracked checkout content (inside the checkout only
  `./data`, `tests/.tmp/…` and `.env` via env-store; the DB and the outbox never
  elsewhere in it). Keep `assertSafeDataDir` / `resolveDataPaths` on realpaths, production's "never create the DB" rule, the `0700`
  data folder with `0600` keys / outbox messages / backup archives, the shared-folder
  and owner-mismatch refusals, and filesystem paths out of `/api/health` and app errors /
  log lines.
  Backups and `migration-conflicts/` / `before-restore-*/` hold answer keys (and
  archives hold `.env` secrets); the outbox is never backed up.
- Preserve rate-limit boundaries and per-kind separation.
- Keep sign-in role-gated by household membership (student = student member,
  parent = parent or admin member), derived via `isAllowedEmail`; never leak
  whether an email is a member (no enumeration). Challenge modes keep the
  generic `sent` response (including when mail delivery fails; log `{ error }`
  only, no email, and invalidate the unused magic-link / OTP token).
  Password mode uses a generic `invalid` for unknown email / wrong password /
  wrong role.
- Re-check household membership on every `getSession()` load; a removed member
  is redirected to `/signin/invalidate` so the sealed cookie is actually
  cleared (RSC cannot persist `session.destroy()`). Invite revoke sets
  `revoked_at` (never DELETE while `magic_tokens.invite_id` still references
  the row; `consumed_at` means accepted).
- Keep magic-link tokens hashed at rest and single-use; the token carries the role.
  A failed send after issue invalidates that unused token (row-id consume). Token
  verification lives in a **Route Handler** (`src/app/signin/verify/route.ts`), never a
  Server Component page — clicking the email link is a GET that writes the session cookie,
  and cookie mutation is illegal during a render. Failures redirect to `/signin/verify/error`.
  `/signin/verify` and `consumeMagicToken` only succeed when `AUTH_MODE` is
  `magic-link`. They refuse `otp:` bearers; local OTP is `verifyLocalOtp` only.

## Review guidelines

Codex reads this section when it reviews a PR. Flag as high priority (P0/P1):

- Anything that could ship an answer key, rubric or `provenance` to the browser:
  imports of `*.server.ts` or `server-only` modules from client code, or `answer` /
  `rubric` fields in `src/lib/exam/data.ts`, generated public JSON or component props.
- Trusting the client's score, a client-supplied user id, or writing another
  user's attempts / sessions (writes go to `session.userId` only).
- Membership enumeration: any response, error or timing branch that differs for
  invited vs unknown emails; skipping the dummy scrypt; splitting the `signin` bucket.
- Weakened auth: tokens stored unhashed or reusable, OTP / reset guess locks reset on
  re-issue, a bypassed Turnstile check when captcha is on, IP read from a header other
  than `CLIENT_IP_HEADER`, `secure: isProd` on the session cookie, credential forms
  without `method="post"`.
- Cross-household reads (anything besides `resolveChildren` crossing user ids).
- Free-text grading that can throw, stub in production without `GRADING_STUB=1`, log
  answer / rubric / key text, or UI copy that promises later marking.
- Any runtime write inside the checkout besides `.env` via env-store (content,
  registrars, `.examify-ingest/`, outbox, a content path from `process.cwd()` /
  `findRepoRoot`); writes to `.env` or the data folder reachable by a non-admin, or
  without `requireOnboardingAdmin()`; a filesystem path in `/api/health` or an app error /
  log line.
- Env validation that fails open in production.

Also check: happy + failure tests for new actions / route handlers, docs updated in
the same PR (`README.md`, `CLAUDE.md`, `AGENTS.md`, `.env.example`), and no new
source-text regex tests (assert behaviour, not file contents).

## PR checklist

Include in PR body:

- Routes touched.
- Tests added/updated.
- Command output summary for lint, typecheck, unit, build, and e2e (or explicit reason e2e was skipped).
