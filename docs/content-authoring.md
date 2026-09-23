# Authoring content

Examify has no CMS and no parser scripts — the question bank is TypeScript you edit by
hand (or generate with an AI assistant from your own study material). This guide covers
the data model, the exam builder, the free-text grading API, and a proven workflow for
turning source PDFs into a grounded question bank.

## The two-file model

Every question is split across two files, joined by a shared, **globally-unique** `id`:

| File                                 | Ships to browser?      | Holds                                            |
| ------------------------------------ | ---------------------- | ------------------------------------------------ |
| `src/lib/exam/data.ts`               | **Yes**                | Public text: `id`, `type`, `q`, `choices?`       |
| `src/lib/exam/answer-keys.server.ts` | **No** (`server-only`) | Correct MCQ index, rubric + maxScore, provenance |

The hard rule: **never put an `answer` or `rubric` into `data.ts`.** Everything in the
public bank is bundled into client JavaScript; the key store imports `server-only`, so
the build fails if it ever ends up in the client graph. A unit-test guard
(`tests/unit/answer-keys.test.ts`) additionally asserts no question object carries an
`answer`/`rubric`/`maxScore`/`provenance` property.

## Two generated layers: committed and family

Generated subjects (emitted from BankIR) come in two layers on top of the
sample bank:

| Layer     | Lives in                                                                | The app reads it                                                    |
| --------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Committed | the checkout: `content/subjects`, `content/generated`                   | at build time, through the `src/lib/exam/generated-*.ts` registrars |
| Family    | the family data folder: `data/content/{subjects,source-pdfs,generated}` | on every request (`src/lib/exam/live-bank.server.ts`)               |

- **Committed** is the shipped content (biology, the `demo` generate fixture)
  and what CI runs. Its `--apply` writes tracked files and rewrites the
  registrars, so a change needs a rebuild and a commit.
- **Family** is your family's own content. `/onboarding` reads and writes only
  here (subjects, uploaded PDFs, BankIR, generated JSON; API keys go to the
  checkout `.env`), it is never committed, and an Apply is live on the next
  request. The folder is `EXAMIFY_DATA_DIR` (default `./data`; with an absolute
  value, use that path wherever this guide says `data/`).
- **A family subject with a committed subject's id replaces it** entirely: its
  questions and keys, with the tile in the committed position. The wizard's
  Review says so ("Replaces built-in subject: Biology") and the add-subject form
  warns when an id is a built-in one. A family subject whose questions file does
  not parse, or any of whose questions lacks a key, is left out with one
  reason-coded `[live-bank]` warning, and the committed subject it would have
  replaced stays.
- **The CLI picks the layer from the paths you name.** A path inside the data
  folder is family (checked first — `./data` sits inside the checkout), any
  other path in the checkout is committed; a path in neither, or a run that
  names both, is refused. Every run prints `layer: family (data)` or
  `layer: committed (checkout)` first. Only a committed emit writes the
  registrars. API keys come from the checkout `.env` in both layers.

Family work from the repo root:

```bash
pnpm examify-ingest generate --provider test --seed 0 data/content/subjects/<id>
pnpm examify-ingest validate data/content/subjects
pnpm examify-ingest emit data/content/subjects --dry-run
pnpm examify-ingest emit data/content/subjects --apply
```

**Committed-layer work in a development checkout.** A committed generate or
emit leaves files in the checkout (`bank.ir.json`, `.examify-ingest/`, changed
`content/generated/` and registrars) until you commit them, and
`.examify-ingest/` stays even after that. `pnpm db:migrate` and `install.sh`
read such files as family content an older version left behind and refuse to
run; set `EXAMIFY_IGNORE_LEGACY_CONTENT=1` for `db:migrate` in that checkout.
Never set it on a real install — use `./install.sh --upgrade` there.

## Automated path (Phase 0 emit + Phase 2 generate)

