/**
 * Shared data contracts for the deterministic analysis pipeline.
 *
 * Timestamp fields use integer Unix epoch milliseconds. Fields ending in
 * `_path` are absolute; fields named `paths` are repository-relative unless
 * the producing source cannot determine the repository root.
 */

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Confidence = "low" | "medium" | "high";
export type Bound = "point" | "upper";
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

export interface ToolResultEvent extends NormalizedEventBase {
  kind: "tool_result";
  tool_use_id: string;
  status: ToolResultStatus;
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
}

export interface Interval {
  start_ms: number;
  end_ms: number;
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
  tool_use_id?: string;
  tool_name?: string;
  command?: string;
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

export interface ReportV2 {
  version: 2;
  unit: AnalysisUnit;
  summary: AnalysisSummary;
  findings: Finding[];
  caveats: string[];
}

export function makeSessionRef(
  sessionId: string,
  entryUuid: string,
): string {
  return `${sessionId}#${entryUuid}`;
}
