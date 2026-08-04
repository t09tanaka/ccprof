import { open as openFile, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";

import {
  makeSessionRef,
  type AssistantEvent,
  type Confidence,
  type GenuineUserEvent,
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
  type ParserBudget,
  type ParserProjectionBudgets,
  type ParserReadBudgets,
  type ParserStateReadResult,
  type ParserStateRowBaseV1,
  type ParserStateWarningV1,
  type SourceReadReceipt,
} from "../jsonl-budget.js";

export { PARSER_STATE_SCHEMA_FINGERPRINT } from "../jsonl-budget.js";

export const CODEX_PARSER_VERSION = "2.0.0";

/**
 * Codex rollout logs are one JSON object per line:
 * `{"timestamp": ISO8601, "type": "session_meta"|"turn_context"|"response_item"|"event_msg", "payload": {...}}`.
 *
 * Like the Claude parser, this module streams the rollout file line by line
 * rather than holding the whole transcript in memory, and always yields at
 * most one `Session` per call (a rollout file represents a single Codex
 * session). The returned promise rejects when the file cannot be read.
 */
export interface ParseCodexSessionOptions extends JsonlParserControls {
  sourcePath: string;
  endedAtMs?: number;
}

type UnknownRecord = Record<string, unknown>;

const INJECTED_USER_TEXT_PREFIXES = [
  "<user_instructions>",
  "<environment_context>",
  "<turn_context>",
];

const EXIT_CODE_PATTERN = /^Process exited with code (\d+)(?:\r?\n|$)/u;

/**
 * File headers in an apply_patch body. Content lines inside a patch are
 * prefixed with `+`/`-`/` `, so anchoring on a bare `***` cannot collide
 * with patched file content that itself mentions these markers.
 */
const APPLY_PATCH_FILE_HEADER = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/u;

/** response_item.payload.type subtypes that are intentionally dropped without a warning. */
const IGNORED_RESPONSE_ITEM_SUBTYPES = new Set(["reasoning"]);

interface ParsedRow {
  type: string;
  payload: UnknownRecord;
  timestampMs: number;
  line: number;
}

interface CodexStateRowCommonV1 extends ParserStateRowBaseV1 {
  kind: "codex-row-v1";
  argument_budget: Extract<ParserBudget, "node" | "depth"> | null;
}

export type CodexStateTextFieldV1 =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "text"; value: string };

export interface CodexStateSessionMetaPayloadV1 {
  kind: "session_meta";
  session_id: string | null;
  cwd: string | null;
  branch: string | null;
}

export interface CodexStateMessagePayloadV1 {
  kind: "message";
  role: string | null;
  content: string;
}

export interface CodexStateFunctionCallPayloadV1 {
  kind: "function_call";
  name: string | null;
  call_id: string | null;
  arguments: CodexStateTextFieldV1;
}

export interface CodexStateFunctionOutputPayloadV1 {
  kind: "function_call_output";
  call_id: string | null;
  output: CodexStateTextFieldV1;
}

export interface CodexStateUnknownPayloadV1 {
  kind: "unknown";
  subtype: string | null;
}

export interface CodexStateAuxiliaryPayloadV1 {
  kind: "auxiliary";
}

export type CodexStateResponsePayloadV1 =
  | CodexStateMessagePayloadV1
  | CodexStateFunctionCallPayloadV1
  | CodexStateFunctionOutputPayloadV1
  | CodexStateUnknownPayloadV1;

export type CodexStateRowV1 = CodexStateRowCommonV1 & (
  | { type: "session_meta"; payload: CodexStateSessionMetaPayloadV1 }
  | { type: "response_item"; payload: CodexStateResponsePayloadV1 }
  | { type: "auxiliary"; payload: CodexStateAuxiliaryPayloadV1 }
);

export interface CodexSessionMetadataV1 {
  session_id: string;
  cwd: string | null;
  branch: string | null;
  line: number;
}

export interface CodexParserStateV1 {
  kind: "codex-state-v1";
  canonical_path: string;
  parsed_offset: number;
  line_count: number;
  ends_with_newline: boolean;
  rows: CodexStateRowV1[];
  session_metadata: CodexSessionMetadataV1 | null;
  seen_subtypes: string[];
  warnings: ParserStateWarningV1[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function warn(
  sourcePath: string,
  line: number | undefined,
  code: string,
  message: string,
  sessionRef?: string,
): SourceWarning {
  return {
    code,
    message,
    source_path: sourcePath,
    ...(line !== undefined ? { line } : {}),
    ...(sessionRef !== undefined ? { session_ref: sessionRef } : {}),
  };
}

function fileNameStem(sourcePath: string): string {
  const base = basename(sourcePath);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function snapshotCodexJson(
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
      result.push(snapshotCodexJson(value[index], capacity, depth + 1));
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
    result[key] = snapshotCodexJson(descriptor.value, capacity, depth + 1);
  }
  capacity.addBytes(1);
  return result;
}

function codexExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) throw new TypeError("Parser state has an invalid field set.");
}

function codexNonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Parser-state integer is invalid.");
  }
  return value as number;
}

function codexSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("Parser-state integer is invalid.");
  }
  return value as number;
}

function codexStateString(value: unknown): string;
function codexStateString(value: unknown, nullable: true): string | null;
function codexStateString(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.includes("\0")) {
    throw new TypeError("Parser-state text is invalid.");
  }
  return value;
}

