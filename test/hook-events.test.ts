import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  applyHookEvents,
  HOOK_EVENT_END_WINDOW_MS,
  loadHookEvents,
  type HookEventRow,
} from "../src/analysis/hook-events.js";
import type { AssistantEvent, Session } from "../src/core/model.js";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function assistantEvent(
  sessionId: string,
  timestampMs: number,
  agentId = "main",
  isSidechain = false,
): AssistantEvent {
  return {
    kind: "assistant", timestamp_ms: timestampMs, session_id: sessionId,
    entry_uuid: `${agentId}-${timestampMs}`, session_ref: `${sessionId}#${agentId}`,
    source_index: 0, agent_id: agentId, is_sidechain: isSidechain,
    confidence: "high", text: "done",
  };
}

function makeSession(
  sessionId: string,
  endedAtMs: number,
  overrides: Partial<Session> = {},
): Session {
  return {
    session_id: sessionId,
    source: "claude",
    source_path: `/tmp/${sessionId}.jsonl`,
    observed_cwds: [],
    observed_branches: [],
    started_at_ms: endedAtMs - 60_000,
    ended_at_ms: endedAtMs,
    confidence: "high",
    events: [assistantEvent(sessionId, endedAtMs)],
    warnings: [],
    ...overrides,
  };
}

function stopRow(
  sessionId: string,
  receivedAtMs: number,
): HookEventRow {
  return {
    received_at_ms: receivedAtMs,
    session_id: sessionId,
    hook_event_name: "Stop",
  };
}

// --- applyHookEvents -------------------------------------------------

test("applyHookEvents extends ended_at_ms and verified_ended_at_ms to a matching in-window Stop event", () => {
  const session = makeSession("s1", 1_000_000);
  const [result] = applyHookEvents([session], [stopRow("s1", 1_000_500)]);
  assert.equal(result?.ended_at_ms, 1_000_500);
  assert.equal(result?.verified_ended_at_ms, 1_000_500);
  assert.notEqual(result, session, "a changed session must be a new object");
});

test("applyHookEvents picks the max in-window Stop event when several exist", () => {
  const session = makeSession("s1", 1_000_000);
  const rows = [
    stopRow("s1", 1_000_200),
    stopRow("s1", 1_000_900),
    stopRow("s1", 1_000_400),
  ];
  const [result] = applyHookEvents([session], rows);
  assert.equal(result?.ended_at_ms, 1_000_900);
  assert.equal(result?.verified_ended_at_ms, 1_000_900);
});

test("applyHookEvents ignores a Stop event beyond the 30-minute window", () => {
  const session = makeSession("s1", 1_000_000);
  const justOutside = 1_000_000 + HOOK_EVENT_END_WINDOW_MS + 1;
  const [result] = applyHookEvents([session], [stopRow("s1", justOutside)]);
  assert.equal(result, session, "an out-of-window session must be unchanged");
  assert.equal(result?.verified_ended_at_ms, undefined);
});

test("applyHookEvents accepts a Stop event exactly at the 30-minute boundary", () => {
  const session = makeSession("s1", 1_000_000);
  const atBoundary = 1_000_000 + HOOK_EVENT_END_WINDOW_MS;
  const [result] = applyHookEvents([session], [stopRow("s1", atBoundary)]);
  assert.equal(result?.ended_at_ms, atBoundary);
  assert.equal(result?.verified_ended_at_ms, atBoundary);
});

test("applyHookEvents ignores a Stop event for a different session_id", () => {
  const session = makeSession("s1", 1_000_000);
  const [result] = applyHookEvents(
    [session],
    [stopRow("other-session", 1_000_500)],
  );
  assert.equal(result, session);
  assert.equal(result?.verified_ended_at_ms, undefined);
});

test("applyHookEvents ignores a Stop event at or before ended_at_ms", () => {
  const session = makeSession("s1", 1_000_000);
  const rows = [stopRow("s1", 1_000_000), stopRow("s1", 999_000)];
  const [result] = applyHookEvents([session], rows);
  assert.equal(result, session);
});

test("applyHookEvents ignores non-Stop hook_event_name rows, including ccprof_notified", () => {
  const session = makeSession("s1", 1_000_000);
  const rows: HookEventRow[] = [
    { received_at_ms: 1_000_500, session_id: "s1", hook_event_name: "ccprof_notified" },
    { received_at_ms: 1_000_600, session_id: "s1", hook_event_name: "PreToolUse" },
  ];
  const [result] = applyHookEvents([session], rows);
  assert.equal(result, session);
});

