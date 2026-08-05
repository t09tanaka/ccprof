import { readFile } from "node:fs/promises";

import type { Session } from "../core/model.js";
import { matchesBuiltinSourceAdapterId } from "../core/source-identity.js";
import type { StoreWarning } from "../store/analyses.js";

/**
 * A 30-minute upper bound on how far past a session's log-derived
 * `ended_at_ms` a hook-recorded `Stop` event may extend it. Hook events are
 * keyed only by `session_id`; without this guard a stale or misdirected row
 * (e.g. the log rotated, or a retried hook write) could stitch an unrelated
 * later timestamp onto this session's span instead of degrading safely.
 */
export const HOOK_EVENT_END_WINDOW_MS = 30 * 60 * 1_000;

const STOP_HOOK_EVENT_NAME = "Stop";

export interface HookEventRow {
  received_at_ms: number;
  session_id: string;
  hook_event_name: string;
}

export interface HookEventLoadResult {
  rows: HookEventRow[];
  warnings: StoreWarning[];
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

function isHookEventRow(value: unknown): value is HookEventRow {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Number.isFinite(record.received_at_ms) &&
    typeof record.session_id === "string" &&
    typeof record.hook_event_name === "string";
}

/**
 * Reads the hook-recorded event log `ccprof hook-event` appends to
 * (`{received_at_ms, session_id, hook_event_name}` rows, one per line). A
 * missing file is the common case (no hook has fired yet for this repo) and
 * degrades to an empty result without a warning. Unreadable lines - bad
 * JSON, or JSON missing/mistyping a required field - are skipped and folded
 * into a single aggregate warning carrying the count, rather than one
 * warning per line, so a noisy log doesn't flood the report.
 */
export async function loadHookEvents(
  path: string,
): Promise<HookEventLoadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { rows: [], warnings: [] };
    }
    return {
      rows: [],
      warnings: [{
        code: "hook_events_invalid_rows",
        message: `Hook events were skipped: ${errorMessage(error)}`,
        path,
      }],
    };
  }
  const rows: HookEventRow[] = [];
  let invalidCount = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isHookEventRow(parsed)) {
        rows.push(parsed);
      } else {
        invalidCount += 1;
      }
    } catch {
      invalidCount += 1;
    }
  }
  const warnings: StoreWarning[] = invalidCount === 0 ? [] : [{
    code: "hook_events_invalid_rows",
    message:
      `${invalidCount} hook event row${invalidCount === 1 ? "" : "s"} ` +
      "were skipped as invalid or corrupt.",
    path,
  }];
  return { rows, warnings };
}

/**
 * Extends each session's `ended_at_ms` to the latest hook-recorded `Stop`
 * wall-clock time that both follows it and falls within
 * `HOOK_EVENT_END_WINDOW_MS` after it, and records that same value as
 * `verified_ended_at_ms` so timeline building can tell a hook-corroborated
 * end from a plain log timestamp. Rows for a different `hook_event_name`
 * (including the `ccprof_notified` throttle marker), rows for a
 * non-matching `session_id`, and in-range-but-wrong-direction or
 * out-of-window rows are all ignored. Pure: sessions with no applicable row
 * are returned unchanged (by reference); only sessions that actually gain a
 * later end time get a new object.
 */
export function applyHookEvents(
  sessions: readonly Session[],
  rows: readonly HookEventRow[],
): Session[] {
  const sessionIdCounts = new Map<string, number>();
  for (const session of sessions) {
    sessionIdCounts.set(
      session.session_id,
      (sessionIdCounts.get(session.session_id) ?? 0) + 1,
    );
  }
  const stopTimesBySessionId = new Map<string, number[]>();
  for (const row of rows) {
    if (row.hook_event_name !== STOP_HOOK_EVENT_NAME) continue;
    const existing = stopTimesBySessionId.get(row.session_id);
    if (existing === undefined) {
      stopTimesBySessionId.set(row.session_id, [row.received_at_ms]);
    } else {
      existing.push(row.received_at_ms);
    }
  }
  return sessions.map((session) => {
    const mainAgents = new Set(
      session.events
        .filter((event) => !event.is_sidechain)
        .map((event) => event.agent_id),
    );
    if (
      !matchesBuiltinSourceAdapterId(session.source, "claude") ||
      sessionIdCounts.get(session.session_id) !== 1 ||
      session.observed_branches.length > 1 ||
      mainAgents.size !== 1
    ) {
      return session;
    }
    const stopTimes = stopTimesBySessionId.get(session.session_id);
    if (stopTimes === undefined) return session;
    const inWindow = stopTimes.filter(
      (receivedAtMs) =>
        receivedAtMs > session.ended_at_ms &&
        receivedAtMs <= session.ended_at_ms + HOOK_EVENT_END_WINDOW_MS,
    );
    if (inWindow.length === 0) return session;
    const extendedEndedAtMs = Math.max(...inWindow);
    return {
      ...session,
      ended_at_ms: extendedEndedAtMs,
      verified_ended_at_ms: extendedEndedAtMs,
    };
  });
}
