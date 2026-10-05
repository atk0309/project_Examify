# Add or generate questions

## Use the setup wizard

**Solo:** choose **Create your question bank** on the practice page. You can return
after Finish to add more subjects or material. **Household:** use `/onboarding`
for initial setup, or **Finish content setup** on the parent dashboard if you
skipped it. After household setup is finished, use the CLI below for later changes.

1. Enter a subject name; Examify suggests its ID. Choose a different ID if the
   app warns that it would replace a sample or built-in subject you want to keep
2. Upload PDFs (up to 8 MiB each). Solo also accepts UTF-8 `.txt`/`.md` notes
   (up to 1 MiB each); household text sources use the CLI workflow below.
   Uploading stores them locally; it does not start generation
3. Choose an AI provider and Generate. Check [provider prerequisites](configuration.md#ai-for-question-banks-and-marking).
   For a local endpoint, save its URL and model in AI settings before returning
4. Choose **Review questions** to check the draft format and see the questions,
   correct choices or marking guidance, and planned file changes. Check their
   accuracy against your material
5. Select **Looks good**, then **Confirm apply** to make the bank available.
   Generate alone does not make questions available for practice. Apply does not
   need an app rebuild

Cancel leaves the current subject's previous question-bank file unchanged.
If generating several subjects, those already completed remain saved. Replacing
existing questions requires confirmation. Reusing a built-in subject ID replaces
that entire subject; choose a new ID to keep both. The sample remains unless you
explicitly choose to replace it.

The wizard's Review screen shows saved drafts as read-only cards, grouped by subject
and difficulty. Multiple-choice cards mark the correct choice; written questions show
**Marking guidance** and the maximum score. These drafts have no separate explanations
or model answers. Format validation does not establish accuracy: check the content
against your material, especially scanned pages and diagrams. Cancelled or partial
Generate runs may leave a mix of retained and newly generated drafts; Review shows the
saved drafts, not a claim that all subjects were regenerated.

To edit a draft, use a local text editor on the private
`content/subjects/SUBJECT_ID/bank.ir.json` in the active data folder. Source references
remain in that file and are not displayed in Review; never share it in a public issue.
Choose **Refresh review** after editing to check and inspect the draft again.
Apply is bound to the exact plan shown in this tab, including answers; a newer
review in another tab cannot approve unseen changes.
Leaving Review to change inputs clears its local preview. Reloading requires a new review.
The web wizard rejects linked/nonregular drafts, files above 2 MiB or a combined
8 MiB draft tree; it never silently omits excess questions to enable Apply.
[Solo data locations](solo-maintenance.md#find-your-files) ·
[Household data locations](operations.md).

Keep uploaded material private unless you have permission to share it. Generating
questions can send it to your chosen AI provider; see [privacy](privacy.md).

## Where questions live

- **Family content:** `<data folder>/content/subjects`, with PDFs under
  `content/source-pdfs` and published files under `content/generated`. This is
  what the wizard manages. It is not committed to Git and belongs in your backups
- **Committed content:** the checkout's `content/` plus generated TypeScript
  registrars. This is for shipped examples and developer-maintained banks;
  changes need a rebuild and a commit
- **Sample content:** hand-authored TypeScript under `src/lib/exam/`

A family subject with the same ID as a committed subject takes its place. If its
published question/key files are invalid, the app keeps the committed version
and logs a reason. Run `pnpm examify:data verify` to check family data.

## CLI workflow

These commands are for household/source installations, not the portable solo package.
Run them from the checkout. These examples use the default `./data` folder;
substitute your configured `EXAMIFY_DATA_DIR` when it is elsewhere. Use an existing
family subject, or create `data/content/subjects/history/` and put your notes or
images there. For PDFs, create `data/content/source-pdfs/history/` and place them
there. Replace `history` below with a unique subject ID; generation supplies
default subject metadata when no `subject.json` exists:

```bash
pnpm examify-ingest generate --provider anthropic data/content/subjects/history
pnpm examify-ingest validate data/content/subjects
pnpm examify-ingest emit data/content/subjects --dry-run
pnpm examify-ingest emit data/content/subjects --apply
```

Choose the provider you configured; `--provider test` is a deterministic test
fixture, not real study-material generation. Generate writes intermediate JSON
(`bank.ir.json`) only. Inspect it before Apply. Existing or corrupt BankIR needs
`--force` to replace; an ID from the sample bank also needs `--replace-sample`.
Never add these flags just to silence an error without checking what will change.

A whole-directory emit removes previously generated subjects absent from that
directory. Review the dry-run, especially its deletes. An explicit IR-file emit
updates only the named subjects. Do not mix family and committed paths.

The [CLI reference](../tools/examify-ingest/README.md) covers flags, providers,
BankIR schema, source discovery and developer examples. Biology is a hand-authored
example with no input files, so skip generation for it. `content/subjects/demo`
is the fresh-clone generation fixture.

For developer-maintained committed banks, validate and review the committed paths instead:

```bash
pnpm examify-ingest validate content/subjects
pnpm examify-ingest emit content/subjects --dry-run
pnpm examify-ingest emit content/subjects --apply
```

Committed-layer work can leave content that production migration treats as
legacy family data. In a development checkout only, use
`EXAMIFY_IGNORE_LEGACY_CONTENT=1` when running `pnpm db:migrate`. On a real
installation, use the [upgrade workflow](operations.md#upgrading) instead.

## Public questions and private answers

Public practice questions and saved exam sessions never contain correct answers,
rubrics or source provenance. The privileged onboarding Review is a narrow exception:
a revalidated solo owner, or household admin outside Student View while setup is open,
may inspect the allowlisted draft answers and marking guidance in wizard memory.
It does not expose provenance, provider metadata, raw key files or grading snapshots,
and does not store answers in browser storage. For hand-edited sample questions:

- `src/lib/exam/data.ts` holds IDs, question text and choices
- `src/lib/exam/answer-keys.server.ts` holds the answer or rubric, joined by ID

Never put an answer, rubric, maxScore or provenance into the public bank.
Generated content uses the same separation; tests guard against leaking keys.

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

## Editing the built-in sample bank (developers)

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

Marking uses the household's selected provider: Anthropic, OpenAI, Claude Code,
Codex or a local endpoint. Local-command generation uses the Anthropic fallback
for marking. See [AI configuration](configuration.md#ai-for-question-banks-and-marking).

The provider receives the question, rubric, maximum score and student's answer.
The server validates and bounds the returned score and feedback. Spelling is
reported separately and is not deducted. A score of at least 60% of `maxScore`
counts as correct.

API marking sends individual answers; CLI marking batches an exam. Network,
authentication or invalid-response failures produce `needs_review` rather than
losing the attempt. Unmarked written answers remain pending and are excluded
from the provisional percentage. Pending attempts stay out of aggregate trends
and averages until marking completes. Students can explicitly Retry marking from
their own results or progress; this updates the same attempt using its original
rubric snapshot and leaves completed marks alone. There is no background retry.

Development can use `ANTHROPIC_API_KEY=test` (or an OpenAI test key) for deterministic
full marks without a network request. Production disables that stub unless
`GRADING_STUB=1`; never enable it for a real household.

## Check content before publishing

Run validation and inspect the dry-run for the intended family folder. For
committed content, also run `pnpm test` and `pnpm build`; these check public/private
key parity and catch imports of server-only answers into the client bundle.
Keep every question's ID globally unique and record its source in `provenance`.
