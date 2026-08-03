import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_SESSION_CAPABILITIES,
  type RuleId,
  type RuleCoverage,
  type Session,
  type SessionCapability,
} from "../src/core/model.js";
import {
  RULE_REQUIRED_CAPABILITIES,
  ruleCoverage,
} from "../src/rules/capabilities.js";

function session(options: {
  id: string;
  source?: Session["source"];
  capabilities?: readonly SessionCapability[];
  warningCode?: string;
}): Session {
  const source = options.source ?? "claude";
  return {
    session_id: options.id,
    source,
    source_path: `/private/${source}/${options.id}.jsonl`,
    observed_cwds: ["/repo"],
    observed_branches: ["main"],
    started_at_ms: 1,
    ended_at_ms: 2,
    confidence: "high",
    events: [],
    warnings: options.warningCode === undefined
      ? []
      : [{
        code: options.warningCode,
        message: "SECRET parser detail",
        source_path: "/private/SECRET.jsonl",
        session_ref: "SECRET-session",
      }],
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
  };
}

function coverage(
  entries: readonly RuleCoverage[],
  ruleId: RuleCoverage["rule_id"],
): RuleCoverage {
  const entry = entries.find(({ rule_id }) => rule_id === ruleId);
  assert.ok(entry);
  return entry;
}

test("ruleCoverage emits the exact deterministic R001-R008 contract", () => {
  const limited = ALL_SESSION_CAPABILITIES.filter(
    (capability) => capability !== "token_usage",
  );
  const result = ruleCoverage([
    session({ id: "claude-full" }),
    session({ id: "codex-limited", source: "codex", capabilities: limited }),
  ]);

  assert.deepEqual(
    result.map(({ rule_id }) => rule_id),
    ["R001", "R002", "R003", "R004", "R005", "R006", "R007", "R008"],
  );
  for (const entry of result) {
    assert.deepEqual(Object.keys(entry), [
      "rule_id",
      "eligible_sessions",
      "total_sessions",
      "status",
      "missing_capabilities",
      "completeness",
      "truncated",
    ], entry.rule_id);
  }
  assert.deepEqual(coverage(result, "R007"), {
    rule_id: "R007",
    eligible_sessions: 1,
    total_sessions: 2,
    status: "partial",
    missing_capabilities: ["token_usage"],
    completeness: 0.5,
    truncated: false,
  });
  for (const entry of result.filter(({ rule_id }) => rule_id !== "R007")) {
    assert.equal(entry.eligible_sessions, 2, entry.rule_id);
    assert.equal(entry.total_sessions, 2, entry.rule_id);
    assert.equal(entry.status, "full", entry.rule_id);
    assert.deepEqual(entry.missing_capabilities, [], entry.rule_id);
    assert.equal(entry.completeness, 1, entry.rule_id);
    assert.equal(entry.truncated, false, entry.rule_id);
  }
});

test("ruleCoverage handles zero eligible and required-empty rules", () => {
  const result = ruleCoverage([
    session({ id: "limited", source: "codex", capabilities: [] }),
  ]);

  assert.deepEqual(coverage(result, "R001"), {
    rule_id: "R001",
    eligible_sessions: 0,
    total_sessions: 1,
    status: "partial",
    missing_capabilities: ["edit_fragments"],
    completeness: 0,
    truncated: false,
  });
  assert.deepEqual(coverage(result, "R005").missing_capabilities, [
    "tool_timestamps",
  ]);
  assert.deepEqual(coverage(result, "R007").missing_capabilities, [
    "token_usage",
  ]);
  assert.deepEqual(coverage(result, "R006"), {
    rule_id: "R006",
    eligible_sessions: 1,
    total_sessions: 1,
    status: "full",
    missing_capabilities: [],
    completeness: 1,
    truncated: false,
  });
});

test("ruleCoverage defines empty input as finite full coverage", () => {
  for (const entry of ruleCoverage([])) {
    assert.equal(entry.eligible_sessions, 0, entry.rule_id);
    assert.equal(entry.total_sessions, 0, entry.rule_id);
    assert.equal(entry.status, "full", entry.rule_id);
    assert.deepEqual(entry.missing_capabilities, [], entry.rule_id);
    assert.equal(entry.completeness, 1, entry.rule_id);
    assert.ok(Number.isFinite(entry.completeness), entry.rule_id);
    assert.equal(entry.truncated, false, entry.rule_id);
  }
});

test("ruleCoverage is order-independent and undefined capabilities remain full", () => {
  const sessions = [
    session({ id: "legacy" }),
    session({
      id: "limited",
      source: "codex",
      capabilities: ["edit_fragments", "tool_timestamps"],
    }),
  ];
  assert.deepEqual(ruleCoverage(sessions), ruleCoverage([...sessions].reverse()));
  assert.equal(coverage(ruleCoverage([sessions[0]!]), "R007").status, "full");
});

test("ruleCoverage computes non-binary ratios and canonical missing unions", () => {
  const mutableRequirements = RULE_REQUIRED_CAPABILITIES as Record<
    RuleId,
    readonly SessionCapability[]
  >;
  const original = mutableRequirements.R001;
  mutableRequirements.R001 = ["tool_timestamps", "edit_fragments"];
  try {
    const result = coverage(ruleCoverage([
      session({ id: "eligible" }),
      session({ id: "missing-edit", capabilities: ["tool_timestamps"] }),
      session({ id: "missing-time", capabilities: ["edit_fragments"] }),
    ]), "R001");
    assert.equal(result.eligible_sessions, 1);
    assert.equal(result.total_sessions, 3);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.missing_capabilities, [
      "edit_fragments",
      "tool_timestamps",
    ]);
    assert.equal(result.completeness, 1 / 3);
    assert.ok(Number.isFinite(result.completeness));
  } finally {
    mutableRequirements.R001 = original;
  }
});

test("ruleCoverage truncation uses only admitted parser codes and partial windows", () => {
  const full = session({ id: "full" });
  const limited = session({
    id: "limited",
    source: "codex",
    capabilities: ["edit_fragments", "tool_timestamps"],
    warningCode: "parser_line_budget_exceeded",
  });
  const complete = ruleCoverage([full, limited]);

  assert.equal(coverage(complete, "R001").truncated, true);
  assert.equal(coverage(complete, "R005").truncated, true);
  assert.equal(
    coverage(complete, "R007").truncated,
    false,
    "an ineligible warning must not contaminate the admitted R007 lane",
  );
  assert.ok(!JSON.stringify(complete).includes("SECRET"));

  const unrelated = ruleCoverage([
    session({ id: "unrelated", warningCode: "invalid_json" }),
  ]);
  assert.ok(unrelated.every(({ truncated }) => truncated === false));

  const partialWindow = ruleCoverage([full, limited], "partial");
  assert.ok(partialWindow.every(({ truncated }) => truncated === true));

  for (const warningCode of [
    "parser_file_budget_exceeded",
    "parser_line_budget_exceeded",
    "parser_node_budget_exceeded",
    "parser_depth_budget_exceeded",
    "parser_byte_budget_exceeded",
    "parser_warning_budget_exceeded",
    "parser_content_truncated",
  ]) {
    const entries = ruleCoverage([
      session({ id: warningCode, warningCode }),
    ]);
    assert.ok(entries.every(({ truncated }) => truncated), warningCode);
  }

  const zeroEligible = coverage(ruleCoverage([
    session({
      id: "zero-eligible",
      capabilities: [],
      warningCode: "parser_file_budget_exceeded",
    }),
  ]), "R007");
  assert.equal(zeroEligible.eligible_sessions, 0);
  assert.equal(zeroEligible.truncated, false);
});
