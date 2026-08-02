import {
  subtractIntervals,
  unionIntervals,
} from "../core/intervals.js";
import type {
  ApprovalRequest,
  Confidence,
  Interval,
  NormalizedEvent,
  Session,
  TimelineAction,
  ToolResultEvent,
  ToolUseEvent,
} from "../core/model.js";

export const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1_000;

export interface AttributedTimelineAction extends TimelineAction {
  approval?: ApprovalRequest;
}

export interface TimelineOptions {
  idleThresholdMs?: number;
}

export interface TimelineResult {
  actions: AttributedTimelineAction[];
  rawIntervals: Interval[];
  activeIntervals: Interval[];
  idleIntervals: Interval[];
  toolIntervals: Interval[];
  inferenceIntervals: Interval[];
  humanWaitIntervals: Interval[];
  caveats: string[];
}

interface OrderedEvent {
  event: NormalizedEvent;
  inputIndex: number;
  agentKey: string;
  /**
   * Source lane identity (source path + session id). Tool uses and results
   * pair only within one lane so branch-scoped session segments never stitch
   * an excluded span back together as tool time.
   */
  laneKey: string;
}

interface InternalAction {
  action: AttributedTimelineAction;
  agentKey: string;
}

interface PendingAssistant {
  event: Extract<NormalizedEvent, { kind: "assistant" }>;
  approval?: ApprovalRequest;
}

function eventIdentity(event: NormalizedEvent): string {
  const discriminator =
    event.kind === "tool_use" || event.kind === "tool_result"
      ? event.tool_use_id
      : event.kind === "assistant"
        ? (event.message_id ?? "")
        : "";
  return [
    event.kind,
    event.session_ref,
    event.timestamp_ms,
    event.source_index,
    discriminator,
  ].join("\0");
}

function actionConfidence(
  ...events: readonly NormalizedEvent[]
): Confidence {
  if (events.some((event) => event.confidence === "low")) {
    return "low";
  }
  return events.some((event) => event.confidence === "medium")
    ? "medium"
    : "high";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function overlaps(left: Interval, right: Interval): boolean {
  return (
    left.start_ms < left.end_ms &&
    right.start_ms < right.end_ms &&
    left.start_ms < right.end_ms &&
    right.start_ms < left.end_ms
  );
}

function orderedSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort(
    (left, right) =>
      left.source_path.localeCompare(right.source_path) ||
      left.session_id.localeCompare(right.session_id),
  );
}

function collectEvents(
  sessions: readonly Session[],
  caveats: string[],
): OrderedEvent[] {
  const events: OrderedEvent[] = [];
  const identities = new Set<string>();
  let inputIndex = 0;

  for (const session of orderedSessions(sessions)) {
    for (const event of session.events) {
      const currentIndex = inputIndex;
      inputIndex += 1;
      if (!Number.isSafeInteger(event.timestamp_ms)) {
        caveats.push(
          `ignored event ${event.session_ref} with an invalid timestamp`,
        );
        continue;
      }
      const identity = eventIdentity(event);
      if (identities.has(identity)) {
        caveats.push(`ignored duplicate event ${event.session_ref}`);
        continue;
      }
      identities.add(identity);
      events.push({
        event,
        inputIndex: currentIndex,
        agentKey: [
          session.source_path,
          event.session_id,
          event.agent_id,
        ].join("\0"),
        laneKey: [session.source_path, event.session_id].join("\0"),
      });
    }
  }

  events.sort(
    (left, right) =>
      left.event.timestamp_ms - right.event.timestamp_ms ||
      left.event.source_index - right.event.source_index ||
      left.inputIndex - right.inputIndex,
  );
  return events;
}

function rawIntervalsByAgent(
  events: readonly OrderedEvent[],
): Map<string, Interval[]> {
  const grouped = new Map<string, OrderedEvent[]>();
  for (const event of events) {
    const group = grouped.get(event.agentKey);
    if (group === undefined) {
      grouped.set(event.agentKey, [event]);
    } else {
      group.push(event);
    }
  }

  const result = new Map<string, Interval[]>();
  for (const [agentKey, agentEvents] of grouped) {
    const intervals: Interval[] = [];
    for (let index = 1; index < agentEvents.length; index += 1) {
      const previous = agentEvents[index - 1];
      const current = agentEvents[index];
      if (
        previous !== undefined &&
        current !== undefined &&
        previous.event.timestamp_ms < current.event.timestamp_ms
      ) {
        intervals.push({
          start_ms: previous.event.timestamp_ms,
          end_ms: current.event.timestamp_ms,
        });
      }
    }
    result.set(agentKey, unionIntervals(intervals));
  }
  return result;
}

function isUserQuestionTool(use: ToolUseEvent): boolean {
  return (
    use.tool_name.replaceAll("-", "_").toLowerCase() === "askuserquestion"
  );
}

