import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTimeline,
  DEFAULT_IDLE_THRESHOLD_MS,
} from "../src/analysis/timeline.js";
import type {
  AssistantEvent,
  CompactionEvent,
  GenuineUserEvent,
  NormalizedEvent,
  Session,
  ToolResultEvent,
  ToolUseEvent,
} from "../src/core/model.js";

function base(
  entryUuid: string,
  timestampMs: number,
  sourceIndex: number,
  agentId = "main",
) {
  return {
    timestamp_ms: timestampMs,
    session_id: "s1",
    entry_uuid: entryUuid,
    session_ref: `s1#${entryUuid}`,
    source_index: sourceIndex,
    agent_id: agentId,
    is_sidechain: agentId !== "main",
    confidence: "high" as const,
  };
}

function user(
  timestampMs: number,
  sourceIndex: number,
  agentId = "main",
): GenuineUserEvent {
  return {
    ...base(`u${sourceIndex}`, timestampMs, sourceIndex, agentId),
    kind: "genuine_user",
    text: "continue",
  };
}

function assistant(
  timestampMs: number,
  sourceIndex: number,
  agentId = "main",
): AssistantEvent {
  return {
    ...base(`a${sourceIndex}`, timestampMs, sourceIndex, agentId),
    kind: "assistant",
    text: "done",
  };
}

function toolUse(
  id: string,
  timestampMs: number,
  sourceIndex: number,
  agentId = "main",
  extra: Partial<ToolUseEvent> = {},
): ToolUseEvent {
  return {
    ...base(`tu${sourceIndex}`, timestampMs, sourceIndex, agentId),
    kind: "tool_use",
    tool_use_id: id,
    tool_name: "Read",
    input: {},
    paths: ["src/a.ts"],
    edit_fragments: [],
    ...extra,
  };
}

function toolResult(
  id: string,
  timestampMs: number,
  sourceIndex: number,
  agentId = "main",
): ToolResultEvent {
  return {
    ...base(`tr${sourceIndex}`, timestampMs, sourceIndex, agentId),
    kind: "tool_result",
    tool_use_id: id,
    status: "success",
    output: "ok",
    output_bytes: 2,
    estimated_tokens: 1,
  };
}

function compaction(
  timestampMs: number,
  sourceIndex: number,
  agentId = "main",
): CompactionEvent {
  return {
    ...base(`c${sourceIndex}`, timestampMs, sourceIndex, agentId),
    kind: "compaction",
    summary: "compacted",
  };
}

function session(
  events: NormalizedEvent[],
  endedAtMs = events.at(-1)?.timestamp_ms ?? 0,
  verifiedEndedAtMs?: number,
): Session {
  const timestamps = events
    .map((event) => event.timestamp_ms)
    .filter(Number.isSafeInteger);
  return {
    session_id: "s1",
    source: "claude",
    source_path: "/tmp/session.jsonl",
    observed_cwds: ["/repo"],
    observed_branches: ["feature"],
    started_at_ms: timestamps.length === 0 ? 0 : Math.min(...timestamps),
    ended_at_ms: endedAtMs,
    confidence: "high",
    events,
    warnings: [],
    ...(verifiedEndedAtMs === undefined
      ? {}
      : { verified_ended_at_ms: verifiedEndedAtMs }),
  };
}

test("pairs a tool use with its matching result", () => {
  const timeline = buildTimeline([
    session([toolUse("t1", 1_000, 0), toolResult("t1", 4_000, 1)]),
  ]);

  assert.deepEqual(timeline.toolIntervals, [
    { start_ms: 1_000, end_ms: 4_000 },
  ]);
  assert.deepEqual(timeline.rawIntervals, timeline.toolIntervals);
  assert.deepEqual(timeline.activeIntervals, timeline.toolIntervals);
  assert.deepEqual(timeline.idleIntervals, []);
  assert.deepEqual(timeline.inferenceIntervals, []);
  assert.deepEqual(timeline.humanWaitIntervals, []);
  assert.deepEqual(
    timeline.actions.map((action) => ({
      kind: action.kind,
      interval: action.interval,
      paths: action.paths,
      concurrent: action.concurrent,
    })),
    [
      {
        kind: "tool",
        interval: { start_ms: 1_000, end_ms: 4_000 },
        paths: ["src/a.ts"],
        concurrent: false,
      },
    ],
  );
});

