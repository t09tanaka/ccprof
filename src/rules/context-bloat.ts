import type {
  CompactionEvent,
  MatchedAction,
  NormalizedEvent,
  RecoverableClaim,
  ToolResultEvent,
} from "../core/model.js";
import {
  createFindingCandidate,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";

export const LARGE_RESULT_TOKEN_THRESHOLD = 50_000;

export interface ContextBloatOptions {
  events: readonly NormalizedEvent[];
  externalToolNames?: ReadonlySet<string>;
}

interface ResultSignal {
  result: ToolResultEvent;
  tool?: MatchedAction;
  inference?: MatchedAction;
  target: string;
}

interface ContextSignalGroup {
  target: string;
  results: ResultSignal[];
  compactions: CompactionEvent[];
}

function eventKey(
  event: Pick<NormalizedEvent, "agent_id" | "session_id">,
): string {
  return `${event.session_id}\0${event.agent_id}`;
}

function toolUseKey(
  value: Pick<
    MatchedAction | ToolResultEvent,
    "agent_id" | "session_id" | "tool_use_id"
  >,
): string {
  return `${value.session_id}\0${value.agent_id}\0${value.tool_use_id ?? ""}`;
}

function targetFor(action: MatchedAction | undefined): string {
  const command = action?.normalized_command ?? action?.command;
  if (command !== undefined && command.trim() !== "") return command;
  if (action?.tool_name !== undefined && action.tool_name.trim() !== "") {
    return action.tool_name;
  }
  return action?.tool_use_id === undefined
    ? "large-tool-result"
    : `tool:${action.tool_use_id}`;
}

function latestPrecedingLargeResult(
  compaction: CompactionEvent,
  results: readonly ResultSignal[],
): ResultSignal | undefined {
  let latest: ResultSignal | undefined;
  for (const signal of results) {
    if (
      eventKey(signal.result) !== eventKey(compaction) ||
      signal.result.timestamp_ms > compaction.timestamp_ms
    ) {
      continue;
    }
    if (
      latest === undefined ||
      signal.result.timestamp_ms > latest.result.timestamp_ms ||
      (
        signal.result.timestamp_ms === latest.result.timestamp_ms &&
        signal.result.source_index > latest.result.source_index
      )
    ) {
      latest = signal;
    }
  }
  return latest;
}

function addResult(
  group: ContextSignalGroup,
  signal: ResultSignal,
): void {
  if (!group.results.some(({ result }) => result === signal.result)) {
    group.results.push(signal);
  }
}

function isExternalTool(
  group: ContextSignalGroup,
  externalToolNames: ReadonlySet<string> | undefined,
): boolean {
  if (externalToolNames === undefined) return false;
  return group.results.some(({ tool }) =>
    tool?.tool_name !== undefined && externalToolNames.has(tool.tool_name)
  );
}

function upperLatencyClaim(
  target: string,
  actions: readonly MatchedAction[],
): RecoverableClaim {
  const base = recoverableClaim("R007", target, actions);
  return {
    ...base,
    bound: "upper",
  };
}

export function detectContextBloat(
  actions: readonly MatchedAction[],
  options: ContextBloatOptions,
) {
  const ordered = orderedActions(actions);
  const tools = new Map<string, MatchedAction>();
  const inferences = new Map<string, MatchedAction[]>();
  for (const action of ordered) {
    if (action.tool_use_id === undefined) continue;
    const key = toolUseKey(action);
    if (action.kind === "tool" && !tools.has(key)) {
      tools.set(key, action);
    } else if (action.kind === "inference") {
      const group = inferences.get(key);
      if (group === undefined) inferences.set(key, [action]);
      else group.push(action);
    }
  }

  const largeResults = options.events
    .filter(
      (event): event is ToolResultEvent =>
        event.kind === "tool_result" &&
        Number.isSafeInteger(event.estimated_tokens) &&
        event.estimated_tokens > LARGE_RESULT_TOKEN_THRESHOLD,
    )
    .map<ResultSignal>((result) => {
      const key = toolUseKey(result);
      const tool = tools.get(key);
      const inference = (inferences.get(key) ?? []).find(
        (candidate) =>
          candidate.interval.start_ms === result.timestamp_ms &&
          candidate.interval.end_ms > candidate.interval.start_ms,
      );
      return {
        result,
        ...(tool === undefined ? {} : { tool }),
        ...(inference === undefined ? {} : { inference }),
        target: targetFor(tool),
      };
    })
    .sort(
      (left, right) =>
        left.result.timestamp_ms - right.result.timestamp_ms ||
        left.result.source_index - right.result.source_index ||
        left.target.localeCompare(right.target),
    );
  const compactions = options.events
    .filter(
      (event): event is CompactionEvent => event.kind === "compaction",
    )
    .sort(
      (left, right) =>
        left.timestamp_ms - right.timestamp_ms ||
        left.source_index - right.source_index,
    );

  const groups = new Map<string, ContextSignalGroup>();
  for (const signal of largeResults) {
    const group = groups.get(signal.target);
    if (group === undefined) {
      groups.set(signal.target, {
        target: signal.target,
        results: [signal],
        compactions: [],
      });
    } else {
      addResult(group, signal);
    }
  }
  for (const compact of compactions) {
    const preceding = latestPrecedingLargeResult(compact, largeResults);
    const target = preceding?.target ?? "compaction";
    let group = groups.get(target);
    if (group === undefined) {
      group = { target, results: [], compactions: [] };
      groups.set(target, group);
    }
    group.compactions.push(compact);
    if (preceding !== undefined) addResult(group, preceding);
  }

  return [...groups.values()]
    .sort((left, right) => left.target.localeCompare(right.target))
    .map((group) => {
      const causedInferences = orderedActions(
        [...new Map(
          group.results.flatMap(({ inference }) =>
            inference === undefined
              ? []
              : [[
                  [
                    inference.session_id,
                    inference.agent_id,
                    inference.action_id,
                  ].join("\0"),
                  inference,
                ] as const]
          ),
        ).values()],
      );
      const recoverable = upperLatencyClaim(
        group.target,
        causedInferences,
      );
      const external = isExternalTool(
        group,
        options.externalToolNames,
      );
      const confidenceValues = [
        ...group.results.flatMap(({ result, tool, inference }) => [
          result.confidence,
          ...(tool === undefined
            ? []
            : [tool.confidence, tool.match_confidence]),
          ...(inference === undefined
            ? []
            : [inference.confidence, inference.match_confidence]),
        ]),
        ...group.compactions.map((compaction) => compaction.confidence),
      ];
      const sessionRefs = sortedUnique([
        ...group.results.flatMap(({ result, tool, inference }) => [
          result.session_ref,
          ...(tool?.session_refs ?? []),
          ...(inference?.session_refs ?? []),
        ]),
        ...group.compactions.map((compaction) => compaction.session_ref),
      ]);
      const hasUnlinkedCompaction =
        group.target === "compaction" && group.compactions.length > 0;
      return createFindingCandidate({
        rule_id: "R007",
        title: "Large tool output increased context pressure",
        classification: external ? "repo" : "behavior",
        cause: null,
        scope: external ? "separate_issue" : "claude_md",
        confidence:
          confidenceValues.length === 0
            ? "low"
            : minimumConfidence(confidenceValues),
        target: group.target,
        evidence: {
          session_refs: sessionRefs,
          interval_ids: recoverable.intervals.map(
            (interval) => interval.interval_id,
          ),
          threshold_tokens: LARGE_RESULT_TOKEN_THRESHOLD,
          result_count: group.results.length,
          compaction_count: group.compactions.length,
          max_estimated_tokens: Math.max(
            0,
            ...group.results.map(({ result }) => result.estimated_tokens),
          ),
          output_bytes: group.results.reduce(
            (total, { result }) => total + result.output_bytes,
            0,
          ),
          caused_latency_ms: recoverable.estimated_ms,
          tool_use_ids: sortedUnique(
            group.results.map(({ result }) => result.tool_use_id),
          ),
          tool_names: sortedUnique(
            group.results.flatMap(({ tool }) =>
              tool?.tool_name === undefined ? [] : [tool.tool_name]
            ),
          ),
          commands: sortedUnique(
            group.results.flatMap(({ tool }) =>
              tool?.command === undefined ? [] : [tool.command]
            ),
          ),
        },
        recoverable,
        fix_recipe: {
          suggestion:
            group.target === "compaction"
              ? "Keep large reads range-limited and large command output filtered with head/tail before it enters context."
              : `Limit \`${group.target}\` output with a targeted filter, range, head, or tail before it enters context.`,
          verify: "ccprof --json",
        },
        caveats: sortedUnique([
          ...group.results.flatMap(({ tool, inference }) => [
            ...(tool?.caveats ?? []),
            ...(inference?.caveats ?? []),
          ]),
          "Caused post-result inference is an upper bound; the full latency is not assumed to be removable.",
          ...(recoverable.estimated_ms === 0
            ? ["No directly caused measured inference interval was available, so latency was not invented."]
            : []),
          ...(hasUnlinkedCompaction
            ? ["The compaction had no preceding large result above the deterministic threshold."]
            : []),
        ]),
      });
    });
}
