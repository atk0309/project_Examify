#!/usr/bin/env bash
# Idempotent repository bootstrap: pinned Node + dependencies + a local dev env
# file. Safe to run repeatedly. No servers, migrations, or builds here.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=.cursor/use-node.sh
source .cursor/use-node.sh
echo "Using Node $(node --version) / pnpm $(pnpm --version)"

pnpm install --frozen-lockfile

# Bootstrap a local dev env file (never clobber an existing one). Every
# security-critical var already has a safe dev default in src/lib/env.ts, so
# the app runs without this; the file just makes the config discoverable.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

# The session cookie name + Secure flag follow SITE_URL (sessionCookieConfig
# in src/lib/env.ts), so plain-HTTP local dev already gets a non-Secure
# `examify_session` cookie by default. Only a leftover explicit __Host-
# override still needs rewriting: browsers reject a __Host- cookie that is
# not Secure, so magic-link login would bounce back to /signin. Any other
# explicit value is left untouched.
if grep -qE '^SESSION_COOKIE_NAME=__Host-' .env; then
  sed -i -E 's/^SESSION_COOKIE_NAME=__Host-.*/SESSION_COOKIE_NAME=examify_session/' .env
  echo "Rewrote __Host- SESSION_COOKIE_NAME to examify_session for local dev"
fi
