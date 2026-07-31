import { homedir } from "node:os";
import { join } from "node:path";

import {
  durationMs,
  intersectIntervals,
} from "./intervals.js";
import {
  reconcileLedger,
  type LedgerResult,
} from "./ledger.js";
import type {
  AssistantEvent,
  Finding,
  FindingCandidate,
  MatchedAction,
  NormalizedEvent,
  ReportV2,
  Session,
  SourceWarning,
  ToolResultEvent,
  ToolUseEvent,
} from "./model.js";
import {
  matchTimelineActions,
  type ActionObservation,
} from "../analysis/diff-matcher.js";
import { classifyCommand } from "../analysis/command.js";
import {
  buildTimeline,
  type TimelineResult,
} from "../analysis/timeline.js";
import {
  discoverManifestTestMap,
  evaluateTestRelevance,
  hasMappedCommand,
  loadExplicitTestMap,
  mergeTestMaps,
  type TestMap,
} from "../analysis/test-map.js";
import type { CommandRunner } from "../git/client.js";
import { collectDiffEvidence } from "../git/diff.js";
import {
  resolvePrContext,
  type PrContext,
} from "../git/pr-context.js";
import { detectChronicCost } from "../rules/chronic-cost.js";
import { detectContextBloat } from "../rules/context-bloat.js";
import {
  detectFlakyTests,
  type EditRelevance,
} from "../rules/flaky-test.js";
import { detectHumanWait } from "../rules/human-wait.js";
import { detectRediscovery } from "../rules/rediscovery.js";
import { detectRedundantRuns } from "../rules/redundant-runs.js";
import { detectRework } from "../rules/rework.js";
import { detectSerialSlack } from "../rules/serial-slack.js";
import { ClaudeSessionSource } from "../sources/claude/discover.js";
import type { SessionSource } from "../sources/session-source.js";
import {
  computeBaseline,
  loadAnalyses,
  makeAnalysisRecord,
  saveAnalysis,
  type AnalysisRecord,
  type StoreWarning,
  type StoredCommandCost,
} from "../store/analyses.js";
import {
  applyDismissals,
  loadDismissals,
} from "../store/dismissals.js";
import {
  resolveStorePaths,
  type StorePaths,
} from "../store/paths.js";

const KNOWN_LIMITATIONS = [
  "Claude timestamps are log write times, not exact operation start and end times.",
  "Human wait below the idle threshold cannot distinguish deliberation from being away.",
] as const;

export interface AnalyzeOptions {
  cwd: string;
  pr?: string;
  idleThresholdMs?: number;
  testMapPath?: string;
  testMap?: TestMap;
  sessionSource?: SessionSource;
  claudeProjectsDirectory?: string;
  storePaths?: StorePaths;
  runner?: CommandRunner;
  nowMs?: number;
  externalToolNames?: ReadonlySet<string>;
}

export interface AnalyzeWarning {
  code: string;
  message: string;
  source?: string;
}

export interface AnalyzeResult {
  report: ReportV2;
  allFindings: Finding[];
  record: AnalysisRecord;
  warnings: AnalyzeWarning[];
  suppressedKeys: string[];
  ledger: LedgerResult;
}

export class NoMatchingSessionsError extends Error {
  constructor() {
    super("No matching analyzable sessions were found for this PR.");
    this.name = "NoMatchingSessionsError";
  }
}

