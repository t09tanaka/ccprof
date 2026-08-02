import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  MAX_TOOL_INPUT_FRAGMENT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  parseClaudeSession,
  parseClaudeTranscript,
  parseClaudeTranscriptDetailed,
} from "../src/sources/claude/parser.js";

const fixture = (name: string): string =>
  resolve(process.cwd(), "test", "fixtures", "claude", name);

test("parses malformed JSONL tolerantly and reconstructs cumulative assistant snapshots", async () => {
  const session = await parseClaudeSession(
    fixture("duplicate-and-malformed.jsonl"),
  );

  assert.ok(session);
  assert.equal(session.session_id, "session-main");
  assert.ok(session.warnings.some((warning) => warning.code === "invalid_json"));
  assert.ok(
    session.warnings.some((warning) => warning.code === "invalid_timestamp"),
  );

  const cumulative = session.events.filter(
    (event) =>
      event.kind === "assistant" &&
      event.message_id === "message-cumulative",
  );
  assert.equal(cumulative.length, 1);
  assert.equal(
    cumulative[0]?.kind === "assistant" ? cumulative[0].text : undefined,
    "I will read the file.\nThe read is complete.",
  );
  assert.equal(
    cumulative[0]?.kind === "assistant"
      ? cumulative[0].input_tokens
      : undefined,
    120,
  );
  assert.equal(
    cumulative[0]?.kind === "assistant"
      ? cumulative[0].output_tokens
      : undefined,
    8,
  );

  const readUses = session.events.filter(
    (event) => event.kind === "tool_use" && event.tool_use_id === "tool-read",
  );
  assert.equal(readUses.length, 1);
});

test("reconstructs distinct one-block fragments sharing an assistant message id", async () => {
  const session = await parseClaudeSession(
    fixture("duplicate-and-malformed.jsonl"),
  );
  assert.ok(session);

  const fragmented = session.events.filter(
    (event) =>
      event.kind === "assistant" &&
      event.message_id === "message-fragmented",
  );
  assert.equal(fragmented.length, 1);
  assert.equal(
    fragmented[0]?.kind === "assistant" ? fragmented[0].text : undefined,
    "Running tools.\nTools finished.",
  );
  assert.equal(
    fragmented[0]?.kind === "assistant"
      ? fragmented[0].input_tokens
      : undefined,
    50,
  );
  assert.equal(
    fragmented[0]?.kind === "assistant"
      ? fragmented[0].output_tokens
      : undefined,
    9,
  );

  const fragmentedTools = session.events.filter(
    (event) =>
      event.kind === "tool_use" &&
      ["tool-bash", "tool-edit", "tool-write"].includes(event.tool_use_id),
  );
  assert.deepEqual(
    fragmentedTools.map((event) =>
      event.kind === "tool_use" ? event.tool_use_id : "",
    ),
    ["tool-bash", "tool-edit", "tool-write"],
  );
});

test("replaces evolving prefix snapshots and lowers confidence only for schema-loss groups", async () => {
  const session = await parseClaudeSession(
    fixture("evolving-and-partial.jsonl"),
  );
  assert.ok(session);

  const evolving = session.events.filter(
    (event) =>
      event.kind === "assistant" &&
      event.message_id === "message-evolving",
  );
  assert.equal(evolving.length, 1);
  assert.ok(evolving[0]?.kind === "assistant");
  assert.equal(evolving[0].text, "Hello");
  assert.equal(evolving[0].output_tokens, 3);
  assert.equal(evolving[0].confidence, "high");

  const contracting = session.events.filter(
    (event) =>
      event.kind === "assistant" &&
      event.message_id === "message-contracting",
  );
  assert.equal(contracting.length, 1);
  assert.ok(contracting[0]?.kind === "assistant");
  assert.equal(contracting[0].text, "Hello");
  assert.equal(contracting[0].output_tokens, 3);
  assert.equal(contracting[0].confidence, "high");

  const partial = session.events.find(
    (event) =>
      event.kind === "assistant" &&
      event.message_id === "message-partial",
  );
  assert.ok(partial?.kind === "assistant");
  assert.equal(partial.text, "Visible partial response.");
  assert.equal(partial.confidence, "low");
  assert.equal(session.confidence, "low");
  assert.ok(
    session.warnings.some(
      (warning) => warning.code === "unsupported_content_block",
    ),
  );
});

