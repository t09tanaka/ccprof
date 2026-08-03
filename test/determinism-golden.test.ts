import assert from "node:assert/strict";
import test from "node:test";

import type { ReportV2 } from "../src/core/model.js";
import { renderJsonReport } from "../src/reporters/json.js";

const report: ReportV2 = {
  version: 2,
  unit: {
    repo: "/repo",
    pr_ref: "main...feature",
    sessions: ["session-a"],
  },
  summary: {
    measured_min: 1,
    idle_excluded_min: 0,
    estimated_floor_min: 1,
    recoverable_min: 0,
    human_wait_min: 0,
    unexplained_min: 0,
    baseline: null,
  },
  findings: [{
    finding_key: "R002:stable",
    rule_id: "R002",
    title: "Repeated command",
    classification: "behavior",
    cause: null,
    scope: "this_pr",
    confidence: "high",
    impact: {
      lower_ms: 60_000,
      expected_ms: 90_000,
      upper_ms: 120_000,
      kind: "critical_path_latency",
    },
    finding_confidence: {
      evidence: "high",
      causal: "high",
      source_completeness: 1,
    },
    severity: "high",
    scoring_rationale: ["observed_lower_bound"],
    evidence: {
      session_refs: ["session-a#1"],
      interval_ids: ["R002:stable"],
    },
    recoverable: { min: 2, bound: "upper" },
    fix_recipe: {
      suggestion: "Run focused tests while iterating.",
      verify: "npm test",
    },
    caveats: [],
  }],
  caveats: [],
};

const golden = `{
  "version": 2,
  "unit": {
    "repo": "/repo",
    "pr_ref": "main...feature",
    "sessions": [
      "session-a"
    ]
  },
  "summary": {
    "measured_min": 1,
    "idle_excluded_min": 0,
    "estimated_floor_min": 1,
    "recoverable_min": 0,
    "human_wait_min": 0,
    "unexplained_min": 0,
    "baseline": null
  },
  "findings": [
    {
      "finding_key": "R002:stable",
      "rule_id": "R002",
      "title": "Repeated command",
      "classification": "behavior",
      "cause": null,
      "scope": "this_pr",
      "confidence": "high",
      "impact": {
        "lower_ms": 60000,
        "expected_ms": 90000,
        "upper_ms": 120000,
        "kind": "critical_path_latency"
      },
      "finding_confidence": {
        "evidence": "high",
        "causal": "high",
        "source_completeness": 1
      },
      "severity": "high",
      "scoring_rationale": [
        "observed_lower_bound"
      ],
      "evidence": {
        "session_refs": [
          "session-a#1"
        ],
        "interval_ids": [
          "R002:stable"
        ]
      },
      "recoverable": {
        "min": 2,
        "bound": "upper"
      },
      "fix_recipe": {
        "suggestion": "Run focused tests while iterating.",
        "verify": "npm test"
      },
      "caveats": []
    }
  ],
  "caveats": []
}
`;

test("JSON report is byte-identical for a fixed analysis snapshot", () => {
  const first = renderJsonReport(report);
  const second = renderJsonReport(structuredClone(report));

  assert.equal(first, golden);
  assert.equal(second, golden);
});
