# Generated exam content (committed layer)

These files are the **committed** generated layer: produced by
`examify-ingest emit content/subjects --apply` from the checkout's
`content/subjects/*/bank.ir.json`, and meant to be committed. Family content
(what `/onboarding` writes) never lands here: it lives in the family data
folder, `$EXAMIFY_DATA_DIR/content/generated/` (default `data/content/generated/`).

| File                  | Ships to the browser? | Holds                              |
| --------------------- | --------------------- | ---------------------------------- |
| `subjects.json`       | yes                   | Additive subject metadata          |
| `questions/<id>.json` | yes                   | Public questions only              |
| `keys/<id>.json`      | **no**                | Answer index / rubric / provenance |

Never import `keys/` from client components. The app reads this layer through
the registrars (`src/lib/exam/generated-public.ts` /
`generated-keys.server.ts`), which the same committed-layer emit rewrites, so it
ships with the build: a change here needs a rebuild. The family layer is read
at request time (`src/lib/exam/live-bank.server.ts`); a family subject with the
same id replaces the committed one. Keys stay server-only.

A partial emit (any explicit IR file path, or mixed file+directory argv)
upserts `subjects.json` by subject id and only rewrites this run's
`questions/` + `keys/` files. Emitting only subjects directories (typically
`content/subjects`) is the authoritative generated catalog: leftover
`questions/<id>.json` / `keys/<id>.json` (and the `subjects.json` row) for an
id with no matching `bank.ir.json` are deleted. An empty subjects tree is
refused and never wipes these files. The sample bank is never touched.

Do not edit these files by hand — change the BankIR source and re-emit.
`examify-ingest generate` never writes this directory; only
`emit content/subjects --apply` does. The running app never writes here.
See `tools/examify-ingest/README.md`.
