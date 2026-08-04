import { open as openFile, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";

import {
  makeSessionRef,
  type AssistantEvent,
  type CompactionEvent,
  type Confidence,
  type JsonObject,
  type JsonValue,
  type NormalizedEvent,
  type ResultStatusEvidence,
  type Session,
  type SourceWarning,
  type ToolResultEvent,
  type ToolResultStatus,
  type ToolUseEvent,
} from "../../core/model.js";
import {
  boundedJsonlLines,
  boundedWarnings,
  budgetWarningCode,
  canonicalJsonBytes,
  canonicalJsonStringBytes,
  IncrementalParserStateCapacityError,
  IncrementalParserStateByteTracker,
  jsonlLinePhysicalRange,
  JsonlBudgetTracker,
  ParserBudgetExceededError,
  type JsonlParserControls,
  type ParserProjectionBudgets,
  type ParserReadBudgets,
  type ParserStateReadResult,
  type ParserStateRowBaseV1,
  type ParserStateWarningV1,
  type SourceReadReceipt,
} from "../jsonl-budget.js";

export {
  IncrementalParserStateCapacityError,
  MAX_INCREMENTAL_PARSER_STATE_BYTES,
  PARSER_STATE_SCHEMA_FINGERPRINT,
} from "../jsonl-budget.js";

export const CLAUDE_PARSER_VERSION = "2.0.0";

export const MAX_TOOL_OUTPUT_BYTES = 16_384;
/** Maximum UTF-8 bytes retained for any non-path/command tool-input string. */
export const MAX_TOOL_INPUT_FRAGMENT_BYTES = 4_096;

const OUTPUT_TRUNCATION_SUFFIX = "\n[output truncated]";
const INPUT_TRUNCATION_SUFFIX = "\n[input truncated]";
const CONTENT_TYPE_TRUNCATION_SUFFIX = "\n[content type truncated]";
const MAX_CONTENT_BLOCK_TYPE_BYTES = 256;
const PRESERVED_TOOL_INPUT_KEYS = new Set([
  "command",
  "cwd",
  "file_path",
  "notebook_path",
  "path",
]);
/**
 * Row-level types Claude Code emits for bookkeeping/auxiliary purposes that
 * never contribute to timeline reconstruction. These are recognized so we
 * can skip the invalid_timestamp / missing_entry_uuid warnings they'd
 * otherwise flood a report with, without changing whether they're ingested.
 */
const KNOWN_AUXILIARY_ROW_TYPES = new Set([
  "attachment",
  "queue-operation",
  "last-prompt",
  "custom-title",
  "pr-link",
  "ai-title",
  "bridge-session",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "summary",
  "progress",
]);

type UnknownRecord = Record<string, unknown>;

interface IngestedToolResult {
  toolUseId?: string;
  statusEvidence: ResultStatusEvidence;
  output: string;
  outputBytes: number;
  estimatedTokens: number;
  hasUnknownSchema: boolean;
  exitCode?: number;
}

interface ParsedRow {
  value: UnknownRecord;
  toolResults: IngestedToolResult[];
  sessionId: string;
  timestampMs: number;
  entryUuid: string;
  hasSyntheticUuid: boolean;
  sourceIndex: number;
  line: number;
  cwd?: string;
  branch?: string;
  branchEpoch?: number;
  parentUuid?: string;
  agentId?: string;
  isSidechain: boolean;
}

export interface ClaudeStateToolResultV1 {
  tool_use_id: string | null;
  status_evidence: ResultStatusEvidence;
  output: string;
  output_bytes: number;
  estimated_tokens: number;
  has_unknown_schema: boolean;
  exit_code: number | null;
}

export interface ClaudeStateTextBlockV1 {
  type: "text";
  text?: string;
}

export interface ClaudeStateToolUseBlockV1 {
  type: "tool_use";
  id?: JsonValue;
  name?: JsonValue;
  input: JsonObject;
}

export interface ClaudeStateUnknownBlockV1 {
  type: string;
}

export type ClaudeStateAssistantBlockV1 =
  | ClaudeStateTextBlockV1
  | ClaudeStateToolUseBlockV1
  | ClaudeStateUnknownBlockV1
  | null;

export interface ClaudeStateAssistantValueV1 {
  type: "assistant";
  message: {
    id?: string;
    content: string | null | ClaudeStateAssistantBlockV1[];
    usage: { input_tokens?: number; output_tokens?: number };
  };
}

export interface ClaudeStateUserValueV1 {
  type: "user";
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message: { content: string | ClaudeStateTextBlockV1[] };
}

export interface ClaudeStateSystemValueV1 {
  type: "system";
  subtype?: string;
  content?: string;
  compactMetadata?: {
    preTokens?: number;
    estimatedTokens?: number;
    tokens?: number;
  };
}

export interface ClaudeStateAuxiliaryValueV1 {
  type: "auxiliary";
}

export type ClaudeStateRowValueV1 =
  | ClaudeStateAssistantValueV1
  | ClaudeStateUserValueV1
  | ClaudeStateSystemValueV1
  | ClaudeStateAuxiliaryValueV1;

export interface ClaudeStateRowV1 extends ParserStateRowBaseV1 {
  kind: "claude-row-v1";
  source_index: number;
  session_id: string;
  entry_uuid: string;
  has_synthetic_uuid: boolean;
  cwd: string | null;
  branch: string | null;
  parent_uuid: string | null;
  agent_id: string | null;
  is_sidechain: boolean;
  value: ClaudeStateRowValueV1;
  tool_results: ClaudeStateToolResultV1[];
}

export interface ClaudeBranchLaneV1 {
  session_id: string;
  lane_id: string;
  source_index: number;
  branch: string;
}

export interface ClaudeAncestryV1 {
  session_id: string;
  entry_uuid: string;
  parent_uuid: string;
  source_index: number;
  agent_id: string | null;
}

export interface ClaudeAssistantGroupV1 {
  session_id: string;
  message_id: string;
  source_indexes: number[];
}

export interface ClaudeResultPositionV1 {
  session_id: string;
  tool_use_id: string;
  source_index: number;
}

export interface ClaudeParserStateV1 {
  kind: "claude-state-v1";
  canonical_path: string;
  parsed_offset: number;
  line_count: number;
  ends_with_newline: boolean;
  rows: ClaudeStateRowV1[];
  branch_lanes: ClaudeBranchLaneV1[];
  ancestry: ClaudeAncestryV1[];
  assistant_groups: ClaudeAssistantGroupV1[];
  result_positions: ClaudeResultPositionV1[];
  warnings: ParserStateWarningV1[];
}

interface PendingWarning extends SourceWarning {
  targetSessionId?: string;
}

interface TextBlock {
  kind: "text";
  text: string;
  row: ParsedRow;
}

interface ToolBlock {
  kind: "tool";
  id: string;
  name: string;
  input: JsonObject;
  row: ParsedRow;
}

type LogicalBlock = TextBlock | ToolBlock;

interface AssistantRow {
  row: ParsedRow;
  messageId?: string;
  blocks: LogicalBlock[];
  hasSchemaLoss: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

interface OrderedEvent {
  event: NormalizedEvent;
  suborder: number;
}

export interface ClaudeTranscriptParseResult {
  sessions: Session[];
  warnings: SourceWarning[];
}

export interface ClaudeParserInstrumentation {
  onAgentAncestryStep?(): void;
  onAssistantPrefixProbe?(): void;
}

export interface ClaudeTranscriptParseOptions
  extends ClaudeParserInstrumentation, JsonlParserControls {
  endedAtMs?: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function truncateUtf8(
  value: string,
  maxBytes: number,
  suffixText: string,
): { value: string; originalBytes: number } {
  const bytes = Buffer.from(value);
  const originalBytes = bytes.byteLength;
  if (originalBytes <= maxBytes) {
    return { value, originalBytes };
  }
  const suffix = Buffer.from(suffixText);
  let prefixEnd = maxBytes - suffix.byteLength;
  while (
    prefixEnd > 0 &&
    ((bytes[prefixEnd] ?? 0) & 0b1100_0000) === 0b1000_0000
  ) {
    prefixEnd -= 1;
  }
  return {
    value: Buffer.concat([bytes.subarray(0, prefixEnd), suffix]).toString(
      "utf8",
    ),
    originalBytes,
  };
}

function toJsonValue(value: unknown, key?: string): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return PRESERVED_TOOL_INPUT_KEYS.has(key ?? "")
      ? value
      : truncateUtf8(
          value,
          MAX_TOOL_INPUT_FRAGMENT_BYTES,
          INPUT_TRUNCATION_SUFFIX,
        ).value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const converted = toJsonValue(item, key);
      if (converted !== undefined) {
        result.push(converted);
      }
    }
    return result;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const converted = toJsonValue(item, key);
    if (converted !== undefined) {
      result[key] = converted;
    }
  }
  return result;
}

function toJsonObject(value: unknown): JsonObject {
  const converted = toJsonValue(value);
  return isRecord(converted) ? converted : {};
}

interface ResultText {
  text: string;
  recognized: boolean;
}

function resultText(value: unknown): ResultText {
  if (typeof value === "string") {
    return { text: value, recognized: true };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { text: "", recognized: true };
    }
    const items = value.map((item) => resultText(item));
    return {
      text: items
        .map((item) => item.text)
        .filter((item) => item.length > 0)
        .join("\n"),
      recognized: items.every((item) => item.recognized),
    };
  }
  if (!isRecord(value)) {
    return { text: "", recognized: false };
  }

  const hasStdout = typeof value.stdout === "string";
  const hasStderr = typeof value.stderr === "string";
  if (hasStdout || hasStderr) {
    return {
      text: `${hasStdout ? value.stdout as string : ""}${hasStderr ? value.stderr as string : ""}`,
      recognized: true,
    };
  }
  if (value.type === "image" || value.type === "tool_reference") {
    return { text: "", recognized: true };
  }
  if (typeof value.text === "string") {
    return { text: value.text, recognized: true };
  }
  if (typeof value.output === "string") {
    return { text: value.output, recognized: true };
  }
  if ("content" in value) {
    return resultText(value.content);
  }
  if (isRecord(value.file) && "content" in value.file) {
    return resultText(value.file.content);
  }
  if (typeof value.message === "string") {
    return { text: value.message, recognized: true };
  }
  if (typeof value.error === "string") {
    return { text: value.error, recognized: true };
  }
  return { text: "", recognized: false };
}

