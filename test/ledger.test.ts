import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileLedger,
  type LedgerResult,
} from "../src/core/ledger.js";
import {
  findingScoringRationale,
  findingSeverity,
  projectFindingConfidence,
} from "../src/core/model.js";
import type {
  Bound,
  FindingCandidate,
  FindingConfidence,
  ImpactEstimate,
  Interval,
  RuleId,
} from "../src/core/model.js";

interface CandidateContractOverrides {
  impact?: ImpactEstimate;
  findingConfidence?: FindingConfidence;
  intervalIds?: readonly string[];
}

function candidate(
  ruleId: RuleId,
  key: string,
  bound: Bound,
  intervals: readonly Interval[],
  estimatedMs = intervals.reduce(
    (total, interval) => total + interval.end_ms - interval.start_ms,
    0,
  ),
  overrides: CandidateContractOverrides = {},
): FindingCandidate {
  const kind = ruleId === "R005" || ruleId === "R006"
    ? "resource_cost" as const
    : "critical_path_latency" as const;
  const lowerMs = bound === "point" ? estimatedMs : 0;
  const impact: ImpactEstimate = overrides.impact ?? {
    lower_ms: lowerMs,
    upper_ms: estimatedMs,
    kind,
  };
  const findingConfidence: FindingConfidence = overrides.findingConfidence ?? {
    evidence: "high",
    causal: "high",
    source_completeness: 1,
  };
  return {
    finding_key: key,
    rule_id: ruleId,
    title: key,
    classification: "behavior",
    cause: ruleId === "R001" ? "unknown" : null,
    scope: "separate_issue",
    confidence: projectFindingConfidence(findingConfidence),
    impact,
    finding_confidence: findingConfidence,
    severity: findingSeverity(impact, findingConfidence),
    scoring_rationale: findingScoringRationale(impact, findingConfidence),
    target: key,
    evidence: {
      session_refs: [`s1#${key}`],
      interval_ids: intervals.map((_, index) =>
        overrides.intervalIds?.[index] ?? `${key}-${index}`
      ),
    },
    recoverable: {
      bound,
      estimated_ms: estimatedMs,
      intervals: intervals.map((interval, index) => ({
        ...interval,
        interval_id: overrides.intervalIds?.[index] ?? `${key}-${index}`,
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
  assert.equal(attribution(result, "flaky").reported_ms, 30_000);
  assert.equal(attribution(result, "rework").reported_ms, 20_000);
  assert.equal(attribution(result, "redundant").reported_ms, 0);

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
    min: 1.25,
    bound: "point",
  });
  assert.deepEqual(findingByKey.get("rework")?.recoverable, {
    min: 16.66665,
    bound: "point",
  });
  assert.deepEqual(findingByKey.get("redundant")?.recoverable, {
    min: 1 / 3,
    bound: "point",
  });
  assert.deepEqual(findingByKey.get("serial-upper")?.recoverable, {
    min: 1 / 3,
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
    50_000 / 60_000,
  );
});

test("R004 policy latency never attributes recoverable time or lowers the floor", () => {
  const result = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 120_000 }],
    activeIntervals: [{ start_ms: 0, end_ms: 120_000 }],
    contributingIntervals: [{ start_ms: 0, end_ms: 30_000 }],
    humanWaitIntervals: [{ start_ms: 30_000, end_ms: 90_000 }],
    candidates: [
      candidate(
        "R004",
        "approval-upper",
        "upper",
        [{ start_ms: 60_000, end_ms: 90_000 }],
        30_000,
        {
          impact: {
            lower_ms: 0,
            upper_ms: 30_000,
            kind: "critical_path_latency",
          },
        },
      ),
      candidate(
        "R004",
        "approval-zero",
        "point",
        [],
        0,
        {
          impact: {
            lower_ms: 0,
            upper_ms: 0,
            kind: "critical_path_latency",
          },
        },
      ),
    ],
  });

  assert.deepEqual(result.pointRecoverableIntervals, []);
  assert.deepEqual(result.humanWaitIntervals, [
    { start_ms: 30_000, end_ms: 90_000 },
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
    recoverable: 0,
    human_wait: 60_000,
    unexplained: 30_000,
  });
  assert.deepEqual(result.summary, {
    measured_min: 2,
    idle_excluded_min: 0,
    estimated_floor_min: 2,
    recoverable_min: 0,
    human_wait_min: 1,
    unexplained_min: 0.5,
    baseline: null,
  });
  assert.equal(result.normal_min, 0.5);
  assert.deepEqual(attribution(result, "approval-upper"), {
    finding_key: "approval-upper",
    rule_id: "R004",
    bound: "upper",
    intervals: [],
    attributed_ms: 0,
    reported_ms: 30_000,
  });
  assert.deepEqual(attribution(result, "approval-zero"), {
    finding_key: "approval-zero",
    rule_id: "R004",
    bound: "point",
    intervals: [],
    attributed_ms: 0,
    reported_ms: 0,
  });
  assert.deepEqual(
    result.findings.map(({ recoverable }) => recoverable),
    [
      { min: 0.5, bound: "upper" },
      { min: 0, bound: "point" },
    ],
  );
});

