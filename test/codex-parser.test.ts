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
  assert.deepEqual(session.capabilities, ["tool_timestamps", "edit_fragments"]);
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

test("classifies a function_call_output with no exit-code marker as unknown", () => {
  const raw = [
    '{"timestamp":"2026-07-30T11:00:00.000Z","type":"session_meta","payload":{"id":"unknown-exit-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T11:00:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-x","output":"no exit code information here"}}',
  ].join("\n");

  const session = parseCodexSession({ sourcePath: "unknown-exit.jsonl", raw });
  assert.ok(session);

  const result = session.events.find((event) => event.kind === "tool_result");
  assert.ok(result && result.kind === "tool_result");
  assert.equal(result.status, "unknown");
  assert.equal(result.exit_code, undefined);
  assert.equal(result.output, "no exit code information here");
});

test("skips function_call rows missing call_id/name and function_call_output rows missing output, warning instead of throwing", () => {
  const raw = [
    '{"timestamp":"2026-07-30T12:00:00.000Z","type":"session_meta","payload":{"id":"missing-fields-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T12:00:01.000Z","type":"response_item","payload":{"type":"function_call","arguments":"{}"}}',
    '{"timestamp":"2026-07-30T12:00:02.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-missing-output"}}',
    '{"timestamp":"2026-07-30T12:00:03.000Z","type":"response_item","payload":{"type":"message","role":"user","content":"Keep the session alive."}}',
  ].join("\n");

  const session = parseCodexSession({
    sourcePath: "missing-fields.jsonl",
    raw,
  });
  assert.ok(session);

  // Only the trailing user message should have produced an event; both the
  // call_id/name-less function_call and the output-less function_call_output
  // are dropped.
  assert.equal(session.events.length, 1);
  assert.equal(session.events[0]?.kind, "genuine_user");

  const invalidRowWarnings = session.warnings.filter(
    (warning) => warning.code === "codex_row_invalid",
  );
  assert.equal(invalidRowWarnings.length, 2);
});

test("does not fabricate an exit code from a quoted phrase mid-output", () => {
  const raw = [
    '{"timestamp":"2026-07-30T14:00:00.000Z","type":"session_meta","payload":{"id":"quoted-phrase-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T14:00:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-quoted","output":"cat ci.log\\nsome earlier line\\nProcess exited with code 1\\nthat line was quoted from an old log, not this run status"}}',
  ].join("\n");

  const session = parseCodexSession({ sourcePath: "quoted-phrase.jsonl", raw });
  assert.ok(session);

  const result = session.events.find((event) => event.kind === "tool_result");
  assert.ok(result && result.kind === "tool_result");
  assert.equal(result.status, "unknown");
  assert.equal(result.exit_code, undefined);
});

test("prefers metadata.exit_code over text scanning, even when the text does not match", () => {
  const raw = [
    '{"timestamp":"2026-07-30T15:00:00.000Z","type":"session_meta","payload":{"id":"metadata-exit-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T15:00:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-meta","output":"{\\"output\\":\\"no matching phrase here\\",\\"metadata\\":{\\"exit_code\\":2}}"}}',
  ].join("\n");

  const session = parseCodexSession({ sourcePath: "metadata-exit.jsonl", raw });
  assert.ok(session);

  const result = session.events.find((event) => event.kind === "tool_result");
  assert.ok(result && result.kind === "tool_result");
  assert.equal(result.status, "failure");
  assert.equal(result.exit_code, 2);
  assert.equal(result.output, "no matching phrase here");
});

test("extracts edit paths and fragments from apply_patch file headers", () => {
  const session = parseCodexSession({
    sourcePath: fixturePath("apply-patch.jsonl"),
    raw: readFixture("apply-patch.jsonl"),
  });
  assert.ok(session);

  const patchCall = session.events.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "call-ap-1",
  );
  assert.ok(patchCall && patchCall.kind === "tool_use");
  assert.equal(patchCall.tool_name, "apply_patch");
  assert.deepEqual(patchCall.paths, [
    "src/app/health.ts",
    "src/app/health.test.ts",
    "src/app/legacy.ts",
  ]);
  assert.equal(patchCall.edit_fragments.length, 1);
  assert.match(patchCall.edit_fragments[0] ?? "", /^\*\*\* Begin Patch/u);
  assert.match(patchCall.edit_fragments[0] ?? "", /\+export const ok = true;/u);
  assert.equal(patchCall.confidence, "high");
});

