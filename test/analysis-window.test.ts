import assert from "node:assert/strict";
import test from "node:test";

import {
  analyze,
  InvalidAnalysisWindowError,
  resolveAnalysisWindow,
  type AnalyzeWarning,
} from "../src/core/analyze.js";
import type { CommandRunner } from "../src/git/client.js";
import type { PrContext } from "../src/git/pr-context.js";
import { sliceSessionsToAnalysisWindow } from "../src/analysis/window.js";
import type { AnalysisWindow, GenuineUserEvent, Session } from "../src/core/model.js";

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
  assert.deepEqual(resolveAnalysisWindow(
    context({ branchReflogStartedAtMs: 650 }),
    { sinceMs: 700 },
  ), {
    started_at_ms: 700,
    ended_at_ms: 1_000,
    start_source: "explicit",
    end_source: "analysis_time",
    completeness: "complete",
  });
});

test("an explicit start disables branch reflog probing", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return { code: 0, stdout: "/repo\n", stderr: "" };
    if (args[0] === "rev-parse") {
      const oid = (args.at(-1)?.startsWith("main") === true ? "a" : "b").repeat(40);
      return { code: 0, stdout: `${oid}\n`, stderr: "" };
    }
    if (args[0] === "merge-base")
      return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    if (args[0] === "log") return { code: 0, stdout: "1\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "unavailable" };
  };
  const stop = new Error("stop after discovery");

  await assert.rejects(analyze({
    cwd: "/repo",
    pr: "main...feature",
    sinceMs: 700,
    nowMs: 1_000,
    runner,
    sessionSource: { discover: async () => { throw stop; } },
  }), (error) => error === stop);
  assert.equal(calls.some((args) => args.includes("refs/heads/feature^{commit}")), false);
  assert.equal(calls.some((args) => args[0] === "reflog"), false);
});

test("a valid branch reflog start precedes the commit-anchor fallback", () => {
  assert.deepEqual(
    resolveAnalysisWindow(context({ branchReflogStartedAtMs: 350 })),
    {
      started_at_ms: 350,
      ended_at_ms: 1_000,
      start_source: "branch_reflog",
      end_source: "analysis_time",
      completeness: "partial",
    },
  );
});

test("untrusted branch reflog starts warn and use the commit fallback", () => {
  const cases = [
    [1_001, "invalid_branch_reflog_start", "The branch reflog start followed analysis resolution; the commit anchor fallback was used."],
    [401, "branch_reflog_after_commit_anchor", "The branch reflog start followed the earliest unique commit; the commit anchor fallback was used."],
  ] as const;
  for (const [startedAtMs, code, message] of cases) {
    const warnings: AnalyzeWarning[] = [];
    assert.equal(resolveAnalysisWindow(
      context({ branchReflogStartedAtMs: startedAtMs }), {}, warnings,
    ).started_at_ms, 400);
    assert.deepEqual(warnings, [{ code, message }]);
  }
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
    () => resolveAnalysisWindow(context({ branchReflogStartedAtMs: -1 })),
    () => resolveAnalysisWindow(context({
      branchReflogStartedAtMs: Number.MAX_SAFE_INTEGER + 1,
    })),
  ];
  for (const resolve of invalid) {
    assert.throws(resolve, InvalidAnalysisWindowError);
  }
});

test("slices sessions immutably with inclusive bounds and verified ends", () => {
  const event = (id: string, timestamp_ms: number, agent_id: string): GenuineUserEvent => ({
    kind: "genuine_user", timestamp_ms, session_id: "s", entry_uuid: id,
    session_ref: `s#${id}`, source_index: Number(id.replace(/\D/gu, "")) || 0,
    agent_id, is_sidechain: agent_id !== "main", confidence: "high", text: id,
  });
  const make = (id: string, events: GenuineUserEvent[], verified?: number): Session => ({
    session_id: id, source: "claude", source_path: `/${id}.jsonl`,
    observed_cwds: ["/repo"], observed_branches: ["feature"],
    started_at_ms: -1, ended_at_ms: 99, confidence: "high", events,
    warnings: [], ...(verified === undefined ? {} : { verified_ended_at_ms: verified }),
  });
  const primary = make("primary", [
    event("e20", 20, "side"), event("e9", 9, "main"),
    event("e10", 10, "main"), event("bad", Number.NaN, "main"),
    event("e15", 15, "side"), event("e21", 21, "main"),
  ], 20);
  const extending = make("extending", [event("e12", 12, "main")], 18);
  const invalidVerified = make("invalid", [event("e13", 13, "main")],
    Number.MAX_SAFE_INTEGER + 1);
  const earlyVerified = make("early", [event("e14", 14, "main"), event("e16", 16, "main")], 15);
  const empty = make("empty", [event("e1", 1, "main")]);
  const input = [primary, extending, invalidVerified, earlyVerified, empty];
  const originalEvents = primary.events;
  const originalTimestamps = primary.events.map(({ timestamp_ms }) => timestamp_ms);
  const window: AnalysisWindow = { started_at_ms: 10, ended_at_ms: 20,
    start_source: "explicit", end_source: "analysis_time", completeness: "complete" };

  const sliced = sliceSessionsToAnalysisWindow(input, window);
  assert.deepEqual(sliced.map(({ session_id }) => session_id),
    ["primary", "extending", "invalid", "early"]);
  assert.deepEqual(sliced[0]?.events.map(({ timestamp_ms }) => timestamp_ms), [20, 10, 15]);
  assert.deepEqual([sliced[0]?.started_at_ms, sliced[0]?.ended_at_ms], [10, 20]);
  assert.equal(sliced[1]?.ended_at_ms, 18);
  assert.equal("verified_ended_at_ms" in (sliced[2] ?? {}), false);
  assert.equal("verified_ended_at_ms" in (sliced[3] ?? {}), false);
  assert.notEqual(sliced[0], primary);
  assert.notEqual(sliced[0]?.events, originalEvents);
  assert.deepEqual(primary.events.map(({ timestamp_ms }) => timestamp_ms), originalTimestamps);
  assert.deepEqual([primary.started_at_ms, primary.ended_at_ms], [-1, 99]);
});
