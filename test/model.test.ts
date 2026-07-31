import assert from "node:assert/strict";
import test from "node:test";

import { makeSessionRef, type ReportV2 } from "../src/core/model.js";

test("shared report contract includes all required summary fields", () => {
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
      baseline: null,
    },
    findings: [],
    caveats: [],
  };

  assert.equal(report.version, 2);
});
