import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

import {
  makeSessionRef,
  type AssistantEvent,
  type CompactionEvent,
  type Confidence,
  type JsonObject,
  type JsonValue,
  type NormalizedEvent,
  type Session,
  type SourceWarning,
  type ToolResultEvent,
  type ToolResultStatus,
  type ToolUseEvent,
} from "../../core/model.js";

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
  status: ToolResultStatus;
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
  parentUuid?: string;
  agentId?: string;
  isSidechain: boolean;
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
    Number.isInteger(value) &&
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
      Number.isInteger(candidate) &&
      Number.isFinite(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function classifyExplicitResultStatus(
  value: unknown,
  exitCode: number | undefined,
): { status: ToolResultStatus; recognized: boolean } {
  if (isRecord(value)) {
    const observedStatus = value.status;
    if (
      value.timedOut === true ||
      value.timed_out === true ||
      observedStatus === "timeout" ||
      observedStatus === "timed_out"
    ) {
      return { status: "timeout", recognized: true };
    }
    if (
      value.cancelled === true ||
      value.interrupted === true ||
      observedStatus === "cancelled" ||
      observedStatus === "canceled"
    ) {
      return { status: "cancelled", recognized: true };
    }
    if (
      value.is_error === true ||
      value.success === false ||
      (exitCode !== undefined && exitCode !== 0) ||
      observedStatus === "failed" ||
      observedStatus === "failure" ||
      observedStatus === "error"
    ) {
      return { status: "failure", recognized: true };
    }
    if (
      value.is_error === false ||
      value.success === true ||
      value.interrupted === false ||
      value.noOutputExpected === true ||
      [
        "async_launched",
        "completed",
        "forked",
        "success",
        "teammate_spawned",
      ].includes(
        typeof observedStatus === "string" ? observedStatus : "",
      )
    ) {
      return { status: "success", recognized: true };
    }
  }
  if (exitCode === 0) {
    return { status: "success", recognized: true };
  }
  return { status: "unknown", recognized: false };
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
  visibleText: ResultText,
  structuredText: ResultText,
  visibleExitCode: number | undefined,
  structuredExitCode: number | undefined,
): { status: ToolResultStatus; recognized: boolean } {
  const visible = classifyExplicitResultStatus(block, visibleExitCode);
  if (visible.recognized) {
    return visible;
  }
  const structured = classifyExplicitResultStatus(
    structuredResult,
    structuredExitCode,
  );
  if (structured.recognized) {
    return structured;
  }
  if (visibleText.recognized || structuredText.recognized) {
    return { status: "success", recognized: true };
  }
  return { status: "unknown", recognized: false };
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
    const status = classifyResultStatus(
      item,
      supplementalResult,
      visibleText,
      structuredText,
      visibleExitCode,
      structuredExitCode,
    );
    const selectedText = visibleText.recognized
      ? visibleText.text
      : structuredText.text;
    const bounded = boundedOutput(selectedText);
    const exitCode = visibleExitCode ?? structuredExitCode;
    results.push({
      status: status.status,
      output: bounded.output,
      outputBytes: bounded.outputBytes,
      estimatedTokens: bounded.estimatedTokens,
      hasUnknownSchema: !status.recognized,
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
  }
  return results;
}

interface CompactedContent {
  value: unknown;
  discardedPayload: boolean;
  discardedPayloadBytes: number;
}

interface CompactedRowValue {
  value: UnknownRecord;
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
      value: {},
      discardedPayload: true,
      discardedPayloadBytes: stringPayloadBytes(value),
    };
  }
  let discardedPayload = false;
  let discardedPayloadBytes = 0;
  const compacted: unknown[] = [];
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
        ...(block.id !== undefined ? { id: block.id } : {}),
        ...(block.name !== undefined ? { name: block.name } : {}),
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

  const compacted: unknown[] = [];
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
    return {
      value: {
        type,
        message: {
          ...(message.id !== undefined ? { id: message.id } : {}),
          content: content.value,
          usage: {
            ...(usage.input_tokens !== undefined
              ? { input_tokens: usage.input_tokens }
              : {}),
            ...(usage.output_tokens !== undefined
              ? { output_tokens: usage.output_tokens }
              : {}),
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
        ...(parsed.isMeta !== undefined ? { isMeta: parsed.isMeta } : {}),
        ...(parsed.isCompactSummary !== undefined
          ? { isCompactSummary: parsed.isCompactSummary }
          : {}),
        message: {
          content: content.value,
        },
      },
      discardedPayload: content.discardedPayload,
      discardedPayloadBytes: content.discardedPayloadBytes,
    };
  }
  if (type === "system") {
    return {
      value: {
        type,
        ...(parsed.subtype !== undefined ? { subtype: parsed.subtype } : {}),
        ...(parsed.content !== undefined ? { content: parsed.content } : {}),
        ...(parsed.compactMetadata !== undefined
          ? { compactMetadata: parsed.compactMetadata }
          : {}),
      },
      discardedPayload: false,
      discardedPayloadBytes: 0,
    };
  }
  return {
    value: { ...(type !== undefined ? { type } : {}) },
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

async function readRows(
  sourcePath: string,
): Promise<{ rows: ParsedRow[]; warnings: PendingWarning[] }> {
  const rows: ParsedRow[] = [];
  const warnings: PendingWarning[] = [];
  const input = createReadStream(sourcePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let line = 0;

  for await (const rawLine of lines) {
    line += 1;
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

    const sessionId = nonEmptyString(parsed.sessionId);
    if (sessionId === undefined) {
      warnings.push(
        warning(
          sourcePath,
          "missing_session_id",
          "Ignored a row without a sessionId.",
          { line },
        ),
      );
      continue;
    }
    const rowType = nonEmptyString(parsed.type);
    const isKnownAuxiliaryRow =
      rowType !== undefined && KNOWN_AUXILIARY_ROW_TYPES.has(rowType);

    const timestampMs = parseTimestamp(parsed.timestamp);
    if (timestampMs === undefined) {
      if (!isKnownAuxiliaryRow) {
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
      value: compacted.value,
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

  return { rows, warnings };
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
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.max(...present);
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
    status: result.status,
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

function normalizeSession(
  sourcePath: string,
  sessionRows: ParsedRow[],
  allWarnings: PendingWarning[],
  instrumentation: ClaudeParserInstrumentation,
): Session | undefined {
  const first = sessionRows[0];
  if (first === undefined) {
    return undefined;
  }
  const sessionId = first.sessionId;
  const rowsByUuid = new Map<string, ParsedRow[]>();
  for (const row of sessionRows) {
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

  const ordered: OrderedEvent[] = [];
  const assistantGroups = new Map<string, AssistantRow[]>();
  const resultPositions = new Map<string, number>();

  for (const row of sessionRows) {
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
  const timestamps = events.map((event) => event.timestamp_ms);
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
    started_at_ms: Math.min(...timestamps),
    ended_at_ms: Math.max(...timestamps),
    confidence,
    events,
    warnings: sessionWarnings,
  };
}

export async function parseClaudeTranscriptDetailed(
  sourcePath: string,
  instrumentation: ClaudeParserInstrumentation = {},
): Promise<ClaudeTranscriptParseResult> {
  const { rows, warnings } = await readRows(sourcePath);
  const grouped = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.sessionId);
    if (group === undefined) {
      grouped.set(row.sessionId, [row]);
    } else {
      group.push(row);
    }
  }

  const sessions: Session[] = [];
  for (const sessionRows of grouped.values()) {
    const session = normalizeSession(
      sourcePath,
      sessionRows,
      warnings,
      instrumentation,
    );
    if (session !== undefined) {
      sessions.push(session);
    }
  }
  return {
    sessions,
    warnings: warnings.map(
      ({ targetSessionId: _targetSessionId, ...sourceWarning }) =>
        sourceWarning,
    ),
  };
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