function observedExitCode(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["exitCode", "exit_code"]) {
    const candidate = value[key];
    if (
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      Number.isFinite(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function explicitStatusCandidates(value: unknown): ToolResultStatus[] {
  if (!isRecord(value)) {
    return [];
  }
  const statuses: ToolResultStatus[] = [];
  const observedStatus = value.status;
  if (
    value.timedOut === true ||
    value.timed_out === true ||
    observedStatus === "timeout" ||
    observedStatus === "timed_out"
  ) {
    statuses.push("timeout");
  }
  if (
    value.cancelled === true ||
    observedStatus === "cancelled" ||
    observedStatus === "canceled"
  ) {
    statuses.push("cancelled");
  }
  if (
    value.is_error === true ||
    value.success === false ||
    ["failed", "failure", "error"].includes(
      typeof observedStatus === "string" ? observedStatus : "",
    )
  ) {
    statuses.push("failure");
  }
  if (
    value.is_error === false ||
    value.success === true ||
    observedStatus === "success"
  ) {
    statuses.push("success");
  }
  return statuses;
}

function adapterStatusCandidates(value: unknown): ToolResultStatus[] {
  if (!isRecord(value)) {
    return [];
  }
  const statuses: ToolResultStatus[] = [];
  if (value.interrupted === true) {
    statuses.push("cancelled");
  }
  if (value.interrupted === false || value.noOutputExpected === true) {
    statuses.push("success");
  }
  if (
    ["async_launched", "completed", "forked", "teammate_spawned"].includes(
      typeof value.status === "string" ? value.status : "",
    )
  ) {
    statuses.push("success");
  }
  return statuses;
}

function structuredResultId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return (
    nonEmptyString(value.tool_use_id) ??
    nonEmptyString(value.toolUseId)
  );
}

function matchedStructuredResult(
  container: unknown,
  toolUseId: string,
): unknown {
  if (Array.isArray(container)) {
    const matches = container.filter(
      (candidate) => structuredResultId(candidate) === toolUseId,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (!isRecord(container)) {
    return undefined;
  }
  const directId = structuredResultId(container);
  if (directId !== undefined) {
    return directId === toolUseId ? container : undefined;
  }
  if (Object.hasOwn(container, toolUseId)) {
    return container[toolUseId];
  }
  return undefined;
}

function structuredResultForTool(
  structuredResult: unknown,
  toolUseId: string | undefined,
  resultCount: number,
): unknown {
  if (resultCount === 1) {
    return structuredResult;
  }
  if (toolUseId === undefined) {
    return undefined;
  }
  const direct = matchedStructuredResult(structuredResult, toolUseId);
  if (direct !== undefined) {
    return direct;
  }
  if (!isRecord(structuredResult)) {
    return undefined;
  }
  for (const key of ["results", "tool_results", "toolResults"]) {
    const matched = matchedStructuredResult(structuredResult[key], toolUseId);
    if (matched !== undefined) {
      return matched;
    }
  }
  return undefined;
}

function classifyResultStatus(
  block: UnknownRecord,
  structuredResult: unknown,
  visibleExitCode: number | undefined,
  structuredExitCode: number | undefined,
): [ResultStatusEvidence, boolean] {
  const explicitStatuses = new Set([
    ...explicitStatusCandidates(block),
    ...explicitStatusCandidates(structuredResult),
  ]);
  if (explicitStatuses.size > 0) {
    if (explicitStatuses.has("timeout")) {
      return [{ status: "timeout", source: "explicit_status", confidence: "high" }, true];
    }
    if (explicitStatuses.has("cancelled")) {
      return [{ status: "cancelled", source: "explicit_status", confidence: "high" }, true];
    }
    if (explicitStatuses.has("failure") && explicitStatuses.has("success")) {
      return [{ status: "unknown", source: "explicit_status", confidence: "low" }, true];
    }
    const status = explicitStatuses.has("failure") ? "failure" : "success";
    return [{ status, source: "explicit_status", confidence: "high" }, true];
  }
  const groups = [
    {
      statuses: [visibleExitCode, structuredExitCode]
        .filter((code): code is number => code !== undefined)
        .map(
          (code): ToolResultStatus => code === 0 ? "success" : "failure",
        ),
      source: "exit_code" as const,
      confidence: "high" as const,
    },
    {
      statuses: [
        ...adapterStatusCandidates(block),
        ...adapterStatusCandidates(structuredResult),
      ],
      source: "tool_adapter" as const,
      confidence: "medium" as const,
    },
  ];
  for (const group of groups) {
    const statuses = new Set(group.statuses);
    if (statuses.size === 1) {
      return [{
        status: [...statuses][0]!,
        source: group.source,
        confidence: group.confidence,
      }, true];
    }
    if (statuses.size > 1) {
      return [{ status: "unknown", source: group.source, confidence: "low" }, true];
    }
  }
  return [{ status: "unknown", source: "none", confidence: "low" }, false];
}

function boundedOutput(
  value: string,
): { output: string; outputBytes: number; estimatedTokens: number } {
  const truncated = truncateUtf8(
    value,
    MAX_TOOL_OUTPUT_BYTES,
    OUTPUT_TRUNCATION_SUFFIX,
  );
  return {
    output: truncated.value,
    outputBytes: truncated.originalBytes,
    estimatedTokens: Math.ceil(truncated.originalBytes / 4),
  };
}

function ingestToolResults(parsed: UnknownRecord): IngestedToolResult[] {
  const message = isRecord(parsed.message) ? parsed.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const resultBlocks = content.filter(
    (item): item is UnknownRecord =>
      isRecord(item) && item.type === "tool_result",
  );
  const structuredResult = parsed.toolUseResult;
  const results: IngestedToolResult[] = [];

  for (const item of resultBlocks) {
    const toolUseId = nonEmptyString(item.tool_use_id);
    const supplementalResult = structuredResultForTool(
      structuredResult,
      toolUseId,
      resultBlocks.length,
    );
    const visibleText = resultText(item.content);
    const structuredText = resultText(supplementalResult);
    const visibleExitCode = observedExitCode(item);
    const structuredExitCode = observedExitCode(supplementalResult);
    const [statusEvidence, hasStatusSchema] = classifyResultStatus(
      item,
      supplementalResult,
      visibleExitCode,
      structuredExitCode,
    );
    const selectedText = visibleText.recognized
      ? visibleText.text
      : structuredText.text;
    const bounded = boundedOutput(selectedText);
    const exitCode = visibleExitCode ?? structuredExitCode;
    results.push({
      statusEvidence,
      output: bounded.output,
      outputBytes: bounded.outputBytes,
      estimatedTokens: bounded.estimatedTokens,
      hasUnknownSchema:
        !hasStatusSchema && !visibleText.recognized && !structuredText.recognized,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
  }
  return results;
}

interface CompactedContent {
  value: JsonValue;
  discardedPayload: boolean;
  discardedPayloadBytes: number;
}

interface CompactedRowValue {
  value: ClaudeStateRowValueV1;
  discardedPayload: boolean;
  discardedPayloadBytes: number;
}

function stringPayloadBytes(value: unknown): number {
  let bytes = 0;
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
    } else if (Array.isArray(item)) {
      for (const child of item) {
        pending.push(child);
      }
    } else if (isRecord(item)) {
      for (const child of Object.values(item)) {
        pending.push(child);
      }
    }
  }
  return bytes;
}

function blockPayloadBytes(block: unknown): number {
  if (!isRecord(block)) {
    return stringPayloadBytes(block);
  }
  let bytes = 0;
  for (const [key, value] of Object.entries(block)) {
    if (key !== "type") {
      bytes += stringPayloadBytes(value);
    }
  }
  return bytes;
}

function compactContentBlockType(value: unknown): {
  value: string;
  discardedPayloadBytes: number;
} {
  if (typeof value === "string") {
    const compacted = truncateUtf8(
      value,
      MAX_CONTENT_BLOCK_TYPE_BYTES,
      CONTENT_TYPE_TRUNCATION_SUFFIX,
    );
    const wasTruncated =
      compacted.originalBytes > MAX_CONTENT_BLOCK_TYPE_BYTES;
    return {
      value: compacted.value,
      discardedPayloadBytes: wasTruncated ? compacted.originalBytes : 0,
    };
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return {
      value: String(value),
      discardedPayloadBytes: 0,
    };
  }
  if (value === undefined) {
    return {
      value: "[missing content type]",
      discardedPayloadBytes: 0,
    };
  }
  return {
    value: `[non-scalar content type: ${Array.isArray(value) ? "array" : typeof value}]`,
    discardedPayloadBytes: stringPayloadBytes(value),
  };
}

function compactAssistantContent(value: unknown): CompactedContent {
  if (typeof value === "string") {
    return {
      value,
      discardedPayload: false,
      discardedPayloadBytes: 0,
    };
  }
  if (!Array.isArray(value)) {
    return {
      value: null,
      discardedPayload: true,
      discardedPayloadBytes: stringPayloadBytes(value),
    };
  }
  let discardedPayload = false;
  let discardedPayloadBytes = 0;
  const compacted: JsonValue[] = [];
  for (const block of value) {
    if (!isRecord(block)) {
      discardedPayload = true;
      discardedPayloadBytes += blockPayloadBytes(block);
      compacted.push(null);
      continue;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      // Known reasoning content; intentionally omitted from the compacted
      // representation since it does not affect timeline reconstruction.
      continue;
    }
    if (block.type === "text") {
      compacted.push({
        type: "text",
        ...(typeof block.text === "string" ? { text: block.text } : {}),
      });
      continue;
    }
    if (block.type === "tool_use") {
      compacted.push({
        type: "tool_use",
        ...(typeof block.id === "string" ? { id: block.id } : {}),
        ...(typeof block.name === "string" ? { name: block.name } : {}),
        input: toJsonObject(block.input),
      });
      continue;
    }
    const compactedType = compactContentBlockType(block.type);
    discardedPayload = true;
    discardedPayloadBytes +=
      blockPayloadBytes(block) + compactedType.discardedPayloadBytes;
    compacted.push({ type: compactedType.value });
  }
  return {
    value: compacted,
    discardedPayload,
    discardedPayloadBytes,
  };
}

function compactUserContent(
  value: unknown,
  hasToolResults: boolean,
): CompactedContent {
  if (typeof value === "string" && !hasToolResults) {
    return {
      value,
      discardedPayload: false,
      discardedPayloadBytes: 0,
    };
  }
  if (!Array.isArray(value)) {
    return {
      value: [],
      discardedPayload: value !== undefined && typeof value !== "string",
      discardedPayloadBytes: stringPayloadBytes(value),
    };
  }

  const compacted: JsonValue[] = [];
  let discardedPayload = false;
  let discardedPayloadBytes = 0;
  for (const block of value) {
    if (isRecord(block) && block.type === "tool_result") {
      continue;
    }
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      if (!hasToolResults) {
        compacted.push({ type: "text", text: block.text });
      }
      continue;
    }
    discardedPayload = true;
    discardedPayloadBytes += blockPayloadBytes(block);
  }
  return {
    value: compacted,
    discardedPayload,
    discardedPayloadBytes,
  };
}

function compactRowValue(
  parsed: UnknownRecord,
  toolResults: IngestedToolResult[],
): CompactedRowValue {
  const type = parsed.type;
  if (type === "assistant") {
    const message = isRecord(parsed.message) ? parsed.message : {};
    const usage = isRecord(message.usage) ? message.usage : {};
    const content = compactAssistantContent(message.content);
    const inputTokens = finiteInteger(usage.input_tokens);
    const outputTokens = finiteInteger(usage.output_tokens);
    return {
      value: {
        type,
        message: {
          ...(typeof message.id === "string" ? { id: message.id } : {}),
          content: content.value as
            ClaudeStateAssistantValueV1["message"]["content"],
          usage: {
            ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
            ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
          },
        },
      },
      discardedPayload: content.discardedPayload,
      discardedPayloadBytes: content.discardedPayloadBytes,
    };
  }
  if (type === "user") {
    const message = isRecord(parsed.message) ? parsed.message : {};
    const content = compactUserContent(
      message.content,
      toolResults.length > 0,
    );
    return {
      value: {
        type,
        ...(typeof parsed.isMeta === "boolean" ? { isMeta: parsed.isMeta } : {}),
        ...(typeof parsed.isCompactSummary === "boolean"
          ? { isCompactSummary: parsed.isCompactSummary }
          : {}),
        message: {
          content: content.value as
            ClaudeStateUserValueV1["message"]["content"],
        },
      },
      discardedPayload: content.discardedPayload,
      discardedPayloadBytes: content.discardedPayloadBytes,
    };
  }
  if (type === "system") {
    const rawMetadata = isRecord(parsed.compactMetadata)
      ? parsed.compactMetadata
      : {};
    const preTokens = finiteInteger(rawMetadata.preTokens);
    const estimatedTokens = finiteInteger(rawMetadata.estimatedTokens);
    const tokens = finiteInteger(rawMetadata.tokens);
    const compactMetadata = {
      ...(preTokens === undefined ? {} : { preTokens }),
      ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
      ...(tokens === undefined ? {} : { tokens }),
    };
    return {
      value: {
        type,
        ...(typeof parsed.subtype === "string"
          ? { subtype: parsed.subtype }
          : {}),
        ...(parsed.content !== undefined
          ? { content: textContent(parsed.content) }
          : {}),
        ...(Object.keys(compactMetadata).length > 0
          ? { compactMetadata }
          : {}),
      },
      discardedPayload: false,
      discardedPayloadBytes: 0,
    };
  }
  return {
    value: { type: "auxiliary" },
    discardedPayload: false,
    discardedPayloadBytes: 0,
  };
}

function warning(
  sourcePath: string,
  code: string,
  message: string,
  options: {
    line?: number;
    row?: ParsedRow;
    sessionId?: string;
  } = {},
): PendingWarning {
  const row = options.row;
  const sessionId = options.sessionId ?? row?.sessionId;
  return {
    code,
    message,
    source_path: sourcePath,
    ...(options.line !== undefined ? { line: options.line } : {}),
    ...(row !== undefined
      ? { session_ref: makeSessionRef(row.sessionId, row.entryUuid) }
      : {}),
    ...(sessionId !== undefined ? { targetSessionId: sessionId } : {}),
  };
}

function parserBudgetWarning(
  sourcePath: string, error: ParserBudgetExceededError,
): PendingWarning {
  return warning(sourcePath, budgetWarningCode(error), error.message,
    error.line === undefined ? {} : { line: error.line });
}

function snapshotJson(
  value: unknown,
  capacity: IncrementalParserStateByteTracker,
  depth = 0,
): JsonValue {
  if (depth > 256) throw new TypeError("Parser state is too deeply nested.");
  if (value === null) {
    capacity.addBytes(4);
    return value;
  }
  if (typeof value === "string") {
    capacity.addBytes(canonicalJsonStringBytes(value));
    return value;
  }
  if (typeof value === "boolean") {
    capacity.addBytes(value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Invalid parser-state number.");
    capacity.addBytes(canonicalJsonBytes(value));
    return value;
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      keys.some((key) =>
        key !== "length" && (
          typeof key !== "string" ||
          !Number.isSafeInteger(Number(key)) ||
          Number(key) < 0 || Number(key) >= value.length ||
          Number(key).toString(10) !== key
        )
      )
    ) throw new TypeError("Parser-state arrays have invalid properties.");
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index.toString(10)];
      if (
        descriptor === undefined || !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError("Parser-state arrays must be dense data arrays.");
      }
    }
    capacity.addBytes(1);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) capacity.addBytes(1);
      result.push(snapshotJson(value[index], capacity, depth + 1));
    }
    capacity.addBytes(1);
    return result;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("Invalid parser-state value.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Parser-state objects must be plain objects.");
  }
  const result: JsonObject = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  capacity.addBytes(1);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (typeof key !== "string") {
      throw new TypeError("Parser-state symbol properties are forbidden.");
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError("Parser-state properties must be enumerable data fields.");
    }
    if (index > 0) capacity.addBytes(1);
    capacity.addBytes(canonicalJsonStringBytes(key) + 1);
    result[key] = snapshotJson(descriptor.value, capacity, depth + 1);
  }
  capacity.addBytes(1);
  return result;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw new TypeError("Parser state has an invalid field set.");
  }
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Parser-state integer is invalid.");
  }
  return value as number;
}

function stateInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("Parser-state integer is invalid.");
  }
  return value as number;
}

function stateString(value: unknown): string;
function stateString(value: unknown, nullable: true): string | null;
function stateString(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError("Parser-state text is invalid.");
  }
  return value;
}

function validateWarningFact(value: unknown, expectedOrder: number): void {
  if (!isRecord(value)) throw new TypeError("Invalid parser-state warning fact.");
  exactKeys(value, [
    "order", "applicability", "scope", "target_session_id", "warning",
  ]);
  if (nonnegativeInteger(value.order) !== expectedOrder) {
    throw new TypeError("Parser-state warning order is invalid.");
  }
  if (!isRecord(value.applicability)) {
    throw new TypeError("Invalid parser-state warning applicability.");
  }
  if (value.applicability.kind === "unconditional") {
    exactKeys(value.applicability, ["kind"]);
  } else if (value.applicability.kind === "timestamp") {
    exactKeys(value.applicability, ["kind", "timestamp_ms"]);
    nonnegativeInteger(value.applicability.timestamp_ms);
  } else {
    throw new TypeError("Unknown parser-state warning applicability.");
  }
  if (value.scope !== "source" && value.scope !== "session") {
    throw new TypeError("Invalid parser-state warning scope.");
  }
  stateString(value.target_session_id, true);
  if (!isRecord(value.warning)) throw new TypeError("Invalid source warning.");
  exactKeys(
    value.warning,
    ["code", "message", "source_path"],
    ["line", "session_ref"],
  );
  stateString(value.warning.code);
  stateString(value.warning.message);
  stateString(value.warning.source_path);
  if (value.warning.line !== undefined) nonnegativeInteger(value.warning.line);
  if (value.warning.session_ref !== undefined) stateString(value.warning.session_ref);
}

function validateClaudeAssistantBlock(value: unknown): void {
  if (value === null) return;
  if (!isRecord(value)) {
    throw new TypeError("Invalid Claude assistant state block.");
  }
  const type = stateString(value.type);
  if (type === "text") {
    exactKeys(value, ["type"], ["text"]);
    if (value.text !== undefined) stateString(value.text);
    return;
  }
  if (type === "tool_use") {
    exactKeys(value, ["type", "input"], ["id", "name"]);
    if (value.id !== undefined) stateString(value.id);
    if (value.name !== undefined) stateString(value.name);
    if (!isRecord(value.input)) {
      throw new TypeError("Invalid Claude state tool input.");
    }
    return;
  }
  exactKeys(value, ["type"]);
}

function validateClaudeRowValue(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Invalid Claude state row value.");
  if (value.type === "assistant") {
    exactKeys(value, ["type", "message"]);
    if (!isRecord(value.message)) {
      throw new TypeError("Invalid Claude assistant state message.");
    }
    exactKeys(value.message, ["content", "usage"], ["id"]);
    if (value.message.id !== undefined) stateString(value.message.id);
    const content = value.message.content;
    if (
      typeof content !== "string" && content !== null &&
      !Array.isArray(content)
    ) throw new TypeError("Invalid Claude assistant state content.");
    if (Array.isArray(content)) {
      for (const block of content) validateClaudeAssistantBlock(block);
    }
    if (!isRecord(value.message.usage)) {
      throw new TypeError("Invalid Claude assistant state usage.");
    }
    exactKeys(value.message.usage, [], ["input_tokens", "output_tokens"]);
    if (value.message.usage.input_tokens !== undefined) {
      nonnegativeInteger(value.message.usage.input_tokens);
    }
    if (value.message.usage.output_tokens !== undefined) {
      nonnegativeInteger(value.message.usage.output_tokens);
    }
    return;
  }
  if (value.type === "user") {
    exactKeys(value, ["type", "message"], ["isMeta", "isCompactSummary"]);
    if (value.isMeta !== undefined && typeof value.isMeta !== "boolean") {
      throw new TypeError("Invalid Claude state user marker.");
    }
    if (
      value.isCompactSummary !== undefined &&
      typeof value.isCompactSummary !== "boolean"
    ) throw new TypeError("Invalid Claude state compaction marker.");
    if (!isRecord(value.message)) {
      throw new TypeError("Invalid Claude user state message.");
    }
    exactKeys(value.message, ["content"]);
    const content = value.message.content;
    if (typeof content !== "string" && !Array.isArray(content)) {
      throw new TypeError("Invalid Claude user state content.");
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) {
          throw new TypeError("Invalid Claude user state block.");
        }
        exactKeys(block, ["type", "text"]);
        if (block.type !== "text") {
          throw new TypeError("Unknown Claude user state block.");
        }
        stateString(block.text);
      }
    }
    return;
  }
  if (value.type === "system") {
    exactKeys(value, ["type"], ["subtype", "content", "compactMetadata"]);
    if (value.subtype !== undefined) stateString(value.subtype);
    if (value.content !== undefined) stateString(value.content);
    if (value.compactMetadata !== undefined) {
      if (!isRecord(value.compactMetadata)) {
        throw new TypeError("Invalid Claude compact metadata.");
      }
      exactKeys(value.compactMetadata, [], [
        "preTokens", "estimatedTokens", "tokens",
      ]);
      for (const key of ["preTokens", "estimatedTokens", "tokens"] as const) {
        if (value.compactMetadata[key] !== undefined) {
          nonnegativeInteger(value.compactMetadata[key]);
        }
      }
    }
    return;
  }
  if (value.type === "auxiliary") {
    exactKeys(value, ["type"]);
    return;
  }
  throw new TypeError("Unknown Claude state row value.");
}

