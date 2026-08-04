import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { renameSync, writeFileSync } from "node:fs";
import {
  appendFile,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  type ClaudeParserStateV1,
  IncrementalParserStateCapacityError,
  MAX_INCREMENTAL_PARSER_STATE_BYTES,
  normalizeClaudeParserState,
  parseClaudeTranscriptDetailed,
  projectClaudeParserState,
  readClaudeParserState,
} from "../src/sources/claude/parser.js";
import {
  type CodexParserStateV1,
  normalizeCodexParserState,
  parseCodexSession,
  projectCodexParserState,
  readCodexParserState,
} from "../src/sources/codex/parser.js";
import {
  boundedJsonlLines,
  IncrementalParserStateByteTracker,
  JsonlBudgetTracker,
  type ParserProjectionBudgets,
  type ParserReadBudgets,
} from "../src/sources/jsonl-budget.js";

const SHA256_PREFIX = "sha256:";

function digest(value: string | Buffer): string {
  return `${SHA256_PREFIX}${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function assertCanonicalEqual(actual: unknown, expected: unknown): void {
  assert.deepEqual(canonicalBytes(actual), canonicalBytes(expected));
}

async function tempJsonl(
  t: TestContext,
  name: string,
  raw: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-parser-state-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  await writeFile(path, raw);
  return path;
}

async function drain<T, R>(
  iterator: AsyncGenerator<T, R>,
): Promise<{ values: T[]; result: R }> {
  const values: T[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return { values, result: next.value };
    values.push(next.value);
  }
}

function at(second: number): string {
  return new Date(Date.UTC(2026, 7, 1, 0, 0, second)).toISOString();
}

function claudeUser(
  sessionId: string,
  uuid: string,
  second: number,
  content: unknown,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    sessionId,
    cwd: "/workspace/repo",
    type: "user",
    uuid,
    timestamp: at(second),
    message: { role: "user", content },
    ...extra,
  });
}

function claudeAssistant(
  sessionId: string,
  uuid: string,
  messageId: string,
  second: number,
  content: unknown[],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    sessionId,
    cwd: "/workspace/repo",
    type: "assistant",
    uuid,
    timestamp: at(second),
    message: {
      id: messageId,
      role: "assistant",
      content,
      usage: { input_tokens: 10, output_tokens: 2 },
    },
    ...extra,
  });
}

function codexRow(
  second: number,
  type: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({ timestamp: at(second), type, payload });
}

async function readClaudeState(
  path: string,
  options: {
    range?: { start_offset: number; starting_line: number };
    seed?: ClaudeParserStateV1;
    budgets?: Partial<ParserReadBudgets>;
  } = {},
) {
  const fileHandle = await open(path, "r");
  try {
    return await readClaudeParserState({
      sourcePath: path,
      fileHandle,
      ...options,
    });
  } finally {
    await fileHandle.close();
  }
}

async function readCodexState(
  path: string,
  options: {
    range?: { start_offset: number; starting_line: number };
    seed?: CodexParserStateV1;
    budgets?: Partial<ParserReadBudgets>;
  } = {},
) {
  const fileHandle = await open(path, "r");
  try {
    return await readCodexParserState({
      sourcePath: path,
      fileHandle,
      ...options,
    });
  } finally {
    await fileHandle.close();
  }
}

async function assertClaudePublicStateRoundTrip(
  path: string,
): Promise<{
  state: ClaudeParserStateV1;
  parsed: Awaited<ReturnType<typeof parseClaudeTranscriptDetailed>>;
}> {
  const read = await readClaudeState(path);
  const fresh = projectClaudeParserState(read.state);
  const restored = normalizeClaudeParserState(
    JSON.parse(JSON.stringify(read.state)) as unknown,
  );
  const roundTripped = projectClaudeParserState(restored);
  const parsed = await parseClaudeTranscriptDetailed(path);

  assertCanonicalEqual(fresh, parsed);
  assertCanonicalEqual(roundTripped, parsed);
  return { state: read.state, parsed };
}

async function assertCodexPublicStateRoundTrip(
  path: string,
): Promise<{
  state: CodexParserStateV1;
  parsed: Awaited<ReturnType<typeof parseCodexSession>>;
}> {
  const read = await readCodexState(path);
  const fresh = projectCodexParserState(read.state);
  const restored = normalizeCodexParserState(
    JSON.parse(JSON.stringify(read.state)) as unknown,
  );
  const roundTripped = projectCodexParserState(restored);
  const parsed = await parseCodexSession({ sourcePath: path });

  assertCanonicalEqual(fresh, parsed);
  assertCanonicalEqual(roundTripped, parsed);
  return { state: read.state, parsed };
}

test("reads an exact UTF-8 range from the supplied handle without reopening its path", async (t) => {
  const jsonPrefix = "{\"value\":\"";
  const boundaryText = `${"a".repeat(
    65_535 - Buffer.byteLength(jsonPrefix),
  )}界`;
  const firstLine = `${jsonPrefix}${boundaryText}\"}`;
  const secondLine = JSON.stringify({ value: "emoji 🙂 remains intact" });
  const original = `${firstLine}\r\n${secondLine}\n`;
  const path = await tempJsonl(t, "same-handle.jsonl", original);
  const heldPath = `${path}.held`;
  const fileHandle = await open(path, "r");

  try {
    await rename(path, heldPath);
    await writeFile(path, `${JSON.stringify({ replacement: true })}\n`);
    const tracker = new JsonlBudgetTracker();
    const read = await drain(boundedJsonlLines(path, tracker, {
      file_handle: fileHandle,
      start_offset: 0,
      starting_line: 41,
    }));

    assert.deepEqual(read.values, [
      { text: firstLine, bytes: Buffer.byteLength(firstLine), line: 41 },
      { text: secondLine, bytes: Buffer.byteLength(secondLine), line: 42 },
    ]);
    assert.deepEqual(read.result, {
      start_offset: 0,
      end_offset: Buffer.byteLength(original),
      bytes_read: Buffer.byteLength(original),
      digest: digest(original),
    });
    assert.equal((await fileHandle.stat()).size, Buffer.byteLength(original));
  } finally {
    await fileHandle.close();
  }
});