test("preserves observed human wait before finding attribution", () => {
  const result = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 120_000 }],
    activeIntervals: [{ start_ms: 20_000, end_ms: 100_000 }],
    contributingIntervals: [],
    humanWaitIntervals: [
      { start_ms: 0, end_ms: 50_000 },
      { start_ms: 40_000, end_ms: 90_000 },
      { start_ms: 110_000, end_ms: 120_000 },
    ],
    candidates: [
      candidate(
        "R004",
        "approval-attribution",
        "point",
        [{ start_ms: 60_000, end_ms: 80_000 }],
      ),
    ],
  });

  assert.deepEqual(result.observedHumanWaitIntervals, [
    { start_ms: 20_000, end_ms: 90_000 },
  ]);
  assert.deepEqual(result.humanWaitIntervals, [
    { start_ms: 20_000, end_ms: 60_000 },
    { start_ms: 80_000, end_ms: 90_000 },
  ]);
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

test("estimated floor accepts only strict high-confidence critical lower bounds", async (t) => {
  const cases: readonly {
    name: string;
    impact: ImpactEstimate;
    confidence: FindingConfidence;
    expectedIntervals: Interval[];
    expectedFloorMin: number;
  }[] = [
    {
      name: "strict critical lower bound",
      impact: {
        lower_ms: 30_000,
        upper_ms: 60_000,
        kind: "critical_path_latency",
      },
      confidence: {
        evidence: "high",
        causal: "high",
        source_completeness: 1,
      },
      expectedIntervals: [{ start_ms: 0, end_ms: 30_000 }],
      expectedFloorMin: 0.5,
    },
    {
      name: "resource cost",
      impact: {
        lower_ms: 30_000,
        upper_ms: 60_000,
        kind: "resource_cost",
      },
      confidence: {
        evidence: "high",
        causal: "high",
        source_completeness: 1,
      },
      expectedIntervals: [],
      expectedFloorMin: 1,
    },
    {
      name: "upper only",
      impact: {
        lower_ms: 0,
        upper_ms: 60_000,
        kind: "critical_path_latency",
      },
      confidence: {
        evidence: "high",
        causal: "high",
        source_completeness: 1,
      },
      expectedIntervals: [],
      expectedFloorMin: 1,
    },
    {
      name: "medium evidence",
      impact: {
        lower_ms: 30_000,
        upper_ms: 60_000,
        kind: "critical_path_latency",
      },
      confidence: {
        evidence: "medium",
        causal: "high",
        source_completeness: 1,
      },
      expectedIntervals: [],
      expectedFloorMin: 1,
    },
    {
      name: "low evidence",
      impact: {
        lower_ms: 30_000,
        upper_ms: 60_000,
        kind: "critical_path_latency",
      },
      confidence: {
        evidence: "low",
        causal: "high",
        source_completeness: 1,
      },
      expectedIntervals: [],
      expectedFloorMin: 1,
    },
    {
      name: "medium causal confidence",
      impact: {
        lower_ms: 30_000,
        upper_ms: 60_000,
        kind: "critical_path_latency",
      },
      confidence: {
        evidence: "high",
        causal: "medium",
        source_completeness: 1,
      },
      expectedIntervals: [],
      expectedFloorMin: 1,
    },
    {
      name: "partial source",
      impact: {
        lower_ms: 30_000,
        upper_ms: 60_000,
        kind: "critical_path_latency",
      },
      confidence: {
        evidence: "high",
        causal: "high",
        source_completeness: 0.5,
      },
      expectedIntervals: [],
      expectedFloorMin: 1,
    },
    {
      name: "low causal confidence",
      impact: {
        lower_ms: 30_000,
        upper_ms: 60_000,
        kind: "critical_path_latency",
      },
      confidence: {
        evidence: "high",
        causal: "low",
        source_completeness: 1,
      },
      expectedIntervals: [],
      expectedFloorMin: 1,
    },
    {
      name: "zero source completeness",
      impact: {
        lower_ms: 30_000,
        upper_ms: 60_000,
        kind: "critical_path_latency",
      },
      confidence: {
        evidence: "high",
        causal: "high",
        source_completeness: 0,
      },
      expectedIntervals: [],
      expectedFloorMin: 1,
    },
    {
      name: "legacy conservative projection",
      impact: {
        lower_ms: 0,
        upper_ms: 60_000,
        kind: "critical_path_latency",
      },
      confidence: {
        evidence: "medium",
        causal: "medium",
        source_completeness: 0.5,
      },
      expectedIntervals: [],
      expectedFloorMin: 1,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const bound = entry.impact.lower_ms === entry.impact.upper_ms
        ? "point"
        : "upper";
      const result = reconcileLedger({
        rawIntervals: [{ start_ms: 0, end_ms: 60_000 }],
        activeIntervals: [{ start_ms: 0, end_ms: 60_000 }],
        contributingIntervals: [],
        candidates: [candidate(
          "R002",
          entry.name,
          bound,
          [{ start_ms: 0, end_ms: 60_000 }],
          entry.impact.upper_ms,
          {
            impact: entry.impact,
            findingConfidence: entry.confidence,
          },
        )],
      });
      const withConfirmed = result as LedgerResult & {
        highConfidenceLowerBoundIntervals?: Interval[];
      };
      assert.deepEqual(
        withConfirmed.highConfidenceLowerBoundIntervals,
        entry.expectedIntervals,
      );
      assert.equal(result.summary.estimated_floor_min, entry.expectedFloorMin);
    });
  }
});

