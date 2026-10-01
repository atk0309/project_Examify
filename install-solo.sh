#!/usr/bin/env bash
# Release packaging replaces both pins. Never downloads moving main/latest.
set -euo pipefail
VERSION='__EXAMIFY_VERSION__'
SHA256='__EXAMIFY_SHA256__'
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/examify"
ARCHIVE=''
LAUNCH=1
SHORTCUT=1
usage() {
  printf '%s\n' 'Examify solo installer (Linux x64)' \
    'Usage: bash install-solo.sh [--root PATH] [--archive FILE] [--no-launch] [--no-shortcut]' \
    'Uses a release-pinned app, dependencies and private Node runtime. No sudo, Git or pnpm.' \
    'Keep the launcher terminal open; Ctrl+C stops Examify. Closing the browser alone does not stop it.'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root|--archive)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      if [ "$1" = --root ]; then ROOT="$2"; else ARCHIVE="$2"; fi
      shift 2 ;;
    --no-launch) LAUNCH=0; shift ;;
    --no-shortcut) SHORTCUT=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
fail() { printf 'Examify: %s\n' "$1" >&2; exit 1; }
[[ "$VERSION" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && "$SHA256" =~ ^[0-9a-f]{64}$ ]] || \
  fail 'This is an installer source template. Use the version-pinned installer from a built Examify release artifact; no solo release has been assumed.'
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail 'This package supports Linux x64 only.'
[ "$(id -u)" != 0 ] || fail 'Run this as your normal user, without sudo.'
for cmd in tar sha256sum mktemp; do command -v "$cmd" >/dev/null || fail "Missing standard system tool: $cmd"; done
case "$ROOT" in /*) ;; *) fail 'The install folder must be an absolute path.' ;; esac
case "$ROOT" in *[\"\'\`\$\\%]*|*$'\n'*|*$'\r'*|*' #'*) fail 'Choose an install path without quotes, newlines, dollar signs, percent signs or backslashes.' ;; esac
# Never follow a symlink/reparse-style redirect into someone else's data.
P="$ROOT"
while [ "$P" != / ]; do
  [ ! -L "$P" ] || fail 'The install path must not contain symbolic links.'
  if [ -e "$P" ]; then [ -d "$P" ] || fail 'The install path contains a file.'; fi
  P="$(dirname -- "$P")"
done
if [ -d "$ROOT" ]; then
  [ -O "$ROOT" ] || fail 'The install folder belongs to another user.'
  if [ -n "$(ls -A "$ROOT")" ] && [ ! -f "$ROOT/installation.json" ]; then
    fail 'The destination contains other files. Choose an empty dedicated Examify folder.'
  fi
fi
for ENTRY in installation.json Examify releases config data "releases/$VERSION"; do
  [ ! -L "$ROOT/$ENTRY" ] || fail 'Existing installation paths must not be symbolic links.'
done
umask 077
mkdir -p -- "$ROOT"
chmod 700 -- "$ROOT"
STAGE="$(mktemp -d "$ROOT/.install.XXXXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT
ASSET="examify-${VERSION}-linux-x64.tar.gz"
if [ -n "$ARCHIVE" ]; then
  cp -- "$ARCHIVE" "$STAGE/package.tar.gz"
else
  URL="https://github.com/atk0309/project_Examify/releases/download/${VERSION}/${ASSET}"
  if command -v curl >/dev/null; then
    curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 "$URL" -o "$STAGE/package.tar.gz"
  elif command -v wget >/dev/null; then
    wget --https-only -O "$STAGE/package.tar.gz" "$URL"
  else
    fail 'Install curl or wget with your normal OS tools, then retry.'
  fi
fi
printf '%s  %s\n' "$SHA256" "$STAGE/package.tar.gz" | sha256sum --check --status || fail 'Download checksum mismatch. Nothing was installed.'
mkdir "$STAGE/app"
tar -xzf "$STAGE/package.tar.gz" -C "$STAGE/app" --no-same-owner
NODE="$STAGE/app/runtime/bin/node"
[ -x "$NODE" ] && [ -f "$STAGE/app/scripts/launcher.mjs" ] || fail 'The release package is incomplete.'
# Run only the now checksum-verified bundled runtime, never a host Node installation.
"$NODE" --input-type=module - "$ROOT" "$STAGE/app" "$VERSION" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [root, app, version] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(app, 'desktop-release.json'), 'utf8'));
if (manifest.version !== version || manifest.platform !== 'linux-x64' || process.versions.node !== manifest.nodeVersion) throw new Error('Wrong release/runtime.');
const marker = path.join(root, 'installation.json');
if (fs.existsSync(marker)) {
  const old = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (old.app !== 'examify-solo' || old.version !== version) throw new Error('Different or unknown installation. Automatic upgrades are not enabled; preserve your data and follow the release migration instructions.');
}
JS
mkdir -p "$ROOT/releases"
if [ ! -e "$ROOT/releases/$VERSION" ]; then mv "$STAGE/app" "$ROOT/releases/$VERSION"; fi
"$ROOT/releases/$VERSION/runtime/bin/node" "$ROOT/releases/$VERSION/scripts/desktop/restore-links.mjs" "$ROOT/releases/$VERSION"
printf '{"app":"examify-solo","version":"%s"}\n' "$VERSION" > "$ROOT/installation.json"
cat > "$ROOT/Examify" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SH
printf 'exec "$ROOT/releases/%s/runtime/bin/node" "$ROOT/releases/%s/scripts/launcher.mjs" --root "$ROOT" "$@"\n' "$VERSION" "$VERSION" >> "$ROOT/Examify"
chmod 700 "$ROOT/Examify"
if [ "$SHORTCUT" = 1 ]; then
  DESKTOP="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$DESKTOP"
  cat > "$DESKTOP/examify-solo.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Examify
Comment=Private exam practice on this computer
Exec="$ROOT/Examify"
Terminal=true
Categories=Education;
StartupNotify=false
DESKTOP
  chmod 600 "$DESKTOP/examify-solo.desktop"
fi
printf 'Examify installed. Relaunch with: %s/Examify\n' "$ROOT"
if [ "$LAUNCH" = 1 ]; then "$ROOT/Examify"; fi
