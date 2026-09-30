# Data-only answer review checkpoint (not enabled yet)

This module is prepared and unit-tested. It is not wired into a paid workflow.
No API keys should be configured until the settings integration and full no-key
checkpoint rehearsals pass.

## Proposed flow

1. Install/build without provider secrets. Use the approved immutable product SHA.
2. Start the single recorder on the same disposable runner. Live mode requires both
   user-entered keys, the original absolute expiry, an explicitly marked live
   commit, and run_attempt == 1. Ordinary code/data pushes must not start live work.
3. Generate once, validate/review/apply. Read only the family's public generated
   questions/demo.json file, selecting Easy, plus the original synthetic notes.
   `makeSnapshot` rejects private/unknown fields and binds a public-question hash.
4. Write public-questions.json atomically and signal that it is ready. Pause the
   Playwright process before exam launch; do not stop/restart the app or ledger.
5. Upload only that public snapshot with a standard Actions artifact step. Parent
   downloads it, reasons from public question/options and original source notes,
   and commits answer DATA at demo-recording/answers/<runId>.json. No keys/rubrics
   are read or published. Answer-data commits must be excluded by workflow gates.
6. The existing Playwright process polls that one fixed GitHub raw JSON location
   (no credentials/redirects), for at most ten minutes and never past fixed expiry.
   `parseAnswerPlan` enforces exact run/hash/IDs/types/options and <=800-char written
   responses. It rejects unknown fields. Nothing is evaluated or executed.
7. Continue the same process/session and budget ledger, use the tested admin
   settings route to select Anthropic, then launch the exam. `findAnswer` must match
   each visible question and actual options exactly; unknown/ambiguous questions
   stop the run instead of guessing or regenerating.
8. Grade once and record results/progress. Export only sanitized video, scene
   timings, and provider call/token counters, never traces, HAR, .env, DB, private
   runtime logs, rubrics or key files. Cleanly stop the recorder on any failure.

## Orchestration boundaries

The polling helper runs in the Playwright process, not the Next server whose
provider-only fetch guard intentionally blocks GitHub. A background recorder may
span workflow steps to let the normal upload-artifact action publish its public
checkpoint while it waits. Its code checkout is immutable: never git pull,
checkout another ref, npm-install or dynamically import response data while keys
are active. Only the parsed JSON answer data may change.

Keep the original expiry unchanged on every step/rerun. A new runner resets the
local budget ledger: do not automatically rerun live after any failure. Reconcile
reserved calls and available usage first; user approval is required for further
paid attempts. The approved amount is a ceiling, not a spending target.

## Required rehearsals before live

- Two varied public synthetic papers accepted with their matching source-grounded
  answers, including different wording, item order and MCQ option order
- End-to-end artifact download -> data-only commit -> same-process resume
- Confirm answer-data commit creates no second recording job
- Malformed/stale/oversized/expired plans and missing replies stop cleanly
- Confirm no regeneration, grading retry, or new ledger on resume
- Confirm no secret-like canary in exported files or logs
- Add checkpoint/*.test.mjs to CI alongside the top-level guard tests
- Parent previews final content/pacing and approves the live storyboard

Trim checkpoint waiting from the final video only with an honest caption stating
that answer-review waiting was shortened. Keep its raw timing in the manifest.
