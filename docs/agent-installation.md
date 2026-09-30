# Install Examify with an AI agent

Give your preferred coding agent this file and access to the machine where you want
Examify to run. It can install dependencies, configure an approved local setup, build
the existing app and check startup. You handle private credentials and approve any
hosting or network changes. This is an installation runbook, not a request to generate
new application code.

Copy this request into your agent:

> Read AGENTS.md and docs/agent-installation.md in atk0309/project_Examify. Help me
> install Examify on this machine. Inspect the environment first, ask for missing
> setup choices, preserve existing data and configuration, and verify the result.
> Tell me what you actually tested and what I still need to do. Do not expose it
> publicly, purchase anything, or upload my study files without my approval.

Prefer doing it yourself? Use the [human setup guide](installation.md).

## 1. Inspect before changing anything

- Read [AGENTS.md](../AGENTS.md), [installation](installation.md),
  [configuration](configuration.md), and `./install.sh --help` in a checkout.
- Identify OS, shell, current user, destination directory, free storage, runtime
  versions and whether port 3000 is available. Do not run the installer as root.
- Requirements: Node **22.22.2–22.x**, Git, Bash, curl and pnpm **10.33.0** (Corepack
  is supported). The repository's `package.json` and `.nvmrc` are authoritative.
  Check versions without dumping the environment or credentials.
- Linux is CI-tested. For Windows, use an available WSL/Linux environment; do not
  translate the installer into PowerShell. Report unverified OS/platform behavior.
- Check whether the destination already exists, whether Git has local changes, and
  whether any `.env`, `.env.local`, `.env.production` or `.env.production.local`
  exists. Inspect configuration privately; never paste entire files into a transcript.
  Check for existing data and a running service before treating this as a fresh install.
- If dependencies are missing, propose the official installation method and obtain
  any required approval. Do not run arbitrary download-and-execute scripts, elevate
  privileges, disable security controls or install a system service as a workaround.