test("T1 keeps an earlier Claude projection identical across cold, fresh, restored, and suffix state", async (t) => {
  const cutoff = Date.parse(at(2));
  const prefixRows = [
    claudeUser("t1", "early-user", 0, "early request"),
    claudeAssistant("t1", "early-assistant", "evolving", 1, [
      { type: "text", text: "before cutoff" },
    ]),
  ];
  const suffixRows = [
    claudeAssistant("t1", "late-revision", "evolving", 3, [
      { type: "text", text: `before cutoff${" late".repeat(256)}` },
    ], { gitBranch: "feature/future" }),
    ...Array.from({ length: 4 }, (_, index) =>
      claudeAssistant("t1", `late-warning-${index}`, `warning-${index}`, 4 + index, [
        { type: "future_block", payload: "x".repeat(512) },
      ], { gitBranch: "feature/future" })
    ),
    JSON.stringify({
      timestamp: at(8),
      type: "user",
      message: { role: "user", content: "missing session" },
    }),
  ];
  const prefixRaw = `${prefixRows.join("\n")}\n`;
  const suffixRaw = `${suffixRows.join("\n")}\n`;
  const path = await tempJsonl(t, "t1.jsonl", prefixRaw);
  const seed = await readClaudeState(path);

  await appendFile(path, suffixRaw);
  const suffix = await readClaudeState(path, {
    range: {
      start_offset: Buffer.byteLength(prefixRaw),
      starting_line: prefixRows.length + 1,
    },
    seed: seed.state,
  });
  const fresh = await readClaudeState(path);
  const restored = normalizeClaudeParserState(
    JSON.parse(JSON.stringify(fresh.state)) as unknown,
  );
  const budgets = {
    maxRetainedBytes: prefixRows.reduce(
      (total, row) => total + Buffer.byteLength(row),
      0,
    ),
    maxWarnings: 1,
  } satisfies Partial<ParserProjectionBudgets>;
  const cold = await parseClaudeTranscriptDetailed(path, {
    endedAtMs: cutoff,
    budgets,
  });
  const projections = [fresh.state, restored, suffix.state].map((state) =>
    projectClaudeParserState(state, { endedAtMs: cutoff, budgets })
  );

  for (const projected of projections) assertCanonicalEqual(projected, cold);
  assert.ok(fresh.state.warnings.length > budgets.maxWarnings);
  assert.ok(
    fresh.state.rows.reduce((total, row) => total + row.original_bytes, 0) >
      budgets.maxRetainedBytes,
  );
  assert.deepEqual(
    projections[0]?.sessions[0]?.observed_branches,
    cold.sessions[0]?.observed_branches,
  );
  assert.equal(suffix.receipt.start_offset, Buffer.byteLength(prefixRaw));
  assert.equal(suffix.receipt.end_offset, Buffer.byteLength(prefixRaw + suffixRaw));
  assert.equal(suffix.receipt.digest, digest(suffixRaw));
});

test("T2 restores one complete Codex state and projects a later window without reading the file", async (t) => {
  const rows = [
    codexRow(0, "session_meta", {
      id: "t2",
      cwd: "/workspace/repo",
      git: { branch: "feature/t2" },
    }),
    codexRow(1, "response_item", {
      type: "message",
      role: "user",
      content: "early",
    }),
    codexRow(5, "response_item", {
      type: "message",
      role: "assistant",
      content: "late",
    }),
  ];
  const raw = `${rows.join("\n")}\n`;
  const path = await tempJsonl(t, "t2.jsonl", raw);
  const earlyEnd = Date.parse(at(1));
  const lateEnd = Date.parse(at(5));
  let stateReaderCalls = 0;
  const fileHandle = await open(path, "r");
  let complete;
  try {
    stateReaderCalls += 1;
    complete = await readCodexParserState({ sourcePath: path, fileHandle });
  } finally {
    await fileHandle.close();
  }
  const coldEarly = await parseCodexSession({ sourcePath: path, endedAtMs: earlyEnd });
  const restored = normalizeCodexParserState(
    JSON.parse(JSON.stringify(complete.state)) as unknown,
  );
  await rename(path, `${path}.offline`);

  const projectedEarly = projectCodexParserState(restored, {
    endedAtMs: earlyEnd,
  });
  const projectedLate = projectCodexParserState(restored, {
    endedAtMs: lateEnd,
  });

  assertCanonicalEqual(projectedEarly, coldEarly);
  assert.equal(projectedEarly?.events.length, 1);
  assert.equal(projectedLate?.events.length, 2);
  assert.ok(projectedLate?.events.some((event) => event.kind === "assistant"));
  assert.equal(stateReaderCalls, 1);
});

test("Codex public parsing matches fresh and round-tripped state with NUL-bearing response fields", async (t) => {
  const nul = "\0";

  await t.test("message content", async (t) => {
    const message = `before${nul}after`;
    const path = await tempJsonl(
      t,
      "codex-nul-message.jsonl",
      `${[
        codexRow(0, "session_meta", {
          id: "codex-nul-message",
          cwd: "/workspace/repo",
        }),
        codexRow(1, "response_item", {
          type: "message",
          role: "assistant",
          content: message,
        }),
      ].join("\n")}\n`,
    );
    const { state, parsed } = await assertCodexPublicStateRoundTrip(path);
    const row = state.rows.find((candidate) =>
      candidate.type === "response_item" && candidate.payload.kind === "message"
    );

    assert.equal(row?.payload.kind === "message" && row.payload.content, message);
    assert.ok(parsed?.events.some((event) =>
      event.kind === "assistant" && event.text === message
    ));
  });

  await t.test("function-call output", async (t) => {
    const output = `line one${nul}line two`;
    const path = await tempJsonl(
      t,
      "codex-nul-function-output.jsonl",
      `${[
        codexRow(0, "session_meta", {
          id: "codex-nul-output",
          cwd: "/workspace/repo",
        }),
        codexRow(1, "response_item", {
          type: "function_call",
          name: "exec_command",
          call_id: "call-nul-output",
          arguments: JSON.stringify({ cmd: "true" }),
        }),
        codexRow(2, "response_item", {
          type: "function_call_output",
          call_id: "call-nul-output",
          output,
        }),
      ].join("\n")}\n`,
    );
    const { state, parsed } = await assertCodexPublicStateRoundTrip(path);
    const row = state.rows.find((candidate) =>
      candidate.type === "response_item" &&
      candidate.payload.kind === "function_call_output"
    );

    assert.equal(
      row?.payload.kind === "function_call_output" &&
        row.payload.output.kind === "text" && row.payload.output.value,
      output,
    );
    assert.ok(parsed?.events.some((event) =>
      event.kind === "tool_result" && event.output === output
    ));
  });

  await t.test("function-call arguments", async (t) => {
    const args = `{"cmd":"before${nul}after"}`;
    const path = await tempJsonl(
      t,
      "codex-nul-function-arguments.jsonl",
      `${[
        codexRow(0, "session_meta", {
          id: "codex-nul-arguments",
          cwd: "/workspace/repo",
        }),
        codexRow(1, "response_item", {
          type: "function_call",
          name: "exec_command",
          call_id: "call-nul-arguments",
          arguments: args,
        }),
      ].join("\n")}\n`,
    );
    const { state } = await assertCodexPublicStateRoundTrip(path);
    const row = state.rows.find((candidate) =>
      candidate.type === "response_item" &&
      candidate.payload.kind === "function_call"
    );

    assert.equal(
      row?.payload.kind === "function_call" &&
        row.payload.arguments.kind === "text" && row.payload.arguments.value,
      args,
    );
  });
});

