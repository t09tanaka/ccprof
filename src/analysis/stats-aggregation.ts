import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { LedgerResult } from "../core/ledger.js";
import {
  isStrictHighConfidence,
  snapshotFindingConfidence,
  snapshotImpactEstimate,
} from "../core/model.js";
import type {
  FindingCandidate,
  FindingConfidence,
  ImpactEstimate,
  Interval,
  RuleId,
} from "../core/model.js";
import {
  ruleManifest as builtInRuleManifest,
  type RuleManifest,
} from "../rules/manifest.js";

const RULE_IDS = [
  "R001", "R002", "R003", "R004", "R005", "R006", "R007", "R008",
] as const satisfies readonly RuleId[];

const SNAPSHOT_FIELDS = [
  "schema_version",
  "measured_wall_ms",
  "confirmed_critical_path_ms",
  "estimated_critical_path_upper_ms",
  "resource_cost_ms",
  "human_wait_ms",
  "unexplained_ms",
  "cohort",
  "rules",
  "incomplete_interval_findings",
] as const;

const COHORT_REQUIRED_FIELDS = [
  "repository_id", "workspace_id", "changed_files",
] as const;

const RULE_ROW_FIELDS = [
  "rule_id",
  "rule_version",
  "compatibility_epoch",
  "confirmed_critical_path_ms",
  "estimated_critical_path_upper_ms",
  "resource_cost_ms",
] as const;

const OPAQUE_ID = /^[0-9a-f]{64}$/u;
const DEFAULT_TERMINAL_MINIMUM_COHORT_SIZE = 5;
const MAXIMUM_TERMINAL_COHORT_SIZE = 1_000;

export type OpaqueDigest = string;

export type ChangedFilesBucket =
  | "files_0"
  | "files_1"
  | "files_2_4"
  | "files_5_9"
  | "files_10_19"
  | "files_20_49"
  | "files_50_plus";

export type ChangedLinesBucket =
  | "lines_0"
  | "lines_1_9"
  | "lines_10_49"
  | "lines_50_199"
  | "lines_200_999"
  | "lines_1000_plus";

export type BoundedBaselineMetric = "human_wait_ratio";

export type StatsInputReason =
  | "content_fallback"
  | "invalid_repository_identity"
  | "missing_changed_lines"
  | "missing_selector"
  | "missing_terminal_metrics";

export interface StatsAggregationInput {
  schema_version: 1;
  snapshot_id: OpaqueDigest;
  created_at_ms: number;
  work_unit_key?: OpaqueDigest;
  git_state_key?: OpaqueDigest;
  repository_key?: OpaqueDigest;
  workspace_key?: OpaqueDigest;
  changed_files_bucket?: ChangedFilesBucket;
  changed_lines_bucket?: ChangedLinesBucket;
  cohort_key?: OpaqueDigest;
  terminal_metrics?: {
    measured_wall_ms: number;
    confirmed_critical_path_ms: number;
    estimated_critical_path_upper_ms: number;
    resource_cost_ms: number;
    human_wait_ms: number;
    unexplained_ms: number;
    rules: readonly TerminalStatsRuleV1[];
  };
  baseline_metrics: readonly {
    metric: BoundedBaselineMetric;
    value: number;
  }[];
  command_costs: readonly {
    command_key: OpaqueDigest;
    cache_state: "cold" | "warm";
    duration_ms: number;
  }[];
  reason_codes: readonly StatsInputReason[];
}

export interface CohortDistribution {
  median: number;
  p50: number;
  p75: number;
  mad: number;
  sample_count: number;
}

export type CohortEvaluationMode =
  | {
      mode: "analysis_current";
      current_work_unit_key: OpaqueDigest;
      current_cohort_key: OpaqueDigest;
    }
  | { mode: "stats_all_groups" };

export interface TerminalSelectionResult {
  terminals: StatsAggregationInput[];
  eligible_terminals: StatsAggregationInput[];
  metadata: {
    stored_snapshot_count: number;
    terminal_snapshot_count: number;
    superseded_snapshot_count: number;
    ineligible_snapshot_count: number;
  };
}

export type TerminalMetricAxis =
  | "confirmed_critical_path_ms"
  | "estimated_critical_path_upper_ms"
  | "resource_cost_ms"
  | "human_wait_ms"
  | "unexplained_ms";

export interface TerminalMetricAggregate {
  confirmed_critical_path_ms: number;
  estimated_critical_path_upper_ms: number;
  resource_cost_ms: number;
  human_wait_ms: number;
  unexplained_ms: number;
}

export interface TerminalAggregatePopulationMetadata {
  sample_count: number;
  minimum_cohort_size: number;
  status: "available" | "suppressed";
  reason_codes: Array<"below_minimum">;
}

export interface TerminalStatsAggregateMetadata
  extends TerminalAggregatePopulationMetadata {
  stored_snapshot_count: number;
  distinct_work_unit_count: number;
  terminal_snapshot_count: number;
  superseded_snapshot_count: number;
  ineligible_snapshot_count: number;
}

export interface TerminalStatsCohortAggregate {
  cohort_key: OpaqueDigest;
  metadata: TerminalAggregatePopulationMetadata;
  distributions?: Record<TerminalMetricAxis, CohortDistribution>;
}

export interface TerminalStatsAggregateResult {
  selected_snapshot_ids: OpaqueDigest[];
  metadata: TerminalStatsAggregateMetadata;
  terminal_metrics?: TerminalMetricAggregate;
  rule_minutes: Array<{ rule_id: RuleId; minutes: number }>;
  cohorts: TerminalStatsCohortAggregate[];
}

export const TERMINAL_STATS_COLLECTION_LIMIT = 10_000;

export interface TerminalStatsRuleV1 {
  rule_id: RuleId;
  rule_version: string;
  compatibility_epoch: number;
  confirmed_critical_path_ms: number;
  estimated_critical_path_upper_ms: number;
  resource_cost_ms: number;
}

export interface TerminalStatsSnapshotV1 {
  schema_version: 1;
  measured_wall_ms: number;
  confirmed_critical_path_ms: number;
  estimated_critical_path_upper_ms: number;
  resource_cost_ms: number;
  human_wait_ms: number;
  unexplained_ms: number;
  cohort: {
    repository_id: string;
    workspace_id: string;
    changed_files: number;
    changed_lines?: number;
  };
  rules: TerminalStatsRuleV1[];
  incomplete_interval_findings: number;
}

export type TerminalStatsFindingCandidate = FindingCandidate & {
  rule_version?: string;
  compatibility_epoch?: number;
};

export interface TerminalStatsSnapshotInput {
  repositoryId: string;
  workspaceId: string;
  changedFiles: number;
  changedLines?: number;
  ledger: LedgerResult;
  candidates: readonly TerminalStatsFindingCandidate[];
}

