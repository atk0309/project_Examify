# Household install and first login

For private self-study on this computer, start with the [solo launcher guide](solo-installation.md).
This guide is the optional shared/household path and remains the upgrade path for existing families.

## Before you start

Use a machine that will stay on while your family uses the app. Run commands as
its normal Examify user, not root. The Bash installer needs:

- Node **22.22.2 or newer in the 22.x line**; Node 23 and later are rejected
- Git, Bash and curl
- Corepack or pnpm **10.33.0**
- Internet access to GitHub and the npm registry during installation

Check what is installed:

```bash
node --version
git --version
bash --version
curl --version
corepack --version
```

Install Node 22 from [nodejs.org](https://nodejs.org/en/download), or select the
repository's `.nvmrc` with your Node version manager. If Corepack is available:

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm --version
```

If your Node distribution does not include Corepack, install pnpm 10.33.0 using
[the pnpm installation guide](https://pnpm.io/installation). The app depends on
native SQLite bindings: if installation must compile them, your OS also needs
Python and C/C++ build tools. Keep the actual install error when asking for help.

This advanced household installer is a Bash workflow exercised on Linux. For
Windows personal study, use the native Windows package described in the solo
guide; do not paste this Bash workflow into Command Prompt.

## Install

Run this from the directory in which you want the `examify` checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash
cd examify
pnpm start
```

The command downloads and runs the repository's installer. To inspect it first,
clone the repository, read `install.sh`, then run it:

```bash
git clone https://github.com/atk0309/project_Examify.git examify
cd examify
./install.sh
pnpm start
```

Both paths install dependencies, create `.env`, initialise the data folder,
apply database migrations and build the production app. Neither installs a
service: `pnpm start` runs in the foreground. Stop it with Ctrl+C. Use your
host's service manager for automatic startup; see [operations](operations.md).

### Answer the installer questions

1. **Site URL:** the address your family will open. `http://localhost:3000` is
   only for this machine. A LAN address such as `http://192.168.1.20:3000` works
   only if that is your server's address and the port is reachable. For internet
   access, set up [HTTPS](operations.md#deploying-with-https)
2. **Family data folder:** `./data` is simple. Use a dedicated folder outside the
   checkout if you may delete and re-clone the code. It must belong to the app
   user and remain on persistent storage
3. **Sign-in:** password is the default. Invitations and forgotten-password
   codes still need mail delivery or the local outbox
4. **Mail:** the local outbox is useful for trying the app. Choose SMTP or Resend
   for invitations and resets that arrive in people's inboxes
5. **Captcha and AI:** optional. You can skip both for your first run. The
   [configuration guide](configuration.md) explains the AI choices and PDF tools

Save the printed setup code somewhere private until first login. If you close
the terminal, find `SETUP_BOOTSTRAP_SECRET` in the checkout's `.env`; do not paste
that file into a support request.

## First login

Open the site URL, visit `/setup`, and enter the setup code. Create the first
parent/admin account using your email address (also required for password mode).
Then use `/onboarding` to add subjects, upload source PDFs, choose AI, review
questions and Apply. You can skip custom content and use the sample bank; the
parent dashboard then offers **Finish content setup** to return later. Choosing
Finish after Apply closes the wizard. See [configuration](configuration.md#ai-for-question-banks-and-marking)
for the current limits on changes after setup.

From the parent dashboard, create an invitation for a student or another parent.
Share the invitation privately. In password mode the invitee chooses a password,
then enters the code delivered by your configured mail transport. The account
is not active until that step is complete.

### Try exams as a parent

Select **Student View** on the parent dashboard to practise with the student
interface. Your attempts stay on your own account. Select **Back to parent view**
in the banner above any student-preview screen to return to the dashboard.
Students do not see these parent-only controls.

### Read a local outbox code

Outbox mode writes mail to files; it does not send email. On the server, list
recent messages from your configured data folder (default shown):

```bash
ls -t data/outbox/*.json
```

Open the newest relevant JSON file in a local text editor. Check the recipient
and message body and use its code or link. If `MAIL_OUTBOX_DIR` is set, use that
folder instead. The files contain sign-in secrets: do not expose the directory
on the web, share a screenshot, or paste the contents into an issue.

For routine family use, configure [SMTP or Resend](configuration.md#auth-modes)
so each person receives their own message.

## Check it worked

With the server running, open the app and complete a sample exam. From a second
terminal, test the local server:

```bash
curl --fail http://127.0.0.1:3000/api/health
```

Use your configured port if it is not 3000. A healthy response has `"ok":true`.
A health check alone does not verify mail delivery or AI: test an invitation and,
if configured, a written answer too. Create an [off-machine backup](operations.md#backups-and-restore).

## Existing checkout or automated installation

Run `./install.sh` inside the checkout. Existing `.env` is kept unless you
explicitly choose to overwrite it. To update an existing installation, use
`./install.sh --upgrade`, not a plain `git pull`.

```bash
./install.sh --help
EXAMIFY_NONINTERACTIVE=1 SITE_URL=https://exam.example.com ./install.sh
```

Non-interactive mode defaults to password sign-in and an explicitly enabled local
outbox when writing a new `.env`; provide SMTP/Resend settings if you want actual
email. It does not overwrite existing configuration. Conflicts between supplied
settings and kept configuration are refused rather than silently changing the
live data location. `--data-dir /absolute/path` selects a new data folder.

`--skip-build` is for operators preparing a build separately: run `pnpm build`
before `pnpm start`. `--write-env-only` writes configuration only. Advanced
restore and upgrade flags are in `./install.sh --help` and [operations](operations.md).
