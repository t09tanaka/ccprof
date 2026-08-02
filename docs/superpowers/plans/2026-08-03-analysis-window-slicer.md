# Analysis Window Event Slicer Implementation Plan

> **Goal:** Ensure every downstream metric and finding is derived only from events inside the frozen AnalysisWindow, without inventing evidence for tools that cross a boundary.

## Scope

- Add one pure, authoritative Session slicer immediately after discovery.
- Keep both AnalysisWindow endpoints inclusive.
- Recompute retained Session bounds and conservatively retain an in-window verified end.
- Prevent tool-use/result pairing across agent lanes.
- Degrade tool actions without a uniquely observed in-window result to unexplained/low-confidence/zero-duration evidence.
- Tighten action-to-event lookup so ambiguous cross-segment candidates become unknown.
- Add a metamorphic integration test proving out-of-window high-impact events do not alter analysis outputs.
- Leave Hook Stop ownership for the next PR.
- Do not change package versions or release metadata.

## Files

- `src/analysis/window.ts`
- `src/core/analyze.ts`
- `src/analysis/timeline.ts`
- `src/analysis/diff-matcher.ts`
- `test/analysis-window.test.ts`
- `test/timeline.test.ts`
- `test/analyze-integration.test.ts`
- this plan

## Frozen semantics

- Retain only events satisfying `started_at_ms <= timestamp_ms <= ended_at_ms`.
- Do not create synthetic events or clip a tool interval to either boundary.
- Apply the same predicate to every agent while preserving Session identity.
- Remove Sessions with no retained events.
- Set Session `started_at_ms` and `ended_at_ms` from retained event timestamps.
- Retain `verified_ended_at_ms` only when it is a safe integer inside the window and no earlier than the last retained event; when retained, it may extend `ended_at_ms`.
- Never mutate input Session/Event objects.
- Re-run the existing no-matching-session guard after slicing.

## Task 1: Pure Session slicer

- [x] Add `sliceSessionsToAnalysisWindow(sessions, window)` in `src/analysis/window.ts`.
- [x] Keep exact start/end boundary events and reject invalid/outside timestamps.
- [x] Recompute bounds, remove empty Sessions, and preserve eligible verified ends.
- [x] Return fresh Session/event-array containers without mutating inputs.
- [x] Add focused unit tests for two agents, both boundaries, out-of-order events, empty removal, verified ends, and input immutability.

## Task 2: Authoritative analyze placement

- [x] Invoke the slicer immediately after `SessionSource.discover`, before warnings, hooks, capability checks, timeline, rules, ledger, costs, and read observations.
- [x] Preserve source error precedence when discovery returns nothing.
- [x] Throw `NoMatchingSessionsError` when discovery returned Sessions but slicing removes all events.

## Task 3: Agent-safe tool correlation

- [x] Include the agent lane in timeline tool-use/result correlation keys.
- [x] Include source/agent lane context in duplicate event identity where locally available.
- [x] Require action/event timestamp and session-ref agreement, and accept only a unique candidate, when reconstructing observations.
- [x] Add timeline tests proving identical tool IDs in two agents pair independently and boundary-crossing halves do not pair.

## Task 4: Unknown completion semantics

- [x] Make every tool action without a uniquely observed in-window result `unexplained` with low confidence and an explicit completion caveat.
- [x] Do not classify an unfinished edit from final-diff path/fragment evidence.
- [x] Treat its mutation scope conservatively for later evidence without inventing an elapsed interval.
- [x] Add a matcher or integration assertion showing an end-crossing edit/run cannot become contributing, redundant, or successful evidence.

## Task 5: Metamorphic integration proof

- [x] Analyze one fixed snapshot with only in-window events.
- [x] Analyze the same snapshot after adding pre-start and post-end command, large result, compaction, edit, and correction events.
- [x] Assert identical report, findings, ledger, command costs, and read observations.
- [x] Assert the returned window is unchanged and every retained evidence interval stays inside it.

## Task 6: Verification and delivery

- [x] Confirm TypeScript LanguageService impact for touched private signatures and unchanged shared contracts.
- [x] Run focused slicer/timeline/integration tests in a dedicated subagent.
- [x] Run the full repository check and local GitHub Actions equivalent in an independent subagent.
- [x] Confirm `git diff --check`, at most 8 changed files, and fewer than 300 added source/test lines.
- [x] Confirm package/version files are unchanged.
- [ ] Commit, push, create the PR, complete CI/review, and merge.