export interface TerminalStatsAggregationOptions {
  ruleManifest?: (id: RuleId) => RuleManifest;
}

interface MetricInterval {
  start_ms: number;
  end_ms: number;
}

interface CandidateView {
  key: string;
  manifest: RuleManifest;
  impact: ImpactEstimate;
  confidence: FindingConfidence;
  intervalSignature: string;
  lowerPlacement: MetricInterval[];
  upperPlacement: MetricInterval[];
}

interface RuleAggregate {
  manifest: RuleManifest;
  confirmed: MetricInterval[];
  upper: MetricInterval[];
  resource: number;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMetricInterval(value: MetricInterval): boolean {
  return Number.isFinite(value.start_ms) && Number.isFinite(value.end_ms) &&
    value.start_ms >= 0 && value.start_ms < value.end_ms &&
    !Object.is(value.start_ms, -0) && !Object.is(value.end_ms, -0);
}

function unionMetricIntervals(
  intervals: readonly MetricInterval[],
): MetricInterval[] {
  const sorted = intervals
    .filter(isMetricInterval)
    .map((interval) => ({ ...interval }))
    .sort((left, right) =>
      left.start_ms - right.start_ms || left.end_ms - right.end_ms);
  const result: MetricInterval[] = [];
  for (const interval of sorted) {
    const previous = result[result.length - 1];
    if (previous === undefined || interval.start_ms > previous.end_ms) {
      result.push(interval);
    } else {
      previous.end_ms = Math.max(previous.end_ms, interval.end_ms);
    }
  }
  return result;
}

function intersectMetricIntervals(
  leftIntervals: readonly MetricInterval[],
  rightIntervals: readonly MetricInterval[],
): MetricInterval[] {
  const left = unionMetricIntervals(leftIntervals);
  const right = unionMetricIntervals(rightIntervals);
  const result: MetricInterval[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftInterval = left[leftIndex]!;
    const rightInterval = right[rightIndex]!;
    const start_ms = Math.max(leftInterval.start_ms, rightInterval.start_ms);
    const end_ms = Math.min(leftInterval.end_ms, rightInterval.end_ms);
    if (start_ms < end_ms) result.push({ start_ms, end_ms });
    if (leftInterval.end_ms <= rightInterval.end_ms) leftIndex += 1;
    if (rightInterval.end_ms <= leftInterval.end_ms) rightIndex += 1;
  }
  return result;
}

function subtractMetricIntervals(
  intervals: readonly MetricInterval[],
  subtractions: readonly MetricInterval[],
): MetricInterval[] {
  const base = unionMetricIntervals(intervals);
  const cuts = unionMetricIntervals(subtractions);
  const result: MetricInterval[] = [];
  for (const interval of base) {
    let cursor = interval.start_ms;
    for (const cut of cuts) {
      if (cut.end_ms <= cursor) continue;
      if (cut.start_ms >= interval.end_ms) break;
      if (cut.start_ms > cursor) {
        result.push({
          start_ms: cursor,
          end_ms: Math.min(cut.start_ms, interval.end_ms),
        });
      }
      cursor = Math.max(cursor, cut.end_ms);
      if (cursor >= interval.end_ms) break;
    }
    if (cursor < interval.end_ms) {
      result.push({ start_ms: cursor, end_ms: interval.end_ms });
    }
  }
  return result;
}

function metricDuration(intervals: readonly MetricInterval[]): number {
  return unionMetricIntervals(intervals).reduce(
    (total, interval) => total + interval.end_ms - interval.start_ms,
    0,
  );
}

function takeMetricDuration(
  intervals: readonly MetricInterval[],
  maximumMs: number,
): MetricInterval[] {
  let remaining = Number.isFinite(maximumMs) && maximumMs > 0
    ? maximumMs
    : 0;
  const result: MetricInterval[] = [];
  for (const interval of unionMetricIntervals(intervals)) {
    if (!(remaining > 0)) break;
    const length = interval.end_ms - interval.start_ms;
    const taken = Math.min(length, remaining);
    if (taken > 0) {
      result.push({
        start_ms: interval.start_ms,
        end_ms: interval.start_ms + taken,
      });
      remaining -= taken;
    }
  }
  return result;
}

function intervalSignature(intervals: readonly MetricInterval[]): string {
  return JSON.stringify(unionMetricIntervals(intervals).map(
    ({ start_ms, end_ms }) => [start_ms, end_ms],
  ));
}

function plainDataDescriptors(value: unknown): PropertyDescriptorMap | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) return null;
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function dataValue(
  descriptors: PropertyDescriptorMap,
  key: string,
): unknown {
  const descriptor = descriptors[key];
  return descriptor !== undefined && descriptor.enumerable === true &&
      "value" in descriptor
    ? descriptor.value
    : undefined;
}

function snapshotArray(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) return null;
    const lengthDescriptor: PropertyDescriptor | undefined =
      Object.getOwnPropertyDescriptor(value, "length");
    const lengthValue: unknown = lengthDescriptor !== undefined &&
        "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (
      typeof lengthValue !== "number" ||
      !Number.isSafeInteger(lengthValue) ||
      lengthValue < 0 ||
      lengthValue > TERMINAL_STATS_COLLECTION_LIMIT
    ) return null;
    const length = lengthValue;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1 ||
      ownKeys.length > TERMINAL_STATS_COLLECTION_LIMIT + 1 ||
      ownKeys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string") return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length ||
          String(index) !== key;
      })
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function inputIntervals(value: unknown): MetricInterval[] | null {
  const values = snapshotArray(value);
  if (values === null || values.length === 0) return null;
  const intervals: MetricInterval[] = [];
  for (const entry of values) {
    const descriptors = plainDataDescriptors(entry);
    if (descriptors === null) return null;
    const start = dataValue(descriptors, "start_ms");
    const end = dataValue(descriptors, "end_ms");
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= end ||
      Object.is(start, -0) ||
      Object.is(end, -0)
    ) return null;
    intervals.push({ start_ms: start, end_ms: end });
  }
  return unionMetricIntervals(intervals);
}

function ledgerIntervals(values: readonly Interval[]): MetricInterval[] {
  return unionMetricIntervals(values.filter((interval) =>
    Number.isSafeInteger(interval.start_ms) &&
    Number.isSafeInteger(interval.end_ms) &&
    interval.start_ms >= 0 && interval.start_ms < interval.end_ms
  ));
}

