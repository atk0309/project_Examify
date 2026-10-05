# Troubleshooting

## Personal study (Windows/Linux package)

Start with the launcher window. You do not need Node, pnpm or a source checkout
to troubleshoot a packaged installation. Keep your installation folder intact.
[Install and reopen](solo-installation.md) · [Backup and recovery](solo-maintenance.md)

### Download is blocked or the checksum does not match

Preview artifacts expire. A missing artifact or release-download error does not
mean your computer needs developer tools. Download a complete matching artifact
from a successful run, extract it, and keep its installer and archive together.
On Linux, keep `install-solo.sh` and the matching archive together; on Windows,
keep `install.cmd`, `install.ps1` and the ZIP together.

For a checksum mismatch, download that same complete artifact again. Do not edit
the checksum, mix files from different runs or unpack and launch unchecked files.
If it still fails, report the artifact/run and safe error text. Installers are
unsigned; stop at browser, SmartScreen or organizational-policy warnings. Do not
disable security software or change system execution policy to get past them.

### The browser did not open, or a saved link no longer works

Choose a default browser in your OS settings. Linux also needs `xdg-open`.
Keep the launcher window open and open the **Examify** shortcut again. It creates
a fresh one-use browser session; a bookmark or copied launch link cannot do that.
If reopening fails, stop the launcher with Ctrl+C and launch again. Do not post
launch URLs or cookies in a support request.

If the shortcut is missing, open the installation folder and run `Examify.cmd`
(Windows) or `./Examify` from a terminal (Linux). The installer prints this path.

### Examify will not start, or says it is still running

Use the launcher window's error, not a guessed `localhost:3000` address. Solo
chooses available local ports each time it starts; it does not need a public port
or firewall exception. Stop any Examify launcher you already opened, then retry.
Do not kill unrelated Node programs, delete lock files or expose the service to
your network. After a crash, relaunch normally; stale process markers do not need
manual deletion.

For missing/damaged files, keep the installation and make a private backup before
repair. A verified same-version installer can repair application files, but a
damaged bootstrap needs [recovery into a separate folder](solo-maintenance.md#back-up-or-recover-a-solo-installation).
Do not delete the database to make startup succeed. A household-data refusal means
you must choose a separate solo folder, not remove the household marker.

### My progress or question bank seems missing

Reopen the same installation through its root launcher. A second installation
folder has separate data. After an upgrade, current data can live under `states/`;
the root `data/` may be an older snapshot. Do not move those folders around.
Generation alone does not add questions to practice: review and **Apply** first.
For unfinished practice, select the saved subject under **Continue where you left off**. [Restore a complete backup](solo-maintenance.md#back-up-or-recover-a-solo-installation)
if needed, preserving the newer installation and noting that later work will not
be in an older backup.

### What to include in a support request

- Package version (the `version` value in `installation.json`) and the preview
  run link or source commit, if known. Do not attach the whole installation
- Windows edition/build or Linux distribution/version, x64 architecture, and
  browser name/version
- What you selected or ran, what you expected, and what happened instead
- The short error code or message, with personal paths/usernames removed

Never attach `.env`, `config/`, cookies, launch/invite URLs, backups, databases,
provider keys, answers or uploaded material. Inspect screenshots for private
content before sharing. Do not post raw logs without checking them. Use
[private security reporting](../SECURITY.md) for suspected vulnerabilities.

## Household or source installations

The commands below are for a source checkout, as the OS user running the server.
Packaged solo users should use the steps above instead.

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

In solo mode, open **AI settings** from practice. In household mode, the parent
dashboard names the provider and its readiness, and the admin can open **AI settings** (`/settings/ai`) to change the provider and refresh
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