test("confirmed lower-bound intervals clip, cap, union, and deduplicate deterministically", () => {
  const first = candidate(
    "R001",
    "first",
    "upper",
    [
      { start_ms: 0, end_ms: 15_000 },
      { start_ms: 15_000, end_ms: 30_000 },
      { start_ms: 5_000, end_ms: 25_000 },
      { start_ms: 40_000, end_ms: 70_000 },
      { start_ms: 40_000, end_ms: 70_000 },
    ],
    70_000,
    {
      impact: {
        lower_ms: 35_000,
        upper_ms: 70_000,
        kind: "critical_path_latency",
      },
      intervalIds: ["same", "same", "nested", "tail", "tail"],
    },
  );
  const second = candidate(
    "R002",
    "second",
    "upper",
    [{ start_ms: 50_000, end_ms: 100_000 }],
    50_000,
    {
      impact: {
        lower_ms: 30_000,
        upper_ms: 50_000,
        kind: "critical_path_latency",
      },
    },
  );
  const excludedOverlap = candidate(
    "R003",
    "excluded-overlap",
    "point",
    [{ start_ms: 10_000, end_ms: 90_000 }],
    80_000,
    {
      findingConfidence: {
        evidence: "high",
        causal: "low",
        source_completeness: 1,
      },
    },
  );
  const resourceOverlap = candidate(
    "R005",
    "resource-overlap",
    "point",
    [{ start_ms: 30_000, end_ms: 90_000 }],
    60_000,
  );
  const input = {
    rawIntervals: [{ start_ms: 0, end_ms: 100_000 }],
    activeIntervals: [{ start_ms: 10_000, end_ms: 90_000 }],
    contributingIntervals: [],
    candidates: [first, second, excludedOverlap, resourceOverlap],
  };
  const forward = reconcileLedger(input) as LedgerResult & {
    highConfidenceLowerBoundIntervals?: Interval[];
  };
  const reversed = reconcileLedger({
    ...input,
    candidates: [
      resourceOverlap,
      excludedOverlap,
      { ...second, recoverable: {
        ...second.recoverable,
        intervals: [...second.recoverable.intervals].reverse(),
      } },
      { ...first, recoverable: {
        ...first.recoverable,
        intervals: [...first.recoverable.intervals].reverse(),
      } },
    ],
  }) as LedgerResult & { highConfidenceLowerBoundIntervals?: Interval[] };

  assert.deepEqual(forward.highConfidenceLowerBoundIntervals, [
    { start_ms: 10_000, end_ms: 30_000 },
    { start_ms: 40_000, end_ms: 80_000 },
  ]);
  assert.deepEqual(
    reversed.highConfidenceLowerBoundIntervals,
    forward.highConfidenceLowerBoundIntervals,
  );
  assert.equal(forward.summary.measured_min, 1.33);
  assert.equal(forward.summary.estimated_floor_min, 0.33);
  assert.equal(
    reversed.summary.estimated_floor_min,
    forward.summary.estimated_floor_min,
  );
});

