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
  readonly budgetCooperative?: boolean;
  discover(query: SessionQuery): Promise<Session[]>;
}

export function admitSessionEventPrefix(
  sessions: readonly Session[],
  meter: AnalysisBudgetMeter,
): Session[] {
  const result: Session[] = [];
  for (const session of sessions) {
    const admittedCount = meter.admitInputEvents(session.events.length);
    if (admittedCount > 0) {
      const events = session.events.slice(0, admittedCount);
      const timestamps = events.map(({ timestamp_ms }) => timestamp_ms);
      result.push({
        ...session,
        events,
        started_at_ms: Math.min(...timestamps),
        ended_at_ms: Math.max(...timestamps),
      });
    }
    if (admittedCount < session.events.length) break;
  }
  return result;
}
