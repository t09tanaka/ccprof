import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ALL_SESSION_CAPABILITIES } from "../src/core/model.js";
import { RULE_REQUIRED_CAPABILITIES } from "../src/rules/capabilities.js";
import {
  listRuleManifests,
  ruleManifest,
  RuleManifestValidationError,
  type RuleManifest,
  validateRuleManifestCatalog,
} from "../src/rules/manifest.js";
import {
  findingKey,
  findingKeyForCompatibility,
} from "../src/rules/shared.js";

const SOURCES = ["claude", "codex"] as const;

const EXPECTED: RuleManifest[] = [
  {
    id: "R001",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: ["edit_fragments"],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "union",
    evidence_schema: "ccprof://rules/R001/evidence/v1",
    policy_risk: "medium",
  },
  {
    id: "R002",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "union",
    evidence_schema: "ccprof://rules/R002/evidence/v1",
    policy_risk: "low",
  },
  {
    id: "R003",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "union",
    evidence_schema: "ccprof://rules/R003/evidence/v1",
    policy_risk: "low",
  },
  {
    id: "R004",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "policy_latency",
    default_mode: "observe_only",
    aggregation_policy: "never_aggregate",
    evidence_schema: "ccprof://rules/R004/evidence/v1",
    policy_risk: "high",
  },
  {
    id: "R005",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: ["tool_timestamps"],
    supported_sources: [...SOURCES],
    impact_kind: "resource_cost",
    default_mode: "enabled",
    aggregation_policy: "max",
    evidence_schema: "ccprof://rules/R005/evidence/v1",
    policy_risk: "medium",
  },
  {
    id: "R006",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "resource_cost",
    default_mode: "enabled",
    aggregation_policy: "max",
    evidence_schema: "ccprof://rules/R006/evidence/v1",
    policy_risk: "medium",
  },
  {
    id: "R007",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: ["token_usage"],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "max",
    evidence_schema: "ccprof://rules/R007/evidence/v1",
    policy_risk: "low",
  },
  {
    id: "R008",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "union",
    evidence_schema: "ccprof://rules/R008/evidence/v1",
    policy_risk: "medium",
  },
];

const FIELDS = [
  "id",
  "version",
  "compatibility_epoch",
  "required_capabilities",
  "supported_sources",
  "impact_kind",
  "default_mode",
  "aggregation_policy",
  "evidence_schema",
  "policy_risk",
];

function catalog(): Array<Record<string, unknown>> {
  return structuredClone(EXPECTED) as unknown as Array<Record<string, unknown>>;
}

function invalid(
  mutate: (value: Array<Record<string, unknown>>) => void,
): unknown {
  const value = catalog();
  mutate(value);
  return value;
}

function manifestError(
  value: unknown,
  code: string,
  index?: number,
  field?: string,
): void {
  assert.throws(
    () => validateRuleManifestCatalog(value),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const failure = error as Error & {
        code?: unknown;
        index?: unknown;
        field?: unknown;
      };
      assert.equal(failure.constructor, RuleManifestValidationError);
      assert.equal(failure.code, code);
      assert.equal(failure.index, index);
      assert.equal(failure.field, field);
      assert.match(failure.message, /invalid rule manifest/u);
      return true;
    },
  );
}

test("the built-in manifest registers the exact R001-R008 contracts", () => {
  const manifests = listRuleManifests();
  assert.deepEqual(manifests, EXPECTED);
  assert.deepEqual(manifests.map(({ id }) => id), [
    "R001", "R002", "R003", "R004", "R005", "R006", "R007", "R008",
  ]);
  for (const manifest of manifests) {
    assert.deepEqual(Object.keys(manifest), FIELDS);
    assert.deepEqual(ruleManifest(manifest.id), manifest);
  }
});

test("manifest list, lookup, and validator results cannot mutate the registry", () => {
  const first = listRuleManifests();
  first.reverse();
  first[0]?.required_capabilities.push("approvals");
  first[0]?.supported_sources.reverse();
  const selected = ruleManifest("R001");
  selected.required_capabilities.length = 0;
  const validated = validateRuleManifestCatalog([...EXPECTED].reverse());
  validated[0]?.required_capabilities.push("approvals");

  assert.deepEqual(listRuleManifests(), EXPECTED);
  assert.deepEqual(ruleManifest("R001"), EXPECTED[0]);
  assert.deepEqual(
    validateRuleManifestCatalog([...EXPECTED].reverse()),
    EXPECTED,
  );
});

