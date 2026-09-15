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
  exact paper via `resolveExamPaper` (no re-shuffle).
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
  then `pnpm examify-ingest validate` → `emit --dry-run` → `emit --apply`
  (emit is dry-run by default; never clobbers any sample-bank id without
  `--replace-sample`; partial emit (explicit IR files or mixed file+dir argv)
  merges `subjects.json`; a whole-tree emit of subjects directories only
  (`content/subjects`) deletes leftover generated subject JSON). The live app
  reads `content/generated/` at request time so a production Apply is visible
  without rebuilding. Guide: `docs/content-authoring.md` and
  `tools/examify-ingest/README.md`. Generate writes IR only — still
  validate → emit --dry-run → emit --apply. It never auto-applies.
  `generateSubject` accepts optional `AbortSignal` (forwarded to provider
  HTTP/CMD; abort throws and writes no IR, IR cache, page-raster cache, or
  run manifest). Cloud
  providers fail closed without an env key (generate also reads repo `.env` /
  `.env.local` for unset keys); `--provider test` is the CI
  fixture. OpenAI-compatible generate refuses PDF-only input when no page
  images were rasterized. Run cache/manifests are gitignored under
  `.examify-ingest/`.
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
- Parent→child linking is per-household in SQLite: `resolveChildren(parentEmail)`
  in `src/lib/progress.ts` returns only students who share that parent's household — a
  parent never sees another household's child. It's the privacy boundary; keep it isolated.
  The dashboard lists every household student and compares against a selected child.
  The comparison's "score by attempt number" axis uses `getScoreHistory()` (uncapped,
  oldest-first) rather than the 50-capped `getProgressForUser`.
- Access is invite-only. First-run `/setup` (`bootstrapHousehold`) creates the admin
  when no household exists, and only after `SETUP_BOOTSTRAP_SECRET` matches (required
  in production; captcha is not identity). After bootstrap, `/onboarding` lets the
  household admin add subjects, attach local PDFs, choose an AI mode, optionally
  run `examify-ingest generate` (BankIR only; never emit/apply; cancel
  POSTs `/api/onboarding/cancel-generate` so the token is not queued
  behind generate, then skips the IR write — provider abort is a
  parallel Ingestion PR — and does not replace prior IR; the wizard
  waits for an `ok` cancel response before claiming cancelled; cancel after
  IR commit is `already_committed`; an acknowledged cancel unlocks nav while
  the provider is still pending; cancelled is a
  calm status, not an error toast; delete/rename wait on the generate
  lock and re-check the admin gate after the wait; subject
  ids must be in the wizard catalog; OpenAI mode can set / rotate / clear
  `OPENAI_API_KEY` in the same repo-root `.env` as `install.sh` and
  `examify-ingest generate` (shared `findRepoRoot`; never echoed; host-injected
  keys — exec environ assignment, including empty / `test` — are not rotatable in the wizard); skip / Back / desktop rail lock while
  generate is in flight so Cancel stays reachable), and emit
  BankIR via `examify-ingest` (directory-only, Review / dry-run HITL before apply,
  empty catalog fail-closed; `--replace-sample` only behind an explicit advanced
  toggle). `/onboarding` is one stage at a time: desktop ≥900px uses a left step
  rail + stage + sticky footer; mobile uses compact “Step N of M · Label”
  progress and a sticky bottom bar.
  Apply re-hashes the current plan and refuses if it differs from the confirmed
  dry-run (never applies an unconfirmed plan). Finish requires that confirmed
  apply; skip-without-emit matches Welcome skip (sample bank + dashboard chip).
  Delete does not write generated files; prune runs on confirmed apply.
  Invited members never see it.
  Existing households are migrated as already complete.
  Parents/admins mint invite links
  (`createInvite`); accept goes through `/invite/[token]` using the configured
  `AUTH_MODE` (password, magic-link verify, or local OTP). In `password` mode the
  invitee must confirm a mailbox OTP before membership / `emailVerifiedAt`
  (`completePasswordInvite`); the token must carry `invite_id` (also refused
  inside `consumeHashedBearer` when a password is being set), and a failed
  send after issue invalidates the unused OTP. `invite-invalid` does not burn
  leftover sign-in OTP guesses. Missing mail fails closed.
  Treat links as secrets
  and do not post them publicly (`SECURITY.md`). Do not bring back a
  required `FAMILIES` env allowlist. A leftover `FAMILIES` JSON is imported once
  if the DB has no households. Production boot fails if `FAMILIES` is set and invalid.
- **Auth mode** is `AUTH_MODE` (`password` | `magic-link` | `local-otp`, default
  `magic-link`). `install.sh` writes it. Password sign-in needs no mail;
  password-mode invite accept still sends a mailbox OTP. Magic-link /
  local-otp use `MAIL_TRANSPORT` (`auto` / `resend` / `smtp` / `outbox`).
  Production `local-otp` or explicit `outbox` requires `ALLOW_LOCAL_OUTBOX=1`.
  SMTP AUTH/DATA requires TLS (STARTTLS or `SMTP_SECURE`) unless
  `SMTP_ALLOW_INSECURE=1`. `SMTP_FROM` is required only when SMTP is the
  active transport. Household membership remains the privacy boundary; every
  mode issues the same session shape. Local OTP locks a challenge after 5
  well-formed wrong guesses.

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

## Deployment constraints

- SQLite path should remain runtime-mounted (e.g., `file:/data/app.db`).
- Run migrations at startup (runtime), not build-time.
- Keep `/api/health` lightweight and reliable.
- Preserve fail-closed env validation in production.

## Security invariants (do not weaken)

- Never bypass server-side Turnstile verification when either Turnstile key is set.
  When both site and secret keys are unset, skip the widget and verification so
  sign-in still works. Exactly one key in production crashes boot.
- Keep canonical IP extraction centralized in `src/lib/ip.ts`.
- Preserve rate-limit boundaries and per-kind separation.
- Keep sign-in role-gated by household membership (student = student member,
  parent = parent or admin member), derived via `isAllowedEmail`; never leak
  whether an email is a member (no enumeration). Challenge modes keep the
  generic `sent` response (including when mail delivery fails; log server-side).
  Password mode uses a generic `invalid` for unknown email / wrong password /
  wrong role.
- Re-check household membership on every `getSession()` load; a removed member
  is redirected to `/signin/invalidate` so the sealed cookie is actually
  cleared (RSC cannot persist `session.destroy()`). Invite revoke sets
  `revoked_at` (never DELETE while `magic_tokens.invite_id` still references
  the row; `consumed_at` means accepted).
- Keep magic-link tokens hashed at rest and single-use; the token carries the role. Token
  verification lives in a **Route Handler** (`src/app/signin/verify/route.ts`), never a
  Server Component page — clicking the email link is a GET that writes the session cookie,
  and cookie mutation is illegal during a render. Failures redirect to `/signin/verify/error`.
  `/signin/verify` and `consumeMagicToken` only succeed when `AUTH_MODE` is
  `magic-link`. They refuse `otp:` bearers; local OTP is `verifyLocalOtp` only.

## PR checklist

Include in PR body:

- Routes touched.
- Tests added/updated.
- Command output summary for lint, typecheck, unit, build, and e2e (or explicit reason e2e was skipped).