test("keeps unmatched tool evidence without inventing elapsed time", () => {
  const timeline = buildTimeline([
    session([toolUse("missing", 0, 0), toolResult("orphan", 10, 1)]),
  ]);

  assert.deepEqual(timeline.toolIntervals, []);
  assert.deepEqual(timeline.rawIntervals, [{ start_ms: 0, end_ms: 10 }]);
  const action = timeline.actions.find(
    (candidate) => candidate.tool_use_id === "missing",
  );
  assert.deepEqual(action?.interval, { start_ms: 0, end_ms: 0 });
  assert.equal(action?.confidence, "low");
  assert.ok(timeline.caveats.some((item) => item.includes("missing")));
  assert.ok(timeline.caveats.some((item) => item.includes("orphan")));
});

test("does not turn an unmatched assistant tool use into human wait", () => {
  const timeline = buildTimeline([
    session([
      assistant(0, 0),
      toolUse("missing", 0, 1),
      user(100, 2),
    ]),
  ]);

  assert.deepEqual(timeline.humanWaitIntervals, []);
  assert.equal(
    timeline.actions.some(
      (action) => action.kind === "human_wait" || action.kind === "away",
    ),
    false,
  );
  const action = timeline.actions.find(
    (candidate) => candidate.tool_use_id === "missing",
  );
  assert.deepEqual(action?.interval, { start_ms: 0, end_ms: 0 });
  assert.equal(action?.confidence, "low");
  assert.ok(timeline.caveats.some((item) => item.includes("missing")));
});

test("an unmatched tool use breaks pending inference attribution", () => {
  const timeline = buildTimeline([
    session([
      user(0, 0),
      toolUse("missing", 50, 1),
      assistant(100, 2),
    ]),
  ]);

  assert.deepEqual(timeline.inferenceIntervals, []);
  assert.ok(timeline.caveats.some((item) => item.includes("missing")));
});

test("an unmatched tool result breaks pending human-wait attribution", () => {
  const timeline = buildTimeline([
    session([
      assistant(0, 0),
      toolResult("orphan", 50, 1),
      user(100, 2),
    ]),
  ]);

  assert.deepEqual(timeline.humanWaitIntervals, []);
  assert.equal(
    timeline.actions.some(
      (action) => action.kind === "human_wait" || action.kind === "away",
    ),
    false,
  );
  assert.ok(timeline.caveats.some((item) => item.includes("orphan")));
});

test("an unmatched tool result breaks pending inference attribution", () => {
  const timeline = buildTimeline([
    session([
      user(0, 0),
      toolResult("orphan", 50, 1),
      assistant(100, 2),
    ]),
  ]);

  assert.deepEqual(timeline.inferenceIntervals, []);
  assert.ok(timeline.caveats.some((item) => item.includes("orphan")));
});

test("attributes user/result latency to the next assistant without overlapping a tool", () => {
  const timeline = buildTimeline([
    session([
      user(0, 0),
      assistant(10, 1),
      toolUse("t1", 10, 2),
      toolResult("t1", 30, 3),
      assistant(50, 4),
    ]),
  ]);

  assert.deepEqual(timeline.inferenceIntervals, [
    { start_ms: 0, end_ms: 10 },
    { start_ms: 30, end_ms: 50 },
  ]);
  assert.deepEqual(timeline.toolIntervals, [
    { start_ms: 10, end_ms: 30 },
  ]);
  assert.deepEqual(timeline.humanWaitIntervals, []);
  assert.deepEqual(timeline.rawIntervals, [{ start_ms: 0, end_ms: 50 }]);
});

test("propagates the lowest confidence across action endpoints", () => {
  const mediumResult = {
    ...toolResult("medium", 10, 1),
    confidence: "medium" as const,
  };
  const lowResult = {
    ...toolResult("low", 30, 3),
    confidence: "low" as const,
  };
  const timeline = buildTimeline([
    session([
      toolUse("medium", 0, 0),
      mediumResult,
      toolUse("low", 20, 2),
      lowResult,
    ]),
  ]);

  assert.equal(
    timeline.actions.find((action) => action.tool_use_id === "medium")
      ?.confidence,
    "medium",
  );
  assert.equal(
    timeline.actions.find((action) => action.tool_use_id === "low")?.confidence,
    "low",
  );
});

