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
  email for **sign-in**. Password-mode invite accept still needs SMTP, Resend,
  or an allowed outbox (and fails closed if none can deliver). `install.sh`
  default password mode enables that outbox when no SMTP / Resend is set so
  kid invites are not stranded. `AUTH_SECRET` and `SETUP_BOOTSTRAP_SECRET`
  remain the host secrets.

## Password-mode invite links are secrets

When `AUTH_MODE=password`, `/invite/<token>` URLs are still **secrets** (sharing
the link starts a join), but accept does **not** complete — and does **not**
stamp `emailVerifiedAt` — until the invitee proves the mailbox.

- **Mailbox proof before join.** Password-mode accept issues a one-time code to
  the typed address (same local-OTP + mail transport as `AUTH_MODE=local-otp`).
  Membership and `emailVerifiedAt` are set only when that code is consumed.
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
