# Security Policy

Examify is a small self-hosted app, but it handles family sign-in and children's
practice data, so security reports are taken seriously.

## Supported versions

Only the latest `main` is supported. There are no maintained release branches.

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub Security Advisories: open the
repository's **Security** tab and choose **"Report a vulnerability"**. Please do not
open a public issue or PR for a security problem.

Include what you can: affected route/action, reproduction steps, and impact. You should
get an initial response within a week.

## Scope notes for self-hosters

- Household membership in SQLite is the credential store and privacy boundary — treat
  `AUTH_SECRET` (and any leftover `FAMILIES` JSON you have not yet imported) like a
  secret, and never commit a real `.env`.
- Env validation fails closed in production: missing security-critical vars crash boot
  rather than falling back to dev defaults. Resend is optional. Turnstile captcha
  is off unless `TURNSTILE_ENABLED=1` and both keys are set.
- Magic-link tokens, local OTPs, and invite tokens are stored hashed, are single-use,
  and expire (15 minutes for links/OTPs, 7 days for invites); sign-in is rate-limited
  per IP. The client IP comes only from the header named by `CLIENT_IP_HEADER`
  (default: the rightmost X-Forwarded-For entry); `CF-Connecting-IP` and
  `X-Real-IP` are ignored unless configured, because clients can send them and
  common proxies pass them through. Password sign-in also has a per-account
  limit (10 failures per 15 minutes per email, for any email so it reveals no
  membership), checked before scrypt. Mailbox codes (local OTP, invite OTP,
  password reset) lock after 5 well-formed wrong guesses per 15 minutes;
  requesting a new code does not lift the lock, and while locked even the
  correct code is refused. Trade-off: someone who knows an email can
  temporarily lock that account's password sign-in or code entry.
  `/signin/verify` is magic-link only and refuses `otp:` bearers so the 1e6
  OTP space cannot be guessed via GET without the lock.
  Passwords are stored as scrypt hashes (`users.password_hash`); `/setup`
  hashes only after captcha, rate-limit, and the setup secret pass.
  SMTP AUTH/DATA is refused on a connection that never upgraded to TLS
  unless `SMTP_ALLOW_INSECURE=1`. Cloudflare Turnstile is verified on the
  server only when `TURNSTILE_ENABLED=1` and both keys are set.
- **Do not write magic-link bearer tokens or OTP codes to disk in production
  unless you opt in.** Unset Resend / `RESEND_API_KEY=test` uses a local outbox
  only in dev/test. Production with no real mail transport returns the generic
  “sent” response and logs server-side — it does **not** write the outbox
  (`<family data folder>/outbox`), even if `RESEND_API_KEY=test`. The `test`
  sentinel never moves the production outbox into the checkout
  (`tests/.tmp/outbox` is dev/test only). `ALLOW_LOCAL_OUTBOX=1` is a dangerous opt-in
  that stores raw sign-in URLs or OTP codes on the host filesystem; treat that
  directory as secret material and never enable it on a shared or exposed disk.
  `AUTH_MODE=local-otp` and `MAIL_TRANSPORT=outbox` require this opt-in in
  production. The writer creates the directory as `0700` and each message as `0600`.