You can author a **BankIR** JSON document by hand, or generate one from local
source files, then emit the two-file split with `examify-ingest`. After
first-run `/setup`, the admin wizard at `/onboarding` can add subjects, attach
local PDFs (stored in the family data folder under
`content/source-pdfs/<subject>/`) or notes/text in the subject folder,
optionally generate
BankIR on the AI step (`examify-ingest/generate`, IR only), and run the same
directory emit (validate, Review / dry-run HITL with planned deletes, then apply). The
wizard does **not** auto-emit or auto-apply after generate. Adding a subject
writes `subject.json` only — no empty/placeholder `bank.ir.json`. Overwrite /
skip / generate use shared `hasExistingBankIr` (empty / valid zero-item ≠
existing; corrupt / unparseable / invalid schema needs force; never
`existsSync` on the IR path). A real existing
`bank.ir.json` is never silently replaced: the generate preview names
`would overwrite content/subjects/<id>/bank.ir.json`, then the wizard
asks “Replace existing BankIR for {label}?” before any write (generate-all
uses a named batch, not an opaque count). Decline keeps the prior file
(`skipped` or cancelled, not a failure). Confirm writes through shared
`writeBankIrAtomic` (CLI `--force` for that subject). Cancel POSTs
`/api/onboarding/cancel-generate` (a Route Handler, not a queued Server
Action) so the token can land mid-generate, then aborts provider HTTP/CMD
via AbortSignal and discards the preview so prior `bank.ir.json` is
unchanged. The wizard waits for an `ok` cancel response before claiming
cancelled. During Generate all, cancel stops the later subjects; subjects
that already wrote BankIR are kept and reported. An
acknowledged cancel unlocks the wizard even if the provider is still
unwinding. Delete/rename wait on the generate lock and re-check the admin gate
after the wait. Generate is limited to subjects in the wizard catalog. Hand-authored IR
can skip generate. Apply refuses if the plan hash no longer
matches the confirmed dry-run. Finish requires that confirmed apply; skip is
the no-emit exit (sample bank). Deleting a subject removes its IR/source dirs;
leftover generated JSON is pruned only after a named HITL confirm on Apply
(cancel keeps those files). Ready lists live bank subject ids/names and
question counts.
An empty subjects tree is refused and never wipes generated files. Uploaded
PDFs must start with `%PDF`; their names are sanitised to a safe basename
(commas, apostrophes, accents are fine), and a different file with the same
name is stored as ` (2)`. `--replace-sample` is off unless the admin enables
it: the Review › Advanced toggle, or the same toggle on AI setup, shown when a
subject reuses a sample subject id. Generate uses that setting too; without it
such a subject is refused before the provider call.

Generate writes IR only. It never silently emits or applies. A real BankIR
with questions is not overwritten unless you pass `--force` (dry-run says
**would overwrite**). Empty / placeholder IR (empty file, valid zero-item
schema) is treated as missing — no `--force` needed. Corrupt / unparseable /
invalid-schema IR requires `--force`; the error names corruption, not empty.
Sample-bank ids fail at generate unless `--replace-sample` (**no BankIR
written**; that copy does not imply the file already exists).

**Hand-authored biology** (`content/subjects/biology/bank.ir.json`) has no
source file. Skip generate; validate / emit only. Generate needs a source
file first.

1. Drop sources in `content/source-pdfs/<subject-id>/` and/or the subject
   folder `content/subjects/<subject-id>/` of the layer you work on
   (`data/content/…` for family content; the checkout's `content/source-pdfs/`
   is gitignored) — `notes.txt` / `.md` / images / PDFs; generate scans the
   same extensions the CLI accepts. Optional: author
   `content/subjects/<id>/bank.ir.json` by hand (see the biology sample)
   instead of generating. A committed generate fixture lives at
   `content/subjects/demo/notes.txt`. Uploaded PDFs still need `%PDF` magic
   bytes; notes are text sources, not PDFs.
