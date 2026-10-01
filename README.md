# Examify

Personal exam practice on your own computer. Start with a short sample exam,
keep your progress locally, then optionally add study material and AI. Windows
and Linux are the personal-study targets. Household sharing remains available
as a separate, more involved setup.

## Start with personal study

The new **solo launcher** runs Examify on this computer only. It opens your browser
and creates your private study profile without email, invitations or routine login.
The sample questions need no AI account or key. Choose **Try a sample exam** to start.

This is a **preview implementation**, not a published desktop release. Platform
packages must pass the clean-install checks before release. See the
[personal-study installation guide](docs/solo-installation.md) for the package
layout, verification and current acceptance requirements. Windows x64 and Linux
x64 packages bundle the tested Node runtime and application dependencies; they
are designed to require no manual Git, Node, pnpm, Docker or administrator setup.
macOS is outside this preview's scope.

## Optional household setup

For multiple people or access from another device, use the existing
[household installation guide](docs/installation.md) or
[agent installation manual](docs/agent-installation.md). That path uses accounts,
mailbox-verified invitations and normal sign-in. It needs Node 22.22.2–22.x,
pnpm 10.33.0, Git, Bash and curl.

Existing household installations keep their data and upgrade workflow. A solo
launcher never converts or adopts an existing household database. Do not expose
the solo listener through a reverse proxy or share its local session.

## Everyday use

Pick a subject and difficulty, answer a short exam, then review your results.
Unfinished exams autosave and can be resumed. In household mode, parents see their household's
student progress and can take exams themselves. The app includes a small sample
bank; add your own subjects in the initial setup wizard. After finishing setup,
use **AI settings** on the admin dashboard to manage your provider, and the [CLI workflow](docs/content-authoring.md#cli-workflow) for content updates.

AI generation and marking send study material or answers to the selected
provider. Local hosting alone does not keep AI requests local.
[What leaves your server](docs/privacy.md)

## Guides

- [Personal study on Windows or Linux](docs/solo-installation.md)
- [Household install and first login](docs/installation.md)
- [Install with your preferred AI agent](docs/agent-installation.md)
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

### Student View for parents

From the parent dashboard, select **Student View** to try exams with the student
interface. Your attempts stay on your own account. Select **Back to parent view**
in the banner above any student-preview screen to return to the parent dashboard.
Students do not see these parent-only controls.
