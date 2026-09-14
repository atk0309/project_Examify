#!/usr/bin/env bash
# Per-boot runtime init. Migrations run at runtime (never build-time) and are
# idempotent — Drizzle tracks what's applied — so this is safe on every boot.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=.cursor/use-node.sh
source .cursor/use-node.sh

# Migrate the *configured* database. migrate.ts reads process.env.DATABASE_URL
# directly and does not load .env, so a custom DATABASE_URL set in the local
# .env (by install.sh or by hand) would otherwise be ignored and the fallback
# ./data/app.db migrated instead — leaving the app's real DB unmigrated. Load
# .env via Node's built-in dotenv parser (real env vars still take precedence,
# so an injected secret wins over the file).
if [ -f .env ]; then
  pnpm exec tsx --env-file=.env src/lib/db/migrate.ts
else
  pnpm db:migrate
fi
