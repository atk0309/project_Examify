# Personal study on Windows and Linux

## Preview status

This branch introduces the solo launcher and platform packaging. No release is
published by the packaging workflow. Do not treat a successful unit test, a mock
installer run or a Linux build as proof that Windows installation works. Release
readiness requires the real packaged acceptance job on each supported OS.

Initial targets are Windows x64 and Linux x64. macOS and ARM packages are not
part of this change. Download only an explicitly versioned Examify package and
its matching installer from an authorized release or preview artifact. The
installer must verify its pinned archive digest before unpacking or execution.
There is no `latest` or moving-main executable download in this flow.

## Use a verified preview package

Once the platform CI job produces a passing artifact, extract that artifact into
an ordinary folder. Keep the version-pinned installer and archive together. Do
not run the unsubstituted installer templates directly from a source checkout.

- **Windows:** open Command Prompt in that folder and run `install.cmd`. Run as
  your ordinary account, not Administrator. The private default install location
  is `%LOCALAPPDATA%\Examify`; use the resulting Examify shortcut to reopen it
- **Linux:** run `bash install-solo.sh --archive ./examify-VERSION-linux-x64.tar.gz`
  with the actual matching archive name. The default is
  `${XDG_DATA_HOME:-$HOME/.local/share}/examify`. The installer creates a desktop
  application entry and a relaunch script; it does not require sudo

Keep the launcher terminal open while practicing. Ctrl+C stops the local service;
closing the browser alone does not. Reopening the shortcut uses the existing
running instance and opens a fresh browser session safely. There is no automatic
background service or silent updater in this preview.

## What the launcher does

- Uses the bundled, pinned Node runtime and prebuilt dependencies, including the
  native SQLite binding for that OS; no manual Git, Node, pnpm or compiler setup
- Stores your data and settings separately from replaceable application versions
- Starts a loopback-only local service and opens the browser with a one-use local
  launch capability, exchanged for a private session
- Provides a relaunch shortcut. Keep the launcher running during practice; stop it
  normally before backing up, copying or removing an installation

The local URL is only for this computer. Do not share the launch URL, proxy it to
the internet, bind it to a LAN address or use it as a shared school/family server.
This mode assumes a trusted personal computer. Other people using the same OS
account can access its files and running app. Browser cookies are scoped to a
host, not a TCP port: another local service on 127.0.0.1 can receive local cookies
if you browse to it. Solo is not a security boundary against hostile software or
other untrusted local services/users on the machine. Use the authenticated
household deployment behind HTTPS when stronger shared-machine isolation is
needed; separate OS accounts alone do not fix the browser host/port limitation.

## First practice

Choose **Try a sample exam** on the practice page. No account, email setup,
invitation, AI provider or payment is needed. Select an answer, finish the exam
and review the result. Unfinished exams autosave; reopening through the launcher
keeps your progress and offers your unfinished exam.

**Add your own material** opens the optional content wizard. Uploading stores the
file locally. Generating questions is a separate, explicit operation: review and
Apply before generated questions become available. The built-in sample stays
available. After finishing the wizard, ongoing content changes currently use the
[existing content workflow](content-authoring.md); AI provider settings remain
available from the practice page.

## AI is optional

The sample multiple-choice practice works without AI. Written-answer AI marking
and question generation require a provider you choose. Cloud providers receive
selected source material or written answers; bring your own API key or supported
account and check that provider's charges. A “local” endpoint is only local if you
actually run it on this computer. Remote endpoints and account-backed command
line tools may still send data to a cloud provider. Examify never silently switches
providers. See [privacy](privacy.md) and [configuration](configuration.md).

The solo UI does not load the household analytics or remote font resources.
Installing/downloading the application itself requires internet access.

## Existing families and shared access

Keep using [household installation and upgrades](installation.md). Solo mode
refuses to adopt an existing household database and does not migrate household
accounts into an unauthenticated shared app. Keep the data folders separate.
Household mode continues to require sign-in and mailbox proof for invitations.

## Before a release is ready

On clean Windows and Linux machines, verify the actual distributed package:

1. Install as an ordinary user without Git, Node or pnpm on PATH; paths containing
   spaces must work. Verify archive digest rejection before executable startup
2. Launch, open the browser, redeem the capability, and start a sample exam
3. Submit and persist a result, close/relaunch, and resume unfinished work
4. Reject forged Host, cross-origin requests, reused tokens and access to the
   internal Next server without the gateway secret
5. Confirm no household setup/mail/account screens block first practice
6. Retain private data and configuration across relaunch and version replacement
7. Refuse an existing household database without changing its contents
8. Run the household and existing migration suites to guard upgrades

No paid AI calls or real credentials are needed for this acceptance checklist.

## Back up a solo installation

Stop the launcher cleanly, then copy both the stable `data` and `config` folders
to a private backup location. Keep them together; `config` contains authentication
secrets and any saved provider keys. Do not post or share the backup. Copying a
live SQLite database without its journal is not a reliable backup.

The existing `examify:data` backup command was designed for household checkouts;
it does not yet include the solo launcher's separate `config/secrets.json` and
provider-settings directory. A data-only backup is not a full solo-installation
backup. Platform installers must retain these stable folders when replacing app
versions; do not uninstall/delete them if you want to keep your progress.
