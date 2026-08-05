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
} from "../src/rules/capabilities.js";
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
): Session {
  return {
    session_id: sessionId,
    source: "claude",
    source_path: `/repo/${sessionId}.jsonl`,
    observed_cwds: ["/repo"],
    observed_branches: ["main"],
    started_at_ms: 0,
    ended_at_ms: 1,
    confidence: "high",
    events: [],
    warnings: [],
    capabilities,
    capability_descriptor: legacyCapabilitiesToDescriptor(capabilities),
  };
}

test("ruleApplicability: required evidence needs an explicit subset and descriptor", () => {
  const withoutSubset = makeSession("without-subset");
  delete withoutSubset.capabilities;
  const withoutDescriptor = makeSession("without-descriptor");
  delete withoutDescriptor.capability_descriptor;

  for (const session of [withoutSubset, withoutDescriptor]) {
    const results = ruleApplicability([session]);
    const required = results.find(({ rule_id }) => rule_id === "R007");
    const requirementEmpty = results.find(({ rule_id }) => rule_id === "R002");
    assert.deepEqual(required, {
      rule_id: "R007",
      applicable: false,
      missing: ["token_usage"],
    });
    assert.deepEqual(requirementEmpty, {
      rule_id: "R002",
      applicable: true,
      missing: [],
    });
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
