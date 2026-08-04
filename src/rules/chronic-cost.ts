import { types as utilTypes } from "node:util";

import {
  classifyCommand,
  normalizeCommand,
} from "../analysis/command.js";
import {
  commandIdentityKey,
  formatCommandIdentityTarget,
} from "../analysis/command-identity.js";
import {
  cohortDistribution,
  selectComparableTerminalSnapshots,
  type CohortDistribution,
  type CohortEvaluationMode,
  type StatsAggregationInput,
} from "../analysis/stats-aggregation.js";
import type { CommandIdentity, FindingCandidate } from "../core/model.js";
import type { AnalysisRecord } from "../store/analyses.js";
import { ruleManifest } from "./manifest.js";
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

export interface ChronicCostAggregate {
  cohort_key: string;
  command_key: string;
  cache_state: "cold" | "warm";
  history_count: number;
  presence_count: number;
  distribution: CohortDistribution;
  ratio: number;
  resource_upper_ms: number;
}

export interface ChronicCostMaterializationEntry {
  cohort_key: string;
  command_key: string;
  cache_state: "cold" | "warm";
  command: string;
  command_identity: CommandIdentity;
  session_refs: string[];
}

export type MaterializedChronicCostFinding = FindingCandidate & {
  rule_version: string;
  compatibility_epoch: number;
};

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
  const total = [...values].sort((left, right) => left - right)
    .reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : Number.NaN;
}

function laneKey(
  cohortKey: string,
  commandKey: string,
  cacheState: "cold" | "warm",
): string {
  return `${cohortKey}\0${commandKey}\0${cacheState}`;
}

export function buildChronicCostAggregates(
  input: readonly StatsAggregationInput[],
  mode: CohortEvaluationMode,
  minimumCohortSize = CHRONIC_MINIMUM_HISTORY_COUNT,
): ChronicCostAggregate[] {
  validateThreshold(minimumCohortSize, "minimum cohort size", true);
  const terminals = selectComparableTerminalSnapshots(input, mode);
  const populations = new Map<string, StatsAggregationInput[]>();
  for (const terminal of terminals) {
    if (terminal.cohort_key === undefined) continue;
    const population = populations.get(terminal.cohort_key);
    if (population === undefined) {
      populations.set(terminal.cohort_key, [terminal]);
    } else {
      population.push(terminal);
    }
  }

  const results: ChronicCostAggregate[] = [];
  for (const [cohortKey, population] of [...populations.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const historyCount = population.length;
    if (historyCount < minimumCohortSize) continue;
    const wallTerms = population.map((entry) =>
      entry.terminal_metrics?.measured_wall_ms);
    if (wallTerms.some((value) => !finitePositive(value))) continue;
    const measuredWallMs = sortedSum(wallTerms as number[]);
    if (!finitePositive(measuredWallMs)) continue;

    const samplesByLane = new Map<string, {
      command_key: string;
      cache_state: "cold" | "warm";
      samples: number[];
    }>();
    for (const terminal of population) {
      const perSnapshot = new Map<string, {
        command_key: string;
        cache_state: "cold" | "warm";
        terms: number[];
      }>();
      for (const cost of terminal.command_costs) {
        if (!finitePositive(cost.duration_ms)) continue;
        const key = laneKey(cohortKey, cost.command_key, cost.cache_state);
        const current = perSnapshot.get(key);
        if (current === undefined) {
          perSnapshot.set(key, {
            command_key: cost.command_key,
            cache_state: cost.cache_state,
            terms: [cost.duration_ms],
          });
        } else {
          current.terms.push(cost.duration_ms);
        }
      }
      for (const [key, lane] of perSnapshot) {
        const sample = sortedSum(lane.terms);
        if (!finitePositive(sample)) continue;
        const aggregate = samplesByLane.get(key);
        if (aggregate === undefined) {
          samplesByLane.set(key, {
            command_key: lane.command_key,
            cache_state: lane.cache_state,
            samples: [sample],
          });
        } else {
          aggregate.samples.push(sample);
        }
      }
    }

    for (const lane of samplesByLane.values()) {
      const presenceCount = lane.samples.length;
      if (presenceCount < minimumCohortSize) continue;
      const totalCostMs = sortedSum(lane.samples);
      if (!finitePositive(totalCostMs)) continue;
      const ratio = totalCostMs / measuredWallMs;
      const resourceUpperMs = totalCostMs / historyCount;
      if (
        !Number.isFinite(ratio) || ratio < CHRONIC_MINIMUM_COST_RATIO ||
        !finitePositive(resourceUpperMs)
      ) continue;
      results.push({
        cohort_key: cohortKey,
        command_key: lane.command_key,
        cache_state: lane.cache_state,
        history_count: historyCount,
        presence_count: presenceCount,
        distribution: cohortDistribution(lane.samples),
        ratio: rounded(ratio),
        resource_upper_ms: rounded(resourceUpperMs),
      });
    }
  }
  return results.sort((left, right) =>
    left.cohort_key.localeCompare(right.cohort_key) ||
    left.command_key.localeCompare(right.command_key) ||
    left.cache_state.localeCompare(right.cache_state));
}

function readCommandIdentity(value: unknown): CommandIdentity | undefined {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
  ) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const fields = [
    "repo_relative_cwd", "normalized_argv", "executor",
  ] as const;
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(
      key as (typeof fields)[number],
    )) ||
    fields.some((field) => {
      const descriptor = descriptors[field];
      return descriptor === undefined || descriptor.enumerable !== true ||
        !("value" in descriptor);
    })
  ) return undefined;
  const cwd = descriptors.repo_relative_cwd?.value;
  const argv = descriptors.normalized_argv?.value;
  const executor = descriptors.executor?.value;
  if (
    typeof cwd !== "string" ||
    (cwd !== "." && (cwd === "" || cwd.includes("\0") || cwd.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(cwd) || cwd.split("/").some((segment) =>
        segment === "" || segment === "." || segment === ".."))) ||
    !Array.isArray(argv) || utilTypes.isProxy(argv) ||
    Object.getPrototypeOf(argv) !== Array.prototype ||
    argv.length === 0 || argv[0] === "" ||
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

function materializationEntry(
  value: unknown,
): ChronicCostMaterializationEntry | undefined {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
  ) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = [
    "cohort_key", "command_key", "cache_state", "command",
    "command_identity", "session_refs",
  ] as const;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(
      key as (typeof fields)[number],
    )) ||
    fields.some((field) => {
      const descriptor = descriptors[field];
      return descriptor === undefined || descriptor.enumerable !== true ||
        !("value" in descriptor);
    })
  ) return undefined;
  const read = (field: (typeof fields)[number]): unknown =>
    descriptors[field]?.value;
  const cohortKey = read("cohort_key");
  const commandKey = read("command_key");
  const cacheState = read("cache_state");
  const rawCommand = read("command");
  const identity = readCommandIdentity(read("command_identity"));
  const refs = read("session_refs");
  const command = typeof rawCommand === "string"
    ? normalizeCommand(rawCommand)
    : null;
  if (
    typeof cohortKey !== "string" || !/^[0-9a-f]{64}$/u.test(cohortKey) ||
    typeof commandKey !== "string" || !/^[0-9a-f]{64}$/u.test(commandKey) ||
    (cacheState !== "cold" && cacheState !== "warm") || command === null ||
    identity === undefined || !Array.isArray(refs) || utilTypes.isProxy(refs) ||
    refs.some((ref) => typeof ref !== "string" || ref === "")
  ) return undefined;
  return {
    cohort_key: cohortKey,
    command_key: commandKey,
    cache_state: cacheState,
    command,
    command_identity: identity,
    session_refs: sortedUnique(refs as string[]),
  };
}

