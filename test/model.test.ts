import assert from "node:assert/strict";
import test from "node:test";

import { makeSessionRef, type ReportV2 } from "../src/core/model.js";

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