function validateClaudeToolResult(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Invalid Claude state tool result.");
  exactKeys(value, [
    "tool_use_id", "status_evidence", "output", "output_bytes",
    "estimated_tokens", "has_unknown_schema", "exit_code",
  ]);
  stateString(value.tool_use_id, true);
  stateString(value.output);
  nonnegativeInteger(value.output_bytes);
  nonnegativeInteger(value.estimated_tokens);
  if (typeof value.has_unknown_schema !== "boolean") {
    throw new TypeError("Invalid Claude state tool-result marker.");
  }
  if (value.exit_code !== null) stateInteger(value.exit_code);
  if (!isRecord(value.status_evidence)) {
    throw new TypeError("Invalid Claude state result evidence.");
  }
  exactKeys(value.status_evidence, ["status", "source", "confidence"]);
  if (!["success", "failure", "timeout", "cancelled", "unknown"].includes(
    stateString(value.status_evidence.status),
  )) throw new TypeError("Invalid Claude state result status.");
  if (![
    "explicit_status", "exit_code", "tool_adapter", "output_pattern", "none",
  ].includes(stateString(value.status_evidence.source))) {
    throw new TypeError("Invalid Claude state result source.");
  }
  if (!["low", "medium", "high"].includes(
    stateString(value.status_evidence.confidence),
  )) throw new TypeError("Invalid Claude state result confidence.");
}

function validateClaudeIndexes(
  value: UnknownRecord,
  rows: readonly ClaudeStateRowV1[],
): void {
  const branchLanes = value.branch_lanes;
  const ancestry = value.ancestry;
  const assistantGroups = value.assistant_groups;
  const resultPositions = value.result_positions;
  if (
    !Array.isArray(branchLanes) || !Array.isArray(ancestry) ||
    !Array.isArray(assistantGroups) || !Array.isArray(resultPositions)
  ) throw new TypeError("Invalid Claude parser-state index.");
  for (const item of branchLanes) {
    if (!isRecord(item)) throw new TypeError("Invalid Claude branch index.");
    exactKeys(item, ["session_id", "lane_id", "source_index", "branch"]);
    stateString(item.session_id); stateString(item.lane_id);
    nonnegativeInteger(item.source_index); stateString(item.branch);
  }
  for (const item of ancestry) {
    if (!isRecord(item)) throw new TypeError("Invalid Claude ancestry index.");
    exactKeys(item, [
      "session_id", "entry_uuid", "parent_uuid", "source_index", "agent_id",
    ]);
    stateString(item.session_id); stateString(item.entry_uuid);
    stateString(item.parent_uuid); nonnegativeInteger(item.source_index);
    stateString(item.agent_id, true);
  }
  for (const item of assistantGroups) {
    if (!isRecord(item)) {
      throw new TypeError("Invalid Claude assistant-group index.");
    }
    exactKeys(item, ["session_id", "message_id", "source_indexes"]);
    stateString(item.session_id); stateString(item.message_id);
    if (!Array.isArray(item.source_indexes)) {
      throw new TypeError("Invalid Claude assistant-group positions.");
    }
    for (const index of item.source_indexes) nonnegativeInteger(index);
  }
  for (const item of resultPositions) {
    if (!isRecord(item)) {
      throw new TypeError("Invalid Claude result-position index.");
    }
    exactKeys(item, ["session_id", "tool_use_id", "source_index"]);
    stateString(item.session_id); stateString(item.tool_use_id);
    nonnegativeInteger(item.source_index);
  }
  const expected = buildClaudeIndexes(rows);
  const sameBranchLanes = branchLanes.length === expected.branch_lanes.length &&
    branchLanes.every((item, index) => {
      const expectedItem = expected.branch_lanes[index]!;
      return item.session_id === expectedItem.session_id &&
        item.lane_id === expectedItem.lane_id &&
        item.source_index === expectedItem.source_index &&
        item.branch === expectedItem.branch;
    });
  const sameAncestry = ancestry.length === expected.ancestry.length &&
    ancestry.every((item, index) => {
      const expectedItem = expected.ancestry[index]!;
      return item.session_id === expectedItem.session_id &&
        item.entry_uuid === expectedItem.entry_uuid &&
        item.parent_uuid === expectedItem.parent_uuid &&
        item.source_index === expectedItem.source_index &&
        item.agent_id === expectedItem.agent_id;
    });
  const sameGroups = assistantGroups.length === expected.assistant_groups.length &&
    assistantGroups.every((item, index) => {
      const expectedItem = expected.assistant_groups[index]!;
      return item.session_id === expectedItem.session_id &&
        item.message_id === expectedItem.message_id &&
        Array.isArray(item.source_indexes) &&
        item.source_indexes.length === expectedItem.source_indexes.length &&
        item.source_indexes.every((
          sourceIndex: number,
          sourceOffset: number,
        ) =>
          sourceIndex === expectedItem.source_indexes[sourceOffset]
        );
    });
  const sameResults = resultPositions.length === expected.result_positions.length &&
    resultPositions.every((item, index) => {
      const expectedItem = expected.result_positions[index]!;
      return item.session_id === expectedItem.session_id &&
        item.tool_use_id === expectedItem.tool_use_id &&
        item.source_index === expectedItem.source_index;
    });
  if (!sameBranchLanes || !sameAncestry || !sameGroups || !sameResults) {
    throw new TypeError("Claude parser-state indexes are not canonical.");
  }
}

export function normalizeClaudeParserState(value: unknown): ClaudeParserStateV1 {
  const capacity = new IncrementalParserStateByteTracker();
  const cloned = snapshotJson(value, capacity);
  if (!isRecord(cloned)) throw new TypeError("Claude parser state must be an object.");
  exactKeys(cloned, [
    "kind", "canonical_path", "parsed_offset", "line_count",
    "ends_with_newline", "rows", "branch_lanes", "ancestry",
    "assistant_groups", "result_positions", "warnings",
  ]);
  if (cloned.kind !== "claude-state-v1") {
    throw new TypeError("Unknown Claude parser-state kind.");
  }
  stateString(cloned.canonical_path);
  const parsedOffset = nonnegativeInteger(cloned.parsed_offset);
  const lineCount = nonnegativeInteger(cloned.line_count);
  if (typeof cloned.ends_with_newline !== "boolean") {
    throw new TypeError("Invalid Claude newline state.");
  }
  if (
    !Array.isArray(cloned.rows) || !Array.isArray(cloned.branch_lanes) ||
    !Array.isArray(cloned.ancestry) ||
    !Array.isArray(cloned.assistant_groups) ||
    !Array.isArray(cloned.result_positions) ||
    !Array.isArray(cloned.warnings)
  ) throw new TypeError("Invalid Claude parser-state collection.");

  let previousLine = 0;
  let previousEnd = 0;
  for (const row of cloned.rows) {
    if (!isRecord(row)) throw new TypeError("Invalid Claude state row.");
    exactKeys(row, [
      "kind", "original_bytes", "byte_start", "byte_end", "line",
      "timestamp_ms", "source_index", "session_id", "entry_uuid",
      "has_synthetic_uuid", "cwd", "branch", "parent_uuid", "agent_id",
      "is_sidechain", "value", "tool_results",
    ]);
    if (row.kind !== "claude-row-v1") throw new TypeError("Unknown Claude row kind.");
    const originalBytes = nonnegativeInteger(row.original_bytes);
    const byteStart = nonnegativeInteger(row.byte_start);
    const byteEnd = nonnegativeInteger(row.byte_end);
    const line = nonnegativeInteger(row.line);
    const sourceIndex = nonnegativeInteger(row.source_index);
    nonnegativeInteger(row.timestamp_ms);
    if (
      line < 1 || line <= previousLine || sourceIndex !== line - 1 ||
      byteStart < previousEnd || byteEnd < byteStart ||
      byteEnd - byteStart < originalBytes || byteEnd > parsedOffset
    ) throw new TypeError("Inconsistent Claude physical row indexes.");
    stateString(row.session_id);
    stateString(row.entry_uuid);
    stateString(row.cwd, true);
    stateString(row.branch, true);
    stateString(row.parent_uuid, true);
    stateString(row.agent_id, true);
    if (
      typeof row.has_synthetic_uuid !== "boolean" ||
      typeof row.is_sidechain !== "boolean" || !Array.isArray(row.tool_results)
    ) throw new TypeError("Invalid Claude state row payload.");
    validateClaudeRowValue(row.value);
    for (const result of row.tool_results) validateClaudeToolResult(result);
    previousLine = line;
    previousEnd = byteEnd;
  }
  if (previousLine > lineCount || previousEnd > parsedOffset) {
    throw new TypeError("Claude parser-state progress is inconsistent.");
  }
  validateClaudeIndexes(
    cloned,
    cloned.rows as unknown as ClaudeStateRowV1[],
  );
  cloned.warnings.forEach((fact, index) => validateWarningFact(fact, index));
  return cloned as unknown as ClaudeParserStateV1;
}

function stateToolResult(result: IngestedToolResult): ClaudeStateToolResultV1 {
  return {
    tool_use_id: result.toolUseId ?? null,
    status_evidence: { ...result.statusEvidence },
    output: result.output,
    output_bytes: result.outputBytes,
    estimated_tokens: result.estimatedTokens,
    has_unknown_schema: result.hasUnknownSchema,
    exit_code: result.exitCode ?? null,
  };
}

function parsedToolResult(result: ClaudeStateToolResultV1): IngestedToolResult {
  return {
    statusEvidence: { ...result.status_evidence },
    output: result.output,
    outputBytes: result.output_bytes,
    estimatedTokens: result.estimated_tokens,
    hasUnknownSchema: result.has_unknown_schema,
    ...(result.tool_use_id === null ? {} : { toolUseId: result.tool_use_id }),
    ...(result.exit_code === null ? {} : { exitCode: result.exit_code }),
  };
}

function warningFact(
  pending: PendingWarning,
  order: number,
  timestampMs?: number,
): ParserStateWarningV1 {
  const { targetSessionId, ...sourceWarning } = pending;
  return {
    order,
    applicability: timestampMs === undefined
      ? { kind: "unconditional" }
      : { kind: "timestamp", timestamp_ms: timestampMs },
    scope: targetSessionId === undefined ? "source" : "session",
    target_session_id: targetSessionId ?? null,
    warning: sourceWarning,
  };
}

function buildClaudeIndexes(
  rows: readonly ClaudeStateRowV1[],
  capacity?: IncrementalParserStateByteTracker,
): Pick<
  ClaudeParserStateV1,
  "branch_lanes" | "ancestry" | "assistant_groups" | "result_positions"