function measuredIntervals(ledger: LedgerResult): MetricInterval[] {
  return unionMetricIntervals([
    ...ledgerIntervals(ledger.pointRecoverableIntervals),
    ...ledgerIntervals(ledger.humanWaitIntervals),
    ...ledgerIntervals(ledger.normalIntervals),
    ...ledgerIntervals(ledger.unexplainedIntervals),
  ]);
}

function candidateView(
  descriptors: PropertyDescriptorMap,
  manifest: RuleManifest,
  measured: readonly MetricInterval[],
): CandidateView | null {
  const key = dataValue(descriptors, "finding_key");
  const version = dataValue(descriptors, "rule_version");
  const epoch = dataValue(descriptors, "compatibility_epoch");
  if (
    typeof key !== "string" ||
    key === "" ||
    key.normalize("NFC") !== key ||
    version !== manifest.version ||
    epoch !== manifest.compatibility_epoch
  ) return null;
  let impact: ImpactEstimate;
  let confidence: FindingConfidence;
  try {
    impact = snapshotImpactEstimate(dataValue(descriptors, "impact"));
    confidence = snapshotFindingConfidence(
      dataValue(descriptors, "finding_confidence"),
    );
  } catch {
    return null;
  }
  if (impact.kind !== manifest.impact_kind) return null;
  if (manifest.impact_kind === "resource_cost") {
    return {
      key,
      manifest,
      impact,
      confidence,
      intervalSignature: "[]",
      lowerPlacement: [],
      upperPlacement: [],
    };
  }
  if (manifest.impact_kind !== "critical_path_latency") return null;
  const recoverable = plainDataDescriptors(
    dataValue(descriptors, "recoverable"),
  );
  if (recoverable === null) return null;
  const sourceIntervals = inputIntervals(dataValue(recoverable, "intervals"));
  if (sourceIntervals === null) return null;
  const clipped = intersectMetricIntervals(sourceIntervals, measured);
  if (clipped.length === 0) return null;
  return {
    key,
    manifest,
    impact,
    confidence,
    intervalSignature: intervalSignature(clipped),
    lowerPlacement: takeMetricDuration(clipped, impact.lower_ms),
    upperPlacement: takeMetricDuration(clipped, impact.upper_ms),
  };
}

function winner(
  candidates: readonly CandidateView[],
  placement: (candidate: CandidateView) => readonly MetricInterval[],
  bound: (candidate: CandidateView) => number,
): CandidateView | undefined {
  return [...candidates]
    .filter((candidate) => metricDuration(placement(candidate)) > 0)
    .sort((left, right) => {
      const score = metricDuration(placement(right)) -
        metricDuration(placement(left));
      if (score !== 0) return score;
      const boundOrder = bound(right) - bound(left);
      if (boundOrder !== 0) return boundOrder;
      return compareStrings(left.key, right.key) ||
        compareStrings(left.intervalSignature, right.intervalSignature);
    })[0];
}

function aggregateRule(
  manifest: RuleManifest,
  candidates: readonly CandidateView[],
): RuleAggregate {
  if (manifest.aggregation_policy === "never_aggregate") {
    return { manifest, confirmed: [], upper: [], resource: 0 };
  }
  if (manifest.impact_kind === "resource_cost") {
    const values = candidates.map((candidate) => candidate.impact.upper_ms);
    const resource = manifest.aggregation_policy === "max"
      ? Math.max(0, ...values)
      : manifest.aggregation_policy === "sum"
        ? [...values].sort((left, right) => left - right)
          .reduce((total, value) => total + value, 0)
        : 0;
    return { manifest, confirmed: [], upper: [], resource };
  }
  if (manifest.impact_kind !== "critical_path_latency") {
    return { manifest, confirmed: [], upper: [], resource: 0 };
  }
  const strict = candidates.filter((candidate) =>
    isStrictHighConfidence(candidate.confidence));
  if (manifest.aggregation_policy === "max") {
    const confirmedWinner = winner(
      strict,
      (candidate) => candidate.lowerPlacement,
      (candidate) => candidate.impact.lower_ms,
    );
    const upperWinner = winner(
      candidates,
      (candidate) => candidate.upperPlacement,
      (candidate) => candidate.impact.upper_ms,
    );
    const confirmed = confirmedWinner?.lowerPlacement ?? [];
    const upperScore = upperWinner === undefined
      ? 0
      : metricDuration(upperWinner.upperPlacement);
    const target = Math.max(metricDuration(confirmed), upperScore);
    const uncovered = upperWinner === undefined
      ? []
      : subtractMetricIntervals(upperWinner.upperPlacement, confirmed);
    const residual = takeMetricDuration(
      uncovered,
      target - metricDuration(confirmed),
    );
    return {
      manifest,
      confirmed: unionMetricIntervals(confirmed),
      upper: unionMetricIntervals([...confirmed, ...residual]),
      resource: 0,
    };
  }
  const confirmed = unionMetricIntervals(
    strict.flatMap((candidate) => candidate.lowerPlacement),
  );
  const upper = unionMetricIntervals([
    ...confirmed,
    ...candidates.flatMap((candidate) => candidate.upperPlacement),
  ]);
  return { manifest, confirmed, upper, resource: 0 };
}

function exactDataValues(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Map<string, unknown> {
  const descriptors = plainDataDescriptors(value);
  if (descriptors === null) throw new TypeError("invalid terminal stats snapshot");
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.length < required.length ||
    keys.length > allowed.size ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) throw new TypeError("invalid terminal stats snapshot");
  const result = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new TypeError("invalid terminal stats snapshot");
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) throw new TypeError("invalid terminal stats snapshot");
    result.set(key, descriptor.value);
  }
  return result;
}

function metricValue(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) throw new TypeError("invalid terminal stats snapshot");
  return value;
}

function countValue(value: unknown): number {
  const result = metricValue(value);
  if (!Number.isSafeInteger(result)) {
    throw new TypeError("invalid terminal stats snapshot");
  }
  return result;
}

function opaqueId(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new TypeError("invalid terminal stats snapshot");
  }
  return value;
}

