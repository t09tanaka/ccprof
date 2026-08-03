import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeAgentIdentity,
  encodeEventIdentity,
  encodeInvocationIdentity,
  encodeSessionIdentity,
  eventIdentity,
  type EventIdentity,
} from "../src/core/event-identity.js";
import type { Session, ToolResultEvent } from "../src/core/model.js";

function resultEvent(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return {
    kind: "tool_result",
    timestamp_ms: 10,
    session_id: "session",
    entry_uuid: "result",
    session_ref: "session#result",
    source_index: 7,
    agent_id: "agent",
    is_sidechain: false,
    confidence: "high",
    tool_use_id: "call",
    status: "success",
    output: "TOP_SECRET_TRANSCRIPT_CONTENT",
    output_bytes: 29,
    estimated_tokens: 12,
    ...overrides,
  };
}

function session(event: ToolResultEvent): Session {
  return {
    session_id: event.session_id,
    source: "claude",
    source_path: "/logs/session.jsonl",
    observed_cwds: [],
    observed_branches: [],
    started_at_ms: event.timestamp_ms,
    ended_at_ms: event.timestamp_ms,
    confidence: "high",
    events: [event],
    warnings: [],
  };
}

const BASE: EventIdentity = {
  source_adapter_id: "claude",
  source_instance_id: "/logs/session.jsonl",
  session_id: "session",
  agent_id: "agent",
  tool_use_id: "call",
  source_index: 7,
};

test("EventIdentity is constructed only from Session and normalized event identity fields", () => {
  const event = resultEvent();
  const identity = eventIdentity(session(event), event);

  assert.deepEqual(identity, BASE);
  assert.equal(Object.keys(identity).length, 6);
  assert.equal(encodeEventIdentity(identity).includes(event.output), false);
  assert.equal(JSON.stringify(identity).includes(event.output), false);
});

test("event identity encoding distinguishes every field and optional tool-use presence", () => {
  const encoded = encodeEventIdentity(BASE);
  const variants: EventIdentity[] = [
    { ...BASE, source_adapter_id: "codex" },
    { ...BASE, source_instance_id: "/logs/other.jsonl" },
    { ...BASE, session_id: "other-session" },
    { ...BASE, agent_id: "other-agent" },
    { ...BASE, tool_use_id: "other-call" },
    { ...BASE, source_index: 8 },
  ];
  for (const variant of variants) {
    assert.notEqual(encodeEventIdentity(variant), encoded);
  }

  const { tool_use_id: _toolUseId, ...withoutToolUseId } = BASE;
  assert.notEqual(
    encodeEventIdentity(withoutToolUseId),
    encodeEventIdentity({ ...withoutToolUseId, tool_use_id: "" }),
  );
});

test("canonical identity encoding is collision-safe for NUL and Unicode values", () => {
  assert.notEqual(
    encodeEventIdentity({
      ...BASE,
      source_instance_id: "/logs/a\0b",
      session_id: "c",
    }),
    encodeEventIdentity({
      ...BASE,
      source_instance_id: "/logs/a",
      session_id: "b\0c",
    }),
  );
  assert.notEqual(
    encodeEventIdentity({ ...BASE, agent_id: "agent-\ud800" }),
    encodeEventIdentity({ ...BASE, agent_id: "agent-\ufffd" }),
  );
  assert.notEqual(
    encodeEventIdentity({ ...BASE, session_id: "caf\u00e9" }),
    encodeEventIdentity({ ...BASE, session_id: "cafe\u0301" }),
  );
});

test("identity projections omit only fields outside their correlation domain", () => {
  assert.equal(
    encodeInvocationIdentity(BASE),
    encodeInvocationIdentity({ ...BASE, source_index: 99 }),
  );
  assert.notEqual(
    encodeInvocationIdentity(BASE),
    encodeInvocationIdentity({ ...BASE, source_adapter_id: "codex" }),
  );
  assert.equal(
    encodeAgentIdentity(BASE),
    encodeAgentIdentity({ ...BASE, tool_use_id: "other", source_index: 99 }),
  );
  assert.notEqual(
    encodeAgentIdentity(BASE),
    encodeAgentIdentity({ ...BASE, agent_id: "other-agent" }),
  );
  assert.equal(
    encodeSessionIdentity(BASE),
    encodeSessionIdentity({ ...BASE, agent_id: "other", source_index: 99 }),
  );
  assert.notEqual(
    encodeSessionIdentity(BASE),
    encodeSessionIdentity({ ...BASE, source_instance_id: "/other" }),
  );
});
