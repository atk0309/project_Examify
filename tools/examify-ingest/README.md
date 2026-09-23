# examify-ingest

BankIR tooling for Examify. This package can **generate** intermediate
question-bank JSON from local source files, **validate** it, and **emit** the
split public / server-only files the app merges onto the hand-authored sample
bank.

`generate` writes `content/subjects/<id>/bank.ir.json` (under the layer root —
see [Layers](#layers-checkout-committed-and-family-data-folder)) only. It never
emits or applies. Human-in-the-loop is still required.

**Hand-authored biology** (`content/subjects/biology/bank.ir.json`) has no
source file. Skip generate; validate / emit only. Generate needs a source
file first.

Fresh-clone generate fixture (committed `content/subjects/demo/notes.txt`):

```bash
pnpm examify-ingest generate --provider test --seed 0 content/subjects/demo
pnpm examify-ingest validate content/subjects
pnpm examify-ingest emit content/subjects --dry-run
pnpm examify-ingest emit content/subjects --apply
```

Biology (skip generate):

```bash
pnpm examify-ingest validate content/subjects
pnpm examify-ingest emit content/subjects --dry-run
pnpm examify-ingest emit content/subjects --apply
```

The first-run `/onboarding` wizard can run generate on the AI step (same
`generateSubject` entry, BankIR only), then this same directory emit
(validate, dry-run, then apply) on the family layer only — it never plans the
registrars and refuses any write outside `<data folder>/content/generated/`
("refusing to write outside the family data folder"), judged on realpaths so a
symlinked `content/generated`, `questions/` or `keys/` into the checkout is
refused, and re-checked right before each write. Its Review names each
family subject that replaces a committed one ("Replaces built-in subject: …").
It does not auto-emit or auto-apply after generate. `--replace-sample` is off
unless the admin enables it: the Review › Advanced toggle, or the same
household setting on the AI step, shown next to Generate when a subject reuses
a sample subject id. Generate uses that setting too; without it a sample-id
subject is refused (`sample_collision`) before the provider call.

## Layers: checkout (committed) and family data folder

Every `validate` / `emit` / `generate` run works on exactly one layer, picked
from the paths you name, and says which on stderr first:

- **committed** (`layer: committed (checkout)`): paths in the checkout, such as
  `content/subjects`. This is how shipped subjects (biology, the demo fixture)
  are built and what CI runs. `emit --apply` writes tracked files:
  `content/generated/` and the `src/lib/exam/generated-*.ts` registrars, and
  prints a note saying so.
- **family** (`layer: family (data)`): paths in the family data folder
  (`EXAMIFY_DATA_DIR`, default `./data`; the same resolver as the app, so an
  `EXAMIFY_DATA_DIR` in `.env` counts). This is the tree `/onboarding` writes.
  `emit` writes `<data folder>/content/generated/` only (keys `0600` in a
  `0700` folder) and never the registrars; generate reads sources and writes
  IR and `.examify-ingest/` there. The app reads this layer on every request,
  so an apply is live without a rebuild. A family subject with a committed
  subject's id replaces it in the app, and validate / emit say so:
  `note: family subject biology replaces the committed subject biology`.

The data folder is checked first (the default `./data` sits inside the
checkout). A path in neither is refused, and so is a run that names both. A
path under the checkout's `./data` while `EXAMIFY_DATA_DIR` points elsewhere
(a leftover folder) is refused rather than treated as committed — an emit
would put family answer keys into tracked files. A family run warns when the
data folder belongs to another user (the app could not read what it writes;
run it as the app's user). API keys come from the checkout `.env` /
`.env.local` in both layers.

```bash
pnpm examify-ingest generate --provider test --seed 0 data/content/subjects/<id>
pnpm examify-ingest validate data/content/subjects
pnpm examify-ingest emit data/content/subjects --dry-run
pnpm examify-ingest emit data/content/subjects --apply
```

With an absolute `EXAMIFY_DATA_DIR`, name that path instead
(`/srv/examify-data/content/subjects`). The wizard's power-user hints show
the right one.

Committed-layer runs in a development checkout leave files there
(`bank.ir.json`, `.examify-ingest/`, changed `content/generated/` and
registrars; `.examify-ingest/` stays even after a commit). `pnpm db:migrate`
and `install.sh` read those as family content an older version left in the
checkout and refuse; set `EXAMIFY_IGNORE_LEGACY_CONTENT=1` for `db:migrate`
there. Never on a real install (use `./install.sh --upgrade`).

## Install

From the repo root, after `pnpm install` (this package is a workspace member):

```bash
pnpm exec examify-ingest --help
# or
pnpm examify-ingest --help
```

The root `examify-ingest` script and `pnpm exec` both run the workspace bin.
You can also run it from the package directory:

```bash
pnpm --dir tools/examify-ingest exec examify-ingest validate ../../content/subjects
pnpm --filter examify-ingest exec examify-ingest validate ../../content/subjects
```

Paths are resolved from your current working directory. Run the commands below
from the **repo root**.

## Commands

```bash
pnpm examify-ingest generate --provider test --seed 0 content/subjects/demo
pnpm examify-ingest generate --provider test --seed 0 content/subjects/demo --dry-run-ir
pnpm examify-ingest generate --provider test --seed 0 content/subjects/demo --force
pnpm examify-ingest validate content/subjects
pnpm examify-ingest emit content/subjects --dry-run
pnpm examify-ingest emit content/subjects --apply
pnpm examify-ingest emit content/subjects --apply --replace-sample
```

`generate` accepts `content/subjects` or `content/subjects/<id>` (not an IR
file). Sources include notes/text (`.txt` / `.md`, including `notes.txt`) and
images in the subject folder, plus PDFs and those same extensions under
`content/source-pdfs/<id>/` and standalone `content/source-pdfs/<id>.{pdf,png,jpg,jpeg,webp,txt,md}`
(`bank.ir.json` / `subject.json` are skipped). Uploaded PDF magic-byte checks
stay `%PDF` — notes are text sources, not PDFs. `--provider` is required
(`anthropic` / `openai` / `local` / `claude-cli` / `codex-cli` / `test`). Default `--seed` is `0` and is
recorded in the run manifest. A tree generate of `content/subjects` still needs
a source file per subject — biology is hand-authored and has none, so a tree
generate of `content/subjects` fails closed and hints to target
`content/subjects/<id>` or `--subject <id>` (e.g. demo) instead of inventing
sources. Tree generate is **all-or-nothing for BankIR**: it
preflights sources and overwrite, drafts every subject (`dry-run-ir` — SAMPLE
freeze and provider fail closed here), then commits only if every draft
succeeds. Abort is checked before that commit; a later filesystem write rolls
back earlier artifacts. A sourceless or frozen sibling lists the problem and
leaves **no** partial BankIR.

`--dry-run-ir` prints the would-write path and writes nothing durable (no IR,
cache, or manifest). A real BankIR **with questions** is treated as existing:
dry-run says **would overwrite**, and persist requires `--force` (fail closed,
no write). Empty / placeholder IR (empty file, valid zero-item schema —
the shape addSubject can leave) is **non-existing** for that gate; first
real generate does not need `--force`. Corrupt / unparseable / invalid-schema
IR is overwrite-protected: persist requires `--force` and the error names
**corrupt** (not empty). Sample-bank ids
(`SAMPLE_QUESTIONS`, the same frozen set as validate/emit) fail closed
**before** the IR write unless `--replace-sample` and say **no BankIR written**
(they do not imply `bank.ir.json` already exists). `--provider test` on a
sample subject such as `maths` would emit `maths-easy-1` and is refused
without that flag. Missing cloud API keys are refused before overwrite
messaging when a real key is required; `--force` stays fail-closed. The test
provider still runs without keys.

It still rasterizes missing
PDF pages into a temp directory (`safeTempRoot`: outside every Examify
checkout, even when `TMPDIR` points into one) when `pdftoppm` is available so the preview
matches a persist run; it does not populate `.examify-ingest/cache/pages/`.
The locked generate prompt is `prompts/v2/generate-bank.md`. The unused v1
draft was removed so a stale untrusted-source framing cannot be loaded.

Cloud providers fail closed without a real env key (`ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`) **on a cache miss**. The generate CLI fills unset keys from
the repo `.env` then `.env.local` (already-set env vars, including an empty
string, win). Repo root is the `package.json` name `project-examify` walk
(`findRepoRoot`), not `process.cwd()`, so a generate from a subdirectory
still reads the `.env` the wizard / `install.sh` wrote. `/onboarding` and
`install.sh` write `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` into that same
store. Next `env.ts` optionalizes Anthropic so a wizard clear + production
restart does not brick boot (grading / generate fail closed without a key).
Host-injected
keys (process exec environ) win after restart and are not rotatable from
the wizard even when `.env` happens to match. A matching
`cacheKey` reuses the cached
IR with no network and does not require the key. The app's
`ANTHROPIC_API_KEY=test` sentinel is refused on a miss — use `--provider test`
for CI. `local` needs `EXAMIFY_INGEST_LOCAL_CMD` (quoted executable + args;
stdin JSON includes full source text / `dataBase64` bytes plus page-image
bytes — never hashes-only) or `EXAMIFY_LLM_BASE_URL`
(OpenAI-compatible `/v1/chat/completions` with the same multimodal user
content as `--provider openai`: fenced text + images / page images). The
command wins when both are set; `--local-transport endpoint|command` uses
only that one (the other's settings are dropped, as in the wizard's Local
endpoint / Local command modes). The endpoint gets `--model`, else
`EXAMIFY_LLM_MODEL`, else `local`. The transport in use (`command` /
`endpoint`) is part of the `cacheKey`, so a bank cached by one is never
served to the other.

`claude-cli` runs Claude Code and `codex-cli` runs Codex with their own
sign-in (no key env). Both are found via `EXAMIFY_CLAUDE_BIN` /
`EXAMIFY_CODEX_BIN` (absolute path, or a name on `PATH`), else `PATH`, else
`~/.local/bin` (and `~/.claude/local` for Claude Code); missing →
`CliNotFoundError` before anything runs. On Windows only a `.exe` counts: an
npm `claude.cmd` / `codex.cmd` shim is a batch file that `spawn` cannot start
without a shell, so point `EXAMIFY_CLAUDE_BIN` / `EXAMIFY_CODEX_BIN` at the
CLI's own `.exe` (a full path, or a name such as `codex.exe` on `PATH`).
Windows env names are case-insensitive (`Path`, `SystemRoot`), as Windows
itself treats them: merging the repo `.env` files folds every name to upper
case, and the host env still wins over the files. The model is `--model`, else
`EXAMIFY_CLAUDE_MODEL` / `EXAMIFY_CODEX_MODEL`, else the CLI's own (recorded
as `default`). Each run (`providers/command.ts`, shared with the local
command) has a 10-minute deadline (`CLI_PROVIDER_TIMEOUT_MS`), an empty
private `0700` temp folder as its working directory (removed afterwards; the
system temp folder, else `/tmp`, whichever resolves outside every Examify
checkout, so a `TMPDIR` pointing into the checkout is skipped),
and an allowlisted environment (`agentCliEnv`: PATH, HOME, locale, XDG,
proxy / CA, `TMPDIR` / `TMP` / `TEMP` set to the run folder, plus
`CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_API_KEY`) — never
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or any other Examify secret. Cancel and
the deadline kill the whole process group. The CLI's own folder
(`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, else `~/.claude` / `~/.codex`) inside an
Examify checkout (on realpaths; for Codex, also an `auth.json` that links
into one) is refused before anything runs, as a `command` failure.

Claude Code runs as

```bash
claude -p --input-format stream-json --output-format stream-json --verbose \
  --tools "" --strict-mcp-config --setting-sources project \
  --no-session-persistence --system-prompt <prompt> [--model <m>]
# env: CLAUDE_CODE_SAFE_MODE=1 (plus the agentCliEnv allowlist)
```

Stdin is one user message with the Anthropic provider's content blocks (PDFs
as documents, so no rasterizer needed). The last `result` event is the answer;
`is_error` with `api_error_status` is an `http` failure, a sign-in message is
`auth`, and no result is `command` (with the CLI's stderr). The service
user's own settings and `CLAUDE.md` never load (`--setting-sources project`;
the project is the empty private folder), and safe mode also turns off
plugins and skills (an older Claude Code ignores the variable). Needs Claude
Code 2.x (`--tools`, `--setting-sources`).

Codex runs as

```bash
codex exec --json --sandbox read-only --skip-git-repo-check --ephemeral \
  --ignore-user-config --cd <tmp>/work --output-last-message <tmp>/last-message.txt \
  -c features.shell_tool=false -c features.unified_exec=false … \
  -c 'web_search="disabled"' -c skills.include_instructions=false \
  [--model <m>] [--image <file> …]   # prompt on stdin
# env: CODEX_HOME=<tmp>/home (plus the agentCliEnv allowlist)
```

`--ignore-user-config` skips only `config.toml`, so each run gets a private
`CODEX_HOME` (`stageCodexHome`) holding only a `0600` copy of the user's
`auth.json` (`CODEX_HOME`, else `~/.codex`): the global `AGENTS.md`, skills and
rules never load, and Codex's SQLite state, logs and installation id are
removed with the run folder. A sign-in Codex refreshed during the run (refresh
tokens rotate) is copied back to the user's `auth.json` atomically, only when
it is a JSON object and that file still holds what was staged; no `auth.json`
is ever created there.

Image sources and PDF page images are attached as files; PDF bytes are not,
so a PDF-only subject needs `pdftoppm` (`UnreadableSourcesError`).
`turn.failed` with `status NNN` is `http`, a sign-in message is `auth`.
Unknown feature names only warn, so the list (`CODEX_DISABLED_FEATURES`:
shell, apps, plugins, browser, image tools) is safe across Codex versions.

Temperature is `0` when the remote API allows it. Anthropic's Messages API
has no seed field (`seedHonored: false` on the manifest); the seed still
goes in the user message and `cacheKey`. The agent CLIs honour neither
(`seedHonored: false`).

Every successful (non-dry-run) generate run writes a `RunManifest` under
`.examify-ingest/runs/` (gitignored): provider, model, promptVersion (`v2`),
prompt hash, seed, `seedHonored`, temperature `0`, source file hashes,
cacheKey, timestamp, subject ids, and key presence/name only — never the key
value. `cacheKey` is a stable hash of promptVersion, prompt hash, provider,
model, seed, source hashes, subject meta, ordered page-image hashes
(`path#page=sha256`), and the raster profile (`pdftoppm-png-r150`). A
prompt-text change, a different raster byte set, or a later pdftoppm run
cannot replay a hashes-only cache entry. The page-image list is the set
identity — a derived extra field would bust every existing cache key.
PDF page images, when rasterized with `pdftoppm`, are reused from
`.examify-ingest/cache/pages/<pdf-sha256>/` and framed as untrusted data, same
as source files. OpenAI-compatible generate (`openai` and local HTTP) and Codex
cannot inline raw PDF bytes: if the only sources are PDFs and no page images were
rasterized, the run fails closed. Provider HTTP/CMD calls use a 180s deadline
(`claude-cli` / `codex-cli`: 10 minutes, `CLI_PROVIDER_TIMEOUT_MS`),
optionally combined with `generateSubject({ signal })` via `AbortSignal.any`.
Abort throws `GenerateAbortedError` and writes no IR, IR cache, page-raster
cache, or run manifest.
Sources must stay under `content/subjects/<id>/` or `content/source-pdfs/<id>`
of the layer root.

Source blobs are wrapped as `UNTRUSTED SOURCE MATERIAL` with static
`BEGIN`/`END` markers. Those delimiters stay fixed on prompt v2 on purpose:
a per-run nonce would bust every `cacheKey` and would not stop a hostile PDF
from emitting the same label. The fence is a model-facing reminder, not a
capability boundary. A human still runs validate content/subjects →
emit content/subjects --dry-run → emit content/subjects --apply.

`validate` and `emit` accept a subjects directory (scans `*/bank.ir.json`) or
one or more explicit IR file paths. Generate does not change those commands.

`emit` is **dry-run by default**. It prints a diff against the files already on
disk (or `would create`). Pass `--apply` to write.

`--replace-sample` is required if any IR id collides with an id already in the
hand-authored sample bank (`SAMPLE_QUESTIONS`). Additive subjects are the
default; do not clobber sample ids unless you intend to replace them and update
any unit tests that reference them.

`emit` **merges** `content/generated/subjects.json` by subject id when any
input is an explicit IR file path (a partial emit): this run upserts its
subjects and leaves other generated subjects (and their `questions/` +
`keys/` files) in place. Mixed file+directory argv is also partial-safe and
never prunes.

When **every** emit path is a **subjects directory** (typically just
`content/subjects`), that tree is the authoritative generated catalog. Any
leftover `questions/<id>.json` / `keys/<id>.json` — and the matching
`subjects.json` row — for an id with no `bank.ir.json` in this run is
planned for delete. An empty subjects directory (no `bank.ir.json`) is
refused and never wipes generated files. `validate` of an empty tree also
fails. (The `/onboarding` wizard, which only ever touches the family layer,
turns an empty family tree with leftover family files into a prune-only plan
behind its named prune confirm, so a family can remove its last subject.) Dry-run lists planned deletes; `--apply` writes every file first, then
removes leftover files (order below). The hand-authored sample
bank in `src/lib/exam/data.ts` and `answer-keys.server.ts` is never touched.

When `src/lib/exam/generated-public.ts` and `generated-keys.server.ts` already
exist, a committed-layer `--apply` rewrites those registrars from the
resulting catalog (a family-layer emit never does). Every file is written
atomically (temp file + rename): questions and keys first, then the
registrars, then `subjects.json` (the live bank reads the catalog first, so it
is the commit point), then leftover deletes.

A family-layer emit (the wizard, or the CLI on `data/content/subjects`) also
gives each catalog row it writes a `rev`: the sha256 of that subject's exact
`questions/<id>.json` bytes, a newline, then its `keys/<id>.json` bytes (rows
this run leaves alone keep theirs). The live bank serves a row with `rev` only
when the files it reads hash to it — otherwise the last consistent copy it read,
or nothing — so a request or a crash between the writes never pairs new
questions with old keys. Committed-layer output never has `rev`, and neither do
the registrars.

## BankIR shape (version 1)

```json
{
  "version": 1,
  "subject": {
    "id": "biology",
    "label": "Biology",
    "icon": "biology",
    "l": 0.58,
    "c": 0.09,
    "h": 142
  },
  "difficulties": {
    "easy": [
      {
        "id": "biology-easy-1",
        "type": "mcq",
        "q": "Which organelle is known as the powerhouse of the cell?",
        "choices": ["Nucleus", "Ribosome", "Mitochondrion", "Golgi apparatus"],
        "answer": 2,
        "provenance": { "pdf": "hand-authored", "locator": "sample IR v1 · biology/easy" }
      },
      {
        "id": "biology-easy-free-1",
        "type": "free",
        "q": "Explain two differences between a plant cell and an animal cell.",
        "rubric": "Award up to 2 marks. …",
        "maxScore": 2,
        "provenance": { "pdf": "hand-authored", "locator": "sample IR v1 · biology/easy" }
      }
    ],
    "medium": [],
    "hard": []
  },
  "meta": {
    "promptVersion": "optional",
    "provider": "optional",
    "seed": "optional",
    "sourceHashes": { "optional.pdf": "sha256-optional" }
  }
}
```

Rules the validator enforces:

- `subject.id` is kebab-case (`/^[a-z][a-z0-9-]*$/`).
- MCQ items have exactly 4 choices and `answer` in `0..3`.
- Free-text items have a non-empty `rubric` and `maxScore > 0`.
- Every item has `provenance { pdf, locator }`.
- Ids: `{subject}-{difficulty}-{n}` (MCQ) and `{subject}-{difficulty}-free-{n}`
  (free). Ids must start with the subject id and be globally unique in a run.

`splitIr(bank)` is the library entry that strips `answer` / `rubric` /
`maxScore` / `provenance` from the public question objects.

## Emit targets

Under the layer root (the checkout, or the family data folder):

```
content/generated/subjects.json
content/generated/questions/<subjectId>.json
content/generated/keys/<subjectId>.json
```

Public question JSON never includes answers, rubrics, scores, or provenance.
Keys are server-only. The running app reads the family layer's
`content/generated/` at request time (`src/lib/exam/live-bank.server.ts`) and
must never pass key objects to the client. Do not import
`content/generated/keys/` from client code.

Committed-layer files are meant to be committed; source PDFs stay in the
gitignored `content/source-pdfs/` directory. Nothing in the family data folder
is committed.

After a committed-layer `emit content/subjects --apply`, `planEmit` rewrites
`src/lib/exam/generated-public.ts` and
`src/lib/exam/generated-keys.server.ts` from the merged catalog (`planEmit`
option `registrars: true`; the default is false). The registrars are how the
app loads the committed layer: they import the JSON, so it ships with the
build and a change needs a rebuild. A family-layer emit never writes them. Do
not add those imports by hand. The committed biology sample is already
registered.

## Library

```ts
import { splitIr, validateIrCollection, FIXTURE_IDS, runManifestSchema } from 'examify-ingest';
import { generateSubject } from 'examify-ingest/generate';
```

`generateSubject` is the library entry the Setup Wizard can call later
(`examify-ingest/generate`, not the Phase 0 emit graph). It still only writes
BankIR (+ gitignored run/cache files). Callers must run
validate content/subjects → emit content/subjects --dry-run →
emit content/subjects --apply themselves.

Optional `signal?: AbortSignal` is forwarded to Anthropic / OpenAI / local HTTP
`fetch` and to the local CMD subprocess. Abort/timeout kill the POSIX process
group (SIGTERM, then SIGKILL); stderr is discarded so a chatty wrapper cannot
fill the pipe and hang. The test fixture
honors an already-aborted signal. Wizard cancel passes this signal through
`generateOnboardingSubject` so Cancel aborts provider HTTP/CMD and discards
the preview. Skipping the IR write after the provider returns is not provider
abort. Abort after the
provider returns still writes no `bank.ir.json`, IR cache, page-raster cache,
or run manifest. `--dry-run-ir` still writes nothing durable.

Failures are typed so callers never parse messages (all exported from
`examify-ingest/generate`):

- `ProviderFailureError` — `kind` is `http` (non-2xx, or an agent CLI's API
  error with its status; `status` set), `timeout` (the 180s deadline; 10
  minutes for `claude-cli` / `codex-cli`), `unreachable` (no answer: network,
  or a local command / agent CLI that could not start), `output` (an answer
  that is not usable BankIR, including cached output that fails validate),
  `command` (a local command or agent CLI that exited non-zero or reported an
  error) or `auth` (Claude Code / Codex not signed in, with no HTTP status).
- `CliNotFoundError` — a `ProviderConfigError`: the `claude` / `codex` binary
  was not found (`cli` names which); nothing ran.
- `SampleIdCollisionError` — generated ids hit the frozen sample bank without
  `replaceSample`; `ids` lists them. No BankIR written.
- `UnreadableSourcesError` — the provider cannot read any source
  (OpenAI-compatible or Codex, PDF-only, no rasterized pages).

The HTTP call and reading its body share one deadline / cancel boundary, so a
body that stalls or drops part-way is typed like a failed request. CLI messages
are unchanged except the HTTP fetch deadline, which now reads `provider request
timed out after 180000ms`, and a 200 whose body is not JSON
(`<provider> returned a body that is not JSON`). The wizard maps these to safe
reason codes (`provider_auth` for 401/403, `provider_rate_limited` for 429,
`provider_unavailable` for 5xx or unreachable, `provider_timeout`,
`provider_output_invalid`, `provider_error`, `sample_collision`,
`sources_unreadable`) and never shows the raw message.
