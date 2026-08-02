# Session Branch Transition Analysis Start Plan

> **Goal:** Recover pre-commit branch work from Claude session evidence when neither an explicit start nor a trusted local branch reflog is available.

## Scope

- Add optional session-transition evidence to `resolveAnalysisWindow` without changing existing callers.
- Perform broad, end-frozen discovery only when the provisional source is commit-anchor fallback.
- Derive a conservative transition timestamp from branch-scoped Claude events.
- Decline transition evidence when any configured source failed, because the
  surviving sessions cannot prove that no earlier event existed.
- Re-resolve the final AnalysisWindow once and slice all discovered Sessions to it.
- Preserve explicit/reflog precedence, source error behavior, hook identity scope, and all downstream frozen-window guarantees.
- Do not change package versions or release metadata.

## Files

- `src/core/analyze.ts`
- `test/analysis-window.test.ts`
- `test/analyze-integration.test.ts`
- this plan

## Evidence contract

A session transition candidate must be:

- from a Claude Session;
- an event whose `branch` equals the frozen head branch;
- an event whose `branch_epoch` is a positive safe integer;
- at or before analysis resolution;
- at or before the earliest unique commit when that anchor is available.

The earliest candidate is rejected when any discovered event has an earlier valid timestamp. This prevents a later head→other→head re-entry, or a transition observed after unrelated branchless/Codex work, from cutting off earlier activity. Events at the same timestamp remain included.

## Task 1: Window evidence contract

- [x] Add `AnalysisWindowEvidence` with optional `sessionBranchTransitionAtMs`.
- [x] Add a backward-compatible fourth argument to `resolveAnalysisWindow`.
- [x] Validate supplied transition timestamps as nonnegative safe integers.
- [x] Resolve precedence as explicit, valid reflog, valid session transition, then commit lookback.
- [x] Return `start_source: "session_branch_transition"` with partial completeness.
- [x] Reject transition evidence after resolution or after the earliest commit with a contract warning and fallback.
- [x] Make invalid-reflog warning text neutral so it remains correct when transition evidence wins.

## Task 2: Conservative evidence extraction

- [x] Add a pure helper that examines Claude events by timestamp rather than input order.
- [x] Require frozen head branch and positive `branch_epoch`.
- [x] Ignore epoch zero, Codex-only evidence, missing/invalid epochs, and future timestamps.
- [x] Reject the earliest candidate when any valid event precedes it; allow same-time events.
- [x] Add compact unit tests for multiple Sessions/agents, out-of-order rows, epoch zero, prior branchless/Codex work, re-entry, and same-time inclusion.

## Task 3: Two-phase discovery

- [x] Resolve a provisional window without writing warnings.
- [x] Use a broad start of zero only when provisional source is commit-anchor fallback.
- [x] Keep explicit/reflog discovery on their existing bounded path.
- [x] Derive evidence from the end-frozen discovery result and resolve the final window once into the real warnings list.
- [x] Slice discovered Sessions with the final window before warnings, hooks, timeline, rules, and persistence.
- [x] Preserve `NoMatchingSessionsError` and source-error precedence after final slicing.
- [x] Reject transition evidence after a partial source failure while retaining the actionable source warning.

## Task 4: Integration proof

- [x] Use a real Git repository and a runner that fails only local reflog lookup.
- [x] Provide Claude transition evidence earlier than the first unique commit.
- [x] Prove discovery used start zero and the final window starts at the transition.
- [x] Prove transition-time work remains in the resulting measured analysis.
- [x] Prove valid explicit/reflog paths do not use broad discovery.

## Task 5: Verification and delivery

- [x] Confirm TypeScript LanguageService references for `resolveAnalysisWindow` and unchanged source interfaces.
- [x] Run focused AnalysisWindow/integration tests in a dedicated subagent.
- [x] Run the full repository check and local GitHub Actions equivalent in an independent subagent.
- [x] Confirm `git diff --check`, at most 4 changed files, and fewer than 300 added source/test lines.
- [x] Confirm package/version files are unchanged.
- [x] Commit, push, create the PR, and complete the pre-merge CI/review gate.

Merge and worktree cleanup follow only after this documentation commit also
passes the required remote checks.
