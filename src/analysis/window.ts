import type {
  AnalysisWindow,
  NormalizedEvent,
  Session,
} from "../core/model.js";

export function sliceSessionsToAnalysisWindow(
  sessions: readonly Session[],
  window: AnalysisWindow,
): Session[] {
  return sessions.flatMap((session) => {
    const events: NormalizedEvent[] = [];
    let startedAtMs = Number.POSITIVE_INFINITY;
    let lastEventAtMs = Number.NEGATIVE_INFINITY;
    for (const event of session.events) {
      const timestampMs = event.timestamp_ms;
      if (
        !Number.isSafeInteger(timestampMs) ||
        timestampMs < window.started_at_ms ||
        timestampMs > window.ended_at_ms
      ) {
        continue;
      }
      events.push({ ...event });
      if (timestampMs < startedAtMs) startedAtMs = timestampMs;
      if (timestampMs > lastEventAtMs) lastEventAtMs = timestampMs;
    }
    if (events.length === 0) return [];
    const verified = session.verified_ended_at_ms;
    const verifiedEndedAtMs =
      Number.isSafeInteger(verified) &&
      (verified as number) >= window.started_at_ms &&
      (verified as number) <= window.ended_at_ms &&
      (verified as number) >= lastEventAtMs
        ? verified
        : undefined;
    const { verified_ended_at_ms: _verified, ...copy } = session;
    return [{
      ...copy,
      events,
      started_at_ms: startedAtMs,
      ended_at_ms: verifiedEndedAtMs ?? lastEventAtMs,
      ...(verifiedEndedAtMs === undefined
        ? {}
        : { verified_ended_at_ms: verifiedEndedAtMs }),
    }];
  });
}
