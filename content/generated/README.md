# Generated exam content

These files are produced by `examify-ingest emit --apply` from
`content/subjects/*/bank.ir.json`. They are meant to be committed.

| File                  | Ships to the browser? | Holds                              |
| --------------------- | --------------------- | ---------------------------------- |
| `subjects.json`       | yes                   | Additive subject metadata          |
| `questions/<id>.json` | yes                   | Public questions only              |
| `keys/<id>.json`      | **no**                | Answer index / rubric / provenance |

Never import `keys/` from client components. The app loads keys through
`src/lib/exam/generated-keys.server.ts` (`import 'server-only'`).

A partial emit upserts `subjects.json` by subject id and only rewrites this
run's `questions/` + `keys/` files. It does not delete leftover subject JSON.

Do not edit these files by hand — change the BankIR source and re-emit.
See `tools/examify-ingest/README.md`.