> {
  const branchLanes: ClaudeBranchLaneV1[] = [];
  const ancestry: ClaudeAncestryV1[] = [];
  const assistantGroups = new Map<string, ClaudeAssistantGroupV1>();
  const resultPositions = new Map<string, ClaudeResultPositionV1>();
  for (const row of rows) {
    if (row.branch !== null) {
      const item = {
        session_id: row.session_id,
        lane_id: row.agent_id ?? row.session_id,
        source_index: row.source_index,
        branch: row.branch,
      };
      capacity?.addArrayItem(item, branchLanes.length);
      branchLanes.push(item);
    }
    if (row.parent_uuid !== null) {
      const item = {
        session_id: row.session_id,
        entry_uuid: row.entry_uuid,
        parent_uuid: row.parent_uuid,
        source_index: row.source_index,
        agent_id: row.agent_id,
      };
      capacity?.addArrayItem(item, ancestry.length);
      ancestry.push(item);
    }
    const messageId = row.value.type === "assistant"
      ? nonEmptyString(row.value.message.id)
      : undefined;
    if (messageId !== undefined) {
      const key = `${row.session_id}\0${messageId}`;
      const group = assistantGroups.get(key);
      if (group === undefined) {
        assistantGroups.set(key, {
          session_id: row.session_id,
          message_id: messageId,
          source_indexes: [row.source_index],
        });
      } else {
        group.source_indexes.push(row.source_index);
      }
    }
    for (const result of row.tool_results) {
      if (result.tool_use_id !== null) {
        resultPositions.set(`${row.session_id}\0${result.tool_use_id}`, {
          session_id: row.session_id,
          tool_use_id: result.tool_use_id,
          source_index: row.source_index,
        });
      }
    }
  }
  const assistantGroupsArray: ClaudeAssistantGroupV1[] = [];
  for (const item of assistantGroups.values()) {
    capacity?.addArrayItem(item, assistantGroupsArray.length);
    assistantGroupsArray.push(item);
  }
  const resultPositionsArray: ClaudeResultPositionV1[] = [];
  for (const item of resultPositions.values()) {
    capacity?.addArrayItem(item, resultPositionsArray.length);
    resultPositionsArray.push(item);
  }
  return {
    branch_lanes: branchLanes,
    ancestry,
    assistant_groups: assistantGroupsArray,
    result_positions: resultPositionsArray,
  };
}

function claudeStateSkeleton(
  canonicalPath: string,
  parsedOffset: number,
  lineCount: number,
  endsWithNewline: boolean,
): ClaudeParserStateV1 {
  return {
    kind: "claude-state-v1",
    canonical_path: canonicalPath,
    parsed_offset: parsedOffset,
    line_count: lineCount,
    ends_with_newline: endsWithNewline,
    rows: [],
    branch_lanes: [],
    ancestry: [],
    assistant_groups: [],
    result_positions: [],
    warnings: [],
  };
}

async function rangeEndsWithNewline(
  handle: FileHandle,
  endOffset: number,
  emptyFallback: boolean,
): Promise<boolean> {
  if (endOffset === 0) return false;
  const byte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(byte, 0, 1, endOffset - 1);
  return bytesRead === 0 ? emptyFallback : byte[0] === 0x0a;
}

