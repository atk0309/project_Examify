# Privacy and AI data use

Stored on your server: household accounts, exam attempts and progress,
in-progress drafts, uploaded PDFs and notes, generated question banks and answer keys
(all in the [family data folder](operations.md#where-your-familys-data-lives)), and the `.env` keys.
Your browser holds an encrypted sign-in cookie. A password reset invalidates older
sign-in cookies, so your other browsers must sign in again.
Removing a household member also invalidates their existing sign-in cookies,
including after they join again through a new invitation. Their saved study data
stays on the server.

Sent to a third party only when you turn the feature on:

- **Free-text marking.** Each free-text answer goes, with its question and rubric, to the
  AI the household picked: the Anthropic or OpenAI API with your key, Claude Code or Codex
  (to Anthropic or OpenAI under your plan), or your local endpoint. Examify does not
  add account names, emails or user IDs to the request; the answer or study material
  itself may contain personal information. Multiple-choice answers are scored on
  your server. When that AI is not set up, nothing is sent: exams leave written
  questions out (a bank with only written questions keeps them as pending).
- **Cloud generate (Anthropic / OpenAI).** The `/onboarding` cloud modes and
  `examify-ingest generate --provider anthropic|openai` send that subject's source files
  (PDFs or their page images, notes, images) to the provider. Local modes send them to the
  endpoint or command you configure; `--provider test` sends nothing.
- **Claude Code / Codex generate.** The Claude Code and Codex modes
  (`--provider claude-cli|codex-cli`) run `claude -p` / `codex exec` on your server with
  their own sign-in, so the same files go to Anthropic or OpenAI under your plan. They
  run in an empty private folder with no tools (no file reads, commands or web search;
  Codex in its read-only sandbox, with a private copy of its sign-in only, so your
  `AGENTS.md` and skills stay out), save no session, and get only a short allowlist of
  environment variables: none of Examify's secrets or API keys. A failed wizard
  generate shows a specific reason (rejected key, rate limit, timeout, …) and logs only
  the reason code, subject id and provider HTTP status — never the provider's message,
  model text or your files.
- **Mail.** Invite, sign-in and reset codes go through Resend or your SMTP server. The
  local outbox keeps them on disk.
- **Installer checks.** A new interactive install asks Claude Code and Codex (when
  installed) whether they are signed in, and Ollama for its model list. No family data is
  involved; `EXAMIFY_AI_DETECT=0` skips the checks. When `OLLAMA_HOST` (or
  `EXAMIFY_LLM_BASE_URL`) points at another machine, the Ollama option names it: study
  files and written answers then go there.
- **Sign-in checks.** The app asks Claude Code / Codex whether they are signed in, as
  above: the household's own CLI when its pages render, and every installed one whenever
  the setup wizard loads or runs an action, whatever the AI mode. No family data is
  involved, and the answer is never shown or logged beyond "signed in" / "not signed in".
- **Fonts.** Pages load the Newsreader and Hanken Grotesk stylesheet from Google Fonts.
- **Optional:** Cloudflare Turnstile (`TURNSTILE_ENABLED=1`) and Plausible analytics
  (`PLAUSIBLE_DOMAIN`).

## Personal-study launcher

In solo mode your practice profile, attempts and uploaded files live in the
private local installation. The browser connects through a loopback-only gateway;
there is no routine email/password login. This does not isolate you from other
people or software with access to the same operating-system account. Cookies
are host-scoped rather than port-scoped, so another local service on 127.0.0.1
can receive local cookies if you visit it. Solo assumes trusted local software
and is not a hostile-multi-user-machine isolation boundary. Solo mode
does not load the household analytics script or remote font stylesheets.

Optional cloud AI still sends selected sources or written answers to the provider
you choose. Locally hosting Examify does not make a remote model endpoint or an
account-backed CLI local. Generation/marking needs your explicit provider setup;
the shipped multiple-choice practice needs none. Installation downloads contact
the package host. Back up both local data and configuration privately.
