import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import {
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { types as utilTypes } from "node:util";

import { normalizeCommand } from "../analysis/command.js";
import { commandIdentityKey } from "../analysis/command-identity.js";
import {
  normalizeAnalysisBudgetResult,
  type AnalysisBudgetResult,
} from "../analysis/budgets.js";
import {
  cohortDistribution,
  normalizeTerminalStatsSnapshot,
  selectComparableTerminalSnapshots,
  type CohortEvaluationMode,
  type TerminalStatsSnapshotV1,
} from "../analysis/stats-aggregation.js";
import type { StatsAggregationInput } from "../analysis/stats-input.js";
import { normalizeRepoPath } from "../analysis/test-map.js";
import {
  findingCompatibilityMetadata,
  findingScoringRationale,
  findingSeverity,
  projectFindingConfidence,
  projectFindingRecoverable,
  snapshotFindingConfidence,
  snapshotImpactEstimate,
} from "../core/model.js";
import type {
  AnalysisSummary,
  AnalysisUnit,
  BaselineComparison,
  CommandIdentity,
  Confidence,
  Finding,
  FindingConfidence,
  FindingScoringRationale,
  ImpactEstimate,
} from "../core/model.js";
import { canonicalJson, readLegacyJson } from "./legacy-json.js";
import type { StorePaths } from "./paths.js";
import { openStoreDatabase, storeDatabasePath } from "./sqlite.js";
import {
  DEFAULT_MINIMUM_COHORT_SIZE,
  MAXIMUM_COHORT_SIZE,
  MINIMUM_COHORT_SIZE,
} from "../policy/organization-policy.js";

export interface StoreWarning {
  code: string;
  message: string;
  path: string;
}

export interface StoredCommandCost {
  command: string;
  command_identity?: CommandIdentity;
  cache_state?: "cold" | "warm";
  duration_min: number;
  session_refs: string[];
}

export interface StoredReadObservation {
  path: string;
  object_id: string;
  duration_min: number;
  session_refs: string[];
  confidence?: Confidence;
}
export interface AnalysisRecordInput {
  analysis_id?: string;
  created_at_ms: number;
  unit: AnalysisUnit;
  summary: AnalysisSummary;
  findings: readonly Finding[];
  metrics?: Readonly<Record<string, number>>;
  command_costs?: readonly StoredCommandCost[];
  read_observations?: readonly StoredReadObservation[];
  analysis_budget?: AnalysisBudgetResult;
  terminal_stats_snapshot?: TerminalStatsSnapshotV1;
}

export interface AnalysisRecord {
  schema_version: 1;
  analysis_id: string;
  created_at_ms: number;
  unit: AnalysisUnit;
  summary: AnalysisSummary;
  findings: Finding[];
  metrics: Record<string, number>;
  command_costs: StoredCommandCost[];
  read_observations?: StoredReadObservation[];
  analysis_budget?: AnalysisBudgetResult;
  terminal_stats_snapshot?: TerminalStatsSnapshotV1;
}

export interface AnalysisSaveResult {
  record: AnalysisRecord;
  audit_identity: AnalysisAuditIdentity;
  warnings: StoreWarning[];
}

export type AnalysisSelectorIdentity =
  | { kind: "github_pr"; number: number }
  | {
      kind: "explicit_range";
      range: "double_dot" | "triple_dot";
      base_ref_digest: string;
      head_ref_digest: string;
    }
  | {
      kind: "inferred_local_range";
      base_ref_digest: string;
      head_ref_digest: string;
    };

export interface AnalysisHistoryEntry {
  snapshot_id: string;
  identity: AnalysisSnapshotIdentity | { mode: "content-fallback" };
  record: AnalysisRecord;
}

export interface AnalysisHistoryResult {
  records: AnalysisRecord[];
  entries?: AnalysisHistoryEntry[];
  warnings: StoreWarning[];
}

export interface AnalysisSnapshotIdentity {
  repo_id: string; base_oid: string; head_oid: string; merge_base_oid: string;
  window: {
    started_at_ms: number; ended_at_ms?: number; end_source: "explicit" | "analysis_time";
    start_source: "explicit" | "branch_reflog" | "session_branch_transition" | "commit_anchor_lookback"; completeness: "complete" | "partial";
  };
  source_digest: string; config_digest: string;
  policy_digest: string; history_digest: string;
  selector?: AnalysisSelectorIdentity;
}

export type AnalysisSnapshotEnvelopeIdentity = AnalysisSnapshotIdentity |
  { mode: "content-fallback" };

export interface AnalysisAuditIdentity {
  analysis_id: string;
  snapshot_id: string;
  created_at_ms: number;
  deterministic_digest: `sha256:${string}`;
  snapshot_identity: AnalysisSnapshotEnvelopeIdentity;
}

export interface AnalysisSaveOptions { snapshot?: AnalysisSnapshotIdentity; }
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function analysisDigest(domain: string, value: unknown): string {
  if (domain === "" || domain.includes("\0"))
    throw new TypeError("digest domain must be non-empty and contain no NUL");
  return createHash("sha256").update(`ccprof\0${domain}\0`)
    .update(canonicalJson(value)).digest("hex");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))]
    .sort((left, right) => left.localeCompare(right));
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string");
}

function normalizeCommandIdentity(value: unknown): CommandIdentity {
  if (!isObjectRecord(value)) throw new TypeError("command identity must be an object");
  const cwd = value.repo_relative_cwd;
  if (
    typeof cwd !== "string" ||
    (cwd !== "." && (cwd === "" || cwd.includes("\0") ||
      cwd.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(cwd) ||
      cwd.split("/").some((segment) =>
        segment === "" || segment === "." || segment === "..")))
  ) {
    throw new TypeError("command identity cwd must be normalized and repository-relative");
  }
  const argv = value.normalized_argv;
  if (!isStringArray(argv) || argv.length === 0 || argv[0] === "") {
    throw new TypeError("command identity argv must have a non-empty executable");
  }
  const executor = value.executor;
  if (executor !== "shell" && executor !== "native-tool") {
    throw new TypeError("command identity executor is invalid");
  }
  return { repo_relative_cwd: cwd, normalized_argv: [...argv], executor };
}

function isCommandIdentity(value: unknown): boolean {
  try { normalizeCommandIdentity(value); return true; } catch { return false; }
}

