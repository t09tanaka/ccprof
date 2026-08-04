import {
  durationMs,
  intersectIntervals,
  subtractIntervals,
  unionIntervals,
} from "./intervals.js";
import {
  isStrictHighConfidence,
  projectFindingRecoverable,
} from "./model.js";
import type {
  AnalysisSummary,
  BaselineComparison,
  Bound,
  Finding,
  FindingCandidate,
  Interval,
  RuleId,
} from "./model.js";

const RULE_PRECEDENCE: Readonly<Record<RuleId, number>> = {
  R008: 0,
  R001: 1,
  R002: 2,
  R003: 3,
  R007: 3,
  R004: 4,
  R005: 5,
  R006: 5,
};

const MS_PER_HUNDREDTH_MINUTE = 600;

export interface LedgerInput {
  rawIntervals: readonly Interval[];
  activeIntervals: readonly Interval[];
  contributingIntervals: readonly Interval[];
  /** Sub-threshold human wait; away time must already be excluded. */
  humanWaitIntervals?: readonly Interval[];
  candidates: readonly FindingCandidate[];
  baseline?: BaselineComparison | null;
}

export interface LedgerAttribution {
  finding_key: string;
  rule_id: RuleId;
  bound: Bound;
  intervals: Interval[];
  attributed_ms: number;
  reported_ms: number;
}

export interface LedgerTotalsMs {
  raw_observed: number;
  measured: number;
  idle_excluded: number;
  normal: number;
  recoverable: number;
  human_wait: number;
  unexplained: number;
}

export interface LedgerResult {
  summary: AnalysisSummary;
  findings: Finding[];
  raw_observed_min: number;
  normal_min: number;
  totals_ms: LedgerTotalsMs;
  highConfidenceLowerBoundIntervals: Interval[];
  pointRecoverableIntervals: Interval[];
  humanWaitIntervals: Interval[];
  normalIntervals: Interval[];
  unexplainedIntervals: Interval[];
  idleIntervals: Interval[];
  attributions: LedgerAttribution[];
}

interface IndexedCandidate {
  candidate: FindingCandidate;
  index: number;
}

function takeIntervalDuration(
  intervals: readonly Interval[],
  maximumMs: number,
): Interval[] {
  let remainingMs = Number.isFinite(maximumMs) && maximumMs > 0
    ? maximumMs
    : 0;
  const result: Interval[] = [];
  for (const interval of unionIntervals(intervals)) {
    if (!(remainingMs > 0)) break;
    const duration = interval.end_ms - interval.start_ms;
    const claimed = Math.min(duration, remainingMs);
    if (claimed > 0) {
      result.push({
        start_ms: interval.start_ms,
        end_ms: interval.start_ms + claimed,
      });
      remainingMs -= claimed;
    }
  }
  return result;
}

function unionLowerBoundIntervals(
  intervals: readonly Interval[],
): Interval[] {
  const sorted = [...intervals].sort(
    (left, right) =>
      left.start_ms - right.start_ms || left.end_ms - right.end_ms,
  );
  const result: Interval[] = [];
  for (const interval of sorted) {
    if (
      !Number.isFinite(interval.start_ms) ||
      !Number.isFinite(interval.end_ms) ||
      interval.start_ms >= interval.end_ms
    ) continue;
    const previous = result.at(-1);
    if (previous !== undefined && interval.start_ms <= previous.end_ms) {
      previous.end_ms = Math.max(previous.end_ms, interval.end_ms);
    } else {
      result.push({ ...interval });
    }
  }
  return result;
}

function confirmedLowerBoundIntervals(
  candidates: readonly FindingCandidate[],
  activeIntervals: readonly Interval[],
): Interval[] {
  return unionLowerBoundIntervals(candidates.flatMap((candidate) => {
    if (
      candidate.impact.kind !== "critical_path_latency" ||
      !(candidate.impact.lower_ms > 0) ||
      !isStrictHighConfidence(candidate.finding_confidence)
    ) {
      return [];
    }
    return takeIntervalDuration(
      intersectIntervals(candidate.recoverable.intervals, activeIntervals),
      candidate.impact.lower_ms,
    );
  }));
}