function validateCodexWarningFact(value: unknown, expectedOrder: number): void {
  if (!isRecord(value)) throw new TypeError("Invalid parser-state warning fact.");
  codexExactKeys(value, [
    "order", "applicability", "scope", "target_session_id", "warning",
  ]);
  if (codexNonnegativeInteger(value.order) !== expectedOrder) {
    throw new TypeError("Parser-state warning order is invalid.");
  }
  if (!isRecord(value.applicability)) {
    throw new TypeError("Invalid parser-state warning applicability.");
  }
  if (value.applicability.kind === "unconditional") {
    codexExactKeys(value.applicability, ["kind"]);
  } else if (value.applicability.kind === "timestamp") {
    codexExactKeys(value.applicability, ["kind", "timestamp_ms"]);
    codexSafeInteger(value.applicability.timestamp_ms);
  } else {
    throw new TypeError("Unknown parser-state warning applicability.");
  }
  if (value.scope !== "source" && value.scope !== "session") {
    throw new TypeError("Invalid parser-state warning scope.");
  }
  codexStateString(value.target_session_id, true);
  if (!isRecord(value.warning)) throw new TypeError("Invalid source warning.");
  codexExactKeys(
    value.warning,
    ["code", "message", "source_path"],
    ["line", "session_ref"],
  );
  codexStateString(value.warning.code);
  codexStateString(value.warning.message);
  codexStateString(value.warning.source_path);
  if (value.warning.line !== undefined) {
    codexNonnegativeInteger(value.warning.line);
  }
  if (value.warning.session_ref !== undefined) {
    codexStateString(value.warning.session_ref);
  }
}

function validateCodexTextField(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Invalid Codex state text field.");
  if (value.kind === "text") {
    codexExactKeys(value, ["kind", "value"]);
    codexStateString(value.value);
    return;
  }
  if (value.kind === "missing" || value.kind === "invalid") {
    codexExactKeys(value, ["kind"]);
    return;
  }
  throw new TypeError("Unknown Codex state text field.");
}

function validateCodexStatePayload(type: unknown, value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Invalid Codex state payload.");
  if (type === "session_meta") {
    codexExactKeys(value, ["kind", "session_id", "cwd", "branch"]);
    if (value.kind !== "session_meta") {
      throw new TypeError("Invalid Codex session metadata payload.");
    }
    codexStateString(value.session_id, true);
    codexStateString(value.cwd, true);
    codexStateString(value.branch, true);
    return;
  }
  if (type === "auxiliary") {
    codexExactKeys(value, ["kind"]);
    if (value.kind !== "auxiliary") {
      throw new TypeError("Invalid Codex auxiliary payload.");
    }
    return;
  }
  if (type !== "response_item") {
    throw new TypeError("Unknown Codex state row type.");
  }
  if (value.kind === "message") {
    codexExactKeys(value, ["kind", "role", "content"]);
    codexStateString(value.role, true);
    codexStateString(value.content);
    return;
  }
  if (value.kind === "function_call") {
    codexExactKeys(value, ["kind", "name", "call_id", "arguments"]);
    codexStateString(value.name, true);
    codexStateString(value.call_id, true);
    validateCodexTextField(value.arguments);
    return;
  }
  if (value.kind === "function_call_output") {
    codexExactKeys(value, ["kind", "call_id", "output"]);
    codexStateString(value.call_id, true);
    validateCodexTextField(value.output);
    return;
  }
  if (value.kind === "unknown") {
    codexExactKeys(value, ["kind", "subtype"]);
    codexStateString(value.subtype, true);
    return;
  }
  throw new TypeError("Unknown Codex response payload.");
}

function validateCodexDerivedState(
  value: UnknownRecord,
  rows: readonly CodexStateRowV1[],
): void {
  const metadata = value.session_metadata;
  if (metadata !== null) {
    if (!isRecord(metadata)) {
      throw new TypeError("Invalid Codex session metadata.");
    }
    codexExactKeys(metadata, ["session_id", "cwd", "branch", "line"]);
    codexStateString(metadata.session_id);
    codexStateString(metadata.cwd, true);
    codexStateString(metadata.branch, true);
    codexNonnegativeInteger(metadata.line);
  }
  if (!Array.isArray(value.seen_subtypes)) {
    throw new TypeError("Invalid Codex subtype index.");
  }
  for (const subtype of value.seen_subtypes) codexStateString(subtype);
  if (new Set(value.seen_subtypes).size !== value.seen_subtypes.length) {
    throw new TypeError("Codex subtype index is not canonical.");
  }
  const expectedMetadata = codexMetadata(rows);
  const sameMetadata = metadata === null
    ? expectedMetadata === null
    : expectedMetadata !== null &&
      metadata.session_id === expectedMetadata.session_id &&
      metadata.cwd === expectedMetadata.cwd &&
      metadata.branch === expectedMetadata.branch &&
      metadata.line === expectedMetadata.line;
  const expectedSubtypes = codexSeenSubtypes(rows);
  const sameSubtypes = value.seen_subtypes.length === expectedSubtypes.length &&
    value.seen_subtypes.every((subtype, index) =>
      subtype === expectedSubtypes[index]
    );
  if (!sameMetadata || !sameSubtypes) {
    throw new TypeError("Codex derived parser state is not canonical.");
  }
}

