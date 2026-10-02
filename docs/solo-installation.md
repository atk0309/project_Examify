# Personal study on Windows and Linux

Examify runs on your computer and opens in your browser. Start with five fixed
sample questions: no account, email, AI provider or payment is needed.

## Get the preview

**There is no published desktop release yet.** Windows x64 and Linux x64 packages
are available only as expiring preview artifacts from successful
[Solo desktop preview runs](https://github.com/atk0309/project_Examify/actions/workflows/desktop-preview.yml).
Open a successful run for the commit you intend to test and download its
`examify-solo-win32-x64-COMMIT` or `examify-solo-linux-x64-COMMIT` artifact. GitHub
may require you to sign in. If the artifact has expired, ask the maintainer for a
verified replacement; do not use a guessed release URL.

Extract the downloaded artifact into an ordinary folder. Keep its installer,
archive and checksum files together. Do not unpack the inner application archive
or run the installer templates from the source-code ZIP. The installer checks the
matching archive's pinned checksum before running it.

These packages bundle Node and application dependencies. You do not need Git,
pnpm, Docker or a compiler. Use your ordinary account, without Administrator or
sudo. Choose local storage, not a network drive or cloud-synced folder.

Windows needs PowerShell 5.1 or later. Linux needs Bash, tar, sha256sum and a
desktop with `xdg-open` and a default browser. No minimum consumer Windows/Linux
or browser version has been verified yet: Windows Server 2022 and Ubuntu 22.04 CI
runs are automated checks, not a consumer support claim. macOS and ARM are not
supported by this preview.

Installers are unsigned. A checksum checks bytes, not who published them. Stop
if your browser or OS blocks the download or shows a security warning; do not
disable protection. See [download help](troubleshooting.md#download-is-blocked-or-the-checksum-does-not-match).

## Install and open

### Windows

1. Open the extracted folder. It should contain `install.cmd`, `install.ps1` and
   `examify-VERSION-win32-x64.zip`, all from the same artifact
2. Open an ordinary Command Prompt in that folder and run:

   ```cmd
   install.cmd
   ```

3. Keep the terminal open. Examify starts and opens your default browser

The default location is `%LOCALAPPDATA%\Examify`. The installer adds **Examify**
to the Start menu. It uses the archive beside the installer; no release download
is needed when all three files are present.

### Linux

Open a terminal in the extracted folder. Run this with the **actual archive
filename** from that folder in place of `examify-VERSION-linux-x64.tar.gz`:

```bash
bash install-solo.sh --archive ./examify-VERSION-linux-x64.tar.gz
```

Keep the terminal open. Examify starts and opens your default browser. The
installer adds **Examify** to your applications menu. The default location is
`${XDG_DATA_HOME:-$HOME/.local/share}/examify`. Supplying `--archive` avoids a
release download, so this also works offline after you have downloaded the files.

## Try your first exam

1. Select **Try a sample exam** on the practice page
2. Answer the five questions using **Next question**, select **Finish exam**,
   then review your result
3. Select **Back to subjects**, start another sample, answer a question and
   return with the home icon (**Back to subjects**). Your unfinished exam is saved so you can resume it

The sample always uses the same questions and deterministic scoring. It does
not generate questions or send answers to AI.

## Stop and come back

Press **Ctrl+C in the launcher terminal** to stop Examify. Closing the browser
alone leaves it running. Open **Examify** from Start or your applications menu to
return; you can resume an unfinished exam and see saved results. Reopening while
it is running opens a fresh browser session in that same instance.

If the shortcut is missing, open the installation folder and run `Examify.cmd`
on Windows or `./Examify` in a Linux terminal. Use that root entrypoint, not a
file inside `releases/`. Bookmarked launch links are single-use; reopen through
Examify instead. [Browser or startup problems](troubleshooting.md#personal-study-windowslinux-package).

## Make your own question bank

Choose **Create your question bank** from the practice page:

1. Add a subject with a unique ID and a name you recognise
2. Upload a PDF (up to 8 MiB) or UTF-8 `.txt`/`.md` notes (up to 1 MiB).
   Uploading only stores the file locally; it does not start generation
3. Choose and configure an AI provider. For **Local endpoint**, select
   **Configure endpoint URL and model**, save both in AI settings, then return
4. Select **Generate questions**. When it finishes, choose **Validate** to open
   the next screen, then **Validate** again to check the draft format. Select
   **Next** for Review, then **Review plan** and inspect additions/replacements/deletions.
   Select **Looks good**, then **Confirm apply** to make the bank available
5. Select **Next**, then **Back to practice** and choose your subject

Return to **Create your question bank** to add more subjects or material. Your
existing banks and progress remain. Replacing questions needs explicit review;
the built-in sample stays available unless you explicitly replace it. **Optional AI settings** lets you change providers.
Review shows planned file changes, not a question editor; Validate does not check
answer accuracy. AI output can be wrong. [Question-bank help](content-authoring.md)
explains private draft inspection before using generated questions for study.

### Choose AI only when you need it

Generation and written-answer marking use the provider you choose. Cloud APIs
and account-backed tools may send material or answers to a cloud service and may
cost money. A local endpoint needs a model already running; a remote endpoint is
not private to your computer. Examify never silently switches providers.
[What leaves your computer](privacy.md).

For a first bank, text notes avoid extra PDF tooling. Anthropic/Claude Code and
OpenAI can send PDFs directly to their provider; OpenAI needs a PDF-capable model
and less than 50 MB combined PDF input per subject. Codex and local vision
endpoints need the separate `pdftoppm` tool for PDF-only material. It is not
bundled. Local command execution is host-configured in household installations;
the solo settings do not accept executable commands. Tests use an offline
provider fixture, not a bundled model or evidence of real-model quality.

## Keep your work private and safe

[Back up, upgrade, recover or remove Examify](solo-maintenance.md). Back up the
whole installation folder while Examify is stopped; copying only root `data/`
can miss current work after an upgrade. Backups contain secrets and provider keys.

The local service is for this computer only. Do not share its launch URL, expose
it through a proxy or use it as a school/family server. It assumes a trusted
personal computer: people using your OS account can access its files, and other
local services on `127.0.0.1` can receive host-scoped cookies. Separate OS accounts
do not fix that browser host/port limitation. For shared access, use the
[authenticated household setup](installation.md) behind HTTPS, with separate
data. Solo never adopts an existing household database.

The [release checklist](release-candidate.md) tracks checks still needed before
public downloads, including real shortcut/browser opening and security warnings.