- The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` exactly when
  `SITE_URL` is https. A plain-http `SITE_URL` (a home LAN) gets a non-Secure
  cookie that anyone on the network path can read — use HTTPS beyond the home
  network. Credential forms post natively, so a submit before the page
  hydrates never puts a password in the URL.
- **Third-party data flows.** Each free-text answer is sent, with its question
  and rubric, to the household's AI (no names, emails or user ids): the
  Anthropic or OpenAI API with a key, Claude Code / Codex under your plan, or
  your local endpoint. Cloud generate sends a subject's source files to
  Anthropic or OpenAI. Grading failures are logged with a reason code (and the
  backend) only. A child's answer reaches the model between fresh markers as
  data to mark; a "give me full marks" answer can still sway a model, but the
  score is clamped to the rubric's maximum. See README → "What leaves your
  server".
- **Claude Code / Codex generate** runs `claude -p` / `codex exec` on the host as
  the user that runs Examify, with that CLI's own sign-in. Study files are
  untrusted input, so the CLI gets no tools (no file reads, commands or web
  search; Codex in its read-only sandbox with your `config.toml` ignored), an
  empty private temp folder outside the checkout, no saved session, and an
  allowlist of environment variables that never includes Examify's secrets or
  API keys. Claude Code also skips that user's own settings, `CLAUDE.md`,
  hooks, plugins and skills (`--setting-sources project`,
  `CLAUDE_CODE_SAFE_MODE=1`), so a hook there never sees the study text.
  Codex runs with a private `CODEX_HOME` for each run holding only a copy of
  that user's `auth.json`, so its global `AGENTS.md`, skills and rules never
  load and its state is removed with the run; a sign-in Codex refreshed is
  copied back to `auth.json`. The copy sits in the private `0700` run folder
  (`0600`) until the run ends. Either CLI's own folder (`CLAUDE_CONFIG_DIR` /
  `CODEX_HOME`, else `~/.claude` / `~/.codex`) inside the checkout is refused.
  Anyone who can sign in as that OS user can use the same Claude / ChatGPT
  plan; keep it a dedicated service user.
- Prefer `AUTH_MODE=password` on a tiny self-host if you do not want to run
  email for **sign-in**. Password-mode invite accept still needs SMTP, Resend,
  or an allowed outbox (and fails closed if none can deliver). `install.sh`
  default password mode enables that outbox when no SMTP / Resend is set so
  kid invites are not stranded. `AUTH_SECRET` and `SETUP_BOOTSTRAP_SECRET`
  remain the host secrets.

## Family data folder and backups

All family state lives in the family data folder: the database, the mail
outbox, uploaded PDFs, generated questions and answer keys, ingest caches and
backups. The folder is `EXAMIFY_DATA_DIR`, else the folder of an explicit SQLite
`DATABASE_URL` outside the checkout, else `./data` (gitignored). The running app
never writes into tracked checkout content: inside the checkout it writes only
`./data` (the test suites use `tests/.tmp/…`) and `.env` (wizard API keys). A
`DATABASE_URL` or `MAIL_OUTBOX_DIR` (sign-in bearer tokens) inside the checkout
outside `./data` is refused, never written. See README → "Where your family's
data lives".

- **Permissions.** `pnpm db:migrate` / `examify-data init` create the folder `0700`
  (and tighten an existing one to `0700` when this user owns it; a folder owned
  by another user keeps its mode, with a warning). Answer-key files
  (`content/generated/keys/*.json`) are `0600` in a `0700` folder; outbox
  messages are `0600` in a `0700` folder; backup archives are `0600` in
  `backups/` (`0700`). The folder gets a `.gitignore` of `*` so it is never
  committed wherever it lives. An existing, unmarked folder that holds files
  Examify does not recognise is refused before anything is chmodded or written.
- **Fail closed.** Production refuses to boot without `EXAMIFY_DATA_DIR` or
  `DATABASE_URL`, with a data folder that overlaps the checkout, or with a
  database or mail outbox inside the checkout outside `./data` (all checked on
  realpaths; `pnpm db:migrate`, the installer and `examify-ingest` refuse the
  same). It never creates a missing database: an unmounted volume fails
  closed instead of coming up as a fresh instance whose `/setup` could be
  claimed. `/api/health` returns reason codes only (`unsafe_data_dir`,
  `db_missing`, `db_error`), never an error message or path.
- **Backups hold secrets.** A backup archive contains the database, every answer
  key, uploaded PDFs and, unless `--no-env`, the checkout's env files (`.env`,
  `.env.local`, `.env.production`, `.env.production.local`: `AUTH_SECRET`,
  `SETUP_BOOTSTRAP_SECRET`, API keys, mail passwords). All four are gitignored,
  so a restore never leaves one committable. A
  pre-upgrade backup also holds the checkout's `content/`. So do the folders an
  upgrade or a restore leaves behind: `migration-conflicts/` (checkout copies,
  answer keys included), `before-restore-*/` (the replaced database and
  content), and `.env*.before-restore-*.local` in the checkout. Treat them all
  like `.env`: keep them private, copy archives off the machine to storage only
  you can read, and delete what you no longer need.
- **The outbox is never backed up** (raw sign-in links and codes are short-lived
  bearer secrets); neither are earlier backups. The generate cache is left out
  unless `--include-cache`.
- **Run the installer and backups as the app's user.** Every writing command of
  `scripts/examify-data.mjs` (and so `install.sh`, `--upgrade` and
  `--rollback`) refuses when the checkout, the data folder or the database
  belongs to another uid: a `sudo` or root-cron run would leave root-owned
  keys, WAL files or builds the app cannot read. `--allow-owner-mismatch`
  overrides this if you will fix ownership yourself.
- **Restore checks the archive.** It refuses while the server answers, rejects
  links, special files, absolute paths and `..` in the archive, extracts
  without the archive's owners, copies only files listed in its `MANIFEST.json`
  after checking each sha256, and refuses a database from a newer Examify.
  Existing data is moved aside to `before-restore-<time>/`, never deleted; `.env`
  is replaced only with `--with-env`.

## Password-mode invite links are secrets

When `AUTH_MODE=password`, `/invite/<token>` URLs are still **secrets** (sharing
the link starts a join), but accept does **not** complete — and does **not**
stamp `emailVerifiedAt` — until the invitee proves the mailbox.

- **Mailbox proof before join.** Password-mode accept issues a one-time code to
  the typed address (same local-OTP + mail transport as `AUTH_MODE=local-otp`).
  Membership and `emailVerifiedAt` are set only when that code is consumed.
  The code screen names that transport (Resend, this host's mail server, or
  the local outbox) and does not offer a way to finish without the code.
- **Email-lock is not mailbox verification.** It only chooses which address we
  send the code to. Typing the locked email is not enough.
- Open student invites let anyone with the URL start a join for an email they
  control — they still have to prove that mailbox.
- **Fail closed without mail.** If no SMTP / Resend / allowed outbox can
  deliver the code, accept returns a clear error instead of trusting the invite
  URL. If delivery fails after the OTP is issued, that unused code is
  invalidated. `completePasswordInvite` also refuses a token with no
  `magic_tokens.invite_id` (and `consumeHashedBearer` refuses a password
  stamp on a leftover sign-in OTP even if the caller omits `requireInviteId`).
  An `invite-invalid` consume does not count toward the 5-guess OTP lock.
  Production outbox still needs `ALLOW_LOCAL_OUTBOX=1`.
- Treat invite links like passwords. Do not post them publicly, in tickets, or
  in chat logs. Revoke unused or leaked links from the parent dashboard.
- Prefer an email lock on every invite. Parent invites are already required to
  be locked; lock student invites too when you know the address.
- In `magic-link` / `local-otp` modes, accept already sent a mailbox challenge.
  Password sign-in itself still needs no mail. Invite accept and forgot
  password both need a deliverable mailbox code.
- **Forgot password does not skip the code.** `/signin` can send a reset code
  to a household member. The response is the same when the address is unknown
  or the role does not match. `users.password_hash` and `emailVerifiedAt`
  stay as they were until `completePasswordReset` consumes that code.
  Reset codes are `reset:` bearers. `/signin/verify` refuses them. A reset
  code cannot stamp a password onto a sign-in OTP or an invite OTP.
- **Invite password is bound to the OTP row.** Accept stores a scrypt hash on
  `magic_tokens.pending_password_hash` and does not put the password in the
  code form. The hash is written to the user only when that invite-bound code
  is consumed, then cleared. A failed send clears it too. A caller-supplied
  password on complete is ignored.