export function normalizeCodexParserState(value: unknown): CodexParserStateV1 {
  const capacity = new IncrementalParserStateByteTracker();
  const cloned = snapshotCodexJson(value, capacity);
  if (!isRecord(cloned)) throw new TypeError("Codex parser state must be an object.");
  codexExactKeys(cloned, [
    "kind", "canonical_path", "parsed_offset", "line_count",
    "ends_with_newline", "rows", "session_metadata", "seen_subtypes",
    "warnings",
  ]);
  if (cloned.kind !== "codex-state-v1") {
    throw new TypeError("Unknown Codex parser-state kind.");
  }
  codexStateString(cloned.canonical_path);
  const parsedOffset = codexNonnegativeInteger(cloned.parsed_offset);
  const lineCount = codexNonnegativeInteger(cloned.line_count);
  if (typeof cloned.ends_with_newline !== "boolean") {
    throw new TypeError("Invalid Codex newline state.");
  }
  if (
    !Array.isArray(cloned.rows) || !Array.isArray(cloned.seen_subtypes) ||
    !Array.isArray(cloned.warnings)
  ) throw new TypeError("Invalid Codex parser-state collection.");
  let previousLine = 0;
  let previousEnd = 0;
  for (const row of cloned.rows) {
    if (!isRecord(row)) throw new TypeError("Invalid Codex state row.");
    codexExactKeys(row, [
      "kind", "original_bytes", "byte_start", "byte_end", "line",
      "timestamp_ms", "type", "payload", "argument_budget",
    ]);
    if (row.kind !== "codex-row-v1") throw new TypeError("Unknown Codex row kind.");
    const originalBytes = codexNonnegativeInteger(row.original_bytes);
    const byteStart = codexNonnegativeInteger(row.byte_start);
    const byteEnd = codexNonnegativeInteger(row.byte_end);
    const line = codexNonnegativeInteger(row.line);
    codexSafeInteger(row.timestamp_ms);
    if (
      line < 1 || line <= previousLine || byteStart < previousEnd ||
      byteEnd < byteStart || byteEnd - byteStart < originalBytes ||
      byteEnd > parsedOffset
    ) throw new TypeError("Inconsistent Codex physical row indexes.");
    validateCodexStatePayload(row.type, row.payload);
    if (
      row.argument_budget !== null && row.argument_budget !== "node" &&
      row.argument_budget !== "depth"
    ) throw new TypeError("Invalid Codex argument budget marker.");
    previousLine = line;
    previousEnd = byteEnd;
  }
  if (previousLine > lineCount || previousEnd > parsedOffset) {
    throw new TypeError("Codex parser-state progress is inconsistent.");
  }
  validateCodexDerivedState(
    cloned,
    cloned.rows as unknown as CodexStateRowV1[],
  );
  cloned.warnings.forEach((fact, index) =>
    validateCodexWarningFact(fact, index)
  );
  return cloned as unknown as CodexParserStateV1;
}

function codexWarningFact(
  warning: SourceWarning,
  order: number,
  timestampMs?: number,
): ParserStateWarningV1 {
  return {
    order,
    applicability: timestampMs === undefined
      ? { kind: "unconditional" }
      : { kind: "timestamp", timestamp_ms: timestampMs },
    scope: "source",
    target_session_id: null,
    warning,
  };
}

function codexStateTextField(value: unknown): CodexStateTextFieldV1 {
  if (value === undefined) return { kind: "missing" };
  if (typeof value === "string") return { kind: "text", value };
  return { kind: "invalid" };
}

function compactCodexStatePayload(
  type: string,
  payload: UnknownRecord,
): CodexStateRowV1["payload"] {
  if (type === "session_meta") {
    const git = isRecord(payload.git) ? payload.git : {};
    return {
      kind: "session_meta",
      session_id: nonEmptyString(payload.id) ??
        nonEmptyString(payload.session_id) ?? null,
      cwd: nonEmptyString(payload.cwd) ?? null,
      branch: nonEmptyString(git.branch) ?? null,
    };
  }
  if (type !== "response_item") return { kind: "auxiliary" };
  const subtype = nonEmptyString(payload.type);
  if (subtype === "message") {
    return {
      kind: "message",
      role: nonEmptyString(payload.role) ?? null,
      content: extractMessageText(payload.content),
    };
  }
  if (subtype === "function_call") {
    return {
      kind: "function_call",
      name: nonEmptyString(payload.name) ?? null,
      call_id: nonEmptyString(payload.call_id) ?? null,
      arguments: codexStateTextField(payload.arguments),
    };
  }
  if (subtype === "function_call_output") {
    return {
      kind: "function_call_output",
      call_id: nonEmptyString(payload.call_id) ?? null,
      output: codexStateTextField(payload.output),
    };
  }
  return { kind: "unknown", subtype: subtype ?? null };
}

function codexParsedTextField(value: CodexStateTextFieldV1): unknown {
  if (value.kind === "missing") return undefined;
  if (value.kind === "invalid") return null;
  return value.value;
}

function parsedCodexStatePayload(row: CodexStateRowV1): UnknownRecord {
  if (row.type === "session_meta") {
    return {
      ...(row.payload.session_id === null
        ? {}
        : { id: row.payload.session_id }),
      ...(row.payload.cwd === null ? {} : { cwd: row.payload.cwd }),
      ...(row.payload.branch === null
        ? {}
        : { git: { branch: row.payload.branch } }),
    };
  }
  if (row.type === "auxiliary") return {};
  const payload = row.payload;
  if (payload.kind === "message") {
    return {
      type: "message",
      ...(payload.role === null ? {} : { role: payload.role }),
      content: payload.content,
    };
  }
  if (payload.kind === "function_call") {
    const args = codexParsedTextField(payload.arguments);
    return {
      type: "function_call",
      ...(payload.name === null ? {} : { name: payload.name }),
      ...(payload.call_id === null ? {} : { call_id: payload.call_id }),
      ...(args === undefined ? {} : { arguments: args }),
    };
  }
  if (payload.kind === "function_call_output") {
    const output = codexParsedTextField(payload.output);
    return {
      type: "function_call_output",
      ...(payload.call_id === null ? {} : { call_id: payload.call_id }),
      ...(output === undefined ? {} : { output }),
    };
  }
  return payload.subtype === null ? {} : { type: payload.subtype };
}

