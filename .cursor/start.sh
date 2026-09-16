#!/usr/bin/env bash
# Per-boot runtime init. Migrations run at runtime (never build-time) and are
# idempotent — Drizzle tracks what's applied — so this is safe on every boot.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=.cursor/use-node.sh
source .cursor/use-node.sh

# Migrate the *configured* database. migrate.ts walks to the Examify repo root
# (findRepoRoot) and fills DATABASE_URL from `.env` / `.env.local` when the
# process env is unset — same file Next loads. A host-injected DATABASE_URL
# still wins.
pnpm db:migrate
