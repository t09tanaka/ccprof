import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_SESSION_CAPABILITIES,
  type Session,
  type SessionCapability,
} from "../src/core/model.js";
import {
  SourceDescriptorValidationError,
  deriveSourceDescriptor,
  sourceDescriptorsForSessions,
  validateSourceDescriptor,
  validateSourceDescriptors,
  type SourceDescriptor,
} from "../src/core/source-descriptor.js";

function session(options: {
  sessionId?: string;
  source?: Session["source"];
  sourcePath?: string;
  capabilities?: readonly SessionCapability[];
} = {}): Session {
  return {
    session_id: options.sessionId ?? "session-1",
    source: options.source ?? "claude",
    source_path: options.sourcePath ?? "/private/logs/session.jsonl",
    observed_cwds: ["/repo"],
    observed_branches: ["main"],
    started_at_ms: 1,
    ended_at_ms: 2,
    confidence: "high",
    events: [],
    warnings: [],
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
  };
}

function assertContentFreeError(
  callback: () => unknown,
  expectedCode: string,
  canaries: readonly string[] = [],
): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof SourceDescriptorValidationError);
    assert.equal(error.code, expectedCode);
    for (const canary of canaries) {
      assert.doesNotMatch(error.message, new RegExp(canary, "u"));
    }
    return true;
  });
}

