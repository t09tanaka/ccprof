import { basename } from "node:path";

import { classifyCommand } from "../analysis/command.js";
import { durationMs, normalizeInterval } from "../core/intervals.js";
import type {
  MatchedAction,
  RecoverableClaim,
  RecoverableInterval,
} from "../core/model.js";
import {
  encodeAgentIdentity,
  evidenceEventIdentity,
} from "../core/event-identity.js";
import {
  resourceDomainDecision,
  type EffectiveRuleSafetyPolicy,
} from "../policy/rule-safety.js";
import {
  createFindingCandidate,
  impactFromClaim,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";

export interface SerialSlackOptions {
  sourceCompleteness?: number;
  ruleSafety?: EffectiveRuleSafetyPolicy;
}

const READ_TOOL_NAMES = new Set([
  "glob",
  "grep",
  "list",
  "ls",
  "read",
  "search",
]);

const READ_ONLY_EXECUTABLES = new Set([
  "cat",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "stat",
  "tail",
  "wc",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

interface EligibleAction {
  action: MatchedAction;
  paths: string[];
}

function normalizedToolName(value: string | undefined): string {
  return (value ?? "").replaceAll("-", "_").toLocaleLowerCase("en-US");
}

function normalizedPath(value: string): string {
  let result = value.normalize("NFC").trim().replaceAll("\\", "/");
  while (result.startsWith("./")) result = result.slice(2);
  return result.replace(/\/+/gu, "/").replace(/\/$/u, "");
}

function pathsFor(action: MatchedAction): string[] {
  return sortedUnique(
    action.paths.map(normalizedPath).filter((path) => path !== ""),
  );
}

function relevancePathsFor(action: MatchedAction): string[] {
  return sortedUnique(
    action.relevance_paths
      .map(normalizedPath)
      .filter((path) => path !== ""),
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function pathsAreDisjoint(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.every((leftPath) =>
    right.every((rightPath) => !pathsOverlap(leftPath, rightPath))
  );
}

export function isReadOnlyCommand(command: string | undefined): boolean {
  if (command === undefined || command.trim() === "") return false;
  const descriptor = classifyCommand(command);
  if (descriptor.opaque || descriptor.tokens.length === 0) return false;
  // Composite commands are never vouched for as read-only: a later segment
  // or redirect could write even when the first segment looks safe.
  if (descriptor.segmentFamilies !== undefined) return false;
  const executable = basename(descriptor.tokens[0] ?? "")
    .toLocaleLowerCase("en-US");
  const args = descriptor.tokens.slice(1);

  if (executable === "git") {
    const subcommand = args.find((token) => !token.startsWith("-"));
    return subcommand !== undefined &&
      READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
  }
  return READ_ONLY_EXECUTABLES.has(executable);
}

function eligibleAction(action: MatchedAction): EligibleAction | null {
  if (action.kind !== "tool" || normalizeInterval(action.interval) === null) {
    return null;
  }
  const paths = pathsFor(action);
  const nativeRead =
    READ_TOOL_NAMES.has(normalizedToolName(action.tool_name)) &&
    (action.match === "safe_read" || action.match === "duplicate_read");
  if (nativeRead || isReadOnlyCommand(action.command)) {
    return paths.length === 0 ? null : { action, paths };
  }
  if (action.command === undefined) return null;
  const descriptor = classifyCommand(action.command);
  const mappedValidation =
    descriptor.family === "other" &&
    (action.match === "contributing_run" ||
      action.match === "redundant_run") &&
    action.normalized_command !== undefined &&
    action.normalized_command !== "" &&
    action.normalized_command === descriptor.normalized;
  if (
    descriptor.opaque ||
    (descriptor.family === "other" && !mappedValidation)
  ) {
    return null;
  }
  const relevancePaths = relevancePathsFor(action);
  return relevancePaths.length === 0
    ? null
    : { action, paths: relevancePaths };
}

function upperClaim(
  target: string,
  actions: readonly MatchedAction[],
): {
  claim: RecoverableClaim;
  serialDurationMs: number;
  longestActionMs: number;
} {
  const base = recoverableClaim("R005", target, actions);
  const durations = actions.map((action) => durationMs([action.interval]));
  const serialDurationMs = durations.reduce(
    (total, duration) => total + duration,
    0,
  );
  const longestActionMs = Math.max(0, ...durations);
  const intervals: RecoverableInterval[] = base.intervals.map((interval) => ({
    ...interval,
  }));
  return {
    claim: {
      bound: "upper",
      estimated_ms: Math.max(0, serialDurationMs - longestActionMs),
      intervals,
    },
    serialDurationMs,
    longestActionMs,
  };
}

function groupsForAgent(
  actions: readonly MatchedAction[],
): EligibleAction[][] {
  const groups: EligibleAction[][] = [];
  let current: EligibleAction[] = [];

  const flush = (): void => {
    if (current.length >= 2) groups.push(current);
    current = [];
  };

  for (const action of actions) {
    if (action.kind === "inference") continue;
    if (action.kind !== "tool") {
      flush();
      continue;
    }
    const eligible = eligibleAction(action);
    if (eligible === null) {
      flush();
      continue;
    }
    const previous = current.at(-1);
    const serial =
      previous === undefined ||
      previous.action.interval.end_ms <= action.interval.start_ms;
    const independent = current.every((entry) =>
      pathsAreDisjoint(entry.paths, eligible.paths)
    );
    if (!serial || !independent) {
      flush();
    }
    current.push(eligible);
  }
  flush();
  return groups;
}

export function detectSerialSlack(
  actions: readonly MatchedAction[],
  options: SerialSlackOptions = {},
) {
  const byAgent = new Map<string, MatchedAction[]>();
  for (const action of orderedActions(actions)) {
    const key = encodeAgentIdentity(evidenceEventIdentity(action));
    const group = byAgent.get(key);
    if (group === undefined) byAgent.set(key, [action]);
    else group.push(action);
  }

  return [...byAgent.values()]
    .flatMap(groupsForAgent)
    .map((group) => {
      const groupActions = group.map(({ action }) => action);
      const paths = sortedUnique(group.flatMap(({ paths }) => paths));
      const target = paths.join(" | ");
      const {
        claim,
        serialDurationMs,
        longestActionMs,
      } = upperClaim(target, groupActions);
      const decision = resourceDomainDecision(
        groupActions.map((action) => action.command),
        options.ruleSafety,
      );
      const evidenceConfidence = minimumConfidence(
        groupActions.flatMap((action) => [
          action.confidence,
          action.match_confidence,
        ]),
      );
      return createFindingCandidate({
        rule_id: "R005",
        title: "Path-disjoint tool calls ran serially",
        classification: "behavior",
        cause: null,
        scope: "claude_md",
        impact: impactFromClaim(claim, "resource_cost"),
        finding_confidence: {
          evidence: evidenceConfidence,
          causal: minimumConfidence([evidenceConfidence, "medium"]),
          source_completeness: options.sourceCompleteness ?? 1,
        },
        target,
        evidence: {
          session_refs: sortedUnique(
            groupActions.flatMap((action) => action.session_refs),
          ),
          interval_ids: claim.intervals.map(
            (interval) => interval.interval_id,
          ),
          paths,
          action_count: groupActions.length,
          serial_duration_ms: serialDurationMs,
          longest_action_ms: longestActionMs,
          commands: sortedUnique(
            groupActions.flatMap((action) =>
              action.command === undefined ? [] : [action.command]
            ),
          ),
          tool_names: sortedUnique(
            groupActions.flatMap((action) =>
              action.tool_name === undefined ? [] : [action.tool_name]
            ),
          ),
          parallelization_classification: decision.kind,
          ...(decision.kind === "investigation_candidate"
            ? {}
            : { resource_domain: decision.domain }),
        },
        intervals: claim.intervals,
        fix_recipe: {
          suggestion: decision.kind === "parallel_safe"
            ? `Batch the independent read or validation calls for ${target} into one parallel tool invocation.`
            : decision.kind === "parallel_unsafe"
              ? `The effective resource-domain policy prohibits concurrent execution for ${target}; no parallel invocation is recommended.`
              : `Review shared resources for the path-disjoint read or validation calls affecting ${target} before changing execution.`,
          verify: "ccprof --json",
        },
        caveats: sortedUnique([
          ...groupActions.flatMap((action) => action.caveats),
          "The estimate is an upper bound: it subtracts the longest call from measured serial execution and does not assert achievable speedup.",
        ]),
      });
    })
    .filter((finding) => finding.recoverable.estimated_ms > 0)
    .sort(
      (left, right) =>
        left.target.localeCompare(right.target) ||
        left.finding_key.localeCompare(right.finding_key),
    );
}
