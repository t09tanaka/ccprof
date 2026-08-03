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

export function admitSessionEventPrefix(
  sessions: readonly Session[],
  meter: AnalysisBudgetMeter,
): Session[] {
  const physicalOrder = sessions.flatMap((session, sessionIndex) =>
    session.events.map((event, eventIndex) => ({
      event,
      eventIndex,
      sessionIndex,
    }))
  ).sort((left, right) =>
    left.event.source_index - right.event.source_index ||
    left.sessionIndex - right.sessionIndex ||
    left.eventIndex - right.eventIndex
  );
  const admittedCount = meter.admitInputEvents(physicalOrder.length);
  const admittedBySession = new Map<number, Session["events"]>();
  for (const { event, sessionIndex } of physicalOrder.slice(0, admittedCount)) {
    const events = admittedBySession.get(sessionIndex);
    if (events === undefined) admittedBySession.set(sessionIndex, [event]);
    else events.push(event);
  }
  return sessions.flatMap((session, sessionIndex) => {
    const events = admittedBySession.get(sessionIndex);
    if (events === undefined || events.length === 0) return [];
    const timestamps = events.map(({ timestamp_ms }) => timestamp_ms);
    return [{
      ...session,
      events,
      started_at_ms: Math.min(...timestamps),
      ended_at_ms: Math.max(...timestamps),
    }];
  });
}
