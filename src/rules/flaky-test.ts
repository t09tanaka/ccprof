import {
  classifyCommand,
  classifyCommandResult,
} from "../analysis/command.js";
import type {
  CommandResultClassification,
} from "../analysis/command.js";
import type {
  Confidence,
  MatchedAction,
  ToolResultEvent,
} from "../core/model.js";
import {
  createFindingCandidate,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";
import { isReadOnlyCommand } from "./serial-slack.js";

export type EditRelevance = "related" | "unrelated";

export interface FlakyTestOptions {
  toolResults: readonly ToolResultEvent[];
  editRelevanceByActionId?: ReadonlyMap<string, EditRelevance>;
  additionalTestCommands?: ReadonlySet<string>;
}

interface RunSignal {
  action: MatchedAction;
  result: ToolResultEvent;
  classification: CommandResultClassification;
  command: string;
}

interface FlakyEpisode {
  command: string;
  failedRuns: RunSignal[];
  passingRun: RunSignal;
  investigation: MatchedAction[];
  unrelatedEdits: MatchedAction[];
}

function runKey(
  value: Pick<
    MatchedAction | ToolResultEvent,
    "agent_id" | "session_id" | "tool_use_id"
  >,
): string {
  return `${value.session_id}\0${value.agent_id}\0${value.tool_use_id ?? ""}`;
}

function isTestCommand(
  command: string,
  additional: ReadonlySet<string> | undefined,
): boolean {
  return classifyCommand(command).family === "test" ||
    additional?.has(command) === true;
}

function runSignals(
  actions: readonly MatchedAction[],
  options: FlakyTestOptions,
): RunSignal[] {
  const results = new Map<string, ToolResultEvent[]>();
  for (const result of options.toolResults) {
    const key = runKey(result);
    const group = results.get(key);
    if (group === undefined) results.set(key, [result]);
    else group.push(result);
  }
  for (const group of results.values()) {
    group.sort(
      (left, right) =>
        left.timestamp_ms - right.timestamp_ms ||
        left.source_index - right.source_index,
    );
  }

  return orderedActions(actions).flatMap((action) => {
    const command = action.normalized_command;
    if (
      action.kind !== "tool" ||
      action.tool_use_id === undefined ||
      command === undefined ||
      command.trim() === "" ||
      !isTestCommand(command, options.additionalTestCommands)
    ) {
      return [];
    }
    const result = (results.get(runKey(action)) ?? []).find(
      (candidate) =>
        candidate.timestamp_ms >= action.interval.end_ms,
    );
    if (result === undefined) return [];
    const descriptor = classifyCommand(command);
    const classification = classifyCommandResult(descriptor, {
      status: result.status,
      ...(result.exit_code === undefined
        ? {}
        : { exitCode: result.exit_code }),
      output: result.output,
    });
    if (
      !classification.definite ||
      (
        classification.status !== "failure" &&
        classification.status !== "success"
      )
    ) {
      return [];
    }
    return [{ action, result, classification, command }];
  });
}

function sameAgent(
  action: Pick<MatchedAction, "agent_id" | "session_id">,
  run: RunSignal,
): boolean {
  return (
    action.session_id === run.action.session_id &&
    action.agent_id === run.action.agent_id
  );
}

function isEdit(action: MatchedAction): boolean {
  return (
    action.kind === "tool" &&
    (
      action.match === "contributing_edit" ||
      action.match === "rework_edit"
    )
  );
}

function hasUnknownMutationRisk(action: MatchedAction): boolean {
  if (
    action.match !== "unexplained" ||
    (action.kind !== "tool" && action.kind !== "inference")
  ) {
    return false;
  }
  if (isReadOnlyCommand(action.command)) return false;
  const toolName = action.tool_name
    ?.replaceAll("-", "_")
    .toLocaleLowerCase("en-US");
  if (
    action.command === undefined &&
    ["glob", "grep", "list", "ls", "read", "search"].includes(
      toolName ?? "",
    )
  ) {
    return false;
  }
  return (
    action.kind === "tool" ||
    action.command !== undefined ||
    action.tool_name !== undefined
  );
}

function temporalActionsIntersectingWindow(
  actions: readonly MatchedAction[],
  failure: RunSignal,
  passing: RunSignal,
): MatchedAction[] {
  return actions.filter(
    (action) =>
      action.interval.start_ms < passing.action.interval.start_ms &&
      action.interval.end_ms > failure.action.interval.end_ms,
  );
}

function temporalActionsContainedInWindow(
  actions: readonly MatchedAction[],
  failure: RunSignal,
  passing: RunSignal,
): MatchedAction[] {
  return actions.filter(
    (action) =>
      action.interval.start_ms >= failure.action.interval.end_ms &&
      action.interval.end_ms <= passing.action.interval.start_ms,
  );
}

function investigationActions(
  between: readonly MatchedAction[],
  failedRuns: readonly RunSignal[],
): MatchedAction[] {
  const failedIds = new Set(
    failedRuns.map(({ action }) => action.action_id),
  );
  const failedToolUseIds = new Set(
    failedRuns.flatMap(({ action }) =>
      action.tool_use_id === undefined ? [] : [action.tool_use_id]
    ),
  );
  return between.filter((action) => {
    if (failedIds.has(action.action_id)) return true;
    if (
      action.kind === "inference" &&
      action.tool_use_id !== undefined &&
      failedToolUseIds.has(action.tool_use_id)
    ) {
      return true;
    }
    return (
      (action.kind === "tool" || action.kind === "inference") &&
      (
        action.match === "safe_read" ||
        action.match === "duplicate_read" ||
        action.match === "redundant_run" ||
        isReadOnlyCommand(action.command)
      )
    );
  });
}

function episodeFor(
  failure: RunSignal,
  passing: RunSignal,
  allFailures: readonly RunSignal[],
  actions: readonly MatchedAction[],
  editRelevance: ReadonlyMap<string, EditRelevance> | undefined,
): FlakyEpisode | null {
  const intersecting = temporalActionsIntersectingWindow(
    actions,
    failure,
    passing,
  );
  if (intersecting.some(hasUnknownMutationRisk)) return null;
  const edits = intersecting.filter(isEdit);
  if (
    edits.some(
      (edit) => editRelevance?.get(edit.action_id) !== "unrelated",
    )
  ) {
    return null;
  }
  const failedRuns = allFailures.filter(
    (candidate) =>
      candidate.action.interval.start_ms >= failure.action.interval.start_ms &&
      candidate.action.interval.end_ms <= passing.action.interval.start_ms,
  );
  const contained = temporalActionsContainedInWindow(
    actions,
    failure,
    passing,
  );
  const between = contained.filter((action) => sameAgent(action, failure));
  const investigation = [
    failure.action,
    ...investigationActions(between, failedRuns),
  ];
  const uniqueInvestigation = new Map(
    investigation.map((action) => [action.action_id, action] as const),
  );
  return {
    command: failure.command,
    failedRuns,
    passingRun: passing,
    investigation: orderedActions([...uniqueInvestigation.values()]),
    unrelatedEdits: edits,
  };
}

function episodesForGroup(
  signals: readonly RunSignal[],
  actions: readonly MatchedAction[],
  editRelevance: ReadonlyMap<string, EditRelevance> | undefined,
): FlakyEpisode[] {
  const episodes: FlakyEpisode[] = [];
  let failures: RunSignal[] = [];
  for (const signal of signals) {
    if (signal.classification.status === "failure") {
      failures.push(signal);
      continue;
    }
    if (signal.classification.status !== "success" || failures.length === 0) {
      continue;
    }
    for (const failure of failures) {
      const episode = episodeFor(
        failure,
        signal,
        failures,
        actions,
        editRelevance,
      );
      if (episode !== null) {
        episodes.push(episode);
        break;
      }
    }
    failures = [];
  }
  return episodes;
}

function downgradeForUnrelatedEdits(
  confidence: Confidence,
  hasUnrelatedEdits: boolean,
): Confidence {
  if (!hasUnrelatedEdits || confidence === "low") return confidence;
  return "medium";
}

export function detectFlakyTests(
  actions: readonly MatchedAction[],
  options: FlakyTestOptions,
) {
  const ordered = orderedActions(actions);
  const groups = new Map<string, RunSignal[]>();
  for (const signal of runSignals(ordered, options)) {
    const key = [
      signal.action.session_id,
      signal.action.agent_id,
      signal.command,
    ].join("\0");
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [signal]);
    else group.push(signal);
  }

  const episodes = [...groups.values()].flatMap((signals) =>
    episodesForGroup(
      signals,
      ordered,
      options.editRelevanceByActionId,
    )
  );
  const byCommand = new Map<string, FlakyEpisode[]>();
  for (const episode of episodes) {
    const group = byCommand.get(episode.command);
    if (group === undefined) byCommand.set(episode.command, [episode]);
    else group.push(episode);
  }

  return [...byCommand.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([command, commandEpisodes]) => {
      const investigation = orderedActions(
        [...new Map(
          commandEpisodes
            .flatMap((episode) => episode.investigation)
            .map((action) => [
              `${action.session_id}\0${action.agent_id}\0${action.action_id}`,
              action,
            ] as const),
        ).values()],
      );
      const passingRuns = commandEpisodes.map(
        (episode) => episode.passingRun,
      );
      const failedRuns = [
        ...new Map(
          commandEpisodes
            .flatMap((episode) => episode.failedRuns)
            .map((signal) => [
              `${signal.action.session_id}\0${signal.action.agent_id}\0${signal.action.action_id}`,
              signal,
            ] as const),
        ).values(),
      ];
      const unrelatedEdits = [
        ...new Map(
          commandEpisodes
            .flatMap((episode) => episode.unrelatedEdits)
            .map((action) => [
              `${action.session_id}\0${action.agent_id}\0${action.action_id}`,
              action,
            ] as const),
        ).values(),
      ];
      const recoverable = recoverableClaim(
        "R008",
        command,
        investigation,
      );
      const baseConfidence = minimumConfidence([
        ...investigation.flatMap((action) => [
          action.confidence,
          action.match_confidence,
        ]),
        ...passingRuns.flatMap(({ action }) => [
          action.confidence,
          action.match_confidence,
        ]),
      ]);
      return createFindingCandidate({
        rule_id: "R008",
        title: "Test failed then passed without a relevant edit",
        classification: "repo",
        cause: null,
        scope: "separate_issue",
        confidence: downgradeForUnrelatedEdits(
          baseConfidence,
          unrelatedEdits.length > 0,
        ),
        target: command,
        evidence: {
          session_refs: sortedUnique([
            ...investigation.flatMap((action) => action.session_refs),
            ...passingRuns.flatMap(({ action, result }) => [
              ...action.session_refs,
              result.session_ref,
            ]),
            ...failedRuns.map(({ result }) => result.session_ref),
          ]),
          interval_ids: recoverable.intervals.map(
            (interval) => interval.interval_id,
          ),
          investigation_interval_ids: recoverable.intervals.map(
            (interval) => interval.interval_id,
          ),
          command,
          episode_count: commandEpisodes.length,
          failed_run_count: failedRuns.length,
          passing_run_count: passingRuns.length,
          investigation_action_count: investigation.length,
          unrelated_edit_count: unrelatedEdits.length,
          unrelated_edit_paths: sortedUnique(
            unrelatedEdits.flatMap((action) => action.paths),
          ),
          result_sources: sortedUnique([
            ...failedRuns.map(({ classification }) => classification.source),
            ...passingRuns.map(({ classification }) => classification.source),
          ]),
        },
        recoverable,
        fix_recipe: {
          suggestion:
            `Fix or quarantine the flaky behavior exercised by \`${command}\` in a separate repository issue.`,
          verify: command,
        },
        caveats: sortedUnique([
          ...investigation.flatMap((action) => action.caveats),
          ...(unrelatedEdits.length > 0
            ? ["Only proven unrelated edits occurred between failure and success, so confidence was lowered."]
            : []),
          ...(recoverable.bound === "upper"
            ? ["The investigation overlapped another agent, so recoverable time is an upper bound."]
            : []),
        ]),
      });
    });
}
