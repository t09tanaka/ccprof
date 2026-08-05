import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_SESSION_CAPABILITIES,
  makeSessionRef,
  type Session,
  type SessionCapability,
  type ReportV2,
} from "../src/core/model.js";
import {
  ruleApplicability,
  RULE_REQUIRED_CAPABILITIES,
  sessionSupportsRule,
} from "../src/rules/capabilities.js";
import {
  CAPABILITY_DESCRIPTOR_SCHEMA_ID,
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_DESCRIPTOR_VERSION,
  CAPABILITY_UNDECLARED_STATE,
  validateCapabilityDescriptor,
  type CapabilityDescriptorV1,
} from "../src/protocol/capability-descriptor.js";
import { legacyCapabilitiesToDescriptor } from
  "../src/protocol/legacy-capability-descriptor.js";

test("report v2 serializes the exact public wire contract", () => {
  assert.equal(makeSessionRef("s1", "u1"), "s1#u1");

  const report: ReportV2 = {
    version: 2,
    unit: { repo: "/repo", pr_ref: "main...head", sessions: ["s1"] },
    summary: {
      measured_min: 1,
      idle_excluded_min: 0,
      estimated_floor_min: 1,
      recoverable_min: 0,
      human_wait_min: 0,
      unexplained_min: 0,
      baseline: {
        prs: 3,
        notable: [
          { metric: "recoverable_min", value: 0, baseline: 0.25 },
        ],
      },
    },
    findings: [
      {
        finding_key: "R001:example",
        rule_id: "R001",
        title: "Rework did not survive the final diff",
        classification: "behavior",
        cause: "missing_context",
        evidence: {
          session_refs: ["s1#u1"],
          interval_ids: ["rework-1"],
          changed_path: "src/example.ts",
        },
        recoverable: { min: 0.25, bound: "point" },
        confidence: "high",
        scope: "this_pr",
        fix_recipe: {
          suggestion: "Confirm the target before editing.",
          verify: "git diff --check",
        },
        caveats: [],
      },
    ],
    caveats: [],
  };

  assert.deepEqual(JSON.parse(JSON.stringify(report)), {
    version: 2,
    unit: { repo: "/repo", pr_ref: "main...head", sessions: ["s1"] },
    summary: {
      measured_min: 1,
      idle_excluded_min: 0,
      estimated_floor_min: 1,
      recoverable_min: 0,
      human_wait_min: 0,
      unexplained_min: 0,
      baseline: {
        prs: 3,
        notable: [
          { metric: "recoverable_min", value: 0, baseline: 0.25 },
        ],
      },
    },
    findings: [
      {
        finding_key: "R001:example",
        rule_id: "R001",
        title: "Rework did not survive the final diff",
        classification: "behavior",
        cause: "missing_context",
        evidence: {
          session_refs: ["s1#u1"],
          interval_ids: ["rework-1"],
          changed_path: "src/example.ts",
        },
        recoverable: { min: 0.25, bound: "point" },
        confidence: "high",
        scope: "this_pr",
        fix_recipe: {
          suggestion: "Confirm the target before editing.",
          verify: "git diff --check",
        },
        caveats: [],
      },
    ],
    caveats: [],
  });
});

function makeSession(
  sessionId: string,
  capabilities: readonly SessionCapability[] = ALL_SESSION_CAPABILITIES,
  capabilityDescriptor: CapabilityDescriptorV1 =
    legacyCapabilitiesToDescriptor(ALL_SESSION_CAPABILITIES),
  source: Session["source"] = "claude",
): Session {
  return {
    session_id: sessionId,
    source,
    source_path: `/repo/${sessionId}.jsonl`,
    observed_cwds: ["/repo"],
    observed_branches: ["main"],
    started_at_ms: 0,
    ended_at_ms: 1,
    confidence: "high",
    events: [],
    warnings: [],
    capabilities,
    capability_descriptor: capabilityDescriptor,
  };
}

function descriptorFor(options: {
  id?: string;
  state: string;
  quality: string;
  provenance: string;
  timestampPrecision?: string;
}): CapabilityDescriptorV1 {
  return validateCapabilityDescriptor({
    $schema: CAPABILITY_DESCRIPTOR_SCHEMA_ID,
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    descriptor_version: CAPABILITY_DESCRIPTOR_VERSION,
    undeclared_capability_state: CAPABILITY_UNDECLARED_STATE,
    capabilities: [{
      id: options.id ?? "ccprof.dev/capabilities/token_usage",
      version: CAPABILITY_DESCRIPTOR_VERSION,
      requirement: "optional",
      state: options.state,
      evidence: {
        quality: options.quality,
        provenance: options.provenance,
      },
      timestamp_precision: options.timestampPrecision ?? "not_applicable",
    }],
  });
}

test("ruleApplicability: every rule is applicable with explicit validated evidence", () => {
  const sessions = [makeSession("s1"), makeSession("s2")];
  const results = ruleApplicability(sessions);

  assert.deepEqual(
    results.map((entry) => entry.rule_id).sort(),
    Object.keys(RULE_REQUIRED_CAPABILITIES).sort(),
  );
  for (const entry of results) {
    assert.equal(entry.applicable, true, `${entry.rule_id} should be applicable`);
    assert.deepEqual(entry.missing, []);
  }
});

