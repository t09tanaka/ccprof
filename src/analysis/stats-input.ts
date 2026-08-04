import { types as utilTypes } from "node:util";

import {
  changedFilesBucket,
  changedLinesBucket,
  exactCohortKey,
  normalizeTerminalStatsSnapshot,
  statsOpaqueDigest,
  type BoundedBaselineMetric,
  type StatsAggregationInput as ProjectedStatsAggregationInput,
  type StatsInputReason,
} from "./stats-aggregation.js";
import type { AnalysisSelectorIdentity } from "../store/analyses.js";

export type { StatsAggregationInput } from "./stats-aggregation.js";

const HEX_64 = /^[0-9a-f]{64}$/u;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SELECTOR_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BASELINE_METRICS = new Set<BoundedBaselineMetric>([
  "human_wait_ratio",
]);

function exactDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  message: string,
): Map<string, unknown> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    const allowed = new Set([...required, ...optional]);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))
    ) throw new TypeError();
    const result = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) throw new TypeError();
      result.set(key, descriptor.value);
    }
    return result;
  } catch {
    throw new TypeError(message);
  }
}

function assertPassiveJson(
  value: unknown,
  state = { remaining: 100_000 },
  depth = 0,
): void {
  if (state.remaining <= 0 || depth > 64) {
    throw new TypeError("invalid stats history data");
  }
  state.remaining -= 1;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError("invalid stats history data");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError("invalid stats history data");
  }
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new TypeError("invalid stats history data");
    }
    const length = descriptors.length;
    if (
      length === undefined ||
      !("value" in length) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      keys.length !== length.value + 1
    ) throw new TypeError("invalid stats history data");
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) throw new TypeError("invalid stats history data");
      assertPassiveJson(descriptor.value, state, depth + 1);
    }
    return;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("invalid stats history data");
  }
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError("invalid stats history data");
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) throw new TypeError("invalid stats history data");
    assertPassiveJson(descriptor.value, state, depth + 1);
  }
}

function selectorIdentity(value: unknown): AnalysisSelectorIdentity {
  const kindObject = exactDataObject(
    value,
    ["kind"],
    ["number", "range", "base_ref_digest", "head_ref_digest"],
    "invalid stats history selector",
  );
  const kind = kindObject.get("kind");
  if (kind === "github_pr") {
    if (
      kindObject.size !== 2 ||
      !kindObject.has("number") ||
      !Number.isSafeInteger(kindObject.get("number")) ||
      (kindObject.get("number") as number) <= 0
    ) throw new TypeError("invalid stats history selector");
    return { kind, number: kindObject.get("number") as number };
  }
  const base = kindObject.get("base_ref_digest");
  const head = kindObject.get("head_ref_digest");
  if (
    typeof base !== "string" ||
    typeof head !== "string" ||
    !SELECTOR_DIGEST.test(base) ||
    !SELECTOR_DIGEST.test(head)
  ) throw new TypeError("invalid stats history selector");
  if (kind === "explicit_range") {
    const range = kindObject.get("range");
    if (
      kindObject.size !== 4 ||
      (range !== "double_dot" && range !== "triple_dot")
    ) throw new TypeError("invalid stats history selector");
    return {
      kind,
      range,
      base_ref_digest: base,
      head_ref_digest: head,
    };
  }
  if (kind === "inferred_local_range" && kindObject.size === 3) {
    return {
      kind,
      base_ref_digest: base,
      head_ref_digest: head,
    };
  }
  throw new TypeError("invalid stats history selector");
}

interface ProjectedIdentity {
  repositoryId?: string;
  workUnitKey?: string;
  gitStateKey?: string;
  reason?: StatsInputReason;
}

