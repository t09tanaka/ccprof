import {
  classifyCommand,
  normalizeCommand,
} from "../analysis/command.js";
import {
  commandIdentityKey,
  formatCommandIdentityTarget,
} from "../analysis/command-identity.js";
import type { CommandIdentity, FindingCandidate } from "../core/model.js";
import type { AnalysisRecord } from "../store/analyses.js";
import {
  createFindingCandidate,
  findingKey,
  sortedUnique,
} from "./shared.js";

export const CHRONIC_MINIMUM_HISTORY_COUNT = 5;
export const CHRONIC_MINIMUM_PRESENCE_COUNT = 3;
export const CHRONIC_MINIMUM_COST_RATIO = 0.3;

export interface ChronicCostOptions {
  minimum_history_count?: number;
  minimum_presence_count?: number;
  minimum_cost_ratio?: number;
  sourceCompleteness?: number;
}

interface CommandAggregate {
  command: string;
  identity: CommandIdentity;
  cost_terms: number[];
  presence_count: number;
  session_refs: string[];
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function sortedSum(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)
    .reduce((total, value) => total + value, 0);
}

function readCommandIdentity(value: unknown): CommandIdentity | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const identity = value as Record<string, unknown>;
  const cwd = identity.repo_relative_cwd;
  const argv = identity.normalized_argv;
  const executor = identity.executor;
  if (
    typeof cwd !== "string" ||
    (cwd !== "." && (cwd === "" || cwd.includes("\0") || cwd.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(cwd) || cwd.split("/").some((segment) =>
        segment === "" || segment === "." || segment === ".."))) ||
    !Array.isArray(argv) || argv.length === 0 || argv[0] === "" ||
    argv.some((entry) => typeof entry !== "string") ||
    (executor !== "shell" && executor !== "native-tool")
  ) return undefined;
  return { repo_relative_cwd: cwd, normalized_argv: [...argv] as string[], executor };
}

function validateThreshold(
  value: number,
  name: string,
  integer: boolean,
): void {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new TypeError(`${name} must be a positive ${integer ? "safe integer" : "number"}`);
  }
}

function matchingFindingRefs(
  record: AnalysisRecord,
  identityKey: string,
): string[] {
  const findings: readonly unknown[] = Array.isArray(record.findings)
    ? record.findings
    : [];
  return findings.flatMap((finding) => {
    if (
      finding === null ||
      typeof finding !== "object" ||
      !("evidence" in finding) ||
      finding.evidence === null ||
      typeof finding.evidence !== "object"
    ) {
      return [];
    }
    const identity = "command_identity" in finding.evidence
      ? readCommandIdentity(finding.evidence.command_identity)
      : undefined;
    if (identity === undefined || commandIdentityKey(identity) !== identityKey) return [];
    const refs = "session_refs" in finding.evidence
      ? finding.evidence.session_refs
      : undefined;
    return Array.isArray(refs)
      ? refs.filter((ref): ref is string => typeof ref === "string")
      : [];
  });
}

function recipe(command: string, identity: CommandIdentity): {
  suggestion: string;
  verify: string;
} {
  const descriptor = classifyCommand(command);
  if (descriptor.family === "build" || descriptor.family === "check") {
    return {
      suggestion:
        `In \`${identity.repo_relative_cwd}\`, add or tune repository build caching for \`${command}\`, then compare its duration across several PRs.`,
      verify: command,
    };
  }
  if (descriptor.family === "test") {
    return {
      suggestion:
        `In \`${identity.repo_relative_cwd}\`, split or affected-scope \`${command}\` while retaining it as the final full validation.`,
      verify: command,
    };
  }
  return {
    suggestion:
      `In \`${identity.repo_relative_cwd}\`, cache or split the repeated work in \`${command}\`, then compare its duration across several PRs.`,
    verify: command,
  };
}

