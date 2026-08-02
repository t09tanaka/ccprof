import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "../src/core/model.js";
import { CombinedSessionSource } from "../src/sources/combined.js";
import type { SessionQuery, SessionSource } from "../src/sources/session-source.js";

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