function projectedIdentity(value: unknown): ProjectedIdentity {
  const base = exactDataObject(
    value,
    [],
    [
      "mode",
      "repo_id",
      "base_oid",
      "head_oid",
      "merge_base_oid",
      "window",
      "source_digest",
      "config_digest",
      "policy_digest",
      "history_digest",
      "selector",
    ],
    "invalid stats history identity",
  );
  if (base.get("mode") === "content-fallback" && base.size === 1) {
    return { reason: "content_fallback" };
  }
  const required = [
    "repo_id",
    "base_oid",
    "head_oid",
    "merge_base_oid",
    "window",
    "source_digest",
    "config_digest",
    "policy_digest",
    "history_digest",
  ];
  if (
    base.has("mode") ||
    required.some((key) => !base.has(key)) ||
    (base.size !== required.length && base.size !== required.length + 1)
  ) throw new TypeError("invalid stats history identity");
  const repositoryId = base.get("repo_id");
  const baseOid = base.get("base_oid");
  const headOid = base.get("head_oid");
  const mergeBaseOid = base.get("merge_base_oid");
  if (
    typeof repositoryId !== "string" ||
    !HEX_64.test(repositoryId) ||
    typeof baseOid !== "string" ||
    !OID.test(baseOid) ||
    typeof headOid !== "string" ||
    !OID.test(headOid) ||
    typeof mergeBaseOid !== "string" ||
    !OID.test(mergeBaseOid)
  ) throw new TypeError("invalid stats history identity");
  for (const key of [
    "source_digest",
    "config_digest",
    "policy_digest",
    "history_digest",
  ]) {
    const digest = base.get(key);
    if (typeof digest !== "string" || !HEX_64.test(digest)) {
      throw new TypeError("invalid stats history identity");
    }
  }
  const window = exactDataObject(
    base.get("window"),
    ["started_at_ms", "start_source", "end_source", "completeness"],
    ["ended_at_ms"],
    "invalid stats history identity",
  );
  const startedAt = window.get("started_at_ms");
  const endedAt = window.get("ended_at_ms");
  if (
    !Number.isSafeInteger(startedAt) ||
    (startedAt as number) < 0 ||
    (endedAt !== undefined &&
      (!Number.isSafeInteger(endedAt) || (endedAt as number) < 0)) ||
    ![
      "explicit",
      "branch_reflog",
      "session_branch_transition",
      "commit_anchor_lookback",
    ].includes(window.get("start_source") as string) ||
    !["explicit", "analysis_time"].includes(
      window.get("end_source") as string,
    ) ||
    !["complete", "partial"].includes(window.get("completeness") as string)
  ) throw new TypeError("invalid stats history identity");
  const rawSelector = base.get("selector");
  if (rawSelector === undefined) {
    return { repositoryId, reason: "missing_selector" };
  }
  const selector = selectorIdentity(rawSelector);
  const workUnitKey = statsOpaqueDigest("stats-work-unit-v1", [
    repositoryId,
    selector,
  ]);
  return {
    repositoryId,
    workUnitKey,
    gitStateKey: statsOpaqueDigest("stats-git-state-v1", [
      workUnitKey,
      baseOid,
      headOid,
      mergeBaseOid,
    ]),
  };
}

function baselineMetrics(
  value: unknown,
): ProjectedStatsAggregationInput["baseline_metrics"] {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError("invalid stats history metrics");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const metrics: Array<{ metric: BoundedBaselineMetric; value: number }> = [];
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError("invalid stats history metrics");
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) throw new TypeError("invalid stats history metrics");
    const metric = key as BoundedBaselineMetric;
    const metricValue = descriptor.value;
    if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) {
      throw new TypeError("invalid stats history metrics");
    }
    if (
      BASELINE_METRICS.has(metric) &&
      metricValue >= 0 &&
      !Object.is(metricValue, -0)
    ) metrics.push({ metric, value: metricValue });
  }
  return metrics.sort((left, right) => left.metric.localeCompare(right.metric));
}