const RULE_IDS = new Set([
  "R001",
  "R002",
  "R003",
  "R004",
  "R005",
  "R006",
  "R007",
  "R008",
]);
const CLASSIFICATIONS = new Set(["repo", "config", "behavior"]);
const SCOPES = new Set(["this_pr", "separate_issue", "claude_md"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const BOUNDS = new Set(["point", "upper"]);
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isStoredFinding(value: unknown): value is Finding {
  if (!isObjectRecord(value)) return false;
  const recoverable = value.recoverable;
  const evidence = value.evidence;
  const fixRecipe = value.fix_recipe;
  return (
    typeof value.finding_key === "string" &&
    value.finding_key !== "" &&
    typeof value.rule_id === "string" &&
    RULE_IDS.has(value.rule_id) &&
    typeof value.title === "string" &&
    typeof value.classification === "string" &&
    CLASSIFICATIONS.has(value.classification) &&
    typeof value.scope === "string" &&
    SCOPES.has(value.scope) &&
    typeof value.confidence === "string" &&
    CONFIDENCES.has(value.confidence) &&
    (
      value.target === undefined ||
      (typeof value.target === "string" && value.target !== "")
    ) &&
    isObjectRecord(recoverable) &&
    finiteNonnegative(recoverable.min) &&
    typeof recoverable.bound === "string" &&
    BOUNDS.has(recoverable.bound) &&
    isObjectRecord(evidence) &&
    isStringArray(evidence.session_refs) &&
    isStringArray(evidence.interval_ids) &&
    (
      evidence.command === undefined ||
      typeof evidence.command === "string"
    ) &&
    isObjectRecord(fixRecipe) &&
    typeof fixRecipe.suggestion === "string" &&
    fixRecipe.suggestion !== "" &&
    typeof fixRecipe.verify === "string" &&
    fixRecipe.verify !== "" &&
    isStringArray(value.caveats) &&
    findingCompatibilityMetadata(value).valid
  );
}

function snapshotScoringRationale(value: unknown): FindingScoringRationale[] {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) throw new TypeError();
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    ownKeys.length !== lengthDescriptor.value + 1
  ) throw new TypeError();
  const snapshot: FindingScoringRationale[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) throw new TypeError();
    snapshot.push(descriptor.value as FindingScoringRationale);
  }
  return snapshot;
}

function legacyImpactKind(ruleId: Finding["rule_id"]): ImpactEstimate["kind"] {
  return ruleId === "R005" || ruleId === "R006"
    ? "resource_cost"
    : "critical_path_latency";
}

function legacyImpact(finding: Finding): ImpactEstimate {
  return snapshotImpactEstimate({
    lower_ms: 0,
    upper_ms: finding.recoverable.min * 60_000,
    kind: legacyImpactKind(finding.rule_id),
  });
}

function legacyFindingConfidence(confidence: Confidence): FindingConfidence {
  if (confidence === "low") {
    return { evidence: "low", causal: "low", source_completeness: 0 };
  }
  return {
    evidence: confidence,
    causal: "medium",
    source_completeness: 0.5,
  };
}

function isLegacyProjectedConfidence(value: FindingConfidence): boolean {
  return (
    value.evidence === "low" &&
    value.causal === "low" &&
    value.source_completeness === 0
  ) || (
    (value.evidence === "medium" || value.evidence === "high") &&
    value.causal === "medium" &&
    value.source_completeness === 0.5
  );
}

function exactRationale(
  actual: readonly FindingScoringRationale[],
  expected: readonly FindingScoringRationale[],
): boolean {
  return actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index]);
}

function isCanonicalLegacyProjection(
  base: Finding,
  impact: ImpactEstimate,
  confidence: FindingConfidence,
  rationale: readonly FindingScoringRationale[],
): boolean {
  const projectedRecoverable = projectFindingRecoverable(impact);
  const expectedRationale = findingScoringRationale(impact, confidence, {
    ...(base.rule_id === "R004" ? { policy_dependent: true } : {}),
    legacy_projection: true,
  });
  return impact.kind === legacyImpactKind(base.rule_id) &&
    impact.lower_ms === 0 &&
    !("expected_ms" in impact) &&
    isLegacyProjectedConfidence(confidence) &&
    base.confidence === projectFindingConfidence(confidence) &&
    base.recoverable.min === projectedRecoverable.min &&
    base.recoverable.bound === projectedRecoverable.bound &&
    exactRationale(rationale, expectedRationale);
}

function snapshotStoredFinding(value: Finding): Finding {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const compatibilitySource: Record<string, unknown> = {};
    for (const field of ["rule_version", "compatibility_epoch"] as const) {
      const descriptor = descriptors[field];
      if (descriptor !== undefined) {
        Object.defineProperty(compatibilitySource, field, descriptor);
      }
    }
    const compatibility = findingCompatibilityMetadata(compatibilitySource);
    if (!compatibility.valid) throw new TypeError();
    const read = (field: keyof Finding): unknown => {
      const descriptor = descriptors[field] as PropertyDescriptor | undefined;
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        if (descriptor === undefined) return undefined;
        throw new TypeError();
      }
      return descriptor.value;
    };
    const base = cloneJson({
      finding_key: read("finding_key"),
      rule_id: read("rule_id"),
      title: read("title"),
      target: read("target"),
      classification: read("classification"),
      cause: read("cause"),
      scope: read("scope"),
      confidence: read("confidence"),
      evidence: read("evidence"),
      recoverable: read("recoverable"),
      fix_recipe: read("fix_recipe"),
      caveats: read("caveats"),
      ...(compatibility.metadata ?? {}),
    });
    if (!isStoredFinding(base)) throw new TypeError();

    const canonicalFields = [
      "impact",
      "finding_confidence",
      "severity",
      "scoring_rationale",
    ] as const;
    const presentCanonicalFields = canonicalFields.filter(
      (field) => descriptors[field] !== undefined,
    );
    if (
      presentCanonicalFields.length !== 0 &&
      presentCanonicalFields.length !== canonicalFields.length
    ) throw new TypeError();

    let impact: ImpactEstimate;
    let confidence: FindingConfidence;
    let rationale: FindingScoringRationale[];
    if (presentCanonicalFields.length === 0) {
      impact = legacyImpact(base);
      confidence = legacyFindingConfidence(base.confidence);
      rationale = findingScoringRationale(impact, confidence, {
        ...(base.rule_id === "R004" ? { policy_dependent: true } : {}),
        legacy_projection: true,
      });
    } else {
      impact = snapshotImpactEstimate(read("impact"));
      confidence = snapshotFindingConfidence(read("finding_confidence"));
      rationale = snapshotScoringRationale(read("scoring_rationale"));
      const expectedSeverity = findingSeverity(impact, confidence);
      const expectedRationale = findingScoringRationale(impact, confidence, {
        ...(base.rule_id === "R004" ? { policy_dependent: true } : {}),
      });
      const legacyProjection = rationale.includes("legacy_projection");
      if (
        read("severity") !== expectedSeverity ||
        (legacyProjection
          ? !isCanonicalLegacyProjection(base, impact, confidence, rationale)
          : !exactRationale(rationale, expectedRationale))
      ) throw new TypeError();
    }
    const { target, ...baseWithoutTarget } = base;
    return {
      ...baseWithoutTarget,
      ...(target === undefined ? {} : { target }),
      confidence: projectFindingConfidence(confidence),
      impact,
      finding_confidence: confidence,
      severity: findingSeverity(impact, confidence),
      scoring_rationale: rationale,
      recoverable: projectFindingRecoverable(impact),
    };
  } catch {
    throw new TypeError("invalid finding");
  }
}

