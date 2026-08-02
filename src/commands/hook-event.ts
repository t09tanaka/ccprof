import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  analyze as analyzeCore,
  type AnalyzeOptions,
  type AnalyzeResult,
} from "../core/analyze.js";
import {
  resolveStorePaths,
  type StorePaths,
} from "../store/paths.js";
import type { CommandExecutionResult } from "./analyze.js";
import { resolveCurrentRepoRoot } from "./stats.js";

const THROTTLE_WINDOW_MS = 10 * 60 * 1_000;
const NOTIFIED_EVENT_NAME = "ccprof_notified";

export interface HookEventCommandOptions {
  cwd: string;
  stdinText: string;
  nowMs?: number;
  notify?: boolean;
}

export interface HookEventCommandDependencies {
  resolveRepoRoot?: (cwd: string) => Promise<string>;
  resolveStorePaths?: (repoRoot: string) => Promise<StorePaths>;
  analyze?: (
    options: AnalyzeOptions,
  ) => Promise<Pick<AnalyzeResult, "allFindings">>;
}

interface HookPayload {
  session_id: string;
  hook_event_name: string;
}

interface HookEventLogRow {
  received_at_ms: number;
  session_id: string;
  hook_event_name: string;
}

/**
 * Parses the hook payload Claude Code writes to stdin. Only the two fields
 * the event log needs are extracted; anything else on the payload (cwd,
 * transcript_path, ...) is ignored. Returns `undefined` for anything that
 * isn't a JSON object, per the "silent success on bad input" contract -
 * callers must not append a row in that case.
 */
function parsePayload(stdinText: string): HookPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdinText);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const sessionId = record.session_id;
  const hookEventName = record.hook_event_name;
  return {
    session_id: typeof sessionId === "string" ? sessionId : "",
    hook_event_name: typeof hookEventName === "string" ? hookEventName : "",
  };
}

function isHookEventLogRow(value: unknown): value is HookEventLogRow {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Number.isFinite(record.received_at_ms) &&
    typeof record.session_id === "string" &&
    typeof record.hook_event_name === "string";
}

async function appendEventRow(
  path: string,
  row: HookEventLogRow,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
}

/** Reads the throttle decision input. Any read/parse failure (including a
 * missing file, i.e. no prior events) is treated as "no rows" rather than
 * an error - the throttle check degrades to "not throttled" rather than
 * blocking the whole command. */
async function readEventRows(path: string): Promise<HookEventLogRow[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const rows: HookEventLogRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isHookEventLogRow(parsed)) rows.push(parsed);
    } catch {
      // Malformed line: skip it and keep reading the rest of the log.
    }
  }
  return rows;
}

/**
 * True when a `ccprof_notified` row was recorded within the throttle
 * window ending at `nowMs`. The check is a pure function of the event log
 * plus `nowMs`, so it stays deterministic under injected clocks in tests.
 */
function isThrottled(
  rows: readonly HookEventLogRow[],
  nowMs: number,
): boolean {
  return rows.some((row) => {
    if (row.hook_event_name !== NOTIFIED_EVENT_NAME) return false;
    const ageMs = nowMs - row.received_at_ms;
    return ageMs >= 0 && ageMs < THROTTLE_WINDOW_MS;
  });
}

function notifyStdout(findings: AnalyzeResult["allFindings"]): string {
  if (findings.length === 0) return "";
  const count = findings.length;
  const top = findings[0];
  const lines = [`${count} finding${count === 1 ? "" : "s"}`];
  if (top !== undefined && top.title.trim() !== "") lines.push(top.title);
  return `${lines.join("\n")}\n`;
}

const SILENT_SUCCESS: CommandExecutionResult = { stdout: "", warnings: [] };

/**
 * Always-exit-0 hook entrypoint: any failure here (bad JSON, no repo,
 * unwritable store, a throwing `analyze`) must degrade to silent success
 * rather than propagate, since Claude Code treats a nonzero hook exit as a
 * blocking failure. The whole body is one try/catch for exactly that
 * reason; see also `runCli`'s hook-event dispatch, which wraps this call a
 * second time for defense in depth.
 */
export async function runHookEventCommand(
  options: HookEventCommandOptions,
  dependencies: HookEventCommandDependencies = {},
): Promise<CommandExecutionResult> {
  try {
    const payload = parsePayload(options.stdinText);
    if (payload === undefined) return SILENT_SUCCESS;

    const repoRoot = await (
      dependencies.resolveRepoRoot ?? resolveCurrentRepoRoot
    )(options.cwd);
    const paths = await (
      dependencies.resolveStorePaths ?? resolveStorePaths
    )(repoRoot);
    const nowMs = options.nowMs ?? Date.now();

    await appendEventRow(paths.hook_events_path, {
      received_at_ms: nowMs,
      session_id: payload.session_id,
      hook_event_name: payload.hook_event_name,
    });

    if (options.notify !== true) return SILENT_SUCCESS;

    const rows = await readEventRows(paths.hook_events_path);
    if (isThrottled(rows, nowMs)) return SILENT_SUCCESS;

    await appendEventRow(paths.hook_events_path, {
      received_at_ms: nowMs,
      session_id: payload.session_id,
      hook_event_name: NOTIFIED_EVENT_NAME,
    });

    try {
      const analyze = dependencies.analyze ?? analyzeCore;
      const result = await analyze({
        cwd: options.cwd,
        nowMs,
        persist: false,
      });
      return { stdout: notifyStdout(result.allFindings), warnings: [] };
    } catch {
      // analyze failures (exit 3/4/5-equivalent exceptions, and anything
      // else) must never surface: --notify is best-effort.
      return SILENT_SUCCESS;
    }
  } catch {
    return SILENT_SUCCESS;
  }
}
