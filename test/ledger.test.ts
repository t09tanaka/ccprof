import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileLedger,
  type LedgerResult,
} from "../src/core/ledger.js";
import type {
  Bound,
  FindingCandidate,
  Interval,
  RuleId,
} from "../src/core/model.js";

function candidate(
  ruleId: RuleId,
  key: string,
  bound: Bound,
  intervals: readonly Interval[],
  estimatedMs = intervals.reduce(
    (total, interval) => total + interval.end_ms - interval.start_ms,
    0,
  ),
): FindingCandidate {
  return {
    finding_key: key,
    rule_id: ruleId,
    title: key,
    classification: "behavior",
    cause: ruleId === "R001" ? "unknown" : null,
    scope: "separate_issue",
    confidence: "high",
    target: key,
    evidence: {
      session_refs: [`s1#${key}`],
      interval_ids: intervals.map((_, index) => `${key}-${index}`),
    },
    recoverable: {
      bound,
      estimated_ms: estimatedMs,
      intervals: intervals.map((interval, index) => ({
        ...interval,
        interval_id: `${key}-${index}`,
        target: key,
      })),
    },
    fix_recipe: {
      suggestion: `fix ${key}`,
      verify: "git diff --check",
    },
    caveats: [],
  };
}

function attribution(
  result: LedgerResult,
  key: string,
) {
  const found = result.attributions.find(
    (entry) => entry.finding_key === key,
  );
  assert.ok(found, `missing attribution ${key}`);
  return found;
}

test("partitions wall-clock time with exclusive point precedence", () => {
  const result = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 120_000 }],
    activeIntervals: [{ start_ms: 0, end_ms: 90_000 }],
    contributingIntervals: [
      { start_ms: 0, end_ms: 20_000 },
      { start_ms: 55_000, end_ms: 80_000 },
    ],
    candidates: [
      candidate(
        "R001",
        "rework",
        "point",
        [{ start_ms: 10_000, end_ms: 50_000 }],
        999_999,
      ),
      candidate(
        "R008",
        "flaky",
        "point",
        [
          { start_ms: 30_000, end_ms: 60_000 },
          { start_ms: 30_000, end_ms: 60_000 },
          { start_ms: 40_000, end_ms: 55_000 },
        ],
      ),
      candidate(
        "R002",
        "redundant",
        "point",
        [{ start_ms: 20_000, end_ms: 40_000 }],
      ),
      candidate(
        "R005",
        "serial-upper",
        "upper",
        [{ start_ms: 60_000, end_ms: 85_000 }],
        20_000,
      ),
      candidate(
        "R007",
        "context-upper",
        "upper",
        [{ start_ms: 70_000, end_ms: 90_000 }],
        15_000,
      ),
    ],
  });

  assert.deepEqual(attribution(result, "flaky").intervals, [
    { start_ms: 30_000, end_ms: 60_000 },
  ]);
  assert.deepEqual(attribution(result, "rework").intervals, [
    { start_ms: 10_000, end_ms: 30_000 },
  ]);
  assert.deepEqual(attribution(result, "redundant").intervals, []);
  assert.equal(attribution(result, "serial-upper").attributed_ms, 0);
  assert.equal(attribution(result, "context-upper").attributed_ms, 0);

  assert.deepEqual(result.pointRecoverableIntervals, [
    { start_ms: 10_000, end_ms: 60_000 },
  ]);
  assert.deepEqual(result.normalIntervals, [
    { start_ms: 0, end_ms: 10_000 },
    { start_ms: 60_000, end_ms: 80_000 },
  ]);
  assert.deepEqual(result.unexplainedIntervals, [
    { start_ms: 80_000, end_ms: 90_000 },
  ]);
  assert.deepEqual(result.idleIntervals, [
    { start_ms: 90_000, end_ms: 120_000 },
  ]);
  assert.deepEqual(result.totals_ms, {
    raw_observed: 120_000,
    measured: 90_000,
    idle_excluded: 30_000,
    normal: 30_000,
    recoverable: 50_000,
    human_wait: 0,
    unexplained: 10_000,
  });

  assert.equal(result.raw_observed_min, 2);
  assert.equal(result.normal_min, 0.5);
  assert.deepEqual(result.summary, {
    measured_min: 1.5,
    idle_excluded_min: 0.5,
    estimated_floor_min: 0.67,
    recoverable_min: 0.83,
    human_wait_min: 0,
    unexplained_min: 0.17,
    baseline: null,
  });
  assert.equal(
    result.summary.measured_min,
    result.normal_min +
      result.summary.recoverable_min +
      result.summary.human_wait_min +
      result.summary.unexplained_min,
  );
  assert.equal(
    result.raw_observed_min,
    result.summary.measured_min + result.summary.idle_excluded_min,
  );
  assert.equal(
    result.summary.estimated_floor_min,
    result.summary.measured_min - result.summary.recoverable_min,
  );

  const findingByKey = new Map(
    result.findings.map((finding) => [finding.finding_key, finding]),
  );
  assert.deepEqual(findingByKey.get("flaky")?.recoverable, {
    min: 0.5,
    bound: "point",
  });
  assert.deepEqual(findingByKey.get("rework")?.recoverable, {
    min: 0.33,
    bound: "point",
  });
  assert.deepEqual(findingByKey.get("redundant")?.recoverable, {
    min: 0,
    bound: "point",
  });
  assert.deepEqual(findingByKey.get("serial-upper")?.recoverable, {
    min: 0.33,
    bound: "upper",
  });
  assert.deepEqual(findingByKey.get("context-upper")?.recoverable, {
    min: 0.25,
    bound: "upper",
  });
});

