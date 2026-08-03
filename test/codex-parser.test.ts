import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
  type Confidence,
  makeSessionRef,
  type ResultStatusSource,
  type ToolResultEvent,
  type ToolResultStatus,
} from "../src/core/model.js";
import { parseCodexSession } from "../src/sources/codex/parser.js";
import { ParserBudgetExceededError } from "../src/sources/jsonl-budget.js";

const fixturePath = (name: string): string =>
  resolve(process.cwd(), "test", "fixtures", "codex", name);

/**
 * Writes `raw` to `<tempdir>/<name>` so path-based parsing sees the intended
 * file name (the parser falls back to the file name stem for the session id).
 * The temp directory is removed when the test finishes.
 */
async function tempRollout(
  t: TestContext,
  name: string,
  raw: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccprof-codex-parser-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  await writeFile(path, raw);
  return path;
}

function assertStatusEvidence(
  result: ToolResultEvent,
  status: ToolResultStatus,
  source: ResultStatusSource,
  confidence: Confidence,
): void {
  assert.equal(result.status, status);
  assert.equal(result.status_evidence?.status, status);
  assert.equal(result.status_evidence?.source, source);
  assert.equal(result.status_evidence?.confidence, confidence);
}

function budgetCodexMeta(): string {
  return JSON.stringify({
    timestamp: "2026-07-31T19:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "budget-codex",
      cwd: "/workspace/repo",
      git: { branch: "feature/budget" },
    },
  });
}

function budgetCodexMessage(index: number): string {
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 6, 31, 19, 1, index)).toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: `message-${index}`,
    },
  });
}

test("returns null when there is no parseable content", async (t) => {
  assert.equal(
    await parseCodexSession({
      sourcePath: await tempRollout(t, "empty.jsonl", ""),
    }),
    null,
  );
  assert.equal(
    await parseCodexSession({
      sourcePath: await tempRollout(t, "blank.jsonl", "   \n\n  "),
    }),
    null,
  );
  assert.equal(
    await parseCodexSession({
      sourcePath: await tempRollout(
        t,
        "garbage.jsonl",
        "not json at all\n{also not json",
      ),
    }),
    null,
  );
});

test("normalizes a well-formed Codex rollout into a Session", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
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

test("joins user message text parts and skips injected instruction text", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
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

test("joins assistant message content array parts and carries no token usage", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
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

test("maps exec_command/shell function_call rows into tool_use events", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
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

test("maps function_call_output rows into tool_result events with exit-code status", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
  });
  assert.ok(session);

  const results = session.events.filter((event) => event.kind === "tool_result");
  assert.equal(results.length, 2);
  assert.ok(
    results.every((result) => result.status_evidence?.status === result.status),
  );

  const success = results.find(
    (event) => event.kind === "tool_result" && event.tool_use_id === "call-1",
  );
  assert.ok(success && success.kind === "tool_result");
  assert.equal(success.status, "success");
  assertStatusEvidence(success, "success", "exit_code", "high");
  assert.equal(success.exit_code, 0);
  assert.equal(success.output, "Process exited with code 0\nok  \tpkg/health\t0.004s");
  assert.equal(success.output_bytes, Buffer.byteLength(success.output));
  assert.equal(success.estimated_tokens, Math.ceil(success.output.length / 4));

  const failure = results.find(
    (event) => event.kind === "tool_result" && event.tool_use_id === "call-2",
  );
  assert.ok(failure && failure.kind === "tool_result");
  assert.equal(failure.status, "failure");
  assertStatusEvidence(failure, "failure", "tool_adapter", "medium");
  assert.equal(failure.exit_code, 1);
  assert.equal(
    failure.output,
    "Process exited with code 1\nvet: pkg/health/health.go:12: undeclared name: Ping",
  );
});

test("ignores reasoning, event_msg, and turn_context rows", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
  });
  assert.ok(session);
  // 1 user + 2 assistant + 3 tool_use + 2 tool_result = 8 events total.
  assert.equal(session.events.length, 8);
});

