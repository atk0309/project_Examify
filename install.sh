#!/usr/bin/env bash
# Examify installer — curl|bash friendly.
#
#   curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash
#
# From a clone:
#   ./install.sh
#   ./install.sh --help
#
# Piped help (do not use `bash --help` — that is bash's own flag):
#   curl -fsSL …/install.sh | bash -s -- --help
#
# Non-interactive (CI / automation):
#   EXAMIFY_NONINTERACTIVE=1 SITE_URL=https://exam.example.com ./install.sh
#   Existing .env is never overwritten in non-interactive mode. Remove it first
#   to regenerate. Keep-broken / keep-good / heal is judged from on-disk
#   env files (.env, .env.local, .env.production*, in Next's order) — never a
#   transient host process env.
#   Host ALLOW_LOCAL_OUTBOX=1 must not greenlight a broken password file.
#   A kept password-mode file with no SMTP / Resend / allowed outbox is
#   refused (invite accept would fail closed; this run does not claim to
#   enable an outbox). Host AUTH_MODE that differs from effective on-disk
#   AUTH_MODE (.env.local wins over .env, including an empty AUTH_MODE=)
#   is refused with copy that names that effective mode, not the host's
#   and not .env alone when local wins. A host EXAMIFY_DATA_DIR /
#   DATABASE_URL or --data-dir that differs from the kept files' family
#   data folder / database is refused the same way.
#   Default AUTH_MODE=password enables a local outbox so invite-accept OTP
#   (mailbox proof) can be read from <family data folder>/outbox — only when
#   this run writes .env. Set SMTP_* / RESEND_* to use real mail instead.
#   Invite accept never skips that OTP. RESEND_API_KEY=test is not a mail path.
#   Turnstile stays off unless TURNSTILE_ENABLED=1 (or true) and both Turnstile
#   keys are set (keys alone do not enable captcha).
#
# Family data folder (EXAMIFY_DATA_DIR, default ./data): database, mail
# outbox, uploaded study PDFs, subjects, generated questions and answer keys.
# The running app never writes into tracked checkout content (inside it, only
# ./data and .env).
#
# Upgrading (never manages services; stop the server first):
#   ./install.sh --upgrade
#   First upgrade of an older install: curl -fsSL …/install.sh | bash -s -- --upgrade
#
# Flags:
#   --data-dir <path>        family data folder for a new .env (skips the prompt)
#   --upgrade                back up, move family content out of the checkout,
#                            merge upstream, then install / migrate / build / verify
#   --rollback <archive>     go back to the version and data in a pre-upgrade backup
#   --restore <archive>      set this checkout up from a backup (fresh machine)
#   --allow-running          skip the "server is answering" refusal
#   --allow-owner-mismatch   run although another user owns the checkout / data
#   --write-env-only         write .env and exit (used by tests)
#   --skip-build             install + migrate, skip pnpm build
#   --yes                    same as EXAMIFY_NONINTERACTIVE=1
#   --help                   print this usage (safe when $0 is bash)
#
# The whole script runs from main(), called on the last line: bash parses the
# entire function before running it, so a `git merge` that replaces this file
# mid-run (--upgrade) cannot change what is executing.
set -euo pipefail

usage() {
  cat <<'EOF'
Examify installer — curl|bash friendly.

  curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash

From a clone:
  ./install.sh
  ./install.sh --help

Piped help (do not use `bash --help` — that is bash's own flag):
  curl -fsSL …/install.sh | bash -s -- --help

Non-interactive (CI / automation):
  EXAMIFY_NONINTERACTIVE=1 SITE_URL=https://exam.example.com ./install.sh
  Existing .env is never overwritten in non-interactive mode. Remove it first
  to regenerate. Keep-broken / keep-good / heal is judged from on-disk
  env files (.env, .env.local, .env.production*, in Next's order) — never a
  transient host process env.
  Host ALLOW_LOCAL_OUTBOX=1 must not greenlight a broken password file.
  A kept password-mode file with no SMTP / Resend / allowed outbox is
  refused (invite accept would fail closed; this run does not claim to
  enable an outbox). Host AUTH_MODE that differs from effective on-disk
  AUTH_MODE (.env.local wins over .env, including an empty AUTH_MODE=)
  is refused with copy that names that effective mode, not the host's
  and not .env alone when local wins. A host EXAMIFY_DATA_DIR /
  DATABASE_URL or --data-dir that differs from the kept files' family
  data folder / database is refused the same way.
  Default AUTH_MODE=password enables a local outbox so invite-accept OTP
  (mailbox proof) can be read from <family data folder>/outbox — only when
  this run writes .env. Set SMTP_* / RESEND_* to use real mail instead.
  Invite accept never skips that OTP. RESEND_API_KEY=test is not a mail path.
  Turnstile stays off unless TURNSTILE_ENABLED=1 (or true) and both Turnstile
  keys are set (keys alone do not enable captcha).

Family data folder (EXAMIFY_DATA_DIR, default ./data): database, mail
outbox, uploaded study PDFs, subjects, generated questions and answer keys.
Pick a folder outside the checkout if you might ever delete and re-clone it.

Upgrading (the installer never starts or stops services; stop the server first):
  ./install.sh --upgrade
  First upgrade of an older install:
  curl -fsSL …/install.sh | bash -s -- --upgrade

Flags:
  --data-dir <path>        family data folder for a new .env (skips the prompt)
  --upgrade                back up, move family content out of the checkout,
                           merge upstream, then install / migrate / build / verify
  --rollback <archive>     go back to the version and data in a pre-upgrade backup
  --restore <archive>      set this checkout up from a backup (fresh machine)
  --allow-running          skip the "server is answering" refusal (another
                           service on that port)
  --allow-owner-mismatch   run although another user owns the checkout / data
  --write-env-only         write .env and exit (used by tests)
  --skip-build             install + migrate, skip pnpm build
  --yes                    same as EXAMIFY_NONINTERACTIVE=1
  --help                   print this usage (safe when $0 is bash)

OpenAI / PDF generate needs pdftoppm (poppler-utils) on PATH.
EOF
}

die() {
  local line
  for line in "$@"; do
    printf '%s\n' "$line" >&2
  done
  exit 1
}

usage_error() {
  echo "$1" >&2
  echo "Run ./install.sh --help for usage." >&2
  exit 2
}

# Phase 2 of --upgrade is the *new* installer run by the old one, so flags are
# a cross-version contract: detect it first, then only warn on unknown flags.
parse_args() {
  local arg value
  for arg in "$@"; do
    if [ "$arg" = "--upgrade-phase2" ]; then
      UPGRADE_PHASE2=1
    fi
  done
  while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
      --write-env-only) WRITE_ENV_ONLY=1 ;;
      --skip-build) SKIP_BUILD=1 ;;
      --yes|-y) NONINTERACTIVE=1 ;;
      --help|-h)
        usage
        exit 0
        ;;
      --upgrade) UPGRADE=1 ;;
      --upgrade-phase2) ;;
      --allow-running) ALLOW_RUNNING=1 ;;
      --allow-owner-mismatch) ALLOW_OWNER_MISMATCH=1 ;;
      --data-dir|--rollback|--restore|--data-dir=*|--rollback=*|--restore=*)
        case "$arg" in
          *=*)
            value="${arg#*=}"
            arg="${arg%%=*}"
            ;;
          *)
            value="${1-}"
            if [ "$#" -gt 0 ]; then
              shift
            fi
            ;;
        esac
        if [ -z "$value" ]; then
          if [ "$UPGRADE_PHASE2" = "1" ]; then
            echo "Warning: ignoring ${arg} without a value." >&2
            continue
          fi
          usage_error "${arg} needs a value."
        fi
        case "$arg" in
          --data-dir) FLAG_DATA_DIR="$value" ;;
          --rollback) ROLLBACK_ARCHIVE="$value" ;;
          --restore) RESTORE_ARCHIVE="$value" ;;
        esac
        ;;
      *)
        if [ "$UPGRADE_PHASE2" = "1" ]; then
          echo "Warning: ignoring unknown flag ${arg} (this installer is newer or older than the one that started the upgrade)." >&2
          continue
        fi
        echo "Unknown flag: $arg" >&2
        exit 2
        ;;
    esac
  done
  if [ "$UPGRADE_PHASE2" != "1" ]; then
    local modes=0
    [ "$UPGRADE" = "1" ] && modes=$((modes + 1))
    [ -n "$ROLLBACK_ARCHIVE" ] && modes=$((modes + 1))
    [ -n "$RESTORE_ARCHIVE" ] && modes=$((modes + 1))
    [ "$WRITE_ENV_ONLY" = "1" ] && modes=$((modes + 1))
    if [ "$modes" -gt 1 ]; then
      usage_error "Use only one of --upgrade, --rollback, --restore and --write-env-only."
    fi
  fi
}

# /dev/tty can exist without a controlling terminal (setsid, CI, service
# managers): read it only when it opens, else stdin as inherited (reopening
# /dev/stdin fails when stdin is a socket). A piped `curl | bash` is at the
# end of the script by then (main is the last line), so prompts take defaults.
tty_usable() {
  { : < /dev/tty; } 2>/dev/null
}

# One answer line into REPLY_LINE; "secret" hides typing on a terminal.
read_reply() {
  REPLY_LINE=""
  if tty_usable; then
    if [ "${1-}" = "secret" ]; then
      IFS= read -rs REPLY_LINE < /dev/tty || true
    else
      IFS= read -r REPLY_LINE < /dev/tty || true
    fi
  elif [ "${1-}" = "secret" ]; then
    IFS= read -rs REPLY_LINE || true
  else
    IFS= read -r REPLY_LINE || true
  fi
}

prompt() {
  local var="$1"
  local message="$2"
  local default="${3-}"
  local secret="${4-}"
  local current="${!var:-}"
  if [ -n "${current}" ]; then
    return 0
  fi
  if [ "$NONINTERACTIVE" = "1" ]; then
    printf -v "$var" '%s' "$default"
    return 0
  fi
  local reply=""
  if [ -n "$default" ]; then
    { printf '%s [%s]: ' "$message" "$default" > /dev/tty; } 2>/dev/null || printf '%s [%s]: ' "$message" "$default"
  else
    { printf '%s: ' "$message" > /dev/tty; } 2>/dev/null || printf '%s: ' "$message"
  fi
  if [ "$secret" = "secret" ]; then
    read_reply secret
    { printf '\n' > /dev/tty; } 2>/dev/null || printf '\n'
  else
    read_reply
  fi
  reply="$REPLY_LINE"
  if [ -z "$reply" ]; then
    reply="$default"
  fi
  printf -v "$var" '%s' "$reply"
}

# Password sign-in needs no mail. Password-mode invite accept still sends a
# mailbox OTP (#61) and fails closed if nothing can deliver it.
# Matches src/lib/env.ts canDeliverMailboxProof / resolveMailTransport:
# an allowed outbox is only a path when transport is outbox, or auto that
# actually falls back to outbox (explicit smtp/resend stay on that provider).
has_invite_mail_path() {
  local transport="${MAIL_TRANSPORT:-auto}"
  case "$transport" in
    smtp)
      [ -n "${SMTP_HOST-}" ] && [ -n "${SMTP_FROM-}" ] && return 0
      return 1
      ;;
    resend)
      [ -n "${RESEND_API_KEY-}" ] && [ "${RESEND_API_KEY}" != "test" ] && [ -n "${RESEND_FROM-}" ] && return 0
      return 1
      ;;
    outbox)
      [ "${ALLOW_LOCAL_OUTBOX-}" = "1" ] && return 0
      return 1
      ;;
    auto|"")
      if [ -n "${SMTP_HOST-}" ]; then
        [ -n "${SMTP_FROM-}" ] && return 0
        return 1
      fi
      if [ -n "${RESEND_API_KEY-}" ] && [ "${RESEND_API_KEY}" != "test" ]; then
        [ -n "${RESEND_FROM-}" ] && return 0
        return 1
      fi
      [ "${ALLOW_LOCAL_OUTBOX-}" = "1" ] && return 0
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