test("Claude public parsing matches fresh and round-tripped state with NUL-bearing event text", async (t) => {
  const nul = "\0";

  await t.test("assistant text", async (t) => {
    const text = `before${nul}after`;
    const path = await tempJsonl(
      t,
      "claude-nul-assistant.jsonl",
      `${claudeAssistant(
        "claude-nul-assistant",
        "assistant-nul",
        "message-nul",
        0,
        [{ type: "text", text }],
      )}\n`,
    );
    const { state, parsed } = await assertClaudePublicStateRoundTrip(path);
    const row = state.rows.find((candidate) =>
      candidate.value.type === "assistant"
    );
    const content = row?.value.type === "assistant"
      ? row.value.message.content
      : null;

    assert.ok(Array.isArray(content));
    const firstBlock = content[0];
    assert.deepEqual(firstBlock, { type: "text", text });
    assert.ok(parsed.sessions.some((session) =>
      session.events.some((event) =>
        event.kind === "assistant" && event.text === text
      )
    ));
  });

  await t.test("tool output", async (t) => {
    const output = `first${nul}second`;
    const path = await tempJsonl(
      t,
      "claude-nul-tool-output.jsonl",
      `${[
        claudeAssistant(
          "claude-nul-output",
          "assistant-tool",
          "message-tool",
          0,
          [{
            type: "tool_use",
            id: "tool-nul-output",
            name: "Bash",
            input: { command: "true" },
          }],
        ),
        claudeUser("claude-nul-output", "result-nul", 1, [{
          type: "tool_result",
          tool_use_id: "tool-nul-output",
          content: output,
        }]),
      ].join("\n")}\n`,
    );
    const { state, parsed } = await assertClaudePublicStateRoundTrip(path);

    assert.ok(state.rows.some((row) =>
      row.tool_results.some((result) => result.output === output)
    ));
    assert.ok(parsed.sessions.some((session) =>
      session.events.some((event) =>
        event.kind === "tool_result" && event.output === output
      )
    ));
  });
});

test("Claude public parsing matches fresh and round-tripped state for a finite negative numeric timestamp", async (t) => {
  const rawTimestamp = -1.75;
  const path = await tempJsonl(
    t,
    "claude-negative-timestamp.jsonl",
    `${JSON.stringify({
      sessionId: "claude-negative-timestamp",
      cwd: "/workspace/repo",
      type: "user",
      uuid: "negative-timestamp",
      timestamp: rawTimestamp,
      message: { role: "user", content: "before the Unix epoch" },
    })}\n`,
  );
  const { state, parsed } = await assertClaudePublicStateRoundTrip(path);

  assert.equal(state.rows[0]?.timestamp_ms, Math.trunc(rawTimestamp));
  assert.equal(
    parsed.sessions[0]?.events[0]?.timestamp_ms,
    Math.trunc(rawTimestamp),
  );
});

test("Claude public parsing matches fresh and round-tripped state when a negative timestamp gates a warning", async (t) => {
  const rawTimestamp = -1.75;
  const path = await tempJsonl(
    t,
    "claude-negative-warning-timestamp.jsonl",
    `${JSON.stringify({
      cwd: "/workspace/repo",
      type: "user",
      uuid: "negative-warning-timestamp",
      timestamp: rawTimestamp,
      message: { role: "user", content: "missing session before the epoch" },
    })}\n`,
  );
  const { state, parsed } = await assertClaudePublicStateRoundTrip(path);

  assert.deepEqual(state.rows, []);
  assert.deepEqual(
    state.warnings.map(({ applicability, warning }) => ({
      applicability,
      code: warning.code,
    })),
    [{
      applicability: {
        kind: "timestamp",
        timestamp_ms: Math.trunc(rawTimestamp),
      },
      code: "missing_session_id",
    }],
  );
  assert.deepEqual(parsed.sessions, []);
  assert.deepEqual(
    parsed.warnings.map(({ code }) => code),
    ["missing_session_id"],
  );
});

