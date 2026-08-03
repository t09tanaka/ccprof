/**
 * Shared data contracts for the deterministic analysis pipeline.
 *
 * Timestamp fields use integer Unix epoch milliseconds. Fields ending in
 * `_path` are absolute; fields named `paths` are repository-relative unless
 * the producing source cannot determine the repository root.
 */

import type { EventIdentity } from "./event-identity.js";
import type { SourceDescriptor } from "./source-descriptor.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Confidence = "low" | "medium" | "high";
export type Bound = "point" | "upper";
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
 * Optional data a session source can supply. `undefined` on `Session.capabilities`
 * means "all of them" (full capabilities), matching existing single-source
 * (Claude) behavior exactly. A source that cannot provide a capability (for
 * example, Codex rollout logs lacking per-message token usage) declares a
 * narrower list so rules that structurally depend on it can be skipped
 * instead of misfiring.
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
  source: "claude" | "codex";
  source_path: string;
  observed_cwds: string[];
  observed_branches: string[];
  started_at_ms: number;
  ended_at_ms: number;
  confidence: Confidence;
  events: NormalizedEvent[];
  warnings: SourceWarning[];
  /**
   * Data capabilities this session's source can supply. `undefined` means
   * full capabilities (every existing constructor and test is unaffected).
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
}

export interface FindingRecoverable {
  min: number;
  bound: Bound;
}

export interface Finding extends FindingMetadata {
  target?: string;
  recoverable: FindingRecoverable;
}

export interface BaselineNotable {
  metric: string;
  value: number;
  baseline: number;
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
