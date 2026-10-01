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
background service or silent updater in this preview. The installer supports a
fresh install and repair of the same pinned version, replacing app files only
from the newly verified archive. Stop the launcher before repairing. Automatic
cross-version upgrades are refused until their backup/rollback flow is validated.
Existing household upgrades still use `install.sh --upgrade`.

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

Choose **Try a sample exam** on the practice page. It uses the same five fixed
multiple-choice questions, choices and deterministic answer-key scoring, without
AI generation or marking. No account, email setup,
invitation, AI provider or payment is needed. Select an answer, finish the exam
and review the result. Unfinished exams autosave; reopening through the launcher
keeps your progress and offers your unfinished exam.

**Create your question bank** opens the guided subject → material → AI → generate → review/Apply workflow. Uploading stores the
file locally. Generating questions is a separate, explicit operation: review and
Apply before generated questions become available. The built-in sample stays
available. After finishing, return to **Create your question bank** to add another subject or
material. Existing questions and progress are retained; replacement and Apply
still need explicit review. Household first-run completion keeps its existing
behavior. AI provider settings remain available from the practice page.

The material step accepts PDFs up to 8 MB, or UTF-8 `.txt`/`.md` notes up to
1 MB. Notes must contain readable text; binary files and empty notes are refused.
Files are stored privately using safe names. Uploading a different file with the
same name retains the earlier file and adds a numbered copy. After selecting
**Local endpoint**, use **Configure endpoint URL and model** to enter both values
in AI settings, then return to the question-bank wizard. Your subjects and
uploaded material are retained while you configure the provider.

## AI is optional

The sample multiple-choice practice works without AI. Written-answer AI marking
and question generation require a provider you choose. Cloud providers receive
selected source material or written answers; bring your own API key or supported
account and check that provider's charges. A “local” endpoint is only local if you
actually run it on this computer. Remote endpoints and account-backed command
line tools may still send data to a cloud provider. Examify never silently switches
providers. See [privacy](privacy.md) and [configuration](configuration.md).

### PDF support and external tools

- **Anthropic API** and **Claude Code** send PDFs directly to their provider
- **OpenAI API** sends PDFs directly to a PDF-capable model (the default is
  `gpt-4o`); the combined PDF input for one subject must be below 50 MB
- **Local endpoint** and **Codex** need the external `pdftoppm` tool for PDF-only
  material. It is not bundled with this preview. UTF-8 text notes avoid that
  dependency; a real local model still needs to be installed and running
- Local command execution is host-configured in household installations. The
  solo launcher's private provider settings do not accept executable commands

The offline acceptance provider used by tests is not a bundled model or a
production fallback. The tests select an actual loopback HTTP endpoint through
AI settings, upload text notes, and exercise generation, review, Apply and study.
They do not demonstrate real-model question quality or install `pdftoppm`.

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
9. Create a subject, upload study notes, select/configure a local endpoint,
   generate, review and Apply, then complete an exam from that bank. Repeat for
   a second subject after completion, retaining both banks and earlier progress

No paid AI calls or real credentials are needed for this acceptance checklist.

## Back up a solo installation

Stop the launcher cleanly, then copy both the stable `data` and `config` folders
to a private backup location. Keep them together; `config` contains authentication
secrets and any saved provider keys. Do not post or share the backup. Copying a
live SQLite database without its journal is not a reliable backup.

The small `.examify-operations` directory at the install root coordinates
launch/repair operations; it is outside learner data and configuration. It is not
part of your study backup and must not be removed while an operation is running.

The existing `examify:data` backup command was designed for household checkouts;
it does not yet include the solo launcher's separate `config/secrets.json` and
provider-settings directory. A data-only backup is not a full solo-installation
backup. Platform installers must retain these stable folders when replacing app
versions; do not uninstall/delete them if you want to keep your progress.