test("Claude unsafe numeric timestamps stay out of state with existing invalid-timestamp and missing-session warnings", async (t) => {
  const unsafeTimestamp = 9_007_199_254_740_992;
  const rows = [
    {
      sessionId: "claude-unsafe-timestamp",
      cwd: "/workspace/repo",
      type: "user",
      uuid: "unsafe-timestamp-with-session",
      timestamp: unsafeTimestamp,
      message: { role: "user", content: "unsafe timestamp" },
    },
    {
      cwd: "/workspace/repo",
      type: "user",
      uuid: "unsafe-timestamp-without-session",
      timestamp: unsafeTimestamp,
      message: { role: "user", content: "unsafe timestamp and no session" },
    },
  ];
  const path = await tempJsonl(
    t,
    "claude-unsafe-timestamp.jsonl",
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const { state, parsed } = await assertClaudePublicStateRoundTrip(path);

  assert.deepEqual(state.rows, []);
  assert.deepEqual(
    state.warnings.map(({ applicability, warning }) => ({
      applicability,
      code: warning.code,
    })),
    [
      {
        applicability: { kind: "unconditional" },
        code: "invalid_timestamp",
      },
      {
        applicability: { kind: "unconditional" },
        code: "missing_session_id",
      },
    ],
  );
  assert.deepEqual(parsed.sessions, []);
  assert.deepEqual(
    parsed.warnings.map(({ code }) => code),
    ["invalid_timestamp", "missing_session_id"],
  );
});

test("Claude seeded state preserves branch lanes, cross-suffix ancestry, grouping, results, and multiple sessions", async (t) => {
  const prefixRows = [
    claudeAssistant("claude-a", "agent-parent", "agent-message", 0, [
      { type: "text", text: "Hel" },
    ], {
      agentId: "agent-x",
      parentUuid: "root",
      isSidechain: true,
      gitBranch: "feature/a",
    }),
    claudeAssistant("claude-a", "tool-owner", "tool-message", 1, [
      { type: "text", text: "run" },
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "true" } },
    ], { gitBranch: "feature/a", isSidechain: false }),
    claudeUser("claude-b", "second-session", 2, "second", {
      gitBranch: "feature/b",
      isSidechain: false,
    }),
  ];
  const suffixRows = [
    claudeAssistant("claude-a", "agent-child", "agent-message", 3, [
      { type: "text", text: "Hello" },
    ], {
      parentUuid: "agent-parent",
      isSidechain: true,
    }),
    JSON.stringify({
      sessionId: "claude-a",
      cwd: "/workspace/repo",
      gitBranch: "feature/c",
      type: "system",
      subtype: "turn_duration",
      durationMs: 5,
      timestamp: at(4),
    }),
    claudeUser("claude-a", "tool-result-1", 5, [
      { type: "tool_result", tool_use_id: "tool-1", content: "first" },
    ]),
    claudeUser("claude-a", "tool-result-2", 6, [
      { type: "tool_result", tool_use_id: "tool-1", content: "replacement" },
    ]),
  ];
  const prefixRaw = `${prefixRows.join("\n")}\n`;
  const suffixRaw = `${suffixRows.join("\n")}\n`;
  const path = await tempJsonl(t, "claude-continuation.jsonl", prefixRaw);
  const seed = await readClaudeState(path);
  await appendFile(path, suffixRaw);
  const merged = await readClaudeState(path, {
    range: {
      start_offset: Buffer.byteLength(prefixRaw),
      starting_line: prefixRows.length + 1,
    },
    seed: seed.state,
  });
  const fresh = await readClaudeState(path);
  const restored = normalizeClaudeParserState(
    JSON.parse(JSON.stringify(merged.state)) as unknown,
  );
  const cold = await parseClaudeTranscriptDetailed(path);

  assertCanonicalEqual(projectClaudeParserState(merged.state), cold);
  assertCanonicalEqual(projectClaudeParserState(fresh.state), cold);
  assertCanonicalEqual(projectClaudeParserState(restored), cold);
  assert.equal(cold.sessions.length, 2);
  const first = cold.sessions.find((session) => session.session_id === "claude-a");
  assert.ok(first);
  assert.equal(
    first.events.find((event) => event.entry_uuid === "agent-child")?.agent_id,
    "agent-x",
  );
  assert.ok(fresh.state.branch_lanes.length > 0);
  assert.ok(fresh.state.ancestry.length > 0);
  assert.ok(fresh.state.assistant_groups.length > 0);
  assert.ok(fresh.state.result_positions.length > 0);
  assert.deepEqual(
    fresh.state.rows.map((row) => row.original_bytes),
    [...prefixRows, ...suffixRows].map((row) => Buffer.byteLength(row)),
  );
});

test("Codex suffix state reuses metadata, deduplicates subtypes, and pairs calls with results", async (t) => {
  const prefixRows = [
    codexRow(0, "session_meta", {
      id: "codex-continuation",
      cwd: "/workspace/repo",
      git: { branch: "feature/codex" },
    }),
    codexRow(1, "response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: "call-1",
      arguments: JSON.stringify({ cmd: "npm test" }),
    }),
  ];
  const suffixRows = [
    codexRow(2, "response_item", {
      type: "function_call_output",
      call_id: "call-1",
      output: "Process exited with code 0\nok",
    }),
    codexRow(3, "response_item", {
      type: "local_shell_call",
      call_id: "unknown-a",
    }),
    codexRow(4, "response_item", {
      type: "local_shell_call",
      call_id: "unknown-b",
    }),
    codexRow(5, "response_item", {
      type: "message",
      role: "user",
      content: "done",
    }),
  ];
  const prefixRaw = `${prefixRows.join("\n")}\n`;
  const suffixRaw = `${suffixRows.join("\n")}\n`;
  const path = await tempJsonl(t, "codex-continuation.jsonl", prefixRaw);
  const seed = await readCodexState(path);
  await appendFile(path, suffixRaw);
  const merged = await readCodexState(path, {
    range: {
      start_offset: Buffer.byteLength(prefixRaw),
      starting_line: prefixRows.length + 1,
    },
    seed: seed.state,
  });
  const fresh = await readCodexState(path);
  const restored = normalizeCodexParserState(
    JSON.parse(JSON.stringify(merged.state)) as unknown,
  );
  const cold = await parseCodexSession({ sourcePath: path });

  assertCanonicalEqual(projectCodexParserState(merged.state), cold);
  assertCanonicalEqual(projectCodexParserState(fresh.state), cold);
  assertCanonicalEqual(projectCodexParserState(restored), cold);
  assert.equal(merged.state.session_metadata?.session_id, "codex-continuation");
  assert.deepEqual(merged.state.seen_subtypes, ["local_shell_call"]);
  assert.equal(
    cold?.warnings.filter((warning) =>
      warning.code === "codex_unknown_response_item"
    ).length,
    1,
  );
  assert.ok(cold?.events.some((event) =>
    event.kind === "tool_use" && event.tool_use_id === "call-1"
  ));
  assert.ok(cold?.events.some((event) =>
    event.kind === "tool_result" && event.tool_use_id === "call-1"
  ));
  assert.deepEqual(
    fresh.state.rows.map((row) => row.original_bytes),
    [...prefixRows, ...suffixRows].map((row) => Buffer.byteLength(row)),
  );
});

