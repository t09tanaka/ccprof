# Result Status Evidence Consumer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make command classification, R002 successful-run snapshots, and R008 failure-to-success episodes consume provenance-aware result status so unknown or truncated evidence is never promoted to success.

**Architecture:** Make optional `ResultStatusEvidence` authoritative whenever present, while retaining scalar status only for evidence-less migration callers. A `none` evidence source may fall through to an observed exit code or strong command-aware pattern but never to the scalar compatibility mirror; patterns require positively complete UTF-8 output. Classification carries the same status/source/confidence vocabulary plus its existing segment-attribution `definite` flag. Claude conflicts retain their originating source so a lower-priority exit code or output pattern cannot overwrite an explicit conflict.

**Tech Stack:** TypeScript 5.9, Node.js 20 test runner, existing deterministic command/R002/R008 analysis

---

## Scope, semantic impact, and budget

Exactly eight files may change:

- Modify: `src/analysis/command.ts`
- Modify: `src/analysis/diff-matcher.ts`
- Modify: `src/rules/flaky-test.ts`
- Modify: `src/sources/claude/parser.ts`
- Modify: `test/command-and-matcher.test.ts`
- Modify: `test/rules-secondary.test.ts`
- Modify: `test/claude-parser.test.ts`
- Add: `docs/superpowers/plans/2026-08-03-result-status-consumers.md`

Added implementation and test code must stay at or below 285 lines, with 300 as a hard stop. Do not modify the shared model, Codex parser, timeline, Report/Store schema, other rules, package metadata, version, or changelog.

`ts-rename-helper` is unavailable. TypeScript LanguageService semantic references were checked instead: `CommandResultSignal` has 3 references internal to `command.ts`; `CommandResultClassification` has 5 references; `classifyCommandResult` has 17 references across `command.ts`, `diff-matcher.ts`, `flaky-test.ts`, and `command-and-matcher.test.ts`; `ToolResultEvent.status_evidence` has 11 current references but no production consumer; `ToolResultEvent.status` has 40 references across 12 files; and `ToolResultEvent.output_bytes` has 17 references across 11 files. The two production classifier callers and their private helpers are closed inside `diff-matcher.ts` and `flaky-test.ts`.

`ToolResultEvent.status` remains an optional-migration compatibility projection. Production parsers always populate `status_evidence`, which takes precedence even when its source is `none`; only evidence-less legacy/custom `SessionSource` callers may use scalar status before exit-code or complete-pattern fallback.

## Edge cases fixed before implementation

- Explicit, exit-code, adapter, and precomputed output-pattern evidence retains its status, source, and confidence and outranks lower-priority raw fields.
- Conflicting Claude explicit signals remain `unknown / explicit_status / low`; exit-code and adapter conflicts likewise retain their originating source, preventing fall-through.
- `none / unknown` evidence never trusts the compatibility scalar status; a valid observed exit code may still classify because it is independent high-confidence evidence.
- Evidence-less legacy/custom session events retain scalar success/failure/timeout/cancelled compatibility as explicit high-confidence status, while scalar `unknown` may fall through to exit code or a complete pattern.
- Arbitrary complete text remains unknown; only existing strong command-aware timeout/cancel/failure/success patterns may produce `output_pattern / medium`.
- Pattern inference requires `outputBytes === Buffer.byteLength(output)`. Missing, smaller, larger, negative, fractional, or unsafe byte counts are not proof of completeness.
- A precomputed `output_pattern` evidence value is also rejected when completeness is not positively established.
- UTF-8 multibyte output uses byte length, not JavaScript character length.
- Opaque commands never gain output-pattern status.
- Pipes, `;`, and `||` still discard segment-level success/failure attribution; all-`&&` retains definite success but not definite failure.
- When evidence is present, R002 never seeds a successful-run snapshot from the scalar mirror, unknown/conflicting evidence, or a truncated success pattern; evidence-less migration callers retain scalar compatibility.
- Read deduplication follows the same rule: present evidence or exit code governs the result, while only evidence-less migration callers may use scalar success.
- R008 never accepts unknown/conflicting/truncated results as failure or success endpoints; valid evidence and complete patterns retain existing episode behavior.
- Legacy stored findings and Store schema are unaffected because normalized events are not persisted in `AnalysisRecord`.
- Classification remains deterministic under repeated calls and input order changes.

