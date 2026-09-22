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
#   .env (and .env.local when present) — never a transient host process env.
#   Host ALLOW_LOCAL_OUTBOX=1 must not greenlight a broken password file.
#   A kept password-mode file with no SMTP / Resend / allowed outbox is
#   refused (invite accept would fail closed; this run does not claim to
#   enable an outbox). Host AUTH_MODE that differs from effective on-disk
#   AUTH_MODE (.env.local wins over .env, including an empty AUTH_MODE=)
#   is refused with copy that names that effective mode, not the host's
#   and not .env alone when local wins.
#   Default AUTH_MODE=password enables a local outbox so invite-accept OTP
#   (mailbox proof) can be read from data/outbox — only when this run writes
#   .env. Set SMTP_* / RESEND_* to use real mail instead. Invite accept never
#   skips that OTP. RESEND_API_KEY=test is not a mail path.
#
# Flags:
#   --write-env-only   write .env and exit (used by tests)
#   --skip-build       install + migrate, skip pnpm build
#   --yes              same as EXAMIFY_NONINTERACTIVE=1
#   --help             print this usage (safe when $0 is bash)
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
  .env (and .env.local when present) — never a transient host process env.
  Host ALLOW_LOCAL_OUTBOX=1 must not greenlight a broken password file.
  A kept password-mode file with no SMTP / Resend / allowed outbox is
  refused (invite accept would fail closed; this run does not claim to
  enable an outbox). Host AUTH_MODE that differs from effective on-disk
  AUTH_MODE (.env.local wins over .env, including an empty AUTH_MODE=)
  is refused with copy that names that effective mode, not the host's
  and not .env alone when local wins.
  Default AUTH_MODE=password enables a local outbox so invite-accept OTP
  (mailbox proof) can be read from data/outbox — only when this run writes
  .env. Set SMTP_* / RESEND_* to use real mail instead. Invite accept never
  skips that OTP. RESEND_API_KEY=test is not a mail path.

Flags:
  --write-env-only   write .env and exit (used by tests)
  --skip-build       install + migrate, skip pnpm build
  --yes              same as EXAMIFY_NONINTERACTIVE=1
  --help             print this usage (safe when $0 is bash)

OpenAI / PDF generate needs pdftoppm (poppler-utils) on PATH.
EOF
}

REPO_URL="${EXAMIFY_REPO_URL:-https://github.com/atk0309/project_Examify.git}"
PNPM_VERSION="${EXAMIFY_PNPM_VERSION:-10.33.0}"
MIN_NODE="22.22.2"
MAX_NODE_MAJOR=23

WRITE_ENV_ONLY=0
SKIP_BUILD=0
NONINTERACTIVE="${EXAMIFY_NONINTERACTIVE:-0}"
ENABLED_PASSWORD_OUTBOX=0

# Host AUTH_MODE at invoke time (before installer defaults). Used only to
# refuse a conflict with effective on-disk AUTH_MODE — never to judge mail.
HOST_AUTH_MODE="${AUTH_MODE-}"

for arg in "$@"; do
  case "$arg" in
    --write-env-only) WRITE_ENV_ONLY=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --yes|-y) NONINTERACTIVE=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

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
  local input=/dev/tty
  if [ ! -r /dev/tty ]; then
    input=/dev/stdin
  fi
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$message" "$default" > /dev/tty 2>/dev/null || printf '%s [%s]: ' "$message" "$default"
  else
    printf '%s: ' "$message" > /dev/tty 2>/dev/null || printf '%s: ' "$message"
  fi
  if [ "$secret" = "secret" ]; then
    # shellcheck disable=SC2162
    IFS= read -rs reply < "$input" || true
    printf '\n' > /dev/tty 2>/dev/null || printf '\n'
  else
    # shellcheck disable=SC2162
    IFS= read -r reply < "$input" || true
  fi
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

# On-disk dotenv only: .env.local wins over .env (same file order Next.js
# loads), including an empty assignment that shadows .env. Host process
# env is ignored so a transient ALLOW_LOCAL_OUTBOX=1 on the installer
# cannot greenlight a broken file.
disk_env_get() {
  local key="$1"
  local value=""
  if value="$(env_file_get .env.local "$key")"; then
    printf '%s' "$value"
    return 0
  fi
  value="$(env_file_get .env "$key")" || true
  printf '%s' "$value"
}

