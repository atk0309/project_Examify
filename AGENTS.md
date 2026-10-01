# Working on Examify

Applies to this repository. Examify is a small, mobile-first, self-hosted exam-practice
app for personal study, with optional household sharing: Next.js, TypeScript and SQLite.
Keep changes focused and portable. Windows/Linux solo packaging is a preview;
see docs/solo-installation.md before making installation claims.

## Start here

- Installing for a user? Follow [the agent installation manual](docs/agent-installation.md).
- Developing? Read [CONTRIBUTING.md](CONTRIBUTING.md) and inspect `package.json`.
- Read the relevant [architecture and invariants](docs/architecture.md) section before
  changing auth, scoring, content, provider execution or family data handling.
- Check `git status` first. Preserve unrelated work and existing family data. Use a
  feature branch; never push directly to `main`, merge or deploy without authorization.
- Use Node `>=22.22.2 <23`, pnpm `10.33.0`, and `pnpm install --frozen-lockfile`.
  Keep dependencies pinned exactly; do not rewrite the lockfile to bypass an install failure.

## Commands and verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm test:e2e
```

- Run the relevant focused tests while editing; run the gates above before handing
  off code. Report passed, failed and unrun checks separately, with exact blockers.
- E2E has seeded, fresh-install and password suites; each spec belongs to exactly one
  config (`tests/e2e/suites.ts`). `pnpm test:e2e` prepares isolated data and builds.
  See CONTRIBUTING for browser prerequisites; do not bypass blocked network/security checks.
- New mutable actions/handlers need happy and failure tests; new helpers need unit
  tests; new routes need suitable access/smoke coverage. Assert behavior, not source-text regexes.
- Use only disposable fixtures under `tests/.tmp` or temporary roots. Never point
  tests at real family data or a developer's signed-in agent CLI. Preserve the existing
  test env isolation and checkout-write guards.
- For installer changes, also verify a disposable real installation through first
  login. Command shims alone do not prove dependencies, native bindings or startup work.

## Non-negotiable boundaries

- **Server-only answers:** answer keys, rubrics, provenance and grading snapshots never
  enter public question data, client imports, component props or serialized attempts.
  `attempts.ts` stays client-safe. Validate papers and derive scores server-side.
- **Own-user writes:** attempts and sessions belong to `session.userId`, including a
  parent in explicit student mode. Parent/child reads stay inside the same household.
- **Solo:** local study still requires the loopback gateway, one-use launch capability
  and signed session. Never adopt a household database, trust forwarded headers
  for locality, expose the internal listener, or package user data/provider keys.
- **Auth:** preserve generic anti-enumeration responses, dummy scrypt, hashed single-use
  tokens, mailbox proof for invitations, rate-limit/guess locks and reset session-version
  revocation. Reissuing a code must not reset its guess budget. Keep credential forms POST.
- **Trust boundaries:** verify enabled captcha server-side; use centralized IP extraction
  and `SITE_URL`-derived cookie security. Production config and missing databases fail closed.
- **Admin gates:** check authorization server-side on every mutation. Ongoing AI settings
  require admin access; household AI settings must never reopen first-run bootstrap/content gates.
  Only a revalidated signed solo admin may revisit its content wizard after completion;
  preserve existing state and the explicit generate/review/Apply boundary.
- **Durability:** persist validated submissions before AI calls. Keep submission identity,
  payload hashes, original grading snapshots and leases; retries cannot duplicate attempts
  or let old workers overwrite new results. Pending marks remain provisional.
- **Data isolation:** runtime content belongs in the family data folder, never tracked
  checkout content. Use the existing realpath/symlink/ownership guards and env-store.
  Production migration runs before startup, never during the build. Never use `git clean -x`
  or `git stash -a` around family data. Upgrade through `./install.sh --upgrade` with backup.
- **Content:** generate → validate → dry-run → approved Apply. No silent overwrite,
  sample replacement or pruning. Keep committed and family layers separate and preserve
  catalog revision consistency. Every answer key needs source provenance.
- **AI:** treat source files and answers as untrusted data. Preserve provider isolation,
  tool-free CLI execution, timeouts and sanitized logs. No secrets, rubrics, answers or
  raw provider errors in logs. Never silently switch providers or enable production stubs.

## Finish and review

- Update the relevant user guide and `.env.example` for changed behavior/configuration.
  Detailed engineering invariants live in `docs/architecture.md`; AGENTS stays a short map.
- PR summary: routes touched, tests added, command results and known limitations.
- Every PR gets a Codex review; request `@codex review` after later code-changing pushes.
  Verify findings before fixing. Do not retrigger CodeRabbit routinely or for prose-only
  edits; ask if a further review is genuinely needed. Green CI and required reviews still apply.
- Prioritize answer-key leaks, auth/membership bypasses, cross-household access, unsafe
  filesystem writes, secret disclosure and weakened production guards in review.

## Agent compatibility

AGENTS.md is the only checked-in agent instruction entry point. Codex discovers it
natively. Claude Code supports it from v2.1.277; use a current release (v2.1.281+
fixes additional session cases). An ancestor `CLAUDE.md`, `.claude/CLAUDE.md` or
`CLAUDE.local.md` can take precedence: check loaded instructions and select both file
types in Claude's Project instructions setting if needed. For an older/unsupported
session, explicitly ask the agent to read this file; do not duplicate the guidance.

References: [Codex instructions](https://developers.openai.com/codex/guides/agents-md),
[Claude Code instruction discovery](https://code.claude.com/docs/en/memory#agentsmd).