function toolAction(
  use: ToolUseEvent,
  result: ToolResultEvent | undefined,
  agentKey: string,
  validPair: boolean,
  idleThresholdMs: number,
): InternalAction {
  const endMs =
    result !== undefined && validPair
      ? result.timestamp_ms
      : use.timestamp_ms;
  const confidence =
    result === undefined || !validPair
      ? "low"
      : actionConfidence(use, result);
  const kind: AttributedTimelineAction["kind"] = isUserQuestionTool(use)
    ? endMs - use.timestamp_ms > idleThresholdMs
      ? "away"
      : "human_wait"
    : "tool";
  const action: AttributedTimelineAction = {
    action_id: `${use.session_ref}:${kind}:${use.tool_use_id}`,
    kind,
    interval: { start_ms: use.timestamp_ms, end_ms: endMs },
    session_id: use.session_id,
    agent_id: use.agent_id,
    session_refs: unique([
      use.session_ref,
      ...(result === undefined ? [] : [result.session_ref]),
    ]),
    confidence,
    concurrent: false,
    paths: unique(use.paths),
    tool_use_id: use.tool_use_id,
    tool_name: use.tool_name,
    ...(use.command === undefined ? {} : { command: use.command }),
    ...(use.approval === undefined
      ? {}
      : { approval: { ...use.approval } }),
  };
  return { action, agentKey };
}

function pairTools(
  events: readonly OrderedEvent[],
  idleThresholdMs: number,
  caveats: string[],
): {
  actions: InternalAction[];
  selectedUses: ReadonlySet<NormalizedEvent>;
  selectedResults: ReadonlySet<NormalizedEvent>;
  ignoredDuplicateResults: ReadonlySet<NormalizedEvent>;
  useForResult: ReadonlyMap<ToolResultEvent, ToolUseEvent>;
} {
  const uses = new Map<string, OrderedEvent>();
  const results = new Map<string, OrderedEvent[]>();

  for (const ordered of events) {
    const event = ordered.event;
    if (event.kind === "tool_use") {
      const key = `${ordered.laneKey}\0${event.tool_use_id}`;
      if (uses.has(key)) {
        caveats.push(
          `ignored duplicate tool use ${event.tool_use_id} in ${event.session_id}`,
        );
      } else {
        uses.set(key, ordered);
      }
    } else if (event.kind === "tool_result") {
      const key = `${ordered.laneKey}\0${event.tool_use_id}`;
      const group = results.get(key);
      if (group === undefined) {
        results.set(key, [ordered]);
      } else {
        group.push(ordered);
      }
    }
  }

  const actions: InternalAction[] = [];
  const selectedUses = new Set<NormalizedEvent>();
  const selectedResults = new Set<NormalizedEvent>();
  const ignoredDuplicateResults = new Set<NormalizedEvent>();
  const useForResult = new Map<ToolResultEvent, ToolUseEvent>();

  for (const [key, orderedUse] of uses) {
    const use = orderedUse.event as ToolUseEvent;
    selectedUses.add(use);
    const candidates = results.get(key) ?? [];
    if (candidates.length > 1) {
      caveats.push(
        `ignored duplicate tool results for ${use.tool_use_id} in ${use.session_id}`,
      );
    }
    const sameAgentCandidates = candidates.filter(
      (candidate) =>
        candidate.event.kind === "tool_result" &&
        candidate.event.agent_id === use.agent_id,
    );
    for (const candidate of candidates) {
      if (
        candidate.event.kind === "tool_result" &&
        candidate.event.agent_id !== use.agent_id
      ) {
        caveats.push(
          `tool result ${candidate.event.tool_use_id} in ${candidate.event.session_id} was attributed to a different agent and has no matching use`,
        );
      }
    }
    const resultEntry =
      sameAgentCandidates.find(
        (candidate) =>
          candidate.event.timestamp_ms > use.timestamp_ms,
      ) ?? sameAgentCandidates[0];
    const result =
      resultEntry?.event.kind === "tool_result"
        ? resultEntry.event
        : undefined;
    const validPair =
      result !== undefined && result.timestamp_ms > use.timestamp_ms;

    if (result === undefined) {
      caveats.push(
        `tool use ${use.tool_use_id} in ${use.session_id} has no matching result; elapsed time was not invented`,
      );
    } else {
      if (validPair) {
        selectedResults.add(result);
        useForResult.set(result, use);
        for (const candidate of sameAgentCandidates) {
          if (
            candidate.event.kind === "tool_result" &&
            candidate.event !== result
          ) {
            ignoredDuplicateResults.add(candidate.event);
          }
        }
      } else {
        caveats.push(
          `tool ${use.tool_use_id} in ${use.session_id} has a non-positive timestamp pair; elapsed time was not invented`,
        );
      }
    }
    actions.push(
      toolAction(use, result, orderedUse.agentKey, validPair, idleThresholdMs),
    );
  }

  for (const [key, candidates] of results) {
    if (uses.has(key)) {
      continue;
    }
    const result = candidates[0]?.event;
    if (result?.kind === "tool_result") {
      caveats.push(
        `tool result ${result.tool_use_id} in ${result.session_id} has no matching use`,
      );
    }
  }

  return {
    actions,
    selectedUses,
    selectedResults,
    ignoredDuplicateResults,
    useForResult,
  };
}

