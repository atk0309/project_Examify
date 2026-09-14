# Sourced helper: put the repo's pinned Node (from .nvmrc) on PATH and make the
# corepack-managed pnpm available. Not meant to be executed directly.
#
# The base image ships nvm, but another Node shim can sit ahead of it on PATH,
# so `nvm use` alone isn't reliable. We prepend the exact version's bin dir
# explicitly to guarantee the pinned Node wins.

_use_node_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  # Reads .nvmrc from the current directory; a no-op if already installed.
  (cd "$_use_node_root" && nvm install >/dev/null 2>&1) || true
fi

_use_node_version="$(tr -d ' \t\r\n' < "$_use_node_root/.nvmrc")"
_use_node_bin="$NVM_DIR/versions/node/v${_use_node_version}/bin"
if [ -d "$_use_node_bin" ]; then
  export PATH="$_use_node_bin:$PATH"
fi

# Activate the pnpm version pinned in package.json's "packageManager" field.
# Non-interactive so corepack fetches the pinned pnpm without prompting.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable >/dev/null 2>&1 || true

# Fail fast on the *effective* versions. The activation steps above are allowed
# to fail (|| true) only when the already-selected runtime is already correct —
# never silently fall back to an unpinned node/pnpm from the inherited PATH
# (e.g. a system Node shim older than the engines floor).
_use_node_actual="$(node --version 2>/dev/null || true)"
_use_node_actual="${_use_node_actual#v}"
if [ "$_use_node_actual" != "$_use_node_version" ]; then
  echo "use-node: Node $_use_node_version (from .nvmrc) required, found '${_use_node_actual:-none}'." >&2
  echo "use-node: install it with 'nvm install $_use_node_version' and retry." >&2
  return 1 2>/dev/null || exit 1
fi

_use_pnpm_want="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9][^"]*\)".*/\1/p' "$_use_node_root/package.json" | head -1)"
_use_pnpm_actual="$(pnpm --version 2>/dev/null || true)"
if [ -n "$_use_pnpm_want" ] && [ "$_use_pnpm_actual" != "$_use_pnpm_want" ]; then
  echo "use-node: pnpm $_use_pnpm_want (from package.json packageManager) required, found '${_use_pnpm_actual:-none}'." >&2
  echo "use-node: run 'corepack enable' (or 'corepack prepare pnpm@$_use_pnpm_want --activate') and retry." >&2
  return 1 2>/dev/null || exit 1
fi
