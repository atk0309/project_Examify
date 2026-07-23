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
`answer`/`rubric` property.

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

- **`ANTHROPIC_API_KEY=test`** (the dev/test default) routes to a deterministic
  full-score stub — no network, no key needed for local development or CI.
- **It never throws.** A fetch error, non-2xx, or unparseable model reply resolves to
  `{ status: 'needs_review' }`; the attempt persists with `score: null` and renders as
  "Saved for review" (counted as incorrect, never lost).
- A graded item counts as **correct** when `score / maxScore >= 0.6`
  (`PASS_THRESHOLD` / `isFreePass` in `src/lib/exam/attempts.ts`).
- Items in one exam are graded concurrently, so a mixed paper marks in roughly one
  model round-trip.

## Generating a bank from your own PDFs

There is no automated parser — this is a documented (AI-assisted) workflow, and it is
how the original 13-subject deployment was produced from school study guides:

1. Drop your source PDFs in `content/source-pdfs/`. The directory is **gitignored** —
   source material often can't be redistributed, so it stays local-only; only the
   questions you author from it (with `provenance`) get committed.
2. Ingest **vision-first**: render each page as an image (`pdftoppm -r 200`) and read
   the images as the primary source of truth — study-guide PDFs are usually heavy on
   layout, tables, and diagrams that text extraction mangles. Use `pdftotext -layout`
   (text-layer PDFs) or `tesseract` OCR (scanned PDFs) as a cross-check.
3. Author ~10 questions per subject per difficulty, graded **easy = recall**,
   **medium = apply**, **hard = reason**, with 2–3 free-text items per tier carrying a
   rubric derived from the source material.
4. Keep questions grounded: stay close to what the source actually says (a good rule of
   thumb is ~80% direct grounding, ~20% reasonable application of it), and record each
   item's `provenance { pdf, locator }` as you go.
5. Run `pnpm test` — the guards below catch most authoring mistakes immediately.

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
