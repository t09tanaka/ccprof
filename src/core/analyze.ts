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
  AnalysisWindow,
  AssistantEvent,
  Finding,
  FindingCandidate,
  MatchedAction,
  NormalizedEvent,
  ReportV2,
  Session,
  SkippedRule,
  SourceWarning,
  ToolResultEvent,
  ToolUseEvent,
} from "./model.js";
import {
  detectAdoptions,
  detectability,
  type AdoptionCandidateFinding,
} from "../analysis/adoption.js";
import {
  isDelegationToolName,
  matchTimelineActions,
  type ActionObservation,
} from "../analysis/diff-matcher.js";
import {
  classifyCommand,
  commandMayMutateRepo,
} from "../analysis/command.js";
import {
  applyHookEvents,
  loadHookEvents,
} from "../analysis/hook-events.js";
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
import { runCommand, type CommandRunner } from "../git/client.js";
import { collectDiffEvidence } from "../git/diff.js";
import {
  resolvePrContext,
  type PrContext,
} from "../git/pr-context.js";
import { ruleApplicability } from "../rules/capabilities.js";
import { detectChronicCost } from "../rules/chronic-cost.js";
import { detectContextBloat } from "../rules/context-bloat.js";
import {
  detectFlakyTests,
  flakyEditRelevanceKey,
  type EditRelevance,
} from "../rules/flaky-test.js";
import { detectHumanWait } from "../rules/human-wait.js";
import { detectRediscovery } from "../rules/rediscovery.js";
import { detectRedundantRuns } from "../rules/redundant-runs.js";
import { detectRework } from "../rules/rework.js";
import { detectSerialSlack } from "../rules/serial-slack.js";
import { minimumConfidence } from "../rules/shared.js";
import {
  ClaudeDiscoveryError,
  ClaudeSessionSource,
} from "../sources/claude/discover.js";
import { CodexSessionSource } from "../sources/codex/discover.js";
import { CombinedSessionSource } from "../sources/combined.js";
import type { SessionSource } from "../sources/session-source.js";
import {
  computeBaseline,
  loadAnalyses,
  makeAnalysisRecord,
  saveAnalysis,
  type AnalysisRecord,
  type StoreWarning,
  type StoredCommandCost,
  type StoredReadObservation,
} from "../store/analyses.js";
import {
  applyDismissals,
  loadDismissals,
} from "../store/dismissals.js";
import {
  loadAdoptions,
  saveAdoptions,
  type AdoptionRecord,
} from "../store/adoptions.js";
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
  sinceMs?: number;
  commitAnchorLookbackMs?: number;
  idleThresholdMs?: number;
  testMapPath?: string;
  testMap?: TestMap;
  sessionSource?: SessionSource;
  claudeProjectsDirectory?: string;
  codexSessionsDirectory?: string;
  storePaths?: StorePaths;
  runner?: CommandRunner;
  nowMs?: number;
  externalToolNames?: ReadonlySet<string>;
  /**
   * When `false`, skips persisting this analysis: neither `saveAnalysis`
   * nor `saveAdoptions` is called. Adoption detection itself is skipped
   * entirely in that case too (rather than running detection but
   * discarding the result) since detection only exists to feed the save,
   * and running it would spend a git-backed check for no benefit. Callers
   * that need a persisted `record`/`adoptions` (e.g. `ccprof stats`) must
   * use the default `true`. Defaults to `true`.
   */
  persist?: boolean;
}

export interface AnalyzeWarning {
  code: string;
  message: string;
  source?: string;
}

export interface AnalyzeResult {
  report: ReportV2;
  window: AnalysisWindow;
  allFindings: Finding[];
  record: AnalysisRecord;
  warnings: AnalyzeWarning[];
  suppressedKeys: string[];
  ledger: LedgerResult;
  adoptions: AdoptionRecord[];
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

export class InvalidAnalysisWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnalysisWindowError";
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

/**
 * A `ClaudeDiscoveryError` carries per-file failure details in `warnings`
 * (one `SourceWarning` per unreadable source); surface those paths so the
 * resulting `session_source_error` warning says which files failed rather
 * than just that discovery failed. Other errors keep a message-only summary.
 */
function sourceErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error instanceof ClaudeDiscoveryError && error.warnings.length > 0) {
    const paths = [
      ...new Set(error.warnings.map((warning) => warning.source_path)),
    ];
    return `${error.message} (${paths.join(", ")})`;
  }
  return error.message;
}