# AUTH_MODE written in the kept `.env` only (not host, not .env.local).
# Omitted line is the runtime default (magic-link). Used to name an override.
kept_env_auth_mode() {
  local mode
  mode="$(env_file_get .env AUTH_MODE)"
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
  echo "so kid invite codes land in data/outbox (treat that directory as secret)." >&2
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
# Never claim .env alone when .env.local wins, and never claim the host value.
refuse_kept_auth_mode_conflict() {
  local disk_mode="$1"
  local host_mode="$2"
  local env_mode
  env_mode="$(kept_env_auth_mode)"
  if env_file_has .env.local AUTH_MODE && [ "$disk_mode" != "$env_mode" ]; then
    echo "Keeping existing .env. Host AUTH_MODE=${host_mode}, but on-disk AUTH_MODE=${disk_mode} (.env.local overrides .env AUTH_MODE=${env_mode})." >&2
  else
    echo "Keeping existing .env. Host AUTH_MODE=${host_mode}, but the kept file is AUTH_MODE=${disk_mode}." >&2
  fi
  echo "This run did not overwrite .env. Unset AUTH_MODE to keep this file, or remove .env and re-run." >&2
  exit 1
}

confirm() {
  local message="$1"
  local default="${2:-n}"
  local reply=""
  if [ "$NONINTERACTIVE" = "1" ]; then
    [ "$default" = "y" ]
    return $?
  fi
  local input=/dev/tty
  if [ ! -r /dev/tty ]; then
    input=/dev/stdin
  fi
  printf '%s [%s]: ' "$message" "$default" > /dev/tty 2>/dev/null || printf '%s [%s]: ' "$message" "$default"
  # shellcheck disable=SC2162
  IFS= read -r reply < "$input" || true
  reply="${reply:-$default}"
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

write_env() {
  local dest="${1:-.env}"
  local old_umask
  old_umask="$(umask)"
  umask 077
  {
    printf '%s\n' '# Generated by install.sh. Edit and restart the app after changes.'
    printf '\n'
    printf 'SITE_URL=%s\n' "${SITE_URL}"
    printf 'AUTH_SECRET=%s\n' "${AUTH_SECRET}"
    printf 'SETUP_BOOTSTRAP_SECRET=%s\n' "${SETUP_BOOTSTRAP_SECRET}"
    printf 'DATABASE_URL=%s\n' "${DATABASE_URL}"
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
  if [ -n "${NEXT_PUBLIC_TURNSTILE_SITE_KEY-}" ]; then
    printf 'TURNSTILE_ENABLED=1\n' >> "$dest"
    printf 'NEXT_PUBLIC_TURNSTILE_SITE_KEY=%s\n' "$NEXT_PUBLIC_TURNSTILE_SITE_KEY" >> "$dest"
    printf 'TURNSTILE_SECRET_KEY=%s\n' "${TURNSTILE_SECRET_KEY-}" >> "$dest"
  fi
  chmod 600 "$dest"
  umask "$old_umask"
}

# --- resolve working directory ---
# Prefer the Examify checkout that contains this cwd (walk up), so `.env`
# matches env-store + examify-ingest generate even when invoked from src/.
if FOUND_ROOT="$(find_examify_root)"; then
  cd "$FOUND_ROOT"
  if [ "$WRITE_ENV_ONLY" != "1" ]; then
    echo "Using Examify checkout: $(pwd)"
  fi
elif [ "$WRITE_ENV_ONLY" = "1" ]; then
  :
else
  TARGET="${EXAMIFY_DIR:-examify}"
  if [ -d "$TARGET" ] && (cd "$TARGET" && is_examify_repo); then
    cd "$TARGET"
    echo "Using existing checkout: $(pwd)"
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

# --- collect config ---
SITE_URL="${SITE_URL:-}"
AUTH_SECRET="${AUTH_SECRET:-}"
SETUP_BOOTSTRAP_SECRET="${SETUP_BOOTSTRAP_SECRET:-}"
AUTH_MODE="${AUTH_MODE:-}"
DATABASE_URL="${DATABASE_URL:-}"
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

if [ "$WRITE_ENV_ONLY" != "1" ]; then
  echo
  echo "Examify installer"
  echo "A self-hosted exam-practice app for one family. Invite-only; data stays on this box."
  echo
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
prompt DATABASE_URL "SQLite path" "file:./data/app.db"

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
  echo "  1) local outbox  — write codes to data/outbox (dogfood / LAN; treat as secret)"
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
        echo "Invite / sign-in codes will be written to data/outbox. Treat that directory as secret."
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
  echo "ANTHROPIC_API_KEY for /onboarding Cloud (Anthropic) generate."
  echo "Same .env store as the wizard. Leave blank to keep the test sentinel (you can set it later)."
  prompt ANTHROPIC_API_KEY "Anthropic API key" "" secret
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-test}"
  echo
  echo "Optional: OPENAI_API_KEY for /onboarding Cloud (OpenAI) generate."
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
    write_env .env
    WROTE_ENV=1
    echo "Wrote .env"
  fi
else
  write_env .env
  WROTE_ENV=1
  echo "Wrote .env"
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
    kept_mode="$(disk_auth_mode)"
    if [ "$HOST_AUTH_MODE" != "$kept_mode" ]; then
      refuse_kept_auth_mode_conflict "$kept_mode" "$HOST_AUTH_MODE"
    fi
  fi
  if ! kept_password_has_mail; then
    refuse_kept_password_without_mail
  fi
fi

if [ "$WRITE_ENV_ONLY" = "1" ]; then
  exit 0
fi

ensure_node
ensure_pnpm

echo
echo "Installing dependencies…"
pnpm install --frozen-lockfile

echo "Applying database migrations…"
pnpm db:migrate

if [ "$SKIP_BUILD" != "1" ]; then
  echo "Building production app…"
  pnpm build
fi

echo
echo "Examify is ready."
echo
if [ "$KEPT_EXISTING_ENV" = "1" ]; then
  echo "Using the existing .env. Start with: pnpm start   (or: pnpm dev)"
  echo "Open the SITE_URL from that file. This run's generated setup code was not written."
else
  echo "  1. Start the server:   pnpm start          (or: pnpm dev)"
  echo "  2. Open SITE_URL:      ${SITE_URL}"
  echo "  3. First run:          ${SITE_URL%/}/setup"
  echo "     Setup code:         ${SETUP_BOOTSTRAP_SECRET}"
  echo "     Auth mode:          ${AUTH_MODE}"
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
    echo "Local outbox path: data/outbox (or MAIL_OUTBOX_DIR). Treat it as secret."
    if [ "$AUTH_MODE" = "password" ]; then
      echo "Kid invite OTP codes are read from that directory."
    fi
  fi
  echo "OpenAI / PDF generate: install pdftoppm (poppler-utils) before using Cloud generate."
fi