test("rule applicability intersects source-neutral descriptor and session evidence", () => {
  const source = "dev.example/producers/dummy-agent";
  const capability = "token_usage" as const;
  const exact = descriptorFor({
    state: "supported_exact",
    quality: "exact",
    provenance: "producer_declared",
  });
  const validDescriptors: readonly [string, CapabilityDescriptorV1][] = [
    ["exact", exact],
    ["estimated", descriptorFor({
      state: "supported_estimated",
      quality: "estimated",
      provenance: "observed",
    })],
    ["partial", descriptorFor({
      state: "supported_partial",
      quality: "partial",
      provenance: "adapter_declared",
    })],
    [
      "legacy partial unknown",
      legacyCapabilitiesToDescriptor([capability]),
    ],
  ];
  for (const [label, descriptor] of validDescriptors) {
    const value = makeSession(
      label.replaceAll(" ", "-"),
      [capability],
      descriptor,
      source,
    );
    assert.equal(value.source, source);
    assert.equal(sessionSupportsRule(value, "R007"), true, label);
  }

  const withoutSubset = makeSession("without-subset", [capability], exact, source);
  delete withoutSubset.capabilities;
  const withoutDescriptor = makeSession(
    "without-descriptor",
    [capability],
    exact,
    source,
  );
  delete withoutDescriptor.capability_descriptor;
  const invalidTuple = structuredClone(exact) as unknown as {
    capabilities: Array<{ evidence: { quality: string } }>;
  };
  invalidTuple.capabilities[0]!.evidence.quality = "partial";
  const failClosed = [
    ["absent subset", withoutSubset],
    ["absent descriptor", withoutDescriptor],
    ["undeclared", makeSession(
      "undeclared",
      [capability],
      descriptorFor({
        id: "dummy.example/capabilities/neutral_signal",
        state: "supported_exact",
        quality: "exact",
        provenance: "producer_declared",
      }),
      source,
    )],
    ["unknown", makeSession(
      "unknown",
      [capability],
      descriptorFor({
        state: "unknown",
        quality: "unknown",
        provenance: "unknown",
        timestampPrecision: "unknown",
      }),
      source,
    )],
    ["unsupported", makeSession(
      "unsupported",
      [capability],
      descriptorFor({
        state: "unsupported",
        quality: "none",
        provenance: "adapter_declared",
      }),
      source,
    )],
    ["invalid tuple", makeSession(
      "invalid-tuple",
      [capability],
      invalidTuple as unknown as CapabilityDescriptorV1,
      source,
    )],
  ] as const;
  for (const [label, value] of failClosed) {
    assert.equal(sessionSupportsRule(value, "R007"), false, label);
    assert.equal(sessionSupportsRule(value, "R002"), true, label);
  }
});

test("ruleApplicability: a session missing token_usage makes only R007 inapplicable", () => {
  const limitedCapabilities = ALL_SESSION_CAPABILITIES.filter(
    (capability) => capability !== "token_usage",
  );
  const sessions = [
    makeSession("full"),
    makeSession("limited", limitedCapabilities),
  ];
  const results = ruleApplicability(sessions);

  for (const entry of results) {
    if (entry.rule_id === "R007") {
      assert.equal(entry.applicable, false);
      assert.deepEqual(entry.missing, ["token_usage"]);
    } else {
      assert.equal(entry.applicable, true, `${entry.rule_id} should stay applicable`);
      assert.deepEqual(entry.missing, []);
    }
  }
});

test("ruleApplicability: a session missing edit_fragments makes only R001 inapplicable", () => {
  const limitedCapabilities = ALL_SESSION_CAPABILITIES.filter(
    (capability) => capability !== "edit_fragments",
  );
  const sessions = [makeSession("limited", limitedCapabilities)];
  const results = ruleApplicability(sessions);

  for (const entry of results) {
    if (entry.rule_id === "R001") {
      assert.equal(entry.applicable, false);
      assert.deepEqual(entry.missing, ["edit_fragments"]);
    } else {
      assert.equal(entry.applicable, true);
      assert.deepEqual(entry.missing, []);
    }
  }
});

test("ruleApplicability: a session missing tool_timestamps makes only R005 inapplicable", () => {
  const limitedCapabilities = ALL_SESSION_CAPABILITIES.filter(
    (capability) => capability !== "tool_timestamps",
  );
  const sessions = [makeSession("limited", limitedCapabilities)];
  const results = ruleApplicability(sessions);

  for (const entry of results) {
    if (entry.rule_id === "R005") {
      assert.equal(entry.applicable, false);
      assert.deepEqual(entry.missing, ["tool_timestamps"]);
    } else {
      assert.equal(entry.applicable, true);
      assert.deepEqual(entry.missing, []);
    }
  }
});

test("ruleApplicability: capability requirements are unaffected by session order", () => {
  const limitedCapabilities = ALL_SESSION_CAPABILITIES.filter(
    (capability) => capability !== "token_usage",
  );
  const forward = ruleApplicability([
    makeSession("limited", limitedCapabilities),
    makeSession("full"),
  ]);
  const backward = ruleApplicability([
    makeSession("full"),
    makeSession("limited", limitedCapabilities),
  ]);
  assert.deepEqual(forward, backward);
});

test("RULE_REQUIRED_CAPABILITIES declares the verified per-rule capability map", () => {
  assert.deepEqual(RULE_REQUIRED_CAPABILITIES, {
    R001: ["edit_fragments"],
    R002: [],
    R003: [],
    R004: [],
    R005: ["tool_timestamps"],
    R006: [],
    R007: ["token_usage"],
    R008: [],
  });
});