function normalizeRuleRows(value: unknown): TerminalStatsRuleV1[] {
  const values = snapshotArray(value);
  if (values === null) throw new TypeError("invalid terminal stats snapshot");
  const rows: TerminalStatsRuleV1[] = [];
  let previous = "";
  for (const valueEntry of values) {
    const entry = exactDataValues(valueEntry, RULE_ROW_FIELDS);
    const ruleId = entry.get("rule_id");
    if (typeof ruleId !== "string" || !RULE_IDS.includes(ruleId as RuleId)) {
      throw new TypeError("invalid terminal stats snapshot");
    }
    if (previous !== "" && compareStrings(previous, ruleId) >= 0) {
      throw new TypeError("invalid terminal stats snapshot");
    }
    previous = ruleId;
    const manifest = builtInRuleManifest(ruleId);
    if (
      entry.get("rule_version") !== manifest.version ||
      entry.get("compatibility_epoch") !== manifest.compatibility_epoch
    ) throw new TypeError("invalid terminal stats snapshot");
    const confirmed = metricValue(entry.get("confirmed_critical_path_ms"));
    const upper = metricValue(entry.get("estimated_critical_path_upper_ms"));
    const resource = metricValue(entry.get("resource_cost_ms"));
    if (confirmed > upper) throw new TypeError("invalid terminal stats snapshot");
    const hasCritical = confirmed !== 0 || upper !== 0;
    const hasResource = resource !== 0;
    if (
      (manifest.aggregation_policy === "never_aggregate" &&
        (hasCritical || hasResource)) ||
      (manifest.impact_kind === "critical_path_latency" && hasResource) ||
      (manifest.impact_kind === "resource_cost" && hasCritical) ||
      ((manifest.impact_kind === "policy_latency" ||
        manifest.impact_kind === "evidence_only") &&
        (hasCritical || hasResource))
    ) throw new TypeError("invalid terminal stats snapshot");
    rows.push({
      rule_id: ruleId as RuleId,
      rule_version: manifest.version,
      compatibility_epoch: manifest.compatibility_epoch,
      confirmed_critical_path_ms: confirmed,
      estimated_critical_path_upper_ms: upper,
      resource_cost_ms: resource,
    });
  }
  return rows;
}

export function normalizeTerminalStatsSnapshot(
  value: unknown,
): TerminalStatsSnapshotV1 {
  const entries = exactDataValues(value, SNAPSHOT_FIELDS);
  if (entries.get("schema_version") !== 1) {
    throw new TypeError("invalid terminal stats snapshot");
  }
  const measured = metricValue(entries.get("measured_wall_ms"));
  const confirmed = metricValue(entries.get("confirmed_critical_path_ms"));
  const upper = metricValue(
    entries.get("estimated_critical_path_upper_ms"),
  );
  const resource = metricValue(entries.get("resource_cost_ms"));
  const wait = metricValue(entries.get("human_wait_ms"));
  const unexplained = metricValue(entries.get("unexplained_ms"));
  const incomplete = countValue(entries.get("incomplete_interval_findings"));
  if (confirmed > upper || upper + wait + unexplained > measured) {
    throw new TypeError("invalid terminal stats snapshot");
  }

  const cohortEntries = exactDataValues(
    entries.get("cohort"),
    COHORT_REQUIRED_FIELDS,
    ["changed_lines"],
  );
  const repositoryId = opaqueId(cohortEntries.get("repository_id"));
  const workspaceId = opaqueId(cohortEntries.get("workspace_id"));
  const changedFiles = countValue(cohortEntries.get("changed_files"));
  const changedLines = cohortEntries.has("changed_lines")
    ? countValue(cohortEntries.get("changed_lines"))
    : undefined;
  const rules = normalizeRuleRows(entries.get("rules"));
  const confirmedSum = rules.reduce(
    (total, row) => total + row.confirmed_critical_path_ms,
    0,
  );
  const upperSum = rules.reduce(
    (total, row) => total + row.estimated_critical_path_upper_ms,
    0,
  );
  const resourceSum = rules.reduce(
    (total, row) => total + row.resource_cost_ms,
    0,
  );
  if (
    !Number.isFinite(confirmedSum) ||
    !Number.isFinite(upperSum) ||
    !Number.isFinite(resourceSum) ||
    confirmedSum !== confirmed ||
    upperSum !== upper ||
    resourceSum !== resource
  ) throw new TypeError("invalid terminal stats snapshot");

  return {
    schema_version: 1,
    measured_wall_ms: measured,
    confirmed_critical_path_ms: confirmed,
    estimated_critical_path_upper_ms: upper,
    resource_cost_ms: resource,
    human_wait_ms: wait,
    unexplained_ms: unexplained,
    cohort: {
      repository_id: repositoryId,
      workspace_id: workspaceId,
      changed_files: changedFiles,
      ...(changedLines === undefined ? {} : { changed_lines: changedLines }),
    },
    rules,
    incomplete_interval_findings: incomplete,
  };
}

function manifestCatalog(
  resolver: (id: RuleId) => RuleManifest,
): RuleManifest[] {
  return RULE_IDS.map((id) => {
    const manifest = resolver(id);
    if (
      manifest.id !== id ||
      (manifest.aggregation_policy !== "sum" &&
        manifest.aggregation_policy !== "union" &&
        manifest.aggregation_policy !== "max" &&
        manifest.aggregation_policy !== "never_aggregate")
    ) throw new TypeError("invalid terminal stats manifest");
    return manifest;
  });
}

