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
  rather than falling back to dev defaults. Resend and Turnstile are optional.
- Magic-link tokens, local OTPs, and invite tokens are stored hashed, are single-use,
  and expire (15 minutes for links/OTPs, 7 days for invites); sign-in is rate-limited
  per IP. Local OTP also locks a challenge after 5 well-formed wrong 6-digit
  guesses (recorded in `rate_limit_events` under `otp:{email}:{role}`).
  `/signin/verify` is magic-link only and refuses `otp:` bearers so the 1e6
  OTP space cannot be guessed via GET without the lock.
  Passwords are stored as scrypt hashes (`users.password_hash`); `/setup`
  hashes only after captcha, rate-limit, and the setup secret pass.
  SMTP AUTH/DATA is refused on a connection that never upgraded to TLS
  unless `SMTP_ALLOW_INSECURE=1`. Cloudflare
  Turnstile is verified on the server when keys are set.
- **Do not write magic-link bearer tokens or OTP codes to disk in production
  unless you opt in.** Unset Resend / `RESEND_API_KEY=test` uses a local outbox
  only in dev/test. Production with no real mail transport returns the generic
  “sent” response and logs server-side — it does **not** write `data/outbox`,
  even if `RESEND_API_KEY=test`. `ALLOW_LOCAL_OUTBOX=1` is a dangerous opt-in
  that stores raw sign-in URLs or OTP codes on the host filesystem; treat that
  directory as secret material and never enable it on a shared or exposed disk.
  `AUTH_MODE=local-otp` and `MAIL_TRANSPORT=outbox` require this opt-in in
  production. The writer creates the directory as `0700` and each message as `0600`.
- Prefer `AUTH_MODE=password` on a tiny self-host if you do not want to run
  email. `AUTH_SECRET` and `SETUP_BOOTSTRAP_SECRET` remain the host secrets.

## Password-mode invite links are secrets

When `AUTH_MODE=password`, `/invite/<token>` URLs are **bearer tokens**. Sharing
the link is sharing household access.

- **Email-lock is not mailbox verification.** It only requires the joiner to type
  the locked address; it does not prove they can receive mail there. Anyone who
  has the URL and knows or guesses the locked email can set a password and join.
- Open student invites are broader still: anyone with the URL can pick an email
  and join.
- Treat invite links like passwords. Do not post them publicly, in tickets, or
  in chat logs. Revoke unused or leaked links from the parent dashboard.
- Prefer an email lock on every invite. Parent invites are already required to
  be locked; lock student invites too when you know the address.
- In `magic-link` / `local-otp` modes, accept still sends a mailbox challenge, so
  the invite URL alone is not enough to join. Password mode has no mailbox proof
  at accept time — that is the difference.