/**
 * Rules a session's declared capabilities cannot support, derived from
 * `ruleApplicability`. Sorted by rule_id and omitted entirely (empty array)
 * when every session has full capabilities, so a Claude-only analysis is
 * unaffected.
 */
function skippedRules(sessions: readonly Session[]): SkippedRule[] {
  return ruleApplicability(sessions)
    .filter((entry) => !entry.applicable)
    .map((entry): SkippedRule => ({
      rule_id: entry.rule_id,
      missing: entry.missing,
    }))
    .sort((left, right) => left.rule_id.localeCompare(right.rule_id));
}

function skippedRuleWarning(skipped: SkippedRule): AnalyzeWarning {
  return textWarning(
    "rule_skipped_missing_capability",
    `${skipped.rule_id} skipped: session source lacks ${
      skipped.missing.join(", ")
    }`,
  );
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
  ).map((session) => ({
    ...session,
    events: session.events.map((event) => ({ ...event,
      confidence: minimumConfidence([event.confidence, session.confidence]) })),
  }));
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
    testMap.mappings
      .flatMap((mapping) => mapping.commands)
      .filter((command) => {
        const family = classifyCommand(command).family;
        return family !== "build" && family !== "check";
      }),
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
  const relevanceByActionAndCommand = new Map<string, EditRelevance>();
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
    for (const command of commands.values()) {
      const decision = evaluateTestRelevance(
        command,
        action.paths,
        testMap,
      ).relevant;
      if (decision === true) {
        relevanceByActionAndCommand.set(
          flakyEditRelevanceKey(action.action_id, command.normalized),
          "related",
        );
      } else if (decision === false) {
        relevanceByActionAndCommand.set(
          flakyEditRelevanceKey(action.action_id, command.normalized),
          "unrelated",
        );
      }
    }
  }
  return relevanceByActionAndCommand;
}

