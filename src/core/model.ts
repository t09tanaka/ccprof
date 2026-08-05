/**
 * Shared data contracts for the deterministic analysis pipeline.
 *
 * Timestamp fields use integer Unix epoch milliseconds. Fields ending in
 * `_path` are absolute; fields named `paths` are repository-relative unless
 * the producing source cannot determine the repository root.
 */

import { types as utilTypes } from "node:util";

import type { EventIdentity } from "./event-identity.js";
import type { ProducerId } from "./source-identity.js";
import type { SourceDescriptor } from "./source-descriptor.js";
import type { AnalysisBudgetResult } from "../analysis/budgets.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Confidence = "low" | "medium" | "high";
export type Bound = "point" | "upper";
export interface ImpactEstimate {
  lower_ms: number;
  expected_ms?: number;
  upper_ms: number;
  kind: "critical_path_latency" | "resource_cost";
}
export interface FindingConfidence {
  evidence: "low" | "medium" | "high";
  causal: "low" | "medium" | "high";
  source_completeness: number;
}
export type FindingSeverity = "info" | "low" | "medium" | "high";
export const FINDING_SCORING_RATIONALE_ORDER = [
  "observed_lower_bound",
  "estimated_upper_only",
  "resource_cost_only",
  "policy_dependent",
  "partial_source",
  "legacy_projection",
] as const;
export type FindingScoringRationale =
  (typeof FINDING_SCORING_RATIONALE_ORDER)[number];
export type CommandExecutor = "shell" | "native-tool";
export interface CommandIdentity {
  repo_relative_cwd: string;
  normalized_argv: string[];
  executor: CommandExecutor;
}
export type Classification = "repo" | "config" | "behavior";
export type Scope = "this_pr" | "separate_issue" | "claude_md";
export type RuleId =
  | "R001"
  | "R002"
  | "R003"
  | "R004"
  | "R005"
  | "R006"
  | "R007"
  | "R008";
export type R001Cause =
  | "ambiguous_task"
  | "requirements_changed"
  | "missing_context"
  | "scope_creep"
  | "tool_failure"
  | "unknown";

/**
 * Data a session source can supply. New SessionSource adapters are normalized
 * to an explicit list before analysis. `undefined` remains accepted only for
 * legacy sessions and means all capabilities. A narrower list keeps rules
 * that structurally depend on unavailable evidence from misfiring.
 */
export type SessionCapability =
  | "tool_timestamps"
  | "token_usage"
  | "sidechains"
  | "branch_rows"
  | "edit_fragments"
  | "approvals";

export const ALL_SESSION_CAPABILITIES: readonly SessionCapability[] = [
  "tool_timestamps",
  "token_usage",
  "sidechains",
  "branch_rows",
  "edit_fragments",
  "approvals",
];

export interface SourceWarning {
  code: string;
  message: string;
  source_path: string;
  line?: number;
  session_ref?: string;
}

interface NormalizedEventBase {
  timestamp_ms: number;
  session_id: string;
  entry_uuid: string;
  session_ref: string;
  source_index: number;
  agent_id: string;
  is_sidechain: boolean;
  confidence: Confidence;
  /** Analysis-only identity added after a Session establishes source context. */
  event_identity?: EventIdentity;
  parent_uuid?: string;
  /** Git branch recorded on the source row, when the log provided one. */
  branch?: string;
  /**
   * Monotonic counter that advances whenever the effective branch changes in
   * source order, including on rows that emit no events. Two events on the
   * same branch but different epochs are separated by a branch departure.
   */
  branch_epoch?: number;
}

export interface GenuineUserEvent extends NormalizedEventBase {
  kind: "genuine_user";
  text: string;
}

export interface AssistantEvent extends NormalizedEventBase {
  kind: "assistant";
  text: string;
  message_id?: string;
  input_tokens?: number;
  output_tokens?: number;
}

export interface ApprovalRequest {
  required: boolean;
  reason?: string;
}

export interface ToolUseEvent extends NormalizedEventBase {
  kind: "tool_use";
  tool_use_id: string;
  tool_name: string;
  input: JsonObject;
  paths: string[];
  edit_fragments: string[];
  command?: string;
  cwd?: string;
  approval?: ApprovalRequest;
}

export type ToolResultStatus =
  | "success"
  | "failure"
  | "timeout"
  | "cancelled"
  | "unknown";

export type ResultStatusSource =
  | "explicit_status"
  | "exit_code"
  | "tool_adapter"
  | "output_pattern"
  | "none";