export class NoAnalyzableTimestampsError extends Error {
  constructor() {
    super(
      "Matching sessions did not contain enough valid timestamps to form an analyzable interval.",
    );
    this.name = "NoAnalyzableTimestampsError";
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function warningKey(warning: AnalyzeWarning): string {
  return [
    warning.code,
    warning.message,
    warning.source ?? "",
  ].join("\0");
}

function normalizeWarnings(
  warnings: readonly AnalyzeWarning[],
): AnalyzeWarning[] {
  const byKey = new Map<string, AnalyzeWarning>();
  for (const warning of warnings) {
    byKey.set(warningKey(warning), { ...warning });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message) ||
      (left.source ?? "").localeCompare(right.source ?? ""),
  );
}

function sourceWarning(warning: SourceWarning): AnalyzeWarning {
  const location =
    warning.line === undefined
      ? warning.source_path
      : `${warning.source_path}:${warning.line}`;
  return {
    code: warning.code,
    message:
      warning.session_ref === undefined
        ? warning.message
        : `${warning.message} (${warning.session_ref})`,
    source: location,
  };
}

function storeWarning(warning: StoreWarning): AnalyzeWarning {
  return {
    code: warning.code,
    message: warning.message,
    source: warning.path,
  };
}

function textWarning(
  code: string,
  message: string,
): AnalyzeWarning {
  return { code, message };
}

function warningCaveat(warning: AnalyzeWarning): string {
  return `[${warning.code}] ${warning.message}${
    warning.source === undefined ? "" : ` (${warning.source})`
  }`;
}

function orderedSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort(
    (left, right) =>
      left.source_path.localeCompare(right.source_path) ||
      left.session_id.localeCompare(right.session_id),
  );
}

function orderedEvents(sessions: readonly Session[]): NormalizedEvent[] {
  return orderedSessions(sessions)
    .flatMap((session) => session.events)
    .sort(
      (left, right) =>
        left.timestamp_ms - right.timestamp_ms ||
        left.source_index - right.source_index ||
        left.session_id.localeCompare(right.session_id) ||
        left.agent_id.localeCompare(right.agent_id) ||
        left.session_ref.localeCompare(right.session_ref) ||
        left.kind.localeCompare(right.kind),
    );
}

function toolKey(
  value: Pick<
    ToolUseEvent | ToolResultEvent | MatchedAction,
    "agent_id" | "session_id" | "tool_use_id"
  >,
): string {
  return [
    value.session_id,
    value.agent_id,
    value.tool_use_id ?? "",
  ].join("\0");
}

interface ToolEventIndex {
  uses: ReadonlyMap<string, ToolUseEvent[]>;
  results: ReadonlyMap<string, ToolResultEvent[]>;
}

function toolEventIndex(
  events: readonly NormalizedEvent[],
): ToolEventIndex {
  const uses = new Map<string, ToolUseEvent[]>();
  const results = new Map<string, ToolResultEvent[]>();
  for (const event of events) {
    if (event.kind === "tool_use") {
      const key = toolKey(event);
      const values = uses.get(key);
      if (values === undefined) uses.set(key, [event]);
      else values.push(event);
    } else if (event.kind === "tool_result") {
      const key = toolKey(event);
      const values = results.get(key);
      if (values === undefined) results.set(key, [event]);
      else values.push(event);
    }
  }
  for (const values of uses.values()) {
    values.sort(
      (left, right) =>
        left.timestamp_ms - right.timestamp_ms ||
        left.source_index - right.source_index,
    );
  }
  for (const values of results.values()) {
    values.sort(
      (left, right) =>
        left.timestamp_ms - right.timestamp_ms ||
        left.source_index - right.source_index,
    );
  }
  return { uses, results };
}

function observationFor(
  action: TimelineResult["actions"][number],
  index: ToolEventIndex,
): ActionObservation {
  if (action.tool_use_id === undefined) {
    return { action };
  }
  const key = toolKey(action);
  const toolUse = (index.uses.get(key) ?? []).find(
    (event) =>
      event.timestamp_ms === action.interval.start_ms ||
      action.session_refs.includes(event.session_ref),
  );
  const toolResult = (index.results.get(key) ?? []).find(
    (event) =>
      event.timestamp_ms === action.interval.end_ms &&
      action.session_refs.includes(event.session_ref),
  );
  return {
    action,
    ...(toolUse === undefined ? {} : { toolUse }),
    ...(toolResult === undefined ? {} : { toolResult }),
    ...(toolUse?.cwd === undefined ? {} : { cwd: toolUse.cwd }),
  };
}

