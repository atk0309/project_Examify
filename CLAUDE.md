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
and one **family data folder** (`EXAMIFY_DATA_DIR`: the SQLite file, the mail outbox and
everything the wizard writes) on persistent storage. The running app never writes into
tracked checkout content (see "Family data folder invariants").

Surface:

- **`/`** — the app. A server gate: no session → redirect to `/signin`. A `student`
  session renders the client `ExamApp` (dashboard → difficulty → exam → results, plus
  a "Your progress" screen); a `parent` session renders `ParentDashboard` (the child's
  progress, the parent's own progress, and a parent-vs-child comparison). A parent can
  enter **student mode** ("Are you smarter than your kid?") to get the full
  `ExamApp` themselves; their attempts persist under the parent's own account, never the
  child's.
- **`/setup`** — first-run household bootstrap (only when no household exists).
  `SetupForm` reads submitted FormData (autofill-safe), keeps inputs
  uncontrolled, and re-reads / restores a FormData snapshot if a Turnstile
  remount wipes values. First-paint default household name (“Our family”)
  does not seed that snapshot; silent autofill is captured so a remount
  can restore it. A user-cleared password or confirmation is never
  resurrected from an old snapshot. It never silently disables Create household.
  Password mode asks for the admin password twice; a mismatch is refused
  and scrypt still runs only after Turnstile, the sign-in rate limit, and
  `SETUP_BOOTSTRAP_SECRET`.
  Field-level / `aria-invalid` errors explain what failed and drop on the
  next successful edit of that field or on resubmit. Email is the required
  admin account id in every `AUTH_MODE` (including password).
- **`/onboarding`** — post-bootstrap content wizard (household **admin** only, while
  `onboarding_complete` is false). Welcome → subjects → PDF dropzones → AI setup
  (optional `examify-ingest generate` after files + mode; Anthropic / OpenAI
  modes can set / rotate / clear `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in
  the same repo-root `.env` as `install.sh` and `examify-ingest generate`
  (shared `findRepoRoot`, never `process.cwd()`), never echoed; a
  host-injected usable key is not rotatable in the wizard; a boot
  `ANTHROPIC_API_KEY=test` sentinel stays “not configured” but Clear/Rotate
  remain available after the first Save; Claude Code / Codex modes
  (`claude-cli` / `codex-cli`) run the household's signed-in CLI with no API
  key, and the card says “Found” when the binary resolves, never its path;
  Local endpoint passes only `EXAMIFY_LLM_BASE_URL` and needs
  `EXAMIFY_LLM_MODEL`, Local command passes only `EXAMIFY_INGEST_LOCAL_CMD`
  (`localTransportForOnboardingAiMode`); every card shows
  `onboardingAiCapabilityLine`: how it reads PDFs, how it signs in) → validate → Review
  (dry-run HITL) → apply → ready. The wizard is one stage at a time: desktop
  (≥900px) uses a left step rail + stage + sticky footer; mobile uses compact
  “Step N of M · Label” progress and a sticky bottom bar. Everything the
  wizard reads and writes — subjects, uploaded PDFs, BankIR, generated JSON,
  `.examify-ingest/` — is the **family layer** in the family data folder
  (`getOnboardingContentRoot()` → `getDataPaths().familyRoot`), never the
  checkout; only API keys go to the checkout `.env`. Its emit never plans the
  registrars, and Apply refuses (`invalid`, “refusing to write outside the
  family data folder”) any planned path outside `<familyRoot>/content/generated`,
  judged on realpaths (`plannedInsideFamilyGenerated`: that folder must resolve
  inside the family root and every file's folder inside it, so a symlinked
  `content/generated`, `questions/` or `keys/` into the checkout is refused) and
  re-checked by `applyEmit({ familyRoot })` right before each write. The wizard's other
  writes (add / rename / delete a subject, attach / detach a PDF, the generate IR
  commit) return `unsafe_path` (“Nothing was written: a folder or file inside the family
  data folder is a link…”) when any existing path component below the family root is a
  symlink, a dangling one included (`isFamilyWritePathSafe` in `content-root.ts`: lstat
  of each component, right before the write; generate checks before the provider call
  too). The family root itself was vetted on realpaths by the resolver.
  The subject list shows family subjects only (committed biology / demo are
  not there); the dry-run's `shadows` (family ids that are committed generated
  ids) render as a Review notice (“Replaces built-in subject: Biology”), the
  add form shows `wizard-subject-id-builtin-hint` for a committed id, and the
  power-user CLI hints name the folder via the snapshot's `dataDirDisplay`
  (`data`, `data/<sub>`, or the absolute path). Generate writes BankIR
  only and never auto-applies. Adding a subject writes `subject.json`
  only — no empty/placeholder `bank.ir.json`. Overwrite / skip / generate
  use shared `hasExistingBankIr` (empty / valid zero-item ≠ existing;
  corrupt / unparseable / invalid schema needs force; never `existsSync`
  on the IR path). A real existing `bank.ir.json` is never
  silently clobbered: the dry-run/preview names `would overwrite <rel>`
  and the wizard asks a calm confirm before any write (“Replace existing
  BankIR for {label}?” or a named generate-all batch). Decline
  keeps prior bytes (`skipped` / cancelled — not a failure); confirm
  writes through shared `writeBankIrAtomic` (CLI `--force` for that subject).
  Cancel POSTs `/api/onboarding/cancel-generate` (a Route Handler, not a
  queued Server Action) so the token can land while generate is in flight,
  then aborts provider HTTP/CMD via AbortSignal and discards the preview
  (no IR write; prior IR unchanged). The wizard waits for an
  `ok` cancel response before claiming cancelled; a failed POST is an error,
  not a calm cancel. Cancel records the token even after an earlier subject
  committed, so Generate all stops before its next subject (refused as
  `cancelled` before the provider call) and an in-flight subject is aborted;
  subjects that already wrote BankIR are kept and reported (“Generate
  cancelled. Kept N subjects already generated.”). With nothing in flight
  and the token's last generate committed, the route still answers
  `already_committed` (409); a single-subject run then shows a calm
  “Generate already finished — review the new BankIR.” An acknowledged cancel unlocks
  skip / Back / rail even if the provider is still unwinding.
  User-initiated cancel is a calm status, not an error toast. Generate
  busy / progress state is set outside the async transition so Cancel
  renders during the run.
  Generate uses the household replace-sample setting (same as CLI / emit
  `--replace-sample`): a wizard subject whose id is a sample subject id
  (`maths`, `computer-science`, `geography`; `isSampleSubjectId`) is refused
  with `sample_collision` before any provider call unless that setting is
  on. The AI step shows the replace-sample toggle next to Generate when such
  a subject exists, the Subjects add form warns, and Generate all continues
  past it and names it. Generate failures return safe reason codes
  (`provider_auth`, `provider_rate_limited`, `provider_timeout`,
  `provider_unavailable`, `provider_error`, `provider_output_invalid`,
  `sources_unreadable`, `sample_collision`, `missing_cli`, `missing_local`,
  `disk`, `generate_failed`, …) with specific copy (`onboardingModeErrorCopy`:
  CLI modes name the tool and how to sign it in, never API-key copy; local modes
  name the missing setting); raw provider messages never reach the browser. Each
  failure logs one line,
  `console.warn('[onboarding] generate failed', { reason, subjectId?, status? })`
  (`subjectId` only when it is a valid kebab id, `status` only for a provider
  HTTP status); never the message, model text, paths or keys. Cancel / skip /
  overwrite-confirm are not logged.
  Uploaded PDFs are stored under a sanitised basename (`sanitizeUploadName`:
  accents folded, quotes and other punctuation dropped) instead of being
  refused; path separators / NUL are `invalid_name`, a non-`.pdf` name, an
  empty file or missing `%PDF` magic is `invalid_type`, and over 8 MiB is
  `too_large`. A different file with the same stored name becomes ` (2)`,
  ` (3)`, … via exclusive create (no clobber, never through a symlink); the
  same bytes again is a no-op.
  Generate is gated to wizard catalog subjects (`listOnboardingSubjects`).
  Delete/rename wait on the generate lock. A post-provider catalog
  re-check (#65) refuses a write if the id is gone.
  While generate is in flight, Welcome “Use sample bank”, later skip, Back,
  and the desktop rail stay locked so Cancel remains reachable.
  Finish (“Open dashboard”) requires
  a confirmed apply of that dry-run; a changed plan is refused (`stale_preview`).
  Skip-without-emit is Welcome “Use sample bank for now” / later “Skip to
  dashboard” — same skip semantics, sample bank stays usable, parent-dashboard
  “Finish content setup” chip remains. Invited students and parents never see
  it. Directory-only `examify-ingest` emit (dry-run before apply). An empty family
  tree is refused unless the family generated layer still serves subjects (the family
  deleted its last one): then Review offers a prune-only plan (catalog `[]` + deletes)
  behind the same confirmed hash and named prune confirm. Delete removes IR/source dirs only; prune of leftover generated JSON
  waits for a named HITL confirm on Apply (cancel = no deletes/writes). Ready
  lists live bank subject ids/names and question counts. Not a replacement for `install.sh`
  auth-mode picking. Existing households are backfilled complete.
  `/setup/wizard` redirects here.
- **`/invite/[token]`** — accept a household invite (password, magic-link, or local OTP).
  In `AUTH_MODE=password` the URL is a secret that starts a join; membership and
  `emailVerifiedAt` wait for a mailbox OTP (`completePasswordInvite`). The chosen
  password's scrypt hash is stored on that OTP row (`pending_password_hash`) and
  applied only when the code is consumed; the code form does not resubmit it.
  The password step reads submitted FormData and keeps email/password
  uncontrolled, so silent autofill can request a code. A short password or a
  confirmation mismatch shows a field error and does not send. Fail closed
  if mail cannot be delivered. The code screen names where that code went
  from `resolveMailTransport()` (Resend inbox, this host's SMTP, or the
  local mail outbox). When `canDeliverMailboxProof()` is false the page
  names no transport and says mail is not set up. Going back to send a new
  code keeps the email, hedges the pending code (15-minute expiry), and
  offers a way back to code entry; there is no way to finish without the
  code. See `SECURITY.md`.
- **`/signin`** — sign-in UI for the configured `AUTH_MODE` (password, magic-link, or
  local OTP) with a Student/Parent role control. Password mode can reset a
  forgotten password with a mailbox OTP (`requestPasswordReset` /
  `completePasswordReset`); the hash does not change until the code is consumed,
  and unknown addresses get the same sent screen. Redirects to
  `/setup` when the instance has no household yet. Password sign-in
  (`PasswordLoginForm`) reads submitted FormData and keeps email/password
  uncontrolled, so silent autofill can submit. The button stays enabled when
  React state is empty. A bad email or empty/over-long password shows a field
  error; wrong password, wrong role, and unknown email stay one server `invalid`.
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
- **`/api/health`** — lightweight platform healthcheck (touches the DB). Failures are
  503 `{ ok:false, reason }` with a reason code only (`unsafe_data_dir`, `db_missing`,
  `db_error`) — never `error.message`, which can carry a filesystem path.
- **`/api/onboarding/cancel-generate`** — POST; household-admin generate
  cancel. A Route Handler so the token is not queued behind the in-flight
  generate Server Action. Same-origin + session; aborts the in-flight
  AbortSignal so provider HTTP/CMD stop, then discards the preview.
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
| DB          | SQLite in the family data folder (persistent storage), via Drizzle + better-sqlite3               |
| Auth        | Host-picked mode (`password` / `magic-link` / `local-otp`) + iron-session, invite-only households |
| Captcha     | Optional Cloudflare Turnstile (off when keys unset; server-verified when set)                     |
| Email       | Resend, SMTP, or local outbox (`MAIL_TRANSPORT`); outbox gated in production                      |
| Tests       | Vitest (unit), Playwright (e2e), Cloudflare dummy test keys                                       |
| Lint/Format | ESLint 9.39 (Next 16 plugin set) + Prettier + Tailwind plugin                                     |

**Why ESLint 9, not 10?** `eslint-plugin-react@7.x` doesn't support ESLint 10 yet, and
`eslint-config-next@16` pulls it in transitively. Move both together later.

## Commands cheat-sheet

| Command                             | What it does                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Next.js dev server with Turbopack                                                              |
| `pnpm build`                        | Production build                                                                               |
| `pnpm start`                        | Run the production build (`PORT` defaults to 3000)                                             |
| `pnpm lint`                         | ESLint flat-config across the repo                                                             |
| `pnpm format`                       | Prettier write                                                                                 |
| `pnpm format:check`                 | Prettier dry-run (CI guard)                                                                    |
| `pnpm typecheck`                    | `tsc --noEmit`                                                                                 |
| `pnpm test`                         | Vitest unit suite                                                                              |
| `pnpm test:e2e`                     | Playwright e2e (`pnpm build`, then seeded + fresh + password)                                  |
| `pnpm db:generate`                  | Generate a new Drizzle migration from schema diffs                                             |
| `pnpm db:migrate`                   | Init the data folder (refuses leftover checkout content), migrate its DB                       |
| `pnpm db:studio`                    | Drizzle Studio against the local DB                                                            |
| `pnpm examify-ingest`               | Generate / validate / emit BankIR (`tools/examify-ingest`); layer from the paths               |
| `pnpm examify:data`                 | Data folder CLI `scripts/examify-data.mjs` (`paths`, `init`, `backup`, `restore`, `verify`, …) |
| `pnpm examify:backup`               | `0600` archive: DB snapshot + family content + `.env` (`--no-env`, `--out`)                    |
| `pnpm examify:restore`              | Restore an archive (server stopped; `--force` moves data aside, `--with-env`)                  |
| `./install.sh`                      | Interactive self-host install (env + data folder + mail/outbox + migrate + build)              |
| `./install.sh --upgrade`            | Backup → move checkout content → merge → install / migrate / build / verify                    |
| `./install.sh --rollback <archive>` | Back to a pre-upgrade backup's commit, data and `.env`                                         |
| `./install.sh --restore <archive>`  | New machine: install, restore the archive (and its `.env`), migrate, build                     |

## Branch + PR rules

- All development lands on a feature branch.
- **Never push directly to `main`**. Every change opens a PR.
- PR body lists routes touched and tests added (the `PULL_REQUEST_TEMPLATE.md` enforces this).
- Don't merge with a red CI. Don't merge bypassing required reviews.
- **Every PR gets a Codex review.** Opening a PR (or marking it ready) triggers one;
  after each later push that changes code, comment `@codex review` so the fix commits
  are reviewed too. Verify each finding and fix the real ones before merging.
  CodeRabbit reviews each PR to `main` once, when it opens (`.coderabbit.yaml`, no
  incremental re-reviews — it rate-limits); don't re-trigger it after fixes (Codex
  re-reviews those). Both are advisory on top of green CI. `AGENTS.md` → "Review guidelines" is what Codex checks against.

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
    api/onboarding/cancel-generate/ # concurrent generate cancel (not a Server Action)
    setup/              # household bootstrap (page); leftover /setup/wizard → /onboarding
    onboarding/         # admin-only content wizard (BankIR validate / dry-run / apply)
    signin/             # login (page); magic-link verify (route.ts) + verify/error (page)
    page.tsx            # auth gate -> ExamApp
    error.tsx           # app-level error boundary: calm copy, retry(), full reload to /
    layout.tsx          # fonts (Newsreader + Hanken Grotesk via <link>), data-theme
    globals.css         # Tailwind @theme tokens + component layer
    robots.ts           # disallow-all
  actions/              # 'use server' actions (requestMagicLink, signInWithPassword,
                        #   verifyLocalOtp, acceptInviteWithPassword, completePasswordInvite,
                        #   requestPasswordReset, completePasswordReset,
                        #   bootstrapHousehold,
                        #   onboarding (subjects/PDFs/AI mode + OpenAI key write + generate + ingest validate/dry-run/apply),
                        #   createInvite / revokeInvite / requestInviteLink, signOut,
                        #   recordAttempt, saveExamProgress + discardExamSession)
  components/
    exam/               # ExamApp (flow), ProgressView, ParentDashboard, OnboardingWizard, LoginForm, icons
    analytics/          # Plausible (opt-in)
  lib/
    exam/data.ts        # SAMPLE + generated SUBJECTS/QUESTIONS + accentCSS + buildExam
    exam/live-bank.server.ts # sample + committed (registrars) + family (data folder, per request) bank + keys
    exam/merge-generated.ts  # client-safe layer merge (composeGeneratedLayers / composeGeneratedKeys)
    exam/attempts.ts    # validate + re-score a submitted attempt; aggregate helpers (pure)
    progress.ts         # persist/read attempts; resolveChildren(parentEmail) per-family (server-only)
    exam-session.ts     # save/list/clear an in-progress exam for resume (server-only)
    households.ts       # bootstrap, invites, membership, optional FAMILIES import (server-only)
    household-types.ts  # client-safe PendingInvite type
    onboarding.ts       # first-run subjects/PDFs + examify-ingest emit (server-only)
    onboarding-generate.ts # AI-step generateSubject bridge (preview then commit if !cancelled);
                        #   maps failures to safe reason codes + one `[onboarding] generate failed` log line
    onboarding-admin.ts # shared household-admin gate for wizard actions + cancel route
    onboarding-types.ts # client-safe wizard snapshot / AI mode types
    repo-root.ts        # shared `findRepoRoot` (checkout root: env-store `.env`, data-dir, ingest keys)
    data-dir.ts         # THE family data folder resolver (getDataPaths / resolveCliDataPaths,
                        #   assertSafeDataDir, UnsafeDataDirError); relative imports, no server-only
    data-folder.ts      # initDataFolder: 0700 + `.gitignore` + marker; refuses a shared folder
    env-file.ts         # the one `.env` parser + `next start` file order (readProductionEnvFiles)
    content-root.ts     # getOnboardingContentRoot() = the family data folder (test override)
    env-store.ts        # server-only `.env` upsert/clear (ANTHROPIC_API_KEY / OPENAI_API_KEY write path)
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
  examify-ingest/       # BankIR generate + validate + emit (generate writes IR only; roots.ts picks the layer)
scripts/
  examify-data.mjs      # data folder CLI: paths / init / backup / restore / check-archive /
                        #   legacy-check / migrate-checkout / verify (plain ESM, Node builtins +
                        #   better-sqlite3)
content/                # the COMMITTED layer only (never written at runtime)
  subjects/             # BankIR sources (*/bank.ir.json): biology, demo fixture
  generated/            # public subjects/questions + server-only keys (committed; read via registrars)
  source-pdfs/          # gitignored local PDFs (committed-layer CLI work)
data/                   # gitignored default family data folder (EXAMIFY_DATA_DIR)
  app.db, outbox/, content/{subjects,source-pdfs,generated}/, .examify-ingest/, backups/
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
bank from source PDFs (and notes/text in the subject folder) kept local-only
in the gitignored `content/source-pdfs/` / subject directory.

**Two generated layers** sit on top of the sample bank (`live-bank.server.ts`):

- **Committed** (the checkout): `content/subjects/<id>/bank.ir.json` →
  `emit content/subjects --apply` writes tracked `content/generated/` **and** rewrites the
  registrars `src/lib/exam/generated-public.ts` / `generated-keys.server.ts`. The
  registrars _are_ the committed layer: they import the JSON, so it ships with the build
  (a change needs a rebuild and a commit). This is the shipped content (biology, the demo
  fixture) and what CI runs. It is not a "missing-catalog fallback".
- **Family** (the data folder): `<data>/content/subjects/<id>/`,
  `<data>/content/source-pdfs/<id>/`, `<data>/content/generated/`. `/onboarding` reads
  and writes only this layer, and the CLI uses it for `data/content/subjects` paths.
  `readGeneratedOverlay` reads its catalog on every request, so Apply → dashboard needs
  no rebuild. It is never committed and never has registrars. Its catalog rows carry
  `rev` (`planEmit({ revisions: true })` in family emits, and `migrate-checkout` for the
  rows it moves): `generatedRevision`, the
  sha256 of the exact `questions/<id>.json` bytes + "\n" + `keys/<id>.json` bytes. The
  live bank serves a row with `rev` only when the files it reads hash to it; otherwise
  the last consistent copy of that subject read in this process (kept per root + id), or
  the row is dropped (`revision_mismatch`). A crash or a request between an Apply's
  writes never pairs new questions with old keys. Rows without `rev` read as before;
  `parseSubject` and the registrars never carry it; committed emits never write it.
  `examify-data verify` recomputes it (a copy of `generatedRevision`, parity-tested) and
  fails with exit 6, `{ check: 'revision', detail: <subject id> }`, on a mismatch.
- **Precedence:** the family layer overlays the committed layer, and the result merges
  onto the sample bank under the unchanged sample-freeze rules. A family subject with a
  committed id **replaces it entirely** (its questions and keys; the tile keeps the
  committed position; `composeGeneratedLayers` / `composeGeneratedKeys` in
  `merge-generated.ts`);
  family-only subjects append. A family row counts only when its id is kebab-case, its
  `questions/<id>.json` parses with ids that subject may own, and every public question
  has a key of its type; otherwise it is dropped with one reason-coded
  `[live-bank] family subject dropped` warning (code + subject id, never a path) and a
  committed subject it would have replaced stays. No family catalog ⇒ no family layer; an
  unreadable one ⇒ none plus one `[live-bank] family catalog unreadable`.
- **The ingest CLI infers the layer** (`tools/examify-ingest/src/roots.ts`,
  `resolveIngestRoot`): each positional path is realpathed; inside the data folder ⇒
  family (tested first — `./data` is inside the checkout), else inside the checkout ⇒
  committed, else error; mixed ⇒ error. The first stderr line is
  `layer: family (<display>)` / `layer: committed (checkout)`. Emit passes
  `registrars: layer === 'committed'` (`planEmit` defaults to false, so nothing at
  runtime ever rewrites registrars); a committed `--apply` that changes files prints a
  note that it writes tracked files; a family validate / emit notes each subject that
  replaces a committed one. API keys come from the checkout `.env` / `.env.local`
  (`mergeRepoEnvFiles(repoRoot)`) in both layers.
- **Dev checkouts:** committed-layer generate / emit leaves `bank.ir.json`,
  `.examify-ingest/` and changed generated files in the checkout, which `pnpm db:migrate`
  and `install.sh` treat as leftover family content and refuse. Use
  `EXAMIFY_IGNORE_LEGACY_CONTENT=1` for `db:migrate` there; never on a real install.

Automated path: author or `pnpm examify-ingest generate` a
`content/subjects/<id>/bank.ir.json` (in the layer's root), then
`pnpm examify-ingest validate content/subjects`, `emit content/subjects --dry-run`, and
only afterward `emit content/subjects --apply` (family work: the same with
`data/content/subjects`; or use `/onboarding` after first-run bootstrap — AI-step
generate is optional, then the same directory emit on the family layer, HITL dry-run
before apply; an empty family tree is only a confirmed prune of leftover family files).
Hand-authored biology has no source file — skip generate (validate/emit only).
A committed generate fixture is `content/subjects/demo/notes.txt`
(`pnpm examify-ingest generate --provider test --seed 0 content/subjects/demo`).
Generate scans notes/text (`.txt` / `.md`) and images in the subject folder
plus PDFs under `content/source-pdfs/<id>/`; uploaded PDF magic-byte checks
stay `%PDF`. Generate never auto-applies; it writes IR + gitignored
`.examify-ingest/` run/cache files only. A real BankIR with questions is
not overwritten unless `--force` (`--dry-run-ir` says **would overwrite**)
when `hasExistingBankIr` is true. Empty / placeholder IR (empty file, valid
zero-item schema) is non-existing for that gate. Corrupt / unparseable /
invalid-schema IR requires `--force` (error names corruption, not empty).
Frozen sample-bank ids fail closed at generate (same set as validate) unless
`--replace-sample` — **no BankIR written** (do not imply `bank.ir.json`
already exists) —
`--provider test` must not write `maths-easy-1` / other SAMPLE ids without
that flag. Missing cloud keys are refused before overwrite messaging when
a real key is required; `--provider test` still runs without keys. Persist
uses shared `writeBankIrAtomic` (force required to clobber real IR). Tree
generate drafts every subject before the first IR write (sources, overwrite,
SAMPLE freeze, provider) so a mid-list failure leaves no BankIR. A
sourceless sibling blocks `generate content/subjects` and hints to target
`content/subjects/<id>` or `--subject <id>` (e.g. demo). Persist of a tree is one abort gate then a transactional commit
(any later write rolls back earlier BankIR / IR cache / manifest / page cache). The `/onboarding` generate path calls that same helper: named
confirm supplies `force`; decline/cancel keeps prior bytes; the household
replace-sample setting is passed as `replaceSample`. `generateSubject` accepts optional `AbortSignal` (forwarded
to provider HTTP/CMD; abort throws and writes no IR, IR cache, page-raster
cache, or run manifest). Generate throws typed errors so callers never parse
messages: `ProviderFailureError` (`kind` `http` / `timeout` / `unreachable` /
`output` / `command` / `auth`, plus HTTP `status`), `SampleIdCollisionError` (`ids`),
`UnreadableSourcesError`, `CliNotFoundError` (`cli`; a `ProviderConfigError`). The provider HTTP call and its body read sit inside
one `withProviderSignal` boundary, so a deadline / cancel / dropped connection
while the body is still arriving is typed too. CLI messages are unchanged except
the fetch deadline (`provider request timed out after 180000ms`) and a 200 whose
body is not JSON (`<provider> returned a body that is not JSON`). Cloud
providers fail closed without an env key (generate also fills unset keys from
repo `.env` / `.env.local`); `--provider test` is the CI
fixture. OpenAI-compatible and Codex generate fail closed when the only sources are
PDFs and no page images were rasterized (`pdftoppm` from poppler-utils).
`--provider claude-cli` (`claude -p`, stream-json in/out, the Anthropic
provider's content blocks, so PDFs go as documents) and `--provider codex-cli`
(`codex exec --json`, prompt on stdin, images as `--image` files) use the CLI's
own sign-in: binary from `EXAMIFY_CLAUDE_BIN` / `EXAMIFY_CODEX_BIN`, `PATH`, then
`~/.local/bin`; model from `--model`, `EXAMIFY_CLAUDE_MODEL` /
`EXAMIFY_CODEX_MODEL`, else the CLI's own (`default` in the manifest); a
10-minute deadline (`CLI_PROVIDER_TIMEOUT_MS`). Both run through
`providers/command.ts` (shared with the local command: abort / deadline kill the
process group). Local HTTP sends `--model`, else `EXAMIFY_LLM_MODEL`, else `local`
(`GenerateProvider.modelEnv`). The local transport (command / endpoint) is part of
the cacheKey (`GenerateProvider.transport`; absent for every other provider, so their
keys are unchanged), so one transport never serves the other's cached IR; wizard
Local command also drops `EXAMIFY_LLM_MODEL`, which the command never gets.
`emit` is dry-run by default;
`--apply` writes the layer's `content/generated/` (public
subjects/questions + server-only keys, `0600` in a `0700` folder). Keys stay
server-only. Any id already in
the sample bank is refused unless
`--replace-sample`. A partial emit (explicit IR files or mixed file+directory
argv) merges `subjects.json` by id and leaves other generated subject files in
place. A whole-tree emit of subjects directories only (`content/subjects`) is
authoritative for generated subjects: leftover `questions/<id>.json` /
`keys/<id>.json` (and the `subjects.json` row) for an id with no IR in that
tree are deleted. `--apply` writes every file atomically (temp + rename, `writeFileAtomic`)
in a fixed order — questions + keys, then registrars (committed layer only), then
`subjects.json` last (the live bank reads the catalog first, so it is the commit point)
— and unlinks leftovers only after every write. In the family layer each catalog row's
`rev` names the questions + keys it was written with, so a reader between those writes
serves the previous revision instead of a mix. The sample bank is never touched.

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
  membership, stamps `emailVerifiedAt`, and stores the password hash. The token
  must carry `magic_tokens.invite_id` (a leftover sign-in OTP is refused).
  `consumeHashedBearer` also refuses when a `passwordHash` is supplied and
  `invite_id` is null — not only via the call-site `requireInviteId` flag.
  `invite-invalid` does not record an OTP guess (leftover sign-in codes stay
  usable). Email-lock only chooses which mailbox we send to. Missing mail
  transport fails closed (`send_failed`) instead of trusting the URL; if
  `sendEmail` fails after issue, the unused OTP is invalidated and its pending
  hash is cleared. Parent invites stay email-locked; do not post links publicly.
  Forgot-password (`reset:` bearer) is a separate consume path: it does not
  stamp `emailVerifiedAt`, does not attach membership, and `/signin/verify`
  refuses the bearer. See `SECURITY.md`.
- **No enumeration.** Challenge modes (`magic-link`, `local-otp`): `requestMagicLink`
  always returns the generic `sent` state once Turnstile (when enabled) + rate-limit
  pass; it only issues a link/code when the email is a household member for that
  role. Don't add a branch that reveals whether an email has been invited —
  including delivery failure (log `{ error }` only — no email or other
  identifiers — still return `sent`; invalidate the unused token so it cannot
  complete sign-in). Email-locked
  invites use the same generic `sent` copy when the address does not match.
  Password mode: `signInWithPassword` always returns generic `invalid` for unknown
  email, wrong password, wrong role, or a user with no hash (after a dummy scrypt).
- **The "sent" screen resets via client state, not navigation.** `LoginForm` lives on
  `/signin`, so "Use a different email" can't be a `<Link href="/signin">` — that's a
  same-route soft nav that never remounts the component, leaving `useActionState` at
  `status: 'sent'` (the button looked dead). It toggles a local `dismissed` flag back to
  the form; the `submit` wrapper clears `dismissed` so a fresh send re-shows the screen.
- Turnstile is **never** bypassed server-side **when captcha is enabled**.
  Captcha is off by default. Set `TURNSTILE_ENABLED=1` and both
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to enable it;
  when the flag is unset, the widget is omitted and `verifyTurnstile`
  returns ok (keys alone do not enable captcha). When captcha is on,
  `verifyTurnstile()` never short-circuits to ok (partial config fails closed).
  The login / setup / invite-accept actions still call `verifyTurnstile()` with
  the client's token before issuing anything.
- IP extraction always goes through `src/lib/ip.ts`, and trusts exactly **one**
  header: `CLIENT_IP_HEADER` (default `x-forwarded-for` → its **last** entry, the
  hop the nearest proxy appended; the first entries are client-controlled).
  `x-real-ip` and `cf-connecting-ip` are ordinary request headers a client can
  send (nginx / Caddy pass a client-sent `CF-Connecting-IP` through), so they are
  **never read unless configured**. XFF is parsed only in `x-forwarded-for` mode: if
  a configured `x-real-ip` / `cf-connecting-ip` is absent or invalid the result is
  `0.0.0.0` (one shared bucket), never an XFF fallback — XFF is client-controlled in
  exactly the setups that pick those modes. An unknown value fails boot.
  Don't read these headers in handlers and don't restore the old cf → x-real-ip →
  XFF precedence (it let a client rotate "IPs" past every per-IP bucket).
- Rate-limit windows are tracked in `rate_limit_events`. Sign-in uses a **single**
  `signin` bucket (10/IP/hour by default) for every request, regardless of whether a user
  row exists — a per-state threshold would leak whether an email is a returning/approved
  user even behind the generic "sent" copy. Don't split it back into signup/login.
  Per-account buckets share the table under a synthetic `ip` (no migration):
  **password sign-in** `pw:{email}` (every role and IP) allows
  `PASSWORD_FAILURE_MAX` (10) failures per 15 min, is checked before scrypt,
  records every `invalid` outcome for any email (known or not, so a lock reveals
  nothing), and is cleared by a successful sign-in or password reset; locked →
  `rate_limited`. **Mailbox codes** use `otp:{email}:{role}` (local OTP, invite
  OTP) and `reset:{email}:{role}`: after `OTP_GUESS_MAX` (5) well-formed wrong
  guesses in the 15-min window, outstanding codes are consumed and verification
  returns `locked` (shown as `rate_limited`) **even for a correct code**.
  **Re-issuing a code never clears a guess bucket** — clearing it gave five fresh
  guesses per new code (reset-code cycling → account takeover). Non-6-digit input
  and `invite-invalid` do not count. Rows older than 7 days are purged globally
  (`purgeStaleRateLimitEvents`), which `checkRateLimit` runs at most once an hour
  per process — the scan is unindexed, so never per request.
- `/setup` (`bootstrapHouseholdAction`) may do the cheap password-policy check
  early, but `hashPassword` (scrypt) runs only after Turnstile, the sign-in
  rate-limit, and `SETUP_BOOTSTRAP_SECRET` all pass.
- Magic-link tokens are stored **hashed** at rest (`sha256`), single-use (a `consumed_at`
  timestamp marks them spent inside the same transaction that resolves the user), and 15
  minutes long. The token carries the **role** so verify can set `session.role` without
  re-checking env. If `sendEmail` fails after issue, that unused token is
  invalidated (same row-id consume as invite / local OTP) so a dangling bearer
  cannot complete sign-in. `/signin/verify` and `consumeMagicToken` only succeed when
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
- **The session cookie follows `SITE_URL`, not `NODE_ENV`.** `sessionCookieConfig()`
  (`src/lib/env.ts`) is the only source of iron-session's cookie name + `secure`:
  `Secure` exactly when `SITE_URL` is `https:`; the default name is
  `__Host-examify_session` on https and `examify_session` on plain http. Browsers
  drop a Secure cookie over http and a `__Host-` cookie without Secure, so keying
  either off `NODE_ENV` bounced LAN hosts and `pnpm dev` to `/signin` forever. An
  explicit `__Host-` / `__Secure-` `SESSION_COOKIE_NAME` with a non-https
  `SITE_URL` fails production boot (dev keeps it with a warning).
- **Credential forms post natively.** Forms that carry a password, setup code or
  API key and submit through a JS `onSubmit` keep `method="post"`: a submit before
  hydration otherwise falls back to a GET and puts the secret in the URL, browser
  history and proxy logs.

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
  not the navigation `subject`, so browsing other tiles can't mis-label a draft. A waiting
  debounced autosave is **sent, not dropped**, when the exam is left: Home, starting/resuming
  another exam, Finish (queued ahead of `recordAttempt`), and before `setStudentMode(false)`. It
  is also sent best-effort on `visibilitychange` → hidden and `pagehide`; a Server Action can't
  use `sendBeacon`, so an unloading page may still drop it. Autosave and discard rejections are
  swallowed (`unstable_rethrow` still lets Next redirect / not-found through): local state is kept
  and the next checkpoint re-sends the full snapshot. If `beginExamSession` never succeeded for a
  combo, the next checkpoint retries `beginExamSession` (upsert) instead of the update-only save;
  this is safe because Next dispatches Server Actions one at a time and finish/discard end the
  retrying. `saveExamProgress` itself stays update-only. Exams left for another one this session
  are kept in memory ("parked"): the dashboard lists the live exam, then parked drafts (newest
  first), then the page-load `resumable` drafts. An in-memory copy always wins over the page-load
  snapshot of the same combo, so resume never rolls back answers given this session.
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

- **Agent CLIs get nothing but the request.** `claude-cli` / `codex-cli` run with
  no tools (`--tools ""`; Codex: `--sandbox read-only`, shell / apps / plugins /
  browser / image features off, `web_search="disabled"`, `--ignore-user-config`),
  in an empty private `0700` temp folder (`safeTempRoot` in `temp-root.ts`, which
  PDF page rasterizing also uses: the system temp folder, else `/tmp`, whichever
  realpath is outside every Examify checkout, so a `TMPDIR` pointing into it
  changes nothing; never the checkout, so no project
  `CLAUDE.md` or settings load; removed afterwards), with no saved session
  (`--no-session-persistence` / `--ephemeral`, `--strict-mcp-config`), none of the
  service user's own customizations (Claude: `--setting-sources project`, the
  project being that empty folder, plus `CLAUDE_CODE_SAFE_MODE=1`, so no user
  `CLAUDE.md`, hooks, plugins or skills: a `UserPromptSubmit` hook would otherwise
  get the untrusted study text on stdin; Codex: `--ignore-user-config`, though its
  global `$CODEX_HOME/AGENTS.md` still loads) and only the
  `agentCliEnv` allowlist (PATH, HOME, locale, XDG, proxy / CA, the CLI's own
  config dir and headless token; `TMPDIR` / `TMP` / `TEMP` are replaced by the
  private run folder, never the host's). Never add Examify secrets,
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to that allowlist (the `test` sentinel
  would also break the CLI's own sign-in), and never grant file, command or web
  tools: study files are untrusted input.

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
  Live `ANTHROPIC_API_KEY` is read from `process.env` only (never the boot-frozen
  `env.ts` snapshot) so a wizard set / rotate / clear is visible on the next
  grade. The `test` sentinel stubs only when `gradingStubAllowed()`:
  `NODE_ENV !== 'production'` or `GRADING_STUB=1` (both read live; the
  Playwright configs set the flag because `next start` runs as production). In
  production without it the sentinel is no usable key → `needs_review`, never a
  silent full-marks default (`install.sh` writes `test` for a blank key prompt).
  A missing key after clear is fail-closed (`needs_review`, no stub) — same
  usable-key rule as the Configured badge. Blank / missing is never treated as
  `test`. `ANTHROPIC_API_KEY` is optional in `env.ts` (wizard clear + production
  restart must not brick boot). Every `needs_review` logs one
  `[grading] free-text answer not marked` warning with a reason code only
  (`no_key`, `stub_disabled_in_production`, `http_<status>`, `timeout`,
  `network_error`, `bad_json`, `bad_shape`) — never the answer, question, rubric,
  key, an error message (it can quote model text) or a user id.
- **A free-text item is "correct" at `PASS_THRESHOLD` (0.6).** `isFreePass(score, maxScore)`
  (`attempts.ts`, the shared constant — not an inline literal) decides the ring/tally. A
  `needs_review` item persists `score: null, verdict: null` and counts as incorrect.
- **Render only the bounded verdict.** The UI shows only `Verdict` fields (`score`, `verdict`,
  `gotRight`, `toReview`, `spelling`) — never the rubric, never raw model text. `needs_review`
  renders `NEEDS_REVIEW_COPY` (`attempts.ts`): nothing re-grades it, so the copy says it
  counts as not correct and must never promise later marking.
- **Results are server-driven.** Because the client holds no answer keys, it can't self-score:
  on finish `ExamApp` submits, shows a "Marking…" state, and renders from the returned
  `AttemptRecord`. Two failure cases: (1) a submit that never came back (a rejected Server
  Action: dropped connection, server restart, a redeploy that retired the action id, or a server
  exception) keeps the answers in memory and shows `exam-error-unreachable`; "Try again"
  (`exam-retry`) re-sends the identical payload. (2) an `ok:false` result (`invalid` |
  `forbidden`) is deterministic, so it shows `exam-error-refused` with no retry and drops that
  exam's local resume card. Next redirect / not-found errors still propagate
  (`unstable_rethrow`). Known limitation: a retry after a lost response (the server saved the
  attempt but the reply never arrived) records a duplicate `exam_attempts` row — there is no
  idempotency key yet. Anything else that throws on the client lands on `src/app/error.tsx`, a
  calm app-level boundary (retry, or a full reload to `/`). Every `ExamApp` instance can submit (the `/` gate
  only renders it for a student or a parent in student mode), so there is no `canRecord` prop.

## Family data folder invariants

These are non-negotiable. Don't "fix" them out.

- **The running app never writes into tracked checkout content.** Every piece of family
  state — SQLite DB, mail outbox, wizard subjects / uploaded PDFs / BankIR / generated
  questions + keys, ingest caches and run manifests, backups — lives under one family
  data folder resolved by `src/lib/data-dir.ts` (`getDataPaths()` at runtime; content I/O
  goes through `getOnboardingContentRoot()`); data folder = `EXAMIFY_DATA_DIR` → else the
  folder of an explicit SQLite `DATABASE_URL` outside the checkout → else `./data`.
  Inside the checkout the only runtime writes are `./data` (gitignored), `tests/.tmp/…`
  (the suites) and the repo-root `.env` through `env-store.ts` (wizard API keys,
  `findRepoRoot`), besides Next's own `.next/`. Dev/test only: outside production
  `RESEND_API_KEY=test` (or `NODE_ENV=test`) keeps the outbox in `tests/.tmp/outbox`. Never resolve a runtime content path from
  `process.cwd()` / `findRepoRoot`, never rewrite registrars at runtime, and never write
  `content/`, `.examify-ingest/` or `src/` from the app or a test (CI fails on it). So
  `git pull` never conflicts with family content, and a re-clone loses nothing when the
  folder is outside the checkout.
- **Resolution** (`resolveDataPaths`): data folder = `EXAMIFY_DATA_DIR` (relative → the
  checkout root, never cwd) → else the folder of an explicit SQLite `DATABASE_URL` when it
  is fully outside the checkout (a `file:/data/app.db` volume keeps family content next to
  its DB) → else `./data` (gitignored `/data`). DB = explicit `DATABASE_URL` (existing
  installs keep theirs), else `<data>/app.db`. Outbox = `MAIL_OUTBOX_DIR` (relative → the
  checkout), else `<data>/outbox`; a production host with the `test` sentinel still gets
  `<data>/outbox`, and only with `ALLOW_LOCAL_OUTBOX=1`. The runtime reads `process.env`
  (Next loaded the env files). CLIs (`db:migrate`, drizzle-kit, `examify-ingest`,
  `examify-data.mjs`) use `resolveCliDataPaths`: the repo env files in `next start` order
  (`.env.production.local` > `.env.local` > `.env.production` > `.env`; the first file
  that defines a key wins, even empty; a process env value that is set wins over the files,
  even an empty one, exactly as `@next/env` keeps it, and the resolver treats blank as
  unset like the app)
  via `env-file.ts`, the single `.env` parser.
- **Safety** (`assertSafeDataDir`, on realpaths so a symlink can't route around it): never
  the checkout or a folder that contains it (`checkout_root`); inside the checkout only
  `data/…` (plus `tests/.tmp/…` for the suites) (`inside_checkout`); an
  `EXAMIFY_DATA_DIR`, `DATABASE_URL` (after `file:`) or `MAIL_OUTBOX_DIR` value starting
  with `~` or containing a quote, backtick, newline, `$` or ` #` is `bad_value`
  (`assertPathValue`; `.env` can't carry it / Next expands `$VAR` but CLIs reading the
  files do not, so `db:migrate` could open another database; `install.sh` expands a
  leading `~` in the data folder before writing and refuses such kept values, naming the
  file). `UnsafeDataDirError` messages name the variable, never the path or value. A
  data folder that is a file, or one this user cannot read or create (ENOTDIR, EACCES,
  EPERM, ELOOP, …), is `unreadable`: `data-folder.ts` maps those errors (Node's messages
  name the path) so boot reports an env issue, `db:migrate` one line, and the CLI exit 3.
  Only ENOENT means "not created yet": existence is a `stat` (never `existsSync`, which
  is false for EACCES / ELOOP / ENOTDIR too and would pass an unusable folder at boot).
  Production boot fails on an unsafe folder, on a folder shared with other software
  (an existing folder without the marker holding files Examify does not recognise —
  e.g. the folder of `DATABASE_URL=file:/root/examify.db` is `$HOME`), and when neither
  `EXAMIFY_DATA_DIR` nor `DATABASE_URL` is set. The database and the mail outbox (bearer
  tokens) follow the same inside-checkout allowlist: a `DATABASE_URL` or
  `MAIL_OUTBOX_DIR` inside the checkout outside `data/…` / `tests/.tmp/…` is refused by
  the resolver itself (`db_inside_checkout` / `outbox_inside_checkout`, messages without
  the path), so production boot, `db:migrate`, `examify-data paths --check` (and with it
  `install.sh`) and the ingest CLI all fail on it. The outbox is never backed up, so it
  must not overlap a tree a backup copies (`content/{subjects,source-pdfs,generated}`,
  `.examify-ingest`, `migration-conflicts`): not the data folder, not a folder containing
  it, not one of those trees and not inside one (a subject folder would drop that whole
  subject) — `outbox_overlaps_data`, refused by the same resolver. The backup walk still
  skips the outbox's canonical path, so a symlink to it from a family tree is not
  followed.
- **Production never creates the database.** `openSqliteFile(dbPath, { mustExist: isProd })`
  throws `DatabaseMissingError` for a missing file and creates nothing: an unmounted
  volume must fail closed, not come up as a fresh household whose `/setup` could be
  claimed. Dev/test keep mkdir + create. `/api/health` maps failures to reason codes.
- **Initialising.** `pnpm db:migrate` (`initDataFolder`, `src/lib/data-folder.ts`) and
  `examify-data init` create the folder `0700` (chmod only when this uid owns it, else one
  warning), a `.gitignore` of `*`, and the marker `.examify-data.json`
  (`{layout:1, createdAt, migrations}`, `0600`); existing files are never rewritten. An
  existing, unmarked folder holding anything but known Examify names is refused
  (`SharedDataFolderError`, exit 5 in the CLI) before any chmod or write — a
  `DATABASE_URL`-derived folder could be `/var/lib`. `db:migrate` first refuses (exit 1,
  with `./install.sh --upgrade` / `migrate-checkout` instructions) while family content
  from an older version is still in the checkout (`detectLegacyCheckoutContent` from
  `scripts/examify-data.mjs`; skipped when git can't answer), unless
  `EXAMIFY_IGNORE_LEGACY_CONTENT=1` (dev checkouts doing committed-layer CLI work only).
- **`scripts/examify-data.mjs` is a cross-version tool.** `install.sh --upgrade` runs the
  _upstream_ copy (`git show @{u}:scripts/examify-data.mjs`) against the _old_ checkout's
  `node_modules`, so it stays plain ESM on Node ≥22 builtins plus the checkout's
  better-sqlite3 (`createRequire(<repo>/package.json)`, or `--sqlite-module` /
  `EXAMIFY_SQLITE_MODULE`), and imports nothing from `src/`. It carries a copy of the
  resolver + env parser; `tests/unit/examify-data.test.ts` runs both over one table, so
  change them together. Exit codes are a contract with `install.sh`: 0 ok, 1 unexpected,
  2 usage, 3 unsafe data folder, 4 legacy content, 5 refused (server running, owner
  mismatch, target not empty, shared folder), 6 verify failed. Every writing command —
  and `verify`, whose read-only open still creates `-wal` / `-shm` — refuses (5) when the
  euid differs from the owner of the checkout, the data folder or the DB, unless
  `--allow-owner-mismatch`.
- **Backup** (`backup`): `VACUUM INTO` on a read-only connection (one read transaction,
  WAL frames included; `SQLITE_BUSY` retried 3×; never copies the live file or
  `-wal` / `-shm`), then `integrity_check` + the `__drizzle_migrations` count on the
  snapshot. Family files: `content/{subjects,source-pdfs,generated}`,
  `.examify-ingest/runs` (+ `cache` with `--include-cache`), `migration-conflicts/`, the
  marker — never `backups/` or the mail outbox (`outbox/`, or a `MAIL_OUTBOX_DIR` that
  sits inside one of those trees: the walk skips its canonical path, a symlink to it
  included, with a warning). Every repo env file `next start` reads (`.env`,
  `.env.local`, `.env.production`, `.env.production.local`; all gitignored) unless
  `--no-env`.
  `--include-checkout` (pre-upgrade) adds the checkout's `content/**` (tracked, untracked
  and ignored), the registrars and `.examify-ingest/{runs,cache/ir}`, and records the git
  sha. `content/generated` is re-copied until every catalog row has questions + keys (no
  cross-process lock). `MANIFEST.json` lists every file with its sha256. Staged `0700`,
  tarred to a temp file, fsynced, published with `link()` + `unlink` (no clobber) as
  `examify-backup-<UTC>-<rand>[-pre-upgrade-<sha7>].tar.gz`, `0600`, in `$DATA/backups/`
  (`--out` must be outside the checkout or inside the data folder, and never inside a tree
  the backup copies — `content/{subjects,source-pdfs,generated}`, `.examify-ingest`,
  `migration-conflicts` — or the next archive would copy it; the default `backups/`
  is never created in a shared folder — `shared_folder`, exit 5, nothing created). The
  family `content/generated/**` is staged as one revision: hashed before and after
  staging and compared with the staged bytes, restaged up to 3 times, else exit 1
  `content_changing` (an Apply between copies could pair one Apply's questions with
  another's keys). Then the archive is read back
  (`tar -tzf` over the whole stream, every MANIFEST file a member, `MANIFEST.json` byte
  for byte); one that does not read back is removed and the backup fails
  (`archive_unreadable`).
- **Restore** (`restore`): refuses while Examify answers `/api/health` (any JSON body with a
  boolean `ok`, whatever the status; host `PORT`, `.env` `PORT`, 3000); lists members first and rejects links / special files / absolute / `..` paths;
  extracts with `--no-same-owner`; copies only MANIFEST-listed regular files under
  allowed prefixes after a sha256 check; refuses a snapshot with more migrations than the
  checkout's journal; refuses a non-empty target unless `--force`, which moves the DB and
  family content aside into `$DATA/before-restore-<ts>/` (never `backups/`); removes stale
  `-wal` / `-shm` before placing the DB; restores the env files only with `--with-env`
  (a current one saved as `<name>.before-restore-<ts>.local`, `0600`), checkout files only
  with `--include-checkout`. Target: with `--with-env` and no `--data-dir`, the folder
  the **restored** env files name (each archived env file, else the checkout's, in
  `next start` order — what the app will read), checked for safety, ownership and a
  shared folder like any other; otherwise the folder resolved now (`--data-dir`
  overrides). `install.sh --restore` refuses a host `EXAMIFY_DATA_DIR` / `DATABASE_URL`
  or `--data-dir` when the archive brings its own `.env`. A failure after the move-aside
  names the `before-restore-*` folder (JSON `movedAside`). Once everything is placed the
  restore never fails: its final init skips the shared-folder check the target already
  passed (the marker may be aside; a pre-data-folder archive has none) and only warns.
- **`migrate-checkout`** (the upgrade step): classifies with `git status --ignored` plus
  an lstat walk (OS junk ignored; a clean committed file with no family meaning, such as
  a README in `content/subjects/`, is ignored). Family = subjects with a real difference from `HEAD`,
  everything under `content/source-pdfs/`, `subjects.json` rows added or changed
  (compared per id with `HEAD`; questions + keys copied verbatim, missing rows rebuilt
  from the IR / `subject.json`; each row gets the `rev` of the bytes it copies, hashed
  from the same read as their sha, and neither the family catalog nor a conflict catalog
  is published if a file changed before its copy verified, or its data-folder copy
  (one found identical and not copied included) no longer hashes to it —
  `changed_during_migration`),
  `.examify-ingest/`. Registrars are never copied, only
  restored. Copy with a journal (`$DATA/.migrate-journal.json`): identical ⇒ skip, a
  destination its own unfinished run wrote ⇒ overwrite, any other difference ⇒ the
  checkout copy goes to `$DATA/migration-conflicts/<ts>/`; keys `0600`; every copy
  sha256-verified; then `checkout-content-v1` is appended to the marker. Only then
  `git checkout HEAD --` the content + registrars and unlink exactly the verified
  untracked / ignored files that are still untracked (a file `git rm --cached` had
  untracked stays: the checkout restored it), never `git clean`, never through a
  symlinked folder; prune each emptied area bottom-up (nested empty or junk-only
  folders too, never through a symlink), and assert `git status -- content src/lib/exam`
  is clean with no `content/source-pdfs/` or `.examify-ingest/` left. **Before moving
  anything** it needs a backup of what that checkout step reverts: `--backup <archive>`
  must be a complete archive (extracted into private staging in the data folder and
  checked like a restore: members, every MANIFEST file present with its size and
  sha256, a DB snapshot; so a truncated or repacked one is refused) with this checkout
  at `HEAD` and the current bytes of every tracked file it puts back (else exit 5
  `backup_mismatch`); without it, it takes its own
  `--kind pre-upgrade --include-checkout` backup. A run that only removes empty leftover
  folders takes none. Idempotent; `--dry-run` writes nothing. Deleted committed subjects
  are reported (`hiddenCommitted`) and come back.
- **`install.sh`** runs from `main()` (last line `main "$@"`), so a merge that replaces it
  mid-run can't change what executes. It never starts / stops services, never
  `git stash`es or `git clean`s, and refuses (never chmods / chowns) on an owner
  mismatch. `--upgrade` phase 1 (the invoked script) = read-only preflight (an existing
  install is any of `.env`, `.env.local`, `.env.production`, `.env.production.local`;
  also refuses upstream-added paths that exist here untracked / ignored outside `content/` and
  `.examify-ingest/`, and a Node below the upstream `.nvmrc` major or its installer's
  `MIN_NODE`) → upstream `examify-data.mjs backup --kind pre-upgrade --include-checkout`
  → `$DATA/.upgrade-state.json` `{fromSha, archive, startedAt, movesCheckoutContent}`
  **right away** (a rerun keeps the earlier archive as the rollback point when `HEAD` has
  moved on from its `fromSha`, or equals it and that run had content to move) →
  `migrate-checkout --backup <that archive>` → `.next` parked as
  `.next.pre-upgrade-<ts>` → `git merge --ff-only @{u}` (else `--no-edit`, aborted on
  conflict) → `exec bash ./install.sh --upgrade-phase2`. Failure hints print
  `./install.sh …`, or `git show <upstream>:install.sh | bash -s -- …` while the
  checkout's `install.sh` predates `--upgrade`. The running-server check counts any JSON
  `{ok:boolean}` answer (same rule as `restore`). Phase 2 (the merged installer; unknown flags
  only warn — phase-2 flags are a cross-version contract) = frozen-lockfile
  `pnpm install` → `pnpm db:migrate` → `pnpm build` (unless `--skip-build`) →
  `examify-data verify` → drop the state file and the parked build; a failed Node / pnpm
  setup names the backup like any other step. `--rollback <archive>` = the data CLI
  copied first (the checkout's, else `git show @{u}:scripts/examify-data.mjs`) →
  running-server check (the local ports even with `--allow-running`) →
  `check-archive` (the whole archive extracted into private staging in the data folder
  and verified like a restore — members, every MANIFEST file by size and sha256, a DB
  snapshot — so a truncated or repacked one changes nothing) → `git reset --keep` to
  that verified MANIFEST's `checkout.gitSha` → `restore` with `--force`,
  `--with-env` and `--include-checkout` → drop the state file → reinstall → put back
  the parked build or rebuild. `--restore <archive>` = install → `restore` (with `--with-env` when
  the archive carries any of the four env files under `env/`) → `db:migrate` → build.
- **Secrets on disk.** Data folder `0700`; answer-key files `0600` in a `0700` `keys/`
  (emit, migrate and restore all set it; `verify` fails on a group/world-readable key);
  outbox `0700` / messages `0600`; `backups/` `0700` / archives `0600`. Archives hold the
  DB, every answer key and (unless `--no-env`) `.env` secrets; `migration-conflicts/`
  and `before-restore-*/` hold answer keys too; the outbox is never backed up. Every
  user-facing doc tells operators to copy archives off the machine, run the installer and
  backups as the app's user, upgrade with `./install.sh --upgrade` (never a plain
  `git pull` over an older install's wizard content), and never `git clean -x` /
  `git stash -a` a checkout whose data folder is the default `./data`.

## Environment

Defined and validated by zod in `src/lib/env.ts`. **Fails closed in production:** dev
defaults attach only when `NODE_ENV !== 'production'` (and during `next build`, which Next
distinguishes via `NEXT_PHASE=phase-production-build`). The production server boots under
`NEXT_PHASE=phase-production-server` and `NODE_ENV=production`, so a missing `AUTH_SECRET`,
a missing data location (neither `EXAMIFY_DATA_DIR` nor `DATABASE_URL`), etc. crashes
boot with a readable zod error (and fails the platform healthcheck). Don't add dev
defaults to security-critical vars without weighing that.
Access is DB-backed: empty households fail closed (nobody can sign in until `/setup`
or a leftover `FAMILIES` import). A leftover `FAMILIES` value that is set but
unparsable **crashes production boot**. `/setup` itself is gated by
`SETUP_BOOTSTRAP_SECRET` (required in production, min 16, not a documented
placeholder); captcha is not identity. Documented placeholder `AUTH_SECRET` /
`SETUP_BOOTSTRAP_SECRET` values also fail production boot.

Required in production: `SITE_URL`, `AUTH_SECRET`, `SETUP_BOOTSTRAP_SECRET`, and
`EXAMIFY_DATA_DIR` **or** `DATABASE_URL` (otherwise boot fails with
`Set EXAMIFY_DATA_DIR (or DATABASE_URL) in production`), so a deploy without persistent
storage fails boot instead of writing to ephemeral disk. Both are optional in `env.ts`
otherwise (no dev default for either; the resolver defaults to `./data` and
`<data>/app.db`). Production validation also resolves
the data folder once, so an unsafe `EXAMIFY_DATA_DIR` fails boot with the
`UnsafeDataDirError` message (no path). `EXAMIFY_DATA_DIR` is the one setting for where
family data lives (see "Family data folder invariants"); `DATABASE_URL` is an optional
override that older installs keep (`file:./data/app.db`, the same file). `install.sh`
writes `EXAMIFY_DATA_DIR` (prompt “Family data folder”, `--data-dir`, or a host
`EXAMIFY_DATA_DIR`; a leading `~` is expanded, quotes / newline / ` #` refused) and writes
`DATABASE_URL` only when the host supplied one. It runs `examify-data paths --check`,
`legacy-check` and `init` before installing; reuses a folder that already holds an
Examify DB / `outbox/` / marker; and refuses a non-empty folder with none of those. With a
kept `.env`, the effective folder comes from the on-disk env files (Next's order, an empty
value counts); a host `EXAMIFY_DATA_DIR` / `DATABASE_URL` or `--data-dir` that differs is
refused with copy naming both, like the `AUTH_MODE` conflict.
`SITE_URL` must be the public origin family devices open:
it builds invite / sign-in links and decides the session cookie (see Auth
invariants); `install.sh` warns when it is localhost or plain http beyond the host.
`CLIENT_IP_HEADER` (`x-forwarded-for` default | `x-real-ip` | `cf-connecting-ip`)
names the one header the rate limiter trusts. `AUTH_MODE` defaults to `magic-link` (existing #56 hosts
keep working). `password` sign-in needs no mail; password-mode invite accept
sends a mailbox OTP and fails closed without a transport. Interactive /
default `install.sh` (`AUTH_MODE=password`) prompts for mail or enables a
local outbox (`ALLOW_LOCAL_OUTBOX=1`) when it **writes** `.env` so kid
invites are not stranded — it does not skip mailbox proof. A kept
password-mode `.env` with no mail path is refused (no false “enabled
outbox” claim). Keep-broken / keep-good is judged from the on-disk env files
(`.env`, `.env.local`, `.env.production*`, in Next's order), not a transient host
process env — `ALLOW_LOCAL_OUTBOX=1` on the installer must not greenlight a broken
file. A host `AUTH_MODE` that differs from effective on-disk `AUTH_MODE`
(`.env.local` wins over `.env`, including an empty `AUTH_MODE=` that
Next treats as the magic-link default) is refused with copy that names
that effective mode. `RESEND_API_KEY=test` is not a
mail path. `local-otp` in production requires
`ALLOW_LOCAL_OUTBOX=1`. `MAIL_TRANSPORT` is `auto` (SMTP if `SMTP_HOST`, else
Resend if a real key, else outbox). Explicit `MAIL_TRANSPORT=smtp` needs
`SMTP_HOST` + `SMTP_FROM`; `auto` + `SMTP_HOST` also needs `SMTP_FROM`. A
leftover `SMTP_HOST` does not fail `resend` / `outbox`. SMTP AUTH/DATA on a
connection that never upgraded to TLS is refused unless `SMTP_ALLOW_INSECURE=1`.
`resend` needs a real key + `RESEND_FROM`; `outbox`
in production needs `ALLOW_LOCAL_OUTBOX=1`. Production with no real mail
transport does not write bearer tokens to the outbox (`<data>/outbox`) unless
`ALLOW_LOCAL_OUTBOX=1`. Turnstile captcha is off by default; set
`TURNSTILE_ENABLED=1` with both keys to enable (exactly one key in
production crashes boot; keys alone do not enable captcha).
The OTP / forgot-password step after a `sent` screen mounts Turnstile with an
explicit `turnstile.render()` (`ExplicitTurnstile`) because the implicit scanner
already ran on the first form (or the form mounted after page load).
`ANTHROPIC_API_KEY` is optional (wizard clear + production restart must not
brick boot). A missing / empty key fail-closes free-text grading
(`needs_review`, no stub) — blank is never treated as `test`. The `test`
sentinel stubs only outside production or with `GRADING_STUB=1` (test/CI only).
See `.env.example` for the canonical list.

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
  `pnpm test:e2e` runs _before_ `pnpm build` and `playwright test`. All three Playwright
  configs require an existing `.next` (they start with `next start`; they do not
  create the production build).
- **Test data folders, never a real one.** `tests/unit/setup.ts` sets
  `EXAMIFY_DATA_DIR=tests/.tmp/unit-data-<pid>` (wiped at start) and
  `DATABASE_URL=file:tests/.tmp/unit.db` **unconditionally**, so a developer's exported
  values can't point unit tests at real family data. Each Playwright config sets its own
  `EXAMIFY_DATA_DIR=tests/.tmp/e2e-{seeded,fresh,password}-data` in the webServer env;
  the prepare scripts pass `E2E_DATA_DIR` and `setup-db.ts` wipes + initialises it
  (refusing anything outside `tests/.tmp`). `--empty` seeds the committed `demo` fixture
  (`subject.json` + `notes.txt`) into the fresh data folder, since the wizard lists
  family subjects only; `fresh.spec.ts` asserts the subject landed there and the checkout
  is untouched. Unit tests of the family layer use a temp family root **and** a separate
  temp fake checkout (registrar bytes and checkout `content/generated` must stay
  unchanged). CI fails when
  `git status --porcelain --ignored=traditional -- content .examify-ingest src` is
  non-empty after the unit suite (unit job) and after the build and the three suites
  (e2e job).
- Default sign-in e2e uses the documented always-pass Turnstile dummy key. The widget
  owns the single `cf-turnstile-response` field when captcha is on; never add a second
  fallback field with that name. When the widget CDN is unavailable, the Playwright
  helper injects that same field and submits it in one browser task. A second
  Playwright config (`playwright.fresh.config.ts`) covers first-run bootstrap and
  Turnstile-off sign-in. A third (`playwright.password.config.ts`, seeded by
  `setup-db.ts --password` with the known passwords in `tests/e2e/seed.ts`) runs
  `AUTH_MODE=password` — the `install.sh` default — and is the browser coverage for
  the exam flow: password sign-in, a whole exam (MCQ + free-text) → results →
  progress, resume after reload, the parent dashboard, and a finish whose first submit is
  dropped (`page.route` abort) → retry screen → Try again → results. Keep the `data-testid`s it
  uses on ExamApp / ProgressView / ParentDashboard (including `exam-error-unreachable`,
  `exam-error-refused` and `exam-retry`). Each spec runs under exactly one
  config (`tests/e2e/suites.ts`, guarded by `tests/unit/e2e-suites.test.ts`). The
  Playwright webServer envs set `GRADING_STUB=1` (deterministic grading under
  `next start`) and, for the seeded/fresh suites, `CLIENT_IP_HEADER=x-real-ip` so
  specs can pick a rate-limit bucket per test. Happy-path, invite accept, uniform rate-limit, and
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
