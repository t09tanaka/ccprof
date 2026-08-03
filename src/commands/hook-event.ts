import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  analyze as analyzeCore,
  type AnalyzeOptions,
  type AnalyzeResult,
} from "../core/analyze.js";
import type { Finding } from "../core/model.js";
import {
  resolveStorePaths,
  type StorePaths,
} from "../store/paths.js";
import type { CommandExecutionResult } from "./analyze.js";
import { resolveCurrentRepoRoot } from "./stats.js";

const THROTTLE_WINDOW_MS = 10 * 60 * 1_000;
const NOTIFIED_EVENT_NAME = "ccprof_notified";
const MAX_HOOK_EVENTS_BYTES = 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

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
  ) => Promise<Pick<AnalyzeResult, "report">>;
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
 * callers must not append a row in that case. Also returns `undefined`
 * when both fields are missing/non-string: a row with neither field is
 * useless to the throttle/analysis reader and is treated the same as
 * malformed input rather than appended.
 */
function parsePayload(stdinText: string): HookPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdinText);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sessionId = record.session_id;
  const hookEventName = record.hook_event_name;
  const session_id = typeof sessionId === "string" ? sessionId : "";
  const hook_event_name = typeof hookEventName === "string"
    ? hookEventName
    : "";
  if (session_id === "" && hook_event_name === "") return undefined;
  return { session_id, hook_event_name };
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

/**
 * Bounds the event log in place once an append pushes it past
 * `MAX_HOOK_EVENTS_BYTES`. The common path costs a single `stat`; only an
 * oversized log is read, filtered, and rewritten:
 *
 * 1. valid rows (per `isHookEventLogRow`) newer than `RETENTION_MS` are
 *    kept, malformed lines are discarded;
 * 2. if the retained rows still exceed the byte cap, only the newest
 *    suffix that fits is kept (absolute upper bound), preserving the
 *    original relative order;
 * 3. the result replaces the log via temp file + fsync + rename (the same
 *    lock-free atomic-write pattern as `writeJsonAtomically` in
 *    `src/store/analyses.ts`).
 *
 * Like the throttle read below, this read-then-rename is a benign TOCTOU
 * accepted by design: a concurrent Stop hook may append a row between the
 * read and the rename, and that row is lost. Compaction only triggers at
 * the 1 MiB boundary, so the race is rare and costs at most the last row
 * or two - no lock is added. Any failure (unreadable log, unwritable
 * directory) is swallowed: compaction is best-effort and must never fail
 * the hook.
 */
async function maybeCompactHookEvents(
  path: string,
  nowMs: number,
): Promise<void> {
  try {
    const info = await stat(path);
    if (info.size <= MAX_HOOK_EVENTS_BYTES) return;
    await compactHookEventFile(path, nowMs);
  } catch {
    // Best-effort: an unbounded log is preferable to a failing hook.
  }
}

async function compactHookEventFile(
  path: string,
  nowMs: number,
  source?: string,
): Promise<number> {
  const text = source ?? await readFile(path, "utf8");
  const input = text.split("\n").filter((line) => line.trim() !== "");
  const cutoffMs = nowMs - RETENTION_MS;
  const kept = input.filter((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return isHookEventLogRow(parsed) && parsed.received_at_ms >= cutoffMs;
    } catch {
      return false;
    }
  });

  let suffixStart = kept.length;
  let suffixBytes = 0;
  while (suffixStart > 0) {
    const line = kept[suffixStart - 1];
    if (line === undefined) break;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (suffixBytes + lineBytes > MAX_HOOK_EVENTS_BYTES) break;
    suffixBytes += lineBytes;
    suffixStart -= 1;
  }
  const retained = kept.slice(suffixStart);
  const output = retained.map((line) => `${line}\n`).join("");
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(output, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return input.length - retained.length;
}

/** Force compaction for explicit maintenance, propagating unsafe-path and I/O
 * failures instead of weakening the always-successful hook command. */
export async function compactHookEventsStrict(
  path: string,
  nowMs: number,
): Promise<number> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (!before.isFile()) throw new Error("hook event log is not a regular file");
  const handle = await open(path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("hook event log changed while opening");
    }
    text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error("hook event log changed while reading");
    }
  } finally {
    await handle.close();
  }
  return compactHookEventFile(path, nowMs, text);
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

/**
 * Summarizes from `report.findings`, not `allFindings`: the report is
 * already dismissal-applied and filtered to `recoverable.min > 0`, so a
 * finding the user dismissed via `ccprof dismiss` (14-day suppression) or
 * one below the recoverable threshold never resurfaces here.
 */
function notifyStdout(findings: Finding[]): string {
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
    await maybeCompactHookEvents(paths.hook_events_path, nowMs);

    if (options.notify !== true) return SILENT_SUCCESS;

    // Two simultaneous Stop hooks (e.g. concurrent agent turns racing on
    // the same repo) can both read `rows` before either append lands below
    // and thus both observe "not throttled" - a benign TOCTOU accepted by
    // design: the worst outcome is one duplicate notification, not a
    // correctness issue.
    const rows = await readEventRows(paths.hook_events_path);
    if (isThrottled(rows, nowMs)) return SILENT_SUCCESS;

    // The throttle marker is written before `analyze` runs, not after it
    // succeeds. This is deliberate: if `analyze` is consistently failing
    // (e.g. a broken repo state), each 10-minute window still gets marked
    // "notified" and the next attempt waits out the full window rather
    // than re-running an expensive failing analysis on every subsequent
    // turn. The trade-off is that a transient failure also burns a window
    // silently, which is judged an acceptable cost for bounding retry cost.
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
      return { stdout: notifyStdout(result.report.findings), warnings: [] };
    } catch {
      // analyze failures (exit 3/4/5-equivalent exceptions, and anything
      // else) must never surface: --notify is best-effort.
      return SILENT_SUCCESS;
    }
  } catch {
    return SILENT_SUCCESS;
  }
}