function tokenEstimates(
  events: readonly NormalizedEvent[],
): ReadonlyMap<string, number> {
  const values = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "tool_result") continue;
    values.set(
      event.tool_use_id,
      Math.max(values.get(event.tool_use_id) ?? 0, event.estimated_tokens),
    );
  }
  return values;
}

function mappedTestCommands(testMap: TestMap): ReadonlySet<string> {
  return new Set(
    testMap.mappings.flatMap((mapping) => mapping.commands),
  );
}

export function buildFlakyEditRelevance(
  actions: readonly MatchedAction[],
  testMap: TestMap,
): ReadonlyMap<string, EditRelevance> {
  const commands = new Map(
    actions.flatMap((action) => {
      const normalized = action.normalized_command;
      if (normalized === undefined || normalized.trim() === "") return [];
      const descriptor = classifyCommand(normalized);
      return descriptor.opaque ||
          descriptor.family === "test" ||
          hasMappedCommand(descriptor, testMap)
        ? [[descriptor.normalized, descriptor] as const]
        : [];
    }),
  );
  const relevanceByActionId = new Map<string, EditRelevance>();
  for (const action of actions) {
    if (
      action.kind !== "tool" ||
      (
        action.match !== "contributing_edit" &&
        action.match !== "rework_edit"
      ) ||
      action.paths.length === 0 ||
      commands.size === 0
    ) {
      continue;
    }
    const decisions = [...commands.values()].map((command) =>
      evaluateTestRelevance(command, action.paths, testMap).relevant
    );
    if (decisions.some((decision) => decision === true)) {
      relevanceByActionId.set(action.action_id, "related");
    } else if (decisions.every((decision) => decision === false)) {
      relevanceByActionId.set(action.action_id, "unrelated");
    }
  }
  return relevanceByActionId;
}

function contributingIntervals(
  actions: readonly MatchedAction[],
) {
  const contributing = new Set([
    "contributing_edit",
    "contributing_run",
    "safe_read",
  ]);
  return actions
    .filter((action) => contributing.has(action.match))
    .map((action) => action.interval);
}

function commandCosts(
  actions: readonly MatchedAction[],
): StoredCommandCost[] {
  const byCommand = new Map<string, {
    intervals: MatchedAction["interval"][];
    sessionRefs: string[];
  }>();
  for (const action of actions) {
    if (
      action.kind !== "tool" ||
      action.normalized_command === undefined
    ) {
      continue;
    }
    const existing = byCommand.get(action.normalized_command);
    if (existing === undefined) {
      byCommand.set(action.normalized_command, {
        intervals: [action.interval],
        sessionRefs: [...action.session_refs],
      });
    } else {
      existing.intervals.push(action.interval);
      existing.sessionRefs.push(...action.session_refs);
    }
  }
  return [...byCommand.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([command, observations]) => {
      const elapsed = durationMs(observations.intervals);
      return elapsed <= 0
        ? []
        : [{
            command,
            duration_min: elapsed / 60_000,
            session_refs: uniqueSorted(observations.sessionRefs),
          }];
    });
}

function analysisMetrics(
  timeline: TimelineResult,
): Record<string, number> {
  const measuredMs = durationMs(timeline.activeIntervals);
  const humanWaitMs = durationMs(
    intersectIntervals(
      timeline.humanWaitIntervals,
      timeline.activeIntervals,
    ),
  );
  return {
    human_wait_ratio: measuredMs === 0 ? 0 : humanWaitMs / measuredMs,
  };
}

function findingOrder(left: Finding, right: Finding): number {
  return (
    right.recoverable.min - left.recoverable.min ||
    left.rule_id.localeCompare(right.rule_id) ||
    left.finding_key.localeCompare(right.finding_key)
  );
}

async function resolveTestMap(
  options: AnalyzeOptions,
  repoRoot: string,
): Promise<TestMap> {
  if (options.testMap !== undefined && options.testMapPath !== undefined) {
    throw new TypeError("testMap and testMapPath are mutually exclusive");
  }
  const manifest = await discoverManifestTestMap(repoRoot);
  if (options.testMap !== undefined) {
    return mergeTestMaps(options.testMap, manifest);
  }
  if (options.testMapPath !== undefined) {
    return mergeTestMaps(
      await loadExplicitTestMap(options.testMapPath),
      manifest,
    );
  }
  return manifest;
}

