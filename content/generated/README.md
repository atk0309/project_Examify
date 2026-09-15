# Generated exam content

These files are produced by `examify-ingest emit --apply` from
`content/subjects/*/bank.ir.json`. They are meant to be committed.

| File                  | Ships to the browser? | Holds                              |
| --------------------- | --------------------- | ---------------------------------- |
| `subjects.json`       | yes                   | Additive subject metadata          |
| `questions/<id>.json` | yes                   | Public questions only              |
| `keys/<id>.json`      | **no**                | Answer index / rubric / provenance |

Never import `keys/` from client components. The running app reads these
JSON files at request time (`src/lib/exam/live-bank.server.ts`). Registrars
(`generated-public.ts` / `generated-keys.server.ts`) are a committed fallback
when `subjects.json` is missing. Keys stay server-only.

A partial emit (any explicit IR file path, or mixed file+directory argv)
upserts `subjects.json` by subject id and only rewrites this run's
`questions/` + `keys/` files. Emitting only subjects directories (typically
`content/subjects`) is the authoritative generated catalog: leftover
`questions/<id>.json` / `keys/<id>.json` (and the `subjects.json` row) for an
id with no matching `bank.ir.json` are deleted. An empty subjects tree is
refused and never wipes these files. The sample bank is never touched.

Do not edit these files by hand — change the BankIR source and re-emit.
See `tools/examify-ingest/README.md`.
