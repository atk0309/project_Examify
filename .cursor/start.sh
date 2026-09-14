#!/usr/bin/env bash
# Per-boot runtime init. Migrations run at runtime (never build-time) and are
# idempotent — Drizzle tracks what's applied — so this is safe on every boot.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=.cursor/use-node.sh
source .cursor/use-node.sh

pnpm db:migrate