function contributingIntervals(
  actions: readonly MatchedAction[],
) {
  const contributing = new Set([
    "contributing_edit",
    "contributing_run",
    "safe_read",
    "coordination",
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

const READ_BLOB = /^(?:100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/iu;
const READ_ONLY_TOOL = /^(?:glob|grep|list|ls|read|search)$/u;
async function readObservations(
  actions: readonly MatchedAction[], context: PrContext,
  runnerOption: CommandRunner | undefined, warnings: AnalyzeWarning[],
): Promise<{ objects: Map<string, string>; observations: StoredReadObservation[]; eligibleReadKeys: Set<string> }> {
  const byPath = new Map<string, MatchedAction[]>();
  const eligibleReadKeys = new Set<string>();
  for (const action of actions) {
    if (action.kind !== "tool" || (action.match !== "safe_read" && action.match !== "duplicate_read")) continue;
    for (const path of action.paths) {
      if (actions.some((mutation) =>
        mutation.kind === "tool" &&
        mutation.interval.end_ms > action.interval.start_ms &&
        (((mutation.match === "contributing_edit" ||
          mutation.match === "rework_edit") && mutation.paths.includes(path)) ||
          (mutation.match === "unexplained" &&
            mutation.normalized_command === undefined &&
            !READ_ONLY_TOOL.test((mutation.tool_name ?? "")
              .replaceAll("-", "_").toLowerCase())) ||
          (mutation.match === "coordination" &&
            isDelegationToolName(mutation.tool_name)) ||
          (mutation.command !== undefined &&
            commandMayMutateRepo(mutation.command)))
      )) continue;
      byPath.set(path, [...(byPath.get(path) ?? []), action]);
      eligibleReadKeys.add([action.session_id, action.agent_id, action.action_id, path].join("\0"));
    }
  }
  const empty = { objects: new Map<string, string>(), observations: [] as StoredReadObservation[], eligibleReadKeys };
  if (byPath.size === 0) return empty;
  let result;
  try {
    result = await (runnerOption ?? runCommand)("git", [
      "ls-tree", "-z", "--full-tree", context.head.oid, "--",
      ...[...byPath.keys()].sort().map((path) => `:(top,literal)${path}`),
    ], { cwd: context.repoRoot });
  } catch {
    result = { code: 1, stdout: "", stderr: "" };
  }
  const rows = result.stdout.split("\0");
  const objects = new Map<string, string>();
  const malformed = result.code !== 0 || result.stdoutTruncated === true ||
    rows.pop() !== "" || rows.some((row) => {
      const match = READ_BLOB.exec(row);
      if (match === null || !byPath.has(match[2] ?? "") || objects.has(match[2] ?? "")) return true;
      objects.set(match[2] ?? "", (match[1] ?? "").toLowerCase());
      return false;
    });
  if (malformed) { warnings.push(textWarning("read_observation_unavailable",
    "Frozen-head read object identities were unavailable or malformed.")); return empty; }
  if (objects.size !== byPath.size)
    warnings.push(textWarning("read_observation_unavailable", "At least one read path was not an exact blob at the frozen PR head."));
  return { objects,
    observations: [...objects].map(([path, object_id]) => ({
      path, object_id,
      duration_min: durationMs((byPath.get(path) ?? []).map(({ interval }) => interval)) / 60_000,
      session_refs: uniqueSorted((byPath.get(path) ?? []).flatMap(({ session_refs }) => session_refs)),
      confidence: minimumConfidence((byPath.get(path) ?? []).flatMap((action) =>
        [action.confidence, action.match_confidence])),
    })), eligibleReadKeys };
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

function defaultSessionSource(
  options: AnalyzeOptions,
  onSourceError?: (error: unknown) => void,
): SessionSource {
  const projectsDirectory =
    options.claudeProjectsDirectory ??
    process.env.CCPROF_CLAUDE_PROJECTS_DIR ??
    join(homedir(), ".claude", "projects");
  const claudeSource = new ClaudeSessionSource(projectsDirectory);
  const codexSource = new CodexSessionSource(
    options.codexSessionsDirectory === undefined
      ? undefined
      : { sessionsDirectory: options.codexSessionsDirectory },
  );
  return new CombinedSessionSource([claudeSource, codexSource], onSourceError);
}

function validWindowTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidAnalysisWindowError(
      `${name} must be a nonnegative safe integer`,
    );
  }
}

export function resolveAnalysisWindow(
  context: PrContext,
  options: Pick<AnalyzeOptions, "sinceMs" | "commitAnchorLookbackMs"> = {},
  warnings: AnalyzeWarning[] = [],
): AnalysisWindow {
  validWindowTimestamp(context.resolvedAtMs, "analysis resolution");
  if (options.sinceMs !== undefined) {
    validWindowTimestamp(options.sinceMs, "explicit analysis start");
  }
  if (options.commitAnchorLookbackMs !== undefined) {
    validWindowTimestamp(
      options.commitAnchorLookbackMs,
      "commit anchor lookback",
    );
  }
  if (context.earliestUniqueCommitAtMs !== undefined) {
    validWindowTimestamp(
      context.earliestUniqueCommitAtMs,
      "earliest unique commit time",
    );
  }
  if (context.branchReflogStartedAtMs !== undefined) {
    validWindowTimestamp(
      context.branchReflogStartedAtMs,
      "branch reflog start",
    );
  }

  const endedAtMs = context.resolvedAtMs;
  if (options.sinceMs !== undefined) {
    if (options.sinceMs > endedAtMs) {
      throw new InvalidAnalysisWindowError(
        "explicit analysis start must not be after analysis resolution",
      );
    }
    return {
      started_at_ms: options.sinceMs,
      ended_at_ms: endedAtMs,
      start_source: "explicit",
      end_source: "analysis_time",
      completeness: "complete",
    };
  }

  const anchor = context.earliestUniqueCommitAtMs;
  if (context.branchReflogStartedAtMs !== undefined) {
    if (
      context.branchReflogStartedAtMs <= endedAtMs &&
      (anchor === undefined || context.branchReflogStartedAtMs <= anchor)
    ) {
      return {
        started_at_ms: context.branchReflogStartedAtMs,
        ended_at_ms: endedAtMs,
        start_source: "branch_reflog",
        end_source: "analysis_time",
        completeness: "partial",
      };
    }
    warnings.push(textWarning(
      context.branchReflogStartedAtMs > endedAtMs
        ? "invalid_branch_reflog_start"
        : "branch_reflog_after_commit_anchor",
      context.branchReflogStartedAtMs > endedAtMs
        ? "The branch reflog start followed analysis resolution; the commit anchor fallback was used."
        : "The branch reflog start followed the earliest unique commit; the commit anchor fallback was used.",
    ));
  }

  const lookbackMs = options.commitAnchorLookbackMs ?? 0;
  if (anchor === undefined) {
    warnings.push(
      textWarning(
        "pr_start_fallback",
        "The earliest unique commit time was unavailable; session discovery used an unbounded start.",
      ),
    );
    return {
      started_at_ms: 0,
      ended_at_ms: endedAtMs,
      start_source: "commit_anchor_lookback",
      end_source: "analysis_time",
      completeness: "partial",
    };
  }
  const startedAtMs = Math.max(0, anchor - lookbackMs);
  if (startedAtMs > endedAtMs) {
    warnings.push(
      textWarning(
        "invalid_pr_window",
        "The commit-derived start followed analysis resolution; session discovery used an unbounded start.",
      ),
    );
    return {
      started_at_ms: 0,
      ended_at_ms: endedAtMs,
      start_source: "commit_anchor_lookback",
      end_source: "analysis_time",
      completeness: "partial",
    };
  }
  return {
    started_at_ms: startedAtMs,
    ended_at_ms: endedAtMs,
    start_source: "commit_anchor_lookback",
    end_source: "analysis_time",
    completeness: "partial",
  };
}

function ruleCandidates(
  matched: readonly MatchedAction[],
  timeline: TimelineResult,
  events: readonly NormalizedEvent[],
  history: readonly AnalysisRecord[],
  currentObjectIdsByPath: ReadonlyMap<string, string>,
  crossPrEligibleReadKeys: ReadonlySet<string>,
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
      currentObjectIdsByPath,
      crossPrEligibleReadKeys,
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

/**
 * Builds detectable adoption candidates from prior analysis history. Each
 * finding_key is represented once, by the oldest record it appeared in
 * (ties broken by analysis_id), so a candidate's recorded_at_ms reflects the
 * first time the suggestion was surfaced. Finding_keys already present in
 * the adoptions store, and candidates the detector cannot ever confirm, are
 * excluded before the (possibly expensive) git-backed detection runs.
 */
function adoptionCandidates(
  history: readonly AnalysisRecord[],
  existingAdoptions: readonly AdoptionRecord[],
): AdoptionCandidateFinding[] {
  const existingKeys = new Set(
    existingAdoptions.map((record) => record.finding_key),
  );
  const oldestByKey = new Map<
    string,
    { record: AnalysisRecord; finding: Finding }
  >();
  for (const record of history) {
    for (const finding of record.findings) {
      if (existingKeys.has(finding.finding_key)) continue;
      const existing = oldestByKey.get(finding.finding_key);
      if (
        existing === undefined ||
        record.created_at_ms < existing.record.created_at_ms ||
        (record.created_at_ms === existing.record.created_at_ms &&
          record.analysis_id.localeCompare(existing.record.analysis_id) < 0)
      ) {
        oldestByKey.set(finding.finding_key, { record, finding });
      }
    }
  }
  return [...oldestByKey.values()]
    .map(({ record, finding }): AdoptionCandidateFinding => ({
      finding_key: finding.finding_key,
      rule_id: finding.rule_id,
      scope: finding.scope,
      ...(finding.target === undefined ? {} : { target: finding.target }),
      suggestion: finding.fix_recipe.suggestion,
      recorded_at_ms: record.created_at_ms,
    }))
    .filter((candidate) => detectability(candidate) !== "undetectable");
}

export async function analyze(
  options: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const context = await resolvePrContext({
    cwd: options.cwd,
    ...(options.pr === undefined ? {} : { input: options.pr }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    includeBranchReflog: options.sinceMs === undefined,
  });
  const warnings: AnalyzeWarning[] = context.warnings.map((message) =>
    textWarning("pr_context", message)
  );
  const window = resolveAnalysisWindow(context, options, warnings);
  // Only the default (Claude + Codex combined) source reports per-source
  // discovery failures this way; an injected sessionSource (tests, or a
  // future custom integration) keeps its original throw-propagates
  // behavior untouched.
  const sourceErrors: unknown[] = [];
  const source = options.sessionSource ??
    defaultSessionSource(options, (error) => sourceErrors.push(error));
  let sessions = orderedSessions(
    await source.discover({
      repoRoot: context.repoRoot,
      headBranch: context.headBranch,
      startedAtMs: window.started_at_ms,
      endedAtMs: window.ended_at_ms,
    }),
  );
  if (sessions.length === 0) {
    // Nothing was found at all: if a source failed, its error is almost
    // certainly why, so surface it instead of the generic
    // NoMatchingSessionsError (restores pre-combined-source diagnosability
    // when the primary source is unreadable/misconfigured).
    if (sourceErrors.length > 0) {
      throw sourceErrors[0];
    }
    throw new NoMatchingSessionsError();
  }
  if (sourceErrors.length > 0) {
    warnings.push(
      ...sourceErrors.map((error) =>
        textWarning("session_source_error", sourceErrorMessage(error))
      ),
    );
  }
  warnings.push(
    ...sessions.flatMap((session) => session.warnings.map(sourceWarning)),
  );

  // Resolved here (ahead of the diff/testMap Promise.all below) because
  // hook-recorded wall clock times must be folded into `sessions` before
  // `buildTimeline` runs; diff and testMap have no such ordering
  // requirement and stay parallelized together.
  const paths = options.storePaths === undefined
    ? await resolveStorePaths(context.repoRoot)
    : options.storePaths;
  const hookEvents = await loadHookEvents(paths.hook_events_path);
  warnings.push(...hookEvents.warnings.map(storeWarning));
  sessions = applyHookEvents(
    sessions,
    hookEvents.rows.filter((row) => row.received_at_ms <= window.ended_at_ms),
  );

  const inapplicableRules = skippedRules(sessions);
  warnings.push(...inapplicableRules.map(skippedRuleWarning));

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

  const [diff, testMap] = await Promise.all([
    collectDiffEvidence({
      cwd: context.repoRoot,
      baseOid: context.base.oid,
      headOid: context.head.oid,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    }),
    resolveTestMap(options, context.repoRoot),
  ]);
  warnings.push(
    ...diff.caveats.map((message) => textWarning("git_diff", message)),
    ...testMap.caveats.map((message) => textWarning("test_map", message)),
  );

  const [historyResult, dismissalResult, adoptionResult] = await Promise.all([
    loadAnalyses(paths),
    loadDismissals(paths),
    loadAdoptions(paths),
  ]);
  warnings.push(
    ...historyResult.warnings.map(storeWarning),
    ...dismissalResult.warnings.map(storeWarning),
    ...adoptionResult.warnings.map(storeWarning),
  );
  const history = priorRecords(historyResult.records, context);
  const persist = options.persist ?? true;

  // Adoption detection only exists to feed a save; when persist is false
  // (e.g. a hook-driven `--notify` analysis) skip it entirely rather than
  // detect-then-discard, which would spend a git-backed check for nothing.
  let mergedAdoptions = adoptionResult.records;
  if (persist) {
    const adoptionDetection = await detectAdoptions({
      repoRoot: context.repoRoot,
      candidates: adoptionCandidates(history, adoptionResult.records),
      detectedAtMs: context.resolvedAtMs,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
    warnings.push(...adoptionDetection.warnings);
    mergedAdoptions = adoptionDetection.adoptions.length === 0
      ? adoptionResult.records
      : [...adoptionResult.records, ...adoptionDetection.adoptions];
    if (adoptionDetection.adoptions.length > 0) {
      const adoptionSaveWarnings = await saveAdoptions(paths, mergedAdoptions);
      warnings.push(...adoptionSaveWarnings.map(storeWarning));
    }
  }
  const adoptions = [...mergedAdoptions].sort(
    (left, right) => left.finding_key.localeCompare(right.finding_key),
  );

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
  const reads = await readObservations(matched, context, options.runner, warnings);
  const inapplicableRuleIds = new Set(
    inapplicableRules.map((skipped) => skipped.rule_id),
  );
  const candidates = ruleCandidates(
    matched,
    timeline,
    events,
    history,
    reads.objects,
    reads.eligibleReadKeys,
    testMap,
    options.externalToolNames,
  ).filter((candidate) => !inapplicableRuleIds.has(candidate.rule_id));
  const unit = {
    repo: context.repoRoot,
    pr_ref: context.prRef,
    sessions: uniqueSorted(sessions.map((session) => session.session_id)),
  };
  const ledgerInput = {
    rawIntervals: timeline.rawIntervals,
    activeIntervals: timeline.activeIntervals,
    contributingIntervals: contributingIntervals(matched),
    // Includes both turn-gap waits and AskUserQuestion waits: the timeline
    // builds humanWaitIntervals from every action with kind "human_wait".
    // Away time is excluded from activeIntervals, so it stays idle.
    humanWaitIntervals: timeline.humanWaitIntervals,
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
    read_observations: reads.observations,
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
    read_observations: reads.observations,
  });
  const saveResult = persist
    ? await saveAnalysis(paths, record)
    : { record, warnings: [] as StoreWarning[] };
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
    ...(inapplicableRules.length === 0
      ? {}
      : { skipped_rules: inapplicableRules }),
  };
  return {
    report,
    window,
    allFindings,
    record: saveResult.record,
    warnings: normalizedWarnings,
    suppressedKeys: applied.suppressed_keys,
    ledger,
    adoptions,
  };
}
