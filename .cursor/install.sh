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

# A __Host--prefixed cookie is rejected by browsers unless it carries the
# Secure attribute, but local dev serves over plain HTTP (Secure is off), so
# the session cookie never sticks and magic-link login bounces back to /signin.
# Drop the prefix for local dev only; production keeps the __Host- default over
# HTTPS (see src/lib/auth.ts, which sets secure: isProd).
#
# Three cases: an active __Host- value is rewritten (covers an existing .env
# that copied the example default); a missing key is appended; any other
# explicit value is left untouched.
if grep -qE '^SESSION_COOKIE_NAME=__Host-' .env; then
  sed -i -E 's/^SESSION_COOKIE_NAME=__Host-.*/SESSION_COOKIE_NAME=examify_session/' .env
  echo "Rewrote __Host- SESSION_COOKIE_NAME to examify_session for local dev"
elif ! grep -qE '^SESSION_COOKIE_NAME=' .env; then
  printf '\n# Local dev only: plain HTTP cannot set a Secure __Host- cookie.\nSESSION_COOKIE_NAME=examify_session\n' >> .env
  echo "Set SESSION_COOKIE_NAME=examify_session for local dev"
fi