### Task 1: Specify conflict provenance and evidence-aware classification with RED tests

**Files:**
- Modify: `test/claude-parser.test.ts`
- Modify: `test/command-and-matcher.test.ts`
- Modify: `test/rules-secondary.test.ts`

- [x] Require Claude explicit/exit conflicts to retain the originating evidence source while staying unknown/low.
- [x] Add a compact classifier table for evidence priority, evidence-backed scalar rejection, evidence-less scalar compatibility, exit fallback, arbitrary text, complete patterns, malformed byte counts, UTF-8 completeness, and truncated precomputed pattern evidence.
- [x] Preserve composite-command attribution assertions using the new source/confidence contract.
- [x] Add a three-run R002 test proving unknown/truncated results do not seed snapshots and only a valid result enables a later redundant run.
- [x] Add focused R008 cases proving unknown/conflicting/truncated endpoints produce no finding while valid endpoints still do.
- [x] Have a validation subagent run focused Claude, command/R002, and R008 tests under Node 20 and record RED failures attributable to unimplemented consumers.

### Task 2: Migrate the classifier and R002/read consumers

**Files:**
- Modify: `src/analysis/command.ts`
- Modify: `src/analysis/diff-matcher.ts`
- Test: `test/command-and-matcher.test.ts`

- [x] Add optional `statusEvidence`, `exitCode`, `output`, and `outputBytes` signal fields while retaining scalar status only for evidence-less migration callers.
- [x] Make `CommandResultClassification` carry `ResultStatusEvidence` plus `definite`.
- [x] Preserve non-`none` evidence, use exit code next, and derive medium-confidence output-pattern evidence only from positively complete output.
- [x] Keep timeout/cancelled and composite-command `definite` behavior conservative.
- [x] Pass evidence and original byte count from `ToolResultEvent` in R002 run classification.
- [x] Make read-success snapshots prefer present evidence/exit code and use scalar compatibility only for evidence-less migration callers.
- [x] Have a validation subagent rerun focused command/R002 tests and confirm GREEN.

### Task 3: Migrate R008 and preserve Claude conflict provenance

**Files:**
- Modify: `src/rules/flaky-test.ts`
- Modify: `src/sources/claude/parser.ts`
- Test: `test/rules-secondary.test.ts`
- Test: `test/claude-parser.test.ts`

- [x] Pass evidence and original byte count into R008 classification so only definite failure/success endpoints form episodes.
- [x] Keep exact CommandIdentity grouping, mutation guards, failed-test extraction, history, and finding keys unchanged.
- [x] Emit source-specific unknown/low evidence for conflicting Claude explicit, exit, or adapter signals.
- [x] Have a validation subagent rerun focused Claude/R008 tests and confirm GREEN.

### Task 4: Review, verify, and deliver through worktree PR flow

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-result-status-consumers.md` (checkboxes only after evidence exists)

- [x] Run independent specification review, then independent code-quality review. Resolve and re-review only problems introduced in these eight files.
- [x] Have a separate validation subagent run Node 20 `npm ci`, `npm run check`, focused suites, determinism, build, and isolated package smoke.
- [x] Run the repository's local GitHub Actions equivalent before push because analysis logic changes.
- [x] Confirm exactly eight changed files, at most 285 added implementation+test lines, and no shared model/Codex/timeline/Report/Store/other-rule/package/version/changelog diff.
- [ ] Commit without amend, confirm the branch is based on current `origin/main`, push, open a PR against `main`, and wait for all checks plus absence of actionable feedback. Merge remains a post-gate action under the user's standing authorization.
- [ ] After merged-commit verification, clean up only this worktree and its local/remote feature branch.