export function projectStatsAggregationInput(
  value: unknown,
): ProjectedStatsAggregationInput {
  const entry = exactDataObject(
    value,
    ["snapshot_id", "identity", "record"],
    [],
    "invalid stats history entry",
  );
  const snapshotId = entry.get("snapshot_id");
  if (typeof snapshotId !== "string" || !HEX_64.test(snapshotId)) {
    throw new TypeError("invalid stats history entry");
  }
  const identity = projectedIdentity(entry.get("identity"));
  const record = exactDataObject(
    entry.get("record"),
    [
      "schema_version",
      "analysis_id",
      "created_at_ms",
      "unit",
      "summary",
      "findings",
      "metrics",
      "command_costs",
    ],
    ["read_observations", "analysis_budget", "terminal_stats_snapshot"],
    "invalid stats history record",
  );
  if (record.get("schema_version") !== 1) {
    throw new TypeError("invalid stats history record");
  }
  const analysisId = record.get("analysis_id");
  const createdAt = record.get("created_at_ms");
  if (
    typeof analysisId !== "string" ||
    analysisId === "" ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) throw new TypeError("invalid stats history record");
  for (const key of [
    "unit",
    "summary",
    "findings",
    "command_costs",
    "read_observations",
    "analysis_budget",
  ]) {
    const child = record.get(key);
    if (child !== undefined) assertPassiveJson(child);
  }
  const reasons = new Set<StatsInputReason>();
  if (identity.reason !== undefined) reasons.add(identity.reason);
  const terminalValue = record.get("terminal_stats_snapshot");
  const terminal = terminalValue === undefined
    ? undefined
    : normalizeTerminalStatsSnapshot(terminalValue);
  if (terminal === undefined) reasons.add("missing_terminal_metrics");

  let repositoryKey: string | undefined;
  let workspaceKey: string | undefined;
  let filesBucket: ReturnType<typeof changedFilesBucket> | undefined;
  let linesBucket: ReturnType<typeof changedLinesBucket> | undefined;
  let cohortKey: string | undefined;
  if (terminal !== undefined) {
    if (identity.repositoryId !== undefined &&
      identity.repositoryId !== terminal.cohort.repository_id) {
      reasons.add("invalid_repository_identity");
    } else {
      repositoryKey = terminal.cohort.repository_id;
      workspaceKey = terminal.cohort.workspace_id;
      filesBucket = changedFilesBucket(terminal.cohort.changed_files);
      if (terminal.cohort.changed_lines === undefined) {
        reasons.add("missing_changed_lines");
      } else {
        linesBucket = changedLinesBucket(terminal.cohort.changed_lines);
        cohortKey = exactCohortKey({
          repository_key: repositoryKey,
          workspace_key: workspaceKey,
          changed_files_bucket: filesBucket,
          changed_lines_bucket: linesBucket,
        });
      }
    }
  }

  return {
    schema_version: 1,
    snapshot_id: snapshotId,
    created_at_ms: createdAt,
    ...(identity.workUnitKey === undefined
      ? {}
      : { work_unit_key: identity.workUnitKey }),
    ...(identity.gitStateKey === undefined
      ? {}
      : { git_state_key: identity.gitStateKey }),
    ...(repositoryKey === undefined ? {} : { repository_key: repositoryKey }),
    ...(workspaceKey === undefined ? {} : { workspace_key: workspaceKey }),
    ...(filesBucket === undefined
      ? {}
      : { changed_files_bucket: filesBucket }),
    ...(linesBucket === undefined
      ? {}
      : { changed_lines_bucket: linesBucket }),
    ...(cohortKey === undefined ? {} : { cohort_key: cohortKey }),
    ...(terminal === undefined ? {} : {
      terminal_metrics: {
        measured_wall_ms: terminal.measured_wall_ms,
        confirmed_critical_path_ms: terminal.confirmed_critical_path_ms,
        estimated_critical_path_upper_ms:
          terminal.estimated_critical_path_upper_ms,
        resource_cost_ms: terminal.resource_cost_ms,
        human_wait_ms: terminal.human_wait_ms,
        unexplained_ms: terminal.unexplained_ms,
        rules: terminal.rules.map((row) => ({ ...row })),
      },
    }),
    baseline_metrics: baselineMetrics(record.get("metrics")),
    command_costs: [],
    reason_codes: [...reasons].sort((left, right) =>
      left.localeCompare(right)),
  };
}