export interface ResultStatusEvidence {
  status: ToolResultStatus;
  source: ResultStatusSource;
  confidence: Confidence;
}

export interface ToolResultEvent extends NormalizedEventBase {
  kind: "tool_result";
  tool_use_id: string;
  status: ToolResultStatus;
  status_evidence?: ResultStatusEvidence;
  output: string;
  output_bytes: number;
  estimated_tokens: number;
  exit_code?: number;
}

export interface CompactionEvent extends NormalizedEventBase {
  kind: "compaction";
  summary: string;
  estimated_tokens?: number;
}

export type NormalizedEvent =
  | GenuineUserEvent
  | AssistantEvent
  | ToolUseEvent
  | ToolResultEvent
  | CompactionEvent;

export interface Session {
  session_id: string;
  source: ProducerId;
  source_path: string;
  observed_cwds: string[];
  observed_branches: string[];
  started_at_ms: number;
  ended_at_ms: number;
  confidence: Confidence;
  events: NormalizedEvent[];
  warnings: SourceWarning[];
  /**
   * Data capabilities this session's source can supply. New analyses always
   * set this explicitly; legacy `undefined` means full capabilities.
   */
  capabilities?: readonly SessionCapability[];
  /**
   * A hook-recorded (`Stop` event) wall-clock end time for this session,
   * set only when `applyHookEvents` extended `ended_at_ms` from an
   * in-window hook row. Distinct from `ended_at_ms` - which is always the
   * last observed event's log timestamp - so timeline building can tell
   * "the log's own last timestamp" from "a verified, hook-confirmed later
   * end" and only extend measured time for the latter. `undefined` means
   * no hook corroborated this session's end (every existing constructor
   * and test is unaffected).
   */
  verified_ended_at_ms?: number;
}

export interface Interval {
  start_ms: number;
  end_ms: number;
}

export interface AnalysisWindow {
  started_at_ms: number;
  ended_at_ms: number;
  start_source:
    | "explicit"
    | "branch_reflog"
    | "session_branch_transition"
    | "commit_anchor_lookback";
  end_source: "explicit" | "analysis_time";
  completeness: "complete" | "partial";
}

export type TimelineActionKind =
  | "tool"
  | "inference"
  | "human_wait"
  | "away";

export interface TimelineAction {
  action_id: string;
  kind: TimelineActionKind;
  interval: Interval;
  session_id: string;
  agent_id: string;
  session_refs: string[];
  confidence: Confidence;
  concurrent: boolean;
  paths: string[];
  /** Analysis-only identity of the event that starts this action. */
  event_identity?: EventIdentity;
  /** Analysis-only identity of the selected valid tool result, when present. */
  result_identity?: EventIdentity;
  tool_use_id?: string;
  tool_name?: string;
  command?: string;
  cwd?: string;
}

export type ActionMatch =
  | "contributing_edit"
  | "rework_edit"
  | "contributing_run"
  | "redundant_run"
  | "safe_read"
  | "duplicate_read"
  | "coordination"
  | "unexplained";

export interface MatchedAction extends TimelineAction {
  match: ActionMatch;
  match_confidence: Confidence;
  relevance_paths: string[];
  target: string;
  caveats: string[];
  normalized_command?: string;
  command_identity?: CommandIdentity;
}

export interface RecoverableInterval extends Interval {
  interval_id: string;
  target: string;
}

export interface RecoverableClaim {
  bound: Bound;
  estimated_ms: number;
  intervals: RecoverableInterval[];
}

export interface FindingEvidence extends JsonObject {
  session_refs: string[];
  interval_ids: string[];
}

export interface FixRecipe {
  suggestion: string;
  verify: string;
}

interface FindingMetadata {
  finding_key: string;
  rule_id: RuleId;
  title: string;
  classification: Classification;
  cause: R001Cause | null;
  scope: Scope;
  confidence: Confidence;
  evidence: FindingEvidence;
  fix_recipe: FixRecipe;
  caveats: string[];
}

export interface FindingCandidate extends FindingMetadata {
  target: string;
  recoverable: RecoverableClaim;
  impact: ImpactEstimate;
  finding_confidence: FindingConfidence;
  severity: FindingSeverity;
  scoring_rationale: FindingScoringRationale[];
}

export interface FindingRecoverable {
  min: number;
  bound: Bound;
}