# Last KEY=VALUE in a dotenv file. Does not eval / expand.
# Prints the value (empty if the assignment is empty). Exit 0 if the key is
# present — including AUTH_MODE= — so an empty .env.local can shadow .env.
# Exit 1 if the file or key is missing.
env_file_get() {
  local file="$1"
  local key="$2"
  local line="" body="" value="" quoted=0 found=0
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    body="${line#"${line%%[![:space:]]*}"}"
    [ -z "$body" ] && continue
    [ "${body#\#}" != "$body" ] && continue
    if [ "${body#export }" != "$body" ]; then
      body="${body#export }"
      body="${body#"${body%%[![:space:]]*}"}"
    fi
    case "$body" in
      "${key}="*)
        found=1
        value="${body#"${key}="}"
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        quoted=0
        if [ "${#value}" -ge 2 ]; then
          case "$value" in
            \"*\") quoted=1 ;;
            \'*\') quoted=1 ;;
          esac
        fi
        if [ "$quoted" -eq 0 ]; then
          # Next.js / dotenv: unquoted inline comment is whitespace then #.
          value="$(printf '%s' "$value" | sed 's/[[:space:]]\{1\}#.*$//')"
          value="${value%"${value##*[![:space:]]}"}"
        fi
        if [ "${#value}" -ge 2 ]; then
          case "$value" in
            \"*\") value="${value#\"}"; value="${value%\"}" ;;
            \'*\') value="${value#\'}"; value="${value%\'}" ;;
          esac
        fi
        ;;
    esac
  done < "$file"
  printf '%s' "$value"
  [ "$found" -eq 1 ]
}

env_file_has() {
  env_file_get "$1" "$2" >/dev/null
}

# The files `next start` loads, highest precedence first (@next/env in
# production; src/lib/env-file.ts PRODUCTION_ENV_FILES). The first file that
# defines a key wins, even with an empty value.
disk_env_source() {
  local key="$1" file
  for file in .env.production.local .env.local .env.production .env; do
    if env_file_has "$file" "$key"; then
      printf '%s' "$file"
      return 0
    fi
  done
  return 1
}

# Same order, but only the files that override the .env this run writes.
override_env_source() {
  local key="$1" file
  for file in .env.production.local .env.local .env.production; do
    if env_file_has "$file" "$key"; then
      printf '%s' "$file"
      return 0
    fi
  done
  return 1
}

# An existing install has at least one of the env files `next start` reads (an
# install configured only through .env.local counts).
has_env_config() {
  [ -f .env ] || [ -f .env.local ] || [ -f .env.production ] || [ -f .env.production.local ]
}

# On-disk dotenv only, in Next's order (.env.local wins over .env), including
# an empty assignment that shadows a lower file. Host process env is ignored
# so a transient ALLOW_LOCAL_OUTBOX=1 on the installer cannot greenlight a
# broken file.
disk_env_get() {
  local key="$1" file
  if file="$(disk_env_source "$key")"; then
    env_file_get "$file" "$key" || true
  fi
}

# AUTH_MODE written in the kept `.env` only (not host, not .env.local).
# Omitted line is the runtime default (magic-link). Used to name an override.
kept_env_auth_mode() {
  local mode
  mode="$(env_file_get .env AUTH_MODE)" || true
  printf '%s' "${mode:-magic-link}"
}

# Effective on-disk AUTH_MODE: .env.local wins over .env (Next.js load order).
# Omitted everywhere is the runtime default (magic-link).
disk_auth_mode() {
  local mode
  mode="$(disk_env_get AUTH_MODE)"
  printf '%s' "${mode:-magic-link}"
}

# Kept-file mail check uses on-disk files and runtime defaults
# (AUTH_MODE=magic-link, MAIL_TRANSPORT=auto) — not host process env,
# not this run's installer prompt defaults.
kept_password_has_mail() {
  local AUTH_MODE MAIL_TRANSPORT ALLOW_LOCAL_OUTBOX SMTP_HOST SMTP_FROM RESEND_API_KEY RESEND_FROM
  AUTH_MODE="$(disk_env_get AUTH_MODE)"
  AUTH_MODE="${AUTH_MODE:-magic-link}"
  [ "$AUTH_MODE" = "password" ] || return 0
  MAIL_TRANSPORT="$(disk_env_get MAIL_TRANSPORT)"
  MAIL_TRANSPORT="${MAIL_TRANSPORT:-auto}"
  ALLOW_LOCAL_OUTBOX="$(disk_env_get ALLOW_LOCAL_OUTBOX)"
  SMTP_HOST="$(disk_env_get SMTP_HOST)"
  SMTP_FROM="$(disk_env_get SMTP_FROM)"
  RESEND_API_KEY="$(disk_env_get RESEND_API_KEY)"
  RESEND_FROM="$(disk_env_get RESEND_FROM)"
  has_invite_mail_path
}

# Prepare in-memory outbox for a write. Do not claim enable here — keep/write
# happens later, and a kept file must not be described as enabled.
ensure_password_invite_mail() {
  if [ "$AUTH_MODE" != "password" ]; then
    return 0
  fi
  if has_invite_mail_path; then
    return 0
  fi
  MAIL_TRANSPORT="outbox"
  ALLOW_LOCAL_OUTBOX=1
  ENABLED_PASSWORD_OUTBOX=1
}

claim_password_outbox_enable() {
  echo "Password sign-in needs no mail. Invite accept still requires mailbox proof (OTP)." >&2
  echo "No SMTP / Resend is configured. Enabling MAIL_TRANSPORT=outbox and ALLOW_LOCAL_OUTBOX=1" >&2
  echo "so kid invite codes land in ${DATA_DIR_DISPLAY}/outbox (treat that directory as secret)." >&2
  echo "To use real mail, set SMTP_HOST+SMTP_FROM or RESEND_API_KEY+RESEND_FROM and re-run." >&2
}

# Kept file was not written. Do not claim enable. Password without a delivery
# path would strand kid invites — refuse instead of warning and ignoring.
# Copy names on-disk AUTH_MODE (effective .env / .env.local), never host env.
refuse_kept_password_without_mail() {
  local disk_mode env_mode
  disk_mode="$(disk_env_get AUTH_MODE)"
  disk_mode="${disk_mode:-magic-link}"
  env_mode="$(kept_env_auth_mode)"
  if [ "$env_mode" != "$disk_mode" ]; then
    echo "Keeping existing .env (AUTH_MODE=${env_mode}); on-disk config is AUTH_MODE=${disk_mode} with no SMTP / Resend / allowed outbox." >&2
  else
    echo "Keeping existing .env, but it is AUTH_MODE=${disk_mode} with no SMTP / Resend / allowed outbox." >&2
  fi
  echo "Invite accept still requires mailbox proof and will fail closed. This run did not enable an outbox." >&2
  echo "Add SMTP_* or RESEND_* (or MAIL_TRANSPORT=outbox and ALLOW_LOCAL_OUTBOX=1), or remove .env and re-run." >&2
  exit 1
}

# Host AUTH_MODE is this run's intent; effective on-disk mode is what would boot.
# Never claim .env alone when a higher file wins, and never claim the host value.
refuse_kept_auth_mode_conflict() {
  local disk_mode="$1"
  local host_mode="$2"
  local env_mode source
  env_mode="$(kept_env_auth_mode)"
  source="$(disk_env_source AUTH_MODE)" || source=".env"
  if [ "$source" != ".env" ] && [ "$disk_mode" != "$env_mode" ]; then
    echo "Keeping existing .env. Host AUTH_MODE=${host_mode}, but on-disk AUTH_MODE=${disk_mode} (${source} overrides .env AUTH_MODE=${env_mode})." >&2
  else
    echo "Keeping existing .env. Host AUTH_MODE=${host_mode}, but the kept file is AUTH_MODE=${disk_mode}." >&2
  fi
  echo "This run did not overwrite .env. Unset AUTH_MODE to keep this file, or remove .env and re-run." >&2
  exit 1
}

# SITE_URL is the address family devices open; invite / sign-in links and the
# session cookie (Secure only on https) follow it. One line of feedback:
# localhost only opens on this machine; plain http beyond it is unencrypted.
site_url_note() {
  local url="$1"
  local scheme rest host
  scheme="$(printf '%s' "${url%%://*}" | tr '[:upper:]' '[:lower:]')"
  rest="${url#*://}"
  rest="${rest%%/*}"
  rest="${rest##*@}"
  case "$rest" in
    \[*) host="${rest%%]*}]" ;;
    *) host="${rest%%:*}" ;;
  esac
  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  case "$host" in
    localhost|*.localhost|127.*|0.0.0.0|\[::1\])
      echo "Warning: SITE_URL uses ${host}, so invite links will only open on this machine." >&2
      ;;
    *)
      if [ "$scheme" = "http" ]; then
        echo "Note: SITE_URL is plain http, so traffic is unencrypted; use HTTPS (a reverse proxy) beyond your home network." >&2
      fi
      ;;
  esac
}

confirm() {
  local message="$1"
  local default="${2:-n}"
  local reply=""
  if [ "$NONINTERACTIVE" = "1" ]; then
    [ "$default" = "y" ]
    return $?
  fi
  { printf '%s [%s]: ' "$message" "$default" > /dev/tty; } 2>/dev/null || printf '%s [%s]: ' "$message" "$default"
  read_reply
  reply="${REPLY_LINE:-$default}"
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

rand_secret() {
  local bytes="${1:-32}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr -d '\n'
    return
  fi
  head -c "$bytes" /dev/urandom | base64 | tr -d '\n'
}

version_ge() {
  # true if $1 >= $2 (dotted numeric)
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

is_examify_package_json() {
  [ -f "$1" ] && grep -Eq '"name"[[:space:]]*:[[:space:]]*"project-examify"' "$1"
}

is_examify_repo() {
  is_examify_package_json package.json
}

# Walk up from $PWD until package.json name is project-examify (same marker
# as src/lib/repo-root.ts). Writes then land on the checkout `.env`, not a
# subdirectory cwd. Prints the root on stdout; returns 1 if not found.
find_examify_root() {
  local dir="$PWD"
  while :; do
    if is_examify_package_json "$dir/package.json"; then
      printf '%s\n' "$dir"
      return 0
    fi
    local parent
    parent="$(dirname "$dir")"
    if [ "$parent" = "$dir" ]; then
      return 1
    fi
    dir="$parent"
  done
}

ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js ${MIN_NODE}+ is required. Install Node 22 LTS from https://nodejs.org/ and re-run." >&2
    exit 1
  fi
  local ver
  ver="$(node -p 'process.versions.node')"
  if ! version_ge "$ver" "$MIN_NODE"; then
    echo "Node.js ${ver} is too old. Examify needs ${MIN_NODE}+ (22 LTS)." >&2
    exit 1
  fi
  local major="${ver%%.*}"
  if [ "$major" -ge "$MAX_NODE_MAJOR" ]; then
    echo "Node.js ${ver} is not supported. Examify needs Node 22 LTS (${MIN_NODE}–22.x)." >&2
    exit 1
  fi
}

ensure_pnpm() {
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@${PNPM_VERSION}" --activate
    return
  fi
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi
  echo "corepack (ships with Node) or pnpm is required." >&2
  exit 1
}

# --- family data folder (bash mirror of src/lib/data-dir.ts) ---

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# A leading ~ becomes $HOME before anything is written: the app never
# expands it (data-dir.ts refuses a leading ~). ~user stays and is refused.
expand_tilde() {
  local value="$1"
  case "$value" in
    \~|\~/*)
      if [ -z "${HOME-}" ]; then
        die "Family data folder ${value}: HOME is not set, so ~ cannot be expanded; use an absolute path."
      fi
      ;;
  esac
  case "$value" in
    \~) printf '%s' "$HOME" ;;
    \~/*) printf '%s/%s' "${HOME%/}" "${value#\~/}" ;;
    *) printf '%s' "$value" ;;
  esac
}

# Values .env cannot carry or the app refuses (data-dir.ts assertDataDirValue),
# plus `$`, which Next's .env loading would expand but the CLI tools would not.
# Prints the problem and returns 0 when there is one.
data_dir_value_problem() {
  local value="$1" nl=$'\n' cr=$'\r' comment='[[:space:]]#'
  case "$value" in
    "~"*)
      printf 'starts with ~, which is never expanded; use an absolute path'
      return 0
      ;;
    *\"*|*\'*|*\`*|*"$nl"*|*"$cr"*)
      printf 'contains a quote or a newline; pick a plainer path'
      return 0
      ;;
    *\$*)
      printf 'contains $, which .env loading would expand; pick a plainer path'
      return 0
      ;;
  esac
  if [[ "$value" =~ $comment ]]; then
    printf 'contains " #", which .env reads as a comment; pick a plainer path'
    return 0
  fi
  return 1
}

# path.resolve: a relative value resolves against the checkout root (never
# cwd), then . and .. collapse lexically.
abs_path() {
  local base="$1" value="$2" joined part out=""
  local -a parts=() stack=()
  case "$value" in
    /*) joined="$value" ;;
    *) joined="${base%/}/$value" ;;
  esac
  IFS=/ read -r -a parts <<< "$joined"
  for part in ${parts[@]+"${parts[@]}"}; do
    case "$part" in
      ''|.) ;;
      ..)
        if [ "${#stack[@]}" -gt 0 ]; then
          unset "stack[$((${#stack[@]} - 1))]"
        fi
        ;;
      *) stack+=("$part") ;;
    esac
  done
  for part in ${stack[@]+"${stack[@]}"}; do
    out="$out/$part"
  done
  printf '%s' "${out:-/}"
}

# realpath of the nearest existing ancestor + the not-yet-created rest
# (data-dir.ts canonical), so a symlink cannot route around the checks.
canonical_path() {
  local p="$1" rest="" real parent
  case "$p" in
    /*) ;;
    *)
      printf '%s' "$p"
      return 0
      ;;
  esac
  while [ ! -e "$p" ] && [ "$p" != "/" ]; do
    rest="/${p##*/}$rest"
    p="${p%/*}"
    [ -n "$p" ] || p="/"
  done
  if [ -d "$p" ]; then
    real="$(cd "$p" 2>/dev/null && pwd -P)" || real="$p"
  else
    parent="${p%/*}"
    [ -n "$parent" ] || parent="/"
    real="$(cd "$parent" 2>/dev/null && pwd -P)" || real="$parent"
    real="${real%/}/${p##*/}"
  fi
  real="${real%/}$rest"
  [ -n "$real" ] || real="/"
  if [ "$CASE_INSENSITIVE_FS" = "1" ]; then
    real="$(printf '%s' "$real" | tr '[:upper:]' '[:lower:]')"
  fi
  printf '%s' "$real"
}