test("warning facts are ordered and windowed before warning saturation", async (t) => {
  const earlyMissingSession = JSON.stringify({
    timestamp: at(1),
    type: "user",
    message: { role: "user", content: "early invalid" },
  });
  const valid = claudeUser("warning-window", "valid", 2, "visible");
  const lateMissingSession = JSON.stringify({
    timestamp: at(8),
    type: "user",
    message: { role: "user", content: "late invalid" },
  });
  const raw = `{\n${earlyMissingSession}\n${valid}\n${lateMissingSession}\n`;
  const path = await tempJsonl(t, "warning-facts.jsonl", raw);
  const read = await readClaudeState(path);

  assert.deepEqual(read.state.warnings.map((fact) => fact.order), [0, 1, 2]);
  assert.deepEqual(
    read.state.warnings.map((fact) => fact.applicability.kind),
    ["unconditional", "timestamp", "timestamp"],
  );
  assert.deepEqual(
    read.state.warnings.map((fact) => fact.target_session_id),
    [null, null, null],
  );
  assert.equal(read.state.rows[0]?.original_bytes, Buffer.byteLength(valid));

  const early = projectClaudeParserState(read.state, {
    endedAtMs: Date.parse(at(2)),
    budgets: { maxWarnings: 2 },
  });
  const later = projectClaudeParserState(read.state, {
    endedAtMs: Date.parse(at(8)),
    budgets: { maxWarnings: 2 },
  });
  assert.deepEqual(early.warnings.map((warning) => warning.code), [
    "invalid_json",
    "missing_session_id",
  ]);
  assert.deepEqual(later.warnings.map((warning) => warning.code), [
    "invalid_json",
    "parser_warning_budget_exceeded",
  ]);
});

test("closed state normalizers reject unknown variants and inconsistent physical indexes", async (t) => {
  const claudePath = await tempJsonl(
    t,
    "closed-claude.jsonl",
    `${claudeUser("closed", "one", 0, "one")}\n${claudeUser("closed", "two", 1, "two")}\n`,
  );
  const codexPath = await tempJsonl(
    t,
    "closed-codex.jsonl",
    `${codexRow(0, "session_meta", { id: "closed", cwd: "/workspace/repo" })}\n${codexRow(1, "response_item", { type: "message", role: "user", content: "one" })}\n`,
  );
  const claude = await readClaudeState(claudePath);
  const codex = await readCodexState(codexPath);

  const unknownClaude = JSON.parse(JSON.stringify(claude.state)) as {
    kind: string;
  };
  unknownClaude.kind = "claude-state-v2";
  assert.throws(() => normalizeClaudeParserState(unknownClaude));

  const inconsistentClaude = JSON.parse(JSON.stringify(claude.state)) as {
    rows: Array<{ line: number }>;
  };
  assert.ok(inconsistentClaude.rows.length >= 2);
  inconsistentClaude.rows[1]!.line = inconsistentClaude.rows[0]!.line;
  assert.throws(() => normalizeClaudeParserState(inconsistentClaude));

  const unknownCodex = JSON.parse(JSON.stringify(codex.state)) as {
    rows: Array<Record<string, unknown>>;
  };
  unknownCodex.rows[0]!.unexpected = true;
  assert.throws(() => normalizeCodexParserState(unknownCodex));

  const inconsistentCodex = JSON.parse(JSON.stringify(codex.state)) as {
    rows: Array<{ byte_start: number; byte_end: number }>;
  };
  assert.ok(inconsistentCodex.rows.length >= 2);
  inconsistentCodex.rows[1]!.byte_start = inconsistentCodex.rows[0]!.byte_start;
  inconsistentCodex.rows[1]!.byte_end = inconsistentCodex.rows[0]!.byte_end;
  assert.throws(() => normalizeCodexParserState(inconsistentCodex));
});

test("physical row spans bind exact retained bytes for EOF, LF, and CRLF", async (t) => {
  const claudeRows = [
    claudeUser("physical-claude", "lf", 0, "first"),
    claudeUser("physical-claude", "crlf", 1, "second"),
    claudeUser("physical-claude", "eof", 2, "third"),
  ];
  const claudePath = await tempJsonl(
    t,
    "physical-claude.jsonl",
    `${claudeRows[0]}\n${claudeRows[1]}\r\n${claudeRows[2]}`,
  );
  const claude = await readClaudeState(claudePath);
  assert.deepEqual(
    claude.state.rows.map((row) =>
      row.byte_end - row.byte_start - row.original_bytes
    ),
    [1, 2, 0],
  );

  const restoredClaude = normalizeClaudeParserState(
    JSON.parse(JSON.stringify(claude.state)) as unknown,
  );
  const exactRetainedBytes = claudeRows.reduce(
    (total, row) => total + Buffer.byteLength(row),
    0,
  );
  for (const maxRetainedBytes of [exactRetainedBytes, exactRetainedBytes - 1]) {
    const budgets = { maxRetainedBytes };
    assertCanonicalEqual(
      projectClaudeParserState(restoredClaude, { budgets }),
      await parseClaudeTranscriptDetailed(claudePath, { budgets }),
    );
  }

  const zeroClaude = JSON.parse(JSON.stringify(claude.state)) as {
    rows: Array<{ original_bytes: number }>;
  };
  zeroClaude.rows[0]!.original_bytes = 0;
  assert.throws(() => normalizeClaudeParserState(zeroClaude));

  const inflatedClaudeSpan = JSON.parse(JSON.stringify(claude.state)) as {
    parsed_offset: number;
    rows: Array<{ byte_end: number }>;
  };
  inflatedClaudeSpan.rows.at(-1)!.byte_end += 3;
  inflatedClaudeSpan.parsed_offset += 3;
  assert.throws(() => normalizeClaudeParserState(inflatedClaudeSpan));

  const codexRows = [
    codexRow(0, "session_meta", { id: "physical-codex" }),
    codexRow(1, "response_item", {
      type: "message",
      role: "user",
      content: "later",
    }),
  ];
  const codexPath = await tempJsonl(
    t,
    "physical-codex.jsonl",
    `${codexRows[0]}\r\n${codexRows[1]}`,
  );
  const codex = await readCodexState(codexPath);
  assert.deepEqual(
    codex.state.rows.map((row) =>
      row.byte_end - row.byte_start - row.original_bytes
    ),
    [2, 0],
  );

  const zeroCodex = JSON.parse(JSON.stringify(codex.state)) as {
    rows: Array<{ original_bytes: number }>;
  };
  zeroCodex.rows[0]!.original_bytes = 0;
  assert.throws(() => normalizeCodexParserState(zeroCodex));

  const inflatedCodexSpan = JSON.parse(JSON.stringify(codex.state)) as {
    parsed_offset: number;
    rows: Array<{ byte_end: number }>;
  };
  inflatedCodexSpan.rows.at(-1)!.byte_end += 3;
  inflatedCodexSpan.parsed_offset += 3;
  assert.throws(() => normalizeCodexParserState(inflatedCodexSpan));
});