test("a wait exactly at the threshold stays human wait", () => {
  const timeline = buildTimeline([
    session([
      assistant(0, 0),
      user(DEFAULT_IDLE_THRESHOLD_MS, 1),
    ]),
  ]);

  assert.deepEqual(timeline.humanWaitIntervals, [
    { start_ms: 0, end_ms: DEFAULT_IDLE_THRESHOLD_MS },
  ]);
  assert.deepEqual(timeline.idleIntervals, []);
  assert.deepEqual(timeline.activeIntervals, timeline.rawIntervals);
});

test("a wait one millisecond over the threshold becomes away", () => {
  const end = DEFAULT_IDLE_THRESHOLD_MS + 1;
  const timeline = buildTimeline([session([assistant(0, 0), user(end, 1)])]);

  assert.deepEqual(timeline.humanWaitIntervals, []);
  assert.deepEqual(timeline.idleIntervals, [{ start_ms: 0, end_ms: end }]);
  assert.deepEqual(timeline.activeIntervals, []);
  assert.equal(timeline.actions[0]?.kind, "away");
});

test("unions overlapping agents and marks active overlaps concurrent", () => {
  const timeline = buildTimeline([
    session([
      user(0, 0),
      assistant(100, 1),
      toolUse("side", 20, 2, "side-1"),
      toolResult("side", 60, 3, "side-1"),
    ]),
  ]);

  assert.deepEqual(timeline.rawIntervals, [{ start_ms: 0, end_ms: 100 }]);
  assert.deepEqual(timeline.activeIntervals, [{ start_ms: 0, end_ms: 100 }]);
  assert.equal(
    timeline.actions.find((action) => action.kind === "inference")?.concurrent,
    true,
  );
  assert.equal(
    timeline.actions.find((action) => action.kind === "tool")?.concurrent,
    true,
  );
});

test("marks an action concurrent with another agent's unclassified active interval", () => {
  const timeline = buildTimeline([
    session([
      user(0, 0),
      assistant(100, 1),
      compaction(20, 2, "side-1"),
      compaction(60, 3, "side-1"),
    ]),
  ]);

  assert.equal(
    timeline.actions.find((action) => action.kind === "inference")?.concurrent,
    true,
  );
  assert.equal(
    timeline.actions.some((action) => action.agent_id === "side-1"),
    false,
  );
});

test("sidechain activity remains active inside a parent away interval", () => {
  const end = DEFAULT_IDLE_THRESHOLD_MS + 100;
  const timeline = buildTimeline([
    session([
      assistant(0, 0),
      user(end, 1),
      toolUse("side", 20, 2, "side-1"),
      toolResult("side", 60, 3, "side-1"),
    ]),
  ]);

  assert.deepEqual(timeline.activeIntervals, [{ start_ms: 20, end_ms: 60 }]);
  assert.deepEqual(timeline.idleIntervals, [
    { start_ms: 0, end_ms: 20 },
    { start_ms: 60, end_ms: end },
  ]);
});

test("sorts reversed input and rejects missing or non-positive timestamps", () => {
  const invalid = {
    ...assistant(25, 6),
    timestamp_ms: undefined,
  } as unknown as AssistantEvent;
  const timeline = buildTimeline([
    session(
      [
        toolResult("valid", 20, 3),
        toolUse("valid", 10, 2),
        toolResult("backward", 5, 0),
        toolUse("backward", 10, 1),
        toolUse("equal", 30, 4),
        toolResult("equal", 30, 5),
        invalid as AssistantEvent,
      ],
      1_000,
    ),
  ]);

  assert.deepEqual(timeline.toolIntervals, [
    { start_ms: 10, end_ms: 20 },
  ]);
  assert.deepEqual(timeline.rawIntervals, [{ start_ms: 5, end_ms: 30 }]);
  assert.equal(
    timeline.actions.filter((action) => action.kind === "tool").length,
    3,
  );
  assert.ok(timeline.caveats.some((item) => item.includes("timestamp")));
  assert.ok(timeline.caveats.some((item) => item.includes("backward")));
  assert.ok(timeline.caveats.some((item) => item.includes("equal")));
  assert.equal(timeline.rawIntervals.at(-1)?.end_ms, 30);
});

