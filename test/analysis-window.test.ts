import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidAnalysisWindowError,
  resolveAnalysisWindow,
  type AnalyzeWarning,
} from "../src/core/analyze.js";
import type { PrContext } from "../src/git/pr-context.js";

function context(overrides: Partial<PrContext> = {}): PrContext {
  return {
    repoRoot: "/repo",
    base: { label: "main", oid: "a".repeat(40) },
    head: { label: "feature", oid: "b".repeat(40) },
    mergeBaseOid: "a".repeat(40),
    prRef: "main...feature",
    headBranch: "feature",
    earliestUniqueCommitAtMs: 400,
    resolvedAtMs: 1_000,
    warnings: [],
    ...overrides,
  };
}

test("createdAtMs is ignored for an otherwise identical snapshot", () => {
  const first = resolveAnalysisWindow(context({ createdAtMs: 1 }));
  const second = resolveAnalysisWindow(context({ createdAtMs: 999 }));

  assert.deepEqual(second, first);
  assert.equal(first.ended_at_ms, 1_000);
});

test("explicit since takes precedence and produces a complete window", () => {
  assert.deepEqual(resolveAnalysisWindow(context(), { sinceMs: 700 }), {
    started_at_ms: 700,
    ended_at_ms: 1_000,
    start_source: "explicit",
    end_source: "analysis_time",
    completeness: "complete",
  });
});

test("commit-anchor lookback is applied and clamped at the Unix epoch", () => {
  assert.deepEqual(
    resolveAnalysisWindow(context(), { commitAnchorLookbackMs: 250 }),
    {
      started_at_ms: 150,
      ended_at_ms: 1_000,
      start_source: "commit_anchor_lookback",
      end_source: "analysis_time",
      completeness: "partial",
    },
  );
  assert.equal(
    resolveAnalysisWindow(
      context({ earliestUniqueCommitAtMs: 50 }),
      { commitAnchorLookbackMs: 100 },
    ).started_at_ms,
    0,
  );
});

test("missing and future commit anchors fall back with contract warnings", () => {
  const missingAnchor = context();
  delete missingAnchor.earliestUniqueCommitAtMs;
  const cases: readonly [PrContext, string, string][] = [
    [
      missingAnchor,
      "pr_start_fallback",
      "The earliest unique commit time was unavailable; session discovery used an unbounded start.",
    ],
    [
      context({ earliestUniqueCommitAtMs: 1_001 }),
      "invalid_pr_window",
      "The commit-derived start followed analysis resolution; session discovery used an unbounded start.",
    ],
  ];

  for (const [value, code, message] of cases) {
    const warnings: AnalyzeWarning[] = [];
    assert.deepEqual(resolveAnalysisWindow(value, {}, warnings), {
      started_at_ms: 0,
      ended_at_ms: 1_000,
      start_source: "commit_anchor_lookback",
      end_source: "analysis_time",
      completeness: "partial",
    });
    assert.deepEqual(warnings, [{ code, message }]);
  }
});

test("an explicit start equal to resolution is valid", () => {
  assert.equal(
    resolveAnalysisWindow(context(), { sinceMs: 1_000 }).started_at_ms,
    1_000,
  );
});

test("invalid supplied analysis-window millisecond values throw", () => {
  const invalid = [
    () => resolveAnalysisWindow(context({ resolvedAtMs: -1 })),
    () => resolveAnalysisWindow(context(), { sinceMs: -1 }),
    () => resolveAnalysisWindow(context(), { sinceMs: 1_001 }),
    () => resolveAnalysisWindow(context(), { commitAnchorLookbackMs: -1 }),
    () => resolveAnalysisWindow(context(), {
      commitAnchorLookbackMs: Number.MAX_SAFE_INTEGER + 1,
    }),
    () => resolveAnalysisWindow(context({ earliestUniqueCommitAtMs: -1 })),
  ];
  for (const resolve of invalid) {
    assert.throws(resolve, InvalidAnalysisWindowError);
  }
});
