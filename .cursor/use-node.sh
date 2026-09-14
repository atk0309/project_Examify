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
corepack enable >/dev/null 2>&1 || true