test("invalid equal or reversed tool pairs break inference causality", () => {
  for (const events of [
    [
      user(0, 0),
      toolResult("reversed", 5, 1),
      toolUse("reversed", 10, 2),
      assistant(20, 3),
    ],
    [
      user(0, 0),
      toolUse("equal", 10, 1),
      toolResult("equal", 10, 2),
      assistant(20, 3),
    ],
  ]) {
    const timeline = buildTimeline([session(events)]);
    assert.deepEqual(timeline.inferenceIntervals, []);
    const action = timeline.actions.find((candidate) =>
      candidate.kind === "tool"
    );
    assert.deepEqual(action?.interval, {
      start_ms: 10,
      end_ms: 10,
    });
    assert.equal(action?.confidence, "low");
    assert.ok(timeline.caveats.some((item) =>
      item.includes("non-positive timestamp pair")
    ));
  }
});

test("prefers a later positive result over an equal-timestamp duplicate", () => {
  const timeline = buildTimeline([
    session([
      toolUse("duplicate-result", 10, 0),
      toolResult("duplicate-result", 10, 1),
      toolResult("duplicate-result", 20, 2),
      assistant(30, 3),
    ]),
  ]);

  assert.deepEqual(timeline.toolIntervals, [
    { start_ms: 10, end_ms: 20 },
  ]);
  assert.deepEqual(timeline.inferenceIntervals, [
    { start_ms: 20, end_ms: 30 },
  ]);
  const action = timeline.actions.find(
    (candidate) => candidate.tool_use_id === "duplicate-result",
  );
  assert.deepEqual(action?.interval, { start_ms: 10, end_ms: 20 });
  assert.equal(action?.confidence, "high");
  assert.ok(action?.session_refs.includes("s1#tr2"));
  assert.ok(timeline.caveats.some((item) => item.includes("duplicate")));
});

test("ignores prior, equal, and later duplicates around the selected result", () => {
  const timeline = buildTimeline([
    session([
      toolResult("duplicate-result", 5, 0),
      toolUse("duplicate-result", 10, 1),
      toolResult("duplicate-result", 10, 2),
      toolResult("duplicate-result", 20, 3),
      toolResult("duplicate-result", 25, 4),
      assistant(30, 5),
    ]),
  ]);

  assert.deepEqual(timeline.toolIntervals, [
    { start_ms: 10, end_ms: 20 },
  ]);
  assert.deepEqual(timeline.inferenceIntervals, [
    { start_ms: 20, end_ms: 30 },
  ]);
  const action = timeline.actions.find(
    (candidate) => candidate.tool_use_id === "duplicate-result",
  );
  assert.deepEqual(action?.session_refs, ["s1#tu1", "s1#tr3"]);
  assert.ok(timeline.caveats.some((item) => item.includes("duplicate")));
});

test("does not pair a tool result attributed to another agent", () => {
  const timeline = buildTimeline([
    session([
      user(0, 0),
      toolUse("cross-agent", 10, 1),
      toolResult("cross-agent", 20, 2, "side-1"),
      assistant(30, 3, "side-1"),
    ]),
  ]);

  assert.deepEqual(timeline.toolIntervals, []);
  assert.deepEqual(timeline.inferenceIntervals, []);
  const action = timeline.actions.find(
    (candidate) => candidate.tool_use_id === "cross-agent",
  );
  assert.deepEqual(action?.interval, { start_ms: 10, end_ms: 10 });
  assert.equal(action?.confidence, "low");
  assert.deepEqual(action?.session_refs, ["s1#tu1"]);
  assert.ok(
    timeline.caveats.some(
      (item) =>
        item.includes("cross-agent") &&
        item.includes("different agent"),
    ),
  );
  assert.ok(
    timeline.caveats.some(
      (item) =>
        item.includes("cross-agent") &&
        item.includes("no matching result"),
    ),
  );
  assert.ok(
    timeline.caveats.some(
      (item) =>
        item.includes("cross-agent") &&
        item.includes("no matching use"),
    ),
  );
});

test("propagates explicit approval metadata and deduplicates repeated tool rows", () => {
  const approvalUse = toolUse("approval", 0, 1, "main", {
    approval: { required: true, reason: "filesystem permission" },
  });
  const timeline = buildTimeline([
    session([
      assistant(0, 0),
      approvalUse,
      { ...approvalUse },
      user(100, 2),
      toolResult("approval", 110, 3),
    ]),
  ]);

  const wait = timeline.actions.find(
    (action) => action.kind === "human_wait",
  );
  assert.deepEqual(wait?.approval, {
    required: true,
    reason: "filesystem permission",
  });
  assert.equal(
    timeline.actions.filter((action) => action.kind === "tool").length,
    1,
  );
  assert.ok(timeline.caveats.some((item) => item.includes("duplicate")));
});

