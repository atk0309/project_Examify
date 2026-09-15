# examify-ingest

Phase 0 BankIR tooling for Examify. This package **validates** intermediate
question-bank JSON and **emits** the split public / server-only files the app
merges onto the hand-authored sample bank.

It does **not** extract PDFs or call an LLM (those are later phases). You
author `bank.ir.json` by hand (or generate it offline) and run the CLI.

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
pnpm examify-ingest validate content/subjects
pnpm examify-ingest emit content/subjects --dry-run
pnpm examify-ingest emit content/subjects --apply
pnpm examify-ingest emit content/subjects --apply --replace-sample
```

`validate` and `emit` accept a subjects directory (scans `*/bank.ir.json`) or
one or more explicit IR file paths.

`emit` is **dry-run by default**. It prints a diff against the files already on
disk (or `would create`). Pass `--apply` to write.

`--replace-sample` is required if any IR id collides with an id already in the
hand-authored sample bank (`SAMPLE_QUESTIONS`). Additive subjects are the
default; do not clobber sample ids unless you intend to replace them and update
any unit tests that reference them.

`emit` **merges** `content/generated/subjects.json` by subject id: this run
upserts its subjects and leaves other generated subjects (and their
`questions/` + `keys/` files) in place. It does not delete files for subjects
that disappeared from the IR set. When `src/lib/exam/generated-public.ts` and
`generated-keys.server.ts` already exist, `--apply` rewrites those registrars
from the merged catalog.

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

```
content/generated/subjects.json
content/generated/questions/<subjectId>.json
content/generated/keys/<subjectId>.json
```

Public question JSON never includes answers, rubrics, scores, or provenance.
Keys are server-only: the app imports them from
`src/lib/exam/generated-keys.server.ts` (`import 'server-only'`). Do not import
`content/generated/keys/` from client code.

Generated files are meant to be committed. Source PDFs stay in the gitignored
`content/source-pdfs/` directory.

After `emit --apply` of a **new** subject, register its public questions in
`src/lib/exam/generated-public.ts` and its keys in
`src/lib/exam/generated-keys.server.ts` (one import each). The committed
biology sample is already wired.

## Library

```ts
import { splitIr, validateIrCollection, FIXTURE_IDS } from 'examify-ingest';
```
