# Analysis Window Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PR-creation-time truncation with an explicit, auditable analysis-window contract whose end is always the frozen analysis resolution time.

**Architecture:** Add the report-shaped `AnalysisWindow` contract to the shared model, derive it in one pure helper, and map its numeric bounds into the existing `SessionQuery` without changing source adapters. Explicit starts are complete; commit-anchor and unbounded fallbacks are marked partial. CLI parsing and event/lane slicing remain separate PRs.

**Tech Stack:** TypeScript, Node.js test runner.

---

## Scope and edge cases

- Preserve `PrContext.createdAtMs` as metadata, but never use it as an end boundary.
- Keep `SessionQuery` unchanged in this PR.
- Accept `start === end`; reject only an explicit start after the frozen end.
- Validate injected millisecond values as nonnegative safe integers.
- Clamp commit-anchor lookback at Unix epoch.
- If the inferred commit anchor is missing or produces an invalid future start, fall back to start `0`, emit a warning, and mark the window partial.
- Do not add CLI flags, report serialization, reflog/session-transition discovery, or event slicing here.

### Task 1: Define the shared analysis-window contract

**Files:**
- Modify: `src/core/model.ts`

- [x] **Step 1: Add the exact contract**

~~~ts
export interface AnalysisWindow {
  started_at_ms: number;
  ended_at_ms: number;
  start_source:
    | "explicit"
    | "branch_reflog"
    | "session_branch_transition"
    | "commit_anchor_lookback";
  end_source: "explicit" | "analysis_time";
  completeness: "complete" | "partial";
}
~~~

### Task 2: Derive and expose the frozen window

**Files:**
- Modify: `src/core/analyze.ts`

- [x] **Step 1: Extend options and result without breaking callers**

Add optional `sinceMs?: number` and `commitAnchorLookbackMs?: number` to `AnalyzeOptions`. Add required `window: AnalysisWindow` to `AnalyzeResult`.

- [x] **Step 2: Replace `contextWindow` with an exported pure resolver**

Implement `resolveAnalysisWindow(context, options, warnings)` with this behavior:

~~~ts
const endedAtMs = context.resolvedAtMs;
const lookbackMs = options.commitAnchorLookbackMs ?? 0;

if (options.sinceMs !== undefined) {
  if (options.sinceMs > endedAtMs) {
    throw new InvalidAnalysisWindowError(
      "explicit analysis start must not be after analysis resolution",
    );
  }
  return {
    started_at_ms: options.sinceMs,
    ended_at_ms: endedAtMs,
    start_source: "explicit",
    end_source: "analysis_time",
    completeness: "complete",
  };
}

const anchor = context.earliestUniqueCommitAtMs;
if (anchor === undefined) {
  warnings.push({
    code: "pr_start_fallback",
    message:
      "The earliest unique commit time was unavailable; session discovery used an unbounded start.",
  });
  return {
    started_at_ms: 0,
    ended_at_ms: endedAtMs,
    start_source: "commit_anchor_lookback",
    end_source: "analysis_time",
    completeness: "partial",
  };
}

const startedAtMs = Math.max(0, anchor - lookbackMs);
if (startedAtMs > endedAtMs) {
  warnings.push({
    code: "invalid_pr_window",
    message:
      "The commit-derived start followed analysis resolution; session discovery used an unbounded start.",
  });
  return {
    started_at_ms: 0,
    ended_at_ms: endedAtMs,
    start_source: "commit_anchor_lookback",
    end_source: "analysis_time",
    completeness: "partial",
  };
}

return {
  started_at_ms: startedAtMs,
  ended_at_ms: endedAtMs,
  start_source: "commit_anchor_lookback",
  end_source: "analysis_time",
  completeness: "partial",
};
~~~

Validate `resolvedAtMs`, `sinceMs`, `commitAnchorLookbackMs`, and any supplied commit anchor before arithmetic. Define/export `InvalidAnalysisWindowError` for invalid injected values.

- [x] **Step 3: Wire the contract through analysis**

Pass only `window.started_at_ms` and `window.ended_at_ms` to existing source discovery fields `startedAtMs` and `endedAtMs`. Return the same `window` on `AnalyzeResult`. Delete the old `pr_end_fallback` logic and the use of `createdAtMs`.

### Task 3: Add focused regression coverage

**Files:**
- Create: `test/analysis-window.test.ts`
- Modify: `test/analyze-integration.test.ts`

- [x] **Step 1: Unit-test the resolver**

Cover:

- two contexts with identical resolution/commit anchor but different PR creation times yield identical windows;
- end is `resolvedAtMs`;
- explicit `sinceMs` wins and is complete;
- commit lookback is applied and clamped to epoch;
- missing/future commit anchors use start `0`, partial completeness, and the expected warning;
- `sinceMs === resolvedAtMs` is valid;
- future explicit start, negative/unsafe lookback, and invalid resolution throw `InvalidAnalysisWindowError`.

- [x] **Step 2: Assert orchestration returns and passes the same window**

In the existing deterministic integration test, capture the `SessionQuery` through a lightweight wrapping `SessionSource`, then assert:

~~~ts
assert.deepEqual(first.window, {
  started_at_ms: Date.parse(FEATURE_COMMIT_DATE),
  ended_at_ms: NOW_MS,
  start_source: "commit_anchor_lookback",
  end_source: "analysis_time",
  completeness: "partial",
});
assert.equal(capturedQuery?.startedAtMs, first.window.started_at_ms);
assert.equal(capturedQuery?.endedAtMs, first.window.ended_at_ms);
~~~

Use a fresh wrapper for each deterministic rerun so query capture does not add state to the source.

### Task 4: Verify and commit

**Files:**
- Verify the four implementation/test files plus this plan.

- [ ] **Step 1: Run focused and full checks**

Run: `npm run build:test && node --test .test-dist/test/analysis-window.test.js .test-dist/test/analyze-integration.test.js`

Expected: all focused tests pass.

Run: `npm run check`

Expected: typecheck and the complete suite pass.

- [ ] **Step 2: Review scope**

Confirm no CLI, README, source adapter, store, version, or package-lock changes; implementation remains below 300 lines and no more than five files changed.

- [ ] **Step 3: Commit**

Commit as `fix: freeze analysis end at resolution time` with the Codex co-author trailer.