test("source descriptors use the exact built-in contract and sorted capabilities", () => {
  const claude = deriveSourceDescriptor(session());
  const codex = deriveSourceDescriptor(session({
    source: "codex",
    capabilities: ["tool_timestamps", "edit_fragments"],
  }));

  assert.deepEqual(Object.keys(claude), [
    "adapter_id",
    "adapter_version",
    "source_instance_id",
    "source_kind",
    "provided_capabilities",
    "required_capabilities",
    "provenance",
    "sensitivity",
    "retention_class",
    "canonical_fingerprint",
  ]);
  assert.deepEqual(claude, {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    source_instance_id: claude.source_instance_id,
    source_kind: "claude_transcript_jsonl",
    provided_capabilities: [...ALL_SESSION_CAPABILITIES].sort(),
    required_capabilities: [],
    provenance: "local_filesystem",
    sensitivity: "sensitive",
    retention_class: "raw_evidence",
    canonical_fingerprint: claude.canonical_fingerprint,
  });
  assert.match(claude.source_instance_id, /^source-[a-f0-9]{64}$/u);
  assert.match(claude.canonical_fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(codex.source_kind, "codex_rollout_jsonl");
  assert.deepEqual(codex.provided_capabilities, [
    "edit_fragments",
    "tool_timestamps",
  ]);
});

test("derivation is deterministic, order independent, deduplicated, and adapter separated", () => {
  const path = "/private/logs/café.jsonl";
  const logicalSession = "session-café";
  const first = session({
    sessionId: logicalSession,
    sourcePath: path,
    capabilities: ["token_usage", "edit_fragments", "token_usage"],
  });
  const equivalent = session({
    sessionId: logicalSession.normalize("NFD"),
    sourcePath: "/a/different/worktree/session.jsonl",
    capabilities: ["edit_fragments", "token_usage"],
  });
  const codex = session({
    sessionId: logicalSession,
    source: "codex",
    sourcePath: path,
    capabilities: ["edit_fragments", "tool_timestamps"],
  });

  assert.deepEqual(deriveSourceDescriptor(first), deriveSourceDescriptor(equivalent));
  assert.notEqual(
    deriveSourceDescriptor(first).source_instance_id,
    deriveSourceDescriptor(codex).source_instance_id,
  );
  assert.notEqual(
    deriveSourceDescriptor(first).source_instance_id,
    deriveSourceDescriptor(session({
      sessionId: "session-2",
      sourcePath: path,
      capabilities: ["edit_fragments", "token_usage"],
    })).source_instance_id,
  );
  const forward = sourceDescriptorsForSessions([first, equivalent, codex]);
  const reverse = sourceDescriptorsForSessions([codex, equivalent, first]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 2);
});

test("opaque descriptor values never contain path, Unicode, transcript, or token canaries", () => {
  const sessionCanary = "SESSION_ID_CANARY";
  const canaries = [
    "PRIVATE_PATH_CANARY",
    "秘密の会話",
    "ghp_SOURCE_DESCRIPTOR_TOKEN_12345678",
    sessionCanary,
  ];
  const descriptor = deriveSourceDescriptor(session({
    sessionId: `session-${sessionCanary}`,
    sourcePath: `/Users/alice/${canaries.join("/")}.jsonl`,
  }));
  const encoded = JSON.stringify(descriptor);
  for (const canary of canaries) {
    assert.doesNotMatch(encoded, new RegExp(canary, "u"));
  }
});

test("derivation rejects NUL-bearing session and source identities without echoing them", () => {
  assertContentFreeError(
    () => deriveSourceDescriptor(session({ sessionId: "SESSION\0CANARY" })),
    "invalid_field",
    ["SESSION", "CANARY"],
  );
  assertContentFreeError(
    () => deriveSourceDescriptor(session({ sourcePath: "/PATH\0CANARY" })),
    "invalid_field",
    ["PATH", "CANARY"],
  );
});

test("strict validation accepts only canonical registered descriptors", () => {
  const descriptor = deriveSourceDescriptor(session());
  assert.deepEqual(validateSourceDescriptor(structuredClone(descriptor)), descriptor);
  assert.deepEqual(validateSourceDescriptors([structuredClone(descriptor)]), [descriptor]);

  const cases: Array<{
    mutate: (value: Record<string, unknown>) => void;
    code: string;
  }> = [
    { mutate: (value) => { value.extra = "FIELD_CANARY"; }, code: "unknown_field" },
    { mutate: (value) => { value.adapter_id = "ADAPTER_CANARY"; }, code: "unknown_adapter" },
    { mutate: (value) => { value.adapter_version = "VERSION_CANARY"; }, code: "unsupported_version" },
    { mutate: (value) => { value.source_kind = "KIND_CANARY"; }, code: "registry_mismatch" },
    { mutate: (value) => { value.provenance = "PROVENANCE_CANARY"; }, code: "registry_mismatch" },
    { mutate: (value) => { value.source_instance_id = "source-NUL\0CANARY"; }, code: "invalid_field" },
    { mutate: (value) => { value.canonical_fingerprint = "sha256:deadbeef"; }, code: "invalid_fingerprint" },
    { mutate: (value) => { value.provided_capabilities = ["token_usage", "token_usage"]; }, code: "invalid_capability" },
    { mutate: (value) => { value.provided_capabilities = ["token_usage", "edit_fragments"]; }, code: "invalid_capability" },
    { mutate: (value) => { value.provided_capabilities = ["CAPABILITY_CANARY"]; }, code: "invalid_capability" },
  ];
  for (const { mutate, code } of cases) {
    const value = structuredClone(descriptor) as unknown as Record<string, unknown>;
    mutate(value);
    assertContentFreeError(
      () => validateSourceDescriptor(value),
      code,
      ["FIELD_CANARY", "ADAPTER_CANARY", "VERSION_CANARY", "KIND_CANARY",
        "PROVENANCE_CANARY", "CANARY", "CAPABILITY_CANARY"],
    );
  }
});

test("descriptor-list validation rejects malformed containers and duplicate sources", () => {
  const descriptor: SourceDescriptor = deriveSourceDescriptor(session());
  assertContentFreeError(
    () => validateSourceDescriptors({ descriptor }),
    "invalid_shape",
  );
  assertContentFreeError(
    () => validateSourceDescriptors([descriptor, structuredClone(descriptor)]),
    "duplicate_source",
  );
});