export interface Finding extends FindingMetadata {
  target?: string;
  recoverable: FindingRecoverable;
  /** Present on every newly produced finding; optional only for v2 input. */
  impact?: ImpactEstimate;
  /** Present on every newly produced finding; optional only for v2 input. */
  finding_confidence?: FindingConfidence;
  /** Present on every newly produced finding; optional only for v2 input. */
  severity?: FindingSeverity;
  /** Present on every newly produced finding; optional only for v2 input. */
  scoring_rationale?: FindingScoringRationale[];
  rule_version?: string;
  compatibility_epoch?: number;
}

const FINDING_CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

function validNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    !Object.is(value, -0);
}

function exactDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  message: string,
): Record<string, unknown> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new TypeError();
    }
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))
    ) {
      throw new TypeError();
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw new TypeError();
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    throw new TypeError(message);
  }
}

export function snapshotImpactEstimate(value: unknown): ImpactEstimate {
  try {
    const snapshot = exactDataObject(
      value,
      ["lower_ms", "upper_ms", "kind"],
      ["expected_ms"],
      "invalid impact estimate",
    );
    const lower = snapshot.lower_ms;
    const upper = snapshot.upper_ms;
    const expected = snapshot.expected_ms;
    const kind = snapshot.kind;
    if (
      !validNonnegativeNumber(lower) ||
      !validNonnegativeNumber(upper) ||
      lower > upper ||
      (kind !== "critical_path_latency" && kind !== "resource_cost")
    ) {
      throw new TypeError();
    }
    let expectedValue: number | undefined;
    if ("expected_ms" in snapshot) {
      if (
        !validNonnegativeNumber(expected) ||
        expected < lower ||
        expected > upper
      ) throw new TypeError();
      expectedValue = expected;
    }
    return {
      lower_ms: lower,
      ...(expectedValue === undefined ? {} : { expected_ms: expectedValue }),
      upper_ms: upper,
      kind,
    };
  } catch {
    throw new TypeError("invalid impact estimate");
  }
}

export function snapshotFindingConfidence(value: unknown): FindingConfidence {
  try {
    const snapshot = exactDataObject(
      value,
      ["evidence", "causal", "source_completeness"],
      [],
      "invalid finding confidence",
    );
    const evidence = snapshot.evidence;
    const causal = snapshot.causal;
    const completeness = snapshot.source_completeness;
    if (
      (evidence !== "low" && evidence !== "medium" && evidence !== "high") ||
      (causal !== "low" && causal !== "medium" && causal !== "high") ||
      !validNonnegativeNumber(completeness) ||
      completeness > 1
    ) {
      throw new TypeError();
    }
    return {
      evidence,
      causal,
      source_completeness: completeness,
    };
  } catch {
    throw new TypeError("invalid finding confidence");
  }
}

export function projectFindingConfidence(value: FindingConfidence): Confidence {
  const confidence = snapshotFindingConfidence(value);
  const completeness: Confidence = confidence.source_completeness === 1
    ? "high"
    : confidence.source_completeness === 0
      ? "low"
      : "medium";
  return [confidence.evidence, confidence.causal, completeness]
    .reduce<Confidence>((minimum, entry) =>
      FINDING_CONFIDENCE_RANK[entry] < FINDING_CONFIDENCE_RANK[minimum]
        ? entry
        : minimum, "high");
}

export function projectFindingRecoverable(
  value: ImpactEstimate,
): FindingRecoverable {
  const impact = snapshotImpactEstimate(value);
  return {
    min: impact.upper_ms / 60_000,
    bound: impact.lower_ms === impact.upper_ms ? "point" : "upper",
  };
}

export function isStrictHighConfidence(value: FindingConfidence): boolean {
  const confidence = snapshotFindingConfidence(value);
  return confidence.evidence === "high" && confidence.causal === "high" &&
    confidence.source_completeness === 1;
}

export function findingSeverity(
  impactValue: ImpactEstimate,
  confidenceValue: FindingConfidence,
): FindingSeverity {
  const impact = snapshotImpactEstimate(impactValue);
  const confidence = snapshotFindingConfidence(confidenceValue);
  if (impact.upper_ms === 0) return "info";
  if (
    impact.kind === "critical_path_latency" &&
    impact.lower_ms > 0 &&
    isStrictHighConfidence(confidence)
  ) return "high";
  if (
    FINDING_CONFIDENCE_RANK[confidence.evidence] >=
        FINDING_CONFIDENCE_RANK.medium &&
    FINDING_CONFIDENCE_RANK[confidence.causal] >=
        FINDING_CONFIDENCE_RANK.medium &&
    confidence.source_completeness > 0
  ) return "medium";
  return "low";
}