test("state snapshots reject proxies before reflection and close own __proto__ data", async (t) => {
  const claudePath = await tempJsonl(
    t,
    "descriptor-claude.jsonl",
    `${claudeUser("descriptor-claude", "one", 0, "one")}\n`,
  );
  const codexPath = await tempJsonl(
    t,
    "descriptor-codex.jsonl",
    `${codexRow(0, "response_item", {
      type: "message",
      role: "user",
      content: "one",
    })}\n`,
  );
  const claude = await readClaudeState(claudePath);
  const codex = await readCodexState(codexPath);

  const transparentProxy = <T extends object>(
    target: T,
    calls: string[],
  ): T => new Proxy(target, {
    getPrototypeOf(inner) {
      calls.push("getPrototypeOf");
      return Reflect.getPrototypeOf(inner);
    },
    ownKeys(inner) {
      calls.push("ownKeys");
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(inner, key) {
      calls.push("getOwnPropertyDescriptor");
      return Reflect.getOwnPropertyDescriptor(inner, key);
    },
  });

  for (const [name, state, normalize] of [
    ["Claude", claude.state, normalizeClaudeParserState],
    ["Codex", codex.state, normalizeCodexParserState],
  ] as const) {
    await t.test(`${name} rejects an object Proxy without traps`, () => {
      const calls: string[] = [];
      const proxied = transparentProxy(
        JSON.parse(JSON.stringify(state)) as object,
        calls,
      );
      assert.throws(() => normalize(proxied));
      assert.deepEqual(calls, []);
    });

    await t.test(`${name} rejects an array Proxy without traps`, () => {
      const calls: string[] = [];
      const candidate = JSON.parse(JSON.stringify(state)) as {
        rows: object[];
      };
      candidate.rows = transparentProxy(candidate.rows, calls);
      assert.throws(() => normalize(candidate));
      assert.deepEqual(calls, []);
    });

    await t.test(`${name} preserves own __proto__ for closed validation`, () => {
      const candidate = JSON.parse(JSON.stringify(state)) as {
        rows: Array<{ payload?: object; value?: object }>;
      };
      const rowPayload = candidate.rows[0]!.value ??
        candidate.rows[0]!.payload;
      assert.ok(rowPayload);
      Object.defineProperty(rowPayload, "__proto__", {
        value: { concealed: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      assert.throws(() => normalize(candidate));
    });
  }
});

test("mid-yield capacity fallback cleans the reader before same-handle replay", async (t) => {
  const runWithForcedCapacity = async <T>(
    onCapacity: () => void,
    task: () => Promise<T>,
  ): Promise<T> => {
    const prototype = IncrementalParserStateByteTracker.prototype;
    const original = prototype.addArrayItem;
    let forced = false;
    prototype.addArrayItem = function(value, currentLength): void {
      if (!forced) {
        forced = true;
        onCapacity();
        throw new IncrementalParserStateCapacityError(
          MAX_INCREMENTAL_PARSER_STATE_BYTES + 1,
        );
      }
      original.call(this, value, currentLength);
    };
    try {
      return await task();
    } finally {
      prototype.addArrayItem = original;
    }
  };

  await t.test("Claude closes the suspended reader and retains the later row", async () => {
    const valid = claudeUser("fallback-claude", "later", 1, "later");
    const maxLineBytes = Buffer.byteLength(valid);
    const path = await tempJsonl(
      t,
      "capacity-fallback-claude.jsonl",
      `${"x".repeat(maxLineBytes + 1)}\r\n${valid}\n`,
    );
    const controller = new AbortController();
    const heldPath = `${path}.held`;
    let listenersAtCapacity = 0;
    const parsed = await runWithForcedCapacity(
      () => {
        listenersAtCapacity = getEventListeners(
          controller.signal,
          "abort",
        ).length;
        renameSync(path, heldPath);
        writeFileSync(
          path,
          `${claudeUser("replacement", "replacement", 2, "replacement")}\n`,
        );
      },
      () => parseClaudeTranscriptDetailed(path, {
        budgets: { maxLineBytes },
        signal: controller.signal,
      }),
    );

    assert.ok(listenersAtCapacity > 0);
    assert.deepEqual(
      parsed.sessions.flatMap((session) =>
        session.events.map((event) => event.entry_uuid)
      ),
      ["later"],
    );
    assert.ok(parsed.warnings.some((warning) =>
      warning.code === "parser_line_budget_exceeded"
    ));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  await t.test("Codex closes the suspended reader and retains the later row", async () => {
    const metadata = codexRow(1, "session_meta", { id: "fallback-codex" });
    const valid = codexRow(2, "response_item", {
      type: "message",
      role: "user",
      content: "later",
    });
    const maxLineBytes = Math.max(
      Buffer.byteLength(metadata),
      Buffer.byteLength(valid),
    );
    const path = await tempJsonl(
      t,
      "capacity-fallback-codex.jsonl",
      `${"x".repeat(maxLineBytes + 1)}\n${metadata}\n${valid}\n`,
    );
    const controller = new AbortController();
    const heldPath = `${path}.held`;
    let listenersAtCapacity = 0;
    const parsed = await runWithForcedCapacity(
      () => {
        listenersAtCapacity = getEventListeners(
          controller.signal,
          "abort",
        ).length;
        renameSync(path, heldPath);
        writeFileSync(
          path,
          `${codexRow(3, "response_item", {
            type: "message",
            role: "user",
            content: "replacement",
          })}\n`,
        );
      },
      () => parseCodexSession({
        sourcePath: path,
        budgets: { maxLineBytes },
        signal: controller.signal,
      }),
    );

    assert.ok(listenersAtCapacity > 0);
    assert.ok(parsed?.events.some((event) =>
      event.kind === "genuine_user" && event.text === "later"
    ));
    assert.ok(parsed?.warnings.some((warning) =>
      warning.code === "parser_line_budget_exceeded"
    ));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });
});

test("Claude state validation closes row payloads, tool results, and derived indexes", async (t) => {
  const toolResult = JSON.stringify({
    sessionId: "closed-claude",
    cwd: "/workspace/repo",
    gitBranch: "feature/closed",
    type: "user",
    uuid: "tool-result",
    parentUuid: "assistant-two",
    agentId: "agent-a",
    timestamp: at(3),
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call-1",
        content: "ok",
      }],
    },
  });
  const rows = [
    claudeUser("closed-claude", "parent", 0, "request", {
      gitBranch: "main",
    }),
    claudeAssistant("closed-claude", "assistant-one", "group-1", 1, [{
      type: "tool_use",
      id: "call-1",
      name: "Read",
      input: { file_path: "/workspace/repo/input.txt" },
    }], { gitBranch: "feature/closed" }),
    claudeAssistant("closed-claude", "assistant-two", "group-1", 2, [{
      type: "text",
      text: "done",
    }], {
      gitBranch: "feature/closed",
      parentUuid: "parent",
      agentId: "agent-a",
    }),
    toolResult,
  ];
  const path = await tempJsonl(
    t,
    "closed-claude-payloads.jsonl",
    `${rows.join("\n")}\n`,
  );
  const { state } = await readClaudeState(path);
  type MutableClaudeState = {
    rows: Array<{
      value: Record<string, unknown>;
      tool_results: Array<Record<string, unknown>>;
    }>;
    branch_lanes: Array<Record<string, unknown>>;
    ancestry: Array<Record<string, unknown>>;
    assistant_groups: Array<Record<string, unknown> & {
      source_indexes: number[];
    }>;
    result_positions: Array<Record<string, unknown>>;
  };
  const corruptions: Array<[
    string,
    (candidate: MutableClaudeState) => void,
  ]> = [
    ["unknown row-value field", (candidate) => {
      candidate.rows[0]!.value.unexpected = true;
    }],
    ["unknown row-value discriminator", (candidate) => {
      candidate.rows[0]!.value.type = "future-row";
    }],
    ["unknown assistant content field", (candidate) => {
      const message = candidate.rows[1]!.value.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>>;
      content[0]!.unexpected = true;
    }],
    ["unknown tool-result field", (candidate) => {
      const resultRow = candidate.rows.find((row) => row.tool_results.length > 0)!;
      resultRow.tool_results[0]!.unexpected = true;
    }],
    ["invalid tool-result status", (candidate) => {
      const resultRow = candidate.rows.find((row) => row.tool_results.length > 0)!;
      const evidence = resultRow.tool_results[0]!.status_evidence as
        Record<string, unknown>;
      evidence.status = "forged";
    }],
    ["reordered branch index", (candidate) => {
      candidate.branch_lanes.reverse();
    }],
    ["forged ancestry index", (candidate) => {
      candidate.ancestry[0]!.parent_uuid = "forged-parent";
    }],
    ["reordered assistant-group members", (candidate) => {
      candidate.assistant_groups[0]!.source_indexes.reverse();
    }],
    ["forged result-position index", (candidate) => {
      candidate.result_positions[0]!.source_index = 0;
    }],
  ];

  assert.ok(state.branch_lanes.length > 1);
  assert.ok(state.ancestry.length > 0);
  assert.ok(state.assistant_groups[0]!.source_indexes.length > 1);
  assert.ok(state.result_positions.length > 0);
  for (const [name, corrupt] of corruptions) {
    await t.test(name, () => {
      const candidate = JSON.parse(JSON.stringify(state)) as MutableClaudeState;
      corrupt(candidate);
      assert.throws(() => normalizeClaudeParserState(candidate));
    });
  }
});

test("Codex state validation closes payloads and recomputes derived metadata", async (t) => {
  const rows = [
    codexRow(0, "session_meta", {
      id: "closed-codex",
      cwd: "/workspace/repo",
      git: { branch: "feature/closed" },
    }),
    codexRow(1, "response_item", {
      type: "message",
      role: "user",
      content: "request",
    }),
    codexRow(2, "response_item", {
      type: "local_shell_call",
      call_id: "local-1",
    }),
    codexRow(3, "response_item", {
      type: "web_search_call",
      call_id: "search-1",
    }),
  ];
  const path = await tempJsonl(
    t,
    "closed-codex-payloads.jsonl",
    `${rows.join("\n")}\n`,
  );
  const { state } = await readCodexState(path);
  type MutableCodexState = {
    rows: Array<{ type: string; payload: Record<string, unknown> }>;
    session_metadata: Record<string, unknown> | null;
    seen_subtypes: string[];
  };
  const corruptions: Array<[
    string,
    (candidate: MutableCodexState) => void,
  ]> = [
    ["unknown payload field", (candidate) => {
      candidate.rows[1]!.payload.unexpected = true;
    }],
    ["invalid message payload type", (candidate) => {
      candidate.rows[1]!.payload.content = 42;
    }],
    ["unknown physical-row discriminator", (candidate) => {
      candidate.rows[1]!.type = "forged-row";
    }],
    ["unknown metadata field", (candidate) => {
      candidate.session_metadata!.unexpected = true;
    }],
    ["forged derived metadata", (candidate) => {
      candidate.session_metadata!.session_id = "forged-session";
    }],
    ["reordered subtype index", (candidate) => {
      candidate.seen_subtypes.reverse();
    }],
    ["forged subtype index", (candidate) => {
      candidate.seen_subtypes = ["forged-subtype"];
    }],
  ];

  assert.equal(state.seen_subtypes.length, 2);
  for (const [name, corrupt] of corruptions) {
    await t.test(name, () => {
      const candidate = JSON.parse(JSON.stringify(state)) as MutableCodexState;
      corrupt(candidate);
      assert.throws(() => normalizeCodexParserState(candidate));
    });
  }
});

test("read limits stay physical while retained-byte and warning limits stay in projection", async (t) => {
  let deep: unknown = "leaf";
  for (let depth = 0; depth < 12; depth += 1) deep = [deep];
  const overlong = claudeUser("limits", "overlong", 0, "界".repeat(32));
  const tooDeep = claudeUser("limits", "deep", 1, deep);
  const tooWide = claudeUser(
    "limits",
    "wide",
    2,
    Array.from({ length: 32 }, () => 1),
  );
  const accepted = claudeUser("limits", "accepted", 3, "accepted");
  const raw = `${[overlong, tooDeep, tooWide, accepted].join("\n")}\n`;
  const path = await tempJsonl(t, "read-limits.jsonl", raw);
  const read = await readClaudeState(path, {
    budgets: {
      maxFileBytes: Buffer.byteLength(raw),
      maxLineBytes: Buffer.byteLength(overlong) - 1,
      maxNestingDepth: 4,
      maxNodesPerLine: 24,
    },
  });
  const restored = normalizeClaudeParserState(
    JSON.parse(JSON.stringify(read.state)) as unknown,
  );
  const projectionBudgets = {
    maxRetainedBytes: Buffer.byteLength(accepted),
    maxWarnings: 3,
  } satisfies Partial<ParserProjectionBudgets>;
  const projected = projectClaudeParserState(read.state, {
    budgets: projectionBudgets,
  });
  const restoredProjection = projectClaudeParserState(restored, {
    budgets: projectionBudgets,
  });

  assert.equal(read.completeness, "complete");
  assertCanonicalEqual(restoredProjection, projected);
  assert.deepEqual(
    projected.sessions.flatMap((session) =>
      session.events.map((event) => event.entry_uuid)
    ),
    ["accepted"],
  );
  assert.ok(read.state.warnings.some((fact) =>
    fact.warning.code === "parser_line_budget_exceeded"
  ));
  assert.ok(read.state.warnings.some((fact) =>
    fact.warning.code === "parser_depth_budget_exceeded"
  ));
  assert.ok(read.state.warnings.some((fact) =>
    fact.warning.code === "parser_node_budget_exceeded"
  ));
});

test("file-byte admission is inclusive and a one-byte-over source returns only a partial receipt", async (t) => {
  const rows = [
    claudeUser("file-limit", "one", 0, "one"),
    claudeUser("file-limit", "two", 1, "two"),
  ];
  const raw = `${rows.join("\n")}\n`;
  const rawBytes = Buffer.byteLength(raw);
  const path = await tempJsonl(t, "file-limit.jsonl", raw);
  const exact = await readClaudeState(path, {
    budgets: { maxFileBytes: rawBytes },
  });
  const partial = await readClaudeState(path, {
    budgets: { maxFileBytes: rawBytes - 1 },
  });

  assert.equal(exact.completeness, "complete");
  assert.deepEqual(exact.receipt, {
    start_offset: 0,
    end_offset: rawBytes,
    bytes_read: rawBytes,
    digest: digest(raw),
  });
  assert.equal(partial.completeness, "partial");
  assert.deepEqual(partial.receipt, {
    start_offset: 0,
    end_offset: rawBytes - 1,
    bytes_read: rawBytes - 1,
    digest: digest(Buffer.from(raw).subarray(0, rawBytes - 1)),
  });
  assert.equal(partial.state.parsed_offset, rawBytes - 1);
  assert.equal(partial.state.ends_with_newline, false);
});

test("the closed-state normalizer accepts the exact fixed capacity and rejects one byte over", {
  timeout: 120_000,
}, async (t) => {
  const path = await tempJsonl(t, "capacity.jsonl", "{\n");
  const base = await readClaudeState(path);
  const exact = JSON.parse(JSON.stringify(base.state)) as unknown as {
    warnings: Array<{ warning: { message: string } }>;
  };
  const warning = exact.warnings[0];
  assert.ok(warning);
  const baseBytes = Buffer.byteLength(JSON.stringify(exact));
  assert.ok(baseBytes < MAX_INCREMENTAL_PARSER_STATE_BYTES);
  const privateMarker = "CAPACITY_PAYLOAD_DO_NOT_ECHO:";
  warning.warning.message += privateMarker;
  const markedBytes = Buffer.byteLength(JSON.stringify(exact));
  warning.warning.message += "x".repeat(
    MAX_INCREMENTAL_PARSER_STATE_BYTES - markedBytes,
  );
  assert.equal(
    Buffer.byteLength(JSON.stringify(exact)),
    MAX_INCREMENTAL_PARSER_STATE_BYTES,
  );
  assert.doesNotThrow(() => normalizeClaudeParserState(exact));

  const seed = normalizeClaudeParserState(exact);
  const seedMessage = seed.warnings[0]!.warning.message;
  const seedDigest = digest(seedMessage);
  const suffix = `${claudeUser("capacity", "suffix", 1, "tiny suffix", {
    gitBranch: "feature/capacity",
  })}\n`;
  await appendFile(path, suffix);
  await assert.rejects(
    () => readClaudeState(path, {
      range: {
        start_offset: base.state.parsed_offset,
        starting_line: base.state.line_count + 1,
      },
      seed,
    }),
    (error: unknown) => {
      assert.ok(error instanceof IncrementalParserStateCapacityError);
      const bounded = error as IncrementalParserStateCapacityError & {
        limit: number;
        observed: number;
      };
      assert.equal(bounded.code, "incremental_state_capacity");
      assert.equal(bounded.limit, MAX_INCREMENTAL_PARSER_STATE_BYTES);
      assert.ok(Number.isSafeInteger(bounded.observed));
      assert.ok(bounded.observed > bounded.limit);
      assert.equal(bounded.message.includes(privateMarker), false);
      return true;
    },
  );
  assert.equal(seed.rows.length, 0);
  assert.equal(seed.warnings.length, 1);
  assert.equal(digest(seed.warnings[0]!.warning.message), seedDigest);

  warning.warning.message += "x";
  assert.equal(
    Buffer.byteLength(JSON.stringify(exact)),
    MAX_INCREMENTAL_PARSER_STATE_BYTES + 1,
  );
  assert.throws(
    () => normalizeClaudeParserState(exact),
    (error) => error instanceof IncrementalParserStateCapacityError,
  );
});

test("read and projection budget types reject cross-stage limits", () => {
  const readBudgets: Partial<ParserReadBudgets> = {
    maxFileBytes: 1,
    // @ts-expect-error retained bytes are a projector concern
    maxRetainedBytes: 1,
  };
  const projectionBudgets: Partial<ParserProjectionBudgets> = {
    maxWarnings: 1,
    // @ts-expect-error line bytes are a reader concern
    maxLineBytes: 1,
  };
  assert.ok(readBudgets);
  assert.ok(projectionBudgets);
});
