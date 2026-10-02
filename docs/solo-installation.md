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
background service or silent updater in this preview. The installer supports fresh installs and same-version repairs. Upgrade-capable
packages also support an explicit upgrade to a higher stable numeric version
(for example, `0.1.0` to `0.2.0`) using that version’s verified installer. Stop
the launcher first. The original preview format cannot be upgraded in place;
keep that installation and use a separate empty folder. A same-version preview
repair does not convert it into an upgrade-capable installation.
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

## Upgrade safely

Run the new version-pinned installer against the same installation folder, with
Examify stopped. There is no automatic download or silent downgrade. CI preview
labels and prereleases are not ordered as upgrade versions. The first public
upgrade-capable package must have a version never used by a legacy preview.

An upgrade or upgrade-capable same-version repair:

1. Acquires OS-released installation, launcher and database-worker locks. PID
   numbers alone are never evidence that an installation is stopped
2. Preserves the entire previous data/config generation, including SQLite WAL,
   material, question banks, results, provider settings and authentication secrets
3. Makes a private, hash-checked candidate copy and requires free space for twice
   the copied bytes plus a 128 MiB migration reserve, after package extraction
4. Migrates and starts the actual new application against the candidate, without
   opening a browser. It stops all verification workers before activation
5. Replaces one installation pointer, selecting the complete matching app and
   study-state generation together. The ordinary shortcut resolves that pointer

Migration, startup or preactivation interruption leaves the previous pair
selected. Orphan candidate folders may remain; they are never automatically
adopted or deleted. Re-running the verified installer prepares a fresh candidate.
After activation, no automatic rollback occurs: newer work might already exist.
Directly running an inactive supported version refuses to open study data.

Use a local filesystem owned by your ordinary OS account. Network shares,
cloud-synced installation folders, links/junctions, hard-linked study files and
shared/foreign-owned state are unsupported. Keep adequate disk space; the reserve
is a safety check, not a bound on every future migration’s requirements. If a
fresh install is interrupted before it creates its installation marker, use a
new empty folder. A damaged immutable bootstrap fails closed and needs recovery
into a separate folder; repair does not overwrite its running Node executable.

The automated checks cover process interruption. They do not simulate physical
power failure or failing storage. In particular, Windows ordinary-user Node APIs
do not provide a proven durable directory-commit guarantee; keep an independent
backup before upgrading. This feature does not claim guaranteed recovery from
sudden power loss on Windows.

## Back up or recover a solo installation

Stop Examify and copy the **whole installation folder** to a private location.
This retains the installation pointer, matching application/runtime, all state
generations, configuration and recovery metadata. After an upgrade, `data` and
`config` at the root can be an older snapshot: copying only those folders can
miss current work. Keep backup copies private; they include authentication
secrets and saved provider keys. Never publish or share them.

To recover, retain the damaged installation unchanged, restore the complete
known-good backup into a separate private folder, and launch its `Examify` or
`Examify.cmd` entrypoint. Do not overlay old app files onto a newer database or
manually change just the version field. Recovery to a pre-upgrade backup loses
changes made after that snapshot; preserve the newer installation for possible
recovery of that work. Never run two copies against the same data directory.

The retained previous generation and its matching release provide a recovery
source, not a second automatically active installation. The previous pointer is
recorded in `installation.json`, and candidate `backup-source.json` records the
source snapshot’s hashes. Advanced selective recovery requires keeping that
matched pair together in a separate folder; there is no one-click rollback or
automatic old-generation cleanup in this release.

The `.examify-operations` databases are coordination files, outside study state.
Do not remove them while an operation is active. Stale process markers after a
crash do not require manual deletion. The household `examify:data` backup command
does not capture this complete solo layout; use the full-folder backup above.