test("degrades malformed rows to warnings instead of throwing", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("session-basic.jsonl"),
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

test("falls back to the file name stem and low confidence when session_meta is absent", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("no-session-meta.jsonl"),
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

test("does not infer success or failure from result text alone", async (t) => {
  const raw = [
    '{"timestamp":"2026-07-30T11:00:00.000Z","type":"session_meta","payload":{"id":"unknown-exit-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T11:00:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-x","output":"Tests failed: connection refused"}}',
  ].join("\n");

  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "unknown-exit.jsonl", raw),
  });
  assert.ok(session);

  const result = session.events.find((event) => event.kind === "tool_result");
  assert.ok(result && result.kind === "tool_result");
  assertStatusEvidence(result, "unknown", "none", "low");
  assert.equal(result.exit_code, undefined);
  assert.equal(result.output, "Tests failed: connection refused");
});

test("skips function_call rows missing call_id/name and function_call_output rows missing output, warning instead of throwing", async (t) => {
  const raw = [
    '{"timestamp":"2026-07-30T12:00:00.000Z","type":"session_meta","payload":{"id":"missing-fields-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T12:00:01.000Z","type":"response_item","payload":{"type":"function_call","arguments":"{}"}}',
    '{"timestamp":"2026-07-30T12:00:02.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-missing-output"}}',
    '{"timestamp":"2026-07-30T12:00:03.000Z","type":"response_item","payload":{"type":"message","role":"user","content":"Keep the session alive."}}',
  ].join("\n");

  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "missing-fields.jsonl", raw),
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

test("does not fabricate an exit code from a quoted phrase mid-output", async (t) => {
  const raw = [
    '{"timestamp":"2026-07-30T14:00:00.000Z","type":"session_meta","payload":{"id":"quoted-phrase-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T14:00:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-quoted","output":"cat ci.log\\nsome earlier line\\nProcess exited with code 1\\nthat line was quoted from an old log, not this run status"}}',
  ].join("\n");

  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "quoted-phrase.jsonl", raw),
  });
  assert.ok(session);

  const result = session.events.find((event) => event.kind === "tool_result");
  assert.ok(result && result.kind === "tool_result");
  assertStatusEvidence(result, "unknown", "none", "low");
  assert.equal(result.exit_code, undefined);
});

test("prefers metadata.exit_code over text scanning, even when the text does not match", async (t) => {
  const raw = [
    '{"timestamp":"2026-07-30T15:00:00.000Z","type":"session_meta","payload":{"id":"metadata-exit-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T15:00:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-meta","output":"{\\"output\\":\\"no matching phrase here\\",\\"metadata\\":{\\"exit_code\\":2}}"}}',
  ].join("\n");

  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "metadata-exit.jsonl", raw),
  });
  assert.ok(session);

  const result = session.events.find((event) => event.kind === "tool_result");
  assert.ok(result && result.kind === "tool_result");
  assertStatusEvidence(result, "failure", "exit_code", "high");
  assert.equal(result.exit_code, 2);
  assert.equal(result.output, "no matching phrase here");
});

test("validates metadata exit codes and gives them precedence over runner banners", async (t) => {
  const raw = [
    '{"timestamp":"2026-07-30T15:30:00.000Z","type":"session_meta","payload":{"id":"metadata-validation","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T15:30:01.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"malformed","output":"{\\"output\\":\\"failed\\",\\"metadata\\":{\\"exit_code\\":\\"2\\"}}"}}',
    '{"timestamp":"2026-07-30T15:30:02.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"conflict","output":"{\\"output\\":\\"Process exited with code 9\\\\nfailed\\",\\"metadata\\":{\\"exit_code\\":0}}"}}',
  ].join("\n");
  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "metadata-validation.jsonl", raw),
  });
  assert.ok(session);

  const results = session.events.filter(
    (event): event is ToolResultEvent => event.kind === "tool_result",
  );
  assert.equal(results[0]?.status, "unknown");
  assertStatusEvidence(results[0]!, "unknown", "none", "low");
  assert.equal(results[0]?.exit_code, undefined);
  assert.equal(results[1]?.status, "success");
  assertStatusEvidence(results[1]!, "success", "exit_code", "high");
  assert.equal(results[1]?.exit_code, 0);
});