function causalAction(
  kind: "inference" | "human_wait" | "away",
  start: NormalizedEvent,
  end: NormalizedEvent,
  agentKey: string,
  details?: {
    use?: ToolUseEvent;
    approval?: ApprovalRequest;
  },
): InternalAction {
  const use = details?.use;
  const action: AttributedTimelineAction = {
    action_id: `${start.session_ref}:${kind}:${end.session_ref}`,
    kind,
    interval: {
      start_ms: start.timestamp_ms,
      end_ms: end.timestamp_ms,
    },
    session_id: start.session_id,
    agent_id: start.agent_id,
    session_refs: unique([start.session_ref, end.session_ref]),
    confidence: actionConfidence(start, end),
    concurrent: false,
    paths: use === undefined ? [] : unique(use.paths),
    ...(use === undefined
      ? {}
      : {
          tool_use_id: use.tool_use_id,
          tool_name: use.tool_name,
          ...(use.command === undefined ? {} : { command: use.command }),
        }),
    ...(details?.approval === undefined
      ? {}
      : { approval: { ...details.approval } }),
  };
  return { action, agentKey };
}

function causalActions(
  events: readonly OrderedEvent[],
  selectedUses: ReadonlySet<NormalizedEvent>,
  selectedResults: ReadonlySet<NormalizedEvent>,
  ignoredDuplicateResults: ReadonlySet<NormalizedEvent>,
  useForResult: ReadonlyMap<ToolResultEvent, ToolUseEvent>,
  idleThresholdMs: number,
  caveats: string[],
): InternalAction[] {
  const usesWithResults = new Set(useForResult.values());
  const grouped = new Map<string, OrderedEvent[]>();
  for (const ordered of events) {
    if (
      ordered.event.kind === "tool_use" &&
      !selectedUses.has(ordered.event)
    ) {
      continue;
    }
    if (
      ordered.event.kind === "tool_result" &&
      ignoredDuplicateResults.has(ordered.event)
    ) {
      continue;
    }
    const group = grouped.get(ordered.agentKey);
    if (group === undefined) {
      grouped.set(ordered.agentKey, [ordered]);
    } else {
      group.push(ordered);
    }
  }

  const actions: InternalAction[] = [];
  for (const [agentKey, agentEvents] of grouped) {
    let pendingInference:
      | Extract<NormalizedEvent, { kind: "genuine_user" | "tool_result" }>
      | undefined;
    let pendingAssistant: PendingAssistant | undefined;

    for (const ordered of agentEvents) {
      const event = ordered.event;
      switch (event.kind) {
        case "genuine_user": {
          if (pendingAssistant !== undefined) {
            if (
              pendingAssistant.event.timestamp_ms < event.timestamp_ms
            ) {
              const elapsed =
                event.timestamp_ms - pendingAssistant.event.timestamp_ms;
              actions.push(
                causalAction(
                  elapsed > idleThresholdMs ? "away" : "human_wait",
                  pendingAssistant.event,
                  event,
                  agentKey,
                  pendingAssistant.approval === undefined
                    ? undefined
                    : { approval: pendingAssistant.approval },
                ),
              );
            } else {
              caveats.push(
                `assistant/user pair at ${event.session_ref} has a non-positive timestamp`,
              );
            }
          }
          pendingAssistant = undefined;
          pendingInference = event;
          break;
        }
        case "assistant": {
          if (pendingInference !== undefined) {
            if (pendingInference.timestamp_ms < event.timestamp_ms) {
              const use =
                pendingInference.kind === "tool_result"
                  ? useForResult.get(pendingInference)
                  : undefined;
              actions.push(
                causalAction(
                  "inference",
                  pendingInference,
                  event,
                  agentKey,
                  use === undefined ? undefined : { use },
                ),
              );
            } else {
              caveats.push(
                `inference ending at ${event.session_ref} has a non-positive timestamp`,
              );
            }
          }
          pendingInference = undefined;
          pendingAssistant = { event };
          break;
        }
        case "tool_use": {
          if (!usesWithResults.has(event)) {
            pendingAssistant = undefined;
            pendingInference = undefined;
            break;
          }
          if (
            pendingAssistant !== undefined &&
            pendingAssistant.event.timestamp_ms === event.timestamp_ms &&
            event.approval !== undefined
          ) {
            pendingAssistant = {
              ...pendingAssistant,
              approval: { ...event.approval },
            };
          } else if (
            pendingAssistant !== undefined &&
            pendingAssistant.event.timestamp_ms !== event.timestamp_ms
          ) {
            pendingAssistant = undefined;
          }
          break;
        }
        case "tool_result":
          pendingAssistant = undefined;
          pendingInference = selectedResults.has(event) ? event : undefined;
          break;
        case "compaction":
          if (
            pendingAssistant !== undefined ||
            pendingInference !== undefined
          ) {
            caveats.push(
              `compaction at ${event.session_ref} broke causal interval attribution`,
            );
          }
          pendingAssistant = undefined;
          pendingInference = undefined;
          break;
      }
    }
  }
  return actions;
}