test("normalizes tool inputs, polymorphic results, and only observed exit codes", async () => {
  const session = await parseClaudeSession(
    fixture("duplicate-and-malformed.jsonl"),
  );
  assert.ok(session);

  const read = session.events.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "tool-read",
  );
  assert.ok(read?.kind === "tool_use");
  assert.deepEqual(read.paths, ["/workspace/repo/src/a.ts"]);

  const bash = session.events.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "tool-bash",
  );
  assert.ok(bash?.kind === "tool_use");
  assert.equal(bash.command, "npm test");
  assert.equal(bash.cwd, "/workspace/repo");

  const edit = session.events.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "tool-edit",
  );
  assert.ok(edit?.kind === "tool_use");
  assert.deepEqual(edit.paths, ["src/a.ts"]);
  assert.deepEqual(edit.edit_fragments, ["new value"]);

  const write = session.events.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "tool-write",
  );
  assert.ok(write?.kind === "tool_use");
  assert.deepEqual(write.paths, ["notes.txt"]);
  assert.deepEqual(write.edit_fragments, ["hello from Write"]);

  const bashResult = session.events.find(
    (event) =>
      event.kind === "tool_result" && event.tool_use_id === "tool-bash",
  );
  assert.ok(bashResult?.kind === "tool_result");
  assert.equal(bashResult.status, "success");
  assert.equal(bashResult.output, "shell visible output");
  assert.equal("exit_code" in bashResult, false);
  assert.ok(bashResult.output_bytes > 0);
  assert.ok(bashResult.estimated_tokens > 0);

  const writeResult = session.events.find(
    (event) =>
      event.kind === "tool_result" && event.tool_use_id === "tool-write",
  );
  assert.ok(writeResult?.kind === "tool_result");
  assert.equal(writeResult.status, "failure");
  assert.equal(writeResult.exit_code, 2);
  assert.equal(writeResult.output, "write failed");

  const stringResult = session.events.find(
    (event) =>
      event.kind === "tool_result" &&
      event.tool_use_id === "tool-string-result",
  );
  assert.ok(stringResult?.kind === "tool_result");
  assert.equal(stringResult.output, "visible fallback");
  assert.equal(stringResult.status, "failure");

  const explicitFailure = session.events.find(
    (event) =>
      event.kind === "tool_result" &&
      event.tool_use_id === "tool-explicit-failure",
  );
  assert.ok(explicitFailure?.kind === "tool_result");
  assert.equal(explicitFailure.status, "failure");
  assert.equal(explicitFailure.output, "visible agent failure");

  const absentResult = session.events.find(
    (event) =>
      event.kind === "tool_result" &&
      event.tool_use_id === "tool-absent-result",
  );
  assert.ok(absentResult?.kind === "tool_result");
  assert.equal(absentResult.output, "absent structured result");
  assert.equal(absentResult.status, "success");
});

test("marks wholly unknown tool result schemas unknown without penalizing recognized empty success", async () => {
  const session = await parseClaudeSession(fixture("unknown-result.jsonl"));
  assert.ok(session);

  const unknown = session.events.find(
    (event) =>
      event.kind === "tool_result" &&
      event.tool_use_id === "tool-unknown-schema",
  );
  assert.ok(unknown?.kind === "tool_result");
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.output, "");
  assert.equal(unknown.confidence, "low");
  assert.ok(
    session.warnings.some(
      (warning) => warning.code === "unknown_tool_result",
    ),
  );

  const knownEmpty = session.events.find(
    (event) =>
      event.kind === "tool_result" &&
      event.tool_use_id === "tool-empty-success",
  );
  assert.ok(knownEmpty?.kind === "tool_result");
  assert.equal(knownEmpty.status, "success");
  assert.equal(knownEmpty.output, "");
  assert.equal(knownEmpty.confidence, "high");
});

test("keeps assistant rows without ids and treats compact summaries as compaction", async () => {
  const session = await parseClaudeSession(
    fixture("duplicate-and-malformed.jsonl"),
  );
  assert.ok(session);

  const idless = session.events.filter(
    (event) =>
      event.kind === "assistant" &&
      event.message_id === undefined &&
      event.text.includes("API Error"),
  );
  assert.equal(idless.length, 1);

  const compactions = session.events.filter(
    (event) => event.kind === "compaction",
  );
  assert.equal(compactions.length, 2);
  assert.ok(
    compactions.some(
      (event) =>
        event.kind === "compaction" &&
        event.summary === "Conversation compacted" &&
        event.estimated_tokens === 12345,
    ),
  );
  assert.ok(
    compactions.some(
      (event) =>
        event.kind === "compaction" &&
        event.summary === "Summary of the compacted conversation.",
    ),
  );
  assert.equal(
    session.events.some(
      (event) =>
        event.kind === "genuine_user" &&
        event.text.includes("Summary of the compacted conversation."),
    ),
    false,
  );
  assert.ok(session.warnings.some((warning) => warning.code === "api_error"));
});