If an installation already exists, stop the fresh-install path. Summarize its state
and use [the upgrade procedure](operations.md#upgrading) only when an upgrade is
requested. A clone with no configuration may be a development checkout: ask rather
than repurposing it silently. Never delete `.env` or a database to unblock setup.

## 2. Agree on the setup

Ask only for choices not already supplied:

1. Checkout and dedicated persistent family-data locations
2. This-machine-only, home-network, or separately approved public deployment, and
   the actual site URL/port; never invent a domain or LAN address
3. Sign-in method (password is the installer default) and mail delivery (local
   outbox, SMTP or Resend). Explain that outbox messages stay on the server, including
   invitation/reset codes; they are not delivered to an inbox
4. Optional AI: decide later, an existing signed-in Claude Code/Codex installation,
   a confirmed local endpoint/model, or an API provider. Explain which study material
   and answers will leave the machine and any usage costs before making live requests
5. Whether captcha is wanted and already configured; it is optional

For a simple local trial, propose `http://localhost:3000`, password sign-in, a local
outbox, no AI and captcha off. Use these only after the user agrees. Detecting an
installed agent or an environment variable is not permission to use its account.
Do not create cloud accounts, buy subscriptions or download large models by default.

Let the user enter passwords, API keys and sign-in credentials through their own
terminal, the app or an approved secure credential mechanism. Never ask them to paste
secrets into chat, put secrets in shell arguments/history, print `.env`, or commit it.
The installer generates the session and bootstrap secrets: do not use `.env.example`
placeholders in a production install. Keep setup-code output private too.

## 3. Install the approved configuration

Clone the official repository into the agreed empty destination. The relative name
below is an example; substitute the approved path and use the requested release/branch
if the user specified one. Do not overwrite an existing checkout.

```bash
git clone https://github.com/atk0309/project_Examify.git examify
cd examify
./install.sh --help
```

Read the checked-out `install.sh` before executing it. Prefer this inspectable path to
piping a remote script into Bash. Record the checked-out commit for the handoff.

Use the interactive installer when the user is entering choices/secrets:

```bash
./install.sh
```

For an approved local trial, a fresh checkout with no conflicting host configuration
can use this non-interactive example. It assumes the approved data path is `./data`;
use `--data-dir` with the approved dedicated path if different.

```bash
EXAMIFY_NONINTERACTIVE=1 EXAMIFY_AI_DETECT=0 \
  SITE_URL=http://localhost:3000 AUTH_MODE=password \
  MAIL_TRANSPORT=outbox ALLOW_LOCAL_OUTBOX=1 TURNSTILE_ENABLED=0 \
  ./install.sh --data-dir ./data
```

Before using that example, check privately for inherited AI/mail/data settings. It
does not clear existing environment variables or saved configuration; isolate or
adjust only the relevant settings with the user's agreement. `EXAMIFY_AI_DETECT=0`
skips discovery, not an already configured provider. Never claim it disables AI.

The installer preserves existing configuration in non-interactive mode, installs
locked dependencies, initializes/migrates the data folder and runs the production
build. Capture each exit status and a sanitized error summary. It does not start a
service, configure DNS/HTTPS, open a firewall, or create the household account.
Do not use `--allow-owner-mismatch`, `--allow-running`, `--skip-build`, insecure mail,
production grading stubs or legacy-content bypasses to hide a failure.

If it fails, identify the failing stage and retry only after a safe, relevant fix.
Do not reset the checkout, clear the database, overwrite config or upgrade packages
as a generic repair. Report an exact blocker if permission or a prerequisite is missing.

## 4. Verify the installed app

Run in the checkout as the app's OS user:

```bash
pnpm examify:data paths --check
pnpm examify:data verify
```

Keep any path-bearing diagnostic output private. Both checks must pass against the
intended data folder. A successful `pnpm build` alone is not a running installation.
If a separately approved workflow skipped the build, run `pnpm build` now.

For a local-only trial, bind explicitly to loopback:

```bash
pnpm start --hostname 127.0.0.1
```

Keep the process in a visible terminal or the agent's managed session, and explain
that it stops when that session closes. Do not claim persistence. If the chosen port
is different, pass `--port` with that port and keep it consistent with `SITE_URL`.
For an approved LAN/public setup, follow [operations](operations.md#deploying-with-https)
and verify the binding and HTTPS plan separately; do not open network access by default.

In another terminal:

```bash
curl --fail http://127.0.0.1:3000/api/health
```

Verify HTTP success and a JSON body with `"ok":true`, not just that a port responds.
Use the actual chosen port. Then:

- Open the app in a browser and verify the first-run setup page, or the expected
  sign-in screen for an existing household
- Have the user privately enter the setup code and create the first admin account;
  do not put their email/password or setup code in public logs or screenshots
- Try the sample bank before uploading personal material. Use sample data for a
  smoke exam, reload/resume if practical, and check that submitted results persist
- Verify invitation delivery only to an approved recipient. With outbox mode, have
  the user read the matching message on the server; do not paste its contents into chat
- AI readiness is not a live provider test. Run generation or marking only with
  approved data/provider/costs; review generated questions before Apply

If the agent lacks browser access or the user has not completed account setup, label
those steps **not verified** and give the user the remaining checklist. Do not invent
a successful login, working mail or working AI from a healthy `/api/health` response.

## 5. Hand over clearly

Report, without secrets:

- Checkout location, commit, data location and actual local/site URL
- Which dependency installation, migration, build, data checks, health check and
  browser flows passed; what failed or remains untested
- How the app was started, whether it is still running, and how to stop/restart it
- How to find the setup code privately, if first login is still pending
- Mail transport and AI choice, including whether either was tested end to end
- Remaining deployment/HTTPS, off-machine backup or account steps that need the user

The admin can change AI later in **AI settings** (`/settings/ai`), including after
Finish. That does not reopen the content wizard; subsequent question-bank changes use
[the CLI workflow](content-authoring.md#cli-workflow). See [privacy](privacy.md) before
using real student answers or study material, and [backup/restore](operations.md#backups-and-restore)
before routine family use. Copying a backup off the machine needs an approved destination;
archives may contain credentials and private family data.
