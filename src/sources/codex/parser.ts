import { basename } from "node:path";

import {
  makeSessionRef,
  type AssistantEvent,
  type Confidence,
  type GenuineUserEvent,
  type JsonObject,
  type NormalizedEvent,
  type Session,
  type SourceWarning,
  type ToolResultEvent,
  type ToolResultStatus,
  type ToolUseEvent,
} from "../../core/model.js";

/**
 * Codex rollout logs are one JSON object per line:
 * `{"timestamp": ISO8601, "type": "session_meta"|"turn_context"|"response_item"|"event_msg", "payload": {...}}`.
 *
 * Unlike the Claude parser, this module works over an already-read `raw`
 * string rather than streaming a file, and always yields at most one
 * `Session` per call (a rollout file represents a single Codex session).
 */
export interface ParseCodexSessionOptions {
  sourcePath: string;
  raw: string;
}

type UnknownRecord = Record<string, unknown>;

const INJECTED_USER_TEXT_PREFIXES = [
  "<user_instructions>",
  "<environment_context>",
  "<turn_context>",
];

const EXIT_CODE_PATTERN = /^Process exited with code (\d+)/u;

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

function parseRows(
  sourcePath: string,
  raw: string,
): { rows: ParsedRow[]; warnings: SourceWarning[] } {
  const warnings: SourceWarning[] = [];
  const rows: ParsedRow[] = [];
  const lines = raw.split(/\r\n|\r|\n/);

  lines.forEach((rawLine, index) => {
    const line = index + 1;
    if (rawLine.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      warnings.push(
        warn(sourcePath, line, "codex_row_invalid", "Ignored malformed JSON row."),
      );
      return;
    }
    if (!isRecord(parsed)) {
      warnings.push(
        warn(sourcePath, line, "codex_row_invalid", "JSONL row is not an object."),
      );
      return;
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
      return;
    }
    const type = nonEmptyString(parsed.type);
    if (type === undefined) {
      warnings.push(
        warn(sourcePath, line, "codex_row_invalid", "Ignored a row without a type."),
      );
      return;
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
      return;
    }

    rows.push({ type, payload: parsed.payload, timestampMs, line });
  });

  return { rows, warnings };
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
        isRecord(metadata) && typeof metadata.exit_code === "number"
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
      if (isRecord(parsedArguments)) {
        input = parsedArguments as JsonObject;
      } else {
        hasSchemaLoss = true;
      }
    } catch {
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

  let command: string | undefined;
  let cwd: string | undefined;
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
    if (typeof input.workdir === "string" && input.workdir.length > 0) {
      cwd = input.workdir;
    }
  }

  let paths: string[] = [];
  let editFragments: string[] = [];
  if (name === "apply_patch") {
    const patchBody =
      typeof input.input === "string" ? input.input : undefined;
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
  const textExitCode = match?.[1] !== undefined ? Number(match[1]) : undefined;
  const exitCode = metadataExitCode ?? textExitCode;
  const status: ToolResultStatus =
    exitCode === undefined ? "unknown" : exitCode === 0 ? "success" : "failure";

  return {
    ...eventBase(row, sessionId, baseConfidence, false),
    kind: "tool_result",
    tool_use_id: callId,
    status,
    output: text,
    output_bytes: Buffer.byteLength(text),
    estimated_tokens: Math.ceil(text.length / 4),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
  };
}

export function parseCodexSession(
  options: ParseCodexSessionOptions,
): Session | null {
  const { sourcePath, raw } = options;
  const { rows, warnings } = parseRows(sourcePath, raw);

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
    return null;
  }

  const timestamps = events.map((event) => event.timestamp_ms);

  return {
    session_id: sessionId,
    source: "codex",
    source_path: sourcePath,
    observed_cwds: sessionMetaCwd !== undefined ? [sessionMetaCwd] : [],
    observed_branches:
      sessionMetaBranch !== undefined ? [sessionMetaBranch] : [],
    started_at_ms: Math.min(...timestamps),
    ended_at_ms: Math.max(...timestamps),
    confidence,
    events,
    warnings,
    capabilities: ["tool_timestamps"],
  };
}