function snapshotStoredFindings(values: readonly Finding[]): Finding[] {
  try {
    if (
      values === null ||
      typeof values !== "object" ||
      utilTypes.isProxy(values) ||
      !Array.isArray(values) ||
      Object.getPrototypeOf(values) !== Array.prototype
    ) throw new TypeError();
    const ownKeys = Reflect.ownKeys(values);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(values, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      ownKeys.length !== lengthDescriptor.value + 1
    ) throw new TypeError();
    const snapshots: Finding[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) throw new TypeError();
      snapshots.push(snapshotStoredFinding(descriptor.value as Finding));
    }
    return snapshots;
  } catch {
    throw new TypeError("invalid finding");
  }
}

function summaryMetrics(summary: AnalysisSummary): Record<string, number> {
  const rawObserved = summary.measured_min + summary.idle_excluded_min;
  return {
    measured_min: summary.measured_min,
    idle_excluded_min: summary.idle_excluded_min,
    estimated_floor_min: summary.estimated_floor_min,
    recoverable_min: summary.recoverable_min,
    human_wait_min: summary.human_wait_min ?? 0,
    unexplained_min: summary.unexplained_min,
    recoverable_ratio:
      summary.measured_min > 0
        ? summary.recoverable_min / summary.measured_min
        : 0,
    idle_ratio:
      rawObserved > 0 ? summary.idle_excluded_min / rawObserved : 0,
  };
}

function findingCommandCosts(
  findings: readonly Finding[],
): StoredCommandCost[] {
  return findings.flatMap((finding) => {
    const rawIdentity = finding.evidence.command_identity;
    const identity = rawIdentity === undefined
      ? undefined
      : normalizeCommandIdentity(rawIdentity);
    const command = finding.evidence.command;
    if (typeof command !== "string") return [];
    const durationMs = finding.evidence.duration_ms;
    const durationMin = finiteNonnegative(durationMs)
      ? durationMs / 60_000
      : finding.recoverable.min;
    if (!finiteNonnegative(durationMin) || durationMin <= 0) return [];
    return [{
      command,
      ...(identity === undefined ? {} : { command_identity: identity }),
      duration_min: durationMin,
      session_refs: [...finding.evidence.session_refs],
    }];
  });
}

