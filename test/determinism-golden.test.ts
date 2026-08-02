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
  findings: [],
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
  "findings": [],
  "caveats": []
}
`;

test("JSON report is byte-identical for a fixed analysis snapshot", () => {
  const first = renderJsonReport(report);
  const second = renderJsonReport(structuredClone(report));

  assert.equal(first, golden);
  assert.equal(second, golden);
});
