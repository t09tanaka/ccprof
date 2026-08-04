import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  warning.warning.message += "x".repeat(
    MAX_INCREMENTAL_PARSER_STATE_BYTES - baseBytes,
  );
  assert.equal(
    Buffer.byteLength(JSON.stringify(exact)),
    MAX_INCREMENTAL_PARSER_STATE_BYTES,
  );
  assert.doesNotThrow(() => normalizeClaudeParserState(exact));

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