test("confirmed floor rounds once, clamps, and handles zero measured time", () => {
  const rounded = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 1_201 }],
    activeIntervals: [{ start_ms: 0, end_ms: 1_201 }],
    contributingIntervals: [],
    candidates: [candidate(
      "R008",
      "rounded",
      "upper",
      [{ start_ms: 0, end_ms: 1_201 }],
      1_201,
      {
        impact: {
          lower_ms: 901,
          upper_ms: 1_201,
          kind: "critical_path_latency",
        },
      },
    )],
  }) as LedgerResult & { highConfidenceLowerBoundIntervals?: Interval[] };
  assert.deepEqual(rounded.highConfidenceLowerBoundIntervals, [
    { start_ms: 0, end_ms: 901 },
  ]);
  assert.equal(rounded.summary.measured_min, 0.02);
  assert.equal(rounded.summary.estimated_floor_min, 0);

  const evidenceLimited = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 1_201 }],
    activeIntervals: [{ start_ms: 0, end_ms: 1_201 }],
    contributingIntervals: [],
    candidates: [candidate(
      "R001",
      "evidence-limited",
      "point",
      [{ start_ms: 0, end_ms: 1_201 }],
      2_000,
    )],
  }) as LedgerResult & { highConfidenceLowerBoundIntervals?: Interval[] };
  assert.deepEqual(evidenceLimited.highConfidenceLowerBoundIntervals, [
    { start_ms: 0, end_ms: 1_201 },
  ]);
  assert.equal(evidenceLimited.summary.estimated_floor_min, 0);

  const zero = reconcileLedger({
    rawIntervals: [],
    activeIntervals: [],
    contributingIntervals: [],
    candidates: [candidate(
      "R001",
      "outside-zero",
      "point",
      [{ start_ms: 0, end_ms: 2_000 }],
    )],
  }) as LedgerResult & { highConfidenceLowerBoundIntervals?: Interval[] };
  assert.deepEqual(zero.highConfidenceLowerBoundIntervals, []);
  assert.equal(zero.summary.measured_min, 0);
  assert.equal(zero.summary.estimated_floor_min, 0);
});

test("confirmed lower bounds retain fractional milliseconds until final rounding", () => {
  const result = reconcileLedger({
    rawIntervals: [{ start_ms: 0, end_ms: 600 }],
    activeIntervals: [{ start_ms: 0, end_ms: 600 }],
    contributingIntervals: [],
    candidates: [
      candidate(
        "R002",
        "fractional-lower-bound-a",
        "upper",
        [{ start_ms: 0, end_ms: 200 }],
        200,
        {
          impact: {
            lower_ms: 149.8,
            upper_ms: 200,
            kind: "critical_path_latency",
          },
        },
      ),
      candidate(
        "R003",
        "fractional-lower-bound-b",
        "upper",
        [{ start_ms: 300, end_ms: 500 }],
        200,
        {
          impact: {
            lower_ms: 150.3,
            upper_ms: 200,
            kind: "critical_path_latency",
          },
        },
      ),
    ],
  });

  assert.deepEqual(result.highConfidenceLowerBoundIntervals, [
    { start_ms: 0, end_ms: 149.8 },
    { start_ms: 300, end_ms: 450.3 },
  ]);
  assert.equal(result.summary.measured_min, 0.01);
  assert.equal(result.summary.estimated_floor_min, 0);
});
