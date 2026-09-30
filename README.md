# Examify

Self-hosted exam practice for families. Create a household, invite your family,
and practise with multiple-choice and written questions. Progress, accounts and
study files live on your server. Optional AI generates questions from your study
material and marks written answers.

## Install and try it

You need **Node 22.22.2–22.x**, **Git**, **Bash** and **curl**. The installer uses
**pnpm 10.33.0** through Corepack (or an existing pnpm installation). Run it as
the OS user that will run Examify, not with sudo. See the
[installation guide](docs/installation.md) if you need to set these up.

```bash
curl -fsSL https://raw.githubusercontent.com/atk0309/project_Examify/main/install.sh | bash
cd examify
pnpm start
```

The installer asks for your site address, data folder, sign-in method, mail
transport and optional AI. It creates `.env`, installs dependencies, migrates
the database and builds the app. It does not start a background service.
If it reuses an existing checkout or you set `EXAMIFY_DIR`, use the checkout
path printed at the end instead of `cd examify`.

Open the site address you chose, enter the printed setup code at `/setup`, and
create the first parent account. In the setup wizard, add your study material
or skip to the sample bank. Invite students from the parent dashboard.

- **Trying it on this machine?** Accept `http://localhost:3000`
- **Using family phones or laptops?** Enter an address those devices can reach.
  `localhost` on a phone means the phone, not your server
- **No mail provider?** The default local outbox saves invitation and reset codes
  on the server. Read them there; they will not arrive by email.
  [Outbox instructions](docs/installation.md#read-a-local-outbox-code)
- **No AI yet?** Skip content setup to try the sample bank. Return through
  **Finish content setup** on the parent dashboard before completing the wizard

Use HTTPS before exposing the app beyond your home network. Plain HTTP sends
passwords and session cookies unencrypted. Keep `.env`, the outbox and backups
private. [Deployment and HTTPS](docs/operations.md#deploying-with-https)

## Everyday use

Pick a subject and difficulty, answer a short exam, then review your results.
Unfinished exams autosave and can be resumed. Parents see their household's
student progress and can take exams themselves. The app includes a small sample
bank; add your own subjects in the initial setup wizard. After finishing setup,
use the [CLI workflow](docs/content-authoring.md#cli-workflow) for content updates.

AI generation and marking send study material or answers to the selected
provider. Local hosting alone does not keep AI requests local.
[What leaves your server](docs/privacy.md)

## Guides

- [Install and first login](docs/installation.md)
- [Configure sign-in, mail and AI](docs/configuration.md)
- [Deploy, update, back up and restore](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Add or generate questions](docs/content-authoring.md)
- [Ingest CLI reference](tools/examify-ingest/README.md)
- [Develop and test](CONTRIBUTING.md)

## Built with

Next.js 16, React 19, TypeScript, Tailwind CSS and SQLite (Drizzle + better-sqlite3).
Exact versions live in [package.json](package.json). The app runs on one Node
server with a persistent family data folder; see [deployment](docs/operations.md#deploy).

## Support and contributing

Questions: [SUPPORT.md](SUPPORT.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
Report vulnerabilities privately using [SECURITY.md](SECURITY.md).
[Code of conduct](CODE_OF_CONDUCT.md) · [MIT license](LICENSE)
