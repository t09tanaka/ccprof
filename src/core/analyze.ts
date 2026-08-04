import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  durationMs,
  intersectIntervals,
} from "./intervals.js";
import {
  reconcileLedger,
  type LedgerResult,
} from "./ledger.js";
import {
  encodeEventIdentity,
  encodeInvocationIdentity,
  eventIdentity,
  evidenceEventIdentity,
} from "./event-identity.js";
import type {
  AnalysisWindow,
  AssistantEvent,
  Finding,
  FindingCandidate,
  MatchedAction,
  NormalizedEvent,
  ReportV2,
  RuleCoverage,
  RuleId,
  Session,
  SkippedRule,
  SourceWarning,
  ToolResultEvent,
  ToolUseEvent,
} from "./model.js";
import { sourceDescriptorsForSessions } from "./source-descriptor.js";
import {
  detectAdoptions,
  detectability,
  type AdoptionCandidateFinding,
} from "../analysis/adoption.js";
import {
  AnalysisBudgetMeter,
  systemAnalysisBudgetClock,
  type AnalysisBudgetClock,
  type AnalysisBudgets,
} from "../analysis/budgets.js";
import {
  isDelegationToolName,
  matchTimelineActions,
  type ActionObservation,
} from "../analysis/diff-matcher.js";
import { sliceSessionsToAnalysisWindow } from "../analysis/window.js";
import {
  classifyCommand,
  commandMayMutateRepo,
} from "../analysis/command.js";
import { commandIdentityKey } from "../analysis/command-identity.js";
import {
  applyHookEvents,
  loadHookEvents,
} from "../analysis/hook-events.js";
import {
  buildTimeline,
  DEFAULT_IDLE_THRESHOLD_MS,
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
import { loadRepositoryConfig } from "../analysis/repository-config.js";
import { runCommand, type CommandRunner } from "../git/client.js";
import { collectDiffEvidence } from "../git/diff.js";
import {
  resolvePrContext,
  type PrContext,
} from "../git/pr-context.js";
import {
  finalizeBudgetedOutput,
  type AnalysisOutputProjector,
  type FinalizedBudgetedOutput,
} from "../reporters/budget.js";
import { renderJsonReport } from "../reporters/json.js";
import { projectReportPrivacy } from "../reporters/privacy.js";
import {
  canonicalRuleSafetySnapshot,
  snapshotEffectiveRuleSafetyPolicy,
  type EffectiveRuleSafetyPolicy,
} from "../policy/rule-safety.js";
import {
  ruleCoverage,
  sessionSupportsRule,
} from "../rules/capabilities.js";
import { detectChronicCost } from "../rules/chronic-cost.js";
import { detectContextBloat } from "../rules/context-bloat.js";
import {
  detectFlakyTests,
  flakyEditRelevanceKey,
  type EditRelevance,
} from "../rules/flaky-test.js";
import { detectHumanWait } from "../rules/human-wait.js";
import {
  detectRediscovery,
  rediscoveryReadIdentityKey,
} from "../rules/rediscovery.js";
import { detectRedundantRuns } from "../rules/redundant-runs.js";
import { detectRework } from "../rules/rework.js";
import { detectSerialSlack } from "../rules/serial-slack.js";
import {
  listRuleManifests,
  withRuleManifest,
} from "../rules/manifest.js";
import { minimumConfidence } from "../rules/shared.js";
import {
  ClaudeDiscoveryError,
  ClaudeSessionSource,
} from "../sources/claude/discover.js";
import { CodexSessionSource } from "../sources/codex/discover.js";
import { CombinedSessionSource } from "../sources/combined.js";
import {
  admitSessionEventPrefix,
  type SessionSource,
} from "../sources/session-source.js";
import {
  analysisDigest,
  computeBaseline,
  loadAnalyses,
  makeAnalysisRecord,
  saveAnalysis,
  type AnalysisRecord,
  type AnalysisSnapshotIdentity,
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
  canonicalRepoPath,
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
  resolveRuleSafetyPolicy?: (
    repoRoot: string,
  ) => Promise<EffectiveRuleSafetyPolicy | undefined>;
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
  budgets?: AnalysisBudgets;
  budgetClock?: AnalysisBudgetClock;
  /** Internal display adapter used only when an analysis budget is active. */
  outputProjector?: AnalysisOutputProjector;
}

export interface AnalyzeWarning {
  code: string;
  message: string;
  source?: string;
}

export interface AnalysisWindowEvidence { sessionBranchTransitionAtMs?: number; }

export interface AnalyzeResult {
  report: ReportV2;
  window: AnalysisWindow;
  allFindings: Finding[];
  record: AnalysisRecord;
  warnings: AnalyzeWarning[];
  suppressedKeys: string[];
  ledger: LedgerResult;
  adoptions: AdoptionRecord[];
  /** Exact privacy-projected bytes finalized before an active-budget save. */
  preparedOutput?: string;
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
 * Legacy projection of rules with no eligible sessions. Partially covered
 * rules stay evaluated and are never reported as skipped.
 */
function skippedRules(coverage: readonly RuleCoverage[]): SkippedRule[] {
  return coverage
    .filter((entry) => entry.status === "partial" && entry.eligible_sessions === 0)
    .map((entry): SkippedRule => ({
      rule_id: entry.rule_id,
      missing: [...entry.missing_capabilities],
    }))
    .sort((left, right) => left.rule_id.localeCompare(right.rule_id));
}

export function ruleSessionLanes(
  sessions: readonly Session[],
): Record<RuleId, Session[]> {
  const lane = (ruleId: RuleId): Session[] =>
    sessions.filter((session) => sessionSupportsRule(session, ruleId));
  return {
    R001: lane("R001"),
    R002: lane("R002"),
    R003: lane("R003"),
    R004: lane("R004"),
    R005: lane("R005"),
    R006: lane("R006"),
    R007: lane("R007"),
    R008: lane("R008"),
  };
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
      left.source.localeCompare(right.source) ||
      left.session_id.localeCompare(right.session_id),
  ).map((session) => ({
    ...session,
    events: session.events.map((event) => ({ ...event,
      confidence: minimumConfidence([event.confidence, session.confidence]) })),
  }));
}

function orderedEvents(sessions: readonly Session[]): NormalizedEvent[] {
  return orderedSessions(sessions)
    .flatMap((session) => session.events.map((event): NormalizedEvent => ({
      ...event,
      event_identity: eventIdentity(session, event),
    })))
    .sort(
      (left, right) =>
        left.timestamp_ms - right.timestamp_ms ||
        left.source_index - right.source_index ||
        encodeEventIdentity(evidenceEventIdentity(left)).localeCompare(
          encodeEventIdentity(evidenceEventIdentity(right)),
        ) ||
        left.session_id.localeCompare(right.session_id) ||
        left.agent_id.localeCompare(right.agent_id) ||
        left.session_ref.localeCompare(right.session_ref) ||
        left.kind.localeCompare(right.kind),
    );
}

function compareBudgetCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function backstopBudgetedSessions(
  sessions: readonly Session[],
  meter: AnalysisBudgetMeter,
): Session[] {
  const admitted: Session[] = [];
  const ordered = sessions.map((session, inputIndex) => ({
    inputIndex,
    session,
  })).sort(
    (left, right) =>
      compareBudgetCodeUnits(
        left.session.source_path,
        right.session.source_path,
      ) ||
      compareBudgetCodeUnits(left.session.source, right.session.source) ||
      compareBudgetCodeUnits(
        left.session.session_id,
        right.session.session_id,
      ) ||
      left.inputIndex - right.inputIndex,
  ).map(({ session }) => session);
  const sessionsBySourcePath = new Map<string, Session[]>();
  for (const session of ordered) {
    const group = sessionsBySourcePath.get(session.source_path);
    if (group === undefined) {
      sessionsBySourcePath.set(session.source_path, [session]);
    } else {
      group.push(session);
    }
  }
  for (const sourceSessions of sessionsBySourcePath.values()) {
    if (!meter.checkpoint()) break;
    if (!meter.admitSourceItem()) break;
    if (!meter.checkpoint()) break;
    admitted.push(...admitSessionEventPrefix(sourceSessions, meter));
    if (meter.stopped) break;
  }
  return admitted;
}

function toolKey(
  value: Pick<
    ToolUseEvent | ToolResultEvent | MatchedAction,
    "agent_id" | "session_id" | "tool_use_id"
  >,
): string {
  return encodeInvocationIdentity(evidenceEventIdentity(value));
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
  const uses = (index.uses.get(key) ?? []).filter(
    (event) =>
      event.timestamp_ms === action.interval.start_ms &&
      action.session_refs.includes(event.session_ref),
  );
  const results = (index.results.get(key) ?? []).filter(
    (event) =>
      event.timestamp_ms === action.interval.end_ms &&
      action.session_refs.includes(event.session_ref),
  );
  const toolUse = uses.length === 1 ? uses[0] : undefined;
  const toolResult = results.length === 1 ? results[0] : undefined;
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
    const key = encodeEventIdentity(evidenceEventIdentity(event));
    values.set(
      key,
      Math.max(values.get(key) ?? 0, event.estimated_tokens),
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
    command: string;
    identity: NonNullable<MatchedAction["command_identity"]>;
    intervals: MatchedAction["interval"][];
    sessionRefs: string[];
  }>();
  for (const action of actions) {
    if (
      action.kind !== "tool" ||
      action.normalized_command === undefined ||
      action.normalized_command.trim() === "" ||
      action.command_identity === undefined
    ) {
      continue;
    }
    const key = commandIdentityKey(action.command_identity);
    const existing = byCommand.get(key);
    if (existing === undefined) {
      byCommand.set(key, {
        command: action.normalized_command,
        identity: {
          ...action.command_identity,
          normalized_argv: [...action.command_identity.normalized_argv],
        },
        intervals: [action.interval],
        sessionRefs: [...action.session_refs],
      });
    } else {
      if (action.normalized_command < existing.command) {
        existing.command = action.normalized_command;
      }
      existing.intervals.push(action.interval);
      existing.sessionRefs.push(...action.session_refs);
    }
  }
  return [...byCommand.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([, observations]) => {
      const elapsed = durationMs(observations.intervals);
      return elapsed <= 0
        ? []
        : [{
            command: observations.command,
            command_identity: observations.identity,
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
      eligibleReadKeys.add(rediscoveryReadIdentityKey(action, path));
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

const FINDING_SEVERITY_RANK = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
} as const;

const FINDING_CONFIDENCE_RANK = {
  low: 0,
  medium: 1,
  high: 2,
} as const;

function findingOrder(left: Finding, right: Finding): number {
  const leftUpperMs = left.impact?.upper_ms ?? left.recoverable.min * 60_000;
  const rightUpperMs = right.impact?.upper_ms ?? right.recoverable.min * 60_000;
  const leftLowerMs = left.impact?.lower_ms ?? 0;
  const rightLowerMs = right.impact?.lower_ms ?? 0;
  return (
    rightUpperMs - leftUpperMs ||
    rightLowerMs - leftLowerMs ||
    FINDING_SEVERITY_RANK[right.severity ?? "info"] -
      FINDING_SEVERITY_RANK[left.severity ?? "info"] ||
    FINDING_CONFIDENCE_RANK[right.confidence] -
      FINDING_CONFIDENCE_RANK[left.confidence] ||
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
  const [repositoryConfig, manifest] = await Promise.all([
    loadRepositoryConfig(repoRoot),
    discoverManifestTestMap(repoRoot),
  ]);
  if (options.testMap !== undefined) {
    return mergeTestMaps(options.testMap, repositoryConfig, manifest);
  }
  if (options.testMapPath !== undefined) {
    return mergeTestMaps(
      await loadExplicitTestMap(options.testMapPath),
      repositoryConfig,
      manifest,
    );
  }
  return mergeTestMaps(repositoryConfig, manifest);
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

export function deriveSessionBranchTransitionAtMs(
  sessions: readonly Session[],
  headBranch: string,
  endedAtMs: number,
  earliestUniqueCommitAtMs?: number,
): number | undefined {
  let earliestEventAtMs: number | undefined;
  let earliestCandidateAtMs: number | undefined;
  for (const session of sessions) {
    for (const event of session.events) {
      const timestampMs = event.timestamp_ms;
      if (
        !Number.isSafeInteger(timestampMs) || timestampMs < 0 ||
        timestampMs > endedAtMs
      ) {
        continue;
      }
      earliestEventAtMs = Math.min(
        earliestEventAtMs ?? Number.POSITIVE_INFINITY,
        timestampMs,
      );
      if (
        session.source === "claude" &&
        event.branch === headBranch &&
        Number.isSafeInteger(event.branch_epoch) &&
        (event.branch_epoch ?? 0) > 0 &&
        (earliestUniqueCommitAtMs === undefined ||
          timestampMs <= earliestUniqueCommitAtMs)
      ) {
        earliestCandidateAtMs = Math.min(
          earliestCandidateAtMs ?? Number.POSITIVE_INFINITY,
          timestampMs,
        );
      }
    }
  }
  return earliestCandidateAtMs !== undefined &&
      (earliestEventAtMs ?? earliestCandidateAtMs) >= earliestCandidateAtMs
    ? earliestCandidateAtMs
    : undefined;
}

export function resolveAnalysisWindow(
  context: PrContext,
  options: Pick<AnalyzeOptions, "sinceMs" | "commitAnchorLookbackMs"> = {},
  warnings: AnalyzeWarning[] = [],
  evidence: AnalysisWindowEvidence = {},
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
  if (evidence.sessionBranchTransitionAtMs !== undefined) {
    validWindowTimestamp(
      evidence.sessionBranchTransitionAtMs,
      "session branch transition",
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
        ? "The branch reflog start followed analysis resolution; it was ignored."
        : "The branch reflog start followed the earliest unique commit; it was ignored.",
    ));
  }

  const transitionAtMs = evidence.sessionBranchTransitionAtMs;
  if (transitionAtMs !== undefined) {
    if (
      transitionAtMs <= endedAtMs &&
      (anchor === undefined || transitionAtMs <= anchor)
    ) {
      return {
        started_at_ms: transitionAtMs,
        ended_at_ms: endedAtMs,
        start_source: "session_branch_transition",
        end_source: "analysis_time",
        completeness: "partial",
      };
    }
    warnings.push(textWarning(
      transitionAtMs > endedAtMs
        ? "invalid_session_branch_transition"
        : "session_branch_transition_after_commit_anchor",
      transitionAtMs > endedAtMs
        ? "The session branch transition followed analysis resolution; the evidence was ignored."
        : "The session branch transition followed the earliest unique commit; the evidence was ignored.",
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

interface RuleEvidenceLane {
  matched: readonly MatchedAction[];
  timeline: TimelineResult;
  events: readonly NormalizedEvent[];
}

function findingSourceCompleteness(entry: RuleCoverage): number {
  return entry.truncated ? 0 : entry.completeness;
}

function ruleCandidates(
  lanes: Readonly<Record<RuleId, RuleEvidenceLane>>,
  coverage: readonly RuleCoverage[],
  history: readonly AnalysisRecord[],
  currentObjectIdsByPath: ReadonlyMap<string, string>,
  crossPrEligibleReadKeys: ReadonlySet<string>,
  testMap: TestMap,
  externalToolNames: ReadonlySet<string> | undefined,
  ruleSafety: EffectiveRuleSafetyPolicy | undefined,
): FindingCandidate[] {
  const completenessByRule = new Map(
    coverage.map((entry) => [
      entry.rule_id,
      findingSourceCompleteness(entry),
    ]),
  );
  const completeness = (ruleId: RuleId): number =>
    completenessByRule.get(ruleId) ?? 0;
  const userEvents = lanes.R001.events.filter(
    (event): event is Extract<NormalizedEvent, { kind: "genuine_user" }> =>
      event.kind === "genuine_user",
  );
  const assistantEvents = lanes.R004.events.filter(
    (event): event is AssistantEvent => event.kind === "assistant",
  );
  const toolResults = lanes.R008.events.filter(
    (event): event is ToolResultEvent => event.kind === "tool_result",
  );
  return [
    ...detectRework(lanes.R001.matched, {
      userEvents,
      sourceCompleteness: completeness("R001"),
    }),
    ...detectRedundantRuns(lanes.R002.matched, {
      sourceCompleteness: completeness("R002"),
    }),
    ...detectRediscovery(lanes.R003.matched, {
      estimatedTokensByEventIdentity: tokenEstimates(lanes.R003.events),
      history,
      currentObjectIdsByPath,
      crossPrEligibleReadKeys,
      sourceCompleteness: completeness("R003"),
    }),
    ...detectHumanWait(lanes.R004.timeline.actions, {
      assistantEvents,
      ...(ruleSafety === undefined ? {} : { ruleSafety }),
      sourceCompleteness: completeness("R004"),
    }),
    ...detectSerialSlack(lanes.R005.matched, {
      ...(ruleSafety === undefined ? {} : { ruleSafety }),
      sourceCompleteness: completeness("R005"),
    }),
    ...detectChronicCost(history, {
      sourceCompleteness: completeness("R006"),
    }),
    ...detectContextBloat(lanes.R007.matched, {
      events: lanes.R007.events,
      ...(externalToolNames === undefined ? {} : { externalToolNames }),
      sourceCompleteness: completeness("R007"),
    }),
    ...detectFlakyTests(lanes.R008.matched, {
      toolResults,
      additionalTestCommands: mappedTestCommands(testMap),
      editRelevanceByActionId: buildFlakyEditRelevance(lanes.R008.matched, testMap),
      history,
      sourceCompleteness: completeness("R008"),
    }),
  ];
}

function priorRecords(
  history: readonly AnalysisRecord[],
  context: PrContext,
): AnalysisRecord[] {
  return history.filter((record) => record.unit.pr_ref !== context.prRef);
}

function relativeRepoPath(value: string, repoRoot: string): string | undefined {
  const normalized = value.normalize("NFC");
  if (!isAbsolute(normalized)) return undefined;
  const local = relative(repoRoot, normalized);
  if (local === "") return ".";
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)
    ? local.split(sep).join("/") : undefined;
}
function snapshotPath(value: string, repoRoot: string): string {
  return relativeRepoPath(value, repoRoot) ??
    value.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//u, "");
}
function sourceFailureSnapshot(error: unknown): unknown {
  if (!(error instanceof Error)) return { type: typeof error, name: "non_error_throw" };
  return { type: error.constructor.name, name: error.name, message: error.message,
    ...(error instanceof ClaudeDiscoveryError ? { warnings: error.warnings.map(
      ({ source_path: _path, ...warning }) => warning) } : {}) };
}
function sourceSnapshot(sessions: readonly Session[], repoRoot: string): unknown[] {
  return sessions.map((session) => {
    const { source_path: _sourcePath, ...rest } = session;
    const projected = { ...rest, observed_cwds: session.observed_cwds.map(
      (path) => snapshotPath(path, repoRoot)),
      ...(session.capabilities === undefined ? {} : { capabilities: uniqueSorted(session.capabilities) }),
      events: session.events.map((event) => event.kind === "tool_use"
        ? { ...event, paths: event.paths.map((path) => snapshotPath(path, repoRoot)),
          ...(event.cwd === undefined ? {} : { cwd: snapshotPath(event.cwd, repoRoot) }) }
        : event),
      warnings: session.warnings.map(({ source_path: _path, ...warning }) => warning) };
    return { projected, key: analysisDigest("source-session-order-v1", projected) };
  }).sort((left, right) => left.key.localeCompare(right.key)).map(({ projected }) => projected);
}
function snapshotIdentity(paths: StorePaths, context: PrContext, window: AnalysisWindow,
  sessions: readonly Session[], testMap: TestMap, options: AnalyzeOptions,
  history: readonly AnalysisRecord[], coverage: readonly RuleCoverage[],
  inapplicable: readonly SkippedRule[], ruleSafetyDigest: string,
  sourceErrors: readonly unknown[],
  hookWarnings: readonly StoreWarning[]): AnalysisSnapshotIdentity {
  const mappings = testMap.mappings.map((mapping) => ({ source: uniqueSorted(mapping.source),
    tests: uniqueSorted(mapping.tests),
    commands: uniqueSorted(mapping.commands), confidence: mapping.confidence,
    origin: mapping.origin, caveat: mapping.caveat,
  })).map((value) => ({ value, key: analysisDigest("test-map-entry-v1", value) }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .filter((entry, index, all) => index === 0 || entry.key !== all[index - 1]?.key)
    .map(({ value }) => value);
  const sortedHistory = [...history].sort((left, right) => left.created_at_ms - right.created_at_ms ||
    left.analysis_id.localeCompare(right.analysis_id));
  return {
    repo_id: paths.repo_hash, base_oid: context.base.oid.toLowerCase(),
    head_oid: context.head.oid.toLowerCase(), merge_base_oid: context.mergeBaseOid.toLowerCase(),
    window: { started_at_ms: window.started_at_ms, start_source: window.start_source,
      end_source: window.end_source, completeness: window.completeness,
      ...(window.end_source === "explicit" ? { ended_at_ms: window.ended_at_ms } : {}) },
    source_digest: analysisDigest("analysis-source-v1", {
      sessions: sourceSnapshot(sessions, context.repoRoot), discovery_failures: sourceErrors.map(sourceFailureSnapshot),
      hook_warnings: hookWarnings.map(({ path: _path, ...warning }) => warning) }),
    config_digest: analysisDigest("analysis-config-v1", {
      idle_threshold_ms: options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS, mappings,
      caveats: uniqueSorted(testMap.caveats), external_tool_names: uniqueSorted([...(options.externalToolNames ?? [])]),
      ...(testMap.config_schema_version === undefined ? {} : {
        repository_config_schema_version: testMap.config_schema_version,
      }) }),
    policy_digest: analysisDigest("analysis-policy-v1", {
      fingerprint: "ccprof-rule-policy-2026-08-04-v2",
      rule_coverage: coverage, skipped_rules: inapplicable,
      rule_manifest: listRuleManifests(),
      rule_safety_digest: ruleSafetyDigest }),
    history_digest: analysisDigest("analysis-history-v1", sortedHistory),
  };
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

async function prepareBudgetedOutput(
  options: AnalyzeOptions,
  report: ReportV2,
  meter: AnalysisBudgetMeter,
): Promise<FinalizedBudgetedOutput> {
  const projection = await (options.outputProjector ?? (async () => ({
    format: "json" as const,
    render: (candidate: ReportV2) => ({
      output: renderJsonReport(projectReportPrivacy(candidate, "strict")),
    }),
  })))(report);
  return finalizeBudgetedOutput({ report, meter, projection });
}

async function finishBudgetedPartialAnalysis(
  options: AnalyzeOptions,
  meter: AnalysisBudgetMeter,
  context: PrContext,
  window: AnalysisWindow,
  sessions: readonly Session[],
  inputWarnings: readonly AnalyzeWarning[],
  canonicalRepoRoot?: string,
  resolvedPaths?: StorePaths,
): Promise<AnalyzeResult> {
  meter.checkpoint();
  const warnings = [...inputWarnings];
  const coverage = ruleCoverage(sessions, window.completeness);
  const inapplicableRules = skippedRules(coverage);
  warnings.push(...inapplicableRules.map(skippedRuleWarning));
  const timeline = buildTimeline(sessions, {
    ...(options.idleThresholdMs === undefined
      ? {}
      : { idleThresholdMs: options.idleThresholdMs }),
  });
  warnings.push(
    ...timeline.caveats.map((message) => textWarning("timeline", message)),
  );
  const ledger = reconcileLedger({
    rawIntervals: timeline.rawIntervals,
    activeIntervals: timeline.activeIntervals,
    contributingIntervals: [],
    humanWaitIntervals: timeline.humanWaitIntervals,
    candidates: [],
  });
  const persist = options.persist ?? true;
  const paths = resolvedPaths ?? options.storePaths ??
    (persist ? await resolveStorePaths(context.repoRoot) : undefined);
  const unit = {
    repo: paths?.canonical_repo ?? canonicalRepoRoot ?? context.repoRoot,
    pr_ref: context.prRef,
    sessions: uniqueSorted(sessions.map(({ session_id }) => session_id)),
  };
  const normalizedWarningsBeforeSave = normalizeWarnings(warnings);
  const caveats = uniqueSorted([
    ...KNOWN_LIMITATIONS,
    ...normalizedWarningsBeforeSave.map(warningCaveat),
  ]);
  const report: ReportV2 = {
    version: 2,
    unit,
    sources: sourceDescriptorsForSessions(sessions),
    summary: ledger.summary,
    findings: [],
    caveats,
    rule_coverage: coverage,
    ...(inapplicableRules.length === 0
      ? {}
      : { skipped_rules: inapplicableRules }),
    analysis_budget: meter.result(),
  };
  const prepared = await prepareBudgetedOutput(options, report, meter);
  report.analysis_budget = prepared.analysisBudget;
  const record = makeAnalysisRecord({
    created_at_ms: context.resolvedAtMs,
    unit,
    summary: ledger.summary,
    findings: [],
    metrics: analysisMetrics(timeline),
    command_costs: [],
    read_observations: [],
    analysis_budget: prepared.analysisBudget,
  });
  const saveResult = persist
    ? await saveAnalysis(paths as StorePaths, record)
    : { record, warnings: [] as StoreWarning[] };
  warnings.push(...saveResult.warnings.map(storeWarning));
  const normalizedWarnings = normalizeWarnings(warnings);
  return {
    report,
    window,
    allFindings: [],
    record: saveResult.record,
    warnings: normalizedWarnings,
    suppressedKeys: [],
    ledger,
    adoptions: [],
    preparedOutput: prepared.stdout,
  };
}

export async function analyze(
  options: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const persist = options.persist ?? true;
  const budgetMeter = options.budgets === undefined
    ? undefined
    : new AnalysisBudgetMeter(
        options.budgets,
        options.budgetClock ?? systemAnalysisBudgetClock(),
      );
  const context = await resolvePrContext({
    cwd: options.cwd,
    ...(options.pr === undefined ? {} : { input: options.pr }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    includeBranchReflog: options.sinceMs === undefined,
  });
  const resolveRuleSafety = options.resolveRuleSafetyPolicy;
  let ruleSafetyRepoRoot: string | undefined;
  let resolvedRuleSafety: EffectiveRuleSafetyPolicy | undefined;
  if (resolveRuleSafety !== undefined) {
    ruleSafetyRepoRoot = options.storePaths?.canonical_repo ??
      await canonicalRepoPath(context.repoRoot);
    resolvedRuleSafety = await resolveRuleSafety(ruleSafetyRepoRoot);
  }
  const ruleSafety = resolvedRuleSafety === undefined
    ? undefined
    : snapshotEffectiveRuleSafetyPolicy(resolvedRuleSafety);
  const ruleSafetyDigest = analysisDigest(
    "effective-rule-safety-v1",
    ruleSafety === undefined
      ? { mode: "absent" }
      : canonicalRuleSafetySnapshot(ruleSafety),
  );
  const warnings: AnalyzeWarning[] = context.warnings.map((message) =>
    textWarning("pr_context", message)
  );
  const provisionalWindow = resolveAnalysisWindow(context, options);
  if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
    return finishBudgetedPartialAnalysis(
      options,
      budgetMeter,
      context,
      provisionalWindow,
      [],
      warnings,
      ruleSafetyRepoRoot,
    );
  }
  // Only the default (Claude + Codex combined) source reports per-source
  // discovery failures this way; an injected sessionSource (tests, or a
  // future custom integration) keeps its original throw-propagates
  // behavior untouched.
  const sourceErrors: unknown[] = [];
  const usingDefaultSource = options.sessionSource === undefined;
  const source = options.sessionSource ??
    defaultSessionSource(options, (error) => sourceErrors.push(error));
  let discoveredSessions: Session[];
  try {
    discoveredSessions = await source.discover({
      repoRoot: context.repoRoot,
      headBranch: context.headBranch,
      startedAtMs: provisionalWindow.start_source === "commit_anchor_lookback"
        ? 0
        : provisionalWindow.started_at_ms,
      endedAtMs: provisionalWindow.ended_at_ms,
      ...(budgetMeter === undefined || !usingDefaultSource
        ? {}
        : { analysisBudgetMeter: budgetMeter }),
    });
  } catch (error) {
    if (budgetMeter === undefined) throw error;
    budgetMeter.recordSourceFailure();
    discoveredSessions = [];
  }
  if (
    budgetMeter !== undefined &&
    !usingDefaultSource
  ) {
    discoveredSessions = budgetMeter.checkpoint()
      ? backstopBudgetedSessions(discoveredSessions, budgetMeter)
      : [];
  }
  const transitionAtMs = provisionalWindow.start_source ===
      "commit_anchor_lookback" && sourceErrors.length === 0
    ? deriveSessionBranchTransitionAtMs(
      discoveredSessions,
      context.headBranch,
      provisionalWindow.ended_at_ms,
      context.earliestUniqueCommitAtMs,
    )
    : undefined;
  const window = resolveAnalysisWindow(
    context,
    options,
    warnings,
    transitionAtMs === undefined
      ? {}
      : { sessionBranchTransitionAtMs: transitionAtMs },
  );
  const discoveredSessionIdCounts = new Map<string, number>();
  for (const session of discoveredSessions) {
    discoveredSessionIdCounts.set(
      session.session_id,
      (discoveredSessionIdCounts.get(session.session_id) ?? 0) + 1,
    );
  }
  let sessions = orderedSessions(
    sliceSessionsToAnalysisWindow(discoveredSessions, window),
  );
  if (budgetMeter !== undefined &&
    (budgetMeter.stopped || !budgetMeter.checkpoint())) {
    warnings.push(
      ...sessions.flatMap((session) => session.warnings.map(sourceWarning)),
    );
    return finishBudgetedPartialAnalysis(
      options,
      budgetMeter,
      context,
      window,
      sessions,
      warnings,
      ruleSafetyRepoRoot,
    );
  }
  if (sessions.length === 0) {
    // If discovery failed, surface that cause instead of the generic empty
    // result even when broad discovery returned only pre-window sessions.
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
  if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
    return finishBudgetedPartialAnalysis(
      options,
      budgetMeter,
      context,
      window,
      sessions,
      warnings,
      ruleSafetyRepoRoot,
      paths,
    );
  }
  const hookEvents = await loadHookEvents(paths.hook_events_path);
  warnings.push(...hookEvents.warnings.map(storeWarning));
  sessions = applyHookEvents(
    sessions,
    hookEvents.rows.filter((row) =>
      row.received_at_ms >= window.started_at_ms &&
      row.received_at_ms <= window.ended_at_ms &&
      discoveredSessionIdCounts.get(row.session_id) === 1
    ),
  );
  if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
    return finishBudgetedPartialAnalysis(
      options,
      budgetMeter,
      context,
      window,
      sessions,
      warnings,
      ruleSafetyRepoRoot,
      paths,
    );
  }

  const coverage = ruleCoverage(sessions, window.completeness);
  const inapplicableRules = skippedRules(coverage);
  warnings.push(...inapplicableRules.map(skippedRuleWarning));

  const timeline = buildTimeline(sessions, {
    ...(options.idleThresholdMs === undefined
      ? {}
      : { idleThresholdMs: options.idleThresholdMs }),
  });
  if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
    return finishBudgetedPartialAnalysis(
      options,
      budgetMeter,
      context,
      window,
      sessions,
      warnings,
      ruleSafetyRepoRoot,
      paths,
    );
  }
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
  if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
    return finishBudgetedPartialAnalysis(
      options,
      budgetMeter,
      context,
      window,
      sessions,
      warnings,
      ruleSafetyRepoRoot,
      paths,
    );
  }

  const [historyResult, dismissalResult, adoptionResult] =
    persist || budgetMeter === undefined
    ? await Promise.all([
        loadAnalyses(paths),
        loadDismissals(paths),
        loadAdoptions(paths),
      ])
    : [
        { records: [] as AnalysisRecord[], warnings: [] as StoreWarning[] },
        { records: [], warnings: [] as StoreWarning[] },
        { records: [] as AdoptionRecord[], warnings: [] as StoreWarning[] },
      ];
  warnings.push(
    ...historyResult.warnings.map(storeWarning),
    ...dismissalResult.warnings.map(storeWarning),
    ...adoptionResult.warnings.map(storeWarning),
  );
  if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
    return finishBudgetedPartialAnalysis(
      options,
      budgetMeter,
      context,
      window,
      sessions,
      warnings,
      ruleSafetyRepoRoot,
      paths,
    );
  }
  const history = priorRecords(historyResult.records, context);

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
    if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
      return finishBudgetedPartialAnalysis(
        options,
        budgetMeter,
        context,
        window,
        sessions,
        warnings,
        ruleSafetyRepoRoot,
        paths,
      );
    }
    mergedAdoptions = adoptionDetection.adoptions.length === 0
      ? adoptionResult.records
      : [...adoptionResult.records, ...adoptionDetection.adoptions];
    if (adoptionDetection.adoptions.length > 0) {
      const adoptionSaveWarnings = await saveAdoptions(paths, mergedAdoptions);
      warnings.push(...adoptionSaveWarnings.map(storeWarning));
      if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
        return finishBudgetedPartialAnalysis(
          options,
          budgetMeter,
          context,
          window,
          sessions,
          warnings,
          ruleSafetyRepoRoot,
          paths,
        );
      }
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
  const laneKey = (laneSessions: readonly Session[]): string =>
    analysisDigest("rule-session-lane-v1", laneSessions.map((session) => ({
      source: session.source,
      source_path: session.source_path,
      session_id: session.session_id,
    })).sort((left, right) =>
      left.source_path.localeCompare(right.source_path) ||
      left.source.localeCompare(right.source) ||
      left.session_id.localeCompare(right.session_id)
    ));
  const laneCache = new Map<string, RuleEvidenceLane>([[laneKey(sessions), {
    matched, timeline, events,
  }]]);
  const evidenceLane = (laneSessions: readonly Session[]): RuleEvidenceLane => {
    const key = laneKey(laneSessions);
    const cached = laneCache.get(key);
    if (cached !== undefined) return cached;
    const laneTimeline = buildTimeline(laneSessions, {
      ...(options.idleThresholdMs === undefined
        ? {}
        : { idleThresholdMs: options.idleThresholdMs }),
    });
    const laneEvents = orderedEvents(laneSessions);
    const laneEventIndex = toolEventIndex(laneEvents);
    const laneMatched = matchTimelineActions(
      laneTimeline.actions.map((action) =>
        observationFor(action, laneEventIndex)
      ),
      { diff, testMap, repoRoot: context.repoRoot },
    );
    const result = {
      matched: laneMatched,
      timeline: laneTimeline,
      events: laneEvents,
    };
    laneCache.set(key, result);
    return result;
  };
  const sessionLanes = ruleSessionLanes(sessions);
  const ruleLanes: Record<RuleId, RuleEvidenceLane> = {
    R001: evidenceLane(sessionLanes.R001),
    R002: evidenceLane(sessionLanes.R002),
    R003: evidenceLane(sessionLanes.R003),
    R004: evidenceLane(sessionLanes.R004),
    R005: evidenceLane(sessionLanes.R005),
    R006: evidenceLane(sessionLanes.R006),
    R007: evidenceLane(sessionLanes.R007),
    R008: evidenceLane(sessionLanes.R008),
  };
  if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
    return finishBudgetedPartialAnalysis(
      options,
      budgetMeter,
      context,
      window,
      sessions,
      warnings,
      ruleSafetyRepoRoot,
      paths,
    );
  }
  const reads = await readObservations(matched, context, options.runner, warnings);
  if (budgetMeter !== undefined && !budgetMeter.checkpoint()) {
    return finishBudgetedPartialAnalysis(
      options,
      budgetMeter,
      context,
      window,
      sessions,
      warnings,
      ruleSafetyRepoRoot,
      paths,
    );
  }
  const candidates = ruleCandidates(
    ruleLanes,
    coverage,
    history,
    reads.objects,
    reads.eligibleReadKeys,
    testMap,
    options.externalToolNames,
    ruleSafety,
  );
  const unit = {
    repo: paths.canonical_repo,
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
  const allFindings = ledger.findings.map(withRuleManifest).sort(findingOrder);
  budgetMeter?.checkpoint();
  if (budgetMeter !== undefined) {
    const applied = applyDismissals(
      allFindings,
      dismissalResult.records,
      context.resolvedAtMs,
    );
    const normalizedWarningsBeforeSave = normalizeWarnings(warnings);
    const caveats = uniqueSorted([
      ...KNOWN_LIMITATIONS,
      ...normalizedWarningsBeforeSave.map(warningCaveat),
    ]);
    const report: ReportV2 = {
      version: 2,
      unit,
      sources: sourceDescriptorsForSessions(sessions),
      summary: ledger.summary,
      findings: [...applied.findings]
        .filter((finding) => finding.recoverable.min > 0)
        .sort(findingOrder)
        .slice(0, 3),
      caveats,
      rule_coverage: coverage,
      ...(inapplicableRules.length === 0
        ? {}
        : { skipped_rules: inapplicableRules }),
      analysis_budget: budgetMeter.result(),
    };
    const prepared = await prepareBudgetedOutput(options, report, budgetMeter);
    report.analysis_budget = prepared.analysisBudget;
    const record = makeAnalysisRecord({
      created_at_ms: context.resolvedAtMs,
      unit,
      summary: ledger.summary,
      findings: allFindings,
      metrics,
      command_costs: costs,
      read_observations: reads.observations,
      analysis_budget: prepared.analysisBudget,
    });
    const saveResult = persist
      ? await saveAnalysis(paths, record, { snapshot: snapshotIdentity(
          paths, context, window, sessions, testMap, options, history, coverage,
          inapplicableRules,
          ruleSafetyDigest,
          sourceErrors, hookEvents.warnings,
        ) })
      : { record, warnings: [] as StoreWarning[] };
    warnings.push(...saveResult.warnings.map(storeWarning));
    return {
      report,
      window,
      allFindings,
      record: saveResult.record,
      warnings: normalizeWarnings(warnings),
      suppressedKeys: applied.suppressed_keys,
      ledger,
      adoptions,
      preparedOutput: prepared.stdout,
    };
  }
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
    ? await saveAnalysis(paths, record, { snapshot: snapshotIdentity(
        paths, context, window, sessions, testMap, options, history, coverage,
        inapplicableRules,
        ruleSafetyDigest,
        sourceErrors, hookEvents.warnings,
      ) })
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
    sources: sourceDescriptorsForSessions(sessions),
    summary: ledger.summary,
    findings: [...applied.findings]
      .filter((finding) => finding.recoverable.min > 0)
      .sort(findingOrder)
      .slice(0, 3),
    caveats,
    rule_coverage: coverage,
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