export function detectChronicCost(
  history: readonly AnalysisRecord[],
  options: ChronicCostOptions = {},
): FindingCandidate[] {
  const minimumHistoryCount =
    options.minimum_history_count ?? CHRONIC_MINIMUM_HISTORY_COUNT;
  const minimumPresenceCount =
    options.minimum_presence_count ?? CHRONIC_MINIMUM_PRESENCE_COUNT;
  const minimumCostRatio =
    options.minimum_cost_ratio ?? CHRONIC_MINIMUM_COST_RATIO;
  validateThreshold(minimumHistoryCount, "minimum history count", true);
  validateThreshold(minimumPresenceCount, "minimum presence count", true);
  validateThreshold(minimumCostRatio, "minimum cost ratio", false);

  if (history.length < minimumHistoryCount) return [];
  const measuredMin = sortedSum(history.flatMap((record) =>
    finitePositive(record.summary.measured_min) ? [record.summary.measured_min] : []));
  if (measuredMin <= 0) return [];

  const aggregates = new Map<string, CommandAggregate>();
  for (const record of history) {
    const costByIdentity = new Map<string, Omit<CommandAggregate, "presence_count">>();
    for (const cost of record.command_costs) {
      if (!finitePositive(cost.duration_min)) continue;
      const identity = readCommandIdentity(cost.command_identity);
      if (identity === undefined) continue;
      const command = normalizeCommand(cost.command);
      if (command === null) continue;
      const key = commandIdentityKey(identity);
      const existing = costByIdentity.get(key);
      if (existing === undefined) {
        costByIdentity.set(key, {
          command, identity, cost_terms: [cost.duration_min],
          session_refs: sortedUnique(cost.session_refs),
        });
      } else {
        if (command < existing.command) existing.command = command;
        existing.cost_terms.push(cost.duration_min);
        existing.session_refs = sortedUnique([...existing.session_refs, ...cost.session_refs]);
      }
    }
    for (const [key, cost] of costByIdentity) {
      const costMin = sortedSum(cost.cost_terms);
      const refs = sortedUnique([...cost.session_refs, ...matchingFindingRefs(record, key)]);
      const existing = aggregates.get(key);
      if (existing === undefined) {
        aggregates.set(key, { ...cost, cost_terms: [costMin], presence_count: 1,
          session_refs: refs });
      } else {
        if (cost.command < existing.command) existing.command = cost.command;
        existing.cost_terms.push(costMin);
        existing.presence_count += 1;
        existing.session_refs = sortedUnique([...existing.session_refs, ...refs]);
      }
    }
  }

  return [...aggregates.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([identityKey, aggregate]) => {
      const costMin = sortedSum(aggregate.cost_terms);
      const ratio = costMin / measuredMin;
      if (
        aggregate.presence_count < minimumPresenceCount ||
        ratio < minimumCostRatio ||
        aggregate.session_refs.length === 0
      ) {
        return [];
      }
      const identity = { ...aggregate.identity,
        normalized_argv: [...aggregate.identity.normalized_argv] };
      const target = formatCommandIdentityTarget(identity, aggregate.command) +
        (identity.executor === "native-tool" ? " [native-tool]" : "");
      const estimatedMs = (costMin / history.length) * 60_000;
      const candidate = createFindingCandidate({
        rule_id: "R006",
        title: "Chronic command cost",
        classification: "repo",
        cause: null,
        scope: "separate_issue",
        impact: {
          lower_ms: 0,
          upper_ms: estimatedMs,
          kind: "resource_cost",
        },
        finding_confidence: {
          evidence: "high",
          causal: "medium",
          source_completeness: options.sourceCompleteness ?? 1,
        },
        target,
        evidence: {
          session_refs: aggregate.session_refs,
          interval_ids: [],
          command: aggregate.command,
          command_identity: identity,
          history_count: history.length,
          presence_count: aggregate.presence_count,
          cost_min: rounded(costMin),
          measured_min: rounded(measuredMin),
          cost_ratio: rounded(ratio),
          minimum_history_count: minimumHistoryCount,
          minimum_presence_count: minimumPresenceCount,
          minimum_cost_ratio: minimumCostRatio,
        },
        intervals: [],
        fix_recipe: recipe(aggregate.command, identity),
        caveats: [
          "The estimate is a historical per-analysis upper bound; actual savings require a repository change and follow-up measurement.",
        ],
      });
      return [{ ...candidate, finding_key: findingKey("R006",
        `command-identity:${Buffer.from(identityKey, "utf8").toString("hex")}`) }];
    });
}
