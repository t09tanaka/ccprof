import {
  classifyCommand,
  classifyCommandResult,
  commandMayMutateRepo,
  normalizeCommand,
} from "../analysis/command.js";
import type {
  CommandResultClassification,
} from "../analysis/command.js";
import type {
  Confidence,
  MatchedAction,
  ToolResultEvent,
} from "../core/model.js";
import type { AnalysisRecord } from "../store/analyses.js";
import {
  createFindingCandidate,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";
import { isDelegationToolName } from "../analysis/diff-matcher.js";
import {
  compareCodeUnits,
  extractFailedTestNames,
  MAX_FAILED_TEST_NAMES,
} from "../analysis/test-output.js";
import { isReadOnlyCommand } from "./serial-slack.js";

export type EditRelevance = "related" | "unrelated";

const COMMAND_SCOPED_EDIT_RELEVANCE_PREFIX = "\0";

export function flakyEditRelevanceKey(
  actionId: string,
  command: string,
): string {
  return `${COMMAND_SCOPED_EDIT_RELEVANCE_PREFIX}${
    JSON.stringify([actionId, normalizeCommand(command) ?? command])
  }`;
}

export interface FlakyTestOptions {
  toolResults: readonly ToolResultEvent[];
  editRelevanceByActionId?: ReadonlyMap<string, EditRelevance>;
  additionalTestCommands?: ReadonlySet<string>;
  history?: readonly AnalysisRecord[];
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

interface HistoricalFlakyEvidence {
  prs: string[];
  durationMin: number;
  sessionRefs: string[];
}

interface HistoricalPrEvidence {
  durationMin: number;
  sessionRefs: Set<string>;
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

function isEdit(action: MatchedAction): boolean {
  return (
    action.kind === "tool" &&
    (
      action.match === "contributing_edit" ||
      action.match === "rework_edit"
    )
  );
}

function editRelevanceForCommand(
  relevance: ReadonlyMap<string, EditRelevance> | undefined,
  edit: MatchedAction,
  command: string,
): EditRelevance | undefined {
  const scoped = relevance?.get(
    flakyEditRelevanceKey(edit.action_id, command),
  );
  if (scoped !== undefined) return scoped;
  return relevance?.get(edit.action_id);
}

function hasUnknownMutationRisk(action: MatchedAction): boolean {
  if (action.kind !== "tool" && action.kind !== "inference") {
    return false;
  }
  if (
    action.command !== undefined &&
    commandMayMutateRepo(action.command) &&
    !isReadOnlyCommand(action.command)
  ) {
    return true;
  }
  if (action.match === "coordination") {
    return isDelegationToolName(action.tool_name);
  }
  if (action.match !== "unexplained") {
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
      action.interval.end_ms > failure.action.interval.start_ms,
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
  editRelevance: ReadonlyMap<string, EditRelevance> | undefined,
  command: string,
): MatchedAction[] {
  return between.filter((action) => {
    if (
      action.kind === "tool" &&
      action.match === "rework_edit" &&
      editRelevanceForCommand(editRelevance, action, command) === "unrelated"
    ) {
      return true;
    }
    return (
      action.kind === "tool" && !isEdit(action) &&
      action.match !== "contributing_run" &&
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
  if (passing.action.interval.start_ms < failure.action.interval.end_ms) return null;
  const intersecting = temporalActionsIntersectingWindow(
    actions,
    failure,
    passing,
  );
  if (intersecting.some((action) => !allFailures.some(({ action: failed }) => runKey(action) === runKey(failed)) && hasUnknownMutationRisk(action))) return null;
  const edits = intersecting.filter(isEdit);
  if (
    edits.some(
      (edit) =>
        editRelevanceForCommand(
          editRelevance,
          edit,
          failure.command,
        ) !== "unrelated",
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
  ).filter((action) => action !== passing.action);
  const investigation = [
    ...failedRuns.map(({ action }) => action),
    ...investigationActions(contained, editRelevance, failure.command),
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
        failures = failures.filter(({ action }) => action.interval.end_ms > signal.action.interval.start_ms);
        break;
      }
    }
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

function historicalFlakyByCommand(
  history: readonly AnalysisRecord[],
): Map<string, HistoricalFlakyEvidence> {
  const byCommandAndPr = new Map<
    string,
    Map<string, HistoricalPrEvidence>
  >();
  for (const record of history) {
    const rawPrRef = record?.unit?.pr_ref;
    if (typeof rawPrRef !== "string" || rawPrRef.trim() === "") continue;
    const prRef = rawPrRef.trim();
    if (!Array.isArray(record.findings)) continue;
    for (const finding of record.findings) {
      if (finding?.rule_id !== "R008") continue;
      const evidence: unknown = finding.evidence;
      if (
        evidence === null ||
        typeof evidence !== "object" ||
        Array.isArray(evidence)
      ) {
        continue;
      }
      const rawCommand = Reflect.get(evidence, "command");
      const rawSessionRefs = Reflect.get(evidence, "session_refs");
      if (
        typeof rawCommand !== "string" ||
        !Array.isArray(rawSessionRefs) ||
        rawSessionRefs.length === 0 ||
        !rawSessionRefs.every(
          (ref) => typeof ref === "string" && ref !== "",
        )
      ) {
        continue;
      }
      const command = normalizeCommand(rawCommand);
      const durationMin =
        finding.recoverable !== null &&
          typeof finding.recoverable === "object" &&
          typeof finding.recoverable.min === "number" &&
          Number.isFinite(finding.recoverable.min) &&
          finding.recoverable.min >= 0
          ? finding.recoverable.min
          : null;
      if (command === null || durationMin === null) continue;
      let byPr = byCommandAndPr.get(command);
      if (byPr === undefined) {
        byPr = new Map();
        byCommandAndPr.set(command, byPr);
      }
      const existing = byPr.get(prRef);
      if (existing === undefined) {
        byPr.set(prRef, {
          durationMin,
          sessionRefs: new Set(rawSessionRefs as string[]),
        });
      } else {
        existing.durationMin = Math.max(existing.durationMin, durationMin);
        for (const ref of rawSessionRefs) existing.sessionRefs.add(ref);
      }
    }
  }

  return new Map(
    [...byCommandAndPr.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([command, byPr]) => {
        const orderedPrs = [...byPr.entries()].sort(([left], [right]) =>
          left.localeCompare(right)
        );
        return [command, {
          prs: orderedPrs.map(([prRef]) => prRef),
          durationMin: orderedPrs.reduce(
            (total, [, evidence]) => total + evidence.durationMin,
            0,
          ),
          sessionRefs: sortedUnique(
            orderedPrs.flatMap(([, evidence]) => [...evidence.sessionRefs]),
          ),
        }] as const;
      }),
  );
}

export function detectFlakyTests(
  actions: readonly MatchedAction[],
  options: FlakyTestOptions,
) {
  const ordered = orderedActions(actions);
  const historyByCommand = historicalFlakyByCommand(options.history ?? []);
  const groups = new Map<string, RunSignal[]>();
  for (const signal of runSignals(ordered, options)) {
    const group = groups.get(signal.command);
    if (group === undefined) groups.set(signal.command, [signal]);
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
      const extractions = failedRuns.map(({ result }) =>
        extractFailedTestNames(result.output)
      );
      const distinctFailedTests = [
        ...new Set(extractions.flatMap(({ names }) => names)),
      ].sort(compareCodeUnits);
      const failedTests = distinctFailedTests.slice(
        0,
        MAX_FAILED_TEST_NAMES,
      );
      const failedTestsTruncated =
        extractions.some(({ truncated }) => truncated) ||
        distinctFailedTests.length > MAX_FAILED_TEST_NAMES;
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
      const historical = historyByCommand.get(command);
      const candidate = createFindingCandidate({
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
          failed_tests: failedTests,
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
          ...(historical === undefined
            ? {}
            : {
              historical_prs: historical.prs,
              historical_duration_min: historical.durationMin,
              historical_session_refs: historical.sessionRefs,
            }),
        },
        recoverable,
        fix_recipe: {
          suggestion:
            `Fix or quarantine the flaky behavior exercised by \`${command}\` in a separate repository issue.${
              failedTests.length === 0
                ? ""
                : ` Start with ${
                  failedTests
                    .slice(0, 3)
                    .map((name) => `\`${name}\``)
                    .join(", ")
                }.`
            }`,
          verify: command,
        },
        caveats: sortedUnique([
          ...investigation.flatMap((action) => action.caveats),
          ...(failedTestsTruncated
            ? [
              `The failed test name list was truncated to ${MAX_FAILED_TEST_NAMES} entries.`,
            ]
            : []),
          ...(unrelatedEdits.length > 0
            ? ["Only proven unrelated edits occurred between failure and success, so confidence was lowered."]
            : []),
          ...(recoverable.bound === "upper"
            ? ["The investigation overlapped another agent, so recoverable time is an upper bound."]
            : []),
          ...(historical === undefined
            ? []
            : [
              `The same normalized command was flaky in ${historical.prs.length} prior PR${historical.prs.length === 1 ? "" : "s"} (${historical.durationMin} minutes of historical investigation); historical time is evidence only and is not included in this PR's recoverable estimate.`,
            ]),
        ]),
      });
      // canonicalEvidence re-sorts string arrays with localeCompare; restore
      // the deterministic code-unit ordering for extracted test names.
      candidate.evidence.failed_tests = [...failedTests];
      return candidate;
    });
}