2. From the repo root, committed layer (fresh-clone generate fixture; family
   work swaps in `data/content/subjects`, as above):

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

   Cloud generate (`--provider anthropic` / `openai`) reads `ANTHROPIC_API_KEY`
   / `OPENAI_API_KEY` from the environment or repo `.env` / `.env.local` (existing
   env vars win) and fails closed on a cache miss if
   the key is missing or is the `test` sentinel. The `/onboarding` AI step
   and `install.sh` can write `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` into
   that same repo-root `.env` store (`findRepoRoot`, not `process.cwd()`);
   the wizard never echoes the value. A host-injected usable key (Docker /
   systemd / parent exec environ — not live-vs-file equality) cannot be
   rotated or cleared from the wizard. A boot `test` sentinel can still
   be cleared / rotated, including after the first Save.
   A cache hit returns the prior
   IR without a network call. `--provider test` is the CI fixture (no
   network). `--provider local` uses quoted `EXAMIFY_INGEST_LOCAL_CMD` (stdin
   JSON includes full source text/bytes, not hashes-only) or
   `EXAMIFY_LLM_BASE_URL` (same multimodal payload as OpenAI — source text and
   page images, not hashes-only). `--dry-run-ir` writes nothing durable;
   when a real BankIR with questions already exists it says **would overwrite**.
   Persist over that IR requires `--force`. A sourceless sibling (biology on a
   fresh clone) blocks `generate content/subjects` — target
   `content/subjects/<id>` or `--subject <id>` (e.g. demo); generate does not
   invent sources.
   Sources are framed as untrusted data (`promptVersion` v2) with static
   `UNTRUSTED SOURCE MATERIAL` fences; still review IR before emit. Run
   manifests land in the layer's `.examify-ingest/` (gitignored in the
   checkout).

3. `emit` writes the layer's `content/generated/subjects.json`,
   `content/generated/questions/<id>.json` (public fields only), and
   `content/generated/keys/<id>.json` (answers, rubrics, provenance; `0600` in
   a `0700` folder). Every file is written atomically, questions and keys
   first and `subjects.json` last. The running app reads the family layer's
   JSON at request time and merges it onto the committed layer and the sample
   bank (`src/lib/exam/live-bank.server.ts`), so an onboarding Apply is
   visible on `/` without a rebuild. A committed-layer `--apply` also rewrites
   `src/lib/exam/generated-public.ts` and `src/lib/exam/generated-keys.server.ts`:
   those registrars are how the app loads the committed layer (bundled at
   build time, so rebuild). A family emit never writes them. Keys stay
   server-only. A partial emit (any explicit IR file path, or
   mixed file+directory argv) upserts `subjects.json` and does not clobber
   other generated subjects. Emitting only subjects directories (typically
   `content/subjects`) is authoritative: leftover generated JSON for a subject
   no longer present in that tree is deleted. An empty subjects tree is
   refused (fail closed) and does not wipe generated files.

Ids that collide with **any** id already in the sample bank (`SAMPLE_QUESTIONS`)
are refused unless you pass `--replace-sample`. Full IR shape, commands, and the
`splitIr` contract: [`tools/examify-ingest/README.md`](../tools/examify-ingest/README.md).

## Question shapes

```ts
// data.ts — public
{ id: 'maths-easy-1', type: 'mcq', q: 'What is 9 × 3?', choices: ['18', '24', '27', '36'] }
{ id: 'maths-easy-free-1', type: 'free', q: 'Explain how you would work out 15% of 200…' }
```

The id convention is `<subject>-<difficulty>-<n>` for MCQs and
`<subject>-<difficulty>-free-<n>` for free-text. Ids must be unique across the whole
bank (not just within a subject) because attempts and saved sessions reference questions
by id alone.

## Answer keys

```ts
// answer-keys.server.ts — server-only
'maths-easy-1': {
  type: 'mcq',
  answer: 2, // index into choices
  provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/easy' },
},
'maths-easy-free-1': {
  type: 'free',
  maxScore: 3,
  rubric: 'Award up to 3 marks. 1 mark: … Accept equivalent wording. ' +
          'Do not penalise minor spelling slips; note them separately.',
  provenance: { pdf: 'hand-authored', locator: 'sample bank v1 · maths/easy' },
},
```