type PartitionName = "recoverable" | "human_wait" | "normal" | "unexplained";

function roundedHundredths(ms: number): number {
  return ms > 0 ? Math.round(ms / MS_PER_HUNDREDTH_MINUTE) : 0;
}

function minutesFromHundredths(value: number): number {
  return Math.max(0, value) / 100;
}

function apportionedMeasuredHundredths(
  measuredMs: number,
  partsMs: Readonly<Record<PartitionName, number>>,
): Record<PartitionName, number> {
  const names: readonly PartitionName[] = [
    "recoverable",
    "human_wait",
    "normal",
    "unexplained",
  ];
  const units: Record<PartitionName, number> = {
    recoverable: 0,
    human_wait: 0,
    normal: 0,
    unexplained: 0,
  };
  for (const name of names) {
    units[name] = Math.floor(
      Math.max(0, partsMs[name]) / MS_PER_HUNDREDTH_MINUTE,
    );
  }

  let remaining =
    roundedHundredths(measuredMs) -
    names.reduce((total, name) => total + units[name], 0);
  const byLargestRemainder = [...names].sort(
    (left, right) =>
      (partsMs[right] / MS_PER_HUNDREDTH_MINUTE) % 1 -
        (partsMs[left] / MS_PER_HUNDREDTH_MINUTE) % 1 ||
      names.indexOf(left) - names.indexOf(right),
  );
  for (let index = 0; remaining > 0; index += 1) {
    const name = byLargestRemainder[index % byLargestRemainder.length];
    if (name === undefined) break;
    units[name] += 1;
    remaining -= 1;
  }
  for (let index = byLargestRemainder.length - 1; remaining < 0; index -= 1) {
    const name =
      byLargestRemainder[
        (index + byLargestRemainder.length) % byLargestRemainder.length
      ];
    if (name === undefined) break;
    if (units[name] > 0) {
      units[name] -= 1;
      remaining += 1;
    }
  }
  return units;
}

function intervalSignature(candidate: FindingCandidate): string {
  return candidate.recoverable.intervals
    .map((interval) =>
      `${interval.start_ms}:${interval.end_ms}:${interval.interval_id}`
    )
    .sort()
    .join("\0");
}

function candidateOrder(
  left: IndexedCandidate,
  right: IndexedCandidate,
): number {
  return (
    RULE_PRECEDENCE[left.candidate.rule_id] -
      RULE_PRECEDENCE[right.candidate.rule_id] ||
    left.candidate.rule_id.localeCompare(right.candidate.rule_id) ||
    left.candidate.finding_key.localeCompare(right.candidate.finding_key) ||
    left.candidate.target.localeCompare(right.candidate.target) ||
    intervalSignature(left.candidate).localeCompare(
      intervalSignature(right.candidate),
    ) ||
    left.index - right.index
  );
}

function upperEstimateMs(candidate: FindingCandidate): number {
  const estimate = candidate.recoverable.estimated_ms;
  return Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
}

function publicFinding(candidate: FindingCandidate): Finding {
  const { recoverable, ...metadata } = candidate;
  return {
    ...metadata,
    recoverable: projectFindingRecoverable(candidate.impact),
  };
}