function codexMetadata(rows: readonly CodexStateRowV1[]): CodexSessionMetadataV1 | null {
  const row = rows.find((candidate): candidate is Extract<
    CodexStateRowV1,
    { type: "session_meta" }
  > => candidate.type === "session_meta");
  if (row === undefined) return null;
  if (row.payload.session_id === null) return null;
  return {
    session_id: row.payload.session_id,
    cwd: row.payload.cwd,
    branch: row.payload.branch,
    line: row.line,
  };
}

function codexSeenSubtypes(rows: readonly CodexStateRowV1[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.type !== "response_item" || row.payload.kind !== "unknown") continue;
    const subtype = row.payload.subtype ?? undefined;
    if (
      subtype !== undefined && subtype !== "message" &&
      subtype !== "function_call" && subtype !== "function_call_output" &&
      !IGNORED_RESPONSE_ITEM_SUBTYPES.has(subtype)
    ) seen.add(subtype);
  }
  return [...seen];
}

function codexStateSkeleton(
  canonicalPath: string,
  parsedOffset: number,
  lineCount: number,
  endsWithNewline: boolean,
): CodexParserStateV1 {
  return {
    kind: "codex-state-v1",
    canonical_path: canonicalPath,
    parsed_offset: parsedOffset,
    line_count: lineCount,
    ends_with_newline: endsWithNewline,
    rows: [],
    session_metadata: null,
    seen_subtypes: [],
    warnings: [],
  };
}

async function codexRangeEndsWithNewline(
  handle: FileHandle,
  endOffset: number,
  emptyFallback: boolean,
): Promise<boolean> {
  if (endOffset === 0) return false;
  const byte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(byte, 0, 1, endOffset - 1);
  return bytesRead === 0 ? emptyFallback : byte[0] === 0x0a;
}