test("public findings keep the candidate target", () => {
  const result = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 1_000 }],
    activeIntervals: [{ start_ms: 0, end_ms: 1_000 }],
    contributingIntervals: [{ start_ms: 0, end_ms: 500 }],
    candidates: [
      candidate("R001", "src/foo.ts", "point", [
        { start_ms: 0, end_ms: 500 },
      ]),
    ],
  });

  assert.equal(result.findings[0]?.target, "src/foo.ts");
});

test("rounds a partition once without a negative residual", () => {
  const result = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 1_801 }],
    activeIntervals: [{ start_ms: 0, end_ms: 1_201 }],
    contributingIntervals: [{ start_ms: 400, end_ms: 800 }],
    candidates: [
      candidate(
        "R001",
        "small-rework",
        "point",
        [{ start_ms: 0, end_ms: 400 }],
      ),
      candidate(
        "R005",
        "small-upper",
        "upper",
        [{ start_ms: 800, end_ms: 1_201 }],
        50_000,
      ),
    ],
  });

  assert.deepEqual(result.totals_ms, {
    raw_observed: 1_801,
    measured: 1_201,
    idle_excluded: 600,
    normal: 400,
    recoverable: 400,
    human_wait: 0,
    unexplained: 401,
  });
  assert.equal(
    result.summary.measured_min,
    result.normal_min +
      result.summary.recoverable_min +
      result.summary.human_wait_min +
      result.summary.unexplained_min,
  );
  assert.equal(
    result.raw_observed_min,
    result.summary.measured_min + result.summary.idle_excluded_min,
  );
  assert.equal(
    result.summary.estimated_floor_min,
    result.summary.measured_min - result.summary.recoverable_min,
  );
  assert.ok(result.normal_min >= 0);
  assert.ok(result.summary.recoverable_min >= 0);
  assert.ok(result.summary.unexplained_min >= 0);
  assert.ok(result.summary.estimated_floor_min >= 0);
  assert.equal(
    result.findings.find(
      (finding) => finding.finding_key === "small-upper",
    )?.recoverable.min,
    0.83,
  );
});

test("partitions human wait separately with recoverable precedence", () => {
  const result = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 120_000 }],
    activeIntervals: [{ start_ms: 0, end_ms: 120_000 }],
    contributingIntervals: [{ start_ms: 0, end_ms: 30_000 }],
    humanWaitIntervals: [{ start_ms: 30_000, end_ms: 90_000 }],
    candidates: [
      candidate(
        "R004",
        "approval",
        "point",
        [{ start_ms: 60_000, end_ms: 90_000 }],
      ),
    ],
  });

  assert.deepEqual(result.pointRecoverableIntervals, [
    { start_ms: 60_000, end_ms: 90_000 },
  ]);
  assert.deepEqual(result.humanWaitIntervals, [
    { start_ms: 30_000, end_ms: 60_000 },
  ]);
  assert.deepEqual(result.normalIntervals, [
    { start_ms: 0, end_ms: 30_000 },
  ]);
  assert.deepEqual(result.unexplainedIntervals, [
    { start_ms: 90_000, end_ms: 120_000 },
  ]);
  assert.deepEqual(result.totals_ms, {
    raw_observed: 120_000,
    measured: 120_000,
    idle_excluded: 0,
    normal: 30_000,
    recoverable: 30_000,
    human_wait: 30_000,
    unexplained: 30_000,
  });
  assert.deepEqual(result.summary, {
    measured_min: 2,
    idle_excluded_min: 0,
    estimated_floor_min: 1.5,
    recoverable_min: 0.5,
    human_wait_min: 0.5,
    unexplained_min: 0.5,
    baseline: null,
  });
  assert.equal(result.normal_min, 0.5);
});

test("human wait overlapping contributing time wins over normal", () => {
  const result = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 60_000 }],
    activeIntervals: [{ start_ms: 0, end_ms: 60_000 }],
    contributingIntervals: [{ start_ms: 0, end_ms: 60_000 }],
    humanWaitIntervals: [{ start_ms: 30_000, end_ms: 60_000 }],
    candidates: [],
  });

  assert.deepEqual(result.humanWaitIntervals, [
    { start_ms: 30_000, end_ms: 60_000 },
  ]);
  assert.deepEqual(result.normalIntervals, [
    { start_ms: 0, end_ms: 30_000 },
  ]);
  assert.deepEqual(result.unexplainedIntervals, []);
});

test("the four-way partition identity holds after rounding", () => {
  const result = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 2_401 }],
    activeIntervals: [{ start_ms: 0, end_ms: 2_401 }],
    contributingIntervals: [{ start_ms: 1_002, end_ms: 1_803 }],
    humanWaitIntervals: [{ start_ms: 401, end_ms: 1_002 }],
    candidates: [
      candidate(
        "R001",
        "tiny-rework",
        "point",
        [{ start_ms: 0, end_ms: 401 }],
      ),
    ],
  });

  assert.deepEqual(result.totals_ms, {
    raw_observed: 2_401,
    measured: 2_401,
    idle_excluded: 0,
    normal: 801,
    recoverable: 401,
    human_wait: 601,
    unexplained: 598,
  });
  assert.equal(
    result.summary.measured_min,
    result.normal_min +
      result.summary.recoverable_min +
      result.summary.human_wait_min +
      result.summary.unexplained_min,
  );
  assert.equal(
    result.raw_observed_min,
    result.summary.measured_min + result.summary.idle_excluded_min,
  );
  assert.equal(
    result.summary.estimated_floor_min,
    result.summary.measured_min - result.summary.recoverable_min,
  );
  for (const value of [
    result.normal_min,
    result.summary.recoverable_min,
    result.summary.human_wait_min,
    result.summary.unexplained_min,
  ]) {
    assert.ok(value >= 0);
  }
});