export function reconcileLedger(input: LedgerInput): LedgerResult {
  const rawIntervals = unionIntervals(input.rawIntervals);
  const activeIntervals = intersectIntervals(
    input.activeIntervals,
    rawIntervals,
  );
  const highConfidenceLowerBoundIntervals = confirmedLowerBoundIntervals(
    input.candidates,
    activeIntervals,
  );
  const indexed = input.candidates.map((candidate, index) => ({
    candidate,
    index,
  }));
  const attributionsByIndex = new Map<number, LedgerAttribution>();
  let pointRecoverableIntervals: Interval[] = [];

  for (const { candidate, index } of [...indexed].sort(candidateOrder)) {
    if (candidate.recoverable.bound === "upper") {
      attributionsByIndex.set(index, {
        finding_key: candidate.finding_key,
        rule_id: candidate.rule_id,
        bound: "upper",
        intervals: [],
        attributed_ms: 0,
        reported_ms: upperEstimateMs(candidate),
      });
      continue;
    }
    const eligible = intersectIntervals(
      candidate.recoverable.intervals,
      activeIntervals,
    );
    const intervals = subtractIntervals(
      eligible,
      pointRecoverableIntervals,
    );
    pointRecoverableIntervals = unionIntervals([
      ...pointRecoverableIntervals,
      ...intervals,
    ]);
    const attributedMs = durationMs(intervals);
    attributionsByIndex.set(index, {
      finding_key: candidate.finding_key,
      rule_id: candidate.rule_id,
      bound: "point",
      intervals,
      attributed_ms: attributedMs,
      reported_ms: attributedMs,
    });
  }

  const contributingIntervals = intersectIntervals(
    input.contributingIntervals,
    activeIntervals,
  );
  const humanWaitIntervals = subtractIntervals(
    intersectIntervals(input.humanWaitIntervals ?? [], activeIntervals),
    pointRecoverableIntervals,
  );
  const normalIntervals = subtractIntervals(contributingIntervals, [
    ...pointRecoverableIntervals,
    ...humanWaitIntervals,
  ]);
  const unexplainedIntervals = subtractIntervals(activeIntervals, [
    ...pointRecoverableIntervals,
    ...humanWaitIntervals,
    ...normalIntervals,
  ]);
  const idleIntervals = subtractIntervals(rawIntervals, activeIntervals);

  const totalsMs: LedgerTotalsMs = {
    raw_observed: durationMs(rawIntervals),
    measured: durationMs(activeIntervals),
    idle_excluded: durationMs(idleIntervals),
    normal: durationMs(normalIntervals),
    recoverable: durationMs(pointRecoverableIntervals),
    human_wait: durationMs(humanWaitIntervals),
    unexplained: durationMs(unexplainedIntervals),
  };
  const measuredHundredths = roundedHundredths(totalsMs.measured);
  const partitionHundredths = apportionedMeasuredHundredths(
    totalsMs.measured,
    {
      recoverable: totalsMs.recoverable,
      human_wait: totalsMs.human_wait,
      normal: totalsMs.normal,
      unexplained: totalsMs.unexplained,
    },
  );
  const rawObservedHundredths = roundedHundredths(
    totalsMs.raw_observed,
  );
  const idleHundredths = Math.max(
    0,
    rawObservedHundredths - measuredHundredths,
  );
  const recoverableHundredths = partitionHundredths.recoverable;
  const confirmedHundredths = Math.min(
    measuredHundredths,
    roundedHundredths(highConfidenceLowerBoundIntervals.reduce(
      (total, interval) => total + interval.end_ms - interval.start_ms,
      0,
    )),
  );

  const attributions = indexed.map(({ candidate, index }) =>
    attributionsByIndex.get(index) ?? {
      finding_key: candidate.finding_key,
      rule_id: candidate.rule_id,
      bound: candidate.recoverable.bound,
      intervals: [],
      attributed_ms: 0,
      reported_ms: 0,
    }
  );

  return {
    summary: {
      measured_min: minutesFromHundredths(measuredHundredths),
      idle_excluded_min: minutesFromHundredths(idleHundredths),
      estimated_floor_min: minutesFromHundredths(
        measuredHundredths - confirmedHundredths,
      ),
      recoverable_min: minutesFromHundredths(recoverableHundredths),
      human_wait_min: minutesFromHundredths(
        partitionHundredths.human_wait,
      ),
      unexplained_min: minutesFromHundredths(
        partitionHundredths.unexplained,
      ),
      baseline: input.baseline ?? null,
    },
    findings: indexed.map(({ candidate }) => publicFinding(candidate)),
    raw_observed_min: minutesFromHundredths(rawObservedHundredths),
    normal_min: minutesFromHundredths(partitionHundredths.normal),
    totals_ms: totalsMs,
    highConfidenceLowerBoundIntervals,
    pointRecoverableIntervals,
    humanWaitIntervals,
    normalIntervals,
    unexplainedIntervals,
    idleIntervals,
    attributions,
  };
}
