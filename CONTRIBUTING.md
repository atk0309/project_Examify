# Contributing to Examify

Thanks for your interest! Examify is intentionally small — please keep changes in that
spirit. Architecture, invariants, and the rationale behind them live in
[`CLAUDE.md`](CLAUDE.md) (paired with [`AGENTS.md`](AGENTS.md) for AI coding agents);
read the relevant section before changing auth, scoring, or content code.

## Prerequisites

- Node 22 LTS (`.nvmrc`)
- pnpm 10 (`corepack enable` is the easiest way)

## Setup

```bash
pnpm install
cp .env.example .env   # dev defaults work out of the box — no real keys needed
pnpm dev               # http://localhost:3000
```

In development, magic-link emails are written to `tests/.tmp/outbox/*.json`
(`RESEND_API_KEY=test`) and free-text grading uses a local stub
(`ANTHROPIC_API_KEY=test`), so the whole flow works offline.

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

## Test expectations

- A new public page route gets a Playwright smoke (200 + title) and is covered by the
  link-crawl spec.
- A new server action or route handler that mutates state gets at least one happy-path
  and one failure-path test.
- A new helper in `src/lib/` gets a Vitest unit test.

## Pull requests

- Work on a feature branch; never push to `main`.
- Fill in the PR template (routes touched, tests added, command output summary).
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
