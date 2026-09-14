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
- Magic-link tokens and invite tokens are stored hashed, are single-use, and expire
  (15 minutes for magic links, 7 days for invites); sign-in is rate-limited per IP.
  Cloudflare Turnstile is verified on the server when keys are set.