export function materializeChronicCostFindings(
  aggregates: readonly ChronicCostAggregate[],
  entries: readonly ChronicCostMaterializationEntry[],
  options: Pick<ChronicCostOptions, "sourceCompleteness"> = {},
): MaterializedChronicCostFinding[] {
  const byLane = new Map<string, ChronicCostMaterializationEntry>();
  const invalidLanes = new Set<string>();
  for (const value of entries as readonly unknown[]) {
    const entry = materializationEntry(value);
    if (entry === undefined) continue;
    const key = laneKey(entry.cohort_key, entry.command_key, entry.cache_state);
    if (byLane.has(key)) {
      byLane.delete(key);
      invalidLanes.add(key);
    } else if (!invalidLanes.has(key)) {
      byLane.set(key, entry);
    }
  }
  const manifest = ruleManifest("R006");
  return [...aggregates].sort((left, right) =>
    left.cohort_key.localeCompare(right.cohort_key) ||
    left.command_key.localeCompare(right.command_key) ||
    left.cache_state.localeCompare(right.cache_state))
    .flatMap((aggregate): MaterializedChronicCostFinding[] => {
      if (
        !Number.isSafeInteger(aggregate.history_count) ||
        !Number.isSafeInteger(aggregate.presence_count) ||
        aggregate.history_count <= 0 || aggregate.presence_count <= 0 ||
        aggregate.distribution.sample_count !== aggregate.presence_count ||
        !finitePositive(aggregate.ratio) ||
        !finitePositive(aggregate.resource_upper_ms)
      ) return [];
      const key = laneKey(
        aggregate.cohort_key,
        aggregate.command_key,
        aggregate.cache_state,
      );
      const entry = byLane.get(key);
      if (entry === undefined || invalidLanes.has(key) ||
        entry.session_refs.length === 0) return [];
      const identity = {
        ...entry.command_identity,
        normalized_argv: [...entry.command_identity.normalized_argv],
      };
      const target = `${formatCommandIdentityTarget(identity, entry.command)}${
        identity.executor === "native-tool" ? " [native-tool]" : ""
      } [${entry.cache_state}]`;
      const candidate = createFindingCandidate({
        rule_id: "R006",
        title: "Chronic command cost",
        classification: "repo",
        cause: null,
        scope: "separate_issue",
        impact: {
          lower_ms: 0,
          upper_ms: aggregate.resource_upper_ms,
          kind: "resource_cost",
        },
        finding_confidence: {
          evidence: "high",
          causal: "medium",
          source_completeness: options.sourceCompleteness ?? 1,
        },
        target,
        evidence: {
          session_refs: entry.session_refs,
          interval_ids: [],
          command: entry.command,
          command_identity: identity,
          cache_state: entry.cache_state,
          history_count: aggregate.history_count,
          presence_count: aggregate.presence_count,
          sample_count: aggregate.distribution.sample_count,
          ratio: aggregate.ratio,
          resource_upper_ms: aggregate.resource_upper_ms,
          median: aggregate.distribution.median,
          p50: aggregate.distribution.p50,
          p75: aggregate.distribution.p75,
          mad: aggregate.distribution.mad,
        },
        intervals: [],
        fix_recipe: recipe(entry.command, identity),
        caveats: [
          "The estimate is a historical per-analysis upper bound; actual savings require a repository change and follow-up measurement.",
        ],
      });
      return [{
        ...candidate,
        finding_key: findingKey("R006",
          `command-cohort:${aggregate.cohort_key}:${aggregate.command_key}:${
            aggregate.cache_state
          }:${target}`),
        rule_version: manifest.version,
        compatibility_epoch: manifest.compatibility_epoch,
      }];
    });
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
