# Configuration

For a new install, let the [installer](installation.md) write `.env`. Edit it from
the checkout and restart the server when changing host settings. Keep it private.
The complete variable reference is [`.env.example`](../.env.example);
[`src/lib/env.ts`](../src/lib/env.ts) validates runtime settings.

## Auth modes

| `AUTH_MODE`  | Sign-in                                  | Mail required                          |
| ------------ | ---------------------------------------- | -------------------------------------- |
| `password`   | Email + password (forgot password: OTP)  | Sign-in: no. Invite + reset: yes (OTP) |
| `magic-link` | One-time URL (Resend, SMTP, or outbox)   | Yes, unless outbox opt-in              |
| `local-otp`  | 6-digit code (outbox, or emailed if set) | Production: `ALLOW_LOCAL_OUTBOX=1`     |

`MAIL_TRANSPORT=auto` picks SMTP when `SMTP_HOST` is set, else Resend when a real
key is set, else the local outbox. `SMTP_FROM` is required only when SMTP is the
active transport. A leftover `SMTP_HOST` does not fail `resend` / `outbox`.
Plaintext SMTP (no STARTTLS / `SMTP_SECURE`) needs `SMTP_ALLOW_INSECURE=1`.

## AI for question banks and marking

Choose an AI during initial setup at `/onboarding`. If you skip setup, return
through **Finish content setup** on the parent dashboard. An API subscription/key,
a signed-in CLI, or a local model is only needed for the provider you choose.
Generation always needs review before Apply.

| Choice         | Server requirement                                                      | PDF generation         |
| -------------- | ----------------------------------------------------------------------- | ---------------------- |
| Anthropic      | `ANTHROPIC_API_KEY`                                                     | Native PDF input       |
| OpenAI         | `OPENAI_API_KEY`                                                        | `pdftoppm`             |
| Claude Code    | Installed and signed in as the app user                                 | Native PDF input       |
| Codex          | Installed and signed in as the app user                                 | `pdftoppm`             |
| Local endpoint | `EXAMIFY_LLM_BASE_URL`, `EXAMIFY_LLM_MODEL`; vision model for PDF pages | `pdftoppm`             |
| Local command  | `EXAMIFY_INGEST_LOCAL_CMD`                                              | Depends on the command |

Install Poppler (`poppler-utils` on Debian/Ubuntu, `poppler` with Homebrew) for
`pdftoppm`. For CLI modes, run `claude auth login` or `codex login` as the same
OS user that runs Examify. A CLI signed in under your own desktop account is
not automatically available to a server service account. Set `EXAMIFY_CLAUDE_BIN`
or `EXAMIFY_CODEX_BIN` to its full path if the app cannot find it.

**After Finish, the wizard closes.** There is currently no in-app way to reopen it
or switch the household's saved AI provider. `EXAMIFY_AI_MODE` is only a fallback
until a provider is saved; changing it does not override that saved choice. You
can repair the selected provider's credentials in `.env` or your service manager
and restart Examify, or sign its CLI back in as the app's OS user. Use the
[CLI workflow](content-authoring.md#cli-workflow) for later question-bank updates.

While setup is open, the wizard can save API keys to the checkout `.env`. Keys injected by a service
manager or hosting platform are host-managed: change them there. Local command
mode builds banks only; marking falls back to an Anthropic key. Test stubs are
for development, never a real household.

Written answers that cannot be marked remain pending. They do not count as
wrong answers in the provisional score. Use Retry marking on your own results
or progress to try again after fixing the provider; completed marks stay intact.
If a provider accepted a request before a crash, retrying may make another paid call.
There is no background retry. Where possible, papers omit written questions
while no marking provider is available. See [content authoring](content-authoring.md).

## Required production settings

- `SITE_URL`: the origin family devices open (scheme, host and port)
- `AUTH_SECRET`: a random secret of at least 32 characters
- `SETUP_BOOTSTRAP_SECRET`: a private first-setup code of at least 16 characters
- `EXAMIFY_DATA_DIR` or `DATABASE_URL`: persistent storage

The installer generates secrets. Documented placeholders are rejected in
production. Keep the folder dedicated to Examify; see [data location](operations.md#where-your-familys-data-lives).

Set `TURNSTILE_ENABLED=1` and both Turnstile keys to enable captcha. Keys alone
do not enable it; an incomplete pair fails production validation. For all other
optional settings (analytics, rate limits, cookies, proxy headers, model names,
custom binaries and data paths), use [`.env.example`](../.env.example) rather
than a second copy of the variable reference.

## Changing sign-in mode

Edit `AUTH_MODE` and restart. Switching to password does not give existing members
a password: they must use Forgot password with their mailbox code. Re-inviting
an existing member does not replace their password. Unset `AUTH_MODE` keeps the
legacy magic-link default; new installer configurations use password.

Very old installs with `FAMILIES` JSON import it once when no households exist.
Keep it for the first upgraded boot, check that the households imported, then
remove it. Families without a parent are skipped; invalid JSON fails production
boot. See `.env.example` for the migration details.