export async function readCodexParserState(options: {
  sourcePath: string;
  fileHandle: FileHandle;
  range?: { start_offset: number; starting_line: number };
  seed?: CodexParserStateV1;
  budgets?: Partial<ParserReadBudgets>;
  signal?: AbortSignal;
}): Promise<ParserStateReadResult<CodexParserStateV1>> {
  const seed = options.seed === undefined
    ? undefined
    : normalizeCodexParserState(options.seed);
  const startOffset = options.range?.start_offset ?? 0;
  const startingLine = options.range?.starting_line ?? 1;
  if (
    (seed === undefined && (startOffset !== 0 || startingLine !== 1)) ||
    (seed !== undefined && (
      seed.canonical_path !== options.sourcePath ||
      seed.parsed_offset !== startOffset ||
      seed.line_count + 1 !== startingLine
    ))
  ) throw new TypeError("Codex parser seed/range is inconsistent.");
  const configured = new JsonlBudgetTracker({
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const tracker = new JsonlBudgetTracker({
    budgets: {
      ...options.budgets,
      maxFileBytes: Math.max(0, configured.budgets.maxFileBytes - startOffset),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const stat = await options.fileHandle.stat();
  const rows = seed?.rows ?? [];
  const warnings = seed?.warnings ?? [];
  const initialSkeletonBytes = canonicalJsonBytes(codexStateSkeleton(
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
      pushStateWarning(codexWarningFact(warn(
        options.sourcePath,
        error.line,
        budgetWarningCode(error),
        error.message,
      ), warningOrder));
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
    const pushWarning = (value: SourceWarning, timestampMs?: number): void => {
      pushStateWarning(codexWarningFact(value, warningOrder, timestampMs));
      warningOrder += 1;
    };
    if (rawLine.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine) as unknown;
    } catch {
      pushWarning(warn(
        options.sourcePath,
        line,
        "codex_row_invalid",
        "Ignored malformed JSON row.",
      ));
      continue;
    }
    if (!isRecord(parsed)) {
      pushWarning(warn(
        options.sourcePath,
        line,
        "codex_row_invalid",
        "Ignored a non-object JSON row.",
      ));
      continue;
    }
    const timestampMs = parseTimestamp(parsed.timestamp);
    try {
      tracker.assertNodes(parsed, line);
    } catch (error) {
      tracker.throwIfAborted();
      if (!(error instanceof ParserBudgetExceededError)) throw error;
      pushWarning(warn(
        options.sourcePath,
        error.line,
        budgetWarningCode(error),
        error.message,
      ), timestampMs);
      continue;
    }
    if (timestampMs === undefined) {
      pushWarning(warn(
        options.sourcePath,
        line,
        "codex_row_invalid",
        "Ignored a row with an invalid or missing timestamp.",
      ));
      continue;
    }
    const type = nonEmptyString(parsed.type);
    if (type === undefined) {
      pushWarning(warn(
        options.sourcePath,
        line,
        "codex_row_invalid",
        "Ignored a row without a type.",
      ), timestampMs);
      continue;
    }
    if (!isRecord(parsed.payload)) {
      pushWarning(warn(
        options.sourcePath,
        line,
        "codex_row_invalid",
        "Ignored a row without a payload object.",
      ), timestampMs);
      continue;
    }
    let argumentBudget: Extract<ParserBudget, "node" | "depth"> | null = null;
    if (
      type === "response_item" &&
      parsed.payload.type === "function_call" &&
      typeof parsed.payload.arguments === "string"
    ) {
      try {
        const args: unknown = JSON.parse(parsed.payload.arguments);
        tracker.assertNodes(args, line);
      } catch (error) {
        tracker.throwIfAborted();
        if (error instanceof ParserBudgetExceededError) {
          if (error.budget === "node" || error.budget === "depth") {
            argumentBudget = error.budget;
          }
          pushWarning(warn(
            options.sourcePath,
            error.line,
            budgetWarningCode(error),
            error.message,
          ), timestampMs);
        }
      }
    }
    const range = jsonlLinePhysicalRange(inputLine);
    const stateRow = {
      kind: "codex-row-v1",
      original_bytes: rawBytes,
      byte_start: range.byte_start,
      byte_end: range.byte_end,
      line,
      timestamp_ms: timestampMs,
      type: type === "session_meta" || type === "response_item"
        ? type
        : "auxiliary",
      payload: compactCodexStatePayload(type, parsed.payload),
      argument_budget: argumentBudget,
    } as CodexStateRowV1;
    stateCapacity.addArrayItem(stateRow, rows.length);
    rows.push(stateRow);
  }
  if (receipt === undefined) throw new TypeError("Missing Codex read receipt.");
  lastLine = Math.max(lastLine, tracker.lastPhysicalLine);
  const completeness = receipt.end_offset === stat.size ? "complete" : "partial";
  if (
    completeness === "partial" &&
    !tracker.readStops.some((error) => error.budget === "file")
  ) {
    const error = new ParserBudgetExceededError("file", lastLine + 1);
    pushStateWarning(codexWarningFact(warn(
      options.sourcePath,
      error.line,
      budgetWarningCode(error),
      error.message,
    ), warningOrder));
  }
  const endsWithNewline = await codexRangeEndsWithNewline(
    options.fileHandle,
    receipt.end_offset,
    seed?.ends_with_newline ?? false,
  );
  const finalSkeletonBytes = canonicalJsonBytes(codexStateSkeleton(
    options.sourcePath,
    receipt.end_offset,
    lastLine,
    endsWithNewline,
  ));
  stateCapacity.replaceBytes(initialSkeletonBytes, finalSkeletonBytes);
  const sessionMetadata = codexMetadata(rows);
  if (sessionMetadata !== null) {
    stateCapacity.replaceBytes(4, canonicalJsonBytes(sessionMetadata));
  }
  const seenSubtypes = codexSeenSubtypes(rows);
  for (let index = 0; index < seenSubtypes.length; index += 1) {
    stateCapacity.addArrayItem(seenSubtypes[index], index);
  }
  const state: CodexParserStateV1 = {
    kind: "codex-state-v1",
    canonical_path: options.sourcePath,
    parsed_offset: receipt.end_offset,
    line_count: lastLine,
    ends_with_newline: endsWithNewline,
    rows,
    session_metadata: sessionMetadata,
    seen_subtypes: seenSubtypes,
    warnings,
  };
  return { state, receipt, completeness };
}

async function parseRows(
  options: ParseCodexSessionOptions,
): Promise<{ rows: ParsedRow[]; warnings: SourceWarning[];
  tracker: JsonlBudgetTracker;
  firstBudgetError: ParserBudgetExceededError | undefined }> {
  const { sourcePath, endedAtMs } = options;
  const tracker = new JsonlBudgetTracker(options);
  const warnings = boundedWarnings<SourceWarning>(
    tracker.budgets.maxWarnings,
    () => warn(
      sourcePath,
      undefined,
      "parser_warning_budget_exceeded",
      "Suppressed further parser warnings after reaching maxWarnings.",
    ),
  );
  const rows: ParsedRow[] = [];
  let firstBudgetError: ParserBudgetExceededError | undefined;

  try {
    for await (const inputLine of boundedJsonlLines(sourcePath, tracker)) {
      const { text: rawLine, bytes: rawBytes, line } = inputLine;
    if (rawLine.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      warnings.push(
        warn(sourcePath, line, "codex_row_invalid", "Ignored malformed JSON row."),
      );
      continue;
    }
    if (!isRecord(parsed)) {
      warnings.push(
        warn(sourcePath, line, "codex_row_invalid", "JSONL row is not an object."),
      );
      continue;
    }
    try {
      tracker.assertNodes(parsed, line);
    } catch (error) {
      tracker.throwIfAborted();
      if (!(error instanceof ParserBudgetExceededError)) throw error;
      firstBudgetError ??= error;
      warnings.push(
        warn(sourcePath, error.line, budgetWarningCode(error), error.message),
      );
      continue;
    }
    const timestampMs = parseTimestamp(parsed.timestamp);
    if (timestampMs === undefined) {
      warnings.push(
        warn(
          sourcePath,
          line,
          "codex_row_invalid",
          "Ignored a row with an invalid or missing timestamp.",
        ),
      );
      continue;
    }
    if (endedAtMs !== undefined && timestampMs > endedAtMs) continue;
    const type = nonEmptyString(parsed.type);
    if (type === undefined) {
      warnings.push(
        warn(sourcePath, line, "codex_row_invalid", "Ignored a row without a type."),
      );
      continue;
    }
    if (!isRecord(parsed.payload)) {
      warnings.push(
        warn(
          sourcePath,
          line,
          "codex_row_invalid",
          "Ignored a row without a payload object.",
        ),
      );
      continue;
    }

    try {
      tracker.retain(rawBytes, line);
    } catch (error) {
      tracker.throwIfAborted();
      if (!(error instanceof ParserBudgetExceededError)) throw error;
      firstBudgetError ??= error;
      warnings.push(
        warn(sourcePath, error.line, budgetWarningCode(error), error.message),
      );
      break;
    }
    rows.push({ type, payload: parsed.payload, timestampMs, line });
    }
  } catch (error) {
    tracker.throwIfAborted();
    if (!(error instanceof ParserBudgetExceededError)) throw error;
    firstBudgetError ??= error;
    warnings.push(
      warn(sourcePath, error.line, budgetWarningCode(error), error.message),
    );
  }

  return { rows, warnings, tracker, firstBudgetError };
}

/** Joins string `text` parts out of a Codex message `content` field. */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (item): item is UnknownRecord =>
        isRecord(item) && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("");
}

function applyPatchPaths(patchBody: string): string[] {
  const paths: string[] = [];
  for (const line of patchBody.split(/\r?\n/u)) {
    const path = APPLY_PATCH_FILE_HEADER.exec(line)?.[1]?.trim();
    if (path !== undefined && path.length > 0) {
      paths.push(path);
    }
  }
  return [...new Set(paths)];
}

function isInjectedUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return INJECTED_USER_TEXT_PREFIXES.some((prefix) =>
    trimmed.startsWith(prefix),
  );
}

interface ResolvedOutput {
  text: string;
  metadataExitCode: number | undefined;
}

/**
 * `function_call_output.payload.output` is usually plain text, but may
 * itself be a JSON string wrapping `{"output": "...", "metadata": {...}}`.
 * When it parses as such, the inner `output` text is what should be scanned
 * for an exit code (unless a numeric `metadata.exit_code` is present, which
 * takes priority over text scanning); otherwise the raw string is used as-is
 * and there is no structured exit code.
 */
function resolveOutput(raw: string): ResolvedOutput {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const metadata = parsed.metadata;
      const metadataExitCode =
        isRecord(metadata) &&
        typeof metadata.exit_code === "number" &&
        Number.isFinite(metadata.exit_code) &&
        Number.isInteger(metadata.exit_code)
          ? metadata.exit_code
          : undefined;
      const text = typeof parsed.output === "string" ? parsed.output : raw;
      return { text, metadataExitCode };
    }
  } catch {
    // Not JSON; fall through to the raw string.
  }
  return { text: raw, metadataExitCode: undefined };
}

interface EventBaseFields {
  timestamp_ms: number;
  session_id: string;
  entry_uuid: string;
  session_ref: string;
  source_index: number;
  agent_id: string;
  is_sidechain: boolean;
  confidence: Confidence;
}

function eventBase(
  row: ParsedRow,
  sessionId: string,
  baseConfidence: Confidence,
  hasSchemaLoss: boolean,
): EventBaseFields {
  const entryUuid = `line-${row.line.toString(10)}`;
  return {
    timestamp_ms: row.timestampMs,
    session_id: sessionId,
    entry_uuid: entryUuid,
    session_ref: makeSessionRef(sessionId, entryUuid),
    source_index: row.line,
    agent_id: sessionId,
    is_sidechain: false,
    confidence: baseConfidence === "low" || hasSchemaLoss ? "low" : "high",
  };
}

function buildMessageEvent(
  row: ParsedRow,
  sessionId: string,
  baseConfidence: Confidence,
): GenuineUserEvent | AssistantEvent | undefined {
  const role = row.payload.role;
  const text = extractMessageText(row.payload.content);
  if (text.length === 0) {
    return undefined;
  }
  if (role === "user") {
    if (isInjectedUserText(text)) {
      return undefined;
    }
    return {
      ...eventBase(row, sessionId, baseConfidence, false),
      kind: "genuine_user",
      text,
    };
  }
  if (role === "assistant") {
    return {
      ...eventBase(row, sessionId, baseConfidence, false),
      kind: "assistant",
      text,
    };
  }
  return undefined;
}

function buildFunctionCallEvent(
  row: ParsedRow,
  sessionId: string,
  baseConfidence: Confidence,
  warnings: SourceWarning[],
  sourcePath: string,
  sessionCwd: string | undefined,
  tracker: JsonlBudgetTracker,
  onBudgetError: (error: ParserBudgetExceededError) => void,
): ToolUseEvent | undefined {
  const callId = nonEmptyString(row.payload.call_id);
  const name = nonEmptyString(row.payload.name);
  if (callId === undefined || name === undefined) {
    warnings.push(
      warn(
        sourcePath,
        row.line,
        "codex_row_invalid",
        "Ignored a function_call row without a call_id or name.",
      ),
    );
    return undefined;
  }

  let input: JsonObject = {};
  let hasSchemaLoss = false;
  const argumentsRaw = row.payload.arguments;
  if (typeof argumentsRaw === "string") {
    try {
      const parsedArguments: unknown = JSON.parse(argumentsRaw);
      tracker.assertNodes(parsedArguments, row.line);
      if (isRecord(parsedArguments)) {
        input = parsedArguments as JsonObject;
      } else {
        hasSchemaLoss = true;
      }
    } catch (error) {
      tracker.throwIfAborted();
      if (error instanceof ParserBudgetExceededError) {
        onBudgetError(error);
        warnings.push(warn(sourcePath, error.line,
          budgetWarningCode(error), error.message));
        return undefined;
      }
      hasSchemaLoss = true;
    }
    if (hasSchemaLoss) {
      warnings.push(
        warn(
          sourcePath,
          row.line,
          "codex_invalid_tool_arguments",
          "Failed to parse function_call arguments as a JSON object; used an empty input fallback.",
          makeSessionRef(sessionId, `line-${row.line.toString(10)}`),
        ),
      );
    }
  } else if (argumentsRaw !== undefined) {
    hasSchemaLoss = true;
    warnings.push(
      warn(
        sourcePath,
        row.line,
        "codex_invalid_tool_arguments",
        "function_call arguments field was not a string; used an empty input fallback.",
        makeSessionRef(sessionId, `line-${row.line.toString(10)}`),
      ),
    );
  }

  const cwd =
    nonEmptyString(input.workdir) ??
    nonEmptyString(input.cwd) ??
    sessionCwd;
  let command: string | undefined;
  if (name === "exec_command" || name === "shell") {
    const cmdValue = input.cmd ?? input.command;
    if (typeof cmdValue === "string" && cmdValue.length > 0) {
      command = cmdValue;
    } else if (Array.isArray(cmdValue)) {
      const parts = cmdValue.filter(
        (part): part is string => typeof part === "string",
      );
      if (parts.length > 0) {
        command = parts.join(" ");
      }
    }
  }

  let paths: string[] = [];
  let editFragments: string[] = [];
  if (name === "apply_patch") {
    const patchBody = nonEmptyString(input.input);
    if (patchBody !== undefined) {
      editFragments = [patchBody];
      paths = applyPatchPaths(patchBody);
    }
    if (paths.length === 0) {
      warnings.push(
        warn(
          sourcePath,
          row.line,
          "codex_apply_patch_no_paths",
          "apply_patch arguments contained no recognizable file headers; edit paths are unavailable.",
          makeSessionRef(sessionId, `line-${row.line.toString(10)}`),
        ),
      );
    }
  }

  return {
    ...eventBase(row, sessionId, baseConfidence, hasSchemaLoss),
    kind: "tool_use",
    tool_use_id: callId,
    tool_name: name,
    input,
    paths,
    edit_fragments: editFragments,
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

function buildFunctionCallOutputEvent(
  row: ParsedRow,
  sessionId: string,
  baseConfidence: Confidence,
  warnings: SourceWarning[],
  sourcePath: string,
): ToolResultEvent | undefined {
  const callId = nonEmptyString(row.payload.call_id);
  const rawOutput = row.payload.output;
  if (callId === undefined || typeof rawOutput !== "string") {
    warnings.push(
      warn(
        sourcePath,
        row.line,
        "codex_row_invalid",
        "Ignored a function_call_output row without a call_id or output string.",
      ),
    );
    return undefined;
  }

  const { text, metadataExitCode } = resolveOutput(rawOutput);
  const match = EXIT_CODE_PATTERN.exec(text);
  const parsedTextExitCode =
    match?.[1] !== undefined ? Number(match[1]) : undefined;
  const textExitCode =
    parsedTextExitCode !== undefined && Number.isFinite(parsedTextExitCode)
      ? parsedTextExitCode
      : undefined;
  const exitCode = metadataExitCode ?? textExitCode;
  const statusForExitCode = (code: number): ToolResultStatus =>
    code === 0 ? "success" : "failure";
  const statusEvidence: ResultStatusEvidence =
    metadataExitCode !== undefined
      ? {
          status: statusForExitCode(metadataExitCode),
          source: "exit_code",
          confidence: "high",
        }
      : textExitCode !== undefined
        ? {
            status: statusForExitCode(textExitCode),
            source: "tool_adapter",
            confidence: "medium",
          }
        : { status: "unknown", source: "none", confidence: "low" };

  return {
    ...eventBase(row, sessionId, baseConfidence, false),
    kind: "tool_result",
    tool_use_id: callId,
    status: statusEvidence.status,
    status_evidence: statusEvidence,
    output: text,
    output_bytes: Buffer.byteLength(text),
    estimated_tokens: Math.ceil(text.length / 4),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
  };
}

function projectCodexRows(
  sourcePath: string,
  rows: ParsedRow[],
  warnings: SourceWarning[],
  tracker: JsonlBudgetTracker,
  initialBudgetError?: ParserBudgetExceededError,
): Session | null {
  let firstBudgetError = initialBudgetError;
  const sessionMetaRow = rows.find((row) => row.type === "session_meta");
  let sessionMetaId: string | undefined;
  let sessionMetaCwd: string | undefined;
  let sessionMetaBranch: string | undefined;
  if (sessionMetaRow !== undefined) {
    sessionMetaId =
      nonEmptyString(sessionMetaRow.payload.id) ??
      nonEmptyString(sessionMetaRow.payload.session_id);
    sessionMetaCwd = nonEmptyString(sessionMetaRow.payload.cwd);
    const git = sessionMetaRow.payload.git;
    if (isRecord(git)) {
      sessionMetaBranch = nonEmptyString(git.branch);
    }
  }

  const hasResponseItems = rows.some((row) => row.type === "response_item");
  const sessionId = sessionMetaId ?? fileNameStem(sourcePath);
  const confidence: Confidence = sessionMetaId !== undefined ? "high" : "low";
  if (sessionMetaId === undefined && hasResponseItems) {
    warnings.push(
      warn(
        sourcePath,
        sessionMetaRow?.line,
        "codex_missing_session_meta",
        "No session_meta row with a session id was found; fell back to the file name for the session id.",
      ),
    );
  }

  const events: NormalizedEvent[] = [];
  const warnedUnknownSubtypes = new Set<string>();
  for (const row of rows) {
    tracker.throwIfAborted();
    if (row.type !== "response_item") {
      continue;
    }
    const payloadType = nonEmptyString(row.payload.type);
    if (payloadType === "message") {
      const event = buildMessageEvent(row, sessionId, confidence);
      if (event !== undefined) {
        events.push(event);
      }
      continue;
    }
    if (payloadType === "function_call") {
      const event = buildFunctionCallEvent(
        row,
        sessionId,
        confidence,
        warnings,
        sourcePath,
        sessionMetaCwd,
        tracker,
        (error) => { firstBudgetError ??= error; },
      );
      if (event !== undefined) {
        events.push(event);
      }
      continue;
    }
    if (payloadType === "function_call_output") {
      const event = buildFunctionCallOutputEvent(
        row,
        sessionId,
        confidence,
        warnings,
        sourcePath,
      );
      if (event !== undefined) {
        events.push(event);
      }
      continue;
    }
    // Any other response_item subtype is intentionally not converted to a
    // normalized event; warn once per distinct subtype unless ignored.
    if (
      payloadType !== undefined &&
      !IGNORED_RESPONSE_ITEM_SUBTYPES.has(payloadType) &&
      !warnedUnknownSubtypes.has(payloadType)
    ) {
      warnedUnknownSubtypes.add(payloadType);
      warnings.push(
        warn(
          sourcePath,
          row.line,
          "codex_unknown_response_item",
          `Ignored a response_item with an unhandled payload type "${payloadType}".`,
          makeSessionRef(sessionId, `line-${row.line.toString(10)}`),
        ),
      );
    }
  }

  if (events.length === 0) {
    if (firstBudgetError !== undefined) throw firstBudgetError;
    return null;
  }

  let startedAtMs = events[0]!.timestamp_ms;
  let endedAtMs = startedAtMs;
  for (const event of events) {
    startedAtMs = Math.min(startedAtMs, event.timestamp_ms);
    endedAtMs = Math.max(endedAtMs, event.timestamp_ms);
  }
  const observedCwds = [...new Set([
    ...(sessionMetaCwd === undefined ? [] : [sessionMetaCwd]),
    ...events.flatMap((event) =>
      event.kind === "tool_use" &&
        event.cwd !== undefined &&
        event.cwd !== ""
        ? [event.cwd]
        : []
    ),
  ])];

  return {
    session_id: sessionId,
    source: "codex",
    source_path: sourcePath,
    observed_cwds: observedCwds,
    observed_branches:
      sessionMetaBranch !== undefined ? [sessionMetaBranch] : [],
    started_at_ms: startedAtMs,
    ended_at_ms: endedAtMs,
    confidence,
    events,
    warnings,
    capabilities: ["tool_timestamps", "edit_fragments"],
  };
}

function budgetErrorFromWarning(
  warning: SourceWarning,
): ParserBudgetExceededError | undefined {
  const match = /^parser_(file|line|node|depth)_budget_exceeded$/u.exec(
    warning.code,
  );
  if (match?.[1] === undefined) return undefined;
  return new ParserBudgetExceededError(
    match[1] as Extract<ParserBudget, "file" | "line" | "node" | "depth">,
    warning.line,
  );
}

export function projectCodexParserState(
  value: CodexParserStateV1,
  options: {
    endedAtMs?: number;
    budgets?: Partial<ParserProjectionBudgets>;
    signal?: AbortSignal;
  } = {},
): Session | null {
  const state = normalizeCodexParserState(value);
  const tracker = new JsonlBudgetTracker({
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const rows: ParsedRow[] = [];
  let retainedFailure: ParserBudgetExceededError | undefined;
  let firstBudgetError: ParserBudgetExceededError | undefined;
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
      firstBudgetError ??= error;
      break;
    }
    if (row.argument_budget !== null) {
      firstBudgetError ??= new ParserBudgetExceededError(
        row.argument_budget,
        row.line,
      );
      continue;
    }
    rows.push({
      type: row.type,
      payload: parsedCodexStatePayload(row),
      timestampMs: row.timestamp_ms,
      line: row.line,
    });
  }
  const warnings = boundedWarnings<SourceWarning>(
    tracker.budgets.maxWarnings,
    () => warn(
      state.canonical_path,
      undefined,
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
    const sourceWarning = structuredClone(fact.warning);
    warnings.push(sourceWarning);
    firstBudgetError ??= budgetErrorFromWarning(sourceWarning);
  }
  if (retainedFailure !== undefined) {
    warnings.push(warn(
      state.canonical_path,
      retainedFailure.line,
      budgetWarningCode(retainedFailure),
      retainedFailure.message,
    ));
  }
  return projectCodexRows(
    state.canonical_path,
    rows,
    warnings,
    tracker,
    firstBudgetError,
  );
}

async function parseCodexSessionLegacy(
  options: ParseCodexSessionOptions,
): Promise<Session | null> {
  const { rows, warnings, tracker, firstBudgetError } = await parseRows(options);
  return projectCodexRows(
    options.sourcePath,
    rows,
    warnings,
    tracker,
    firstBudgetError,
  );
}

export async function parseCodexSession(
  options: ParseCodexSessionOptions,
): Promise<Session | null> {
  const fileHandle = await openFile(options.sourcePath, "r");
  try {
    try {
      const read = await readCodexParserState({
        sourcePath: options.sourcePath,
        fileHandle,
        ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return projectCodexParserState(read.state, {
        ...(options.endedAtMs === undefined
          ? {}
          : { endedAtMs: options.endedAtMs }),
        ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (!(error instanceof IncrementalParserStateCapacityError)) throw error;
    }
  } finally {
    await fileHandle.close();
  }
  return parseCodexSessionLegacy(options);
}