test("preserves observed sidechain agents and assigns one deterministic fallback", async () => {
  const sessions = await parseClaudeTranscript(fixture("sidechain.jsonl"));
  assert.equal(sessions.length, 2);

  const observed = sessions.find(
    (session) => session.session_id === "session-sidechain-observed",
  );
  assert.ok(observed);
  assert.ok(observed.events.every((event) => event.is_sidechain));
  assert.ok(observed.events.every((event) => event.agent_id === "agent-observed"));

  const fallback = sessions.find(
    (session) => session.session_id === "session-sidechain-fallback",
  );
  assert.ok(fallback);
  const fallbackIds = new Set(fallback.events.map((event) => event.agent_id));
  assert.equal(fallbackIds.size, 1);
  assert.match([...fallbackIds][0] ?? "", /^sidechain:/);
});

test("resolves missing sidechain agent ids through their own parent ancestry", async () => {
  const session = await parseClaudeSession(fixture("sidechain-multi.jsonl"));
  assert.ok(session);
  const byMessage = (messageId: string) =>
    session.events.find(
      (event) =>
        event.kind === "assistant" && event.message_id === messageId,
    );

  assert.equal(byMessage("multi-a-child")?.agent_id, "agent-a");
  assert.equal(byMessage("multi-b-child")?.agent_id, "agent-b");
  const orphanAgent = byMessage("multi-orphan")?.agent_id;
  assert.match(orphanAgent ?? "", /^sidechain:session-sidechain-multi:root-c$/);
  assert.notEqual(orphanAgent, "agent-a");
  assert.notEqual(orphanAgent, "agent-b");
});

test("memoizes missing-agent sidechain ancestry within a linear visit budget", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-agent-chain-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "long-sidechain.jsonl");
  const chainLength = 512;
  const rows = Array.from({ length: chainLength }, (_, index) => {
    const uuid = `chain-${index.toString(10)}`;
    return {
      type: "assistant",
      sessionId: "long-sidechain",
      uuid,
      ...(index === 0
        ? { parentUuid: "external-root", agentId: "agent-root" }
        : { parentUuid: `chain-${(index - 1).toString(10)}` }),
      timestamp: new Date(
        Date.parse("2026-07-31T07:30:00.000Z") + index,
      ).toISOString(),
      isSidechain: true,
      message: {
        id: `message-${index.toString(10)}`,
        role: "assistant",
        content: [{ type: "text", text: uuid }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
  });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  let ancestrySteps = 0;
  const parsed = await parseClaudeTranscriptDetailed(path, {
    onAgentAncestryStep: () => {
      ancestrySteps += 1;
    },
  });

  assert.equal(parsed.sessions.length, 1);
  assert.ok(
    parsed.sessions[0]?.events.every(
      (event) => event.agent_id === "agent-root",
    ),
  );
  assert.ok(
    ancestrySteps <= chainLength - 1,
    `expected at most ${chainLength - 1} ancestry steps, observed ${ancestrySteps}`,
  );
});

test("reconstructs thousands of distinct assistant fragments with a linear prefix-probe budget", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-fragments-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "many-fragments.jsonl");
  const fragmentCount = 4_096;
  const startedAt = Date.parse("2026-07-31T07:40:00.000Z");
  const rows = Array.from({ length: fragmentCount }, (_, index) => ({
    type: "assistant",
    sessionId: "many-fragments",
    uuid: `fragment-${index.toString(10)}`,
    timestamp: new Date(startedAt + index).toISOString(),
    isSidechain: false,
    message: {
      id: "fragmented-message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: `fragment-${index.toString(10)}-unique`,
        },
      ],
      usage: { input_tokens: 1, output_tokens: index + 1 },
    },
  }));
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  let prefixProbes = 0;
  const parsed = await parseClaudeTranscriptDetailed(path, {
    onAssistantPrefixProbe: () => {
      prefixProbes += 1;
    },
  });
  const assistant = parsed.sessions[0]?.events.find(
    (event) =>
      event.kind === "assistant" &&
      event.message_id === "fragmented-message",
  );

  assert.ok(assistant?.kind === "assistant");
  const fragments = assistant.text.split("\n");
  assert.equal(fragments.length, fragmentCount);
  assert.equal(fragments[0], "fragment-0-unique");
  assert.equal(
    fragments[fragmentCount - 1],
    `fragment-${(fragmentCount - 1).toString(10)}-unique`,
  );
  assert.ok(
    prefixProbes <= fragmentCount - 1,
    `expected at most ${(fragmentCount - 1).toString(10)} prefix probes, observed ${prefixProbes.toString(10)}`,
  );
});