export function buildTerminalStatsSnapshot(
  input: TerminalStatsSnapshotInput,
  options: TerminalStatsAggregationOptions = {},
): TerminalStatsSnapshotV1 {
  const manifests = manifestCatalog(options.ruleManifest ?? builtInRuleManifest);
  const byRule = new Map<RuleId, CandidateView[]>();
  const measured = measuredIntervals(input.ledger);
  let incomplete = 0;
  const candidateValues = snapshotArray(input.candidates);
  if (candidateValues === null) {
    throw new TypeError("invalid terminal stats candidates");
  }
  for (const candidate of candidateValues) {
    const descriptors = plainDataDescriptors(candidate);
    if (descriptors === null) continue;
    const ruleId = dataValue(descriptors, "rule_id");
    if (typeof ruleId !== "string" || !RULE_IDS.includes(ruleId as RuleId)) {
      continue;
    }
    const manifest = manifests.find((entry) => entry.id === ruleId)!;
    if (manifest.aggregation_policy === "never_aggregate") continue;
    const view = candidateView(descriptors, manifest, measured);
    if (view === null) {
      if (
        manifest.impact_kind === "critical_path_latency" &&
        incomplete < Number.MAX_SAFE_INTEGER
      ) incomplete += 1;
      continue;
    }
    const group = byRule.get(view.manifest.id);
    if (group === undefined) byRule.set(view.manifest.id, [view]);
    else group.push(view);
  }

  const aggregates = manifests.map((manifest) =>
    aggregateRule(manifest, byRule.get(manifest.id) ?? []));
  const confirmedByRule = new Map<RuleId, MetricInterval[]>();
  let confirmedClaimed: MetricInterval[] = [];
  for (const aggregate of aggregates) {
    const owned = subtractMetricIntervals(
      aggregate.confirmed,
      confirmedClaimed,
    );
    confirmedByRule.set(aggregate.manifest.id, owned);
    confirmedClaimed = unionMetricIntervals([...confirmedClaimed, ...owned]);
  }

  const upperByRule = new Map<RuleId, MetricInterval[]>();
  let upperClaimed = unionMetricIntervals(confirmedClaimed);
  for (const aggregate of aggregates) {
    const confirmedOwned = confirmedByRule.get(aggregate.manifest.id) ?? [];
    const residual = subtractMetricIntervals(aggregate.upper, upperClaimed);
    upperByRule.set(
      aggregate.manifest.id,
      unionMetricIntervals([...confirmedOwned, ...residual]),
    );
    upperClaimed = unionMetricIntervals([...upperClaimed, ...residual]);
  }

  const rows = aggregates.map((aggregate): TerminalStatsRuleV1 => ({
    rule_id: aggregate.manifest.id,
    rule_version: aggregate.manifest.version,
    compatibility_epoch: aggregate.manifest.compatibility_epoch,
    confirmed_critical_path_ms: metricDuration(
      confirmedByRule.get(aggregate.manifest.id) ?? [],
    ),
    estimated_critical_path_upper_ms: metricDuration(
      upperByRule.get(aggregate.manifest.id) ?? [],
    ),
    resource_cost_ms: aggregate.resource,
  }));
  const confirmed = metricDuration(confirmedClaimed);
  const upper = metricDuration(upperClaimed);
  const possible = subtractMetricIntervals(upperClaimed, confirmedClaimed);
  const wait = subtractMetricIntervals(
    intersectMetricIntervals(
      ledgerIntervals(input.ledger.observedHumanWaitIntervals),
      measured,
    ),
    [...confirmedClaimed, ...possible],
  );
  const unexplained = subtractMetricIntervals(
    intersectMetricIntervals(
      ledgerIntervals(input.ledger.unexplainedIntervals),
      measured,
    ),
    [...confirmedClaimed, ...possible, ...wait],
  );

  return normalizeTerminalStatsSnapshot({
    schema_version: 1,
    measured_wall_ms: metricDuration(measured),
    confirmed_critical_path_ms: confirmed,
    estimated_critical_path_upper_ms: upper,
    resource_cost_ms: rows.reduce(
      (total, row) => total + row.resource_cost_ms,
      0,
    ),
    human_wait_ms: metricDuration(wait),
    unexplained_ms: metricDuration(unexplained),
    cohort: {
      repository_id: input.repositoryId,
      workspace_id: input.workspaceId,
      changed_files: input.changedFiles,
      ...(input.changedLines === undefined
        ? {}
        : { changed_lines: input.changedLines }),
    },
    rules: rows,
    incomplete_interval_findings: incomplete,
  });
}

export function statsOpaqueDigest(
  domain: string,
  value: unknown,
): OpaqueDigest {
  if (domain === "" || domain.includes("\0")) {
    throw new TypeError("stats digest domain must be non-empty");
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("invalid stats digest input");
  return createHash("sha256")
    .update(`ccprof\0${domain}\0`)
    .update(encoded)
    .digest("hex");
}

function boundedCount(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) throw new TypeError("cohort size must be a nonnegative safe integer");
  return value;
}

export function changedFilesBucket(value: number): ChangedFilesBucket {
  const count = boundedCount(value);
  if (count === 0) return "files_0";
  if (count === 1) return "files_1";
  if (count <= 4) return "files_2_4";
  if (count <= 9) return "files_5_9";
  if (count <= 19) return "files_10_19";
  if (count <= 49) return "files_20_49";
  return "files_50_plus";
}

export function changedLinesBucket(value: number): ChangedLinesBucket {
  const count = boundedCount(value);
  if (count === 0) return "lines_0";
  if (count <= 9) return "lines_1_9";
  if (count <= 49) return "lines_10_49";
  if (count <= 199) return "lines_50_199";
  if (count <= 999) return "lines_200_999";
  return "lines_1000_plus";
}

export function exactCohortKey(input: {
  repository_key: OpaqueDigest;
  workspace_key: OpaqueDigest;
  changed_files_bucket: ChangedFilesBucket;
  changed_lines_bucket: ChangedLinesBucket;
}): OpaqueDigest {
  if (!OPAQUE_ID.test(input.repository_key) ||
    !OPAQUE_ID.test(input.workspace_key)) {
    throw new TypeError("invalid exact cohort identity");
  }
  return statsOpaqueDigest("stats-exact-cohort-v1", [
    input.repository_key,
    input.workspace_key,
    input.changed_files_bucket,
    input.changed_lines_bucket,
  ]);
}

const INVALID_COHORT_DISTRIBUTION_INPUT =
  "invalid cohort distribution input";
const INVALID_COHORT_EVALUATION_MODE = "invalid cohort evaluation mode";
const INVALID_STATS_AGGREGATION_INPUT = "invalid stats aggregation input";

function finiteMathResult(value: number, message: string): number {
  if (!Number.isFinite(value)) throw new TypeError(message);
  return value;
}

function checkedFiniteSum(
  values: readonly number[],
  message: string,
): number {
  let total = 0;
  for (const value of values) {
    total = finiteMathResult(total + value, message);
  }
  return total;
}

function roundedDistributionValue(value: number, message: string): number {
  const adjusted = finiteMathResult(value + Number.EPSILON, message);
  const scaled = finiteMathResult(adjusted * 10_000, message);
  const rounded = finiteMathResult(Math.round(scaled) / 10_000, message);
  return Object.is(rounded, -0) ? 0 : rounded;
}

function quantile(
  sorted: readonly number[],
  probability: number,
  message: string,
): number {
  const position = finiteMathResult(
    (sorted.length - 1) * probability,
    message,
  );
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  const spread = finiteMathResult(upper - lower, message);
  const offset = finiteMathResult(
    spread * (position - lowerIndex),
    message,
  );
  return finiteMathResult(lower + offset, message);
}

function normalizedCohortDistribution(
  input: readonly number[],
  message: string,
): CohortDistribution {
  const values = snapshotArray(input);
  if (
    values === null ||
    values.length === 0 ||
    values.some((value) =>
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      Object.is(value, -0)
    )
  ) throw new TypeError(message);
  const sorted = (values as number[]).sort((left, right) => left - right);
  const median = quantile(sorted, 0.5, message);
  const deviations = sorted
    .map((value) => finiteMathResult(Math.abs(value - median), message))
    .sort((left, right) => left - right);
  return {
    median: roundedDistributionValue(median, message),
    p50: roundedDistributionValue(quantile(sorted, 0.5, message), message),
    p75: roundedDistributionValue(quantile(sorted, 0.75, message), message),
    mad: roundedDistributionValue(
      quantile(deviations, 0.5, message),
      message,
    ),
    sample_count: sorted.length,
  };
}

