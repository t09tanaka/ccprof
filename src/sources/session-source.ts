import type { Session } from "../core/model.js";
import type { AnalysisBudgetMeter } from "../analysis/budgets.js";

export interface SessionQuery {
  repoRoot: string;
  headBranch: string;
  startedAtMs: number;
  endedAtMs: number;
  analysisBudgetMeter?: AnalysisBudgetMeter;
}

export interface SessionSource {
  discover(query: SessionQuery): Promise<Session[]>;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptionalCodeUnits(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareCodeUnits(left, right);
}

function toolUseId(event: Session["events"][number]): string | undefined {
  return event.kind === "tool_use" || event.kind === "tool_result"
    ? event.tool_use_id
    : undefined;
}

function eventConfidence(
  events: readonly Session["events"][number][],
): Session["confidence"] {
  let confidence: Session["confidence"] = "high";
  for (const event of events) {
    if (event.confidence === "low") return "low";
    if (event.confidence === "medium") confidence = "medium";
  }
  return confidence;
}

export function admitSessionEventPrefix(
  sessions: readonly Session[],
  meter: AnalysisBudgetMeter,
): Session[] {
  const physicalOrder = sessions.flatMap((session, sessionIndex) =>
    session.events.map((event, eventIndex) => ({
      event,
      eventIndex,
      session,
      sessionIndex,
    }))
  ).sort((left, right) =>
    left.event.source_index - right.event.source_index ||
    compareCodeUnits(left.session.source_path, right.session.source_path) ||
    compareCodeUnits(left.session.source, right.session.source) ||
    compareCodeUnits(left.event.session_id, right.event.session_id) ||
    compareCodeUnits(left.event.agent_id, right.event.agent_id) ||
    compareOptionalCodeUnits(
      toolUseId(left.event),
      toolUseId(right.event),
    ) ||
    compareCodeUnits(left.event.session_ref, right.event.session_ref) ||
    compareCodeUnits(left.event.entry_uuid, right.event.entry_uuid) ||
    compareCodeUnits(left.event.kind, right.event.kind) ||
    left.sessionIndex - right.sessionIndex ||
    left.eventIndex - right.eventIndex
  );
  const admittedCount = meter.admitInputEvents(physicalOrder.length);
  const truncated = admittedCount < physicalOrder.length;
  const admittedBySession = new Map<number, Session["events"]>();
  for (const { event, sessionIndex } of physicalOrder.slice(0, admittedCount)) {
    const events = admittedBySession.get(sessionIndex);
    if (events === undefined) admittedBySession.set(sessionIndex, [event]);
    else events.push(event);
  }
  return sessions.flatMap((session, sessionIndex) => {
    const events = admittedBySession.get(sessionIndex);
    if (events === undefined || events.length === 0) return [];
    let startedAtMs = events[0]!.timestamp_ms;
    let endedAtMs = startedAtMs;
    for (const { timestamp_ms: timestampMs } of events) {
      if (timestampMs < startedAtMs) startedAtMs = timestampMs;
      if (timestampMs > endedAtMs) endedAtMs = timestampMs;
    }
    const admittedSessionRefs = new Set(
      events.map(({ session_ref }) => session_ref),
    );
    const lastSourceIndex = events.reduce(
      (last, { source_index }) => Math.max(last, source_index),
      -1,
    );
    const lastSourceLine =
      lastSourceIndex + (session.source === "claude" ? 1 : 0);
    const observedCwds = [...new Set(events.flatMap((event) =>
      event.kind === "tool_use" && event.cwd !== undefined && event.cwd !== ""
        ? [event.cwd]
        : []
    ))];
    const observedBranches = [...new Set(events.flatMap(({ branch }) =>
      branch === undefined ? [] : [branch]
    ))];
    const warnings = session.warnings.filter((warning) => {
      if (!truncated) return true;
      if (
        warning.session_ref !== undefined &&
        !admittedSessionRefs.has(warning.session_ref)
      ) {
        return false;
      }
      if (warning.line !== undefined && warning.line > lastSourceLine) {
        return false;
      }
      return warning.session_ref !== undefined || warning.line !== undefined;
    });
    const baseSession = (() => {
      if (!truncated) return session;
      const { verified_ended_at_ms: _verifiedEndedAtMs, ...rest } = session;
      return rest;
    })();
    return [{
      ...baseSession,
      ...(truncated
        ? {
            observed_cwds: observedCwds,
            observed_branches: observedBranches,
            confidence: eventConfidence(events),
          }
        : {}),
      events,
      started_at_ms: startedAtMs,
      ended_at_ms: endedAtMs,
      warnings,
    }];
  });
}