test("compaction breaks causal action attribution and session end adds no tail", () => {
  const timeline = buildTimeline([
    session([user(0, 0), compaction(10, 1), assistant(20, 2)], 10_000),
  ]);

  assert.deepEqual(timeline.rawIntervals, [{ start_ms: 0, end_ms: 20 }]);
  assert.deepEqual(timeline.inferenceIntervals, []);
  assert.equal(timeline.rawIntervals.at(-1)?.end_ms, 20);
  assert.ok(timeline.caveats.some((item) => item.includes("compaction")));
});

test("a session with no verified_ended_at_ms still adds no tail, even when ended_at_ms diverges from the last event", () => {
  // Same shape as the pinned "session end adds no tail" case above, plus an
  // explicit check that unverified sessions get no synthetic action at all -
  // this must keep failing to add a tail so hook-events wiring (which sets
  // verified_ended_at_ms only when a Stop row actually corroborates it)
  // can't accidentally widen the unverified case.
  const timeline = buildTimeline([
    session([user(0, 0), assistant(20, 1)], 10_000),
  ]);

  assert.deepEqual(timeline.rawIntervals, [{ start_ms: 0, end_ms: 20 }]);
  assert.deepEqual(timeline.activeIntervals, [{ start_ms: 0, end_ms: 20 }]);
  assert.equal(
    timeline.actions.some((action) =>
      action.action_id.endsWith(":verified_end")
    ),
    false,
  );
});

test("a verified_ended_at_ms past the last event adds a low-confidence inference tail that counts as measured time", () => {
  const timeline = buildTimeline([
    session([user(0, 0), assistant(20, 1)], 20, 25_000),
  ]);

  const tail = timeline.actions.find((action) =>
    action.action_id.endsWith(":verified_end")
  );
  assert.ok(tail, "a verified tail action must be emitted");
  assert.equal(tail?.kind, "inference");
  assert.deepEqual(tail?.interval, { start_ms: 20, end_ms: 25_000 });
  assert.equal(tail?.confidence, "low");
  assert.equal(tail?.concurrent, false);
  assert.equal(tail?.session_id, "s1");
  assert.equal(tail?.agent_id, "main");
  assert.equal(tail?.tool_use_id, undefined);
  assert.equal(tail?.tool_name, undefined);
  assert.equal(tail?.command, undefined);
  assert.deepEqual(tail?.paths, []);

  // The verified tail must extend raw/active time, not just appear as a
  // cosmetic action - this is what makes it count as measured instead of
  // vanishing past the log's last timestamp.
  assert.deepEqual(timeline.rawIntervals, [{ start_ms: 0, end_ms: 25_000 }]);
  assert.deepEqual(
    timeline.activeIntervals,
    [{ start_ms: 0, end_ms: 25_000 }],
  );
  assert.deepEqual(timeline.idleIntervals, []);
});

test("a verified_ended_at_ms that does not exceed the last event adds no tail", () => {
  const timeline = buildTimeline([
    session([user(0, 0), assistant(20, 1)], 20, 20),
  ]);

  assert.equal(
    timeline.actions.some((action) =>
      action.action_id.endsWith(":verified_end")
    ),
    false,
  );
  assert.deepEqual(timeline.rawIntervals, [{ start_ms: 0, end_ms: 20 }]);
});

test("a verified tail exceeding a configured idle threshold becomes away: raw grows but active/measured does not", () => {
  const fiveMinutes = 5 * 60_000;
  const tenMinutes = 10 * 60_000;
  const timeline = buildTimeline(
    [session([user(0, 0), assistant(20, 1)], 20, tenMinutes)],
    { idleThresholdMs: fiveMinutes },
  );

  const tail = timeline.actions.find((action) =>
    action.action_id.endsWith(":verified_end")
  );
  assert.ok(tail, "a verified tail action must still be emitted");
  assert.equal(tail?.kind, "away");
  assert.deepEqual(tail?.interval, { start_ms: 20, end_ms: tenMinutes });
  assert.equal(tail?.confidence, "low");

  // Raw time picks up the full tail (it's still an observed span)...
  assert.deepEqual(
    timeline.rawIntervals,
    [{ start_ms: 0, end_ms: tenMinutes }],
  );
  // ...but active/measured time does not grow past the real last event,
  // matching how every other over-threshold gap in this module behaves;
  // the excess lands in idleIntervals instead.
  assert.deepEqual(timeline.activeIntervals, [{ start_ms: 0, end_ms: 20 }]);
  assert.deepEqual(
    timeline.idleIntervals,
    [{ start_ms: 20, end_ms: tenMinutes }],
  );
});