function markConcurrent(
  actions: InternalAction[],
  activeByAgent: ReadonlyMap<string, readonly Interval[]>,
): void {
  for (const internal of actions) {
    if (
      internal.action.kind === "away" ||
      internal.action.interval.start_ms >= internal.action.interval.end_ms
    ) {
      continue;
    }
    for (const [agentKey, intervals] of activeByAgent) {
      if (agentKey === internal.agentKey) {
        continue;
      }
      if (
        intervals.some((interval) =>
          overlaps(internal.action.interval, interval)
        )
      ) {
        internal.action.concurrent = true;
        break;
      }
    }
  }
}

function sortedActions(
  actions: readonly InternalAction[],
): AttributedTimelineAction[] {
  const kindOrder = new Map([
    ["tool", 0],
    ["inference", 1],
    ["human_wait", 2],
    ["away", 3],
  ]);
  return actions
    .map(({ action }) => action)
    .sort(
      (left, right) =>
        left.interval.start_ms - right.interval.start_ms ||
        left.interval.end_ms - right.interval.end_ms ||
        left.session_id.localeCompare(right.session_id) ||
        left.agent_id.localeCompare(right.agent_id) ||
        (kindOrder.get(left.kind) ?? 99) -
          (kindOrder.get(right.kind) ?? 99) ||
        left.action_id.localeCompare(right.action_id),
    );
}

export function buildTimeline(
  sessions: readonly Session[],
  options: TimelineOptions = {},
): TimelineResult {
  const idleThresholdMs =
    options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  if (
    !Number.isSafeInteger(idleThresholdMs) ||
    idleThresholdMs < 0
  ) {
    throw new RangeError(
      "idleThresholdMs must be a non-negative safe integer",
    );
  }

  const caveats: string[] = [];
  const events = collectEvents(sessions, caveats);
  const rawByAgent = rawIntervalsByAgent(events);
  const tools = pairTools(events, idleThresholdMs, caveats);
  const internalActions = [
    ...tools.actions,
    ...causalActions(
      events,
      tools.selectedUses,
      tools.selectedResults,
      tools.ignoredDuplicateResults,
      tools.useForResult,
      idleThresholdMs,
      caveats,
    ),
  ];

  const awayByAgent = new Map<string, Interval[]>();
  for (const internal of internalActions) {
    if (internal.action.kind !== "away") {
      continue;
    }
    const intervals = awayByAgent.get(internal.agentKey);
    if (intervals === undefined) {
      awayByAgent.set(internal.agentKey, [internal.action.interval]);
    } else {
      intervals.push(internal.action.interval);
    }
  }

  const activeByAgent = new Map<string, Interval[]>();
  for (const [agentKey, raw] of rawByAgent) {
    activeByAgent.set(
      agentKey,
      subtractIntervals(raw, awayByAgent.get(agentKey) ?? []),
    );
  }
  markConcurrent(internalActions, activeByAgent);
  const actions = sortedActions(internalActions);
  const rawIntervals = unionIntervals([...rawByAgent.values()].flat());
  const activeIntervals = unionIntervals([...activeByAgent.values()].flat());
  const idleIntervals = subtractIntervals(rawIntervals, activeIntervals);

  return {
    actions,
    rawIntervals,
    activeIntervals,
    idleIntervals,
    toolIntervals: unionIntervals(
      actions
        .filter((action) => action.kind === "tool")
        .map((action) => action.interval),
    ),
    inferenceIntervals: unionIntervals(
      actions
        .filter((action) => action.kind === "inference")
        .map((action) => action.interval),
    ),
    humanWaitIntervals: unionIntervals(
      actions
        .filter((action) => action.kind === "human_wait")
        .map((action) => action.interval),
    ),
    caveats: [...new Set(caveats)].sort((left, right) =>
      left.localeCompare(right)
    ),
  };
}
