import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "../src/core/model.js";
import {
  AnalysisBudgetMeter,
  type AnalysisBudgetClock,
  type AnalysisBudgets,
} from "../src/analysis/budgets.js";
import { CombinedSessionSource } from "../src/sources/combined.js";
import {
  admitSessionEventPrefix,
  type SessionQuery,
  type SessionSource,
} from "../src/sources/session-source.js";

const query: SessionQuery = {
  repoRoot: "/repo",
  headBranch: "feature",
  startedAtMs: 0,
  endedAtMs: 1,
};

function fakeSession(sourcePath: string): Session {
  return {
    session_id: sourcePath,
    source: "claude",
    source_path: sourcePath,
    observed_cwds: [],
    observed_branches: [],
    started_at_ms: 0,
    ended_at_ms: 1,
    confidence: "high",
    events: [],
    warnings: [],
  };
}

function sourceOf(...sessions: Session[]): SessionSource {
  return { discover: async () => sessions };
}

function throwingSource(error: unknown): SessionSource {
  return {
    discover: async () => {
      throw error;
    },
  };
}

const clock: AnalysisBudgetClock = {
  wall_ms: () => 0,
  cpu_ms: () => 0,
};

function budgets(overrides: Partial<AnalysisBudgets> = {}): AnalysisBudgets {
  return {
    max_input_bytes: 1_000,
    max_input_events: 100,
    max_wall_ms: 1_000,
    max_cpu_ms: 1_000,
    max_output_bytes: 1_000,
    max_source_items: 1,
    ...overrides,
  };
}

test("concatenates sessions from multiple sources in source order", async () => {
  const first = sourceOf(fakeSession("a"), fakeSession("b"));
  const second = sourceOf(fakeSession("c"));
  const combined = new CombinedSessionSource([first, second]);

  const sessions = await combined.discover(query);

  assert.deepEqual(
    sessions.map((session) => session.source_path),
    ["a", "b", "c"],
  );
});

test("a throwing source contributes [] while the other source's sessions survive, and onSourceError is invoked", async () => {
  const failure = new Error("boom");
  const failing = throwingSource(failure);
  const healthy = sourceOf(fakeSession("survivor"));
  const errors: unknown[] = [];
  const combined = new CombinedSessionSource(
    [failing, healthy],
    (error) => errors.push(error),
  );

  const sessions = await combined.discover(query);

  assert.deepEqual(
    sessions.map((session) => session.source_path),
    ["survivor"],
  );
  assert.deepEqual(errors, [failure]);
});

test("preserves source order even when a later source is the one that throws", async () => {
  const healthy = sourceOf(fakeSession("first"), fakeSession("second"));
  const failure = new Error("later source down");
  const failing = throwingSource(failure);
  const errors: unknown[] = [];
  const combined = new CombinedSessionSource(
    [healthy, failing],
    (error) => errors.push(error),
  );

  const sessions = await combined.discover(query);

  assert.deepEqual(
    sessions.map((session) => session.source_path),
    ["first", "second"],
  );
  assert.deepEqual(errors, [failure]);
});

test("discover() never rejects because of a source failure, even without an onSourceError callback", async () => {
  const combined = new CombinedSessionSource([
    throwingSource(new Error("no listener for this one")),
  ]);

  await assert.doesNotReject(combined.discover(query));
});

test("unbudgeted combined discovery starts independent sources in parallel", async () => {
  const order: string[] = [];
  let releaseFirst = (): void => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first: SessionSource = {
    discover: async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
      return [fakeSession("first")];
    },
  };
  const second: SessionSource = {
    discover: async () => {
      order.push("second:start");
      return [fakeSession("second")];
    },
  };
  const pending = new CombinedSessionSource([first, second]).discover(query);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start", "second:start"]);
  releaseFirst();
  await pending;
});