test("warns and leaves paths empty when an apply_patch body has no file headers", () => {
  const session = parseCodexSession({
    sourcePath: fixturePath("apply-patch.jsonl"),
    raw: readFixture("apply-patch.jsonl"),
  });
  assert.ok(session);

  const patchCall = session.events.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "call-ap-2",
  );
  assert.ok(patchCall && patchCall.kind === "tool_use");
  assert.deepEqual(patchCall.paths, []);
  assert.deepEqual(patchCall.edit_fragments, ["this is not a patch body"]);

  const noPathWarnings = session.warnings.filter(
    (warning) => warning.code === "codex_apply_patch_no_paths",
  );
  assert.equal(noPathWarnings.length, 1);
  assert.equal(noPathWarnings[0]?.line, 4);
});

test("deduplicates and trims repeated apply_patch header paths", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/app/health.ts ",
    "@@",
    "+const first = 1;",
    "*** Update File: src/app/health.ts",
    "@@",
    "+const second = 2;",
    "*** End Patch",
  ].join("\n");
  const raw = [
    '{"timestamp":"2026-07-31T10:00:00.000Z","type":"session_meta","payload":{"id":"apply-patch-dedupe","cwd":"/workspace/repo"}}',
    JSON.stringify({
      timestamp: "2026-07-31T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "apply_patch",
        call_id: "call-dupe",
        arguments: JSON.stringify({ input: patch }),
      },
    }),
  ].join("\n");

  const session = parseCodexSession({ sourcePath: "apply-patch-dedupe.jsonl", raw });
  assert.ok(session);

  const patchCall = session.events.find((event) => event.kind === "tool_use");
  assert.ok(patchCall && patchCall.kind === "tool_use");
  assert.deepEqual(patchCall.paths, ["src/app/health.ts"]);
});

test("warns once per distinct unknown response_item subtype without affecting events", () => {
  const raw = [
    '{"timestamp":"2026-07-30T16:00:00.000Z","type":"session_meta","payload":{"id":"unknown-subtype-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T16:00:01.000Z","type":"response_item","payload":{"type":"local_shell_call","call_id":"call-a","status":"completed"}}',
    '{"timestamp":"2026-07-30T16:00:02.000Z","type":"response_item","payload":{"type":"local_shell_call","call_id":"call-b","status":"completed"}}',
    '{"timestamp":"2026-07-30T16:00:03.000Z","type":"response_item","payload":{"type":"message","role":"user","content":"Keep the session alive."}}',
  ].join("\n");

  const session = parseCodexSession({ sourcePath: "unknown-subtype.jsonl", raw });
  assert.ok(session);

  assert.equal(session.events.length, 1);
  assert.equal(session.events[0]?.kind, "genuine_user");

  const unknownSubtypeWarnings = session.warnings.filter(
    (warning) => warning.code === "codex_unknown_response_item",
  );
  assert.equal(unknownSubtypeWarnings.length, 1);
  assert.match(unknownSubtypeWarnings[0]?.message ?? "", /local_shell_call/u);
});

test("returns null for a session with a valid session_meta but zero emitted events", () => {
  const raw = [
    '{"timestamp":"2026-07-30T13:00:00.000Z","type":"session_meta","payload":{"id":"empty-events-session","cwd":"/workspace/repo","git":{"branch":"main"}}}',
    '{"timestamp":"2026-07-30T13:00:01.000Z","type":"turn_context","payload":{"cwd":"/workspace/repo"}}',
  ].join("\n");

  assert.equal(
    parseCodexSession({ sourcePath: "empty-events.jsonl", raw }),
    null,
  );
});