function defaultSessionSource(options: AnalyzeOptions): SessionSource {
  const projectsDirectory =
    options.claudeProjectsDirectory ??
    process.env.CCPROF_CLAUDE_PROJECTS_DIR ??
    join(homedir(), ".claude", "projects");
  return new ClaudeSessionSource(projectsDirectory);
}

function contextWindow(
  context: PrContext,
  warnings: AnalyzeWarning[],
): { startedAtMs: number; endedAtMs: number } {
  const startedAtMs = context.earliestUniqueCommitAtMs ?? 0;
  if (context.earliestUniqueCommitAtMs === undefined) {
    warnings.push(
      textWarning(
        "pr_start_fallback",
        "The earliest unique commit time was unavailable; session discovery used an unbounded start.",
      ),
    );
  }
  let endedAtMs = context.createdAtMs ?? context.resolvedAtMs;
  if (context.createdAtMs === undefined) {
    warnings.push(
      textWarning(
        "pr_end_fallback",
        "PR creation time was unavailable; analysis resolution time was used as the end bound.",
      ),
    );
  }
  if (endedAtMs < startedAtMs) {
    endedAtMs = context.resolvedAtMs;
    warnings.push(
      textWarning(
        "invalid_pr_window",
        "The PR creation time preceded the branch start; analysis resolution time was used instead.",
      ),
    );
  }
  return { startedAtMs, endedAtMs };
}

function ruleCandidates(
  matched: readonly MatchedAction[],
  timeline: TimelineResult,
  events: readonly NormalizedEvent[],
  history: readonly AnalysisRecord[],
  testMap: TestMap,
  externalToolNames: ReadonlySet<string> | undefined,
): FindingCandidate[] {
  const userEvents = events.filter(
    (event): event is Extract<NormalizedEvent, { kind: "genuine_user" }> =>
      event.kind === "genuine_user",
  );
  const assistantEvents = events.filter(
    (event): event is AssistantEvent => event.kind === "assistant",
  );
  const toolResults = events.filter(
    (event): event is ToolResultEvent => event.kind === "tool_result",
  );
  return [
    ...detectRework(matched, { userEvents }),
    ...detectRedundantRuns(matched),
    ...detectRediscovery(matched, {
      estimatedTokensByToolUseId: tokenEstimates(events),
      history,
    }),
    ...detectHumanWait(timeline.actions, { assistantEvents }),
    ...detectSerialSlack(matched),
    ...detectChronicCost(history),
    ...detectContextBloat(matched, {
      events,
      ...(externalToolNames === undefined ? {} : { externalToolNames }),
    }),
    ...detectFlakyTests(matched, {
      toolResults,
      additionalTestCommands: mappedTestCommands(testMap),
      editRelevanceByActionId: buildFlakyEditRelevance(matched, testMap),
      history,
    }),
  ];
}

function priorRecords(
  history: readonly AnalysisRecord[],
  context: PrContext,
): AnalysisRecord[] {
  return history.filter(
    (record) =>
      record.unit.repo !== context.repoRoot ||
      record.unit.pr_ref !== context.prRef,
  );
}