function normalizedCommandCosts(
  costs: readonly StoredCommandCost[],
): StoredCommandCost[] {
  const byKey = new Map<string, StoredCommandCost & { durations: number[] }>();
  for (const value of costs) {
    if (
      value === null || typeof value !== "object" || Array.isArray(value) ||
      utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    ) throw new TypeError("invalid command cost");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set<PropertyKey>([
      "command", "command_identity", "cache_state", "duration_min",
      "session_refs",
    ]);
    if (
      keys.some((key) => !allowed.has(key)) ||
      ["command", "duration_min", "session_refs"].some(
        (key) => descriptors[key] === undefined,
      ) ||
      keys.some((key) => {
        const descriptor = typeof key === "string"
          ? descriptors[key]
          : undefined;
        return descriptor === undefined || descriptor.enumerable !== true ||
          !("value" in descriptor);
      })
    ) throw new TypeError("invalid command cost");
    const read = (key: string): unknown => descriptors[key]?.value;
    const rawIdentity = read("command_identity");
    const identity = rawIdentity === undefined
      ? undefined
      : normalizeCommandIdentity(rawIdentity);
    const duration = read("duration_min");
    if (!finiteNonnegative(duration) || duration <= 0) {
      continue;
    }
    const rawCommand = read("command");
    if (typeof rawCommand !== "string") continue;
    const command = normalizeCommand(rawCommand);
    if (command === null) continue;
    const cacheState = read("cache_state");
    if (
      cacheState !== undefined && cacheState !== "cold" &&
      cacheState !== "warm"
    ) continue;
    const rawSessionRefs = read("session_refs");
    if (!isStringArray(rawSessionRefs)) {
      throw new TypeError("invalid command cost");
    }
    const lane = cacheState ?? "absent";
    const key = identity === undefined
      ? `legacy\0${command}\0${lane}`
      : `identity\0${commandIdentityKey(identity)}\0${lane}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        command,
        ...(identity === undefined ? {} : { command_identity: identity }),
        ...(cacheState === undefined ? {} : { cache_state: cacheState }),
        duration_min: 0,
        durations: [duration],
        session_refs: sortedUnique(rawSessionRefs),
      });
    } else {
      if (command < existing.command) existing.command = command;
      existing.durations.push(duration);
      existing.session_refs = sortedUnique([
        ...existing.session_refs,
        ...rawSessionRefs,
      ]);
    }
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, { durations, ...cost }]) => ({
      ...cost,
      duration_min: durations.sort((left, right) => left - right)
        .reduce((total, duration) => total + duration, 0),
    }));
}

type NormalizedReadObservation = StoredReadObservation & { confidence: Confidence };
function normalizeReadObservation(value: unknown): NormalizedReadObservation {
  if (!isObjectRecord(value)) throw new TypeError("read observation must be an object");
  let path: string;
  try { path = normalizeRepoPath(typeof value.path === "string"
    ? value.path.normalize("NFC") : ""); }
  catch { throw new TypeError("read observation path must be repository-relative"); }
  const objectId = typeof value.object_id === "string" ? value.object_id.toLowerCase() : "";
  if (!OID_PATTERN.test(objectId)) throw new TypeError("invalid read observation object_id");
  if (!finiteNonnegative(value.duration_min)) throw new TypeError("invalid read observation duration_min");
  if (!isStringArray(value.session_refs) || value.session_refs.some((ref) => ref === ""))
    throw new TypeError("invalid read observation session_refs");
  const confidence = value.confidence ?? "low";
  if (typeof confidence !== "string" || !CONFIDENCES.has(confidence))
    throw new TypeError("invalid read observation confidence");
  return { path, object_id: objectId, duration_min: value.duration_min,
    session_refs: sortedUnique(value.session_refs), confidence: confidence as Confidence };
}
function normalizedReadObservations(values: readonly StoredReadObservation[]) {
  const byIdentity = new Map<string, NormalizedReadObservation>();
  for (const raw of values) {
    const value = normalizeReadObservation(raw);
    const key = `${value.path}\0${value.object_id}`;
    const prior = byIdentity.get(key);
    byIdentity.set(key, prior === undefined ? value : {
      ...value, duration_min: prior.duration_min + value.duration_min,
      session_refs: sortedUnique([...prior.session_refs, ...value.session_refs]),
      confidence: prior.confidence === "low" || value.confidence === "low"
        ? "low" : prior.confidence === "medium" || value.confidence === "medium" ? "medium" : "high",
    });
  }
  const result = [...byIdentity.values()].sort((left, right) => left.path.localeCompare(right.path) ||
    left.object_id.localeCompare(right.object_id));
  if (result.some(({ duration_min }) => !Number.isFinite(duration_min)))
    throw new TypeError("invalid read observation duration_min total");
  return result;
}
function isStoredReadObservation(value: unknown): boolean {
  try {
    const normalized = normalizeReadObservation(value);
    const raw = value as StoredReadObservation;
    return raw.path === normalized.path && raw.object_id === normalized.object_id &&
      (raw.confidence === undefined || raw.confidence === normalized.confidence) &&
      raw.session_refs.join("\0") === normalized.session_refs.join("\0");
  } catch { return false; }
}
function validateInput(input: AnalysisRecordInput): void {
  if (
    !Number.isSafeInteger(input.created_at_ms) ||
    input.created_at_ms < 0
  ) {
    throw new TypeError("analysis created_at_ms must be a nonnegative safe integer");
  }
  if (
    input.analysis_id !== undefined &&
    input.analysis_id.trim() === ""
  ) {
    throw new TypeError("analysis_id must be non-empty when provided");
  }
  if (input.unit.repo.trim() === "" || input.unit.pr_ref.trim() === "") {
    throw new TypeError("analysis unit repo and pr_ref must be non-empty");
  }
}

function optionalAnalysisBudget(
  input: AnalysisRecordInput,
): AnalysisBudgetResult | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, "analysis_budget");
  } catch {
    throw new TypeError("Invalid analysis budget result.");
  }
  if (descriptor === undefined) return undefined;
  if (descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError("Invalid analysis budget result.");
  }
  if (descriptor.value === undefined) return undefined;
  return normalizeAnalysisBudgetResult(descriptor.value);
}

function optionalTerminalStatsSnapshot(
  input: AnalysisRecordInput,
): TerminalStatsSnapshotV1 | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(
      input,
      "terminal_stats_snapshot",
    );
  } catch {
    throw new TypeError("Invalid terminal stats snapshot.");
  }
  if (descriptor === undefined) return undefined;
  if (descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError("Invalid terminal stats snapshot.");
  }
  if (descriptor.value === undefined) return undefined;
  return normalizeTerminalStatsSnapshot(descriptor.value);
}

export function makeAnalysisRecord(
  input: AnalysisRecordInput,
): AnalysisRecord {
  validateInput(input);
  const findings = snapshotStoredFindings(input.findings);
  const analysisBudget = optionalAnalysisBudget(input);
  const terminalStatsSnapshot = optionalTerminalStatsSnapshot(input);
  const metrics = {
    ...summaryMetrics(input.summary),
    ...Object.fromEntries(
      Object.entries(input.metrics ?? {})
        .filter(([, value]) => Number.isFinite(value))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  const costs = normalizedCommandCosts(
    input.command_costs ?? findingCommandCosts(findings),
  );
  const content = {
    schema_version: 1 as const,
    created_at_ms: input.created_at_ms,
    unit: {
      repo: input.unit.repo,
      pr_ref: input.unit.pr_ref,
      sessions: sortedUnique(input.unit.sessions),
    },
    summary: cloneJson(input.summary),
    findings,
    metrics,
    command_costs: costs,
    ...(input.read_observations === undefined ? {} :
      { read_observations: normalizedReadObservations(input.read_observations) }),
    ...(analysisBudget === undefined ? {} : { analysis_budget: analysisBudget }),
    ...(terminalStatsSnapshot === undefined ? {} : {
      terminal_stats_snapshot: terminalStatsSnapshot,
    }),
  };
  const generatedId = createHash("sha256")
    .update(canonicalJson(content))
    .digest("hex");
  return {
    ...content,
    analysis_id: input.analysis_id?.trim() ?? generatedId,
  };
}

function recordOrder(
  left: Pick<AnalysisRecord, "analysis_id" | "created_at_ms">,
  right: Pick<AnalysisRecord, "analysis_id" | "created_at_ms">,
): number {
  return left.created_at_ms - right.created_at_ms ||
    left.analysis_id.localeCompare(right.analysis_id);
}

function isRecord(value: unknown): value is AnalysisRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<AnalysisRecord>;
  if (
    record.schema_version !== 1 ||
    typeof record.analysis_id !== "string" ||
    record.analysis_id === "" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    (record.created_at_ms ?? -1) < 0 ||
    !isObjectRecord(record.unit) ||
    typeof record.unit.repo !== "string" ||
    typeof record.unit.pr_ref !== "string" ||
    !isStringArray(record.unit.sessions) ||
    !isObjectRecord(record.summary) ||
    !Array.isArray(record.findings) ||
    !record.findings.every(isStoredFinding) ||
    record.metrics === undefined ||
    record.metrics === null ||
    !isObjectRecord(record.metrics) ||
    !Array.isArray(record.command_costs) ||
    (record.analysis_budget !== undefined &&
      !isAnalysisBudgetResult(record.analysis_budget)) ||
    (record.terminal_stats_snapshot !== undefined &&
      !isTerminalStatsSnapshot(record.terminal_stats_snapshot)) ||
    (record.read_observations !== undefined &&
      (!Array.isArray(record.read_observations) ||
        !record.read_observations.every(isStoredReadObservation)))
  ) {
    return false;
  }
  const summary = record.summary;
  // Legacy records predate human_wait_min; a missing value is treated as 0.
  if (
    summary.human_wait_min !== undefined &&
    !finiteNonnegative(summary.human_wait_min)
  ) {
    return false;
  }
  return [
    summary.measured_min,
    summary.idle_excluded_min,
    summary.estimated_floor_min,
    summary.recoverable_min,
    summary.unexplained_min,
  ].every(finiteNonnegative) &&
    Object.values(record.metrics).every((entry) =>
      typeof entry === "number" && Number.isFinite(entry)
    ) &&
    record.command_costs.every((cost) =>
      cost !== null &&
      typeof cost === "object" &&
      typeof cost.command === "string" &&
      finiteNonnegative(cost.duration_min) &&
      Array.isArray(cost.session_refs) &&
      cost.session_refs.every((entry) => typeof entry === "string") &&
      (cost.command_identity === undefined ||
        isCommandIdentity(cost.command_identity)) &&
      (cost.cache_state === undefined || cost.cache_state === "cold" ||
        cost.cache_state === "warm")
    );
}

function isAnalysisBudgetResult(value: unknown): value is AnalysisBudgetResult {
  try {
    const normalized = normalizeAnalysisBudgetResult(value);
    return canonicalJson(normalized) === canonicalJson(value);
  } catch {
    return false;
  }
}

function isTerminalStatsSnapshot(
  value: unknown,
): value is TerminalStatsSnapshotV1 {
  try {
    const normalized = normalizeTerminalStatsSnapshot(value);
    return canonicalJson(normalized) === canonicalJson(value);
  } catch {
    return false;
  }
}

function normalizeRecordFindings(record: AnalysisRecord): AnalysisRecord {
  const normalized = {
    ...record,
    findings: snapshotStoredFindings(record.findings),
    ...(record.terminal_stats_snapshot === undefined ? {} : {
      terminal_stats_snapshot: normalizeTerminalStatsSnapshot(
        record.terminal_stats_snapshot,
      ),
    }),
  };
  if (!isRecord(normalized)) {
    throw new TypeError("unsupported or invalid analysis record");
  }
  return normalized;
}

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Writes within the destination directory, flushes the file, closes it, and
 * performs one atomic rename. It intentionally does not add a lock.
 */
export async function writeJsonAtomically(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(canonicalJson(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function asRecord(
  input: AnalysisRecord | AnalysisRecordInput,
): AnalysisRecord {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new TypeError("Invalid analysis budget result.");
  }
  const budgetDescriptor = descriptors.analysis_budget;
  if (budgetDescriptor !== undefined) {
    if (
      budgetDescriptor.enumerable !== true ||
      !("value" in budgetDescriptor)
    ) {
      throw new TypeError("Invalid analysis budget result.");
    }
    const normalized = budgetDescriptor.value === undefined
      ? undefined
      : normalizeAnalysisBudgetResult(budgetDescriptor.value);
    descriptors.analysis_budget = {
      configurable: true,
      enumerable: true,
      value: normalized,
      writable: true,
    };
  }
  let snapshot: AnalysisRecord | AnalysisRecordInput;
  try {
    snapshot = Object.defineProperties({}, descriptors) as
      AnalysisRecord | AnalysisRecordInput;
  } catch {
    throw new TypeError("Invalid analysis budget result.");
  }
  try {
    const record = makeAnalysisRecord(snapshot);
    if (!isRecord(record)) throw new TypeError();
    return record;
  } catch {
    throw new TypeError("invalid analysis record");
  }
}

type StoreDatabase = ReturnType<typeof openStoreDatabase>;
function closeDatabase(database: StoreDatabase | undefined): void { try { database?.close(); } catch { /* Preserve the operation result. */ } }
type SnapshotEnvelope = { schema_version: 1; identity: AnalysisSnapshotEnvelopeIdentity;
  payload: Omit<AnalysisRecord, "analysis_id" | "created_at_ms"> };
interface PreparedAnalysis {
  record: AnalysisRecord;
  envelope: SnapshotEnvelope;
  record_json: string;
  snapshot_id: string;
}
const LEGACY_ANALYSES_MIGRATION = "legacy-analyses-json-v1", HEX_64 = /^[0-9a-f]{64}$/u;
const SELECTOR_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const WINDOW_STARTS = new Set(["explicit", "branch_reflog", "session_branch_transition", "commit_anchor_lookback"]);
function selectorDataObject(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value) || utilTypes.isProxy(value)) {
    throw new TypeError("invalid snapshot selector");
  }
  let descriptors: PropertyDescriptorMap;
  let ownKeys: (string | symbol)[];
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError();
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError("invalid snapshot selector");
  }
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError("invalid snapshot selector");
  }
  const data = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true ||
      !("value" in descriptor)) {
      throw new TypeError("invalid snapshot selector");
    }
    data[key] = descriptor.value;
  }
  return data;
}
function exactSelectorFields(
  value: Record<string, unknown>, fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}
function normalizeSelectorIdentity(value: unknown): AnalysisSelectorIdentity {
  const selector = selectorDataObject(value);
  if (selector.kind === "github_pr") {
    if (!exactSelectorFields(selector, ["kind", "number"]) ||
      !Number.isSafeInteger(selector.number) || (selector.number as number) <= 0) {
      throw new TypeError("invalid snapshot selector");
    }
    return { kind: "github_pr", number: selector.number as number };
  }
  const refDigests = (): { base_ref_digest: string; head_ref_digest: string } => {
    if (typeof selector.base_ref_digest !== "string" ||
      !SELECTOR_DIGEST.test(selector.base_ref_digest) ||
      typeof selector.head_ref_digest !== "string" ||
      !SELECTOR_DIGEST.test(selector.head_ref_digest)) {
      throw new TypeError("invalid snapshot selector");
    }
    return {
      base_ref_digest: selector.base_ref_digest,
      head_ref_digest: selector.head_ref_digest,
    };
  };
  if (selector.kind === "explicit_range") {
    if (!exactSelectorFields(selector, [
      "kind", "range", "base_ref_digest", "head_ref_digest",
    ]) || (selector.range !== "double_dot" && selector.range !== "triple_dot")) {
      throw new TypeError("invalid snapshot selector");
    }
    return { kind: "explicit_range", range: selector.range, ...refDigests() };
  }
  if (selector.kind === "inferred_local_range") {
    if (!exactSelectorFields(selector, [
      "kind", "base_ref_digest", "head_ref_digest",
    ])) {
      throw new TypeError("invalid snapshot selector");
    }
    return { kind: "inferred_local_range", ...refDigests() };
  }
  throw new TypeError("invalid snapshot selector");
}
function snapshotSelector(value: AnalysisSnapshotIdentity): AnalysisSelectorIdentity | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    if (utilTypes.isProxy(value)) throw new TypeError();
    descriptor = Object.getOwnPropertyDescriptor(value, "selector");
    if (descriptor === undefined && "selector" in value) throw new TypeError();
  } catch {
    throw new TypeError("invalid snapshot selector");
  }
  if (descriptor === undefined) return undefined;
  if (descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError("invalid snapshot selector");
  }
  return descriptor.value === undefined
    ? undefined
    : normalizeSelectorIdentity(descriptor.value);
}
function normalizeSnapshotIdentity(value: AnalysisSnapshotIdentity): AnalysisSnapshotIdentity {
  const oid = (entry: unknown, label: string, pattern = OID_PATTERN): string => {
    const normalized = typeof entry === "string" ? entry.toLowerCase() : "";
    if (!pattern.test(normalized)) throw new TypeError(`invalid snapshot ${label}`);
    return normalized;
  };
  const window = value?.window;
  const selector = snapshotSelector(value);
  if (!isObjectRecord(window) || !Number.isSafeInteger(window.started_at_ms) || window.started_at_ms < 0 ||
    !WINDOW_STARTS.has(window.start_source) || (window.end_source !== "explicit" &&
      window.end_source !== "analysis_time") || (window.completeness !== "complete" &&
      window.completeness !== "partial") || (window.end_source === "explicit"
        ? !Number.isSafeInteger(window.ended_at_ms) || (window.ended_at_ms ?? -1) < window.started_at_ms
        : window.ended_at_ms !== undefined)) {
    throw new TypeError("invalid snapshot window");
  }
  return {
    repo_id: oid(value.repo_id, "repo_id", HEX_64), base_oid: oid(value.base_oid, "base_oid"),
    head_oid: oid(value.head_oid, "head_oid"),
    merge_base_oid: oid(value.merge_base_oid, "merge_base_oid"),
    window: { started_at_ms: window.started_at_ms, start_source: window.start_source,
      end_source: window.end_source, completeness: window.completeness,
      ...(window.ended_at_ms === undefined ? {} : { ended_at_ms: window.ended_at_ms }) },
    source_digest: oid(value.source_digest, "source_digest", HEX_64),
    config_digest: oid(value.config_digest, "config_digest", HEX_64),
    policy_digest: oid(value.policy_digest, "policy_digest", HEX_64), history_digest: oid(value.history_digest, "history_digest", HEX_64),
    ...(selector === undefined ? {} : { selector }),
  };
}
function captureSnapshotOption(
  options: AnalysisSaveOptions,
): AnalysisSnapshotIdentity | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    if (utilTypes.isProxy(options)) throw new TypeError();
    descriptor = Object.getOwnPropertyDescriptor(options, "snapshot");
    if (descriptor === undefined && "snapshot" in options) throw new TypeError();
  } catch {
    throw new TypeError("invalid analysis save options");
  }
  if (descriptor === undefined) return undefined;
  if (descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError("invalid analysis save options");
  }
  return descriptor.value === undefined
    ? undefined
    : normalizeSnapshotIdentity(descriptor.value);
}
function snapshotEnvelope(record: AnalysisRecord, identity?: AnalysisSnapshotIdentity): SnapshotEnvelope {
  const { analysis_id: _id, created_at_ms: _time, ...payload } = record;
  return { schema_version: 1, identity: identity === undefined
      ? { mode: "content-fallback" } : normalizeSnapshotIdentity(identity),
    payload: cloneJson(payload) };
}
function prepareAnalysis(
  record: AnalysisRecord,
  snapshot?: AnalysisSnapshotIdentity,
): PreparedAnalysis {
  const envelope = snapshotEnvelope(record, snapshot);
  return {
    record,
    envelope,
    record_json: canonicalJson(envelope),
    snapshot_id: analysisDigest("analysis-snapshot-v1", envelope),
  };
}
function auditIdentity(prepared: PreparedAnalysis): AnalysisAuditIdentity {
  return {
    analysis_id: prepared.record.analysis_id,
    snapshot_id: prepared.snapshot_id,
    created_at_ms: prepared.record.created_at_ms,
    deterministic_digest: `sha256:${prepared.snapshot_id}`,
    snapshot_identity: cloneJson(prepared.envelope.identity),
  };
}

export function analysisAuditIdentity(
  input: AnalysisRecord | AnalysisRecordInput,
  options: AnalysisSaveOptions = {},
): AnalysisAuditIdentity {
  const record = asRecord(input);
  const snapshot = captureSnapshotOption(options);
  return auditIdentity(prepareAnalysis(record, snapshot));
}
class StoreConflict extends Error {
  constructor(readonly code: "analysis_record_conflict" | "analysis_snapshot_conflict", message: string) { super(message); }
}

const BUDGET_ROW_COLUMNS = [
  "execution_id",
  "max_input_bytes",
  "max_input_events",
  "max_wall_ms",
  "max_cpu_ms",
  "max_output_bytes",
  "max_source_items",
  "consumed_input_bytes",
  "consumed_input_events",
  "consumed_wall_ms",
  "consumed_cpu_ms",
  "consumed_output_bytes",
  "consumed_source_items",
  "observed_input_bytes",
  "observed_input_events",
  "observed_wall_ms",
  "observed_cpu_ms",
  "observed_output_bytes",
  "observed_source_items",
  "completeness",
  "truncation_reason",
  "coverage",
] as const;

interface AnalysisBudgetRow {
  execution_id: string;
  max_input_bytes: number;
  max_input_events: number;
  max_wall_ms: number;
  max_cpu_ms: number;
  max_output_bytes: number;
  max_source_items: number;
  consumed_input_bytes: number;
  consumed_input_events: number;
  consumed_wall_ms: number;
  consumed_cpu_ms: number;
  consumed_output_bytes: number;
  consumed_source_items: number;
  observed_input_bytes: number;
  observed_input_events: number;
  observed_wall_ms: number;
  observed_cpu_ms: number;
  observed_output_bytes: number;
  observed_source_items: number;
  completeness: "complete" | "partial";
  truncation_reason: AnalysisBudgetResult["truncation_reason"] | null;
  coverage: number;
}

function budgetRow(
  executionId: string,
  result: AnalysisBudgetResult,
): AnalysisBudgetRow {
  return {
    execution_id: executionId,
    max_input_bytes: result.configured.max_input_bytes,
    max_input_events: result.configured.max_input_events,
    max_wall_ms: result.configured.max_wall_ms,
    max_cpu_ms: result.configured.max_cpu_ms,
    max_output_bytes: result.configured.max_output_bytes,
    max_source_items: result.configured.max_source_items,
    consumed_input_bytes: result.consumed.input_bytes,
    consumed_input_events: result.consumed.input_events,
    consumed_wall_ms: result.consumed.wall_ms,
    consumed_cpu_ms: result.consumed.cpu_ms,
    consumed_output_bytes: result.consumed.output_bytes,
    consumed_source_items: result.consumed.source_items,
    observed_input_bytes: result.observed.input_bytes,
    observed_input_events: result.observed.input_events,
    observed_wall_ms: result.observed.wall_ms,
    observed_cpu_ms: result.observed.cpu_ms,
    observed_output_bytes: result.observed.output_bytes,
    observed_source_items: result.observed.source_items,
    completeness: result.completeness,
    truncation_reason: result.truncation_reason ?? null,
    coverage: result.coverage,
  };
}

function readBudgetRow(
  database: StoreDatabase,
  executionId: string,
): AnalysisBudgetRow | undefined {
  return database.prepare(`SELECT ${BUDGET_ROW_COLUMNS.join(", ")}
    FROM analysis_budget_runs WHERE execution_id = ?`).get(executionId) as
    AnalysisBudgetRow | undefined;
}

function assertBudgetMirror(
  database: StoreDatabase,
  executionId: string,
  result: AnalysisBudgetResult | undefined,
): void {
  const existing = readBudgetRow(database, executionId);
  const matches = result === undefined
    ? existing === undefined
    : existing !== undefined &&
      canonicalJson(existing) === canonicalJson(budgetRow(executionId, result));
  if (!matches) {
    throw new StoreConflict(
      "analysis_record_conflict",
      "An immutable analysis execution has different budget content.",
    );
  }
}

function insertBudgetRow(
  database: StoreDatabase,
  executionId: string,
  result: AnalysisBudgetResult | undefined,
): void {
  if (result === undefined) return;
  const placeholders = BUDGET_ROW_COLUMNS.map((column) => `@${column}`);
  database.prepare(`INSERT INTO analysis_budget_runs
    (${BUDGET_ROW_COLUMNS.join(", ")}) VALUES (${placeholders.join(", ")})`)
    .run(budgetRow(executionId, result));
}

function budgetResultFromRow(row: AnalysisBudgetRow): AnalysisBudgetResult {
  return normalizeAnalysisBudgetResult({
    configured: {
      max_input_bytes: row.max_input_bytes,
      max_input_events: row.max_input_events,
      max_wall_ms: row.max_wall_ms,
      max_cpu_ms: row.max_cpu_ms,
      max_output_bytes: row.max_output_bytes,
      max_source_items: row.max_source_items,
    },
    consumed: {
      input_bytes: row.consumed_input_bytes,
      input_events: row.consumed_input_events,
      wall_ms: row.consumed_wall_ms,
      cpu_ms: row.consumed_cpu_ms,
      output_bytes: row.consumed_output_bytes,
      source_items: row.consumed_source_items,
    },
    observed: {
      input_bytes: row.observed_input_bytes,
      input_events: row.observed_input_events,
      wall_ms: row.observed_wall_ms,
      cpu_ms: row.observed_cpu_ms,
      output_bytes: row.observed_output_bytes,
      source_items: row.observed_source_items,
    },
    completeness: row.completeness,
    ...(row.truncation_reason === null
      ? {}
      : { truncation_reason: row.truncation_reason }),
    coverage: row.coverage,
  });
}

function insertAnalysis(database: StoreDatabase, prepared: PreparedAnalysis): void {
  const { record, record_json: recordJson, snapshot_id: snapshotId } = prepared;
  const execution = database.prepare(`SELECT e.snapshot_id, e.executed_at_ms, s.record_json
    FROM analysis_executions e JOIN analysis_snapshots s USING (snapshot_id)
    WHERE e.execution_id = ?`).get(record.analysis_id) as
      { snapshot_id: string; executed_at_ms: number; record_json: string } | undefined;
  if (execution !== undefined) {
    if (execution.snapshot_id === snapshotId && execution.executed_at_ms === record.created_at_ms &&
      execution.record_json === recordJson) {
      assertBudgetMirror(database, record.analysis_id, record.analysis_budget);
      return;
    }
    throw new StoreConflict("analysis_record_conflict",
      "An immutable analysis execution already exists with different content.");
  }
  const existing = database.prepare(
    "SELECT record_json FROM analysis_snapshots WHERE snapshot_id = ?",
  ).get(snapshotId) as { record_json: string } | undefined;
  if (existing !== undefined && existing.record_json !== recordJson) {
    throw new StoreConflict("analysis_snapshot_conflict",
      "An analysis snapshot hash already exists with different content.");
  }
  if (existing === undefined) database.prepare(`INSERT INTO analysis_snapshots
    (snapshot_id, created_at_ms, record_json) VALUES (?, ?, ?)`)
    .run(snapshotId, record.created_at_ms, recordJson);
  else database.prepare(`UPDATE analysis_snapshots SET created_at_ms = MIN(created_at_ms, ?)
    WHERE snapshot_id = ?`).run(record.created_at_ms, snapshotId);
  database.prepare(`INSERT INTO analysis_executions
    (execution_id, snapshot_id, executed_at_ms) VALUES (?, ?, ?)`)
    .run(record.analysis_id, snapshotId, record.created_at_ms);
  insertBudgetRow(database, record.analysis_id, record.analysis_budget);
}
function migrationWarning(code: string, message: string, path: string): StoreWarning { return { code, message, path }; }
class CorruptLegacyRecord extends Error {}
function readLegacyRecord(path: string): AnalysisRecord {
  const read = readLegacyJson(path);
  if (read.kind === "missing") throw new Error("legacy analysis file disappeared while scanning");
  if (read.kind === "corrupt") throw new CorruptLegacyRecord(read.message);
  if (!isRecord(read.value)) throw new CorruptLegacyRecord("unsupported or invalid analysis record");
  try {
    return normalizeRecordFindings(read.value);
  } catch (error) {
    throw new CorruptLegacyRecord(errorMessage(error));
  }
}
function scanLegacyAnalyses(paths: StorePaths): { records: AnalysisRecord[]; warnings: StoreWarning[] } {
  let directory;
  try { directory = lstatSync(paths.analyses_dir); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return { records: [], warnings: [] };
    throw error;
  }
  if (directory.isSymbolicLink() || !directory.isDirectory())
    throw new Error("legacy analyses path is not a regular directory");
  const files = readdirSync(paths.analyses_dir).filter((file) => file.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  const records: AnalysisRecord[] = [], warnings: StoreWarning[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const path = join(paths.analyses_dir, file);
    try {
      const value = readLegacyRecord(path);
      if (seen.has(value.analysis_id)) {
        warnings.push(migrationWarning("duplicate_analysis_record",
          `Duplicate analysis ID ${value.analysis_id} was skipped.`, path));
      } else { seen.add(value.analysis_id); records.push(value); }
    } catch (error) {
      if (!(error instanceof CorruptLegacyRecord)) throw error;
      warnings.push(migrationWarning("corrupt_analysis_record",
        `Analysis record was skipped: ${errorMessage(error)}`, path));
    }
  }
  const after = lstatSync(paths.analyses_dir);
  if (!after.isDirectory() || after.dev !== directory.dev || after.ino !== directory.ino)
    throw new Error("legacy analyses directory changed while scanning");
  return { records, warnings };
}
function migrationComplete(database: StoreDatabase): boolean {
  return database.prepare("SELECT 1 FROM store_migrations WHERE name = ?")
    .get(LEGACY_ANALYSES_MIGRATION) !== undefined;
}
function migrateLegacyAnalyses(database: StoreDatabase, paths: StorePaths): StoreWarning[] {
  if (migrationComplete(database)) return [];
  const scanned = scanLegacyAnalyses(paths);
  return database.transaction(() => {
    if (migrationComplete(database)) return [];
    for (const record of scanned.records) insertAnalysis(database, prepareAnalysis(record));
    database.prepare("INSERT INTO store_migrations(name, completed_at_ms) VALUES (?, ?)")
      .run(LEGACY_ANALYSES_MIGRATION, Date.now());
    return scanned.warnings;
  }).immediate();
}
function parseSnapshot(recordJson: string, snapshotId: string,
  executionId: string, executedAtMs: number): {
    identity: AnalysisHistoryEntry["identity"];
    record: AnalysisRecord;
  } {
  const value = JSON.parse(recordJson) as unknown;
  if (!isObjectRecord(value) || value.schema_version !== 1 ||
    !isObjectRecord(value.payload) || "analysis_id" in value.payload ||
    "created_at_ms" in value.payload || !isObjectRecord(value.identity) ||
    canonicalJson(value) !== recordJson ||
    analysisDigest("analysis-snapshot-v1", value) !== snapshotId) {
    throw new TypeError("unsupported or invalid analysis snapshot");
  }
  let identity: AnalysisHistoryEntry["identity"];
  if (value.identity.mode === "content-fallback") {
    if (Object.keys(value.identity).length !== 1) throw new TypeError("invalid fallback identity");
    identity = { mode: "content-fallback" };
  } else {
    const normalized = normalizeSnapshotIdentity(value.identity as unknown as AnalysisSnapshotIdentity);
    if (canonicalJson(normalized) !== canonicalJson(value.identity))
      throw new TypeError("non-canonical snapshot identity");
    identity = normalized;
  }
  const record = { ...value.payload, analysis_id: executionId, created_at_ms: executedAtMs };
  if (!isRecord(record)) throw new TypeError("unsupported or invalid analysis record");
  return { identity, record: normalizeRecordFindings(record) };
}

export async function loadAnalyses(paths: StorePaths): Promise<AnalysisHistoryResult> {
  const warnings: StoreWarning[] = [];
  let database: StoreDatabase | undefined;
  try {
    database = openStoreDatabase(paths);
    try { warnings.push(...migrateLegacyAnalyses(database, paths)); }
    catch (error) { warnings.push(migrationWarning("history_read_failed",
      `Analysis history could not be migrated: ${errorMessage(error)}`, paths.analyses_dir)); }
    const rows = database.prepare(`SELECT s.snapshot_id, s.record_json,
      e.execution_id, e.executed_at_ms FROM analysis_snapshots s
      JOIN analysis_executions e ON e.rowid =
        (SELECT oldest.rowid FROM analysis_executions oldest
          WHERE oldest.snapshot_id = s.snapshot_id
          ORDER BY oldest.executed_at_ms, oldest.execution_id LIMIT 1)
      ORDER BY e.executed_at_ms, e.execution_id`).all() as {
        snapshot_id: string; record_json: string; execution_id: string; executed_at_ms: number }[];
    const records: AnalysisRecord[] = [];
    const entries: AnalysisHistoryEntry[] = [];
    for (const row of rows) {
      try {
        const parsed = parseSnapshot(row.record_json, row.snapshot_id,
          row.execution_id, row.executed_at_ms);
        const record = parsed.record;
        const storedBudget = readBudgetRow(database, row.execution_id);
        if (record.analysis_budget === undefined) {
          if (storedBudget !== undefined) {
            throw new TypeError("analysis budget mirror does not match snapshot");
          }
        } else {
          if (storedBudget === undefined || canonicalJson(record.analysis_budget) !==
            canonicalJson(budgetResultFromRow(storedBudget))) {
            throw new TypeError("analysis budget mirror does not match snapshot");
          }
        }
        records.push(record);
        entries.push({
          snapshot_id: row.snapshot_id,
          identity: parsed.identity,
          record,
        });
      }
      catch (error) { warnings.push(migrationWarning("corrupt_analysis_record",
        `Analysis snapshot was skipped: ${errorMessage(error)}`,
        `${storeDatabasePath(paths)}#analysis_snapshots/${row.snapshot_id}`)); }
    }
    return {
      records: records.sort(recordOrder),
      entries: entries.sort((left, right) => recordOrder(left.record, right.record)),
      warnings,
    };
  } catch (error) {
    return { records: [], entries: [], warnings: [...warnings, migrationWarning("history_read_failed",
      `Analysis history could not be read: ${errorMessage(error)}`, storeDatabasePath(paths))] };
  } finally { closeDatabase(database); }
}