test("extracts edit paths and fragments from apply_patch file headers", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("apply-patch.jsonl"),
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

test("warns and leaves paths empty when an apply_patch body has no file headers", async () => {
  const session = await parseCodexSession({
    sourcePath: fixturePath("apply-patch.jsonl"),
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

test("deduplicates and trims repeated apply_patch header paths", async (t) => {
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

  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "apply-patch-dedupe.jsonl", raw),
  });
  assert.ok(session);

  const patchCall = session.events.find((event) => event.kind === "tool_use");
  assert.ok(patchCall && patchCall.kind === "tool_use");
  assert.deepEqual(patchCall.paths, ["src/app/health.ts"]);
});

test("warns once per distinct unknown response_item subtype without affecting events", async (t) => {
  const raw = [
    '{"timestamp":"2026-07-30T16:00:00.000Z","type":"session_meta","payload":{"id":"unknown-subtype-session","cwd":"/workspace/repo"}}',
    '{"timestamp":"2026-07-30T16:00:01.000Z","type":"response_item","payload":{"type":"local_shell_call","call_id":"call-a","status":"completed"}}',
    '{"timestamp":"2026-07-30T16:00:02.000Z","type":"response_item","payload":{"type":"local_shell_call","call_id":"call-b","status":"completed"}}',
    '{"timestamp":"2026-07-30T16:00:03.000Z","type":"response_item","payload":{"type":"message","role":"user","content":"Keep the session alive."}}',
  ].join("\n");

  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "unknown-subtype.jsonl", raw),
  });
  assert.ok(session);

  assert.equal(session.events.length, 1);
  assert.equal(session.events[0]?.kind, "genuine_user");

  const unknownSubtypeWarnings = session.warnings.filter(
    (warning) => warning.code === "codex_unknown_response_item",
  );
  assert.equal(unknownSubtypeWarnings.length, 1);
  assert.match(unknownSubtypeWarnings[0]?.message ?? "", /local_shell_call/u);
});

test("returns null for a session with a valid session_meta but zero emitted events", async (t) => {
  const raw = [
    '{"timestamp":"2026-07-30T13:00:00.000Z","type":"session_meta","payload":{"id":"empty-events-session","cwd":"/workspace/repo","git":{"branch":"main"}}}',
    '{"timestamp":"2026-07-30T13:00:01.000Z","type":"turn_context","payload":{"cwd":"/workspace/repo"}}',
  ].join("\n");

  assert.equal(
    await parseCodexSession({
      sourcePath: await tempRollout(t, "empty-events.jsonl", raw),
    }),
    null,
  );
});

test("freezes Codex rows after timestamp validation at an inclusive boundary", async (t) => {
  const cutoff = Date.parse("2026-07-31T12:00:00.000Z");
  const row = (timestamp: unknown, type?: unknown, payload?: unknown) =>
    JSON.stringify({ timestamp: typeof timestamp === "number"
      ? new Date(timestamp).toISOString() : timestamp,
      ...(type === undefined ? {} : { type }),
      ...(payload === undefined ? {} : { payload }) });
  const raw = [
    row(cutoff + 1, "session_meta", { id: "future", cwd: "/future",
      git: { branch: "feature/future" } }),
    row(cutoff - 2, "session_meta", { id: "frozen", cwd: "/frozen",
      git: { branch: "feature/frozen" } }),
    row(cutoff, "response_item", { type: "function_call", name: "shell",
      call_id: "call", arguments: "{\"command\":\"true\"}" }),
    row(cutoff + 2, "response_item", { type: "function_call_output",
      call_id: "call", output: "future result" }),
    row(cutoff + 3, undefined, { invalid: true }),
    row(cutoff - 1, "response_item", { type: "message", role: "user",
      content: "out of order" }),
    row("invalid"),
    JSON.stringify({ type: "response_item", payload: {} }),
  ].join("\n");

  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "snapshot.jsonl", raw),
    endedAtMs: cutoff,
  });
  assert.ok(session);
  assert.equal(session.session_id, "frozen");
  assert.equal(session.confidence, "high");
  assert.deepEqual(session.observed_cwds, ["/frozen"]);
  assert.deepEqual(session.observed_branches, ["feature/frozen"]);
  assert.equal(session.ended_at_ms, cutoff);
  assert.deepEqual(session.events.map(({ kind, source_index }) => [kind, source_index]),
    [["tool_use", 3], ["genuine_user", 6]]);
  assert.equal(session.events.some((event) => event.kind === "tool_result"), false);
  assert.deepEqual(session.warnings.map(({ code, line }) => [code, line]),
    [["codex_row_invalid", 7], ["codex_row_invalid", 8]]);
});