export function findingScoringRationale(
  impactValue: ImpactEstimate,
  confidenceValue: FindingConfidence,
  options: {
    policy_dependent?: boolean;
    legacy_projection?: boolean;
  } = {},
): FindingScoringRationale[] {
  const impact = snapshotImpactEstimate(impactValue);
  const confidence = snapshotFindingConfidence(confidenceValue);
  return [
    ...(impact.lower_ms > 0
      ? ["observed_lower_bound" as const]
      : impact.upper_ms > 0
        ? ["estimated_upper_only" as const]
        : []),
    ...(impact.kind === "resource_cost" ? ["resource_cost_only" as const] : []),
    ...(options.policy_dependent === true ? ["policy_dependent" as const] : []),
    ...(confidence.source_completeness < 1 ? ["partial_source" as const] : []),
    ...(options.legacy_projection === true ? ["legacy_projection" as const] : []),
  ];
}

export function findingCompatibilityMetadata(value: unknown):
  | { valid: true; metadata?: { rule_version: string; compatibility_epoch: number } }
  | { valid: false } {
  if (value === null || typeof value !== "object") return { valid: false };
  let versionDescriptor: PropertyDescriptor | undefined;
  let epochDescriptor: PropertyDescriptor | undefined;
  try {
    versionDescriptor = Object.getOwnPropertyDescriptor(value, "rule_version");
    epochDescriptor = Object.getOwnPropertyDescriptor(value, "compatibility_epoch");
  } catch {
    return { valid: false };
  }
  if ((versionDescriptor === undefined) !== (epochDescriptor === undefined)) {
    return { valid: false };
  }
  if (versionDescriptor === undefined || epochDescriptor === undefined) {
    return { valid: true };
  }
  if (!("value" in versionDescriptor) || !("value" in epochDescriptor)) {
    return { valid: false };
  }
  const ruleVersion = versionDescriptor.value;
  const compatibilityEpoch = epochDescriptor.value;
  if (
    typeof ruleVersion !== "string" ||
    typeof compatibilityEpoch !== "number" ||
    !Number.isSafeInteger(compatibilityEpoch) ||
    compatibilityEpoch <= 0
  ) return { valid: false };
  const match = /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
    .exec(ruleVersion);
  if (
    match === null || match[0] !== ruleVersion ||
    match[1] !== String(compatibilityEpoch)
  ) return { valid: false };
  return {
    valid: true,
    metadata: { rule_version: ruleVersion, compatibility_epoch: compatibilityEpoch },
  };
}

export function hasValidFindingCompatibilityMetadata(value: unknown): boolean {
  return findingCompatibilityMetadata(value).valid;
}

export interface BaselineNotable {
  metric: string;
  value: number;
  baseline: number;
  median?: number;
  p50?: number;
  p75?: number;
  mad?: number;
  sample_count?: number;
}

export interface BaselineComparison {
  prs: number;
  notable: BaselineNotable[];
}

export interface AnalysisSummary {
  measured_min: number;
  idle_excluded_min: number;
  estimated_floor_min: number;
  recoverable_min: number;
  human_wait_min: number;
  unexplained_min: number;
  baseline: BaselineComparison | null;
}

export interface AnalysisUnit {
  repo: string;
  pr_ref: string;
  sessions: string[];
}

export interface SkippedRule {
  rule_id: RuleId;
  missing: SessionCapability[];
}

export interface RuleCoverage {
  rule_id: RuleId;
  eligible_sessions: number;
  total_sessions: number;
  status: "full" | "partial";
  missing_capabilities: SessionCapability[];
  completeness: number;
  truncated: boolean;
}

export interface ReportV2 {
  version: 2;
  unit: AnalysisUnit;
  /** Additive run-wide budget facts; absent when no budget was supplied. */
  analysis_budget?: AnalysisBudgetResult;
  /**
   * Validated, privacy-safe descriptors for source instances used by this
   * analysis. Additive so older stored and constructed v2 reports remain
   * readable when the field is absent.
   */
  sources?: SourceDescriptor[];
  summary: AnalysisSummary;
  findings: Finding[];
  caveats: string[];
  /** Deterministic per-rule source eligibility; absent on legacy v2 reports. */
  rule_coverage?: RuleCoverage[];
  /**
   * Rules that were not evaluated because no session supplies every
   * capability the rule structurally depends on. Additive and omitted when
   * empty so legacy reports remain readable.
   */
  skipped_rules?: SkippedRule[];
}

export function makeSessionRef(
  sessionId: string,
  entryUuid: string,
): string {
  return `${sessionId}#${entryUuid}`;
}