export async function saveAnalysis(
  paths: StorePaths,
  input: AnalysisRecord | AnalysisRecordInput,
  options: AnalysisSaveOptions = {},
): Promise<AnalysisSaveResult> {
  const record = asRecord(input);
  const snapshot = captureSnapshotOption(options);
  const prepared = prepareAnalysis(record, snapshot);
  const audit = auditIdentity(prepared);
  const warnings: StoreWarning[] = [];
  const targetPath = storeDatabasePath(paths);
  let database: StoreDatabase | undefined;
  try {
    database = openStoreDatabase(paths);
    warnings.push(...migrateLegacyAnalyses(database, paths));
    database.transaction(() => insertAnalysis(database as StoreDatabase, prepared)).immediate();
  } catch (error) {
    warnings.push({
      code: error instanceof StoreConflict ? error.code : "analysis_write_failed",
      message: `Analysis could not be persisted: ${errorMessage(error)}`,
      path: targetPath,
    });
  } finally { closeDatabase(database); }
  return { record, audit_identity: audit, warnings };
}

function roundedMetric(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function computeBaseline(
  current: StatsAggregationInput["baseline_metrics"],
  history: readonly StatsAggregationInput[],
  mode: CohortEvaluationMode,
  minimumCohortSize = DEFAULT_MINIMUM_COHORT_SIZE,
): BaselineComparison | null {
  if (
    !Number.isSafeInteger(minimumCohortSize) ||
    minimumCohortSize < MINIMUM_COHORT_SIZE ||
    minimumCohortSize > MAXIMUM_COHORT_SIZE
  ) {
    throw new TypeError("invalid minimum cohort size");
  }
  const prior = selectComparableTerminalSnapshots(history, mode);
  if (prior.length < minimumCohortSize) return null;

  const notable = [...current]
    .sort((left, right) => left.metric.localeCompare(right.metric))
    .flatMap(({ metric, value }) => {
      if (!Number.isFinite(value)) return [];
      const historical = prior.flatMap((record) => {
        const entry = record.baseline_metrics.find((candidate) =>
          candidate.metric === metric)?.value;
        return entry !== undefined && Number.isFinite(entry) ? [entry] : [];
      });
      if (historical.length < minimumCohortSize) return [];
      const distribution = cohortDistribution(historical);
      return [{
        metric,
        value: roundedMetric(value),
        baseline: distribution.median,
        ...distribution,
      }];
    });
  return { prs: prior.length, notable };
}
