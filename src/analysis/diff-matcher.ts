import {
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";

import type {
  Confidence,
  MatchedAction,
  TimelineAction,
  ToolResultEvent,
  ToolUseEvent,
} from "../core/model.js";
import type {
  DiffEvidence,
  FileDiffEvidence,
} from "../git/diff.js";
import {
  classifyCommand,
  classifyCommandResult,
  type CommandDescriptor,
} from "./command.js";
import {
  evaluateTestRelevance,
  hasMappedCommand,
  normalizeRepoPath,
  type TestMap,
} from "./test-map.js";

export interface ActionObservation {
  action: TimelineAction;
  toolUse?: ToolUseEvent;
  toolResult?: ToolResultEvent;
  cwd?: string;
}

export interface MatchActionsOptions {
  diff: DiffEvidence;
  testMap: TestMap;
  repoRoot?: string;
}

interface EditRecord {
  interval: TimelineAction["interval"];
  paths: string[];
  uncertain: boolean;
}

interface MutationRecord extends EditRecord {
  kind: "edit" | "opaque";
}

interface SuccessfulRun {
  snapshotAtMs: number;
  completedAtMs: number;
}

interface SuccessfulRead {
  pathRevision: number;
  uncertaintyOrdinal: number;
  completedAtMs: number;
}

interface ObservedPaths {
  paths: string[];
  caveats: string[];
}

type MeaningfulFragments = { values: string[]; truncated: boolean };
const EDIT_TOOLS = new Set([
  "apply_patch",
  "edit",
  "multiedit",
  "notebookedit",
  "write",
]);
const READ_TOOLS = new Set([
  "glob",
  "grep",
  "list",
  "ls",
  "read",
  "search",
]);
const RUN_TOOLS = new Set([
  "bash",
  "exec",
  "execute",
  "run",
  "run_command",
  "shell",
]);
const RECORDING_TOOLS = new Set([
  "enterplanmode",
  "exitplanmode",
  "pushnotification",
  "schedulewakeup",
  "sendmessage",
  "skill",
  "taskcreate",
  "taskget",
  "tasklist",
  "taskupdate",
  "todoread",
  "todowrite",
  "toolsearch",
]);
const DELEGATION_TOOLS = new Set([
  "agent",
  "dispatch_agent",
  "task",
]);
const RESEARCH_TOOLS = new Set([
  "webfetch",
  "websearch",
]);
const COORDINATION_TOOLS = new Set([
  ...RECORDING_TOOLS,
  ...DELEGATION_TOOLS,
  ...RESEARCH_TOOLS,
]);
const MCP_TOOL_PREFIX = /^mcp__./u;

/**
 * Delegation tools may mutate the repository through a sub-agent, so their
 * intervals must keep invalidating read observations even though their own
 * time is classified as coordination.
 */
export function isDelegationToolName(value: string | undefined): boolean {
  return value !== undefined && DELEGATION_TOOLS.has(normalizedToolName(value));
}

/**
 * A command whose mutation scope cannot be bounded safely: opaque shell
 * composition, unrecognized executables, and vcs commands (git or gh can
 * rewrite the working tree, for example via checkout or merge).
 */
function commandHasUnknownMutationScope(
  descriptor: CommandDescriptor,
  testMap: TestMap,
): boolean {
  if (descriptor.opaque) return true;
  if (
    descriptor.redirectsOutput === true ||
    descriptor.segmentFamilies?.includes("vcs") === true
  ) {
    return true;
  }
  if (hasMappedCommand(descriptor, testMap)) return false;
  return descriptor.family === "vcs" || descriptor.family === "other";
}

export function matchTimelineActions(
  observations: readonly ActionObservation[],
  options: MatchActionsOptions,
): MatchedAction[] {
  const ordered = observations
    .map((observation, inputIndex) => ({ observation, inputIndex }))
    .sort((left, right) =>
      left.observation.action.interval.start_ms -
        right.observation.action.interval.start_ms ||
      left.observation.action.interval.end_ms -
        right.observation.action.interval.end_ms ||
      left.inputIndex - right.inputIndex
    );
  const mutations = ordered.flatMap(({ observation }) => {
    const mutation = mutationRecordFor(observation, options);
    return mutation === null ? [] : [mutation];
  });
  const pathRevisions = new Map<string, number>();
  const successfulRuns = new Map<string, SuccessfulRun[]>();
  const successfulReads = new Map<string, SuccessfulRead[]>();
  const toolClassifications = new Map<string, MatchedAction>();
  let readUncertaintyOrdinal = 0;

  return ordered.map(({ observation }) => {
    if (observation.action.kind !== "tool") {
      if (observation.action.kind === "inference") {
        const identity = toolIdentity(observation);
        const inherited =
          identity === null ? undefined : toolClassifications.get(identity);
        if (inherited !== undefined) {
          return inheritToolClassification(observation.action, inherited);
        }
      }
      return result(
        observation.action,
        "unexplained",
        "low",
        targetFor(
          observation,
          observedPaths(observation, options.repoRoot).paths,
        ),
        ["No matching causal tool classification was available for this interval."],
      );
    }

    const rawToolName =
      observation.toolUse?.tool_name ?? observation.action.tool_name ?? "";
    const toolName = normalizedToolName(rawToolName);
    const observed = observedPaths(observation, options.repoRoot);
    const paths = observed.paths;
    if (observation.toolResult === undefined) {
      const mutation = mutationRecordFor(observation, options);
      if (mutation?.uncertain === true) readUncertaintyOrdinal += 1;
      return rememberToolClassification(
        observation,
        result(
          observation.action,
          "unexplained",
          "low",
          targetFor(observation, paths),
          unique([
            ...observed.caveats,
            "Tool completion was outside the analysis window or could not be identified uniquely.",
          ]),
        ),
        toolClassifications,
      );
    }
    if (EDIT_TOOLS.has(toolName)) {
      const editCaveats = unique([
        ...observed.caveats,
        ...(paths.length === 0
          ? ["Edit path is missing or is not a safe repository-relative path."]
          : []),
      ]);
      if (editCaveats.length > 0) {
        readUncertaintyOrdinal += 1;
      }
      for (const path of paths) {
        pathRevisions.set(path, (pathRevisions.get(path) ?? 0) + 1);
      }
      return rememberToolClassification(
        observation,
        editCaveats.length > 0
          ? result(
              observation.action,
              "unexplained",
              "low",
              targetFor(observation, paths),
              editCaveats,
            )
          : matchEdit(observation, paths, options.diff),
        toolClassifications,
      );
    }
    if (READ_TOOLS.has(toolName)) {
      return rememberToolClassification(
        observation,
        observed.caveats.length > 0
          ? result(
              observation.action,
              "unexplained",
              "low",
              targetFor(observation, paths),
              observed.caveats,
            )
          : matchRead(
              observation,
              paths,
              pathRevisions,
              readUncertaintyOrdinal,
              successfulReads,
            ),
        toolClassifications,
      );
    }
    if (RUN_TOOLS.has(toolName) || observation.action.command !== undefined) {
      const descriptor = classifyCommand(
        observation.toolUse?.command ?? observation.action.command ?? "",
      );
      if (commandHasUnknownMutationScope(descriptor, options.testMap)) {
        readUncertaintyOrdinal += 1;
      }
      return rememberToolClassification(
        observation,
        matchRun(
          observation,
          descriptor,
          paths,
          mutations,
          successfulRuns,
          options.testMap,
        ),
        toolClassifications,
      );
    }
    if (COORDINATION_TOOLS.has(toolName)) {
      if (DELEGATION_TOOLS.has(toolName)) {
        readUncertaintyOrdinal += 1;
      }
      return rememberToolClassification(
        observation,
        result(
          observation.action,
          "coordination",
          lowerConfidence(observation.action.confidence, "high"),
          targetFor(observation, paths),
          [],
        ),
        toolClassifications,
      );
    }
    readUncertaintyOrdinal += 1;
    return rememberToolClassification(
      observation,
      MCP_TOOL_PREFIX.test(rawToolName)
        ? result(
            observation.action,
            "coordination",
            "low",
            targetFor(observation, paths),
            ["MCP tool classified by server prefix."],
          )
        : result(
            observation.action,
            "unexplained",
            "low",
            targetFor(observation, paths),
            ["Tool semantics are not known well enough to classify contribution."],
          ),
      toolClassifications,
    );
  });
}

function mutationRecordFor(
  observation: ActionObservation,
  options: MatchActionsOptions,
): MutationRecord | null {
  if (observation.action.kind !== "tool") return null;
  if (observation.toolResult === undefined) {
    return {
      kind: "opaque",
      interval: observation.action.interval,
      paths: [],
      uncertain: true,
    };
  }
  const toolName = normalizedToolName(
    observation.toolUse?.tool_name ?? observation.action.tool_name ?? "",
  );
  const observed = observedPaths(observation, options.repoRoot);
  if (EDIT_TOOLS.has(toolName)) {
    return {
      kind: "edit",
      interval: observation.action.interval,
      paths: observed.paths,
      uncertain: observed.caveats.length > 0 || observed.paths.length === 0,
    };
  }
  if (READ_TOOLS.has(toolName)) return null;
  if (RUN_TOOLS.has(toolName) || observation.action.command !== undefined) {
    const descriptor = classifyCommand(
      observation.toolUse?.command ?? observation.action.command ?? "",
    );
    return commandHasUnknownMutationScope(descriptor, options.testMap)
      ? {
          kind: "opaque",
          interval: observation.action.interval,
          paths: [],
          uncertain: true,
        }
      : null;
  }
  if (COORDINATION_TOOLS.has(toolName) && !DELEGATION_TOOLS.has(toolName)) {
    return null;
  }
  return {
    kind: "opaque",
    interval: observation.action.interval,
    paths: [],
    uncertain: true,
  };
}

function matchEdit(
  observation: ActionObservation,
  paths: readonly string[],
  diff: DiffEvidence,
): MatchedAction {
  const action = { ...observation.action, paths: [...paths] };
  if (paths.length === 0) {
    return result(
      action,
      "unexplained",
      "low",
      targetFor(observation, paths),
      ["Edit path is missing or is not a safe repository-relative path."],
    );
  }
  const target = paths.join(", ");
  const fragments = meaningfulFragments(observation.toolUse?.edit_fragments ?? [],
    normalizedToolName(observation.toolUse?.tool_name ??
      observation.action.tool_name ?? "") === "apply_patch");
  const matchedFiles = filesForPaths(paths, diff.files);
  if (
    fragments.values.length > 0 &&
    matchedFiles.some((file) => fragmentSurvives(fragments.values, file))
  ) {
    return result(
      action,
      "contributing_edit",
      lowerConfidence(action.confidence, fragments.truncated ? "medium" : "high"),
      target,
      fragments.truncated ? ["Edit input was truncated; surviving fragment evidence is incomplete."] : [],
    );
  }

  if (fragments.truncated) {
    return result(
      action,
      "unexplained",
      "low",
      target,
      unique([
        "Edit input was truncated, so fragment absence cannot establish rework.",
        ...diff.caveats,
      ]),
    );
  }

  if (fragments.values.length > 0) {
    const absenceIsComplete =
      !diff.truncated &&
      paths.every((path) => pathSupportsAbsence(path, diff));
    if (absenceIsComplete) {
      return result(
        action,
        "rework_edit",
        lowerConfidence(action.confidence, "high"),
        target,
        ["A meaningful edit fragment is absent from complete final text evidence."],
      );
    }
    if (hasRevertEvidence(paths, diff)) {
      return result(
        action,
        "rework_edit",
        lowerConfidence(action.confidence, "medium"),
        target,
        ["A revert commit names the edited path; revert evidence supports rework attribution."],
      );
    }
    return result(
      action,
      "unexplained",
      "low",
      target,
      unique([
        "Fragment absence is not strong evidence because final text is incomplete or ambiguous.",
        ...diff.caveats,
      ]),
    );
  }

  const pathOnlyContribution = paths.some((path) => {
    const file = fileForPath(path, diff.files);
    return (
      file !== undefined &&
      diff.survivingPaths.includes(path) &&
      !file.binary &&
      file.status !== "D" &&
      !isRenameOrCopy(file)
    );
  });
  if (pathOnlyContribution) {
    return result(
      action,
      "contributing_edit",
      "low",
      target,
      ["Contribution uses path-only evidence because no edit fragment was available."],
    );
  }
  if (hasRevertEvidence(paths, diff)) {
    return result(
      action,
      "rework_edit",
      lowerConfidence(action.confidence, "medium"),
      target,
      ["A revert commit names the edited path; revert evidence supports rework attribution."],
    );
  }
  return result(
    action,
    "unexplained",
    "low",
    target,
    ["The edit has neither complete fragment evidence nor an unambiguous surviving path."],
  );
}

function matchRead(
  observation: ActionObservation,
  paths: readonly string[],
  pathRevisions: ReadonlyMap<string, number>,
  uncertaintyOrdinal: number,
  successfulReads: Map<string, SuccessfulRead[]>,
): MatchedAction {
  observation = { ...observation, action: { ...observation.action, paths: [...paths] } };
  const successful = resultWasDefinitelySuccessful(observation.toolResult);
  if (!successful) {
    return result(observation.action, "unexplained", "low",
      targetFor(observation, paths),
      ["Read completion was not definitely successful."]);
  }
  const duplicate =
    paths.length > 0 &&
    paths.every((path) => {
      const key = successfulReadKey(observation.action, path);
      const previous = successfulReads.get(key) ?? [];
      return previous.some(
        (read) =>
          read.completedAtMs <= observation.action.interval.start_ms &&
          read.pathRevision === (pathRevisions.get(path) ?? 0) &&
          read.uncertaintyOrdinal === uncertaintyOrdinal,
      );
    });
  for (const path of paths) {
    const key = successfulReadKey(observation.action, path);
    const reads = successfulReads.get(key) ?? [];
    reads.push({
      pathRevision: pathRevisions.get(path) ?? 0,
      uncertaintyOrdinal,
      completedAtMs: observation.action.interval.end_ms,
    });
    successfulReads.set(key, reads);
  }
  if (duplicate) {
    return result(
      observation.action,
      "duplicate_read",
      lowerConfidence(observation.action.confidence, "high"),
      targetFor(observation, paths),
      [],
    );
  }
  return result(
    observation.action,
    "safe_read",
    paths.length === 0 ? "low" : observation.action.confidence,
    targetFor(observation, paths),
    paths.length === 0
      ? ["Read path was unavailable, so duplicate-read attribution is disabled."]
      : [],
  );
}

function matchRun(
  observation: ActionObservation,
  descriptor: CommandDescriptor,
  paths: readonly string[],
  mutations: readonly MutationRecord[],
  successfulRuns: Map<string, SuccessfulRun[]>,
  testMap: TestMap,
): MatchedAction {
  const target = descriptor.normalized === ""
    ? targetFor(observation, paths)
    : descriptor.normalized;
  if (
    descriptor.opaque ||
    (descriptor.family === "other" && !hasMappedCommand(descriptor, testMap))
  ) {
    return result(
      observation.action,
      "unexplained",
      "low",
      target,
      unique([
        ...descriptor.caveats,
        "Command is not a safely recognized test, build, or check invocation.",
      ]),
    );
  }
  if (
    (descriptor.family === "vcs" || descriptor.family === "inspect") &&
    !hasMappedCommand(descriptor, testMap)
  ) {
    return result(
      observation.action,
      "coordination",
      lowerConfidence(observation.action.confidence, "high"),
      target,
      descriptor.caveats,
      descriptor.normalized,
    );
  }

  const previous = latestCompletedRun(
    successfulRuns.get(descriptor.normalized) ?? [],
    observation.action.interval.start_ms,
  );
  const previousSnapshotMs =
    previous?.snapshotAtMs ?? Number.NEGATIVE_INFINITY;
  const completedMutations = mutations.filter(
    (mutation) =>
      mutation.interval.end_ms <= observation.action.interval.start_ms &&
      mutation.interval.end_ms > previousSnapshotMs,
  );
  const editedPaths = unique(
    completedMutations
      .filter((mutation) => mutation.kind === "edit")
      .flatMap((mutation) => mutation.paths),
  );
  const hasInterveningUnknownMutation = completedMutations.some(
    (mutation) => mutation.uncertain,
  );
  const hasOverlappingMutation = mutations.some((mutation) =>
    intervalsOverlap(mutation.interval, observation.action.interval)
  );
  const relevance = evaluateTestRelevance(descriptor, editedPaths, testMap);
  const commandResult = classifyRunResult(descriptor, observation.toolResult);
  if (commandResult.status === "success" && commandResult.definite) {
    const runs = successfulRuns.get(descriptor.normalized) ?? [];
    runs.push({
      snapshotAtMs: observation.action.interval.start_ms,
      completedAtMs: observation.action.interval.end_ms,
    });
    successfulRuns.set(descriptor.normalized, runs);
  }

  if (relevance.relevant === true) {
    return result(
      observation.action,
      "contributing_run",
      lowerConfidence(observation.action.confidence, relevance.confidence),
      target,
      [relevance.caveat],
      descriptor.normalized,
      relevance.matchedPaths,
    );
  }
  if (relevance.relevant === false) {
    if (hasOverlappingMutation || hasInterveningUnknownMutation) {
      return result(
        observation.action,
        "unexplained",
        "low",
        target,
        [
          relevance.caveat,
          ...(hasOverlappingMutation
            ? ["A mutation overlapped this run, so irrelevance is not proven."]
            : []),
          ...(hasInterveningUnknownMutation
            ? ["An intervening action had unknown mutation scope, so irrelevance is not proven."]
            : []),
        ],
        descriptor.normalized,
        relevance.matchedPaths,
      );
    }
    if (descriptor.scope !== "targeted" && previous === undefined) {
      return result(
        observation.action,
        "unexplained",
        "low",
        target,
        [
          relevance.caveat,
          "No prior completed successful equivalent full-suite run was available.",
        ],
        descriptor.normalized,
        relevance.matchedPaths,
      );
    }
    return result(
      observation.action,
      "redundant_run",
      lowerConfidence(observation.action.confidence, relevance.confidence),
      target,
      [relevance.caveat],
      descriptor.normalized,
      relevance.matchedPaths,
    );
  }
  return result(
    observation.action,
    "unexplained",
    "low",
    target,
    [relevance.caveat, "Command relevance could not be determined."],
    descriptor.normalized,
    relevance.matchedPaths,
  );
}

function classifyRunResult(
  descriptor: CommandDescriptor,
  toolResult: ToolResultEvent | undefined,
) {
  return classifyCommandResult(descriptor, {
    ...(toolResult?.status === undefined ? {} : { status: toolResult.status }),
    ...(toolResult?.exit_code === undefined
      ? {}
      : { exitCode: toolResult.exit_code }),
    ...(toolResult?.output === undefined ? {} : { output: toolResult.output }),
  });
}

function latestCompletedRun(
  runs: readonly SuccessfulRun[],
  beforeMs: number,
): SuccessfulRun | undefined {
  let latest: SuccessfulRun | undefined;
  for (const run of runs) {
    if (
      run.completedAtMs <= beforeMs &&
      (latest === undefined || run.completedAtMs > latest.completedAtMs)
    ) {
      latest = run;
    }
  }
  return latest;
}

function intervalsOverlap(
  left: TimelineAction["interval"],
  right: TimelineAction["interval"],
): boolean {
  return (
    left.start_ms < left.end_ms &&
    right.start_ms < right.end_ms &&
    left.start_ms < right.end_ms &&
    right.start_ms < left.end_ms
  );
}

function resultWasDefinitelySuccessful(
  toolResult: ToolResultEvent | undefined,
): boolean {
  if (toolResult === undefined) return false;
  if (toolResult.status === "success") return true;
  return toolResult.status === "unknown" && toolResult.exit_code === 0;
}

function observedPaths(
  observation: ActionObservation,
  repoRoot: string | undefined,
): ObservedPaths {
  const raw = observation.toolUse?.paths ?? observation.action.paths;
  const cwd = observation.toolUse?.cwd ?? observation.cwd;
  const paths: string[] = [];
  const caveats: string[] = [];
  for (const path of raw) {
    const normalized = normalizeObservedPath(path, repoRoot, cwd);
    if (normalized === null) {
      caveats.push(
        isAbsolute(path)
          ? "An absolute observed path was outside or could not be contained by the known repository context."
          : "An observed path was not a safe repository-relative path.",
      );
    } else {
      paths.push(normalized);
    }
  }
  return {
    paths: unique(paths).sort(),
    caveats: unique(caveats),
  };
}

function normalizeObservedPath(
  rawPath: string,
  repoRoot: string | undefined,
  cwd: string | undefined,
): string | null {
  if (repoRoot !== undefined) {
    if (!isAbsolute(repoRoot)) return null;
    if (isAbsolute(rawPath)) {
      return pathRelativeToBase(repoRoot, rawPath);
    }
    let normalized: string;
    try {
      normalized = normalizeRepoPath(rawPath);
    } catch {
      return null;
    }
    if (cwd === undefined) return normalized;
    if (
      !isAbsolute(cwd) ||
      relativeWithin(repoRoot, cwd) === null
    ) {
      return null;
    }
    return pathRelativeToBase(repoRoot, resolvePath(cwd, normalized));
  }
  try {
    return normalizeRepoPath(rawPath);
  } catch {
    if (!isAbsolute(rawPath) || cwd === undefined || !isAbsolute(cwd)) {
      return null;
    }
  }
  return pathRelativeToBase(cwd, rawPath);
}

function relativeWithin(base: string, target: string): string | null {
  const relativePath = relative(resolvePath(base), resolvePath(target));
  return (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    )
    ? null
    : relativePath;
}

function pathRelativeToBase(base: string, target: string): string | null {
  const relativePath = relativeWithin(base, target);
  if (relativePath === null || relativePath === "") return null;
  try {
    return normalizeRepoPath(relativePath);
  } catch {
    return null;
  }
}

function normalizedToolName(value: string): string {
  return value.replaceAll("-", "_").toLowerCase();
}

function meaningfulFragments(
  fragments: readonly string[],
  forcePatch: boolean,
): MeaningfulFragments {
  let truncated = false;
  const values = fragments.flatMap((rawFragment) => {
    let inHunk = false;
    const suffix = "\n[input truncated]";
    const fragment = rawFragment.endsWith(suffix)
      ? rawFragment.slice(0, -suffix.length)
      : rawFragment;
    truncated ||= fragment !== rawFragment;
    const patchLike = forcePatch ||
      /^(?:\*\*\* (?:Begin Patch|Update File|Add File|Delete File)|diff --git |--- |\+\+\+ |@@)/mu.test(fragment);
    return fragment
      .split(/\r?\n/u)
      .flatMap((line) => {
        if (line.startsWith("diff --git ") || line.startsWith("--- ")) inHunk = false;
        inHunk ||= line.startsWith("@@");
        return patchLike
          ? line.startsWith("+") && (inHunk || !line.startsWith("+++ "))
            ? [line.slice(1)]
            : []
          : [line.replace(/^[+ ]/u, "")]
      })
      .map(normalizeText)
      .filter((line) => line.length >= 12 && /[A-Za-z0-9_\p{L}]{3}/u.test(line));
  });
  return { values: unique(values), truncated };
}

function successfulReadKey(
  action: TimelineAction,
  path: string,
): string {
  return [action.session_id, action.agent_id, path].join("\0");
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function fragmentSurvives(
  fragments: readonly string[],
  file: FileDiffEvidence,
): boolean {
  if (
    file.binary ||
    file.status === "D" ||
    isRenameOrCopy(file) ||
    !file.contentComplete
  ) {
    return false;
  }
  const added = normalizeText(file.addedLines.join("\n"));
  return fragments.some((fragment) => added.includes(fragment));
}

function filesForPaths(
  paths: readonly string[],
  files: readonly FileDiffEvidence[],
): FileDiffEvidence[] {
  return files.filter((file) =>
    paths.includes(file.path) ||
    (file.oldPath !== undefined && paths.includes(file.oldPath))
  );
}

function fileForPath(
  path: string,
  files: readonly FileDiffEvidence[],
): FileDiffEvidence | undefined {
  return files.find((file) => file.path === path || file.oldPath === path);
}

function pathSupportsAbsence(path: string, diff: DiffEvidence): boolean {
  if (
    diff.renames.some((rename) => rename.from === path || rename.to === path)
  ) {
    return false;
  }
  const file = fileForPath(path, diff.files);
  if (file === undefined) {
    return !diff.changedPaths.includes(path);
  }
  return (
    file.contentComplete &&
    !file.binary &&
    file.status !== "D" &&
    !isRenameOrCopy(file)
  );
}

function isRenameOrCopy(file: FileDiffEvidence): boolean {
  return file.status.startsWith("R") || file.status.startsWith("C");
}

function hasRevertEvidence(
  paths: readonly string[],
  diff: DiffEvidence,
): boolean {
  return diff.reverts.some((revert) =>
    revert.paths.some((rawPath) => {
      try {
        return paths.includes(normalizeRepoPath(rawPath));
      } catch {
        return false;
      }
    })
  );
}

function targetFor(
  observation: ActionObservation,
  paths: readonly string[],
): string {
  if (paths.length > 0) return paths.join(", ");
  return observation.toolUse?.tool_name ??
    observation.action.tool_name ??
    observation.action.action_id;
}

function toolIdentity(observation: ActionObservation): string | null {
  const toolUseId =
    observation.action.tool_use_id ?? observation.toolUse?.tool_use_id;
  if (toolUseId === undefined || toolUseId === "") return null;
  return [
    observation.action.session_id,
    observation.action.agent_id,
    toolUseId,
  ].join("\0");
}

function rememberToolClassification(
  observation: ActionObservation,
  matched: MatchedAction,
  classifications: Map<string, MatchedAction>,
): MatchedAction {
  const identity = toolIdentity(observation);
  if (identity !== null) classifications.set(identity, matched);
  return matched;
}

function inheritToolClassification(
  action: TimelineAction,
  source: MatchedAction,
): MatchedAction {
  return {
    ...action,
    match: source.match,
    match_confidence: lowerConfidence(
      action.confidence,
      source.match_confidence,
    ),
    relevance_paths: [...source.relevance_paths],
    target: source.target,
    caveats: [...source.caveats],
    ...(source.normalized_command === undefined
      ? {}
      : { normalized_command: source.normalized_command }),
  };
}

function result(
  action: TimelineAction,
  match: MatchedAction["match"],
  confidence: Confidence,
  target: string,
  caveats: readonly string[],
  normalizedCommand?: string,
  relevancePaths: readonly string[] = [],
): MatchedAction {
  return {
    ...action,
    match,
    match_confidence: confidence,
    relevance_paths: stableRelevancePaths(relevancePaths),
    target,
    caveats: unique(caveats.filter((caveat) => caveat !== "")),
    ...(normalizedCommand === undefined
      ? {}
      : { normalized_command: normalizedCommand }),
  };
}

function lowerConfidence(left: Confidence, right: Confidence): Confidence {
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[left] <= rank[right] ? left : right;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function stableRelevancePaths(paths: readonly string[]): string[] {
  return unique(paths.flatMap((path) => {
    try {
      return [normalizeRepoPath(path)];
    } catch {
      return [];
    }
  })).sort((left, right) => left.localeCompare(right));
}