test("prefers event workdir, then event cwd, then session metadata cwd", async (t) => {
  const call = (id: string, input: Record<string, unknown>): string =>
    JSON.stringify({
      timestamp: `2026-07-31T13:00:0${id}.000Z`,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: `call-${id}`,
        arguments: JSON.stringify(input),
      },
    });
  const raw = [
    '{"timestamp":"2026-07-31T13:00:00.000Z","type":"session_meta","payload":{"id":"cwd-priority","cwd":"/metadata/repo"}}',
    call("1", { cmd: "pwd", workdir: "/event/workdir", cwd: "/event/cwd" }),
    call("2", { cmd: "pwd", workdir: "  ", cwd: "/event/cwd" }),
    call("3", { cmd: "pwd", workdir: "", cwd: "  " }),
  ].join("\n");
  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "cwd-priority.jsonl", raw),
  });
  assert.ok(session);
  const toolCwds = session.events
    .filter((event) => event.kind === "tool_use")
    .map((event) => event.kind === "tool_use" ? event.cwd : undefined);
  assert.deepEqual(toolCwds, [
    "/event/workdir",
    "/event/cwd",
    "/metadata/repo",
  ]);
  assert.deepEqual(session.observed_cwds, [
    "/metadata/repo",
    "/event/workdir",
    "/event/cwd",
  ]);
});

test("does not invent a cwd when event and session metadata omit it", async (t) => {
  const raw = JSON.stringify({
    timestamp: "2026-07-31T14:00:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "call-missing-cwd",
      arguments: JSON.stringify({ cmd: "pwd" }),
    },
  });

  const session = await parseCodexSession({
    sourcePath: await tempRollout(t, "missing-cwd.jsonl", raw),
  });
  assert.ok(session);
  const tool = session.events.find((event) => event.kind === "tool_use");
  assert.ok(tool?.kind === "tool_use");
  assert.equal(tool.cwd, undefined);
  assert.deepEqual(session.observed_cwds, []);
});

test("Codex parser accepts the exact file-byte limit and rejects an empty over-budget prefix", async (t) => {
  const metadata = budgetCodexMeta();
  const message = budgetCodexMessage(0);
  const raw = `${metadata}\n${message}`;
  const exactBytes = Buffer.byteLength(raw);
  const path = await tempRollout(t, "file-budget.jsonl", raw);

  const exact = await parseCodexSession({
    sourcePath: path,
    budgets: { maxFileBytes: exactBytes },
  });
  assert.equal(exact?.events.length, 1);

  await assert.rejects(
    parseCodexSession({
      sourcePath: path,
      budgets: { maxFileBytes: exactBytes - 1 },
    }),
    (error) =>
      error instanceof ParserBudgetExceededError && error.budget === "file",
  );
});

test("Codex parser applies budgets to nested function-call arguments", async (t) => {
  let nested: unknown = "deep";
  for (let depth = 0; depth < 16; depth += 1) nested = { child: nested };
  const functionCall = (callId: string, input: unknown): string => JSON.stringify({
    timestamp: "2026-07-31T18:02:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: callId,
      arguments: JSON.stringify(input),
    },
  });
  const path = await tempRollout(
    t,
    "nested-argument-budget.jsonl",
    `${[
      budgetCodexMeta(),
      functionCall("deep-call", { cmd: "true", nested }),
      functionCall("wide-call", {
        cmd: "true",
        items: Array.from({ length: 64 }, () => 1),
      }),
      budgetCodexMessage(0),
    ].join("\n")}\n`,
  );

  const session = await parseCodexSession({
    sourcePath: path,
    budgets: { maxNestingDepth: 4, maxNodesPerLine: 32 },
  });

  assert.ok(session);
  assert.equal(session.events.some(
    (event) => event.kind === "tool_use" && event.tool_use_id === "deep-call",
  ), false);
  assert.equal(session.events.some(
    (event) => event.kind === "tool_use" && event.tool_use_id === "wide-call",
  ), false);
  assert.ok(session.events.some((event) => event.kind === "genuine_user"));
  assert.ok(session.warnings.some(
    (warning) => warning.code === "parser_depth_budget_exceeded" && warning.line === 2,
  ));
  assert.ok(session.warnings.some(
    (warning) => warning.code === "parser_node_budget_exceeded" && warning.line === 3,
  ));
});