test("applyHookEvents returns an empty array unchanged", () => {
  assert.deepEqual(applyHookEvents([], [stopRow("s1", 1_000_500)]), []);
});

test("applyHookEvents does not mutate the input session or rows", () => {
  const session = makeSession("s1", 1_000_000);
  const frozenSession = { ...session };
  const rows = [stopRow("s1", 1_000_500)];
  const frozenRows = rows.map((row) => ({ ...row }));
  applyHookEvents([session], rows);
  assert.deepEqual(session, frozenSession);
  assert.deepEqual(rows, frozenRows);
});

test("applyHookEvents requires one unique eligible Claude main lane", () => {
  const end = 1_000_000;
  const eligible = makeSession("eligible", end);
  const codex = makeSession("codex", end, { source: "codex" });
  const collisionClaude = makeSession("collision", end);
  const collisionCodex = makeSession("collision", end, {
    source: "codex", source_path: "/tmp/collision-codex.jsonl",
  });
  const segmentA = makeSession("segmented", end, { source_path: "/tmp/a.jsonl" });
  const segmentB = makeSession("segmented", end, { source_path: "/tmp/b.jsonl" });
  const multiBranch = makeSession("branches", end, {
    observed_branches: ["feature", "other"],
  });
  const sidechainOnly = makeSession("sidechain", end, {
    events: [assistantEvent("sidechain", end, "side", true)],
  });
  const multiMain = makeSession("multi-main", end, { events: [
    assistantEvent("multi-main", end - 1, "main-a"),
    assistantEvent("multi-main", end, "main-b"),
  ] });
  const sessions = [eligible, codex, collisionClaude, collisionCodex,
    segmentA, segmentB, multiBranch, sidechainOnly, multiMain];
  const rows = [...new Set(sessions.map(({ session_id }) => session_id))]
    .map((sessionId) => stopRow(sessionId, end + 500));

  const results = applyHookEvents(sessions, rows);
  assert.equal(results[0]?.verified_ended_at_ms, end + 500);
  for (let index = 1; index < sessions.length; index += 1) {
    assert.equal(results[index], sessions[index]);
  }
});

// --- loadHookEvents ----------------------------------------------------

test("loadHookEvents returns an empty result with no warning when the file is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-"));
  try {
    const result = await loadHookEvents(join(root, "does-not-exist.jsonl"));
    assert.deepEqual(result, { rows: [], warnings: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadHookEvents parses well-formed rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-"));
  try {
    const path = join(root, "hook-events.jsonl");
    await write(
      path,
      [
        JSON.stringify(stopRow("s1", 1_000_500)),
        JSON.stringify({
          received_at_ms: 1_000_600,
          session_id: "s1",
          hook_event_name: "ccprof_notified",
        }),
      ].join("\n") + "\n",
    );
    const result = await loadHookEvents(path);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.rows, [
      stopRow("s1", 1_000_500),
      { received_at_ms: 1_000_600, session_id: "s1", hook_event_name: "ccprof_notified" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadHookEvents skips corrupt/invalid lines and folds them into one aggregate warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-"));
  try {
    const path = join(root, "hook-events.jsonl");
    await write(
      path,
      [
        "{not json",
        JSON.stringify({ session_id: "s1", hook_event_name: "Stop" }), // missing received_at_ms
        JSON.stringify({ received_at_ms: "nope", session_id: "s1", hook_event_name: "Stop" }),
        JSON.stringify({ received_at_ms: 1_000_500, session_id: 42, hook_event_name: "Stop" }),
        "",
        JSON.stringify(stopRow("s1", 1_000_500)),
      ].join("\n") + "\n",
    );
    const result = await loadHookEvents(path);
    assert.deepEqual(result.rows, [stopRow("s1", 1_000_500)]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, "hook_events_invalid_rows");
    assert.equal(result.warnings[0]?.path, path);
    assert.match(result.warnings[0]?.message ?? "", /^4 hook event rows /u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadHookEvents treats a blank file as zero rows with no warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-"));
  try {
    const path = join(root, "hook-events.jsonl");
    await write(path, "\n\n");
    const result = await loadHookEvents(path);
    assert.deepEqual(result, { rows: [], warnings: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
