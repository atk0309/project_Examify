# Troubleshooting

Start in the Examify checkout, as the user that runs the server. Keep the error
message, Node version and command you ran. Never include `.env`, outbox messages,
backup archives, student answers or study files in a public report.

## `pnpm start` cannot find package.json

You are outside the checkout. Run `cd examify` (or the path printed by the
installer), then `pnpm start`. A piped installer cannot change the directory of
your original terminal.

## Node version rejected or SQLite binding fails

Examify requires Node 22.22.2–22.x. Check `node --version` in the same terminal or
service account that runs the app. After changing Node, run
`pnpm install --frozen-lockfile` again so native dependencies match the runtime.
If a build tool is missing, install your OS's Python/C++ toolchain and retry.

## Production build missing

From the checkout, run `pnpm build` before `pnpm start`. A successful
`./install.sh --skip-build` has not created a production build.

## Phone cannot open the site or invitation

`localhost` points to the device opening the link. Set `SITE_URL` in `.env` to
the server address your family can reach, restart Examify, and create a fresh
invitation. Check the server port and firewall. Behind a reverse proxy, forward
Host and scheme as shown in [HTTPS setup](operations.md#deploying-with-https).

## Invitation or reset says sent, but there is no email

The screen deliberately does not disclose whether an account exists. Check:

- Was that person invited, and did they choose the correct student/parent role?
- Is mail configured as SMTP, Resend, or local outbox?
- In outbox mode, did you read the file on the server? [How to read it](installation.md#read-a-local-outbox-code)
- For SMTP/Resend, do server logs show a delivery error? Is the From address valid?

`RESEND_API_KEY=test` is not a production delivery method. Password sign-in works
without mail, but accepting invitations and resetting passwords still need it.

## App fails to boot or health returns 503

Do not delete the database to make boot succeed. Check that persistent storage is
mounted and the service account can read the configured data folder. Run:

```bash
pnpm examify:data paths --check
```

`db_missing` means the configured database is absent. For a genuinely new install,
run `pnpm db:migrate`. For an existing household, check the mount and configured
path first, then restore the intended backup if necessary. `unsafe_data_dir`
means the folder is not safe for Examify to use; do not bypass the guard.
`db_error` needs the server-side error and a backup before attempting repairs.

Production also rejects placeholder secrets, invalid auth settings and incomplete
Turnstile key pairs. See [configuration](configuration.md) and `.env.example`.

## AI unavailable or written answers not marked

The parent dashboard names the marking provider and its readiness. The household
admin can open **AI settings** (`/settings/ai`) to change the provider and refresh
readiness, including after Finish. This checks configuration and CLI sign-in, not
API-key validity or a paid provider request (see [configuration](configuration.md#change-ai-after-setup)). A CLI
must be installed and signed in as the same OS user that runs Examify, including
when launched by a service manager.
PDF generation with Codex or a local vision endpoint requires `pdftoppm`. OpenAI
sends PDFs directly to a PDF-capable model; keep their combined size under 50 MB
per subject (and each wizard upload under 8 MiB).
Check the provider's error and account availability; changing an API key in a host
service manager requires restarting the service. Do not turn on `GRADING_STUB=1`
on a real install: it awards full marks without evaluating answers.

After fixing the provider, open your results or progress and choose Retry
marking. It updates the saved attempt rather than creating a new one, and only
retries pending answers. If another marking request is still active, wait for it
to finish; an interrupted request unlocks after two minutes. A server crash after
the provider accepted a request can mean another paid call when you retry.

Older saved attempts may have no Retry marking button because their original
rubrics were not saved. Their pending answers stay out of scores and averages.

## Upgrade or restore stopped

Keep the printed backup path. Stop the server and follow the exact rerun or
rollback command in the error. Do not delete the data folder or run
`git clean -fdx` / `git stash -a`: those can remove `.env` and `./data`.
See [update recovery](operations.md#upgrading) and
[restore/rollback](operations.md#backups-and-restore).
