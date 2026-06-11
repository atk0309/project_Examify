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

- The `FAMILIES` env var is the entire credential store and privacy boundary — treat it
  (and `AUTH_SECRET`) like a secret, and never commit a real `.env`.
- Env validation fails closed in production: missing security-critical vars crash boot
  rather than falling back to dev defaults.
- Magic-link tokens are stored hashed, are single-use, and expire after 15 minutes;
  sign-in is rate-limited per IP and protected by Cloudflare Turnstile.