# $2 is $1 or inside it.
path_within() {
  [ "$2" = "$1" ] && return 0
  case "$2" in
    "${1%/}"/*) return 0 ;;
  esac
  return 1
}

same_path() {
  if [ "$1" = ":memory:" ] || [ "$2" = ":memory:" ]; then
    [ "$1" = "$2" ]
    return
  fi
  [ "$(canonical_path "$1")" = "$(canonical_path "$2")" ]
}

# data-dir.ts assertSafeDataDir: never the checkout or a folder containing it;
# inside the checkout only data/… (plus tests/.tmp/…, which the test suites
# use). Prints the problem and returns 0 when there is one.
data_dir_safety_problem() {
  local root dir rel first rest
  root="$(canonical_path "$1")"
  dir="$(canonical_path "$2")"
  if path_within "$dir" "$root"; then
    printf 'the family data folder cannot be the checkout or a folder that contains it'
    return 0
  fi
  path_within "$root" "$dir" || return 1
  rel="${dir#"${root%/}"/}"
  first="${rel%%/*}"
  rest=""
  if [ "$rel" != "$first" ]; then
    rest="${rel#*/}"
  fi
  if [ "$first" = "data" ] || { [ "$first" = "tests" ] && [ "${rest%%/*}" = ".tmp" ]; }; then
    return 1
  fi
  printf 'inside the checkout the family data folder must be ./data (or a folder under it)'
  return 0
}

# $2 (a file or folder) is outside the checkout $1, or under its data/… or
# tests/.tmp/… (data-dir.ts allowedInCheckout: where the database and the mail
# outbox may live). Returns 1 inside the checkout anywhere else, the root included.
allowed_in_checkout() {
  local root target rel first rest=""
  root="$(canonical_path "$1")"
  target="$(canonical_path "$2")"
  path_within "$root" "$target" || return 0
  if [ "$target" = "$root" ]; then
    return 1
  fi
  rel="${target#"${root%/}"/}"
  first="${rel%%/*}"
  if [ "$rel" != "$first" ]; then
    rest="${rel#*/}"
  fi
  if [ "$first" = "data" ] || { [ "$first" = "tests" ] && [ "${rest%%/*}" = ".tmp" ]; }; then
    return 0
  fi
  return 1
}

# data-dir.ts resolveDataPaths over raw EXAMIFY_DATA_DIR / DATABASE_URL:
# EXAMIFY_DATA_DIR, else the folder of an explicit SQLite DATABASE_URL that is
# fully outside the checkout, else ./data. The database is an explicit
# DATABASE_URL, else <data folder>/app.db. Sets RESOLVED_DATA_DIR,
# RESOLVED_DATA_SOURCE and RESOLVED_DB_PATH (absolute, lexical).
resolve_data_paths() {
  local root="$1" raw_dir raw_db db_path="" db_dir
  raw_dir="$(trim "$2")"
  raw_db="$(trim "$3")"
  if [ -n "$raw_db" ]; then
    db_path="${raw_db#file:}"
    if [ "$db_path" != ":memory:" ]; then
      db_path="$(abs_path "$root" "$db_path")"
    fi
  fi
  if [ -n "$raw_dir" ]; then
    RESOLVED_DATA_DIR="$(abs_path "$root" "$raw_dir")"
    RESOLVED_DATA_SOURCE="EXAMIFY_DATA_DIR"
  else
    RESOLVED_DATA_DIR="$(abs_path "$root" data)"
    RESOLVED_DATA_SOURCE="default"
    if [ -n "$db_path" ] && [ "$db_path" != ":memory:" ]; then
      db_dir="${db_path%/*}"
      [ -n "$db_dir" ] || db_dir="/"
      if ! path_within "$(canonical_path "$root")" "$(canonical_path "$db_dir")" &&
        ! path_within "$(canonical_path "$db_dir")" "$(canonical_path "$root")"; then
        RESOLVED_DATA_DIR="$db_dir"
        RESOLVED_DATA_SOURCE="DATABASE_URL"
      fi
    fi
  fi
  if [ -n "$db_path" ]; then
    RESOLVED_DB_PATH="$db_path"
  else
    RESOLVED_DB_PATH="${RESOLVED_DATA_DIR%/}/app.db"
  fi
}

# What `next start` / db:migrate would use from the on-disk env files alone.
resolve_disk_data_paths() {
  DISK_DATA_DIR_RAW="$(disk_env_get EXAMIFY_DATA_DIR)"
  DISK_DATABASE_URL_RAW="$(disk_env_get DATABASE_URL)"
  resolve_data_paths "$ROOT" "$DISK_DATA_DIR_RAW" "$DISK_DATABASE_URL_RAW"
  DISK_DATA_DIR="$RESOLVED_DATA_DIR"
  DISK_DATA_SOURCE="$RESOLVED_DATA_SOURCE"
  DISK_DB_PATH="$RESOLVED_DB_PATH"
}

disk_data_dir_origin() {
  local file
  case "$DISK_DATA_SOURCE" in
    EXAMIFY_DATA_DIR)
      file="$(disk_env_source EXAMIFY_DATA_DIR)" || file=".env"
      printf 'EXAMIFY_DATA_DIR in %s' "$file"
      ;;
    DATABASE_URL)
      file="$(disk_env_source DATABASE_URL)" || file=".env"
      printf 'the folder of DATABASE_URL in %s' "$file"
      ;;
    *) printf 'the default ./data' ;;
  esac
}

disk_db_origin() {
  local file
  if [ -n "$(trim "$DISK_DATABASE_URL_RAW")" ]; then
    file="$(disk_env_source DATABASE_URL)" || file=".env"
    printf 'DATABASE_URL in %s' "$file"
  else
    printf 'app.db in the family data folder'
  fi
}

# The folder a person would recognise: the value as written, else the
# absolute folder the resolver derived.
disk_data_dir_display() {
  if [ -n "$(trim "$DISK_DATA_DIR_RAW")" ]; then
    trim "$DISK_DATA_DIR_RAW"
  elif [ "$DISK_DATA_SOURCE" = "DATABASE_URL" ]; then
    printf '%s' "$DISK_DATA_DIR"
  else
    printf '%s' "$DATA_DIR_DEFAULT"
  fi
}

