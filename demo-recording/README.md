# Isolated Examify demo capture

This branch is recording infrastructure, not a proposed product change or deployment.
The current workflow is a **no-key rehearsal**. It installs the real app on a fresh
GitHub runner, loads only the committed synthetic notes, records real browser UI,
and uses the explicitly labelled deterministic test provider and test marking.
There are no response mocks and no real family data. It must not be described as
real AI generation or real AI grading.

The first video chapter shows an excerpt of actual successful installation output.
Installation happened before browser recording; the caption says this explicitly.
The remaining recording shows setup, pack generation, review/apply, exam and progress.
Provider waits may be cut in the final 2–4 minute edit, with cuts labelled.

## Live run, not yet enabled or authorized by this workflow

User enters fresh restricted provider keys directly into GitHub Environment
`examify-demo-ephemeral`, restricted to branch `dot/examify-recording` (ideally with
user approval required). Proposed secret names: `EXAMIFY_DEMO_OPENAI_KEY` and
`EXAMIFY_DEMO_ANTHROPIC_KEY`. Never put key values in workflow inputs, chat, commands,
logs, screenshots or files. The user revokes both provider keys after the run and
removes the GitHub secrets within their 1–2 hour window. GitHub secrets do not
implicitly expire. No agent should enter the values or change security settings.

The reviewed live workflow must inject credentials only in its final recording
step, after dependency install and build. No traces/HAR, env dumps, database,
source manifests or server logs may be uploaded. Never upload entire output folders.
Environment-scoped secrets are not referenced in the current rehearsal workflow.

The demo-only fetch guard reserves atomic request slots across Node processes,
allows only the exact OpenAI/Anthropic endpoints and models, rejects images/tools/
unknown features, caps request JSON at 32 KiB and output at 8192 tokens, and permits
at most eight attempts per provider. HTTP failures count; no retries in Playwright
or fetch. Missing or implausible usage and transport failures halt later request starts; already-reserved in-flight requests remain bounded by the same slots. Provider responses
are genuine and unchanged. This is harness instrumentation; it is not a product
budget feature. It requires integration review before being relied on for a live run.

At standard published rates, the deliberately generous input allowance of
`2 * 32768 + 1024 = 66560` tokens per request yields maximum model charges:

- GPT-4o ($2.50 input / $10 output per million): **$1.98656** for eight requests
- Claude Sonnet 4.6 ($3 input / $15 output per million): **$2.58048** for eight requests

Sources checked 2026-09-30:
https://developers.openai.com/api/docs/pricing
https://openai.com/index/api-prompt-caching/
https://platform.claude.com/docs/en/models/sonnet-4-6/overview

The current script exercises OpenAI in live mode. A second Anthropic pass must be
explicitly selected, retain the same session ledger, and remain within its eight
attempts. Do not reset/retry a paid run without checking the remaining budget.
Live failures must remain visible as failures, not be replaced with fixture output.

This is a known-script cost guard, not an account-wide billing cap or a sandbox
against arbitrary runner code. Each fresh runner creates a fresh ledger. Never
automatically rerun live: reconcile recorded slots/actual provider usage and obtain
a new remaining-budget approval first. No paid retry is authorized by a failed run.
The amounts above assume standard pricing, token-limit compliance, and no other
key usage. Validate these assumptions before enabling live.