test("manifest validation fails closed with actionable deterministic codes", () => {
  manifestError({}, "invalid_catalog");
  manifestError(invalid((value) => { value[0] = null as never; }), "invalid_entry", 0);
  manifestError(invalid((value) => { delete value[0]?.version; }), "missing_field", 0, "version");
  manifestError(invalid((value) => { value[0]!.extra = true; }), "unknown_field", 0, "extra");
  manifestError(invalid((value) => { value[1]!.id = " r001 "; }), "duplicate_id", 1, "id");
  manifestError(invalid((value) => { value[0]!.id = " r001 "; }), "invalid_rule_id", 0, "id");
  manifestError(invalid((value) => { value[0]!.id = "R999"; }), "unknown_rule_id", 0, "id");
  manifestError(EXPECTED.slice(0, -1), "missing_rule_id", undefined, "R008");
  manifestError(invalid((value) => { value[0]!.version = "01.0.0"; }), "invalid_version", 0, "version");
  manifestError(invalid((value) => { value[0]!.compatibility_epoch = 0; }), "invalid_epoch", 0, "compatibility_epoch");
  manifestError(invalid((value) => { value[0]!.version = "2.0.0"; }), "version_epoch_mismatch", 0, "compatibility_epoch");
  manifestError(invalid((value) => { value[0]!.required_capabilities = ["unknown"]; }), "invalid_capability", 0, "required_capabilities");
  manifestError(invalid((value) => { value[0]!.required_capabilities = ["approvals", "edit_fragments"]; }), "invalid_capability", 0, "required_capabilities");
  manifestError(invalid((value) => { value[0]!.supported_sources = ["other"]; }), "invalid_source", 0, "supported_sources");
  manifestError(invalid((value) => { value[0]!.supported_sources = ["codex", "claude"]; }), "invalid_source", 0, "supported_sources");
  manifestError(invalid((value) => { value[0]!.impact_kind = "time"; }), "invalid_impact_kind", 0, "impact_kind");
  manifestError(invalid((value) => { value[0]!.default_mode = "on"; }), "invalid_mode", 0, "default_mode");
  manifestError(invalid((value) => { value[0]!.aggregation_policy = "average"; }), "invalid_aggregation_policy", 0, "aggregation_policy");
  manifestError(invalid((value) => { value[0]!.evidence_schema = "R001"; }), "invalid_evidence_schema", 0, "evidence_schema");
  manifestError(invalid((value) => { value[0]!.policy_risk = "critical"; }), "invalid_policy_risk", 0, "policy_risk");
});

test("the capability compatibility map is derived exactly from manifests", () => {
  assert.deepEqual(
    RULE_REQUIRED_CAPABILITIES,
    Object.fromEntries(EXPECTED.map((entry) => [
      entry.id,
      entry.required_capabilities,
    ])),
  );
  assert.deepEqual(
    [...new Set(Object.values(RULE_REQUIRED_CAPABILITIES).flat())].sort(),
    ["edit_fragments", "token_usage", "tool_timestamps"],
  );
  assert.ok(
    Object.values(RULE_REQUIRED_CAPABILITIES).flat().every((capability) =>
      ALL_SESSION_CAPABILITIES.includes(capability)
    ),
  );
});

test("epoch one preserves legacy finding keys while later epochs isolate series", () => {
  const target = "npm test";
  const legacy = createHash("sha256")
    .update(`R002\0${target}`)
    .digest("hex");
  assert.equal(findingKey("R002", target), legacy);
  assert.equal(findingKeyForCompatibility("R002", target, 1), legacy);
  assert.notEqual(findingKeyForCompatibility("R002", target, 2), legacy);
  assert.equal(
    findingKeyForCompatibility("R002", target, 2),
    findingKeyForCompatibility("R002", `  ${target}  `, 2),
  );
  assert.throws(
    () => findingKeyForCompatibility("R002", target, 0),
    /compatibility epoch must be a positive safe integer/u,
  );
});

test("unknown rule lookup fails without a partial result", () => {
  assert.throws(
    () => ruleManifest("R999"),
    /unknown rule id.*R001.*R008/u,
  );
});