# A kept on-disk EXAMIFY_DATA_DIR the app would refuse fails here, clearly,
# instead of at boot.
refuse_bad_disk_data_dir() {
  local raw problem file
  raw="$(trim "$DISK_DATA_DIR_RAW")"
  if [ -n "$raw" ] && problem="$(data_dir_value_problem "$raw")"; then
    file="$(disk_env_source EXAMIFY_DATA_DIR)" || file=".env"
    die "${file} has EXAMIFY_DATA_DIR=${raw}, which the app refuses: ${problem}." "Fix it in ${file} and re-run."
  fi
  # The same value rules for the other two paths (data-dir.ts assertPathValue).
  raw="$(trim "$DISK_DATABASE_URL_RAW")"
  if [ -n "$raw" ] && problem="$(data_dir_value_problem "${raw#file:}")"; then
    file="$(disk_env_source DATABASE_URL)" || file=".env"
    die "${file} has DATABASE_URL=${raw}, which the app refuses: ${problem}." "Fix it in ${file} and re-run."
  fi
  raw="$(trim "$(disk_env_get MAIL_OUTBOX_DIR)")"
  if [ -n "$raw" ] && problem="$(data_dir_value_problem "$raw")"; then
    file="$(disk_env_source MAIL_OUTBOX_DIR)" || file=".env"
    die "${file} has MAIL_OUTBOX_DIR=${raw}, which the app refuses: ${problem}." "Fix it in ${file} and re-run."
  fi
  if problem="$(data_dir_safety_problem "$ROOT" "$DISK_DATA_DIR")"; then
    die "The kept env files point the family data folder at ${DISK_DATA_DIR} ($(disk_data_dir_origin)): ${problem}." "Fix it and re-run."
  fi
  if [ "$DISK_DB_PATH" != ":memory:" ] && ! allowed_in_checkout "$ROOT" "$DISK_DB_PATH"; then
    file="$(disk_env_source DATABASE_URL)" || file=".env"
    die "${file} has DATABASE_URL=$(trim "$DISK_DATABASE_URL_RAW"), which the app refuses: ${DB_INSIDE_CHECKOUT}." \
      "Move the database file there, fix DATABASE_URL in ${file}, and re-run."
  fi
  raw="$(trim "$(disk_env_get MAIL_OUTBOX_DIR)")"
  if [ -n "$raw" ] && ! allowed_in_checkout "$ROOT" "$(abs_path "$ROOT" "$raw")"; then
    file="$(disk_env_source MAIL_OUTBOX_DIR)" || file=".env"
    die "${file} has MAIL_OUTBOX_DIR=${raw}, which the app refuses: it points inside the checkout; keep the mail outbox in the family data folder (./data/outbox) or outside the checkout." \
      "Fix MAIL_OUTBOX_DIR in ${file} and re-run."
  fi
}

# Existing family data is reused; a non-empty folder holding none of it is
# refused (never write into somebody else's folder).
check_existing_data() {
  local dir="$1" db="$2" file found=0
  FOUND_EXISTING_DB=0
  if [ "$db" != ":memory:" ] && [ -e "$db" ]; then
    FOUND_EXISTING_DB=1
  fi
  [ -e "$dir" ] || return 0
  if [ ! -d "$dir" ]; then
    die "Family data folder ${dir} exists but is not a folder."
  fi
  if [ ! -r "$dir" ] || [ ! -x "$dir" ]; then
    die "Cannot read the family data folder ${dir}; run the installer as the user that owns it."
  fi
  if [ -e "$dir/$DATA_MARKER" ] || [ -d "$dir/outbox" ]; then
    found=1
  fi
  for file in "$dir"/app.db*; do
    if [ -e "$file" ]; then
      found=1
    fi
  done
  if [ "$FOUND_EXISTING_DB" = "1" ] && path_within "$dir" "$db"; then
    found=1
  fi
  if [ "$found" = "1" ]; then
    echo "Found existing family data in ${dir}; it will be reused."
    return 0
  fi
  if [ -n "$(ls -A "$dir")" ]; then
    die "Family data folder ${dir} is not empty and is not an Examify data folder" \
      "(no database, outbox/ or ${DATA_MARKER} in it). Pick an empty or new folder."
  fi
}

# The data folder this run writes: --data-dir, else host EXAMIFY_DATA_DIR,
# else the prompt. Checked (value, checkout overlap, existing data) before
# anything is written.
settle_data_dir() {
  local default="$1" input problem
  if [ -n "$(trim "$FLAG_DATA_DIR")" ]; then
    input="$FLAG_DATA_DIR"
  elif [ -n "$(trim "$HOST_DATA_DIR_RAW")" ]; then
    input="$HOST_DATA_DIR_RAW"
  else
    if [ "$NONINTERACTIVE" != "1" ]; then
      echo
      echo "Family data folder: the database, uploaded study PDFs, subjects, generated questions"
      echo "and answer keys. Pick a folder outside this checkout if you might ever delete and"
      echo "re-clone it."
    fi
    DATA_DIR_INPUT=""
    prompt DATA_DIR_INPUT "Family data folder" "$default"
    input="$DATA_DIR_INPUT"
  fi
  input="$(trim "$input")"
  [ -n "$input" ] || input="$default"
  input="$(expand_tilde "$input")"
  if problem="$(data_dir_value_problem "$input")"; then
    die "Family data folder ${input}: ${problem}."
  fi
  if [ -n "$WRITE_DATABASE_URL" ] && problem="$(data_dir_value_problem "${WRITE_DATABASE_URL#file:}")"; then
    die "DATABASE_URL=${WRITE_DATABASE_URL}: ${problem}." "Nothing was written."
  fi
  resolve_data_paths "$ROOT" "$input" "$WRITE_DATABASE_URL"
  if problem="$(data_dir_safety_problem "$ROOT" "$RESOLVED_DATA_DIR")"; then
    die "Family data folder ${input}: ${problem}."
  fi
  if [ "$RESOLVED_DB_PATH" != ":memory:" ] && ! allowed_in_checkout "$ROOT" "$RESOLVED_DB_PATH"; then
    die "DATABASE_URL=${WRITE_DATABASE_URL}: ${DB_INSIDE_CHECKOUT}." "Nothing was written."
  fi
  DATA_DIR_VALUE="$input"
  DATA_DIR_DISPLAY="$input"
  DATA_DIR_ABS="$RESOLVED_DATA_DIR"
  DATA_DB_PATH="$RESOLVED_DB_PATH"
  refuse_env_file_override
  check_existing_data "$DATA_DIR_ABS" "$DATA_DB_PATH"
}

# Default for the prompt on a new .env: ./data, or the folder of a host
# DATABASE_URL outside the checkout so family content lives next to the DB.
fresh_data_dir_default() {
  resolve_data_paths "$ROOT" "" "$WRITE_DATABASE_URL"
  if [ "$RESOLVED_DATA_SOURCE" = "DATABASE_URL" ]; then
    printf '%s' "$RESOLVED_DATA_DIR"
  else
    printf '%s' "$DATA_DIR_DEFAULT"
  fi
}

# .env.production.local / .env.local / .env.production win over the .env this
# run writes (Next's order): refuse when they would send the app to another
# data folder or database than the one written here.
refuse_env_file_override() {
  local dir_file db_file eff_dir eff_db
  dir_file="$(override_env_source EXAMIFY_DATA_DIR)" || dir_file=""
  db_file="$(override_env_source DATABASE_URL)" || db_file=""
  [ -n "$dir_file" ] || [ -n "$db_file" ] || return 0
  eff_dir="$DATA_DIR_VALUE"
  eff_db="$WRITE_DATABASE_URL"
  if [ -n "$dir_file" ]; then
    eff_dir="$(env_file_get "$dir_file" EXAMIFY_DATA_DIR)" || true
  fi
  if [ -n "$db_file" ]; then
    eff_db="$(env_file_get "$db_file" DATABASE_URL)" || true
  fi
  resolve_data_paths "$ROOT" "$eff_dir" "$eff_db"
  if ! same_path "$RESOLVED_DATA_DIR" "$DATA_DIR_ABS" || ! same_path "$RESOLVED_DB_PATH" "$DATA_DB_PATH"; then
    die "${dir_file:-$db_file} overrides the .env this run writes: the app would use the family data folder" \
      "${RESOLVED_DATA_DIR} (database ${RESOLVED_DB_PATH}) instead of ${DATA_DIR_ABS}." \
      "Remove EXAMIFY_DATA_DIR / DATABASE_URL from that file (or pick that folder) and re-run."
  fi
}

# Kept .env: the on-disk files decide the folder. A host EXAMIFY_DATA_DIR /
# DATABASE_URL or --data-dir that differs is this run's intent, not what
# would boot — refuse and name both, like the AUTH_MODE conflict.
refuse_kept_data_dir_conflict() {
  local label hint want problem host_db
  resolve_disk_data_paths
  refuse_bad_disk_data_dir
  if [ -n "$(trim "$FLAG_DATA_DIR")" ]; then
    label="--data-dir"
    hint="drop --data-dir"
    want="$(trim "$FLAG_DATA_DIR")"
  elif [ -n "$(trim "$HOST_DATA_DIR_RAW")" ]; then
    label="Host EXAMIFY_DATA_DIR="
    hint="unset EXAMIFY_DATA_DIR"
    want="$(trim "$HOST_DATA_DIR_RAW")"
  else
    want=""
  fi
  if [ -n "$want" ]; then
    want="$(expand_tilde "$want")"
    if problem="$(data_dir_value_problem "$want")"; then
      die "Family data folder ${want}: ${problem}."
    fi
    if ! same_path "$(abs_path "$ROOT" "$want")" "$DISK_DATA_DIR"; then
      if [ "$label" = "--data-dir" ]; then
        echo "Keeping existing .env. --data-dir ${want}, but the kept files use the family data folder ${DISK_DATA_DIR} ($(disk_data_dir_origin))." >&2
      else
        echo "Keeping existing .env. ${label}${want}, but the kept files use the family data folder ${DISK_DATA_DIR} ($(disk_data_dir_origin))." >&2
      fi
      echo "This run did not overwrite .env. To keep this file, ${hint}; to move the data, see the README (back up, then restore with --data-dir)." >&2
      exit 1
    fi
  fi
  if [ -n "$(trim "$HOST_DATABASE_URL_RAW")" ]; then
    resolve_data_paths "$ROOT" "" "$HOST_DATABASE_URL_RAW"
    host_db="$RESOLVED_DB_PATH"
    if ! same_path "$host_db" "$DISK_DB_PATH"; then
      echo "Keeping existing .env. Host DATABASE_URL=$(trim "$HOST_DATABASE_URL_RAW"), but the kept files use the database ${DISK_DB_PATH} ($(disk_db_origin))." >&2
      echo "This run did not overwrite .env. Unset DATABASE_URL to keep this file, or edit DATABASE_URL there and re-run." >&2
      exit 1
    fi
  fi
}

# The checkout's own resolver has the last word (it also sees what the bash
# mirror cannot). Family content left in the checkout by an older version is
# refused here, before anything is installed (db:migrate refuses it too).
# Then init creates the folder 0700 with its marker.
prepare_data_folder() {
  local err out error_code code=0
  err="$(node scripts/examify-data.mjs paths --check --repo "$ROOT" 2>&1 >/dev/null)" || code=$?
  if [ "$code" -eq 3 ]; then
    # stderr is "examify-data paths: <reason>: <message>"
    err="${err#examify-data paths: }"
    die "The family data folder is not safe to use (${err:-unsafe_data_dir})." \
      "Fix EXAMIFY_DATA_DIR / DATABASE_URL / MAIL_OUTBOX_DIR in the env files and re-run."
  elif [ "$code" -ne 0 ]; then
    if [ -n "$err" ]; then
      printf '%s\n' "$err" >&2
    fi
    die "Could not check the family data folder (examify-data paths exited ${code})."
  fi
  if [ "${EXAMIFY_IGNORE_LEGACY_CONTENT-}" != "1" ]; then
    code=0
    node scripts/examify-data.mjs legacy-check --repo "$ROOT" || code=$?
    case "$code" in
      0) ;;
      4)
        die "This checkout still holds family content from an older version (listed above)." \
          "Move it into the family data folder first: ./install.sh --upgrade" \
          "(or node scripts/examify-data.mjs migrate-checkout), then re-run."
        ;;
      *) echo "Warning: could not check the checkout for older family content (examify-data legacy-check exited ${code})." >&2 ;;
    esac
  fi
  code=0
  out="$(node scripts/examify-data.mjs init --repo "$ROOT" --json ${DATA_CLI_WRITE_FLAGS[@]+"${DATA_CLI_WRITE_FLAGS[@]}"})" || code=$?
  case "$code" in
    0) ;;
    5)
      # Exit 5 is owner_mismatch or shared_folder; --json says which.
      error_code="$(printf '%s' "$out" | json_field error)" || error_code=""
      if [ "$error_code" = "shared_folder" ]; then
        die "Refused to set up the family data folder: it already holds files that are not Examify's." \
          "Point EXAMIFY_DATA_DIR in .env at an empty or new folder of its own and re-run."
      fi
      die "Refused to set up the family data folder: it or this checkout belongs to another user." \
        "Run the installer as that user, or pass --allow-owner-mismatch."
      ;;
    *) die "Could not set up the family data folder (examify-data init exited ${code})." ;;
  esac
}

require_data_cli() {
  if [ ! -f scripts/examify-data.mjs ]; then
    die "This checkout has no scripts/examify-data.mjs (it predates the family data folder)." \
      "Update it first: ./install.sh --upgrade (or curl -fsSL …/install.sh | bash -s -- --upgrade)."
  fi
}

write_env() {
  local dest="${1:-.env}"
  local old_umask
  # Keys alone do not enable captcha — same rule as parseEnv / isTurnstileEnabled.
  # Interactive confirm sets TURNSTILE_ENABLED=1 before prompting for keys;
  # non-interactive hosts must export TURNSTILE_ENABLED=1 (or true) with both keys.
  # Validate before creating dest so a refuse leaves no half-written .env.
  if [ "${TURNSTILE_ENABLED-}" = "1" ] || [ "${TURNSTILE_ENABLED-}" = "true" ]; then
    if [ -z "${NEXT_PUBLIC_TURNSTILE_SITE_KEY-}" ] || [ -z "${TURNSTILE_SECRET_KEY-}" ]; then
      echo "TURNSTILE_ENABLED=1 requires both NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY." >&2
      exit 1
    fi
  fi
  old_umask="$(umask)"
  umask 077
  {
    printf '%s\n' '# Generated by install.sh. Edit and restart the app after changes.'
    printf '\n'
    printf 'SITE_URL=%s\n' "${SITE_URL}"
    printf 'AUTH_SECRET=%s\n' "${AUTH_SECRET}"
    printf 'SETUP_BOOTSTRAP_SECRET=%s\n' "${SETUP_BOOTSTRAP_SECRET}"
    printf '%s\n' '# Family data folder: database, outbox, uploads, subjects, answer keys.'
    printf 'EXAMIFY_DATA_DIR=%s\n' "${DATA_DIR_VALUE}"
    if [ -n "${WRITE_DATABASE_URL}" ]; then
      printf 'DATABASE_URL=%s\n' "${WRITE_DATABASE_URL}"
    fi
    printf 'AUTH_MODE=%s\n' "${AUTH_MODE}"
    printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY:-test}"
    if [ -n "${OPENAI_API_KEY-}" ]; then
      printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY"
    fi
    printf '\n'
    printf '%s\n' '# Mail: magic-link, local-otp, and password-mode invite accept.'
    printf 'MAIL_TRANSPORT=%s\n' "${MAIL_TRANSPORT}"
  } > "$dest"

  if [ -n "${RESEND_API_KEY-}" ]; then
    printf 'RESEND_API_KEY=%s\n' "$RESEND_API_KEY" >> "$dest"
  fi
  if [ -n "${RESEND_FROM-}" ]; then
    printf 'RESEND_FROM=%s\n' "$RESEND_FROM" >> "$dest"
  fi
  if [ -n "${SMTP_HOST-}" ]; then
    {
      printf 'SMTP_HOST=%s\n' "$SMTP_HOST"
      printf 'SMTP_PORT=%s\n' "${SMTP_PORT:-587}"
      printf 'SMTP_SECURE=%s\n' "${SMTP_SECURE:-false}"
      [ -n "${SMTP_USER-}" ] && printf 'SMTP_USER=%s\n' "$SMTP_USER"
      [ -n "${SMTP_PASS-}" ] && printf 'SMTP_PASS=%s\n' "$SMTP_PASS"
      [ -n "${SMTP_FROM-}" ] && printf 'SMTP_FROM=%s\n' "$SMTP_FROM"
      [ "${SMTP_ALLOW_INSECURE-}" = "1" ] && printf 'SMTP_ALLOW_INSECURE=1\n'
    } >> "$dest"
  fi
  if [ "${ALLOW_LOCAL_OUTBOX-}" = "1" ]; then
    printf 'ALLOW_LOCAL_OUTBOX=1\n' >> "$dest"
  fi
  if [ "${TURNSTILE_ENABLED-}" = "1" ] || [ "${TURNSTILE_ENABLED-}" = "true" ]; then
    # Canonical form matches interactive confirm and docs (parseEnv also accepts true).
    {
      printf 'TURNSTILE_ENABLED=1\n'
      printf 'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\n' "$NEXT_PUBLIC_TURNSTILE_SITE_KEY"
      printf 'TURNSTILE_SECRET_KEY=%s\n' "$TURNSTILE_SECRET_KEY"
    } >> "$dest"
  fi
  chmod 600 "$dest"
  umask "$old_umask"
}