export async function analyze(
  options: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const context = await resolvePrContext({
    cwd: options.cwd,
    ...(options.pr === undefined ? {} : { input: options.pr }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
  });
  const warnings: AnalyzeWarning[] = context.warnings.map((message) =>
    textWarning("pr_context", message)
  );
  const window = contextWindow(context, warnings);
  const source = options.sessionSource ?? defaultSessionSource(options);
  const sessions = orderedSessions(
    await source.discover({
      repoRoot: context.repoRoot,
      headBranch: context.headBranch,
      ...window,
    }),
  );
  if (sessions.length === 0) {
    throw new NoMatchingSessionsError();
  }
  warnings.push(
    ...sessions.flatMap((session) => session.warnings.map(sourceWarning)),
  );

  const timeline = buildTimeline(sessions, {
    ...(options.idleThresholdMs === undefined
      ? {}
      : { idleThresholdMs: options.idleThresholdMs }),
  });
  warnings.push(
    ...timeline.caveats.map((message) => textWarning("timeline", message)),
  );
  if (timeline.rawIntervals.length === 0) {
    throw new NoAnalyzableTimestampsError();
  }

  const [diff, testMap, paths] = await Promise.all([
    collectDiffEvidence({
      cwd: context.repoRoot,
      baseOid: context.base.oid,
      headOid: context.head.oid,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    }),
    resolveTestMap(options, context.repoRoot),
    options.storePaths === undefined
      ? resolveStorePaths(context.repoRoot)
      : Promise.resolve(options.storePaths),
  ]);
  warnings.push(
    ...diff.caveats.map((message) => textWarning("git_diff", message)),
    ...testMap.caveats.map((message) => textWarning("test_map", message)),
  );

  const [historyResult, dismissalResult] = await Promise.all([
    loadAnalyses(paths),
    loadDismissals(paths),
  ]);
  warnings.push(
    ...historyResult.warnings.map(storeWarning),
    ...dismissalResult.warnings.map(storeWarning),
  );
  const history = priorRecords(historyResult.records, context);
  const events = orderedEvents(sessions);
  const eventIndex = toolEventIndex(events);
  const matched = matchTimelineActions(
    timeline.actions.map((action) =>
      observationFor(action, eventIndex)
    ),
    {
      diff,
      testMap,
      repoRoot: context.repoRoot,
    },
  );
  const candidates = ruleCandidates(
    matched,
    timeline,
    events,
    history,
    testMap,
    options.externalToolNames,
  );
  const unit = {
    repo: context.repoRoot,
    pr_ref: context.prRef,
    sessions: uniqueSorted(sessions.map((session) => session.session_id)),
  };
  const ledgerInput = {
    rawIntervals: timeline.rawIntervals,
    activeIntervals: timeline.activeIntervals,
    contributingIntervals: contributingIntervals(matched),
    candidates,
  };
  const preliminaryLedger = reconcileLedger(ledgerInput);
  const metrics = analysisMetrics(timeline);
  const costs = commandCosts(matched);
  const draftRecord = makeAnalysisRecord({
    created_at_ms: context.resolvedAtMs,
    unit,
    summary: preliminaryLedger.summary,
    findings: [...preliminaryLedger.findings].sort(findingOrder),
    metrics,
    command_costs: costs,
  });
  const baseline = computeBaseline(draftRecord, history);
  const ledger = baseline === null
    ? preliminaryLedger
    : reconcileLedger({ ...ledgerInput, baseline });
  const allFindings = [...ledger.findings].sort(findingOrder);
  const record = makeAnalysisRecord({
    created_at_ms: context.resolvedAtMs,
    unit,
    summary: ledger.summary,
    findings: allFindings,
    metrics,
    command_costs: costs,
  });
  const saveResult = await saveAnalysis(paths, record);
  warnings.push(...saveResult.warnings.map(storeWarning));

  const applied = applyDismissals(
    allFindings,
    dismissalResult.records,
    context.resolvedAtMs,
  );
  const normalizedWarnings = normalizeWarnings(warnings);
  const caveats = uniqueSorted([
    ...KNOWN_LIMITATIONS,
    ...normalizedWarnings.map(warningCaveat),
  ]);
  const report: ReportV2 = {
    version: 2,
    unit,
    summary: ledger.summary,
    findings: [...applied.findings]
      .filter((finding) => finding.recoverable.min > 0)
      .sort(findingOrder)
      .slice(0, 3),
    caveats,
  };
  return {
    report,
    allFindings,
    record: saveResult.record,
    warnings: normalizedWarnings,
    suppressedKeys: applied.suppressed_keys,
    ledger,
  };
}
