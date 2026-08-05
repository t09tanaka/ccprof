import assert from "node:assert/strict";
import test from "node:test";

import { ALL_SESSION_CAPABILITIES, type Session } from "../src/core/model.js";
import {
  CANONICAL_SOURCE_ADAPTER_IDS,
  CANONICAL_SOURCE_KIND_IDS,
  SourceIdentityValidationError,
  compareSourceIdentities,
  normalizeSourceAdapterId,
  normalizeSourceKind,
  parseProducerId,
  parseSourceAdapterId,
  parseSourceKind,
  projectLegacySourceAdapterId,
  projectLegacySourceKind,
  type ProducerId,
  type SourceAdapterId,
  type SourceKind,
} from "../src/core/source-identity.js";
import {
  deriveSourceDescriptor,
  type SourceDescriptor,
} from "../src/core/source-descriptor.js";

test("public source identity types accept namespaced third-party IDs", () => {
  const producer: ProducerId = "dev.example.agent/adapters/dummy-agent";
  const adapter: SourceAdapterId = producer;
  const kind: SourceKind = "dev.example.agent/source-kinds/dummy-jsonl";
  const sessionSource: Session["source"] = producer;
  const descriptorAdapter: SourceDescriptor["adapter_id"] = adapter;
  const descriptorKind: SourceDescriptor["source_kind"] = kind;

  assert.equal(parseProducerId(sessionSource), producer);
  assert.equal(parseSourceAdapterId(descriptorAdapter), adapter);
  assert.equal(parseSourceKind(descriptorKind), kind);
});

test("canonical IDs validate and only known legacy tokens normalize", () => {
  assert.equal(
    normalizeSourceAdapterId("claude"),
    CANONICAL_SOURCE_ADAPTER_IDS.claude,
  );
  assert.equal(
    normalizeSourceAdapterId("codex"),
    CANONICAL_SOURCE_ADAPTER_IDS.codex,
  );
  assert.equal(
    normalizeSourceKind("claude_transcript_jsonl"),
    CANONICAL_SOURCE_KIND_IDS.claude_transcript_jsonl,
  );
  assert.equal(
    parseSourceAdapterId(CANONICAL_SOURCE_ADAPTER_IDS.claude),
    CANONICAL_SOURCE_ADAPTER_IDS.claude,
  );
  assert.equal(
    parseSourceKind(CANONICAL_SOURCE_KIND_IDS.codex_rollout_jsonl),
    CANONICAL_SOURCE_KIND_IDS.codex_rollout_jsonl,
  );
});

test("namespaced identity parsing rejects invalid syntax and excess length", () => {
  const maxLength = `${"a.".repeat(126)}a/x`;
  const overLength = `${"a.".repeat(126)}a/xx`;
  assert.equal(maxLength.length, 255);
  assert.equal(parseProducerId(maxLength), maxLength);
  assert.equal(overLength.length, 256);

  for (const value of [
    "",
    " ",
    "dev.example/has space",
    "dev.example/has\0nul",
    "Dev.example/agent",
    "localhost/agent",
    "dev.example//agent",
    "dev.example/",
    "-dev.example/agent",
    "dev-.example/agent",
    "dev.example/agent\n",
    overLength,
  ]) {
    assert.throws(
      () => parseProducerId(value),
      {
        name: "SourceIdentityValidationError",
        message: "invalid source identity: invalid_namespaced_name",
      },
    );
  }
});

test("unknown unnamespaced aliases fail closed", () => {
  assert.throws(
    () => normalizeSourceAdapterId("dummy-agent"),
    SourceIdentityValidationError,
  );
  assert.throws(
    () => normalizeSourceKind("dummy_jsonl"),
    SourceIdentityValidationError,
  );
});

test("legacy projection is built-in-only", () => {
  assert.equal(
    projectLegacySourceAdapterId(CANONICAL_SOURCE_ADAPTER_IDS.claude),
    "claude",
  );
  assert.equal(
    projectLegacySourceAdapterId(CANONICAL_SOURCE_ADAPTER_IDS.codex),
    "codex",
  );
  assert.equal(
    projectLegacySourceAdapterId("dev.example.agent/adapters/dummy-agent"),
    undefined,
  );
  assert.equal(
    projectLegacySourceKind(CANONICAL_SOURCE_KIND_IDS.claude_transcript_jsonl),
    "claude_transcript_jsonl",
  );
  assert.equal(
    projectLegacySourceKind("dev.example.agent/source-kinds/dummy-jsonl"),
    undefined,
  );
});

test("identity ordering uses deterministic code-unit comparison", () => {
  const hyphenated = parseSourceAdapterId("dev.example/a-b");
  const underscored = parseSourceAdapterId("dev.example/a_b");

  assert.equal(compareSourceIdentities(hyphenated, underscored), -1);
  assert.equal(compareSourceIdentities(underscored, hyphenated), 1);
  assert.equal(compareSourceIdentities(hyphenated, hyphenated), 0);
  assert.deepEqual([underscored, hyphenated].sort(compareSourceIdentities), [
    hyphenated,
    underscored,
  ]);
});

test("built-in descriptors retain their exact legacy shapes and fingerprints", () => {
  const claude = deriveSourceDescriptor({
    session_id: "session-1",
    source: "claude",
    source_path: "/private/logs/session.jsonl",
  });
  const codex = deriveSourceDescriptor({
    session_id: "session-1",
    source: "codex",
    source_path: "/private/logs/session.jsonl",
    capabilities: ["tool_timestamps", "edit_fragments"],
  });

  assert.deepEqual(claude, {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    source_instance_id:
      "source-0e596344ad7c80946741116ed2a54665d0a55027b6a78d6bfb4f1c9dd2872a6d",
    source_kind: "claude_transcript_jsonl",
    provided_capabilities: [...ALL_SESSION_CAPABILITIES].sort(),
    required_capabilities: [],
    provenance: "local_filesystem",
    sensitivity: "sensitive",
    retention_class: "raw_evidence",
    canonical_fingerprint:
      "sha256:d2a320e97e2dd44189283e8d839c346dbcadac97eb0100200e27e23bafe24278",
  });
  assert.deepEqual(codex, {
    adapter_id: "codex",
    adapter_version: "1.0.0",
    source_instance_id:
      "source-38b016536bb29661f22086bef5eae8ee39ecdd62b99b4e90b4cdf5ee77782d88",
    source_kind: "codex_rollout_jsonl",
    provided_capabilities: ["edit_fragments", "tool_timestamps"],
    required_capabilities: [],
    provenance: "local_filesystem",
    sensitivity: "sensitive",
    retention_class: "raw_evidence",
    canonical_fingerprint:
      "sha256:672989e2a9b2301cf7692521ecc4b17317bfdde087b3afcf6b867060e140d715",
  });
});