# --- upgrade / rollback / restore helpers ---

# Print a (dotted) string, boolean or number field of the JSON document on
# stdin; empty if absent.
json_field() {
  node -e '
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      let v;
      try {
        v = JSON.parse(s);
      } catch {
        process.exit(1);
      }
      for (const k of process.argv[1].split(".")) v = v == null ? undefined : v[k];
      if (["string", "boolean", "number"].includes(typeof v)) process.stdout.write(String(v));
    });
  ' "$1"
}

# The archive path from `examify-data backup --json` (or a *.tar.gz line).
backup_archive_from_output() {
  node -e '
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s);
        const a = j.archive || j.path || j.file;
        if (typeof a === "string" && a) return void process.stdout.write(a);
      } catch {}
      const m = s.match(/\S+\.tar\.gz/);
      if (m) process.stdout.write(m[0]);
    });
  '
}

in_git_checkout_root() {
  local top
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ "$(cd "$top" && pwd -P)" = "$(pwd -P)" ]
}

require_git_checkout() {
  command -v git >/dev/null 2>&1 || die "git is required for $1."
  in_git_checkout_root || die "$(pwd) is not a git checkout; $1 needs the git clone the installer made."
}

file_owner_uid() {
  stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null
}

owner_problem() {
  local label="$1" path="$2" me="$3" owner
  [ -e "$path" ] || return 1
  owner="$(file_owner_uid "$path")" || return 1
  [ "$owner" = "$me" ] && return 1
  printf '  %s %s is owned by uid %s\n' "$label" "$path" "$owner"
}

# A sudo / root run leaves root-owned keys, WAL files and builds the app user
# cannot read (every exam submit then fails). Refuse unless told otherwise.
refuse_owner_mismatch() {
  local me report
  if [ "$ALLOW_OWNER_MISMATCH" = "1" ]; then
    return 0
  fi
  me="$(id -u)"
  resolve_disk_data_paths
  report="$(
    owner_problem checkout "$ROOT" "$me"
    owner_problem "family data folder" "$DISK_DATA_DIR" "$me"
    if [ "$DISK_DB_PATH" != ":memory:" ]; then
      owner_problem database "$DISK_DB_PATH" "$me"
    fi
  )" || true
  if [ -z "$report" ]; then
    return 0
  fi
  echo "This run is uid ${me}, but:" >&2
  printf '%s\n' "$report" >&2
  echo "Run the installer as the user that owns them (for example: sudo -u <that user> ./install.sh …)," >&2
  echo "or pass --allow-owner-mismatch if you will fix ownership yourself." >&2
  exit 1
}

# 0 (and the URL on stdout) when Examify answers /api/health at the host PORT,
# the on-disk PORT or 3000, plus SITE_URL unless $1 is "local". Examify is
# any JSON body with a boolean "ok", whatever the status: a 503 {ok:false} is
# a running, unhealthy server. Same rule as `examify-data restore`.
server_answering() {
  local scope="${1-all}" port site
  local -a urls=()
  for port in "$HOST_PORT" "$(disk_env_get PORT)" 3000; do
    case "$port" in
      ''|*[!0-9]*) continue ;;
    esac
    urls+=("http://127.0.0.1:${port}/api/health")
  done
  if [ "$scope" != "local" ]; then
    site="$(trim "$(disk_env_get SITE_URL)")"
    case "$site" in
      http://*|https://*) urls+=("${site%/}/api/health") ;;
    esac
  fi
  node -e '
    const urls = process.argv.slice(1);
    let pending = urls.length;
    if (pending === 0) process.exit(1);
    // A server that never finishes its answer does not hold the installer up.
    setTimeout(() => process.exit(1), 5000).unref();
    for (const url of urls) {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (--pending === 0) process.exit(1);
      };
      try {
        const mod = require(url.startsWith("https:") ? "https" : "http");
        const req = mod.get(url, { timeout: 2000, rejectUnauthorized: false }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            if (body.length < 65536) body += chunk;
          });
          res.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(body);
            } catch {}
            if (json && typeof json === "object" && typeof json.ok === "boolean") {
              process.stdout.write(url);
              process.exit(0);
            }
            done();
          });
          res.on("error", done);
          res.on("close", done);
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", done);
      } catch {
        done();
      }
    }
  ' "${urls[@]}"
}

refuse_if_running() {
  local what="$1" url
  if [ "$ALLOW_RUNNING" != "1" ] && url="$(server_answering)"; then
    die "An Examify server is answering at ${url}. Stop it before ${what}, then re-run." \
      "(If that address is a different service, pass --allow-running.)"
  fi
  if [ "$NONINTERACTIVE" != "1" ] && ! confirm "Is the Examify server stopped?" "n"; then
    die "Stop the Examify server first, then re-run. The installer never stops or starts it."
  fi
}

# How to run the installer again: ./install.sh once the checkout's copy has
# --upgrade / --rollback, else the upstream copy piped into bash (the first
# upgrade of an older install, or one that stopped before its merge).
installer_cmd() {
  if grep -q -- '--upgrade-phase2' install.sh 2>/dev/null; then
    printf './install.sh'
  else
    printf 'git show %s:install.sh | bash -s --' "${UPGRADE_UPSTREAM:-origin/main}"
  fi
}

refuse_tracked_changes() {
  local changes files
  local -a pathspec=(. ':(exclude)content' ':(exclude)src/lib/exam/generated-public.ts' ':(exclude)src/lib/exam/generated-keys.server.ts')
  changes="$(git status --porcelain --untracked-files=no -- "${pathspec[@]}")"
  if [ -z "$changes" ]; then
    return 0
  fi
  files="$(git diff --name-only HEAD -- "${pathspec[@]}" | while IFS= read -r f; do printf ' %q' "$f"; done)"
  echo "These tracked files have uncommitted changes:" >&2
  printf '%s\n' "$changes" >&2
  echo "The upgrade only moves family content (content/ and the generated registrars) out of the" >&2
  echo "checkout. Commit these edits first (the upgrade merges your commits), then re-run:" >&2
  echo "  git commit -m 'local questions' --${files}" >&2
  echo "Nothing was changed." >&2
  exit 1
}

refuse_merge_conflict() {
  local out code=0
  out="$(git merge-tree --write-tree --name-only HEAD '@{u}' 2>&1)" || code=$?
  case "$code" in
    0) ;;
    1)
      echo "Your local commits conflict with ${UPGRADE_UPSTREAM}:" >&2
      printf '%s\n' "$out" | sed '1d' >&2
      die "Resolve that first (merge or rebase by hand), then re-run. Nothing was changed."
      ;;
    *)
      die "Could not check your local commits against ${UPGRADE_UPSTREAM} (git merge-tree --write-tree needs git 2.38+)." \
        "Update git or merge ${UPGRADE_UPSTREAM} by hand, then re-run. Nothing was changed."
      ;;
  esac
  if ! git var GIT_COMMITTER_IDENT >/dev/null 2>&1; then
    die "Merging your local commits needs a git identity (git config user.name / user.email). Set it and re-run."
  fi
}

