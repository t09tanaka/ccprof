# Hook Stop Attribution Implementation Plan

> **Goal:** Extend measured time from a Claude Stop hook only when the target Session and main agent lane are uniquely identifiable inside the frozen AnalysisWindow.

## Scope

- Make `applyHookEvents` reject Codex, cross-source ID collisions, segmented duplicate IDs, multi-branch Sessions, and ambiguous/nonexistent main lanes.
- Make verified timeline tails start from the unique non-sidechain Claude lane, never a sidechain.
- Filter hook rows against both inclusive AnalysisWindow boundaries before attribution.
- Preserve the existing direction check and 30-minute extension cap.
- Do not add warnings or synthetic recovery for ambiguous rows.
- Do not change package versions or release metadata.

## Files

- `src/analysis/hook-events.ts`
- `src/analysis/timeline.ts`
- `src/core/analyze.ts`
- `test/hook-events.test.ts`
- `test/timeline.test.ts`
- `test/analyze-integration.test.ts`
- this plan

## Eligibility contract

A Stop row may set `verified_ended_at_ms` only when all conditions hold:

- the matching Session has `source === "claude"`;
- its `session_id` occurs exactly once across all discovered Sessions and sources;
- it has at most one observed branch;
- its retained events contain exactly one distinct non-sidechain agent;
- the Stop timestamp is later than the Session end and no more than 30 minutes later;
- the caller has already limited the row to the inclusive AnalysisWindow.

The timeline must then use the last retained event of that unique non-sidechain agent as the verified-tail start.

## Task 1: Conservative session attribution

- [x] Count Session IDs across the complete Session collection before applying any rows.
- [x] Reject non-Claude Sessions and every duplicated ID, including Claude/Codex collisions and branch segments.
- [x] Reject Sessions with multiple observed branches.
- [x] Require exactly one distinct non-sidechain agent from retained events.
- [x] Preserve existing max-in-range Stop selection, purity, and unchanged-by-reference behavior for ineligible Sessions.
- [x] Add compact unit tests covering eligible Claude, Codex collision, duplicate segments, multi-branch, sidechain-only, and multiple main agents.

## Task 2: Main-lane verified tail

- [x] Restrict verified tail candidates to Claude Sessions.
- [x] Select only non-sidechain events and require a unique non-sidechain agent per source/session lane.
- [x] Start the tail at that agent's last event even if a sidechain event is later.
- [x] Emit no tail for sidechain-only or multi-main-agent Sessions.
- [x] Replace the obsolete known-limitation comment with the enforced contract.
- [x] Add focused timeline tests for sidechain-last, sidechain-only, multi-main, and Codex verified inputs.

## Task 3: Frozen-window row filtering

- [x] Filter hook rows with `started_at_ms <= received_at_ms <= ended_at_ms` before `applyHookEvents`.
- [x] Keep both exact boundaries inclusive.
- [x] Add an integration test proving a pre-start row cannot affect analysis while exact-end remains accepted.
- [x] Add an integration test proving a same-ID Claude/Codex or segmented collision cannot extend measured time.

## Task 4: Verification and delivery

- [x] Confirm TypeScript LanguageService references and that no shared signature changes are required.
- [x] Run focused hook/timeline/integration tests in a dedicated subagent.
- [x] Run the full repository check and local GitHub Actions equivalent in an independent subagent.
- [x] Confirm `git diff --check`, at most 7 changed files, and fewer than 300 added source/test lines.
- [x] Confirm package/version files are unchanged.
- [x] Commit, push, create the PR, complete CI/review, and merge.