export function cohortDistribution(
  input: readonly number[],
): CohortDistribution {
  return normalizedCohortDistribution(
    input,
    INVALID_COHORT_DISTRIBUTION_INPUT,
  );
}

const TERMINAL_METRIC_AXES = [
  "confirmed_critical_path_ms",
  "estimated_critical_path_upper_ms",
  "resource_cost_ms",
  "human_wait_ms",
  "unexplained_ms",
] as const satisfies readonly TerminalMetricAxis[];

const PROJECTED_REQUIRED_FIELDS = [
  "schema_version",
  "snapshot_id",
  "created_at_ms",
  "baseline_metrics",
  "command_costs",
  "reason_codes",
] as const;
const PROJECTED_OPTIONAL_FIELDS = [
  "work_unit_key",
  "git_state_key",
  "repository_key",
  "workspace_key",
  "changed_files_bucket",
  "changed_lines_bucket",
  "cohort_key",
  "terminal_metrics",
] as const;

const PROJECTED_TERMINAL_METRIC_FIELDS = [
  "measured_wall_ms",
  ...TERMINAL_METRIC_AXES,
  "rules",
] as const;
const PROJECTED_BASELINE_ROW_FIELDS = ["metric", "value"] as const;
const PROJECTED_COMMAND_COST_FIELDS = [
  "command_key", "cache_state", "duration_ms",
] as const;
const CHANGED_FILES_BUCKETS = new Set<ChangedFilesBucket>([
  "files_0",
  "files_1",
  "files_2_4",
  "files_5_9",
  "files_10_19",
  "files_20_49",
  "files_50_plus",
]);
const CHANGED_LINES_BUCKETS = new Set<ChangedLinesBucket>([
  "lines_0",
  "lines_1_9",
  "lines_10_49",
  "lines_50_199",
  "lines_200_999",
  "lines_1000_plus",
]);
const BASELINE_METRICS = new Set<BoundedBaselineMetric>([
  "human_wait_ratio",
]);
const STATS_INPUT_REASONS = new Set<StatsInputReason>([
  "content_fallback",
  "invalid_repository_identity",
  "missing_changed_lines",
  "missing_selector",
  "missing_terminal_metrics",
]);

function normalizedProjectedTerminalMetrics(
  value: unknown,
): NonNullable<StatsAggregationInput["terminal_metrics"]> {
  const entries = exactDataValues(value, PROJECTED_TERMINAL_METRIC_FIELDS);
  const measured = metricValue(entries.get("measured_wall_ms"));
  const confirmed = metricValue(entries.get("confirmed_critical_path_ms"));
  const upper = metricValue(
    entries.get("estimated_critical_path_upper_ms"),
  );
  const resource = metricValue(entries.get("resource_cost_ms"));
  const wait = metricValue(entries.get("human_wait_ms"));
  const unexplained = metricValue(entries.get("unexplained_ms"));
  const rules = normalizeRuleRows(entries.get("rules"));
  const confirmedSum = checkedFiniteSum(
    rules.map((row) => row.confirmed_critical_path_ms),
    INVALID_STATS_AGGREGATION_INPUT,
  );
  const upperSum = checkedFiniteSum(
    rules.map((row) => row.estimated_critical_path_upper_ms),
    INVALID_STATS_AGGREGATION_INPUT,
  );
  const resourceSum = checkedFiniteSum(
    rules.map((row) => row.resource_cost_ms),
    INVALID_STATS_AGGREGATION_INPUT,
  );
  const accountedWall = checkedFiniteSum(
    [upper, wait, unexplained],
    INVALID_STATS_AGGREGATION_INPUT,
  );
  if (
    confirmed > upper ||
    accountedWall > measured ||
    confirmedSum !== confirmed ||
    upperSum !== upper ||
    resourceSum !== resource
  ) throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
  return {
    measured_wall_ms: measured,
    confirmed_critical_path_ms: confirmed,
    estimated_critical_path_upper_ms: upper,
    resource_cost_ms: resource,
    human_wait_ms: wait,
    unexplained_ms: unexplained,
    rules,
  };
}

function normalizedProjectedBaselineMetrics(
  value: unknown,
): Array<{ metric: BoundedBaselineMetric; value: number }> {
  const values = snapshotArray(value);
  if (values === null) throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
  const result: Array<{ metric: BoundedBaselineMetric; value: number }> = [];
  let previous = "";
  for (const rowValue of values) {
    const row = exactDataValues(rowValue, PROJECTED_BASELINE_ROW_FIELDS);
    const metric = row.get("metric");
    if (
      typeof metric !== "string" ||
      !BASELINE_METRICS.has(metric as BoundedBaselineMetric) ||
      (previous !== "" && compareStrings(previous, metric) >= 0)
    ) throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
    previous = metric;
    result.push({
      metric: metric as BoundedBaselineMetric,
      value: metricValue(row.get("value")),
    });
  }
  return result;
}

function normalizedProjectedReasonCodes(value: unknown): StatsInputReason[] {
  const values = snapshotArray(value);
  if (values === null) throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
  const result: StatsInputReason[] = [];
  let previous = "";
  for (const reason of values) {
    if (
      typeof reason !== "string" ||
      !STATS_INPUT_REASONS.has(reason as StatsInputReason) ||
      (previous !== "" && compareStrings(previous, reason) >= 0)
    ) throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
    previous = reason;
    result.push(reason as StatsInputReason);
  }
  return result;
}

function normalizedProjectedCommandCosts(
  value: unknown,
): StatsAggregationInput["command_costs"] {
  const values = snapshotArray(value);
  if (values === null) throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
  return values.map<StatsAggregationInput["command_costs"][number]>(
    (rowValue) => {
      const row = exactDataValues(rowValue, PROJECTED_COMMAND_COST_FIELDS);
      const cacheState = row.get("cache_state");
      if (cacheState !== "cold" && cacheState !== "warm") {
        throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
      }
      const normalizedCacheState: "cold" | "warm" = cacheState;
      return {
        command_key: opaqueId(row.get("command_key")),
        cache_state: normalizedCacheState,
        duration_ms: metricValue(row.get("duration_ms")),
      };
    },
  ).sort((left, right) =>
    compareStrings(left.command_key, right.command_key) ||
    compareStrings(left.cache_state, right.cache_state) ||
    left.duration_ms - right.duration_ms);
}

function optionalOpaqueValue(
  entries: ReadonlyMap<string, unknown>,
  key: string,
): OpaqueDigest | undefined {
  return entries.has(key) ? opaqueId(entries.get(key)) : undefined;
}

function optionalClosedValue<T extends string>(
  entries: ReadonlyMap<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
): T | undefined {
  if (!entries.has(key)) return undefined;
  const value = entries.get(key);
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
  }
  return value as T;
}

