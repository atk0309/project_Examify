# Contributing to Examify

Thanks for your interest! Examify is intentionally small — please keep changes in that
spirit. Architecture, invariants, and the rationale behind them live in
[`CLAUDE.md`](CLAUDE.md) (paired with [`AGENTS.md`](AGENTS.md) for AI coding agents);
read the relevant section before changing auth, scoring, or content code.

By participating, you agree to follow the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Before opening an issue

Search the existing issues, then use the bug, feature, or question form from the issue
chooser. General support guidance lives in [`SUPPORT.md`](SUPPORT.md).

Never put secrets, real family data, active magic links, or vulnerability details in a
public issue. Security problems must use the private process in
[`SECURITY.md`](SECURITY.md); conduct concerns follow
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Prerequisites

- Node 22.22.2–22.x (`.nvmrc`)
- pnpm 10.33.0 (`packageManager` in `package.json`)
- Optional: `pdftoppm` from **poppler** (`poppler-utils`) for PDF generation with OpenAI, Codex or a local vision endpoint

## Setup

```bash
pnpm install --frozen-lockfile
cp .env.example .env   # AUTH_MODE=magic-link; or set AUTH_MODE=password
pnpm dev               # http://localhost:3000
```

Or `./install.sh` from a clone. In development, magic-link / OTP messages are
written to a local outbox (`MAIL_OUTBOX_DIR` if set, otherwise
`data/outbox/*.json`; `RESEND_API_KEY=test` selects `tests/.tmp/outbox/`) and free-text grading uses a
local stub (`ANTHROPIC_API_KEY=test`), so no live mail or AI service is needed for that development flow.
The bootstrap code is `SETUP_BOOTSTRAP_SECRET` in `.env`. These placeholder
secrets are for development and are rejected in production.

For an actual installation, follow the [installation guide](docs/installation.md).

## Commands

| Command          | What it does                                      |
| ---------------- | ------------------------------------------------- |
| `pnpm dev`       | Dev server (Turbopack)                            |
| `pnpm lint`      | ESLint                                            |
| `pnpm typecheck` | `tsc --noEmit`                                    |
| `pnpm format`    | Prettier write (`format:check` is the CI guard)   |
| `pnpm test`      | Vitest unit suite                                 |
| `pnpm test:e2e`  | Playwright e2e (run `pnpm test:e2e:install` once) |
| `pnpm build`     | Production build                                  |

## Quality gates

CI runs all of these on every PR — please run them locally first:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm format:check
pnpm test:e2e   # where your environment permits
```

Installer unit tests use command shims for several paths. They verify control flow
and recovery but do not prove a clean dependency install on every OS. When changing
the installer, also try a disposable real install through first login and record
which commands ran unchanged, any environment workarounds, and untested platforms.

## Test expectations

- A new public page route gets a Playwright smoke (200 + title) and is covered by the
  link-crawl spec.
- A new server action or route handler that mutates state gets at least one happy-path
  and one failure-path test.
- A new helper in `src/lib/` gets a Vitest unit test.

## Pull requests

- Work on a feature branch; never push to `main`.
- Fill in the PR template (routes touched, tests added, command output summary).
- Run formatting, lint, types, tests, and the production build before requesting review.
- Keep docs in sync in the same PR: `README.md`, `CLAUDE.md`/`AGENTS.md`, and
  `.env.example` for anything that changes setup, env vars, routes, or invariants.
- Don't merge with a red CI.

## Contributing content

Question-bank changes (new subjects, questions, rubrics) follow
[`docs/content-authoring.md`](docs/content-authoring.md) — in particular the
server-only answer-key rule and the mandatory `provenance` on every key. Note that the
shipped bank is deliberately a small generic sample; content PRs that would only suit
one school/curriculum are better kept in your own fork.

## Dependency policy

Exact versions in `package.json` (no `^`/`~`); bumps land via the grouped weekly
Dependabot PRs.