test("Codex parser bounds a generated large rollout by retained bytes", async (t) => {
  const metadata = budgetCodexMeta();
  const messages = Array.from({ length: 20_000 }, (_, index) =>
    budgetCodexMessage(index)
  );
  const retainedMessages = messages.slice(0, 64);
  const retainedBytes = [metadata, ...retainedMessages]
    .reduce((total, row) => total + Buffer.byteLength(row), 0);
  const path = await tempRollout(
    t,
    "large-budget.jsonl",
    `${metadata}\n${messages.join("\n")}\n`,
  );

  const session = await parseCodexSession({
    sourcePath: path,
    budgets: {
      maxRetainedBytes: retainedBytes,
      maxWarnings: 4,
    },
  });

  assert.ok(session);
  assert.equal(session.events.length, 64);
  assert.deepEqual(
    session.events.map((event) => event.entry_uuid),
    Array.from({ length: 64 }, (_, index) => `line-${index + 2}`),
  );
  assert.ok(session.warnings.length <= 4);
  assert.ok(session.warnings.some(
    (warning) => warning.code === "parser_byte_budget_exceeded",
  ));
});

test("Codex parser caps malformed-row warning floods", async (t) => {
  const malformed = Array.from({ length: 10_000 }, () => "{");
  const path = await tempRollout(
    t,
    "warning-budget.jsonl",
    `${malformed.join("\n")}\n${budgetCodexMeta()}\n${budgetCodexMessage(0)}\n`,
  );
  const session = await parseCodexSession({
    sourcePath: path,
    budgets: { maxWarnings: 4 },
  });

  assert.ok(session);
  assert.equal(session.warnings.length, 4);
  assert.equal(session.warnings.at(-1)?.code, "parser_warning_budget_exceeded");
});

test("Codex parser validates budgets and propagates AbortSignal cancellation", async (t) => {
  const path = await tempRollout(
    t,
    "abort-budget.jsonl",
    `${budgetCodexMeta()}\n${budgetCodexMessage(0)}\n`,
  );
  await assert.rejects(
    parseCodexSession({ sourcePath: path, budgets: { maxNestingDepth: -1 } }),
    /maxNestingDepth/u,
  );

  const controller = new AbortController();
  controller.abort(new Error("stop Codex parsing"));
  await assert.rejects(
    parseCodexSession({ sourcePath: path, signal: controller.signal }),
    /stop Codex parsing/u,
  );
});

test("Codex parser preserves a budget-shaped mid-read abort reason", async (t) => {
  const raw = `${budgetCodexMeta()}\n${Array.from({ length: 2_000 }, (_, index) =>
    budgetCodexMessage(index)).join("\n")}\n`;
  const path = await tempRollout(t, "mid-read-abort.jsonl", raw);
  const controller = new AbortController();
  const reason = new ParserBudgetExceededError("node", 999);
  let budgetReads = 0;
  Object.defineProperty(reason, "budget", {
    configurable: true,
    get: () => {
      budgetReads += 1;
      return "node";
    },
  });
  const originalThrowIfAborted = controller.signal.throwIfAborted.bind(
    controller.signal,
  );
  let checks = 0;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    configurable: true,
    value: () => {
      checks += 1;
      if (checks === 6) controller.abort(reason);
      originalThrowIfAborted();
    },
  });

  const parsing = parseCodexSession({
    sourcePath: path,
    signal: controller.signal,
  });
  await assert.rejects(parsing, (error) => error === reason);
  assert.equal(budgetReads, 0);
});