function projectedInput(value: unknown): StatsAggregationInput {
  try {
    const entries = exactDataValues(
      value,
      PROJECTED_REQUIRED_FIELDS,
      PROJECTED_OPTIONAL_FIELDS,
    );
    const snapshotId = opaqueId(entries.get("snapshot_id"));
    const createdAt = entries.get("created_at_ms");
    if (
      entries.get("schema_version") !== 1 ||
      typeof createdAt !== "number" ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0
    ) throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
    const commandCosts = normalizedProjectedCommandCosts(
      entries.get("command_costs"),
    );
    const workUnitKey = optionalOpaqueValue(entries, "work_unit_key");
    const gitStateKey = optionalOpaqueValue(entries, "git_state_key");
    const repositoryKey = optionalOpaqueValue(entries, "repository_key");
    const workspaceKey = optionalOpaqueValue(entries, "workspace_key");
    const cohortKey = optionalOpaqueValue(entries, "cohort_key");
    const filesBucket = optionalClosedValue(
      entries,
      "changed_files_bucket",
      CHANGED_FILES_BUCKETS,
    );
    const linesBucket = optionalClosedValue(
      entries,
      "changed_lines_bucket",
      CHANGED_LINES_BUCKETS,
    );
    const terminalMetrics = entries.has("terminal_metrics")
      ? normalizedProjectedTerminalMetrics(entries.get("terminal_metrics"))
      : undefined;
    const baselineMetrics = normalizedProjectedBaselineMetrics(
      entries.get("baseline_metrics"),
    );
    const reasonCodes = normalizedProjectedReasonCodes(
      entries.get("reason_codes"),
    );
    if (
      terminalMetrics !== undefined &&
      repositoryKey !== undefined &&
      workspaceKey !== undefined &&
      filesBucket !== undefined &&
      linesBucket !== undefined &&
      cohortKey !== undefined &&
      cohortKey !== exactCohortKey({
        repository_key: repositoryKey,
        workspace_key: workspaceKey,
        changed_files_bucket: filesBucket,
        changed_lines_bucket: linesBucket,
      })
    ) throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
    return {
      schema_version: 1,
      snapshot_id: snapshotId,
      created_at_ms: createdAt,
      ...(workUnitKey === undefined ? {} : { work_unit_key: workUnitKey }),
      ...(gitStateKey === undefined ? {} : { git_state_key: gitStateKey }),
      ...(repositoryKey === undefined
        ? {}
        : { repository_key: repositoryKey }),
      ...(workspaceKey === undefined ? {} : { workspace_key: workspaceKey }),
      ...(filesBucket === undefined
        ? {}
        : { changed_files_bucket: filesBucket }),
      ...(linesBucket === undefined
        ? {}
        : { changed_lines_bucket: linesBucket }),
      ...(cohortKey === undefined ? {} : { cohort_key: cohortKey }),
      ...(terminalMetrics === undefined
        ? {}
        : { terminal_metrics: terminalMetrics }),
      baseline_metrics: baselineMetrics,
      command_costs: commandCosts,
      reason_codes: reasonCodes,
    };
  } catch {
    throw new TypeError(INVALID_STATS_AGGREGATION_INPUT);
  }
}

function selectNormalizedTerminalSnapshots(
  entries: readonly StatsAggregationInput[],
): TerminalSelectionResult {
  const byWorkUnit = new Map<OpaqueDigest, StatsAggregationInput[]>();
  let ineligible = 0;
  for (const entry of entries) {
    if (entry.work_unit_key === undefined || entry.git_state_key === undefined) {
      ineligible += 1;
      continue;
    }
    const group = byWorkUnit.get(entry.work_unit_key);
    if (group === undefined) byWorkUnit.set(entry.work_unit_key, [entry]);
    else group.push(entry);
  }
  const terminals: StatsAggregationInput[] = [];
  const eligibleTerminals: StatsAggregationInput[] = [];
  let eligibleCount = 0;
  for (const workUnitEntries of byWorkUnit.values()) {
    eligibleCount += workUnitEntries.length;
    const byState = new Map<OpaqueDigest, StatsAggregationInput[]>();
    for (const entry of workUnitEntries) {
      const stateKey = entry.git_state_key!;
      const state = byState.get(stateKey);
      if (state === undefined) byState.set(stateKey, [entry]);
      else state.push(entry);
    }
    const terminalState = [...byState.entries()]
      .map(([gitStateKey, variants]) => ({
        gitStateKey,
        variants,
        firstSeenAtMs: Math.min(...variants.map(({ created_at_ms }) =>
          created_at_ms)),
      }))
      .sort((left, right) =>
        left.firstSeenAtMs - right.firstSeenAtMs ||
        compareStrings(left.gitStateKey, right.gitStateKey))
      .at(-1)!;
    const terminal = [...terminalState.variants].sort((left, right) =>
      left.created_at_ms - right.created_at_ms ||
      compareStrings(left.snapshot_id, right.snapshot_id))
      .at(-1)!;
    terminals.push(terminal);
    if (
      terminal.terminal_metrics === undefined ||
      terminal.repository_key === undefined ||
      terminal.workspace_key === undefined ||
      terminal.changed_files_bucket === undefined ||
      terminal.changed_lines_bucket === undefined ||
      terminal.cohort_key === undefined
    ) {
      ineligible += 1;
    } else {
      eligibleTerminals.push(terminal);
    }
  }
  terminals.sort((left, right) =>
    compareStrings(left.work_unit_key!, right.work_unit_key!) ||
    compareStrings(left.snapshot_id, right.snapshot_id));
  eligibleTerminals.sort((left, right) =>
    compareStrings(left.work_unit_key!, right.work_unit_key!) ||
    compareStrings(left.snapshot_id, right.snapshot_id));
  return {
    terminals,
    eligible_terminals: eligibleTerminals,
    metadata: {
      stored_snapshot_count: entries.length,
      terminal_snapshot_count: terminals.length,
      superseded_snapshot_count: eligibleCount - byWorkUnit.size,
      ineligible_snapshot_count: ineligible,
    },
  };
}

export function selectTerminalSnapshots(
  input: readonly StatsAggregationInput[],
): TerminalSelectionResult {
  const values = snapshotArray(input);
  if (values === null) throw new TypeError("invalid stats aggregation input");
  return selectNormalizedTerminalSnapshots(values.map(projectedInput));
}