# git merge refuses when an untracked file is in its way and silently
# overwrites an ignored one. Refuse now, before the backup and the move, when
# upstream adds a path that already exists here untracked or ignored (or a
# file sits where upstream needs a folder). content/ and .examify-ingest/ are
# left out: migrate-checkout moves those out of the way first.
refuse_merge_overwrites() {
  local rel dir hit blocking="" nl=$'\n'
  while IFS= read -r -d '' rel; do
    case "$rel" in
      content/*|.examify-ingest/*) continue ;;
    esac
    hit=""
    if [ -e "$rel" ] || [ -L "$rel" ]; then
      hit="$rel"
    fi
    dir="$rel"
    while [ -z "$hit" ] && [ "${dir%/*}" != "$dir" ]; do
      dir="${dir%/*}"
      if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then
        hit="$dir"
      fi
    done
    [ -n "$hit" ] || continue
    if git ls-files --error-unmatch -- "$hit" >/dev/null 2>&1; then
      continue
    fi
    case "${nl}${blocking}" in
      *"${nl}  ${hit}${nl}"*) ;;
      *) blocking="${blocking}  ${hit}${nl}" ;;
    esac
  done < <(git diff -z --name-only --no-renames --diff-filter=A 'HEAD...@{u}')
  if [ -z "$blocking" ]; then
    return 0
  fi
  echo "${UPGRADE_UPSTREAM} adds files that already exist here untracked or ignored" >&2
  echo "(git merge would refuse or overwrite them):" >&2
  printf '%s' "$blocking" >&2
  die "Move them out of the checkout (or delete what you do not need), then re-run. Nothing was changed."
}

# Upstream's Node needs: the .nvmrc major and the upgraded installer's
# MIN_NODE, which its phase 2 enforces after the merge.
refuse_node_mismatch() {
  local want have min="" line upstream_installer
  have="$(node -p 'process.versions.node')"
  want="$(git show '@{u}:.nvmrc' 2>/dev/null | tr -d '[:space:]')" || want=""
  want="${want#v}"
  want="${want%%.*}"
  case "$want" in
    ''|*[!0-9]*) ;;
    *)
      if [ "${have%%.*}" != "$want" ]; then
        die "${UPGRADE_UPSTREAM} needs Node ${want} (.nvmrc); this host runs Node ${have}." \
          "Install Node ${want} and re-run. Nothing was changed."
      fi
      ;;
  esac
  upstream_installer="$(git show '@{u}:install.sh' 2>/dev/null)" || upstream_installer=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*MIN_NODE=\"([0-9]+(\.[0-9]+)*)\" ]]; then
      min="${BASH_REMATCH[1]}"
      break
    fi
  done <<< "$upstream_installer"
  if [ -n "$min" ] && ! version_ge "$have" "$min"; then
    die "${UPGRADE_UPSTREAM} needs Node ${min} or newer; this host runs Node ${have}." \
      "Update Node (22 LTS) and re-run. Nothing was changed."
  fi
}

better_sqlite3_loads() {
  node -e '
    const path = require("path");
    const override = process.env.EXAMIFY_SQLITE_MODULE;
    const req = require("module").createRequire(path.join(process.argv[1], "package.json"));
    require(override ? path.resolve(override) : req.resolve("better-sqlite3"));
  ' "$ROOT" >/dev/null 2>&1
}

# Read-only: every refusal leaves the checkout and the data untouched.
upgrade_preflight() {
  local missing=""
  require_git_checkout "--upgrade"
  UPGRADE_BRANCH="$(git symbolic-ref --quiet --short HEAD)" ||
    die "HEAD is detached. Check out your branch (for example: git switch main) and re-run."
  UPGRADE_UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" ||
    die "Branch ${UPGRADE_BRANCH} has no upstream. Set one (for example: git branch --set-upstream-to=origin/main) and re-run."
  if ! has_env_config; then
    die "No existing install here (no .env, .env.local, .env.production or .env.production.local); run ./install.sh instead."
  fi
  command -v node >/dev/null 2>&1 || missing="$missing node"
  command -v pnpm >/dev/null 2>&1 || command -v corepack >/dev/null 2>&1 || missing="$missing pnpm"
  command -v tar >/dev/null 2>&1 || missing="$missing tar"
  if [ -n "$missing" ]; then
    die "--upgrade needs:${missing}. Install them and re-run."
  fi
  better_sqlite3_loads ||
    die "better-sqlite3 does not load from this checkout's node_modules (the backup needs it)." \
      "Run pnpm install --frozen-lockfile and re-run."
  refuse_kept_data_dir_conflict
  # The data CLI then reads the on-disk files, exactly like the app.
  unset EXAMIFY_DATA_DIR DATABASE_URL
  refuse_owner_mismatch
  refuse_if_running "upgrading"
  echo "Fetching ${UPGRADE_UPSTREAM}…"
  git fetch --quiet || die "git fetch failed; check the network and re-run. Nothing was changed."
  if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
    git fetch --quiet --unshallow || die "git fetch --unshallow failed; re-run. Nothing was changed."
  fi
  refuse_tracked_changes
  if ! git merge-base --is-ancestor HEAD '@{u}'; then
    refuse_merge_conflict
  fi
  refuse_merge_overwrites
  refuse_node_mismatch
}

# Write $DATA/.upgrade-state.json: a new {fromSha, archive, startedAt,
# movesCheckoutContent}, or ("keep") the earlier one plus latestArchive.
# Errors are one line (a full disk is the likely one), never a stack trace.
write_upgrade_state() {
  node -e '
    const fs = require("fs");
    const [file, fromSha, archive, keep, moves] = process.argv.slice(1);
    try {
      let prev = null;
      try {
        prev = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      const state =
        keep === "1"
          ? { ...prev, latestArchive: archive }
          : { fromSha, archive, startedAt: new Date().toISOString(), movesCheckoutContent: moves === "1" };
      fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
    } catch (error) {
      process.stderr.write("could not write the upgrade state: " + (error && error.message ? error.message : String(error)) + "\n");
      try {
        fs.rmSync(file + ".tmp", { force: true });
      } catch {}
      process.exit(1);
    }
  ' "$1" "$2" "$3" "$4" "$5"
}

# Record the rollback point right after the backup, before anything moves
# (sets UPGRADE_ARCHIVE). A rerun keeps the first backup of an upgrade that
# stopped while it is still the way back: after that upgrade merged (HEAD has
# moved on from its fromSha), or before its merge when it had family content
# to move out of the checkout (a new backup no longer holds that).
record_upgrade_start() {
  local state="$1" from_sha="$2" archive="$3" moves="$4" keep=0
  local prev_from="" prev_archive="" prev_moves="" prev_at=""
  if [ -f "$state" ]; then
    prev_from="$(json_field fromSha < "$state")" || prev_from=""
    prev_archive="$(json_field archive < "$state")" || prev_archive=""
    prev_moves="$(json_field movesCheckoutContent < "$state")" || prev_moves=""
    prev_at="$(json_field startedAt < "$state")" || prev_at=""
  fi
  if [ -n "$prev_from" ] && [ -n "$prev_archive" ] && [ -f "$prev_archive" ]; then
    if [ "$prev_from" = "$from_sha" ]; then
      if [ "$prev_moves" = "true" ]; then
        keep=1
      fi
    elif git merge-base --is-ancestor "$prev_from" HEAD 2>/dev/null; then
      keep=1
    fi
  fi
  UPGRADE_ARCHIVE="$archive"
  if [ "$keep" = "1" ]; then
    UPGRADE_ARCHIVE="$prev_archive"
  fi
  write_upgrade_state "$state" "$from_sha" "$archive" "$keep" "$moves" ||
    die "Could not record the upgrade in ${state} (see above; is the disk full?)." \
      "Nothing was moved or merged. The backup is ${archive}; fix that and re-run $(installer_cmd) --upgrade"
  if [ "$keep" = "1" ]; then
    echo "Finishing the upgrade started ${prev_at:-earlier}; its backup stays the rollback point: ${prev_archive}"
  fi
}

# Phase 1: the installer that was invoked (maybe an old one's successor via
# curl). Preflight, back up with the upstream data CLI, record the rollback
# point, move family content into the data folder, merge, then exec the
# merged installer for phase 2.
upgrade_phase1() {
  local mjs from_sha backup_out new_archive ts pre data_dir moves=0 code=0
  upgrade_preflight
  UPGRADE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/examify-upgrade.XXXXXX")"
  trap 'rm -rf "$UPGRADE_TMP"' EXIT
  mjs="$UPGRADE_TMP/examify-data.mjs"
  # The upstream copy: this checkout's (if any) predates the migration logic.
  if ! git show '@{u}:scripts/examify-data.mjs' > "$mjs" 2>/dev/null; then
    if [ -f scripts/examify-data.mjs ]; then
      cp scripts/examify-data.mjs "$mjs"
    else
      die "Neither ${UPGRADE_UPSTREAM} nor this checkout has scripts/examify-data.mjs, so nothing can be backed up. Nothing was changed."
    fi
  fi
  from_sha="$(git rev-parse HEAD)"
  data_dir="$(node "$mjs" paths --json --repo "$ROOT" | json_field dataDir)" || data_dir=""
  if [ -z "$data_dir" ]; then
    die "Could not locate the family data folder (see above). Nothing was changed."
  fi
  node "$mjs" legacy-check --repo "$ROOT" >/dev/null 2>&1 || code=$?
  if [ "$code" -eq 4 ]; then
    moves=1
  fi

  echo "Backing up before the upgrade…"
  backup_out="$(node "$mjs" backup --kind pre-upgrade --include-checkout --repo "$ROOT" --json ${DATA_CLI_WRITE_FLAGS[@]+"${DATA_CLI_WRITE_FLAGS[@]}"})" ||
    die "The pre-upgrade backup failed (see above). Nothing was changed."
  new_archive="$(printf '%s' "$backup_out" | backup_archive_from_output)"
  if [ -z "$new_archive" ]; then
    die "The pre-upgrade backup did not report its archive. Nothing was changed."
  fi
  echo "Pre-upgrade backup: ${new_archive}"
  record_upgrade_start "${data_dir%/}/${UPGRADE_STATE_FILE}" "$from_sha" "$new_archive" "$moves"

  echo "Moving family content out of the checkout…"
  node "$mjs" migrate-checkout --repo "$ROOT" --backup "$new_archive" ${DATA_CLI_WRITE_FLAGS[@]+"${DATA_CLI_WRITE_FLAGS[@]}"} ||
    die "Moving family content failed (see above); nothing was merged." \
      "Fix it and re-run: $(installer_cmd) --upgrade" \
      "Or go back: $(installer_cmd) --rollback ${UPGRADE_ARCHIVE}"

  # A stale build must not start against the new code mid-upgrade. The sha
  # file lets --rollback put back the build that matches its backup.
  if [ -d .next ]; then
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    pre=".next.pre-upgrade-${ts}"
    while [ -e "$pre" ]; do
      pre="${pre}-$$"
    done
    mv .next "$pre"
    printf '%s\n' "$from_sha" > "$pre/.examify-git-sha"
    echo "Moved the previous build aside: ${pre}"
  fi

  echo "Merging ${UPGRADE_UPSTREAM}…"
  if git merge-base --is-ancestor HEAD '@{u}'; then
    git merge --ff-only --quiet '@{u}' || upgrade_merge_failed
  else
    if ! git merge --no-edit --quiet '@{u}'; then
      git merge --abort >/dev/null 2>&1 || true
      upgrade_merge_failed
    fi
  fi

  rm -rf "$UPGRADE_TMP"
  trap - EXIT
  if [ ! -f install.sh ]; then
    upgrade_step_failed "the merge (it left no install.sh)" "$UPGRADE_ARCHIVE"
  fi
  echo "Running the updated installer…"
  local -a forward=(--upgrade-phase2)
  if [ "$SKIP_BUILD" = "1" ]; then
    forward+=(--skip-build)
  fi
  if [ "$NONINTERACTIVE" = "1" ]; then
    forward+=(--yes)
  fi
  if [ "$ALLOW_OWNER_MISMATCH" = "1" ]; then
    forward+=(--allow-owner-mismatch)
  fi
  exec bash ./install.sh "${forward[@]}"
}

upgrade_merge_failed() {
  die "git merge failed (see above) and was undone." \
    "Family content is already in the data folder; the pre-upgrade backup is ${UPGRADE_ARCHIVE}." \
    "Fix the problem and re-run: $(installer_cmd) --upgrade" \
    "Or go back: $(installer_cmd) --rollback ${UPGRADE_ARCHIVE}"
}

upgrade_step_failed() {
  echo "Upgrade stopped: $1 failed (see above)." >&2
  if [ -n "$2" ]; then
    echo "The pre-upgrade backup is $2." >&2
    echo "Fix the problem and re-run: $(installer_cmd) --upgrade" >&2
    echo "Or go back: $(installer_cmd) --rollback $2" >&2
  else
    echo "Fix the problem and re-run: $(installer_cmd) --upgrade" >&2
  fi
  exit 1
}

# Phase 2: the merged (new) installer. State comes from the data folder, not
# argv; the installer never starts, stops or restarts services.
upgrade_phase2() {
  local data_dir state="" archive=""
  if command -v node >/dev/null 2>&1; then
    data_dir="$(node scripts/examify-data.mjs paths --json --repo "$ROOT" 2>/dev/null | json_field dataDir)" || data_dir=""
    if [ -n "$data_dir" ] && [ -f "${data_dir%/}/${UPGRADE_STATE_FILE}" ]; then
      state="${data_dir%/}/${UPGRADE_STATE_FILE}"
      archive="$(json_field archive < "$state")" || archive=""
    fi
  fi
  (ensure_node) || upgrade_step_failed "the Node.js check" "$archive"
  (ensure_pnpm) || upgrade_step_failed "setting up pnpm" "$archive"

  echo
  echo "Installing dependencies…"
  pnpm install --frozen-lockfile || upgrade_step_failed "pnpm install" "$archive"
  echo "Applying database migrations…"
  pnpm db:migrate || upgrade_step_failed "pnpm db:migrate" "$archive"
  if [ "$SKIP_BUILD" != "1" ]; then
    echo "Building production app…"
    pnpm build || upgrade_step_failed "pnpm build" "$archive"
  fi
  echo "Checking the upgrade…"
  # verify opens the database, so it checks ownership like the writing commands.
  node scripts/examify-data.mjs verify --repo "$ROOT" ${DATA_CLI_WRITE_FLAGS[@]+"${DATA_CLI_WRITE_FLAGS[@]}"} ||
    upgrade_step_failed "examify-data verify" "$archive"

  if [ -n "$state" ]; then
    rm -f "$state"
  fi
  if [ "$SKIP_BUILD" != "1" ]; then
    rm -rf .next.pre-upgrade-*
  fi
  echo
  echo "Upgrade complete."
  if [ -n "$archive" ]; then
    echo "Pre-upgrade backup: ${archive}"
    echo "It holds .env secrets and answer keys; copy it off this machine."
  fi
  if [ "$SKIP_BUILD" = "1" ]; then
    echo "Build skipped: run pnpm build before starting the server."
  fi
  echo "Start or restart the server (for example: pnpm start, or restart your service)."
}

# Newest .next.pre-upgrade-* built from $1 (see upgrade_phase1).
find_pre_upgrade_build() {
  local want="$1" dir found=""
  for dir in .next.pre-upgrade-*; do
    [ -d "$dir" ] || continue
    if [ "$(cat "$dir/.examify-git-sha" 2>/dev/null)" = "$want" ]; then
      found="$dir"
    fi
  done
  printf '%s' "$found"
}

# Back to the version and data in a pre-upgrade backup: reset the checkout
# (--keep refuses to clobber local changes), then restore data, .env and the
# checkout snapshot with a copy of the data CLI taken first (the old sha may
# lack it): this checkout's, else the upstream one (a first upgrade that
# stopped before its merge left the old code).
rollback_flow() {
  local archive="$ROLLBACK_ARCHIVE" manifest sha before tmp pre url data_dir
  require_git_checkout "--rollback"
  if [ ! -f "$archive" ]; then
    die "Backup not found: ${archive}"
  fi
  command -v tar >/dev/null 2>&1 || die "tar is required for --rollback."
  command -v node >/dev/null 2>&1 || die "Node.js is required for --rollback."
  UPGRADE_UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || UPGRADE_UPSTREAM=""
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/examify-rollback.XXXXXX")"
  UPGRADE_TMP="$tmp"
  trap 'rm -rf "$UPGRADE_TMP"' EXIT
  if [ -f scripts/examify-data.mjs ]; then
    cp scripts/examify-data.mjs "$tmp/examify-data.mjs"
  elif [ -z "$UPGRADE_UPSTREAM" ] || ! git show '@{u}:scripts/examify-data.mjs' > "$tmp/examify-data.mjs" 2>/dev/null; then
    die "Neither this checkout nor its upstream has scripts/examify-data.mjs, so the backup cannot be restored. Nothing was changed."
  fi
  if has_env_config; then
    refuse_kept_data_dir_conflict
  fi
  unset EXAMIFY_DATA_DIR DATABASE_URL
  refuse_owner_mismatch
  refuse_if_running "rolling back"
  # The restore refuses a server on these ports even with --allow-running:
  # find out before git reset moves the checkout.
  if [ "$ALLOW_RUNNING" = "1" ] && url="$(server_answering local)"; then
    die "An Examify server is answering at ${url}, and the restore will not replace its database." \
      "Stop it, then re-run. Nothing was changed."
  fi
  manifest="$(tar -xOzf "$archive" MANIFEST.json 2>/dev/null)" ||
    manifest="$(tar -xOzf "$archive" ./MANIFEST.json 2>/dev/null)" ||
    die "${archive} is not an Examify backup (no MANIFEST.json)."
  sha="$(printf '%s' "$manifest" | json_field checkout.gitSha)" || sha=""
  if [ -z "$sha" ]; then
    die "This backup has no checkout snapshot (it is not a pre-upgrade backup), so there is no version to go back to." \
      "To restore only the family data: node scripts/examify-data.mjs restore ${archive}"
  fi
  git cat-file -e "${sha}^{commit}" 2>/dev/null ||
    die "Commit ${sha} is not in this checkout. Run git fetch and re-run."
  before="$(git rev-parse HEAD)"

  echo "Resetting the checkout to ${sha:0:7}…"
  git reset --keep "$sha" ||
    die "git reset --keep ${sha:0:7} refused (it would overwrite local changes; see above). Nothing was changed."
  echo "Restoring the backup…"
  node "$tmp/examify-data.mjs" restore "$archive" --force --with-env --include-checkout --repo "$ROOT" \
    ${DATA_CLI_WRITE_FLAGS[@]+"${DATA_CLI_WRITE_FLAGS[@]}"} ||
    die "Restoring the backup failed (see above). The checkout is now at ${sha:0:7} (it was ${before:0:7})." \
      "Fix the problem and re-run: $(installer_cmd) --rollback ${archive}"
  # That upgrade is over: a later --upgrade records a fresh rollback point.
  data_dir="$(node "$tmp/examify-data.mjs" paths --json --repo "$ROOT" 2>/dev/null | json_field dataDir)" || data_dir=""
  if [ -n "$data_dir" ]; then
    rm -f "${data_dir%/}/${UPGRADE_STATE_FILE}"
  fi

  ensure_node
  ensure_pnpm
  echo "Installing dependencies…"
  pnpm install --frozen-lockfile
  pre="$(find_pre_upgrade_build "$sha")"
  if [ -n "$pre" ]; then
    rm -rf .next
    mv "$pre" .next
    rm -f .next/.examify-git-sha
    echo "Put back the build from before the upgrade (${pre}); removed the newer .next."
  elif [ "$SKIP_BUILD" != "1" ]; then
    echo "Building production app…"
    pnpm build
  fi
  echo
  echo "Rolled back to ${sha:0:7} (was ${before:0:7})."
  echo "The restore moved the data and .env it replaced aside rather than deleting them (listed above)."
  if [ -z "$pre" ] && [ "$SKIP_BUILD" = "1" ]; then
    echo "Build skipped: run pnpm build before starting the server."
  fi
  echo "Start or restart the server (for example: pnpm start, or restart your service)."
}

# The archive carries env config: env/.env or env/.env.local (an install
# configured only through .env.local counts), with or without a leading ./.
archive_has_env() {
  local list nl=$'\n'
  list="$(tar -tzf "$1" 2>/dev/null)" || return 1
  case "${nl}${list}${nl}" in
    *"${nl}env/.env${nl}"*|*"${nl}./env/.env${nl}"*) return 0 ;;
    *"${nl}env/.env.local${nl}"*|*"${nl}./env/.env.local${nl}"*) return 0 ;;
  esac
  return 1
}

main() {
  REPO_URL="${EXAMIFY_REPO_URL:-https://github.com/atk0309/project_Examify.git}"
  PNPM_VERSION="${EXAMIFY_PNPM_VERSION:-10.33.0}"
  MIN_NODE="22.22.2"
  MAX_NODE_MAJOR=23
  DATA_DIR_DEFAULT="./data"
  DATA_MARKER=".examify-data.json"
  DB_INSIDE_CHECKOUT="DATABASE_URL points inside the checkout; keep the database in the family data folder (./data/app.db) or outside the checkout"
  UPGRADE_STATE_FILE=".upgrade-state.json"
  CASE_INSENSITIVE_FS=0
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    CASE_INSENSITIVE_FS=1
  fi

  WRITE_ENV_ONLY=0
  SKIP_BUILD=0
  NONINTERACTIVE="${EXAMIFY_NONINTERACTIVE:-0}"
  ENABLED_PASSWORD_OUTBOX=0
  UPGRADE=0
  UPGRADE_PHASE2=0
  ROLLBACK_ARCHIVE=""
  RESTORE_ARCHIVE=""
  FLAG_DATA_DIR=""
  ALLOW_RUNNING=0
  ALLOW_OWNER_MISMATCH=0
  UPGRADE_ARCHIVE=""
  UPGRADE_TMP=""
  RESTORE_WITH_ENV=0
  WROTE_ENV=0
  KEPT_EXISTING_ENV=0
  FOUND_EXISTING_DB=0

  # Host AUTH_MODE at invoke time (before installer defaults). Used only to
  # refuse a conflict with effective on-disk AUTH_MODE — never to judge mail.
  HOST_AUTH_MODE="${AUTH_MODE-}"
  # Same for the data folder: this run's intent, never what would boot.
  HOST_DATA_DIR_RAW="${EXAMIFY_DATA_DIR-}"
  HOST_DATABASE_URL_RAW="${DATABASE_URL-}"
  HOST_PORT="${PORT-}"

  parse_args "$@"

  DATA_CLI_WRITE_FLAGS=()
  if [ "$ALLOW_OWNER_MISMATCH" = "1" ]; then
    DATA_CLI_WRITE_FLAGS+=(--allow-owner-mismatch)
  fi
  # Archive paths are relative to where the installer was invoked.
  if [ -n "$ROLLBACK_ARCHIVE" ]; then
    ROLLBACK_ARCHIVE="$(expand_tilde "$ROLLBACK_ARCHIVE")"
    ROLLBACK_ARCHIVE="$(abs_path "$PWD" "$ROLLBACK_ARCHIVE")"
  fi
  if [ -n "$RESTORE_ARCHIVE" ]; then
    RESTORE_ARCHIVE="$(expand_tilde "$RESTORE_ARCHIVE")"
    RESTORE_ARCHIVE="$(abs_path "$PWD" "$RESTORE_ARCHIVE")"
  fi

  # --- resolve working directory ---
  # Prefer the Examify checkout that contains this cwd (walk up), so `.env`
  # matches env-store + examify-ingest generate even when invoked from src/.
  if FOUND_ROOT="$(find_examify_root)"; then
    cd "$FOUND_ROOT"
    if [ "$WRITE_ENV_ONLY" != "1" ] && [ "$UPGRADE_PHASE2" != "1" ]; then
      echo "Using Examify checkout: $(pwd)"
    fi
  elif [ "$WRITE_ENV_ONLY" = "1" ]; then
    :
  else
    TARGET="${EXAMIFY_DIR:-examify}"
    if [ -d "$TARGET" ] && (cd "$TARGET" && is_examify_repo); then
      cd "$TARGET"
      echo "Using existing checkout: $(pwd)"
    elif [ "$UPGRADE" = "1" ] || [ "$UPGRADE_PHASE2" = "1" ] || [ -n "$ROLLBACK_ARCHIVE" ]; then
      die "No Examify checkout here. Run this from your Examify checkout (or set EXAMIFY_DIR)."
    else
      if ! command -v git >/dev/null 2>&1; then
        echo "git is required to clone Examify." >&2
        exit 1
      fi
      echo "Cloning ${REPO_URL} into ${TARGET}…"
      git clone --depth 1 "$REPO_URL" "$TARGET"
      cd "$TARGET"
    fi
  fi
  ROOT="$(pwd)"

  if [ "$UPGRADE_PHASE2" = "1" ]; then
    upgrade_phase2
    return 0
  fi
  if [ "$UPGRADE" = "1" ]; then
    upgrade_phase1
    return 0
  fi
  if [ -n "$ROLLBACK_ARCHIVE" ]; then
    rollback_flow
    return 0
  fi

  if [ "$WRITE_ENV_ONLY" != "1" ]; then
    require_data_cli
  fi
  if [ -n "$RESTORE_ARCHIVE" ]; then
    if [ ! -f "$RESTORE_ARCHIVE" ]; then
      die "Backup not found: ${RESTORE_ARCHIVE}"
    fi
    command -v tar >/dev/null 2>&1 || die "tar is required for --restore."
    if archive_has_env "$RESTORE_ARCHIVE"; then
      RESTORE_WITH_ENV=1
    fi
  fi

  if [ "$RESTORE_WITH_ENV" != "1" ]; then
    collect_and_write_env
  else
    # The backup brings its own .env (and with it the data folder).
    if [ -n "$(trim "$FLAG_DATA_DIR")" ]; then
      die "--data-dir is for a new .env; this backup brings its own .env and family data folder."
    fi
    # The restore follows the restored env files (what the app will read);
    # a host value would be silently ignored, so name it instead.
    if [ -n "$(trim "$HOST_DATA_DIR_RAW")" ] || [ -n "$(trim "$HOST_DATABASE_URL_RAW")" ]; then
      die "Host EXAMIFY_DATA_DIR / DATABASE_URL is for a new .env; this backup brings its own .env and family data folder." \
        "Unset them and re-run: the restored .env decides where the data goes."
    fi
    unset EXAMIFY_DATA_DIR DATABASE_URL
    echo "Restoring ${RESTORE_ARCHIVE} with its env files (current ones are kept aside as .env*.before-restore-…)."
  fi

  if [ "$WRITE_ENV_ONLY" = "1" ]; then
    exit 0
  fi

  ensure_node
  ensure_pnpm
  if [ -z "$RESTORE_ARCHIVE" ]; then
    prepare_data_folder
  fi

  echo
  echo "Installing dependencies…"
  pnpm install --frozen-lockfile

  if [ -n "$RESTORE_ARCHIVE" ]; then
    echo "Restoring ${RESTORE_ARCHIVE}…"
    local -a restore_flags=()
    if [ "$RESTORE_WITH_ENV" = "1" ]; then
      restore_flags+=(--with-env)
    fi
    node scripts/examify-data.mjs restore "$RESTORE_ARCHIVE" --repo "$ROOT" \
      ${restore_flags[@]+"${restore_flags[@]}"} ${DATA_CLI_WRITE_FLAGS[@]+"${DATA_CLI_WRITE_FLAGS[@]}"} ||
      die "Restoring the backup failed (see above)."
  fi

  echo "Applying database migrations…"
  pnpm db:migrate

  if [ "$SKIP_BUILD" != "1" ]; then
    echo "Building production app…"
    pnpm build
  fi

  echo
  echo "Examify is ready."
  echo
  if [ -n "$RESTORE_ARCHIVE" ]; then
    echo "Restored from ${RESTORE_ARCHIVE}. Start with: pnpm start   (or: pnpm dev)"
    echo "Open the SITE_URL from the restored env files and sign in as before."
  elif [ "$KEPT_EXISTING_ENV" = "1" ]; then
    echo "Using the existing .env. Start with: pnpm start   (or: pnpm dev)"
    echo "Open the SITE_URL from that file. This run's generated setup code was not written."
    echo "Family data folder: ${DISK_DATA_DIR}"
  else
    echo "  1. Start the server:   pnpm start          (or: pnpm dev)"
    echo "  2. Open SITE_URL:      ${SITE_URL}"
    echo "  3. First run:          ${SITE_URL%/}/setup"
    echo "     Setup code:         ${SETUP_BOOTSTRAP_SECRET}"
    if [ "$FOUND_EXISTING_DB" = "1" ]; then
      echo "     (An existing database was found: sign in as before; /setup only runs while it has no household.)"
    fi
    echo "     Auth mode:          ${AUTH_MODE}"
    echo "     Family data folder: ${DATA_DIR_ABS}"
    echo
    echo "Invite family from the parent dashboard after setup."
    if [ "$AUTH_MODE" = "password" ]; then
      echo "Password sign-in needs no mail. Eligible invite accept and forgot-password requests"
      echo "still require mailbox OTP delivery via ${MAIL_TRANSPORT}."
      echo "Unknown emails and wrong-role reset requests still return a generic sent response."
    fi
    echo "Edit .env and restart to change AUTH_MODE, mail, or Turnstile (TURNSTILE_ENABLED=1)."
    echo
    if [ "$AUTH_MODE" = "local-otp" ] || [ "${MAIL_TRANSPORT}" = "outbox" ]; then
      echo "Local outbox path: ${DATA_DIR_DISPLAY}/outbox (or MAIL_OUTBOX_DIR). Treat it as secret."
      if [ "$AUTH_MODE" = "password" ]; then
        echo "Kid invite OTP codes are read from that directory."
      fi
    fi
    echo "OpenAI / PDF generate: install pdftoppm (poppler-utils) before using Cloud generate."
  fi
  echo "Back up the family data folder with: node scripts/examify-data.mjs backup"
}

# --- collect config, then write or keep .env ---
collect_and_write_env() {
  SITE_URL="${SITE_URL:-}"
  AUTH_SECRET="${AUTH_SECRET:-}"
  SETUP_BOOTSTRAP_SECRET="${SETUP_BOOTSTRAP_SECRET:-}"
  AUTH_MODE="${AUTH_MODE:-}"
  # DATABASE_URL is written only when the host supplied one (still honoured);
  # otherwise the database is <family data folder>/app.db.
  WRITE_DATABASE_URL="$(trim "$HOST_DATABASE_URL_RAW")"
  DATA_DIR_VALUE=""
  DATA_DIR_DISPLAY="$DATA_DIR_DEFAULT"
  DATA_DIR_ABS=""
  DATA_DB_PATH=""
  FOUND_EXISTING_DB=0
  MAIL_WAS_SET=0
  if [ -n "${MAIL_TRANSPORT-}" ]; then
    MAIL_WAS_SET=1
  fi
  MAIL_TRANSPORT="${MAIL_TRANSPORT:-auto}"
  # Interactive: do not pre-fill `test` or prompt() skips. Non-interactive
  # keeps the grader/boot sentinel when the host did not inject a key.
  if [ "$NONINTERACTIVE" = "1" ]; then
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-test}"
  fi

  # Any run a person answers (interactive), plus every full install, shows the
  # banner; only non-interactive --write-env-only stays quiet for scripts.
  if [ "$WRITE_ENV_ONLY" != "1" ] || [ "$NONINTERACTIVE" != "1" ]; then
    echo
    echo "Examify installer"
    echo "A self-hosted exam-practice app for one family. Invite-only; accounts and progress stay on this server."
    echo "AI marking and cloud generate send answer text or study PDFs to the provider you choose."
    echo
  fi

  if [ "$NONINTERACTIVE" != "1" ] && [ -z "${SITE_URL}" ]; then
    echo "Public site URL: the address family devices open, e.g. https://exam.example.com"
    echo "or http://192.168.1.20:3000. localhost only works on this machine."
  fi
  prompt SITE_URL "Public site URL" "http://localhost:3000"
  GENERATED_AUTH_SECRET=0
  GENERATED_SETUP_SECRET=0
  if [ -z "${AUTH_SECRET}" ]; then
    AUTH_SECRET="$(rand_secret 32)"
    GENERATED_AUTH_SECRET=1
  fi
  if [ -z "${SETUP_BOOTSTRAP_SECRET}" ]; then
    SETUP_BOOTSTRAP_SECRET="$(rand_secret 24)"
    GENERATED_SETUP_SECRET=1
  fi
  # An existing .env already names its folder: no prompt (its answer would be
  # discarded when the file is kept). A new .env asks here.
  if [ -f .env ]; then
    resolve_disk_data_paths
    DATA_DIR_DISPLAY="$(disk_data_dir_display)"
  else
    settle_data_dir "$(fresh_data_dir_default)"
  fi

  if [ -z "${AUTH_MODE}" ]; then
    if [ "$NONINTERACTIVE" = "1" ]; then
      AUTH_MODE="password"
    else
      echo
      echo "How should people sign in?"
      echo "  1) password     — email + password; invite accept still emails a mailbox OTP"
      echo "  2) magic-link   — one-time URL via Resend, SMTP, or a local outbox"
      echo "  3) local-otp    — 6-digit code written to the host outbox (tiny / LAN installs)"
      prompt AUTH_MODE_CHOICE "Choose 1, 2, or 3" "1"
      case "${AUTH_MODE_CHOICE}" in
        2|magic-link) AUTH_MODE="magic-link" ;;
        3|local-otp) AUTH_MODE="local-otp" ;;
        *) AUTH_MODE="password" ;;
      esac
    fi
  fi

  case "$AUTH_MODE" in
    password|magic-link|local-otp) ;;
    *)
      echo "AUTH_MODE must be password, magic-link, or local-otp." >&2
      exit 1
      ;;
  esac

  # Mail is required for magic-link / local-otp sign-in AND password-mode
  # invite accept (mailbox OTP). Do not skip this prompt for password.
  if [ "$NONINTERACTIVE" != "1" ] && [ "$MAIL_WAS_SET" != "1" ]; then
    echo
    echo "Email delivery for ${AUTH_MODE}:"
    if [ "$AUTH_MODE" = "password" ]; then
      echo "Password sign-in itself needs no mail. Invite accept still sends a mailbox OTP"
      echo "and fails closed if nothing can deliver it. Do not skip that proof."
    fi
    echo "  1) local outbox  — write codes to ${DATA_DIR_DISPLAY}/outbox (dogfood / LAN; treat as secret)"
    echo "  2) Resend"
    echo "  3) SMTP"
    prompt MAIL_CHOICE "Choose 1, 2, or 3" "1"
    case "${MAIL_CHOICE}" in
      2|resend)
        MAIL_TRANSPORT="resend"
        prompt RESEND_API_KEY "Resend API key" "" secret
        prompt RESEND_FROM "Resend From: address (Name <you@domain>)"
        ;;
      3|smtp)
        MAIL_TRANSPORT="smtp"
        prompt SMTP_HOST "SMTP host"
        prompt SMTP_PORT "SMTP port" "587"
        prompt SMTP_USER "SMTP username" ""
        prompt SMTP_PASS "SMTP password" "" secret
        prompt SMTP_FROM "SMTP From: address"
        ;;
      *)
        MAIL_TRANSPORT="outbox"
        if [ "$AUTH_MODE" = "password" ] || [ "$AUTH_MODE" = "local-otp" ]; then
          ALLOW_LOCAL_OUTBOX=1
          echo "Invite / sign-in codes will be written to ${DATA_DIR_DISPLAY}/outbox. Treat that directory as secret."
        elif confirm "Allow writing sign-in tokens to a local outbox in production?" "n"; then
          ALLOW_LOCAL_OUTBOX=1
        fi
        ;;
    esac
  fi

  if [ "$AUTH_MODE" = "local-otp" ] && [ "${ALLOW_LOCAL_OUTBOX-}" != "1" ]; then
    ALLOW_LOCAL_OUTBOX=1
  fi

  ensure_password_invite_mail

  if [ "$NONINTERACTIVE" != "1" ] && confirm "Enable Cloudflare Turnstile (captcha)? Off by default — skip unless you have Cloudflare keys." "n"; then
    TURNSTILE_ENABLED=1
    prompt NEXT_PUBLIC_TURNSTILE_SITE_KEY "Turnstile site key"
    prompt TURNSTILE_SECRET_KEY "Turnstile secret key" "" secret
  fi

  if [ "$NONINTERACTIVE" != "1" ]; then
    echo
    echo "Optional: ANTHROPIC_API_KEY marks free-text answers by sending each answer, its question,"
    echo "and its rubric to Anthropic. It also powers /onboarding Cloud (Anthropic) generate."
    echo "Leave blank to skip: free-text answers are saved but not marked (they count as not correct)."
    echo "Add it later in /onboarding content setup, or in .env (then restart)."
    prompt ANTHROPIC_API_KEY "Anthropic API key" "" secret
    # Blank keeps the `test` placeholder: the wizard shows "not configured" and
    # production grading treats it as no key (answers saved, not marked).
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-test}"
    echo
    echo "Optional: OPENAI_API_KEY for /onboarding Cloud (OpenAI) generate."
    echo "That generate sends the subject's study files (PDF pages, notes) to OpenAI."
    echo "Same .env store as the wizard. Leave blank to skip (you can set it later)."
    echo "OpenAI generate from PDFs needs pdftoppm (poppler-utils) on PATH; without it,"
    echo "PDF-only generate fails closed. Install: apt install poppler-utils  (or brew install poppler)"
    prompt OPENAI_API_KEY "OpenAI API key" "" secret
  fi

  WROTE_ENV=0
  KEPT_EXISTING_ENV=0
  if [ -f .env ]; then
    if [ "$NONINTERACTIVE" = "1" ]; then
      echo "Keeping existing .env (non-interactive; not overwriting)."
      KEPT_EXISTING_ENV=1
    elif ! confirm ".env already exists. Overwrite?" "n"; then
      echo "Keeping existing .env"
      KEPT_EXISTING_ENV=1
    else
      settle_overwrite_data_dir
      write_env .env
      WROTE_ENV=1
      echo "Wrote .env"
    fi
  else
    write_env .env
    WROTE_ENV=1
    echo "Wrote .env"
  fi
  # Only when this run's SITE_URL was written: a kept .env (declined overwrite,
  # or non-interactive) keeps its own URL, so a note about ours would mislead.
  if [ "$WROTE_ENV" = "1" ]; then
    site_url_note "$SITE_URL"
  fi

  if [ "$WROTE_ENV" = "1" ] && [ "$NONINTERACTIVE" != "1" ]; then
    if [ "$GENERATED_AUTH_SECRET" = "1" ]; then
      echo "Generated AUTH_SECRET."
    fi
    if [ "$GENERATED_SETUP_SECRET" = "1" ]; then
      echo "Generated SETUP_BOOTSTRAP_SECRET (you will type this at /setup)."
      echo "  ${SETUP_BOOTSTRAP_SECRET}"
    fi
  fi

  if [ "$WROTE_ENV" = "1" ] && [ "$ENABLED_PASSWORD_OUTBOX" = "1" ]; then
    claim_password_outbox_enable
  elif [ "$KEPT_EXISTING_ENV" = "1" ]; then
    if [ -n "$HOST_AUTH_MODE" ]; then
      local kept_mode
      kept_mode="$(disk_auth_mode)"
      if [ "$HOST_AUTH_MODE" != "$kept_mode" ]; then
        refuse_kept_auth_mode_conflict "$kept_mode" "$HOST_AUTH_MODE"
      fi
    fi
    refuse_kept_data_dir_conflict
    check_existing_data "$DISK_DATA_DIR" "$DISK_DB_PATH"
    if ! kept_password_has_mail; then
      refuse_kept_password_without_mail
    fi
  fi
  # Children (examify-data, db:migrate, build) read the settled on-disk
  # files, exactly like the app will — never a host copy of these two.
  unset EXAMIFY_DATA_DIR DATABASE_URL
}

# Overwriting an existing .env keeps pointing at the same data unless told
# otherwise: the prompt defaults to the current folder, and a DATABASE_URL
# the files set is carried when it is not simply <folder>/app.db.
settle_overwrite_data_dir() {
  local default
  resolve_disk_data_paths
  default="$(disk_data_dir_display)"
  if [ -z "$WRITE_DATABASE_URL" ] && [ -n "$(trim "$DISK_DATABASE_URL_RAW")" ]; then
    WRITE_DATABASE_URL="$(trim "$DISK_DATABASE_URL_RAW")"
  fi
  settle_data_dir "$default"
  if [ -z "$(trim "$HOST_DATABASE_URL_RAW")" ] && [ -n "$WRITE_DATABASE_URL" ] &&
    same_path "$DATA_DB_PATH" "${DATA_DIR_ABS%/}/app.db"; then
    WRITE_DATABASE_URL=""
  fi
}

main "$@"; exit $?
