# Result Status Evidence Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop treating the mere presence of tool-result text as proof of success, while preserving an explicit, inspectable status-evidence contract at the Claude and Codex parser boundaries.

**Architecture:** Add an optional migration-period `status_evidence` field beside the existing scalar `ToolResultEvent.status`. Each parser determines evidence once using `explicit_status > exit_code > tool_adapter > output_pattern > none`, then projects `status` from that evidence. This PR implements explicit, exit-code, adapter, and no-evidence paths only; generic output-pattern inference and R002/R008 consumption remain separate follow-up PRs.

**Tech Stack:** TypeScript 5.9, Node.js 20 test runner, existing Claude/Codex JSONL parsers

---

## Scope, semantic impact, and budget

Exactly six files may change:

- Modify: `src/core/model.ts`
- Modify: `src/sources/claude/parser.ts`
- Modify: `src/sources/codex/parser.ts`
- Modify: `test/claude-parser.test.ts`
- Modify: `test/codex-parser.test.ts`
- Add: `docs/superpowers/plans/2026-08-03-result-status-adapters.md`

Added implementation and test code must stay at or below 285 lines, with 300 as a hard stop. Do not modify ReportV2, Store, R002, R008, the command classifier, package metadata, version, or changelog.

`ts-rename-helper` is unavailable. TypeScript LanguageService semantic references were checked instead: `ToolResultStatus` has 11 references across 4 source files, `ToolResultEvent` has 39 references, `ToolResultEvent.status` has 35 references across 12 files, and `ToolResultEvent.exit_code` has 16 references across 8 files. Claude's ingestion/classification helpers and Codex's resolved-output helpers are private to their parser files; no public parser signature changes.

`status_evidence` is optional only during migration. Making it required now would force five unrelated hand-built event test files into this PR and exceed the six-file boundary. Both production parsers must always populate it, with `event.status === event.status_evidence.status`.

## Edge cases fixed before implementation

- Claude plain text such as `Error: connection refused`, `Tests failed`, `Build aborted`, ordinary output, and empty text has `unknown / none / low`; text is never success evidence by itself.
- A recognized text-only or empty result remains a known schema: preserve its output, normal event confidence, and absence of `unknown_tool_result` warnings.
- Only opaque/unrecognized result shapes retain the existing low event confidence and warning behavior.
- Explicit status/boolean flags outrank finite-integer exit codes; the observed exit code is retained even when it conflicts with explicit status.
- Equal-priority contradictory signals do not optimistically choose success; they resolve to unknown evidence.
- Claude's known shell result protocol (`interrupted: false`) and documented lifecycle states may provide medium-confidence adapter evidence, without making arbitrary strings successful.
- Codex structured `metadata.exit_code` is high-confidence exit-code evidence.
- A canonical line-leading Codex runner banner is medium-confidence tool-adapter evidence; a quoted/mid-output banner is not evidence.
- Codex metadata outranks a conflicting runner banner.
- String, decimal, infinite, or otherwise malformed exit codes are ignored.
- Truncated or metadata-less output does not gain generic pattern evidence in this PR.
- The `output_pattern` source is part of the shared contract but is intentionally unused until the follow-up classifier PR can guard truncated output.
- Parser ordering and repeated parsing remain deterministic.

### Task 1: Specify the evidence contract and parser behavior with RED tests

**Files:**
- Modify: `src/core/model.ts`
- Modify: `test/claude-parser.test.ts`
- Modify: `test/codex-parser.test.ts`

- [x] Add `ResultStatusSource` and `ResultStatusEvidence`; add optional `ToolResultEvent.status_evidence` without changing existing scalar fields.
- [x] Update Claude parser assertions so every emitted result carries evidence matching scalar status.
- [x] Add focused Claude cases for explicit/exit/adapter precedence, error-looking and ordinary text, empty content, malformed exits, and contradictory equal-priority signals.
- [x] Update Codex parser assertions for structured metadata, canonical runner banners, no evidence, malformed metadata, mid-output quoted banners, and metadata/banner conflicts.
- [x] Have a validation subagent run focused parser tests under Node 20 and record RED failures attributable to the parser implementation.

### Task 2: Produce ResultStatusEvidence at the Claude boundary

**Files:**
- Modify: `src/sources/claude/parser.ts`
- Test: `test/claude-parser.test.ts`

- [x] Separate result-schema recognition from status-evidence recognition so text-only known results do not emit schema warnings.
- [x] Collect explicit, exit-code, and Claude-adapter candidates independently across visible and supplemental result blocks.
- [x] Select evidence by priority; resolve equal-priority conflicts safely; retain a separately observed exit code.
- [x] Remove the legacy fallback that promoted any recognized output string to success.
- [x] Emit `status_evidence` on every result and derive scalar `status` from it.
- [x] Have a validation subagent rerun focused Claude parser tests and confirm GREEN.

### Task 3: Produce ResultStatusEvidence at the Codex boundary

**Files:**
- Modify: `src/sources/codex/parser.ts`
- Test: `test/codex-parser.test.ts`

- [x] Accept only finite integer structured exit codes.
- [x] Distinguish structured metadata (`exit_code / high`) from the canonical Codex runner banner (`tool_adapter / medium`).
- [x] Preserve metadata precedence and keep generic/mid-output text at `unknown / none / low`.
- [x] Emit `status_evidence` on every result and derive scalar `status` from it.
- [x] Have a validation subagent rerun focused Codex parser tests and confirm GREEN.

### Task 4: Review, verify, and deliver through worktree PR flow

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-result-status-adapters.md` (checkboxes only after evidence exists)

- [x] Run independent specification review, then independent code-quality review. Resolve and re-review only problems introduced in these six files.
- [x] Have a separate validation subagent run Node 20 `npm ci`, `npm run check`, focused Claude/Codex tests, determinism, build, and package smoke.
- [x] Run the repository's local GitHub Actions equivalent before push because parser logic changes.
- [x] Confirm exactly six changed files, at most 285 added implementation+test lines, parser status/evidence equality, and no ReportV2/Store/R002/R008/classifier/package/version/changelog diff.
- [ ] Commit without amend, rebase on current `origin/main` if required, push, open a PR against `main`, wait for all checks and actionable review feedback, then merge under the user's standing authorization.
- [ ] After merged-commit verification, clean up only this worktree and its local feature branch.