function normalizeCohortEvaluationMode(
  value: unknown,
): CohortEvaluationMode {
  try {
    const entries = exactDataValues(
      value,
      ["mode"],
      ["current_work_unit_key", "current_cohort_key"],
    );
    const mode = entries.get("mode");
    if (mode === "stats_all_groups" && entries.size === 1) {
      return { mode };
    }
    if (
      mode === "analysis_current" &&
      entries.size === 3 &&
      entries.has("current_work_unit_key") &&
      entries.has("current_cohort_key")
    ) {
      return {
        mode,
        current_work_unit_key: opaqueId(entries.get("current_work_unit_key")),
        current_cohort_key: opaqueId(entries.get("current_cohort_key")),
      };
    }
    throw new TypeError(INVALID_COHORT_EVALUATION_MODE);
  } catch {
    throw new TypeError(INVALID_COHORT_EVALUATION_MODE);
  }
}

function selectComparableTerminals(
  terminals: readonly StatsAggregationInput[],
  mode: CohortEvaluationMode,
): StatsAggregationInput[] {
  if (mode.mode === "stats_all_groups") {
    return terminals.filter(({ cohort_key }) => cohort_key !== undefined);
  }
  return terminals
    .filter(({ cohort_key }) => cohort_key === mode.current_cohort_key)
    .filter(({ work_unit_key }) =>
      work_unit_key !== mode.current_work_unit_key);
}

export function selectComparableTerminalSnapshots(
  input: readonly StatsAggregationInput[],
  mode: CohortEvaluationMode,
): StatsAggregationInput[] {
  const normalizedMode = normalizeCohortEvaluationMode(mode);
  return selectComparableTerminals(
    selectTerminalSnapshots(input).eligible_terminals,
    normalizedMode,
  );
}

function aggregatePopulationMetadata(
  sampleCount: number,
  minimumCohortSize: number,
): TerminalAggregatePopulationMetadata {
  const available = sampleCount >= minimumCohortSize;
  return {
    sample_count: sampleCount,
    minimum_cohort_size: minimumCohortSize,
    status: available ? "available" : "suppressed",
    reason_codes: available ? [] : ["below_minimum"],
  };
}

function sortedMetricSum(values: readonly number[]): number {
  return checkedFiniteSum(
    [...values].sort((left, right) => left - right),
    INVALID_STATS_AGGREGATION_INPUT,
  );
}

function aggregateTerminalMetrics(
  terminals: readonly StatsAggregationInput[],
): TerminalMetricAggregate {
  return Object.fromEntries(TERMINAL_METRIC_AXES.map((axis) => [
    axis,
    roundedDistributionValue(sortedMetricSum(terminals.map((entry) =>
      entry.terminal_metrics![axis])), INVALID_STATS_AGGREGATION_INPUT),
  ])) as unknown as TerminalMetricAggregate;
}

function aggregateRuleMinutes(
  terminals: readonly StatsAggregationInput[],
): Array<{ rule_id: RuleId; minutes: number }> {
  const byRule = new Map<RuleId, number[]>();
  for (const terminal of terminals) {
    for (const row of terminal.terminal_metrics!.rules) {
      if (!(row.confirmed_critical_path_ms > 0)) continue;
      const values = byRule.get(row.rule_id);
      if (values === undefined) {
        byRule.set(row.rule_id, [row.confirmed_critical_path_ms]);
      } else {
        values.push(row.confirmed_critical_path_ms);
      }
    }
  }
  return [...byRule.entries()]
    .map(([rule_id, values]) => ({
      rule_id,
      minutes: roundedDistributionValue(
        finiteMathResult(
          sortedMetricSum(values) / 60_000,
          INVALID_STATS_AGGREGATION_INPUT,
        ),
        INVALID_STATS_AGGREGATION_INPUT,
      ),
    }))
    .filter(({ minutes }) => minutes > 0)
    .sort((left, right) => compareStrings(left.rule_id, right.rule_id));
}

export function aggregateTerminalStats(
  input: readonly StatsAggregationInput[],
  mode: CohortEvaluationMode,
  minimumCohortSize = DEFAULT_TERMINAL_MINIMUM_COHORT_SIZE,
): TerminalStatsAggregateResult {
  if (
    !Number.isSafeInteger(minimumCohortSize) ||
    minimumCohortSize < DEFAULT_TERMINAL_MINIMUM_COHORT_SIZE ||
    minimumCohortSize > MAXIMUM_TERMINAL_COHORT_SIZE
  ) throw new TypeError("invalid minimum cohort size");

  const normalizedMode = normalizeCohortEvaluationMode(mode);
  const values = snapshotArray(input);
  if (values === null) throw new TypeError("invalid stats aggregation input");
  const entries = values.map(projectedInput);
  const selection = selectNormalizedTerminalSnapshots(entries);
  const population = aggregatePopulationMetadata(
    selection.eligible_terminals.length,
    minimumCohortSize,
  );
  const distinctWorkUnits = selection.terminals.length;
  const comparable = selectComparableTerminals(
    selection.eligible_terminals,
    normalizedMode,
  );
  const byCohort = new Map<OpaqueDigest, StatsAggregationInput[]>();
  for (const terminal of comparable) {
    const cohortKey = terminal.cohort_key!;
    const group = byCohort.get(cohortKey);
    if (group === undefined) byCohort.set(cohortKey, [terminal]);
    else group.push(terminal);
  }
  const cohorts = [...byCohort.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([cohort_key, terminals]): TerminalStatsCohortAggregate => {
      const metadata = aggregatePopulationMetadata(
        terminals.length,
        minimumCohortSize,
      );
      return {
        cohort_key,
        metadata,
        ...(metadata.status === "suppressed" ? {} : {
          distributions: Object.fromEntries(TERMINAL_METRIC_AXES.map((axis) => [
            axis,
            normalizedCohortDistribution(
              terminals.map((entry) => entry.terminal_metrics![axis]),
              INVALID_STATS_AGGREGATION_INPUT,
            ),
          ])) as Record<TerminalMetricAxis, CohortDistribution>,
        }),
      };
    });

  return {
    selected_snapshot_ids: selection.terminals.map(({ snapshot_id }) =>
      snapshot_id),
    metadata: {
      stored_snapshot_count: selection.metadata.stored_snapshot_count,
      distinct_work_unit_count: distinctWorkUnits,
      terminal_snapshot_count: selection.metadata.terminal_snapshot_count,
      superseded_snapshot_count: selection.metadata.superseded_snapshot_count,
      ineligible_snapshot_count: selection.metadata.ineligible_snapshot_count,
      ...population,
    },
    ...(population.status === "suppressed" ? {} : {
      terminal_metrics: aggregateTerminalMetrics(
        selection.eligible_terminals,
      ),
    }),
    rule_minutes: population.status === "suppressed"
      ? []
      : aggregateRuleMinutes(selection.eligible_terminals),
    cohorts,
  };
}