test("budgeted combined discovery is sequential and stops at the shared source-item boundary", async () => {
  const meter = new AnalysisBudgetMeter(budgets(), clock);
  const budgetedQuery = { ...query, analysisBudgetMeter: meter };
  const order: string[] = [];
  const budgetAware = (
    name: string,
  ): SessionSource => ({
    discover: async (sourceQuery) => {
      order.push(`${name}:start`);
      await Promise.resolve();
      const admitted = (sourceQuery as SessionQuery & {
        analysisBudgetMeter: AnalysisBudgetMeter;
      }).analysisBudgetMeter.admitSourceItem();
      order.push(`${name}:end`);
      return admitted ? [fakeSession(name)] : [];
    },
  });
  const errors: unknown[] = [];
  const combined = new CombinedSessionSource(
    [budgetAware("first"), budgetAware("second")],
    (error) => errors.push(error),
  );

  const sessions = await combined.discover(budgetedQuery);

  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
  assert.deepEqual(sessions.map(({ source_path }) => source_path), ["first"]);
  assert.deepEqual(errors, []);
  assert.equal(meter.result().truncation_reason, "max_source_items");
  assert.equal(meter.result().consumed.source_items, 1);
  assert.equal(meter.result().observed.source_items, 2);
});

test("budgeted source failure is content-free and prevents the next source from starting", async () => {
  const meter = new AnalysisBudgetMeter(budgets(), clock);
  const started: string[] = [];
  const failure = new Error("token-canary");
  const combined = new CombinedSessionSource([
    {
      discover: async () => {
        started.push("first");
        throw failure;
      },
    },
    {
      discover: async () => {
        started.push("second");
        return [fakeSession("second")];
      },
    },
  ]);

  const budgetedQuery = {
    ...query,
    analysisBudgetMeter: meter,
  };
  const sessions = await combined.discover(budgetedQuery);

  assert.deepEqual(sessions, []);
  assert.deepEqual(started, ["first"]);
  assert.equal(meter.result().truncation_reason, "source_failure");
  assert.equal(meter.result().coverage, 0);
  assert.ok(!JSON.stringify(meter.result()).includes("token-canary"));
});

test("budgeted combined discovery checkpoints before starting an adapter", async () => {
  let wallReads = 0;
  const expiringClock: AnalysisBudgetClock = {
    wall_ms: () => wallReads++ === 0 ? 0 : 1,
    cpu_ms: () => 0,
  };
  const meter = new AnalysisBudgetMeter(
    budgets({ max_wall_ms: 0 }),
    expiringClock,
  );
  let sourceCalls = 0;
  const combined = new CombinedSessionSource([{
    discover: async () => {
      sourceCalls += 1;
      return [fakeSession("must-not-start")];
    },
  }]);

  const sessions = await combined.discover({
    ...query,
    analysisBudgetMeter: meter,
  });

  assert.deepEqual(sessions, []);
  assert.equal(sourceCalls, 0);
  assert.equal(meter.result().truncation_reason, "max_wall_ms");
});

test("event admission follows one physical source-index prefix across interleaved sessions", () => {
  const event = (sessionId: string, sourceIndex: number): Session["events"][number] => ({
    kind: "assistant",
    timestamp_ms: sourceIndex + 1,
    session_id: sessionId,
    entry_uuid: `${sessionId}-${sourceIndex.toString(10)}`,
    session_ref: `${sessionId}#${sourceIndex.toString(10)}`,
    source_index: sourceIndex,
    agent_id: sessionId,
    is_sidechain: false,
    confidence: "high",
    text: sessionId,
  });
  const first: Session = {
    ...fakeSession("shared.jsonl"),
    session_id: "first",
    events: [event("first", 0), event("first", 2)],
  };
  const second: Session = {
    ...fakeSession("shared.jsonl"),
    session_id: "second",
    events: [event("second", 1), event("second", 3)],
  };
  const meter = new AnalysisBudgetMeter(
    budgets({ max_input_events: 2 }),
    clock,
  );

  const admitted = admitSessionEventPrefix([first, second], meter);

  assert.deepEqual(
    admitted.map(({ session_id, events }) => ({
      session_id,
      source_indices: events.map(({ source_index }) => source_index),
    })),
    [
      { session_id: "first", source_indices: [0] },
      { session_id: "second", source_indices: [1] },
    ],
  );
  assert.equal(meter.result().consumed.input_events, 2);
  assert.equal(meter.result().observed.input_events, 4);
  assert.equal(meter.result().truncation_reason, "max_input_events");
});