test("stops missing-agent sidechains at main boundaries with linear ancestry visits", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-agent-branches-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "deep-main-sidechains.jsonl");
  const sessionId = "deep-main-sidechains";
  const mainDepth = 256;
  const branchCount = 32;
  const startedAt = Date.parse("2026-07-31T07:45:00.000Z");
  const mainRows = Array.from({ length: mainDepth }, (_, index) => ({
    type: "user",
    sessionId,
    uuid: `main-${index.toString(10)}`,
    ...(index > 0
      ? { parentUuid: `main-${(index - 1).toString(10)}` }
      : {}),
    timestamp: new Date(startedAt + index).toISOString(),
    isSidechain: false,
    message: { role: "user", content: `main ${index.toString(10)}` },
  }));
  const sidechainRows = Array.from({ length: branchCount }, (_, index) => {
    const rootUuid = `side-root-${index.toString(10)}`;
    const childUuid = `side-child-${index.toString(10)}`;
    return [
      {
        type: "assistant",
        sessionId,
        uuid: rootUuid,
        parentUuid: `main-${(
          mainDepth -
          branchCount +
          index
        ).toString(10)}`,
        timestamp: new Date(startedAt + mainDepth + index * 2).toISOString(),
        isSidechain: true,
        message: {
          id: `branch-root-message-${index.toString(10)}`,
          role: "assistant",
          content: [{ type: "text", text: rootUuid }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "assistant",
        sessionId,
        uuid: childUuid,
        parentUuid: rootUuid,
        timestamp: new Date(
          startedAt + mainDepth + index * 2 + 1,
        ).toISOString(),
        isSidechain: true,
        message: {
          id: `branch-child-message-${index.toString(10)}`,
          role: "assistant",
          content: [{ type: "text", text: childUuid }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ];
  }).flat();
  await writeFile(
    path,
    `${[...mainRows, ...sidechainRows]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );

  let ancestrySteps = 0;
  const parsed = await parseClaudeTranscriptDetailed(path, {
    onAgentAncestryStep: () => {
      ancestrySteps += 1;
    },
  });
  const session = parsed.sessions[0];
  assert.ok(session);

  type SessionEvent = (typeof session.events)[number];
  const branchAgents = new Set<string>();
  for (let index = 0; index < branchCount; index += 1) {
    const root: SessionEvent | undefined = session.events.find(
      (event) =>
        event.kind === "assistant" &&
        event.message_id === `branch-root-message-${index.toString(10)}`,
    );
    const child: SessionEvent | undefined = session.events.find(
      (event) =>
        event.kind === "assistant" &&
        event.message_id === `branch-child-message-${index.toString(10)}`,
    );
    assert.ok(root?.kind === "assistant");
    assert.ok(child?.kind === "assistant");
    assert.equal(
      root.agent_id,
      `sidechain:${sessionId}:side-root-${index.toString(10)}`,
    );
    assert.equal(child.agent_id, root.agent_id);
    branchAgents.add(root.agent_id);
  }
  assert.equal(branchAgents.size, branchCount);
  assert.ok(
    ancestrySteps <= branchCount * 2,
    `expected at most ${(branchCount * 2).toString(10)} ancestry steps, observed ${ancestrySteps.toString(10)}`,
  );
});

test("source indices remain tied to stable physical file order", async () => {
  const session = await parseClaudeSession(
    fixture("duplicate-and-malformed.jsonl"),
  );
  assert.ok(session);

  const indices = session.events.map((event) => event.source_index);
  assert.ok(indices.every((value) => Number.isInteger(value) && value >= 0));
  for (let index = 1; index < indices.length; index += 1) {
    assert.ok((indices[index - 1] ?? 0) <= (indices[index] ?? 0));
  }
});

test("bounds multibyte tool output without inventing an exit code", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-output-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "long-output.jsonl");
  const output = "🙂".repeat(MAX_TOOL_OUTPUT_BYTES);
  const rows = [
    {
      type: "assistant",
      sessionId: "long-output",
      uuid: "assistant",
      timestamp: "2026-07-31T04:00:00.000Z",
      isSidechain: false,
      message: {
        id: "long-message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "long-tool",
            name: "Bash",
            input: { command: "generate-output" },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "user",
      sessionId: "long-output",
      uuid: "result",
      timestamp: "2026-07-31T04:00:01.000Z",
      isSidechain: false,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "long-tool",
            content: output,
          },
        ],
      },
    },
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = await parseClaudeSession(path);
  const result = session?.events.find(
    (event) =>
      event.kind === "tool_result" && event.tool_use_id === "long-tool",
  );
  assert.ok(result?.kind === "tool_result");
  assert.ok(Buffer.byteLength(result.output) <= MAX_TOOL_OUTPUT_BYTES);
  assert.equal(result.output_bytes, Buffer.byteLength(output));
  assert.equal("exit_code" in result, false);
  assert.equal(result.output.includes("\uFFFD"), false);
  assert.ok(result.output.endsWith("\n[output truncated]"));
});

test("caps retained assistant edit payloads while preserving paths and commands", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-input-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "large-input.jsonl");
  const largeEdit = "🙂".repeat(8_000);
  const row = {
    type: "assistant",
    sessionId: "large-input",
    uuid: "large-assistant",
    timestamp: "2026-07-31T08:00:00.000Z",
    cwd: "/workspace/repo",
    isSidechain: false,
    message: {
      id: "large-input-message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "large-edit",
          name: "Edit",
          input: {
            file_path: "/workspace/repo/src/large.ts",
            command: "preserve-this-command",
            new_string: largeEdit,
          },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
  await writeFile(path, `${JSON.stringify(row)}\n`);

  const session = await parseClaudeSession(path);
  const tool = session?.events.find(
    (event) =>
      event.kind === "tool_use" && event.tool_use_id === "large-edit",
  );
  assert.ok(tool?.kind === "tool_use");
  assert.deepEqual(tool.paths, ["/workspace/repo/src/large.ts"]);
  assert.equal(tool.command, "preserve-this-command");
  assert.equal(typeof tool.input.new_string, "string");
  assert.ok(
    Buffer.byteLength(tool.input.new_string as string) <=
      MAX_TOOL_INPUT_FRAGMENT_BYTES,
  );
  assert.equal((tool.input.new_string as string).includes("\uFFFD"), false);
  assert.ok((tool.input.new_string as string).endsWith("\n[input truncated]"));
  assert.deepEqual(tool.edit_fragments, [tool.input.new_string]);
});

test("does not copy one ambiguous row-level result across multiple tool result blocks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-multi-result-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "multi-result.jsonl");
  const rows = [
    {
      type: "assistant",
      sessionId: "multi-result",
      uuid: "uses",
      timestamp: "2026-07-31T08:30:00.000Z",
      isSidechain: false,
      message: {
        id: "multi-result-uses",
        role: "assistant",
        content: ["alpha", "beta", "gamma"].map((name) => ({
          type: "tool_use",
          id: `tool-${name}`,
          name: "Bash",
          input: { command: name },
        })),
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "user",
      sessionId: "multi-result",
      uuid: "results",
      parentUuid: "uses",
      timestamp: "2026-07-31T08:30:01.000Z",
      isSidechain: false,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-alpha",
            content: "alpha visible",
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "tool-beta",
            content: "beta visible",
            is_error: true,
          },
          {
            type: "tool_result",
            tool_use_id: "tool-gamma",
            content: { future_payload: true },
          },
        ],
      },
      toolUseResult: {
        stdout: "ambiguous row-level output",
        stderr: "",
        interrupted: false,
      },
    },
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = await parseClaudeSession(path);
  assert.ok(session);
  const result = (toolUseId: string) =>
    session.events.find(
      (event) =>
        event.kind === "tool_result" && event.tool_use_id === toolUseId,
    );
  const alpha = result("tool-alpha");
  const beta = result("tool-beta");
  const gamma = result("tool-gamma");

  assert.ok(alpha?.kind === "tool_result");
  assert.equal(alpha.output, "alpha visible");
  assert.equal(alpha.status, "success");
  assert.equal(alpha.confidence, "high");
  assert.ok(beta?.kind === "tool_result");
  assert.equal(beta.output, "beta visible");
  assert.equal(beta.status, "failure");
  assert.equal(beta.confidence, "high");
  assert.ok(gamma?.kind === "tool_result");
  assert.equal(gamma.output, "");
  assert.equal(gamma.status, "unknown");
  assert.equal(gamma.confidence, "low");
  assert.ok(
    session.warnings.some(
      (warning) =>
        warning.code === "unknown_tool_result" &&
        warning.session_ref === gamma.session_ref,
    ),
  );
});

test("compacts oversized unrecognized message content with byte evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-unknown-content-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "unknown-content.jsonl");
  const payload = "🙂".repeat(MAX_TOOL_INPUT_FRAGMENT_BYTES);
  const payloadBytes = Buffer.byteLength(payload);
  const rows = [
    {
      type: "user",
      sessionId: "unknown-content",
      uuid: "known-user",
      timestamp: "2026-07-31T09:00:00.000Z",
      isSidechain: false,
      message: { role: "user", content: "Keep this recognized text." },
    },
    {
      type: "assistant",
      sessionId: "unknown-content",
      uuid: "unknown-assistant",
      parentUuid: "known-user",
      timestamp: "2026-07-31T09:00:01.000Z",
      isSidechain: false,
      message: {
        id: "unknown-assistant-message",
        role: "assistant",
        content: { future_payload: payload },
      },
    },
    {
      type: "user",
      sessionId: "unknown-content",
      uuid: "unknown-user",
      parentUuid: "unknown-assistant",
      timestamp: "2026-07-31T09:00:02.000Z",
      isSidechain: false,
      message: {
        role: "user",
        content: [{ type: "future_user_block", payload }],
      },
    },
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = await parseClaudeSession(path);
  assert.ok(session);
  const compacted = session.warnings.filter(
    (warning) => warning.code === "content_payload_compacted",
  );
  assert.deepEqual(
    compacted.map((warning) => warning.line),
    [2, 3],
  );
  assert.ok(
    compacted.every(
      (warning) =>
        warning.message.includes(`${payloadBytes.toString(10)} UTF-8 bytes`) &&
        warning.session_ref !== undefined,
    ),
  );
  assert.equal(JSON.stringify(session).includes(payload), false);
});

test("silently skips thinking content blocks without warnings or schema loss", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-thinking-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "thinking-block.jsonl");
  const row = {
    type: "assistant",
    sessionId: "thinking-block",
    uuid: "assistant-1",
    timestamp: "2026-07-31T10:00:00.000Z",
    isSidechain: false,
    message: {
      id: "msg-thinking",
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Let me reason about this privately.",
          signature: "sig-abc",
        },
        { type: "text", text: "Here is my answer." },
        {
          type: "tool_use",
          id: "tool-1",
          name: "Bash",
          input: { command: "echo hi" },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  await writeFile(path, `${JSON.stringify(row)}\n`);

  const session = await parseClaudeSession(path);
  assert.ok(session);
  assert.equal(session.warnings.length, 0);
  assert.equal(session.confidence, "high");

  const assistant = session.events.find((event) => event.kind === "assistant");
  assert.ok(assistant?.kind === "assistant");
  assert.equal(assistant.text, "Here is my answer.");
  assert.equal(assistant.confidence, "high");

  const toolUse = session.events.find(
    (event) => event.kind === "tool_use" && event.tool_use_id === "tool-1",
  );
  assert.ok(toolUse);
});

test("silently skips redacted_thinking content blocks without warnings or schema loss", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-redacted-thinking-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "redacted-thinking-block.jsonl");
  const row = {
    type: "assistant",
    sessionId: "redacted-thinking-block",
    uuid: "assistant-1",
    timestamp: "2026-07-31T10:00:00.000Z",
    isSidechain: false,
    message: {
      id: "msg-redacted-thinking",
      role: "assistant",
      content: [
        { type: "redacted_thinking", data: "opaque-redacted-payload" },
        { type: "text", text: "Final answer." },
      ],
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  };
  await writeFile(path, `${JSON.stringify(row)}\n`);

  const session = await parseClaudeSession(path);
  assert.ok(session);
  assert.equal(session.warnings.length, 0);
  assert.equal(session.confidence, "high");

  const assistant = session.events.find((event) => event.kind === "assistant");
  assert.ok(assistant?.kind === "assistant");
  assert.equal(assistant.text, "Final answer.");
  assert.equal(assistant.confidence, "high");
});

test("still warns and marks schema loss for genuinely unknown content block types", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-unknown-block-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "unknown-block.jsonl");
  const row = {
    type: "assistant",
    sessionId: "unknown-block-type",
    uuid: "assistant-1",
    timestamp: "2026-07-31T10:00:00.000Z",
    isSidechain: false,
    message: {
      id: "msg-unknown-block",
      role: "assistant",
      content: [
        { type: "foo", data: "mystery" },
        { type: "text", text: "Still works." },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
  await writeFile(path, `${JSON.stringify(row)}\n`);

  const session = await parseClaudeSession(path);
  assert.ok(session);
  assert.ok(
    session.warnings.some(
      (warning) => warning.code === "unsupported_content_block",
    ),
  );
  assert.equal(session.confidence, "low");

  const assistant = session.events.find((event) => event.kind === "assistant");
  assert.ok(assistant?.kind === "assistant");
  assert.equal(assistant.text, "Still works.");
  assert.equal(assistant.confidence, "low");
});

test("suppresses invalid_timestamp warnings for known auxiliary row types without a timestamp", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-aux-timestamp-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "aux-timestamp.jsonl");
  const rows = [
    { type: "attachment", sessionId: "aux-types", note: "no timestamp here" },
    {
      type: "user",
      sessionId: "aux-types",
      uuid: "user-1",
      timestamp: "2026-07-31T10:00:00.000Z",
      isSidechain: false,
      message: { role: "user", content: "Hello world" },
    },
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = await parseClaudeSession(path);
  assert.ok(session);
  assert.equal(
    session.warnings.some((warning) => warning.code === "invalid_timestamp"),
    false,
  );
});

test("still warns invalid_timestamp for a non-auxiliary unknown row type without a timestamp", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-unknown-row-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "unknown-row.jsonl");
  const rows = [
    {
      type: "totally-unrecognized-row-type",
      sessionId: "unknown-row-types",
      note: "no timestamp here either",
    },
    {
      type: "user",
      sessionId: "unknown-row-types",
      uuid: "user-1",
      timestamp: "2026-07-31T10:00:00.000Z",
      isSidechain: false,
      message: { role: "user", content: "Hello world" },
    },
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = await parseClaudeSession(path);
  assert.ok(session);
  assert.ok(
    session.warnings.some((warning) => warning.code === "invalid_timestamp"),
  );
});

test("suppresses missing_entry_uuid warnings for known auxiliary row types while keeping timestamp-based ingestion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-aux-uuid-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "aux-uuid.jsonl");
  const rows = [
    {
      type: "queue-operation",
      sessionId: "aux-types-2",
      timestamp: "2026-07-31T10:05:00.000Z",
      operation: "enqueue",
    },
    {
      type: "user",
      sessionId: "aux-types-2",
      uuid: "user-1",
      timestamp: "2026-07-31T10:05:01.000Z",
      isSidechain: false,
      message: { role: "user", content: "Hi" },
    },
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = await parseClaudeSession(path);
  assert.ok(session);
  assert.equal(
    session.warnings.some((warning) => warning.code === "missing_entry_uuid"),
    false,
  );
});

test("bounds unknown content block type strings and objects", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-unknown-type-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "unknown-content-type.jsonl");
  const hugeStringType = "🙂".repeat(MAX_TOOL_INPUT_FRAGMENT_BYTES);
  const hugeObjectPayload = `object-type-marker-${"界".repeat(
    MAX_TOOL_INPUT_FRAGMENT_BYTES,
  )}`;
  const rows = [
    {
      type: "assistant",
      sessionId: "unknown-content-type",
      uuid: "unknown-string-type",
      timestamp: "2026-07-31T09:30:00.000Z",
      isSidechain: false,
      message: {
        id: "unknown-string-type-message",
        role: "assistant",
        content: [{ type: hugeStringType }],
      },
    },
    {
      type: "assistant",
      sessionId: "unknown-content-type",
      uuid: "unknown-object-type",
      parentUuid: "unknown-string-type",
      timestamp: "2026-07-31T09:30:01.000Z",
      isSidechain: false,
      message: {
        id: "unknown-object-type-message",
        role: "assistant",
        content: [{ type: { future_payload: hugeObjectPayload } }],
      },
    },
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const session = await parseClaudeSession(path);
  assert.ok(session);
  const unsupported = session.warnings.filter(
    (warning) => warning.code === "unsupported_content_block",
  );
  assert.equal(unsupported.length, 2);
  assert.ok(
    unsupported.every(
      (warning) =>
        Buffer.byteLength(warning.message) <=
          MAX_TOOL_INPUT_FRAGMENT_BYTES + 256 &&
        !warning.message.includes("\uFFFD"),
    ),
  );
  const compacted = session.warnings.filter(
    (warning) => warning.code === "content_payload_compacted",
  );
  assert.deepEqual(
    compacted.map((warning) => warning.line),
    [1, 2],
  );
  const serialized = JSON.stringify(session);
  assert.equal(serialized.includes(hugeStringType), false);
  assert.equal(serialized.includes(hugeObjectPayload), false);
});

test("events carry the git branch recorded on their row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-branch-events-"));
  try {
    const path = join(directory, "branches.jsonl");
    const rows = [
      {
        sessionId: "branchy",
        type: "user",
        uuid: "u1",
        timestamp: "2026-07-31T03:00:00.000Z",
        cwd: "/repo",
        gitBranch: "feature/a",
        message: { role: "user", content: "start" },
      },
      {
        sessionId: "branchy",
        type: "user",
        uuid: "u2",
        timestamp: "2026-07-31T03:01:00.000Z",
        cwd: "/repo",
        message: { role: "user", content: "continue" },
      },
    ];
    await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const session = await parseClaudeSession(path);
    assert.ok(session);
    assert.equal(session.events[0]?.branch, "feature/a");
    // Branchless rows inherit the effective branch in file order.
    assert.equal(session.events[1]?.branch, "feature/a");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("branchless events inherit the branch of non-event rows in row order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-branch-effective-"));
  try {
    const path = join(directory, "effective.jsonl");
    const rows = [
      {
        sessionId: "effective",
        type: "user",
        uuid: "u1",
        timestamp: "2026-07-31T03:00:00.000Z",
        cwd: "/repo",
        gitBranch: "feature/a",
        message: { role: "user", content: "on a" },
      },
      {
        // Emits no normalized event but still advances the effective branch.
        sessionId: "effective",
        type: "system",
        subtype: "api_error",
        uuid: "sys1",
        timestamp: "2026-07-31T03:00:30.000Z",
        cwd: "/repo",
        gitBranch: "feature/b",
      },
      {
        sessionId: "effective",
        type: "user",
        uuid: "u2",
        timestamp: "2026-07-31T03:01:00.000Z",
        cwd: "/repo",
        message: { role: "user", content: "after system row" },
      },
      {
        // A leading-branch check: rows before the first branch row adopt it.
        sessionId: "effective",
        type: "user",
        uuid: "u3",
        timestamp: "2026-07-31T03:02:00.000Z",
        cwd: "/repo",
        gitBranch: "feature/c",
        message: { role: "user", content: "on c" },
      },
    ];
    await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const session = await parseClaudeSession(path);
    assert.ok(session);
    const byUuid = new Map(
      session.events.map((event) => [event.entry_uuid, event.branch]),
    );
    assert.equal(byUuid.get("u1"), "feature/a");
    assert.equal(byUuid.get("u2"), "feature/b");
    assert.equal(byUuid.get("u3"), "feature/c");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a branchless prefix adopts the first branch observed in the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-branch-prefix-"));
  try {
    const path = join(directory, "prefix.jsonl");
    const rows = [
      {
        sessionId: "prefix",
        type: "user",
        uuid: "p1",
        timestamp: "2026-07-31T03:00:00.000Z",
        cwd: "/repo",
        message: { role: "user", content: "before branch metadata" },
      },
      {
        sessionId: "prefix",
        type: "user",
        uuid: "p2",
        timestamp: "2026-07-31T03:01:00.000Z",
        cwd: "/repo",
        gitBranch: "feature/x",
        message: { role: "user", content: "on x" },
      },
    ];
    await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const session = await parseClaudeSession(path);
    assert.ok(session);
    assert.equal(session.events[0]?.branch, "feature/x");
    assert.equal(session.events[1]?.branch, "feature/x");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
