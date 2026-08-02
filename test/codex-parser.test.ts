import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { makeSessionRef } from "../src/core/model.js";
import { parseCodexSession } from "../src/sources/codex/parser.js";

const fixturePath = (name: string): string =>
  resolve(process.cwd(), "test", "fixtures", "codex", name);

const readFixture = (name: string): string =>
  readFileSync(fixturePath(name), "utf8");

test("returns null when there is no parseable content", () => {
  assert.equal(
    parseCodexSession({ sourcePath: "empty.jsonl", raw: "" }),
    null,
  );
  assert.equal(
    parseCodexSession({ sourcePath: "blank.jsonl", raw: "   \n\n  " }),
    null,
  );
  assert.equal(
    parseCodexSession({
      sourcePath: "garbage.jsonl",
      raw: "not json at all\n{also not json",
    }),
    null,
  );
});

test("normalizes a well-formed Codex rollout into a Session", () => {
  const raw = readFixture("session-basic.jsonl");
  const session = parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
    raw,
  });

  assert.ok(session);
  assert.equal(session.session_id, "codex-session-basic");
  assert.equal(session.source, "codex");
  assert.deepEqual(session.capabilities, ["tool_timestamps"]);
  assert.equal(session.confidence, "high");
  assert.deepEqual(session.observed_cwds, ["/workspace/repo"]);
  assert.deepEqual(session.observed_branches, ["feature/health-check"]);
  assert.equal(session.started_at_ms, Date.parse("2026-07-30T09:00:02.000Z"));
  assert.equal(session.ended_at_ms, Date.parse("2026-07-30T09:00:12.000Z"));

  for (const event of session.events) {
    assert.equal(event.agent_id, session.session_id);
    assert.equal(event.is_sidechain, false);
    assert.equal(event.entry_uuid, `line-${event.source_index.toString(10)}`);
    assert.equal(
      event.session_ref,
      makeSessionRef(session.session_id, event.entry_uuid),
    );
  }
});

test("joins user message text parts and skips injected instruction text", () => {
  const session = parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
    raw: readFixture("session-basic.jsonl"),
  });
  assert.ok(session);

  const genuineUsers = session.events.filter(
    (event) => event.kind === "genuine_user",
  );
  assert.equal(genuineUsers.length, 1);
  assert.equal(
    genuineUsers[0]?.kind === "genuine_user" ? genuineUsers[0].text : undefined,
    "Please add a health check endpoint.",
  );
});

test("joins assistant message content array parts and carries no token usage", () => {
  const session = parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
    raw: readFixture("session-basic.jsonl"),
  });
  assert.ok(session);

  const assistants = session.events.filter(
    (event) => event.kind === "assistant",
  );
  assert.equal(assistants.length, 2);
  assert.equal(
    assistants[0]?.kind === "assistant" ? assistants[0].text : undefined,
    "I'll add the health check endpoint now.",
  );
  assert.equal(
    assistants[1]?.kind === "assistant" ? assistants[1].text : undefined,
    "Fixed the failing check and re-ran the suite.",
  );
  for (const event of assistants) {
    assert.equal(event.kind === "assistant" ? event.input_tokens : "x", undefined);
    assert.equal(event.kind === "assistant" ? event.output_tokens : "x", undefined);
  }
});

test("maps exec_command/shell function_call rows into tool_use events", () => {
  const session = parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
    raw: readFixture("session-basic.jsonl"),
  });
  assert.ok(session);

  const toolUses = session.events.filter((event) => event.kind === "tool_use");
  assert.equal(toolUses.length, 3);

  const shellCall = toolUses.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "call-1",
  );
  assert.ok(shellCall && shellCall.kind === "tool_use");
  assert.equal(shellCall.tool_name, "shell");
  assert.equal(shellCall.command, "bash -lc go test ./...");
  assert.equal(shellCall.cwd, "/workspace/repo");
  assert.deepEqual(shellCall.input, {
    command: ["bash", "-lc", "go test ./..."],
    workdir: "/workspace/repo",
  });

  const execCall = toolUses.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "call-2",
  );
  assert.ok(execCall && execCall.kind === "tool_use");
  assert.equal(execCall.tool_name, "exec_command");
  assert.equal(execCall.command, "go vet ./...");
  assert.equal(execCall.cwd, "/workspace/repo");

  const brokenArgsCall = toolUses.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "call-3",
  );
  assert.ok(brokenArgsCall && brokenArgsCall.kind === "tool_use");
  assert.deepEqual(brokenArgsCall.input, {});
  assert.equal(brokenArgsCall.command, undefined);
  assert.equal(brokenArgsCall.confidence, "low");
});

test("maps function_call_output rows into tool_result events with exit-code status", () => {
  const session = parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
    raw: readFixture("session-basic.jsonl"),
  });
  assert.ok(session);

  const results = session.events.filter((event) => event.kind === "tool_result");
  assert.equal(results.length, 2);

  const success = results.find(
    (event) => event.kind === "tool_result" && event.tool_use_id === "call-1",
  );
  assert.ok(success && success.kind === "tool_result");
  assert.equal(success.status, "success");
  assert.equal(success.exit_code, 0);
  assert.equal(success.output, "Process exited with code 0\nok  \tpkg/health\t0.004s");
  assert.equal(success.output_bytes, Buffer.byteLength(success.output));
  assert.equal(success.estimated_tokens, Math.ceil(success.output.length / 4));

  const failure = results.find(
    (event) => event.kind === "tool_result" && event.tool_use_id === "call-2",
  );
  assert.ok(failure && failure.kind === "tool_result");
  assert.equal(failure.status, "failure");
  assert.equal(failure.exit_code, 1);
  assert.equal(
    failure.output,
    "Process exited with code 1\nvet: pkg/health/health.go:12: undeclared name: Ping",
  );
});

test("ignores reasoning, event_msg, and turn_context rows", () => {
  const session = parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
    raw: readFixture("session-basic.jsonl"),
  });
  assert.ok(session);
  // 1 user + 2 assistant + 3 tool_use + 2 tool_result = 8 events total.
  assert.equal(session.events.length, 8);
});

test("degrades malformed rows to warnings instead of throwing", () => {
  const session = parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
    raw: readFixture("session-basic.jsonl"),
  });
  assert.ok(session);

  assert.ok(
    session.warnings.some((warning) => warning.code === "codex_row_invalid"),
  );
  assert.ok(
    session.warnings.some(
      (warning) => warning.code === "codex_invalid_tool_arguments",
    ),
  );
});

test("falls back to the file name stem and low confidence when session_meta is absent", () => {
  const session = parseCodexSession({
    sourcePath: fixturePath("no-session-meta.jsonl"),
    raw: readFixture("no-session-meta.jsonl"),
  });

  assert.ok(session);
  assert.equal(session.session_id, "no-session-meta");
  assert.equal(session.confidence, "low");
  assert.deepEqual(session.observed_cwds, []);
  assert.deepEqual(session.observed_branches, []);
  assert.equal(session.events.length, 2);
  assert.ok(
    session.warnings.some(
      (warning) => warning.code === "codex_missing_session_meta",
    ),
  );
});