**`provenance` is mandatory on every key.** It records where the item came from so the
bank stays auditable: set `pdf` to the source document's filename and `locator` to the
page/section (e.g. `{ pdf: '09 Maths.pdf', locator: 'p2 · Factors and Multiples' }`).
For original content, use the `'hand-authored'` convention the sample bank uses.
Provenance is server-only metadata — it is never rendered to users.

## Writing rubrics the grader marks well

Free-text answers are graded by an LLM strictly against your rubric (see
[Free-text grading](#the-free-text-grading-api) below), so the rubric _is_ the mark
scheme. The house style that grades reliably:

> Award up to **N** marks. 1 mark: ⟨first creditable point⟩. 1 mark: ⟨second point⟩.
> 1 mark: ⟨third point / a correct example⟩. Accept equivalent wording. Do not penalise
> minor spelling slips; note them separately.

Guidelines:

- Keep `maxScore` small (2–4) and enumerate exactly what earns each mark.
- Say what to _accept_ ("accept Australia/Australasia for Oceania") and how to handle
  partial credit, rather than leaving it to the model's judgement.
- Spelling is deliberately never penalised — the grader reports slips in a separate
  `spelling` list so the student still sees them.
- The student sees only the bounded verdict (score, a one-line comment, got-right /
  to-review / spelling lists) — never the rubric itself, so you can be blunt in it.

## Adding a subject or difficulty

1. Add an entry to `SUBJECTS` in `data.ts`: `{ id, label, icon, l, c, h }`. The
   `l`/`c`/`h` values are OKLCH accent parts; pick a distinct hue and the theme system
   re-tones everything else automatically.
2. Add `QUESTIONS[<id>]` with an array per difficulty, plus the matching
   `ANSWER_KEYS` entries.
3. Give it an icon in `src/components/exam/icons.tsx`, keyed by the same id. The file
   still contains all thirteen duotone icons from the original deployment (`biology`,
   `chemistry`, `physics`, `french`, `latin`, `drama`, `music`, `food`,
   `product-design`, `textiles`, …) ready to reuse; an unknown key falls back to the
   maths icon.
4. Difficulties: extend `DIFFICULTIES` in `data.ts` and add the matching keys to each
   subject's bank.

## How exams are built

- `buildExam(subjectId, difficulty)` takes the bank for that combo, shuffles it
  (`EXAM_CONFIG.shuffle`), and slices to `EXAM_CONFIG.length` (20 by default — smaller
  banks just produce shorter exams). It runs on the client, which is exactly why the
  public bank must stay answer-free.
- Mid-exam autosave stores only the ordered question **ids** + the user's answers.
  Resume rebuilds and validates the exact paper with `resolveExamPaper` — never a fresh `buildExam` —
  so the student returns to the same questions in the same order. If you delete a
  question that a saved draft references, the draft is discarded gracefully.
- Scoring is server-truth: the client submits `{ type, id, chosen | response }` and
  `scoreAttempt` (`src/lib/exam/score.server.ts`) re-derives everything against the
  bank + keys.

## The free-text grading API

`gradeFreeText` (`src/lib/grading/index.ts`, server-only) sends one Anthropic Messages
API call per free-text item (`claude-sonnet-4-6`), containing the question, your rubric,
`maxScore`, and the student's answer, and demands strict JSON back:

```ts
type Verdict = {
  score: number; // 0..maxScore, clamped + rounded server-side
  verdict: string; // one encouraging sentence
  gotRight: string[]; // what the answer got right
  toReview: string[]; // what was missed or wrong
  spelling: string[]; // spelling slips (never deducted)
};
```

Behaviour you can rely on:

- **`ANTHROPIC_API_KEY=test`** (the live `process.env` value — never the
  boot-frozen `env.ts` snapshot) routes to a deterministic full-score stub —
  no network, no key needed for local development or CI. The stub only runs
  when `NODE_ENV` is not production or `GRADING_STUB=1`; in production
  without the flag, `test` counts as no key (`needs_review`). A wizard set /
  rotate is used on the next grade; clear fails closed (`needs_review`, no
  stub) so the Configured badge and the grader stay twins. Blank / missing
  is never treated as `test`. The key is optional in `env.ts` — a
  production restart after clear will not brick boot.
- **It never throws.** A fetch error, non-2xx, or unparseable model reply resolves to
  `{ status: 'needs_review' }`; the attempt persists with `score: null` and renders as
  "We couldn’t mark this one automatically, so it counts as not correct." (counted as
  incorrect, never lost, never re-graded). Each such outcome logs a `[grading]` warning
  with a reason code only.
- A graded item counts as **correct** when `score / maxScore >= 0.6`
  (`PASS_THRESHOLD` / `isFreePass` in `src/lib/exam/attempts.ts`).
- Items in one exam are graded concurrently, so a mixed paper marks in roughly one
  model round-trip.

## Generating a bank from your own PDFs and notes

Phase 2 `examify-ingest generate` can draft BankIR from those files (vision-first
when `pdftoppm` can rasterize pages; images are cached under the layer's
`.examify-ingest/cache/pages/<pdf-sha256>/`). Notes/text (`.txt` / `.md`,
including `notes.txt`) and images in the subject folder are first-class
sources too — the same set generate actually scans. You still review the IR, then
`validate data/content/subjects` and `emit data/content/subjects --dry-run` /
`emit data/content/subjects --apply` (`content/subjects` for the committed
layer). The original 13-subject
deployment was produced from school study guides with this same grounding rule.

1. For your family, drop your source PDFs in `data/content/source-pdfs/<subject-id>/`
   and/or notes/text/images in `data/content/subjects/<subject-id>/` (or upload
   them in `/onboarding`). Nothing in the family data folder is committed —
   source material often can't be redistributed, so it stays local-only. For
   shipped content, the checkout's `content/source-pdfs/` is **gitignored** for
   the same reason; only the questions you author or generate from it (with
   `provenance`) get committed. Uploaded PDFs must start with `%PDF`; a
   `notes.txt` is a text source, not a PDF.
2. Ingest **vision-first**: `generate` reuses cached page images when the PDF
   hash matches, and otherwise shells out to `pdftoppm` when it is installed.
   You can still render pages yourself (`pdftoppm -r 200`) and read them as the
   primary source of truth — study-guide PDFs are usually heavy on layout,
   tables, and diagrams that text extraction mangles. Use `pdftotext -layout`
   (text-layer PDFs) or `tesseract` OCR (scanned PDFs) as a cross-check.
3. Author or generate ~10 questions per subject per difficulty, graded
   **easy = recall**, **medium = apply**, **hard = reason**, with 2–3 free-text
   items per tier carrying a rubric derived from the source material.
4. Keep questions grounded: stay close to what the source actually says (a good
   rule of thumb is ~80% direct grounding, ~20% reasonable application of it),
   and record each item's `provenance { pdf, locator }` as you go.
5. Run `pnpm examify-ingest validate data/content/subjects` (family) or
   `pnpm examify-ingest validate content/subjects` then `pnpm test`
   (committed) — the guards below catch most authoring mistakes immediately.
   Generate never writes `content/generated/`. Bare `validate` / `emit` (no
   path) exit 2 and are not the happy path.

## Guards & test-coupled ids

`tests/unit/answer-keys.test.ts` enforces, over the whole bank:

- a **bijection** between `QUESTIONS` and `ANSWER_KEYS` (every question has exactly one
  key and vice versa; ids are globally unique);
- key `type` matches question `type`;
- every MCQ `answer` is an in-range integer; every free key has a non-empty `rubric`
  and `maxScore > 0`;
- every key has non-empty `provenance.pdf` and `provenance.locator`;
- no public question leaks an `answer`/`rubric` property.

A few sample-bank ids are also referenced by unit-test fixtures: `maths-easy-1` (must
stay the **first** item, an MCQ, of `maths`/easy), `maths-hard-1`, `geography-medium-1`,
`geography-medium-free-1`, and `geography-medium-free-2`. If you replace the sample bank
wholesale, either keep those ids or update the fixtures in
`tests/unit/score.server.test.ts`, `tests/unit/record-attempt.test.ts`,
`tests/unit/attempts.test.ts`, and the session tests alongside.