export async function readClaudeParserState(options: {
  sourcePath: string;
  fileHandle: FileHandle;
  range?: { start_offset: number; starting_line: number };
  seed?: ClaudeParserStateV1;
  budgets?: Partial<ParserReadBudgets>;
  signal?: AbortSignal;
}): Promise<ParserStateReadResult<ClaudeParserStateV1>> {
  const seed = options.seed === undefined
    ? undefined
    : normalizeClaudeParserState(options.seed);
  const startOffset = options.range?.start_offset ?? 0;
  const startingLine = options.range?.starting_line ?? 1;
  if (
    (seed === undefined && (startOffset !== 0 || startingLine !== 1)) ||
    (seed !== undefined && (
      seed.canonical_path !== options.sourcePath ||
      seed.parsed_offset !== startOffset ||
      seed.line_count + 1 !== startingLine
    ))
  ) throw new TypeError("Claude parser seed/range is inconsistent.");
  const configured = new JsonlBudgetTracker({
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const remainingFileBytes = Math.max(
    0,
    configured.budgets.maxFileBytes - startOffset,
  );
  const tracker = new JsonlBudgetTracker({
    budgets: { ...options.budgets, maxFileBytes: remainingFileBytes },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const stat = await options.fileHandle.stat();
  const rows = seed?.rows ?? [];
  const warnings = seed?.warnings ?? [];
  const initialSkeletonBytes = canonicalJsonBytes(claudeStateSkeleton(
    options.sourcePath,
    startOffset,
    seed?.line_count ?? 0,
    seed?.ends_with_newline ?? false,
  ));
  const stateCapacity = new IncrementalParserStateByteTracker(
    initialSkeletonBytes,
  );
  for (let index = 0; index < rows.length; index += 1) {
    stateCapacity.addArrayItem(rows[index], index);
  }
  for (let index = 0; index < warnings.length; index += 1) {
    stateCapacity.addArrayItem(warnings[index], index);
  }
  const pushStateWarning = (fact: ParserStateWarningV1): void => {
    stateCapacity.addArrayItem(fact, warnings.length);
    warnings.push(fact);
  };
  let warningOrder = warnings.length;
  let readStopIndex = 0;
  const pushReadStops = (): void => {
    while (readStopIndex < tracker.readStops.length) {
      const error = tracker.readStops[readStopIndex]!;
      pushStateWarning(warningFact(
        parserBudgetWarning(options.sourcePath, error),
        warningOrder,
      ));
      warningOrder += 1;
      readStopIndex += 1;
    }
  };
  let lastLine = seed?.line_count ?? 0;
  const iterator = boundedJsonlLines(options.sourcePath, tracker, {
    file_handle: options.fileHandle,
    start_offset: startOffset,
    starting_line: startingLine,
  });
  let receipt: SourceReadReceipt | undefined;
  while (true) {
    const next = await iterator.next();
    pushReadStops();
    if (next.done) {
      receipt = next.value;
      break;
    }
    const inputLine = next.value;
    const { text: rawLine, bytes: rawBytes, line } = inputLine;
    lastLine = line;
    const pushWarning = (pending: PendingWarning, timestampMs?: number): void => {
      pushStateWarning(warningFact(pending, warningOrder, timestampMs));
      warningOrder += 1;
    };
    if (rawLine.trim().length === 0) {
      pushWarning(warning(
        options.sourcePath,
        "empty_line",
        "Ignored an empty JSONL row.",
        { line },
      ));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine) as unknown;
    } catch {
      pushWarning(warning(
        options.sourcePath,
        "invalid_json",
        "Ignored malformed JSON.",
        { line },
      ));
      continue;
    }
    if (!isRecord(parsed)) {
      pushWarning(warning(
        options.sourcePath,
        "invalid_row",
        "JSONL row is not an object.",
        { line },
      ));
      continue;
    }
    const timestampMs = parseTimestamp(parsed.timestamp);
    try {
      tracker.assertNodes(parsed, line);
    } catch (error) {
      tracker.throwIfAborted();
      if (!(error instanceof ParserBudgetExceededError)) throw error;
      pushWarning(parserBudgetWarning(options.sourcePath, error), timestampMs);
      continue;
    }
    if (timestampMs === undefined) {
      const sessionId = nonEmptyString(parsed.sessionId);
      const rowType = nonEmptyString(parsed.type);
      const isKnownAuxiliaryRow =
        rowType !== undefined && KNOWN_AUXILIARY_ROW_TYPES.has(rowType);
      if (sessionId === undefined) {
        pushWarning(warning(
          options.sourcePath,
          "missing_session_id",
          "Ignored a row without a sessionId.",
          { line },
        ));
      } else if (!isKnownAuxiliaryRow) {
        pushWarning(warning(
          options.sourcePath,
          "invalid_timestamp",
          "Ignored a row with an invalid timestamp.",
          { line, sessionId },
        ));
      }
      continue;
    }
    const sessionId = nonEmptyString(parsed.sessionId);
    if (sessionId === undefined) {
      pushWarning(warning(
        options.sourcePath,
        "missing_session_id",
        "Ignored a row without a sessionId.",
        { line },
      ), timestampMs);
      continue;
    }
    const rowType = nonEmptyString(parsed.type);
    const isKnownAuxiliaryRow =
      rowType !== undefined && KNOWN_AUXILIARY_ROW_TYPES.has(rowType);
    const sourceIndex = line - 1;
    const observedUuid = nonEmptyString(parsed.uuid);
    const entryUuid = observedUuid ??
      `${sessionId}:source-${sourceIndex.toString(10)}`;
    const cwd = nonEmptyString(parsed.cwd);
    const branch = nonEmptyString(parsed.gitBranch);
    const parentUuid = nonEmptyString(parsed.parentUuid);
    const agentId = nonEmptyString(parsed.agentId);
    const toolResults = ingestToolResults(parsed);
    const compacted = compactRowValue(parsed, toolResults);
    const range = jsonlLinePhysicalRange(inputLine);
    const stateRow: ClaudeStateRowV1 = {
      kind: "claude-row-v1",
      original_bytes: rawBytes,
      byte_start: range.byte_start,
      byte_end: range.byte_end,
      line,
      timestamp_ms: timestampMs,
      source_index: sourceIndex,
      session_id: sessionId,
      entry_uuid: entryUuid,
      has_synthetic_uuid: observedUuid === undefined,
      cwd: cwd ?? null,
      branch: branch ?? null,
      parent_uuid: parentUuid ?? null,
      agent_id: agentId ?? null,
      is_sidechain: parsed.isSidechain === true,
      value: compacted.value,
      tool_results: toolResults.map(stateToolResult),
    };
    stateCapacity.addArrayItem(stateRow, rows.length);
    rows.push(stateRow);
    const parsedRow: ParsedRow = {
      value: compacted.value as unknown as UnknownRecord,
      toolResults,
      sessionId,
      timestampMs,
      entryUuid,
      hasSyntheticUuid: observedUuid === undefined,
      sourceIndex,
      line,
      isSidechain: parsed.isSidechain === true,
      ...(cwd === undefined ? {} : { cwd }),
      ...(branch === undefined ? {} : { branch }),
      ...(parentUuid === undefined ? {} : { parentUuid }),
      ...(agentId === undefined ? {} : { agentId }),
    };
    if (compacted.discardedPayload) {
      pushWarning(warning(
        options.sourcePath,
        "content_payload_compacted",
        `Discarded ${compacted.discardedPayloadBytes.toString(10)} UTF-8 bytes from an unrecognized message content payload.`,
        { line, row: parsedRow },
      ), timestampMs);
    }
    if (observedUuid === undefined && !isKnownAuxiliaryRow) {
      pushWarning(warning(
        options.sourcePath,
        "missing_entry_uuid",
        "Used a deterministic entry UUID fallback.",
        { row: parsedRow },
      ), timestampMs);
    }
  }
  if (receipt === undefined) throw new TypeError("Missing Claude read receipt.");
  lastLine = Math.max(lastLine, tracker.lastPhysicalLine);
  const completeness = receipt.end_offset === stat.size ? "complete" : "partial";
  if (
    completeness === "partial" &&
    !tracker.readStops.some((error) => error.budget === "file")
  ) {
    const error = new ParserBudgetExceededError("file", lastLine + 1);
    pushStateWarning(warningFact(
      parserBudgetWarning(options.sourcePath, error),
      warningOrder,
    ));
  }
  const endsWithNewline = await rangeEndsWithNewline(
    options.fileHandle,
    receipt.end_offset,
    seed?.ends_with_newline ?? false,
  );
  const finalSkeletonBytes = canonicalJsonBytes(claudeStateSkeleton(
    options.sourcePath,
    receipt.end_offset,
    lastLine,
    endsWithNewline,
  ));
  stateCapacity.replaceBytes(initialSkeletonBytes, finalSkeletonBytes);
  const indexes = buildClaudeIndexes(rows, stateCapacity);
  const state: ClaudeParserStateV1 = {
    kind: "claude-state-v1",
    canonical_path: options.sourcePath,
    parsed_offset: receipt.end_offset,
    line_count: lastLine,
    ends_with_newline: endsWithNewline,
    rows,
    ...indexes,
    warnings,
  };
  return { state, receipt, completeness };
}

async function readRows(
  sourcePath: string,
  options: ClaudeTranscriptParseOptions,
): Promise<{ rows: ParsedRow[]; warnings: PendingWarning[];
  tracker: JsonlBudgetTracker }> {
  const tracker = new JsonlBudgetTracker(options);
  const rows: ParsedRow[] = [];
  const warnings = boundedWarnings<PendingWarning>(
    tracker.budgets.maxWarnings,
    () => warning(
      sourcePath,
      "parser_warning_budget_exceeded",
      "Suppressed further parser warnings after reaching maxWarnings.",
    ),
  );

  try {
    for await (const inputLine of boundedJsonlLines(sourcePath, tracker)) {
      const { text: rawLine, bytes: rawBytes, line } = inputLine;
    if (rawLine.trim().length === 0) {
      warnings.push(
        warning(sourcePath, "empty_line", "Ignored an empty JSONL row.", {
          line,
        }),
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine) as unknown;
    } catch {
      warnings.push(
        warning(sourcePath, "invalid_json", "Ignored malformed JSON.", {
          line,
        }),
      );
      continue;
    }
    if (!isRecord(parsed)) {
      warnings.push(
        warning(sourcePath, "invalid_row", "JSONL row is not an object.", {
          line,
        }),
      );
      continue;
    }
    try {
      tracker.assertNodes(parsed, line);
    } catch (error) {
      tracker.throwIfAborted();
      if (!(error instanceof ParserBudgetExceededError)) throw error;
      warnings.push(parserBudgetWarning(sourcePath, error));
      continue;
    }

    const timestampMs = parseTimestamp(parsed.timestamp);
    if (timestampMs === undefined) {
      const sessionId = nonEmptyString(parsed.sessionId);
      const rowType = nonEmptyString(parsed.type);
      const isKnownAuxiliaryRow =
        rowType !== undefined && KNOWN_AUXILIARY_ROW_TYPES.has(rowType);
      if (sessionId === undefined) {
        warnings.push(warning(sourcePath, "missing_session_id",
          "Ignored a row without a sessionId.", { line }));
      } else if (!isKnownAuxiliaryRow) {
        warnings.push(
          warning(
            sourcePath,
            "invalid_timestamp",
            "Ignored a row with an invalid timestamp.",
            { line, sessionId },
          ),
        );
      }
      continue;
    }
    if (options.endedAtMs !== undefined && timestampMs > options.endedAtMs) {
      continue;
    }

    const sessionId = nonEmptyString(parsed.sessionId);
    if (sessionId === undefined) {
      warnings.push(warning(sourcePath, "missing_session_id",
        "Ignored a row without a sessionId.", { line }));
      continue;
    }
    const rowType = nonEmptyString(parsed.type);
    const isKnownAuxiliaryRow =
      rowType !== undefined && KNOWN_AUXILIARY_ROW_TYPES.has(rowType);

    try {
      tracker.retain(rawBytes, line);
    } catch (error) {
      tracker.throwIfAborted();
      if (!(error instanceof ParserBudgetExceededError)) throw error;
      warnings.push(parserBudgetWarning(sourcePath, error));
      break;
    }
    const sourceIndex = line - 1;
    const observedUuid = nonEmptyString(parsed.uuid);
    const entryUuid =
      observedUuid ?? `${sessionId}:source-${sourceIndex.toString(10)}`;
    const cwd = nonEmptyString(parsed.cwd);
    const branch = nonEmptyString(parsed.gitBranch);
    const parentUuid = nonEmptyString(parsed.parentUuid);
    const agentId = nonEmptyString(parsed.agentId);
    const toolResults = ingestToolResults(parsed);
    const compacted = compactRowValue(parsed, toolResults);
    const row: ParsedRow = {
      value: compacted.value as unknown as UnknownRecord,
      toolResults,
      sessionId,
      timestampMs,
      entryUuid,
      hasSyntheticUuid: observedUuid === undefined,
      sourceIndex,
      line,
      isSidechain: parsed.isSidechain === true,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(parentUuid !== undefined ? { parentUuid } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
    };
    rows.push(row);
    if (compacted.discardedPayload) {
      warnings.push(
        warning(
          sourcePath,
          "content_payload_compacted",
          `Discarded ${compacted.discardedPayloadBytes.toString(10)} UTF-8 bytes from an unrecognized message content payload.`,
          { line, row },
        ),
      );
    }
    if (row.hasSyntheticUuid && !isKnownAuxiliaryRow) {
      warnings.push(
        warning(
          sourcePath,
          "missing_entry_uuid",
          "Used a deterministic entry UUID fallback.",
          { row },
        ),
      );
    }
    }
  } catch (error) {
    tracker.throwIfAborted();
    if (!(error instanceof ParserBudgetExceededError)) throw error;
    warnings.push(parserBudgetWarning(sourcePath, error));
  }

  return { rows, warnings, tracker };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function eventBase(
  row: ParsedRow,
  agentId: string,
  hasSchemaLoss = false,
): {
  timestamp_ms: number;
  session_id: string;
  entry_uuid: string;
  session_ref: string;
  source_index: number;
  agent_id: string;
  is_sidechain: boolean;
  confidence: Confidence;
  parent_uuid?: string;
  branch?: string;
  branch_epoch?: number;
} {
  return {
    timestamp_ms: row.timestampMs,
    session_id: row.sessionId,
    entry_uuid: row.entryUuid,
    session_ref: makeSessionRef(row.sessionId, row.entryUuid),
    source_index: row.sourceIndex,
    agent_id: agentId,
    is_sidechain: row.isSidechain,
    confidence: row.hasSyntheticUuid || hasSchemaLoss ? "low" : "high",
    ...(row.parentUuid !== undefined ? { parent_uuid: row.parentUuid } : {}),
    ...(row.branch !== undefined ? { branch: row.branch } : {}),
    ...(row.branchEpoch !== undefined
      ? { branch_epoch: row.branchEpoch }
      : {}),
  };
}

function parseAssistantBlocks(
  sourcePath: string,
  row: ParsedRow,
  warnings: PendingWarning[],
): AssistantRow | undefined {
  const message = row.value.message;
  if (!isRecord(message)) {
    warnings.push(
      warning(sourcePath, "invalid_assistant", "Assistant row has no message.", {
        row,
      }),
    );
    return undefined;
  }

  const blocks: LogicalBlock[] = [];
  let hasSchemaLoss = false;
  const content = message.content;
  const rawBlocks = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];
  if (!Array.isArray(content) && typeof content !== "string") {
    hasSchemaLoss = true;
    warnings.push(
      warning(
        sourcePath,
        "invalid_assistant_content",
        "Assistant content is neither a string nor an array.",
        { row },
      ),
    );
  }

  for (const rawBlock of rawBlocks) {
    if (!isRecord(rawBlock)) {
      hasSchemaLoss = true;
      warnings.push(
        warning(
          sourcePath,
          "invalid_content_block",
          "Ignored a non-object assistant content block.",
          { row },
        ),
      );
      continue;
    }
    if (rawBlock.type === "thinking" || rawBlock.type === "redacted_thinking") {
      // Known reasoning content; skip quietly without counting as schema loss.
      continue;
    }
    if (rawBlock.type === "text" && typeof rawBlock.text === "string") {
      blocks.push({ kind: "text", text: rawBlock.text, row });
      continue;
    }
    if (rawBlock.type === "tool_use") {
      const id = nonEmptyString(rawBlock.id);
      const name = nonEmptyString(rawBlock.name);
      if (id !== undefined && name !== undefined) {
        if (!isRecord(rawBlock.input)) {
          hasSchemaLoss = true;
          warnings.push(
            warning(
              sourcePath,
              "invalid_tool_input",
              "Preserved a tool_use block with an empty input fallback.",
              { row },
            ),
          );
        }
        blocks.push({
          kind: "tool",
          id,
          name,
          input: toJsonObject(rawBlock.input),
          row,
        });
      } else {
        hasSchemaLoss = true;
        warnings.push(
          warning(
            sourcePath,
            "invalid_tool_use",
            "Ignored a tool_use block without an id or name.",
            { row },
          ),
        );
      }
      continue;
    }
    hasSchemaLoss = true;
    warnings.push(
      warning(
        sourcePath,
        "unsupported_content_block",
        `Ignored unsupported assistant content block type ${JSON.stringify(rawBlock.type)}.`,
        { row },
      ),
    );
  }

  const usage = isRecord(message.usage) ? message.usage : {};
  const messageId = nonEmptyString(message.id);
  const inputTokens = finiteInteger(usage.input_tokens);
  const outputTokens = finiteInteger(usage.output_tokens);
  return {
    row,
    blocks,
    hasSchemaLoss,
    ...(messageId !== undefined ? { messageId } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  let maximum: number | undefined;
  for (const value of values) {
    if (value !== undefined) maximum = Math.max(maximum ?? value, value);
  }
  return maximum;
}

interface AssistantTextLane {
  position: number;
  sourceIndex: number;
  text: string;
}

function dedupeAssistantBlocks(
  rows: AssistantRow[],
  instrumentation: ClaudeParserInstrumentation,
): LogicalBlock[] {
  const result: LogicalBlock[] = [];
  const positions = new Map<string, number>();
  const textLanes = new Map<number, AssistantTextLane>();

  for (const assistantRow of rows) {
    let textLane = 0;
    for (const block of assistantRow.blocks) {
      const lane = block.kind === "text" ? textLane : undefined;
      if (lane !== undefined) {
        textLane += 1;
      }
      const identity =
        block.kind === "tool"
          ? `tool:${block.id}`
          : `text:${JSON.stringify(block.text)}`;
      const existing = positions.get(identity);
      if (existing !== undefined) {
        result[existing] = block;
        if (lane !== undefined && block.kind === "text") {
          textLanes.set(lane, {
            position: existing,
            sourceIndex: block.row.sourceIndex,
            text: block.text,
          });
        }
        continue;
      }

      if (block.kind === "text" && lane !== undefined) {
        const laneCandidate = textLanes.get(lane);
        if (
          laneCandidate !== undefined &&
          laneCandidate.sourceIndex !== block.row.sourceIndex
        ) {
          instrumentation.onAssistantPrefixProbe?.();
          const candidate = result[laneCandidate.position];
          if (
            candidate?.kind === "text" &&
            candidate.text === laneCandidate.text &&
            (block.text.startsWith(candidate.text) ||
              candidate.text.startsWith(block.text))
          ) {
            positions.delete(`text:${JSON.stringify(candidate.text)}`);
            result[laneCandidate.position] = block;
            positions.set(
              `text:${JSON.stringify(block.text)}`,
              laneCandidate.position,
            );
            textLanes.set(lane, {
              position: laneCandidate.position,
              sourceIndex: block.row.sourceIndex,
              text: block.text,
            });
            continue;
          }
        }
      }

      positions.set(identity, result.length);
      result.push(block);
      if (lane !== undefined && block.kind === "text") {
        textLanes.set(lane, {
          position: result.length - 1,
          sourceIndex: block.row.sourceIndex,
          text: block.text,
        });
      }
    }
  }
  return result;
}

function collectByKeys(
  value: JsonValue,
  keys: ReadonlySet<string>,
  output: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectByKeys(item, keys, output);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && typeof item === "string" && item.length > 0) {
      output.push(item);
    }
    collectByKeys(item, keys, output);
  }
}

function toolUseEvent(
  block: ToolBlock,
  agentId: string,
  hasSchemaLoss: boolean,
): ToolUseEvent {
  const paths: string[] = [];
  const editFragments: string[] = [];
  collectByKeys(
    block.input,
    new Set(["file_path", "path", "notebook_path"]),
    paths,
  );
  collectByKeys(
    block.input,
    new Set([
      "content",
      "new_string",
      "newText",
      "patch",
      "diff",
      "replacement",
    ]),
    editFragments,
  );
  const command =
    typeof block.input.command === "string" && block.input.command.length > 0
      ? block.input.command
      : undefined;
  const cwd =
    typeof block.input.cwd === "string" && block.input.cwd.length > 0
      ? block.input.cwd
      : block.row.cwd;
  return {
    ...eventBase(block.row, agentId, hasSchemaLoss),
    kind: "tool_use",
    tool_use_id: block.id,
    tool_name: block.name,
    input: block.input,
    paths: [...new Set(paths)],
    edit_fragments: [...new Set(editFragments)],
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

function toolResultEvent(
  row: ParsedRow,
  result: IngestedToolResult,
  agentId: string,
): ToolResultEvent | undefined {
  const toolUseId = result.toolUseId;
  if (toolUseId === undefined) {
    return undefined;
  }
  return {
    ...eventBase(row, agentId, result.hasUnknownSchema),
    kind: "tool_result",
    tool_use_id: toolUseId,
    status: result.statusEvidence.status,
    status_evidence: result.statusEvidence,
    output: result.output,
    output_bytes: result.outputBytes,
    estimated_tokens: result.estimatedTokens,
    ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
  };
}

function textContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .filter(
      (item): item is UnknownRecord =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("\n");
}

function compactionEvent(
  row: ParsedRow,
  agentId: string,
): CompactionEvent | undefined {
  const isBoundary =
    row.value.type === "system" && row.value.subtype === "compact_boundary";
  const isSummary = row.value.type === "user" && row.value.isCompactSummary === true;
  if (!isBoundary && !isSummary) {
    return undefined;
  }
  const message = isRecord(row.value.message) ? row.value.message : {};
  const summary = isBoundary
    ? textContent(row.value.content)
    : textContent(message.content);
  const compactMetadata = isRecord(row.value.compactMetadata)
    ? row.value.compactMetadata
    : {};
  const estimatedTokens =
    finiteInteger(compactMetadata.preTokens) ??
    finiteInteger(compactMetadata.estimatedTokens) ??
    finiteInteger(compactMetadata.tokens);
  return {
    ...eventBase(row, agentId),
    kind: "compaction",
    summary: summary.length > 0 ? summary : "Conversation compacted",
    ...(estimatedTokens !== undefined
      ? { estimated_tokens: estimatedTokens }
      : {}),
  };
}

/**
 * Stamps every row with the effective branch: the last observed non-empty
 * gitBranch within the row's agent lane, with rows before the lane's first
 * branch-carrying row adopting that first branch. Rows that emit no events
 * (system rows, meta users) still advance the effective branch for later
 * rows in their lane. A per-lane branch epoch counter advances on every
 * effective-branch change so departures visible only on non-event rows
 * remain detectable downstream, without a sidechain's branch changes
 * advancing the main agent's epoch.
 *
 * Lanes that carry no branch metadata at all (typical subagents) fall back
 * to file-order inheritance so they stay attributable to the surrounding
 * branch context.
 */
function stampEffectiveBranches(
  sessionRows: ParsedRow[],
  agentFor: (row: ParsedRow) => string,
): void {
  const fileBranches = new Map<number, string>();
  const fileEpochs = new Map<number, number>();
  let fileEffective = sessionRows.find(
    (row) => row.branch !== undefined,
  )?.branch;
  if (fileEffective === undefined) return;
  let fileEpoch = 0;
  for (const row of sessionRows) {
    if (row.branch !== undefined && row.branch !== fileEffective) {
      fileEffective = row.branch;
      fileEpoch += 1;
    }
    fileBranches.set(row.sourceIndex, row.branch ?? fileEffective);
    fileEpochs.set(row.sourceIndex, fileEpoch);
  }

  const lanes = new Map<string, ParsedRow[]>();
  for (const row of sessionRows) {
    const lane = agentFor(row);
    const group = lanes.get(lane);
    if (group === undefined) lanes.set(lane, [row]);
    else group.push(row);
  }
  for (const laneRows of lanes.values()) {
    let effective = laneRows.find((row) => row.branch !== undefined)?.branch;
    if (effective === undefined) {
      for (const row of laneRows) {
        row.branch = fileBranches.get(row.sourceIndex) as string;
        row.branchEpoch = fileEpochs.get(row.sourceIndex) as number;
      }
      continue;
    }
    let epoch = 0;
    for (const row of laneRows) {
      if (row.branch !== undefined && row.branch !== effective) {
        effective = row.branch;
        epoch += 1;
      } else if (row.branch === undefined) {
        row.branch = effective;
      }
      row.branchEpoch = epoch;
    }
  }
}

function normalizeSession(
  sourcePath: string,
  sessionRows: ParsedRow[],
  allWarnings: PendingWarning[],
  instrumentation: ClaudeTranscriptParseOptions,
): Session | undefined {
  instrumentation.signal?.throwIfAborted();
  const first = sessionRows[0];
  if (first === undefined) {
    return undefined;
  }
  const sessionId = first.sessionId;
  const rowsByUuid = new Map<string, ParsedRow[]>();
  for (const row of sessionRows) {
    instrumentation.signal?.throwIfAborted();
    const matches = rowsByUuid.get(row.entryUuid);
    if (matches === undefined) {
      rowsByUuid.set(row.entryUuid, [row]);
    } else {
      matches.push(row);
    }
  }
  const parentFor = (
    parentUuid: string,
    sourceIndex: number,
  ): ParsedRow | undefined => {
    const candidates = rowsByUuid.get(parentUuid);
    if (candidates === undefined) {
      return undefined;
    }
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (candidate !== undefined && candidate.sourceIndex < sourceIndex) {
        return candidate;
      }
    }
    return candidates[0];
  };
  const resolvedAgents = new Map<number, string>();
  const agentFor = (row: ParsedRow): string => {
    if (row.agentId !== undefined) {
      resolvedAgents.set(row.sourceIndex, row.agentId);
      return row.agentId;
    }
    if (!row.isSidechain) {
      return sessionId;
    }
    const cached = resolvedAgents.get(row.sourceIndex);
    if (cached !== undefined) {
      return cached;
    }

    let current = row;
    let fallbackRoot = row.parentUuid ?? row.entryUuid;
    const visited = new Set<number>();
    const traversed: ParsedRow[] = [];
    let resolvedAgent: string | undefined;
    while (!visited.has(current.sourceIndex)) {
      visited.add(current.sourceIndex);
      const currentCached = resolvedAgents.get(current.sourceIndex);
      if (currentCached !== undefined) {
        resolvedAgent = currentCached;
        break;
      }
      if (current.isSidechain) {
        traversed.push(current);
      }
      if (current.agentId !== undefined) {
        resolvedAgent = current.agentId;
        break;
      }
      const parentUuid = current.parentUuid;
      if (parentUuid === undefined) {
        fallbackRoot = current.entryUuid;
        break;
      }
      fallbackRoot = parentUuid;
      instrumentation.onAgentAncestryStep?.();
      const parent = parentFor(parentUuid, current.sourceIndex);
      if (parent === undefined) {
        break;
      }
      if (!parent.isSidechain) {
        fallbackRoot = current.entryUuid;
        break;
      }
      current = parent;
    }
    const agent =
      resolvedAgent ??
      `sidechain:${sessionId}:${fallbackRoot || basename(sourcePath)}`;
    for (const traversedRow of traversed) {
      resolvedAgents.set(traversedRow.sourceIndex, agent);
    }
    return agent;
  };
  stampEffectiveBranches(sessionRows, agentFor);

  const ordered: OrderedEvent[] = [];
  const assistantGroups = new Map<string, AssistantRow[]>();
  const resultPositions = new Map<string, number>();

  for (const row of sessionRows) {
    instrumentation.signal?.throwIfAborted();
    const compact = compactionEvent(row, agentFor(row));
    if (compact !== undefined) {
      ordered.push({ event: compact, suborder: 0 });
      continue;
    }
    if (row.value.type === "system" && row.value.subtype === "api_error") {
      allWarnings.push(
        warning(
          sourcePath,
          "api_error",
          "Claude recorded an API error; no normalized event was emitted.",
          { row },
        ),
      );
      continue;
    }

    if (row.value.type === "assistant") {
      const parsed = parseAssistantBlocks(sourcePath, row, allWarnings);
      if (parsed !== undefined) {
        const key =
          parsed.messageId !== undefined
            ? `id:${parsed.messageId}`
            : `row:${row.sourceIndex.toString(10)}`;
        const group = assistantGroups.get(key);
        if (group === undefined) {
          assistantGroups.set(key, [parsed]);
        } else {
          group.push(parsed);
        }
      }
      continue;
    }

    if (row.value.type !== "user" || row.value.isMeta === true) {
      continue;
    }
    const message = isRecord(row.value.message) ? row.value.message : {};
    const content = message.content;
    for (const ingestedResult of row.toolResults) {
      const result = toolResultEvent(row, ingestedResult, agentFor(row));
      if (result === undefined) {
        allWarnings.push(
          warning(
            sourcePath,
            "invalid_tool_result",
            "Ignored a tool_result block without a tool_use_id.",
            { row },
          ),
        );
        continue;
      }
      if (ingestedResult.hasUnknownSchema) {
        allWarnings.push(
          warning(
            sourcePath,
            "unknown_tool_result",
            "Tool result schema was not recognized; retained an unknown low-confidence result.",
            { row },
          ),
        );
      }
      const existing = resultPositions.get(result.tool_use_id);
      if (existing === undefined) {
        resultPositions.set(result.tool_use_id, ordered.length);
        ordered.push({ event: result, suborder: 0 });
      } else {
        ordered[existing] = { event: result, suborder: 0 };
      }
    }
    if (row.toolResults.length === 0) {
      const text = textContent(content);
      if (text.length > 0) {
        ordered.push({
          event: {
            ...eventBase(row, agentFor(row)),
            kind: "genuine_user",
            text,
          },
          suborder: 0,
        });
      }
    }
  }

  for (const group of assistantGroups.values()) {
    instrumentation.signal?.throwIfAborted();
    const blocks = dedupeAssistantBlocks(group, instrumentation);
    const hasSchemaLoss = group.some((item) => item.hasSchemaLoss);
    const textBlocks = blocks.filter(
      (block): block is TextBlock => block.kind === "text",
    );
    const representative =
      textBlocks[0]?.row ?? blocks[0]?.row ?? group[group.length - 1]?.row;
    if (representative === undefined) {
      continue;
    }
    const inputTokens = maxDefined(group.map((item) => item.inputTokens));
    const outputTokens = maxDefined(group.map((item) => item.outputTokens));
    const messageId = group[0]?.messageId;
    const assistant: AssistantEvent = {
      ...eventBase(representative, agentFor(representative), hasSchemaLoss),
      kind: "assistant",
      text: textBlocks.map((block) => block.text).join("\n"),
      ...(messageId !== undefined ? { message_id: messageId } : {}),
      ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
      ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    };
    ordered.push({ event: assistant, suborder: 0 });

    let toolSuborder = 1;
    for (const block of blocks) {
      if (block.kind === "tool") {
        ordered.push({
          event: toolUseEvent(block, agentFor(block.row), hasSchemaLoss),
          suborder: toolSuborder,
        });
        toolSuborder += 1;
      }
    }
  }

  ordered.sort(
    (left, right) =>
      left.event.source_index - right.event.source_index ||
      left.suborder - right.suborder ||
      left.event.kind.localeCompare(right.event.kind),
  );
  const events = ordered.map((item) => item.event);
  if (events.length === 0) {
    return undefined;
  }
  const sessionWarnings = allWarnings
    .filter(
      (item) =>
        item.targetSessionId === undefined || item.targetSessionId === sessionId,
    )
    .map(({ targetSessionId: _targetSessionId, ...item }) => item);
  let startedAtMs = events[0]!.timestamp_ms;
  let endedAtMs = startedAtMs;
  for (const event of events) {
    startedAtMs = Math.min(startedAtMs, event.timestamp_ms);
    endedAtMs = Math.max(endedAtMs, event.timestamp_ms);
  }
  const confidence: Confidence = events.some(
    (event) => event.confidence === "low",
  )
    ? "low"
    : "high";

  return {
    session_id: sessionId,
    source: "claude",
    source_path: sourcePath,
    observed_cwds: uniqueStrings(sessionRows.map((row) => row.cwd)),
    observed_branches: uniqueStrings(sessionRows.map((row) => row.branch)),
    started_at_ms: startedAtMs,
    ended_at_ms: endedAtMs,
    confidence,
    events,
    warnings: sessionWarnings,
  };
}

export function projectClaudeParserState(
  value: ClaudeParserStateV1,
  options: {
    endedAtMs?: number;
    budgets?: Partial<ParserProjectionBudgets>;
    signal?: AbortSignal;
    onAgentAncestryStep?(): void;
    onAssistantPrefixProbe?(): void;
  } = {},
): ClaudeTranscriptParseResult {
  const state = normalizeClaudeParserState(value);
  const tracker = new JsonlBudgetTracker({
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const admittedRows: ParsedRow[] = [];
  let retainedFailure: ParserBudgetExceededError | undefined;
  for (const row of state.rows) {
    tracker.throwIfAborted();
    if (options.endedAtMs !== undefined && row.timestamp_ms > options.endedAtMs) {
      continue;
    }
    try {
      tracker.retain(row.original_bytes, row.line);
    } catch (error) {
      tracker.throwIfAborted();
      if (!(error instanceof ParserBudgetExceededError)) throw error;
      retainedFailure = error;
      break;
    }
    admittedRows.push({
      value: structuredClone(row.value) as unknown as UnknownRecord,
      toolResults: row.tool_results.map(parsedToolResult),
      sessionId: row.session_id,
      timestampMs: row.timestamp_ms,
      entryUuid: row.entry_uuid,
      hasSyntheticUuid: row.has_synthetic_uuid,
      sourceIndex: row.source_index,
      line: row.line,
      isSidechain: row.is_sidechain,
      ...(row.cwd === null ? {} : { cwd: row.cwd }),
      ...(row.branch === null ? {} : { branch: row.branch }),
      ...(row.parent_uuid === null ? {} : { parentUuid: row.parent_uuid }),
      ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    });
  }
  const warnings = boundedWarnings<PendingWarning>(
    tracker.budgets.maxWarnings,
    () => warning(
      state.canonical_path,
      "parser_warning_budget_exceeded",
      "Suppressed further parser warnings after reaching maxWarnings.",
    ),
  );
  for (const fact of state.warnings) {
    const applicable = fact.applicability.kind === "unconditional" ||
      options.endedAtMs === undefined ||
      fact.applicability.timestamp_ms <= options.endedAtMs;
    const beforeRetainedStop = retainedFailure === undefined ||
      fact.warning.line === undefined ||
      fact.warning.line < (retainedFailure.line ?? Number.MAX_SAFE_INTEGER);
    if (!applicable || !beforeRetainedStop) continue;
    warnings.push({
      ...structuredClone(fact.warning),
      ...(fact.target_session_id === null
        ? {}
        : { targetSessionId: fact.target_session_id }),
    });
  }
  if (retainedFailure !== undefined) {
    warnings.push(parserBudgetWarning(state.canonical_path, retainedFailure));
  }
  const grouped = new Map<string, ParsedRow[]>();
  for (const row of admittedRows) {
    const group = grouped.get(row.sessionId);
    if (group === undefined) grouped.set(row.sessionId, [row]);
    else group.push(row);
  }
  const sessions: Session[] = [];
  for (const sessionRows of grouped.values()) {
    tracker.throwIfAborted();
    const session = normalizeSession(
      state.canonical_path,
      sessionRows,
      warnings,
      options,
    );
    if (session !== undefined) sessions.push(session);
  }
  return {
    sessions,
    warnings: warnings.map(
      ({ targetSessionId: _targetSessionId, ...sourceWarning }) => sourceWarning,
    ),
  };
}

async function parseClaudeTranscriptDetailedLegacy(
  sourcePath: string,
  instrumentation: ClaudeTranscriptParseOptions = {},
): Promise<ClaudeTranscriptParseResult> {
  const { rows, warnings, tracker } = await readRows(sourcePath, instrumentation);
  const grouped = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    tracker.throwIfAborted();
    const group = grouped.get(row.sessionId);
    if (group === undefined) {
      grouped.set(row.sessionId, [row]);
    } else {
      group.push(row);
    }
  }

  const sessions: Session[] = [];
  for (const sessionRows of grouped.values()) {
    tracker.throwIfAborted();
    const session = normalizeSession(
      sourcePath,
      sessionRows,
      warnings,
      instrumentation,
    );
    if (session !== undefined) sessions.push(session);
  }
  return {
    sessions,
    warnings: warnings.map(
      ({ targetSessionId: _targetSessionId, ...sourceWarning }) =>
        sourceWarning,
    ),
  };
}

export async function parseClaudeTranscriptDetailed(
  sourcePath: string,
  instrumentation: ClaudeTranscriptParseOptions = {},
): Promise<ClaudeTranscriptParseResult> {
  const fileHandle = await openFile(sourcePath, "r");
  try {
    try {
      const read = await readClaudeParserState({
        sourcePath,
        fileHandle,
        ...(instrumentation.budgets === undefined
          ? {}
          : { budgets: instrumentation.budgets }),
        ...(instrumentation.signal === undefined
          ? {}
          : { signal: instrumentation.signal }),
      });
      return projectClaudeParserState(read.state, {
        ...(instrumentation.endedAtMs === undefined
          ? {}
          : { endedAtMs: instrumentation.endedAtMs }),
        ...(instrumentation.budgets === undefined
          ? {}
          : { budgets: instrumentation.budgets }),
        ...(instrumentation.signal === undefined
          ? {}
          : { signal: instrumentation.signal }),
        ...(instrumentation.onAgentAncestryStep === undefined
          ? {}
          : { onAgentAncestryStep: instrumentation.onAgentAncestryStep }),
        ...(instrumentation.onAssistantPrefixProbe === undefined
          ? {}
          : { onAssistantPrefixProbe: instrumentation.onAssistantPrefixProbe }),
      });
    } catch (error) {
      if (!(error instanceof IncrementalParserStateCapacityError)) throw error;
    }
  } finally {
    await fileHandle.close();
  }
  return parseClaudeTranscriptDetailedLegacy(sourcePath, instrumentation);
}

export async function parseClaudeTranscript(
  sourcePath: string,
): Promise<Session[]> {
  return (await parseClaudeTranscriptDetailed(sourcePath)).sessions;
}

export async function parseClaudeSession(
  sourcePath: string,
): Promise<Session | undefined> {
  return (await parseClaudeTranscript(sourcePath))[0];
}