test("a verified tail exactly at a configured idle threshold stays inference (active)", () => {
  const fiveMinutes = 5 * 60_000;
  const timeline = buildTimeline(
    [session([user(0, 0), assistant(20, 1)], 20, 20 + fiveMinutes)],
    { idleThresholdMs: fiveMinutes },
  );

  const tail = timeline.actions.find((action) =>
    action.action_id.endsWith(":verified_end")
  );
  assert.equal(tail?.kind, "inference");
  assert.deepEqual(
    timeline.activeIntervals,
    [{ start_ms: 0, end_ms: 20 + fiveMinutes }],
  );
  assert.deepEqual(timeline.idleIntervals, []);
});

test("AskUserQuestion becomes human wait with tool metadata retained", () => {
  const timeline = buildTimeline([
    session([
      toolUse("ask", 0, 0, "main", {
        tool_name: "AskUserQuestion",
        paths: [],
      }),
      toolResult("ask", 1_000, 1),
    ]),
  ]);

  assert.deepEqual(timeline.toolIntervals, []);
  assert.deepEqual(timeline.humanWaitIntervals, [
    { start_ms: 0, end_ms: 1_000 },
  ]);
  assert.deepEqual(timeline.activeIntervals, timeline.rawIntervals);
  const action = timeline.actions.find(
    (candidate) => candidate.tool_use_id === "ask",
  );
  assert.equal(action?.kind, "human_wait");
  assert.equal(action?.tool_name, "AskUserQuestion");
  assert.deepEqual(action?.interval, { start_ms: 0, end_ms: 1_000 });
});

test("an AskUserQuestion wait exactly at the threshold stays human wait", () => {
  const timeline = buildTimeline(
    [
      session([
        toolUse("ask", 0, 0, "main", {
          tool_name: "AskUserQuestion",
          paths: [],
        }),
        toolResult("ask", 1_000, 1),
      ]),
    ],
    { idleThresholdMs: 1_000 },
  );

  assert.deepEqual(timeline.humanWaitIntervals, [
    { start_ms: 0, end_ms: 1_000 },
  ]);
  assert.deepEqual(timeline.idleIntervals, []);
});

test("an AskUserQuestion wait over the threshold becomes away and is idle-excluded", () => {
  const timeline = buildTimeline(
    [
      session([
        toolUse("ask", 0, 0, "main", {
          tool_name: "AskUserQuestion",
          paths: [],
        }),
        toolResult("ask", 1_001, 1),
      ]),
    ],
    { idleThresholdMs: 1_000 },
  );

  assert.deepEqual(timeline.humanWaitIntervals, []);
  assert.deepEqual(timeline.activeIntervals, []);
  assert.deepEqual(timeline.idleIntervals, [{ start_ms: 0, end_ms: 1_001 }]);
  const action = timeline.actions.find(
    (candidate) => candidate.tool_use_id === "ask",
  );
  assert.equal(action?.kind, "away");
  assert.equal(action?.tool_name, "AskUserQuestion");
});

test("does not pair tool uses and results across different source lanes", () => {
  const useSession = {
    ...session([toolUse("t1", 0, 0)]),
    source_path: "/tmp/segment-0.jsonl",
  };
  const resultSession = {
    ...session([toolResult("t1", 5_000, 1)]),
    source_path: "/tmp/segment-1.jsonl",
  };
  const timeline = buildTimeline([useSession, resultSession]);

  assert.deepEqual(timeline.toolIntervals, []);
  const action = timeline.actions.find(
    (candidate) => candidate.tool_use_id === "t1",
  );
  assert.deepEqual(action?.interval, { start_ms: 0, end_ms: 0 });
  assert.equal(action?.confidence, "low");
  assert.ok(
    timeline.caveats.some((item) => item.includes("no matching result")),
  );
  assert.ok(timeline.caveats.some((item) => item.includes("no matching use")));
});
