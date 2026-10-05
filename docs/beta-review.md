# First beta review

Reviewed 2026-10-05 against upstream main [`59d505ee7008a92c9896e67eeacd6d204e8399b3`](https://github.com/atk0309/project_Examify/commit/59d505ee7008a92c9896e67eeacd6d204e8399b3).
The inventory below describes that upstream baseline. The local changes and validation
are recorded separately under Changes in this branch.

Examify has a substantial, tested foundation for a small personal-study beta. The remaining release work is concentrated in candidate verification, real-provider evidence, accessibility and clearer first-run guidance. There are **127 pull requests: 88 merged, 33 closed without merge, six open**; the **four actual issues are all open**. GitHub's ten open records therefore mean four issues plus six PRs. [No published releases](https://github.com/atk0309/project_Examify/releases) exist at review time.

## What is already implemented

- Personal study is the default local experience. The packaged sample has five fixed multiple-choice questions, deterministic local scoring and no AI/network requirement. Optional household sharing keeps its own authenticated, invite-only flows. [#117](https://github.com/atk0309/project_Examify/pull/117)
- Repeatable authoring supports subjects, materials, optional AI, generation, review and explicit Apply. The author can inspect questions and answers before applying; that privileged preview is separate from ordinary student data. [#125](https://github.com/atk0309/project_Examify/pull/125)
- Submitted work persists before provider calls. Retry marking reuses the same attempt, pending answers are excluded from provisional scores, leases prevent stale workers from replacing newer results, and password resets revoke existing sessions. [#113](https://github.com/atk0309/project_Examify/pull/113)
- Study data and configuration live separately from application releases. Protocol-1 upgrades copy and verify private state before migration, retain matched old application/state generations and switch one activation pointer. [#99](https://github.com/atk0309/project_Examify/pull/99), [#122](https://github.com/atk0309/project_Examify/pull/122)
- Windows/Linux x64 packaging includes a pinned runtime, archive checksums, source/lockfile identity and retained license notices. Native acceptance covers ordinary-user Windows execution, local download arrangements, packaged browser flows and interruption/recovery. These are previews, not a released consumer support promise. [#123](https://github.com/atk0309/project_Examify/pull/123)
- Install, maintenance, recovery and safe support guidance already exist. The main README can be shorter by directing people to those focused guides. [#124](https://github.com/atk0309/project_Examify/pull/124)

The [main CI run](https://github.com/atk0309/project_Examify/actions/runs/37116297138) passed for the reviewed main SHA. Historical green runs establish those source revisions, not the success of any new local changes or a future final candidate.

## Beta priorities

| Order | Work                                                                                                                                                    | Completion evidence                                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Finish the shortest first-run path: download/install → sample → saved result → reopen; keep optional AI and household setup behind the relevant choice. | README and packaged instructions agree with the actual UI; a new user follows them without knowing Node, pnpm, environment variables or BankIR.                                  |
| 2     | Review and incorporate the useful keyboard/focus work from #126.                                                                                        | Code review plus exact final-source CI; real keyboard, 200% zoom and screen-reader observations recorded separately.                                                             |
| 3     | Repair #127's package license evidence before deciding dependency updates. Keep Next and its lint configuration aligned.                                | Exact-version upstream notices/provenance verified; full combined dependency tree and both native packages pass. A standard CI badge alone misses the current packaging failure. |
| 4     | Freeze one version and source commit, build and preserve the complete matched candidate set.                                                            | #119's final artifact hashes, source/build identity, current security triage and exact-candidate CI/native links.                                                                |
| 5     | Complete upgrade evidence, including unfinished exams.                                                                                                  | #118's two independently built versioned packages on each platform, retained drafts/results/banks/material/settings and explicit refusal without mutation.                       |
| 6     | Validate a small real-provider matrix or narrow the beta's claims.                                                                                      | #120's synthetic PDF/UTF-8 notes, recorded provider/model/platform/candidate and manual grounding/scoring checks.                                                                |
| 7     | Finish consumer-machine and launch checks before announcement.                                                                                          | #119/#121's actual browser/shortcut, downloaded/offline installation, tested OS/browser baseline, signed-in vulnerability form and unsigned-distribution decision.               |

Avoid expanding the beta to macOS/ARM, bundled models, automatic updating or more deployment providers. The current issues already define a bounded Windows/Linux x64 release.

## Reconciled issues

| Issue                                                                                                                                 | Upstream state              | Implemented                                                                                                                                                             | Evidence still missing                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#118 — Make solo upgrades recoverable without losing study data](https://github.com/atk0309/project_Examify/issues/118)              | Open; first-release blocker | #122 private state copy/verification, migration-before-activation, matched rollback, interruption recovery; #124 full-folder maintenance guidance.                      | Independently built old/new packages on Windows and Linux; explicit unfinished-exam resume across upgrade; linked evidence for incompatible/newer and household-data refusal without mutation.                                                    |
| [#119 — Prepare and verify the first Windows/Linux release candidate](https://github.com/atk0309/project_Examify/issues/119)          | Open; first-release blocker | #123 version-pinned distribution/identity/notices, independent inspection, real local-mirror download and native acceptance; later #124/#125 improved help and preview. | One frozen final source/version and preserved matched artifacts; consumer OS/browser/shortcut/download warnings, real HTTPS/CDN/offline checks, current security/native triage, final private-data/notices inspection and signing/trust decision. |
| [#120 — Validate real-provider PDF and notes authoring before release claims](https://github.com/atk0309/project_Examify/issues/120)  | Open; release verification  | No-provider sample and offline fixture generate/review/Apply/study, repeated authoring and persistence; guarded preview in #125.                                        | Real-provider/model PDF and notes evidence with approved synthetic material/account/budget; grounding/scoring and rejected-key/model/timeout/rate-limit/missing-tool behavior. The fixture is not a real model.                                   |
| [#121 — Align first-release help and launch material with solo-first behavior](https://github.com/atk0309/project_Examify/issues/121) | Open; user readiness        | #124 installation, stop/reopen, data/config paths, backup/recovery/uninstall and safe troubleshooting/support; #125 preview help.                                       | Released-version/support baseline from #119, signed-in private vulnerability-form check, actual 200% zoom/assistive-technology checks and refreshed version-pinned launch assets. #126 remains draft/unmerged.                                    |

The issues are already updated with verified progress from 2026-10-03; their open state is justified. Merging implementation PRs does not finish the remaining evidence requirements.

### Exact limits of the current evidence

- **Upgrade fixture:** [`tests/desktop/upgrade-acceptance.mjs`](../tests/desktop/upgrade-acceptance.mjs) selects one native archive, extracts it repeatedly and rewrites its version as `0.1.0`/`0.2.0`, adding a real SQL migration to the latter. It proves migration and recovery behavior; it does not prove compatibility between two independently built releases. Its browser setup completes three exams before upgrade and does not explicitly seed/resume an unfinished one.
- **Consumer support:** [`desktop-preview.yml`](../.github/workflows/desktop-preview.yml) runs Ubuntu 22.04 and Windows Server 2022. Those runner names are not a tested minimum consumer baseline. Browser-opening callbacks and automation without shortcut creation do not prove the actual shortcut/browser/reputation experience.
- **Artifact retention:** preview artifacts last seven days; manually versioned candidates last 90 days. Neither is permanent download hosting. [Release procedure](release-candidate.md)
- **Provider quality:** the OpenAI strict-schema/ID improvements in [#114](https://github.com/atk0309/project_Examify/pull/114)/[#115](https://github.com/atk0309/project_Examify/pull/115) address invalid-output failures; the new native-PDF path and model quality still lack the final live-provider evidence required by #120.
- **Accessibility:** #126's exact head `c6d44f67af36c41c20c94d6bbdd11164370877b1` passed [standard CI](https://github.com/atk0309/project_Examify/actions/runs/37135168706) with 1,570 unit and 32 Chromium E2E tests, and [both native jobs](https://github.com/atk0309/project_Examify/actions/runs/37135168708). Reflow assertions are not actual 200% browser zoom or assistive-technology verification.

## Open PR decisions

| PR                                                                                         | Current result                                                                                                                                                                                                                                                                                        | Recommended disposition                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#126 — Keyboard, focus and contrast](https://github.com/atk0309/project_Examify/pull/126) | Draft; exact-head standard/native CI green. CodeRabbit skipped the draft; that notice is not an approval.                                                                                                                                                                                             | Review the existing patch and use it as the starting point for beta accessibility work; retain manual-check limits.                                           |
| [#127 — Next 16.3.8](https://github.com/atk0309/project_Examify/pull/127)                  | [Standard CI passes](https://github.com/atk0309/project_Examify/actions/runs/37276343082); [both native packages fail](https://github.com/atk0309/project_Examify/actions/runs/37276343083) during notice retention. Error: `Missing exact-version supplemental notice for @next/env 16.3.8: dotenv.` | Extend verified exact-version notice provenance; rerun packaging. Do not weaken the notice gate or treat this failure as evidence of a shipped vulnerability. |
| [#128 — Resend 6.32.0](https://github.com/atk0309/project_Examify/pull/128)                | [Standard CI](https://github.com/atk0309/project_Examify/actions/runs/37276391788) and [native](https://github.com/atk0309/project_Examify/actions/runs/37276391804) pass individually.                                                                                                               | Routine review; validate the final combined dependency graph.                                                                                                 |
| [#129 — Vitest 5.0.3](https://github.com/atk0309/project_Examify/pull/129)                 | [Standard CI](https://github.com/atk0309/project_Examify/actions/runs/37276428714) and [native](https://github.com/atk0309/project_Examify/actions/runs/37276428783) pass individually.                                                                                                               | Routine review; validate the final combined dependency graph.                                                                                                 |
| [#130 — eslint-config-next 16.3.8](https://github.com/atk0309/project_Examify/pull/130)    | [Standard CI](https://github.com/atk0309/project_Examify/actions/runs/37276477456) and [native](https://github.com/atk0309/project_Examify/actions/runs/37276477452) pass individually.                                                                                                               | Keep aligned with the chosen Next version; validate combined updates.                                                                                         |
| [#131 — Node types and tsx](https://github.com/atk0309/project_Examify/pull/131)           | [Standard CI](https://github.com/atk0309/project_Examify/actions/runs/37276528794) and [native](https://github.com/atk0309/project_Examify/actions/runs/37276528827) pass individually.                                                                                                               | Routine review; validate the final combined dependency graph.                                                                                                 |

The dependency PRs are fresh 2026-10-05 maintenance, not stale open feature work. None of these six PRs is in the reviewed main snapshot.

## Historical reconciliation

- #23/#24/#26/#27/#28/#30 were deliberately consolidated into merged #33. Reopening them would repeat completed dependency work.
- #73–#77 were deliberately consolidated into merged #78; later #79–#86 fix dogfood and wizard regressions.
- #42's conflicted rebase led to closure; the recreated SQLite change merged as #54. #50 is included in #47; #51 is included in #52.
- #21 deliberately deferred TypeScript 7 after historical lint and Next build incompatibilities. That is a recorded tooling decision, not an unmerged feature blocker. Reconsider only with new compatibility evidence.
- #59 closed without merge; its discussion supplies no closure rationale. The current focused installation/configuration/architecture guides cover the relevant flows, so its closed status alone is not evidence of a missing auth implementation.
- Older reviewer comments must be checked against final code and later PRs. For example, #104's written-only exception wording was subsequently fixed by #105, and #113 changed unmarked scoring to provisional/pending. Current `onboarding-types.ts` and `install.sh` explicitly describe the exception.
- Skipped/disabled automated-review comments occur across many historical PRs. They do not establish either review approval or a current defect. This review distinguishes discussion findings, recorded fixes and current release evidence.

## Refactoring direction

Preserve the security and durability boundaries while removing user-visible choices and repeated implementation. Focus refactoring around behavior that is difficult to reason about or change:

- `OnboardingWizard.tsx` is 2,340 lines, `ExamApp.tsx` 1,456 and `onboarding.ts` 1,374 at this baseline. They combine several distinct screens/operations. Extract coherent screens or state transitions when touching them, keep one mutation/Apply path, and avoid a new generic workflow framework.
- `install.sh` mixes source installation, auth/mail/AI discovery, repair and upgrade. Personal users should reach the portable installer path immediately; operator details belong in focused guides. Changes must retain private config permissions, fail-closed validation and honest keep/repair messages.
- `scripts/examify-data.mjs` is 3,366 lines. It protects backup/restore/migration across many failure cases. Reduce duplication by sharing existing pure parsing/validation logic where runtime constraints permit; avoid a broad rewrite immediately before beta.
- Keep the README focused on purpose, current preview status and one getting-started path. Link the existing detailed docs instead of repeating command matrices, authentication modes and release engineering.
- Retain tests for user outcomes and trust boundaries. Historical source-text tests were already replaced in several PRs; do not add checks that only mirror implementation.

File size identifies review hotspots, not proof of a bug. The repo's answer isolation, household ownership, explicit Apply, persistence-before-provider-call and matched upgrade state are maturity assets; simplification must preserve them.

## Changes in this branch

These changes are local to `codex/beta-simplicity`; the upstream PR and issue states
above are unchanged.

- Reduced the README by about 55%, gave personal study a three-step starting path,
  and moved detailed navigation into [the guide index](README.md).
- Combined the wizard's separate validation screen and review request into one
  **Review questions** action. It validates the draft and loads the existing
  protected preview; explicit approval, hash-bound Apply and stale-response guards remain.
  AI descriptions now explain the user's choice instead of implementation details.
- Linux's portable installer automatically uses its exact version-pinned sibling
  archive. `--archive` still takes precedence; checksum verification and HTTPS
  fallback remain. The installation guide now uses `bash install-solo.sh`.
- Browser opening reports safe errors and detaches from long-lived openers after
  a bounded wait. The launcher prints simple startup progress without exposing
  session capabilities or private data. Early crash handling and liveness checks
  prevent reporting readiness if the server stops while the browser is opening.
- Removing a household member increments their session version inside the removal
  transaction. Reinviting them cannot revive an old cookie; their study data stays.
  Regressions cover both parent/student sessions and transaction rollback.
- Removed confirmed unused helpers, types and configuration, plus the unused
  `clsx` and `tailwind-merge` dependencies. The manifest and lockfile changes remove
  only those dependencies and their orphan entries; remaining pins are unchanged.

### Simplicity audit

The first pass changed production code by **+4 lines** and did not complete a
repository-wide complexity audit. The follow-up used Ponytail's
[audit](https://github.com/dietrichgebert/ponytail/blob/8cc7bec71144263511e2d087893c2271bd3f6b30/skills/ponytail-audit/SKILL.md)
and [refactoring rules](https://github.com/dietrichgebert/ponytail/blob/8cc7bec71144263511e2d087893c2271bd3f6b30/skills/ponytail/SKILL.md)
across application UI/server code, ingestion, packaging and CSS. Deletion findings
were checked against source, tests, documentation and dynamic/string references.

Applied findings, ranked by net reduction from that first pass:

1. **reuse / yagni:** shared wizard navigation and provider-key controls; removed
   two forwarding components. `OnboardingWizard.tsx`, `EnvKeyPanel.tsx`: **−119**.
2. **delete:** obsolete auth/legacy selectors, unused lookups, types, metadata and
   class-name helper; retained active validation and SQLite boundaries: **−97**.
3. **reuse:** one CAPTCHA script component and one field-error component across
   sign-in, invite and setup forms: **−84**.
4. **shrink / delete:** one validated preview builder for regular and prune-only
   drafts; removed the retired standalone validation action and identity getter:
   **−70**.
5. **reuse / native / delete:** shared rasterization lifecycle, native timeout,
   direct generation input/public projection and unused ingest helpers: **−58**.
6. **reuse / stdlib / delete:** existing digest/copy list, Node delay and removal
   of an unused restore-links CLI: **−23**.
7. **delete:** unused CSS tokens and overridden rules: **−12**.

**Net: −463 additional production lines, −2 dependencies.** Against the original
checkout, production code is **459 lines smaller**, including new shared components
and the earlier reliability fixes. Production counts include `src/`, `scripts/`,
`tools/` and the changed installer. Test, documentation and lockfile lines are separate.

Kept the custom argv parser: native parsing needed compatibility adapters that
cancelled the simplification. Kept bootstrap/worker/data-tool isolation, filesystem
checks and distinct provider protocols. All 241 remaining CSS classes have source
references. This audit establishes concrete reductions, not optimal performance or
completed release validation.

The standalone installer, launcher, wizard and membership tests were updated for
these behaviors. Full validation is still required before merging or releasing.
The pinned pnpm and application dependencies are unavailable offline here, and
the sandbox rejects local server listeners and some subprocess operations.
This does not change the release gates for #118–#121 or import any open PR.

### Validation of the local changes

- **Passed:** four browser-opener subprocess tests on supported Node 22.23.2;
  syntax checks for changed JavaScript and Bash; installer help/source-template
  refusal; all 93 relative Markdown link targets; `git diff --check`.
- **Partial desktop run:** 98 passed, 20 failed, six cancelled and eight platform
  skips across the dependency-free desktop tests. Failures/cancellations are
  blocked by `spawnSync ... EPERM` or loopback `listen EPERM`; the six new installer
  cases and the server-exits-during-browser-opening regression were not exercised.
- **Limited tooling checks:** six changed TS/TSX files have no syntax errors using
  cached TypeScript 5.9.3 in the first pass; all 36 changed TS/TSX files parse in the
  final follow-up. The follow-up also semantically compiled
  the complete ingest source and selected changed application helpers with cached
  TypeScript 5.9.3, Node types 24.13.4 and Zod 4.4.3. Changed files pass cached
  Prettier 3.9.6 with repository
  options but without its unavailable Tailwind plugin. These are not the pinned
  TypeScript 6.0.3/Prettier 3.9.9 typecheck and format gates.
- **Focused runtime checks:** 132 tests passed across eight UI/helper suites,
  and 16 relevant ingest cases passed (74 unrelated cases deselected). React and
  ReactDOM 19.3.0, Testing Library 16.3.3 and the React plugin 6.1.1 match repository
  pins; Vitest 4.1.11, jsdom 30.0.1, jest-dom 6.10.0 and Zod 4.4.3 are cached
  alternatives. Existing action mocks and isolated Next/server boundaries support
  UI checks, not framework or authentication integration. Additional focused
  packaging checks passed 15 tests with one Windows-only skip. Before/after source
  comparisons also cover auth-form render trees, exam construction and retained
  auth helpers; those checks supplement the repository tests.
- **Preview equivalence:** ten before/after source checks passed on Node 22.23.2,
  covering regular/prune-only/error previews, secret redaction, exact hashes,
  confined draft reads and Apply guards. Validator, planner, writer and root
  admission boundaries are isolated; full server integration remains untested.
- **Lockfile consistency:** diagnostic pnpm 10.34.5 accepts the current manifests
  and lockfile in frozen offline mode, then stops at the missing native dependency.
  This ran against byte-identical copies under `/tmp` without rewriting them;
  it does not establish a completed installation or pnpm 10.33.0 validation.
- **Not run:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm format:check` and `pnpm test:e2e` with their pinned dependencies, membership
  and full onboarding database integration, and a disposable real installation
  through first login. pnpm 10.33.0 is uncached; the first-pass diagnostic frozen
  offline install confirmed the original lockfile matched its manifests but stopped
  at missing `better-sqlite3@13.0.3`. Network access cannot retrieve the missing
  packages here. The two unused dependency removals were checked precisely against
  the original manifests/lockfile; the new lock has not been regenerated.

One lower-priority UX finding remains: per-subject progress summaries use the
latest 50 attempts without naming that window (`src/lib/progress.ts`,
`src/components/exam/ProgressView.tsx`). Clarify that scope or compute lifetime
statistics in a later focused change.

## Complete PR inventory

**Merged** means integrated into the reviewed upstream main; old dependency versions may since have been replaced. **Closed unmerged** records deliberate consolidation, replacement or deferred work and is distinct from the six PRs still open.

| PR                                                          | Title                                                                                                         | Upstream disposition                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [#1](https://github.com/atk0309/project_Examify/pull/1)     | chore(deps)(deps): bump next from 16.2.7 to 16.2.9 in the next-runtime group across 1 directory               | Merged                                                                                                                   |
| [#2](https://github.com/atk0309/project_Examify/pull/2)     | chore(deps)(deps-dev): bump the lint-format group with 2 updates                                              | Merged                                                                                                                   |
| [#3](https://github.com/atk0309/project_Examify/pull/3)     | chore(deps)(deps-dev): bump @types/node from 25.9.1 to 25.9.3 in the types-and-utils group                    | Merged                                                                                                                   |
| [#4](https://github.com/atk0309/project_Examify/pull/4)     | Repair pnpm-lock.yaml after concurrent grouped Dependabot merges                                              | Merged                                                                                                                   |
| [#5](https://github.com/atk0309/project_Examify/pull/5)     | Harden CI: least-privilege token permissions + pinned third-party action                                      | Merged                                                                                                                   |
| [#6](https://github.com/atk0309/project_Examify/pull/6)     | Use plain-word markers in the e2e console-noise filter (closes CodeQL alert #3)                               | Merged                                                                                                                   |
| [#7](https://github.com/atk0309/project_Examify/pull/7)     | chore(actions): bump actions/download-artifact from 7 to 8 in the actions group                               | Merged                                                                                                                   |
| [#8](https://github.com/atk0309/project_Examify/pull/8)     | chore(deps)(deps-dev): bump the tailwind group with 2 updates                                                 | Merged                                                                                                                   |
| [#9](https://github.com/atk0309/project_Examify/pull/9)     | chore(deps)(deps): bump better-sqlite3 from 12.10.0 to 12.10.1 in the drizzle group                           | Merged                                                                                                                   |
| [#10](https://github.com/atk0309/project_Examify/pull/10)   | Patch dev-tooling security advisories via pnpm overrides                                                      | Merged                                                                                                                   |
| [#11](https://github.com/atk0309/project_Examify/pull/11)   | chore(actions): bump the actions group with 2 updates                                                         | Merged                                                                                                                   |
| [#12](https://github.com/atk0309/project_Examify/pull/12)   | chore(deps)(deps): bump better-sqlite3 from 12.10.1 to 12.11.1 in the drizzle group                           | Merged                                                                                                                   |
| [#13](https://github.com/atk0309/project_Examify/pull/13)   | chore(deps)(deps): bump resend from 6.12.4 to 6.14.0 in the auth group                                        | Merged                                                                                                                   |
| [#14](https://github.com/atk0309/project_Examify/pull/14)   | chore(deps)(deps-dev): bump the testing group with 2 updates                                                  | Closed unmerged; replaced by dependency maintenance.                                                                     |
| [#15](https://github.com/atk0309/project_Examify/pull/15)   | chore(deps)(deps-dev): bump lint-staged from 17.0.7 to 17.0.8 in the lint-format group                        | Closed unmerged; replaced by dependency maintenance.                                                                     |
| [#16](https://github.com/atk0309/project_Examify/pull/16)   | chore(deps)(deps-dev): bump @types/node from 25.9.3 to 26.0.0 in the types-and-utils group                    | Closed unmerged; replaced by later Node type updates.                                                                    |
| [#17](https://github.com/atk0309/project_Examify/pull/17)   | chore(deps)(deps-dev): bump the testing group across 1 directory with 3 updates                               | Merged                                                                                                                   |
| [#18](https://github.com/atk0309/project_Examify/pull/18)   | chore(deps)(deps-dev): bump the lint-format group across 1 directory with 2 updates                           | Closed unmerged; replaced by dependency maintenance.                                                                     |
| [#19](https://github.com/atk0309/project_Examify/pull/19)   | chore(deps)(deps-dev): bump the types-and-utils group across 1 directory with 2 updates                       | Closed unmerged; replaced by dependency maintenance.                                                                     |
| [#20](https://github.com/atk0309/project_Examify/pull/20)   | chore(deps)(deps-dev): bump the lint-format group across 1 directory with 3 updates                           | Closed unmerged; replaced by dependency maintenance.                                                                     |
| [#21](https://github.com/atk0309/project_Examify/pull/21)   | chore(deps)(deps-dev): bump the types-and-utils group across 1 directory with 3 updates                       | Closed unmerged; TypeScript 7 deliberately deferred after lint/build incompatibility.                                    |
| [#22](https://github.com/atk0309/project_Examify/pull/22)   | chore(deps)(deps-dev): bump the lint-format group across 1 directory with 4 updates                           | Merged                                                                                                                   |
| [#23](https://github.com/atk0309/project_Examify/pull/23)   | chore(deps)(deps-dev): bump the types-and-utils group across 1 directory with 2 updates                       | Closed unmerged; consolidated into #33.                                                                                  |
| [#24](https://github.com/atk0309/project_Examify/pull/24)   | chore(actions): bump actions/setup-node from 6 to 7 in the actions group                                      | Closed unmerged; consolidated into #33.                                                                                  |
| [#25](https://github.com/atk0309/project_Examify/pull/25)   | chore(deps)(deps): bump next from 16.2.9 to 16.2.10 in the next-runtime group                                 | Closed unmerged; replaced by later Next updates.                                                                         |
| [#26](https://github.com/atk0309/project_Examify/pull/26)   | chore(deps)(deps-dev): bump the tailwind group with 3 updates                                                 | Closed unmerged; consolidated into #33.                                                                                  |
| [#27](https://github.com/atk0309/project_Examify/pull/27)   | chore(deps)(deps): bump resend from 6.14.0 to 6.18.0 in the auth group across 1 directory                     | Closed unmerged; consolidated into #33.                                                                                  |
| [#28](https://github.com/atk0309/project_Examify/pull/28)   | chore(deps)(deps-dev): bump vitest from 4.1.9 to 4.1.10 in the testing group                                  | Closed unmerged; consolidated into #33.                                                                                  |
| [#29](https://github.com/atk0309/project_Examify/pull/29)   | Harden exam integrity and authentication                                                                      | Merged                                                                                                                   |
| [#30](https://github.com/atk0309/project_Examify/pull/30)   | chore(deps)(deps): bump the next-runtime group across 1 directory with 2 updates                              | Closed unmerged; consolidated into #33.                                                                                  |
| [#31](https://github.com/atk0309/project_Examify/pull/31)   | Remove stale Railway deployment references                                                                    | Merged                                                                                                                   |
| [#32](https://github.com/atk0309/project_Examify/pull/32)   | Complete repository community standards                                                                       | Merged                                                                                                                   |
| [#33](https://github.com/atk0309/project_Examify/pull/33)   | Roll up pending Dependabot updates                                                                            | Merged                                                                                                                   |
| [#34](https://github.com/atk0309/project_Examify/pull/34)   | chore(deps)(deps): bump next from 16.2.11 to 16.2.12 in the next-runtime group                                | Closed unmerged; replaced by later Next updates.                                                                         |
| [#35](https://github.com/atk0309/project_Examify/pull/35)   | chore(deps)(deps): bump better-sqlite3 from 12.11.1 to 13.0.1 in the drizzle group                            | Closed unmerged; replaced by later SQLite updates.                                                                       |
| [#36](https://github.com/atk0309/project_Examify/pull/36)   | chore(deps)(deps-dev): bump the testing group with 4 updates                                                  | Closed unmerged; replaced by dependency maintenance.                                                                     |
| [#37](https://github.com/atk0309/project_Examify/pull/37)   | chore(deps)(deps-dev): bump the lint-format group across 1 directory with 3 updates                           | Merged                                                                                                                   |
| [#38](https://github.com/atk0309/project_Examify/pull/38)   | chore(deps)(deps-dev): bump postcss from 8.5.15 to 8.5.23                                                     | Merged                                                                                                                   |
| [#39](https://github.com/atk0309/project_Examify/pull/39)   | chore(deps)(deps-dev): bump postcss from 8.5.15 to 8.5.18                                                     | Closed unmerged; dependency already up to date.                                                                          |
| [#40](https://github.com/atk0309/project_Examify/pull/40)   | chore(deps)(deps): bump the next-runtime group across 1 directory with 3 updates                              | Merged                                                                                                                   |
| [#41](https://github.com/atk0309/project_Examify/pull/41)   | chore(actions): bump pnpm/action-setup from 6.0.9 to 6.0.10 in the actions group                              | Merged                                                                                                                   |
| [#42](https://github.com/atk0309/project_Examify/pull/42)   | chore(deps)(deps): bump the drizzle group across 1 directory with 2 updates                                   | Closed unmerged after conflicted rebase; recreated and merged as #54.                                                    |
| [#43](https://github.com/atk0309/project_Examify/pull/43)   | chore(deps)(deps-dev): bump the testing group across 1 directory with 5 updates                               | Closed unmerged; replaced by dependency maintenance.                                                                     |
| [#44](https://github.com/atk0309/project_Examify/pull/44)   | chore(deps)(deps): bump next from 16.3.2 to 16.3.3 in the next-runtime group across 1 directory               | Closed unmerged; replaced by later Next updates.                                                                         |
| [#45](https://github.com/atk0309/project_Examify/pull/45)   | chore(deps)(deps): bump resend from 6.18.0 to 6.25.0 in the auth group across 1 directory                     | Closed unmerged; replaced by later Resend updates.                                                                       |
| [#46](https://github.com/atk0309/project_Examify/pull/46)   | chore(deps)(deps-dev): bump postcss from 8.5.23 to 8.5.28                                                     | Merged                                                                                                                   |
| [#47](https://github.com/atk0309/project_Examify/pull/47)   | chore(deps)(deps-dev): bump the testing group across 1 directory with 6 updates                               | Merged                                                                                                                   |
| [#48](https://github.com/atk0309/project_Examify/pull/48)   | chore(deps)(deps): bump the auth group across 1 directory with 2 updates                                      | Merged                                                                                                                   |
| [#49](https://github.com/atk0309/project_Examify/pull/49)   | chore(deps)(deps): bump the next-runtime group across 1 directory with 2 updates                              | Closed unmerged; replaced by dependency maintenance.                                                                     |
| [#50](https://github.com/atk0309/project_Examify/pull/50)   | chore(deps)(deps-dev): bump vitest from 4.1.10 to 4.1.11                                                      | Closed unmerged; included in merged #47.                                                                                 |
| [#51](https://github.com/atk0309/project_Examify/pull/51)   | chore(deps)(deps): bump next from 16.3.2 to 16.3.3                                                            | Closed unmerged; included in merged #52.                                                                                 |
| [#52](https://github.com/atk0309/project_Examify/pull/52)   | chore(deps)(deps): bump the next-runtime group across 1 directory with 5 updates                              | Merged                                                                                                                   |
| [#53](https://github.com/atk0309/project_Examify/pull/53)   | chore: raise Node engines floor to 22.22.2                                                                    | Merged                                                                                                                   |
| [#54](https://github.com/atk0309/project_Examify/pull/54)   | chore(deps): bump better-sqlite3 to 13.0.3                                                                    | Merged                                                                                                                   |
| [#55](https://github.com/atk0309/project_Examify/pull/55)   | chore(security): pin transitive overrides to exact patched versions                                           | Merged                                                                                                                   |
| [#56](https://github.com/atk0309/project_Examify/pull/56)   | Invite-only households and optional Turnstile                                                                 | Merged                                                                                                                   |
| [#57](https://github.com/atk0309/project_Examify/pull/57)   | Add Cloud Agent dev environment setup (.cursor/environment.json + scripts)                                    | Merged                                                                                                                   |
| [#58](https://github.com/atk0309/project_Examify/pull/58)   | Auth-mode picker (password / magic-link / local OTP) and install.sh                                           | Merged                                                                                                                   |
| [#59](https://github.com/atk0309/project_Examify/pull/59)   | Document authentication, household, password, and email flows                                                 | Closed unmerged; no recorded closure rationale; later guides cover these flows.                                          |
| [#60](https://github.com/atk0309/project_Examify/pull/60)   | Add Phase 0 examify-ingest BankIR CLI and generated content merge                                             | Merged                                                                                                                   |
| [#61](https://github.com/atk0309/project_Examify/pull/61)   | Harden password-mode invite accept with mailbox OTP                                                           | Merged                                                                                                                   |
| [#62](https://github.com/atk0309/project_Examify/pull/62)   | Delete leftover generated subject JSON on whole-tree emit                                                     | Merged                                                                                                                   |
| [#63](https://github.com/atk0309/project_Examify/pull/63)   | Add admin-only /onboarding content setup wizard                                                               | Merged                                                                                                                   |
| [#64](https://github.com/atk0309/project_Examify/pull/64)   | Add examify-ingest generate (Phase 2 BankIR drafting)                                                         | Merged                                                                                                                   |
| [#65](https://github.com/atk0309/project_Examify/pull/65)   | Add onboarding AI-step generate (Phase 2) without a second apply path                                         | Merged                                                                                                                   |
| [#66](https://github.com/atk0309/project_Examify/pull/66)   | Onboarding wizard UI fidelity pass                                                                            | Merged                                                                                                                   |
| [#67](https://github.com/atk0309/project_Examify/pull/67)   | Harden leftover #61 OTP minors on invite complete                                                             | Merged                                                                                                                   |
| [#68](https://github.com/atk0309/project_Examify/pull/68)   | Harden examify-ingest generate cacheKey and local CMD coverage                                                | Merged                                                                                                                   |
| [#69](https://github.com/atk0309/project_Examify/pull/69)   | Add OpenAI API key write path for onboarding and install.sh                                                   | Merged                                                                                                                   |
| [#70](https://github.com/atk0309/project_Examify/pull/70)   | Onboarding generate cancel stays wizard-side (no ingest AbortSignal)                                          | Merged                                                                                                                   |
| [#71](https://github.com/atk0309/project_Examify/pull/71)   | Add AbortSignal through examify-ingest generate                                                               | Merged                                                                                                                   |
| [#72](https://github.com/atk0309/project_Examify/pull/72)   | Wire wizard generate cancel through ingest AbortSignal                                                        | Merged                                                                                                                   |
| [#73](https://github.com/atk0309/project_Examify/pull/73)   | Fix SetupForm autofill desync on Create household                                                             | Closed unmerged; consolidated into #78.                                                                                  |
| [#74](https://github.com/atk0309/project_Examify/pull/74)   | Fail closed on ingest generate overwrite, SAMPLE ids, and tree leftovers                                      | Closed unmerged; consolidated into #78.                                                                                  |
| [#75](https://github.com/atk0309/project_Examify/pull/75)   | Add Anthropic API key write path for onboarding and install.sh                                                | Closed unmerged; consolidated into #78.                                                                                  |
| [#76](https://github.com/atk0309/project_Examify/pull/76)   | Dogfood install: password invite mail + repo-root migrate                                                     | Closed unmerged; consolidated into #78.                                                                                  |
| [#77](https://github.com/atk0309/project_Examify/pull/77)   | Confirm before wizard generate overwrites existing BankIR                                                     | Closed unmerged; consolidated into #78.                                                                                  |
| [#78](https://github.com/atk0309/project_Examify/pull/78)   | Consolidate dogfood drafts #73–#77                                                                            | Merged                                                                                                                   |
| [#79](https://github.com/atk0309/project_Examify/pull/79)   | Fix install keep-broken honesty and SetupForm remount recover                                                 | Merged                                                                                                                   |
| [#80](https://github.com/atk0309/project_Examify/pull/80)   | Treat empty BankIR as missing for generate overwrite                                                          | Merged                                                                                                                   |
| [#81](https://github.com/atk0309/project_Examify/pull/81)   | Wizard majors: sources copy, prune HITL, Ready names, empty IR, sentinel Clear                                | Merged                                                                                                                   |
| [#82](https://github.com/atk0309/project_Examify/pull/82)   | Stop freezing BankIR validate count against live content/subjects                                             | Merged                                                                                                                   |
| [#83](https://github.com/atk0309/project_Examify/pull/83)   | Wizard polish S8–S10: footer clearance, Files tab, generate chip                                              | Merged                                                                                                                   |
| [#84](https://github.com/atk0309/project_Examify/pull/84)   | Close leftover #67 magic-link send-fail hygiene                                                               | Merged                                                                                                                   |
| [#85](https://github.com/atk0309/project_Examify/pull/85)   | Assert singular validate banner for one BankIR file                                                           | Merged                                                                                                                   |
| [#86](https://github.com/atk0309/project_Examify/pull/86)   | Harden S8 proof: AI Save/Rotate/Clear stay above sticky footer                                                | Merged                                                                                                                   |
| [#87](https://github.com/atk0309/project_Examify/pull/87)   | chore(actions): bump pnpm/action-setup from 6.0.10 to 6.1.0 in the actions group                              | Merged                                                                                                                   |
| [#88](https://github.com/atk0309/project_Examify/pull/88)   | chore(deps)(deps): bump next from 16.3.4 to 16.3.5 in the next-runtime group across 1 directory               | Merged                                                                                                                   |
| [#89](https://github.com/atk0309/project_Examify/pull/89)   | chore(deps)(deps): bump resend from 6.27.0 to 6.28.1 in the auth group across 1 directory                     | Merged                                                                                                                   |
| [#90](https://github.com/atk0309/project_Examify/pull/90)   | chore(deps)(deps-dev): bump the testing group with 2 updates                                                  | Merged                                                                                                                   |
| [#91](https://github.com/atk0309/project_Examify/pull/91)   | chore(deps)(deps-dev): bump the lint-format group across 1 directory with 3 updates                           | Merged                                                                                                                   |
| [#92](https://github.com/atk0309/project_Examify/pull/92)   | chore(deps)(deps): bump the types-and-utils group across 1 directory with 4 updates                           | Merged                                                                                                                   |
| [#93](https://github.com/atk0309/project_Examify/pull/93)   | fix(auth): password sign-in and invite autofill stay submittable                                              | Merged                                                                                                                   |
| [#94](https://github.com/atk0309/project_Examify/pull/94)   | Polish password sign-in, invite confirm, and mailbox reset                                                    | Merged                                                                                                                   |
| [#95](https://github.com/atk0309/project_Examify/pull/95)   | Lock /setup confirm-password gates and remount holds                                                          | Merged                                                                                                                   |
| [#96](https://github.com/atk0309/project_Examify/pull/96)   | Name the real mail transport on the password-invite code step                                                 | Merged                                                                                                                   |
| [#97](https://github.com/atk0309/project_Examify/pull/97)   | Harden grading, sessions, rate limits and credential forms; add password-mode exam e2e                        | Merged                                                                                                                   |
| [#98](https://github.com/atk0309/project_Examify/pull/98)   | Keep exams alive through failed submits; name onboarding generate failures, fix batch cancel and upload names | Merged                                                                                                                   |
| [#99](https://github.com/atk0309/project_Examify/pull/99)   | Family data folder: the app never writes inside the checkout; upgrade, backup and restore                     | Merged                                                                                                                   |
| [#100](https://github.com/atk0309/project_Examify/pull/100) | Build banks with Claude Code or Codex; split and fix the local AI modes                                       | Merged                                                                                                                   |
| [#101](https://github.com/atk0309/project_Examify/pull/101) | Mark written answers with the household's own AI                                                              | Merged                                                                                                                   |
| [#102](https://github.com/atk0309/project_Examify/pull/102) | Installer finds Claude Code, Codex and Ollama and picks the household's AI                                    | Merged                                                                                                                   |
| [#103](https://github.com/atk0309/project_Examify/pull/103) | Local endpoint banks work with LM Studio; comparison fits a phone                                             | Merged                                                                                                                   |
| [#104](https://github.com/atk0309/project_Examify/pull/104) | Exams leave out written questions nothing can mark, and say who marks them                                    | Merged                                                                                                                   |
| [#105](https://github.com/atk0309/project_Examify/pull/105) | Ask Claude Code / Codex whether they are signed in before exams keep written questions                        | Merged                                                                                                                   |
| [#106](https://github.com/atk0309/project_Examify/pull/106) | chore(deps)(deps): bump next from 16.3.5 to 16.3.6 in the next-runtime group                                  | Merged                                                                                                                   |
| [#107](https://github.com/atk0309/project_Examify/pull/107) | chore(deps)(deps): bump the drizzle group across 1 directory with 2 updates                                   | Merged                                                                                                                   |
| [#108](https://github.com/atk0309/project_Examify/pull/108) | chore(deps)(deps): bump resend from 6.28.1 to 6.30.0 in the auth group across 1 directory                     | Merged                                                                                                                   |
| [#109](https://github.com/atk0309/project_Examify/pull/109) | chore(deps)(deps-dev): bump jsdom from 30.1.0 to 30.1.1 in the testing group                                  | Closed unmerged; later testing-group update #111 covers jsdom.                                                           |
| [#110](https://github.com/atk0309/project_Examify/pull/110) | chore(deps)(deps-dev): bump the lint-format group with 2 updates                                              | Closed unmerged; later lint/format update #112 covers these dependencies.                                                |
| [#111](https://github.com/atk0309/project_Examify/pull/111) | chore(deps)(deps-dev): bump the testing group across 1 directory with 2 updates                               | Merged                                                                                                                   |
| [#112](https://github.com/atk0309/project_Examify/pull/112) | chore(deps)(deps-dev): bump the lint-format group across 1 directory with 3 updates                           | Merged                                                                                                                   |
| [#113](https://github.com/atk0309/project_Examify/pull/113) | Recover grading, secure sessions, and add ongoing AI settings                                                 | Merged                                                                                                                   |
| [#114](https://github.com/atk0309/project_Examify/pull/114) | Harden OpenAI bank generation with strict schema and safe diagnostics                                         | Merged                                                                                                                   |
| [#115](https://github.com/atk0309/project_Examify/pull/115) | Bind OpenAI question IDs to requested subject and difficulty                                                  | Merged                                                                                                                   |
| [#116](https://github.com/atk0309/project_Examify/pull/116) | Clarify Student View and return-to-parent navigation                                                          | Merged                                                                                                                   |
| [#117](https://github.com/atk0309/project_Examify/pull/117) | Preview: solo-first study with guarded Windows/Linux launchers                                                | Merged                                                                                                                   |
| [#122](https://github.com/atk0309/project_Examify/pull/122) | Add isolated portable upgrades with matched-state recovery                                                    | Merged                                                                                                                   |
| [#123](https://github.com/atk0309/project_Examify/pull/123) | Prepare verified portable release assets without unused native image optimization                             | Merged                                                                                                                   |
| [#124](https://github.com/atk0309/project_Examify/pull/124) | Clarify solo preview installation and first practice                                                          | Merged                                                                                                                   |
| [#125](https://github.com/atk0309/project_Examify/pull/125) | Add guarded author question preview to onboarding review                                                      | Merged                                                                                                                   |
| [#126](https://github.com/atk0309/project_Examify/pull/126) | Polish keyboard navigation, focus and text contrast                                                           | Open draft; keyboard/focus/contrast changes absent from main. Exact-head standard/native CI green; manual checks remain. |
| [#127](https://github.com/atk0309/project_Examify/pull/127) | chore(deps)(deps): bump next from 16.3.6 to 16.3.8 in the next-runtime group                                  | Open; standard CI green, both native packages fail: missing @next/env 16.3.8 dotenv notice.                              |
| [#128](https://github.com/atk0309/project_Examify/pull/128) | chore(deps)(deps): bump resend from 6.30.0 to 6.32.0 in the auth group                                        | Open; Resend update. Standard/native CI green individually; not on main.                                                 |
| [#129](https://github.com/atk0309/project_Examify/pull/129) | chore(deps)(deps-dev): bump vitest from 5.0.2 to 5.0.3 in the testing group                                   | Open; Vitest update. Standard/native CI green individually; not on main.                                                 |
| [#130](https://github.com/atk0309/project_Examify/pull/130) | chore(deps)(deps-dev): bump eslint-config-next from 16.3.6 to 16.3.8 in the lint-format group                 | Open; eslint-config-next update. Standard/native CI green individually; not on main.                                     |
| [#131](https://github.com/atk0309/project_Examify/pull/131) | chore(deps)(deps-dev): bump the types-and-utils group with 2 updates                                          | Open; Node types/tsx update. Standard/native CI green individually; not on main.                                         |

## Review method

Fetched all pages of [issues](https://api.github.com/repos/atk0309/project_Examify/issues?state=all&per_page=100&page=1) and [PRs](https://api.github.com/repos/atk0309/project_Examify/pulls?state=all&per_page=100&page=1), including closed/merged records; the third page of each was empty. Reconciled titles, bodies, merge state and combined discussion/review timelines for all 127 PRs. The four issue bodies carry their current acceptance evidence and had zero comments. Checked current release/workflow state and #127's failing native job log, then corroborated key claims against the verified main snapshot. No issues, PRs, releases or other external records were changed.
