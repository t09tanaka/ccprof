import {
  classifyCommand,
  normalizeCommand,
} from "../analysis/command.js";
import type { FindingCandidate } from "../core/model.js";
import type { AnalysisRecord } from "../store/analyses.js";
import {
  createFindingCandidate,
  sortedUnique,
} from "./shared.js";

export const CHRONIC_MINIMUM_HISTORY_COUNT = 5;
export const CHRONIC_MINIMUM_PRESENCE_COUNT = 3;
export const CHRONIC_MINIMUM_COST_RATIO = 0.3;

export interface ChronicCostOptions {
  minimum_history_count?: number;
  minimum_presence_count?: number;
  minimum_cost_ratio?: number;
}

interface CommandAggregate {
  cost_min: number;
  presence_count: number;
  session_refs: string[];
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
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
  normalizedCommand: string,
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
    const command = "command" in finding.evidence
      ? finding.evidence.command
      : undefined;
    if (
      typeof command !== "string" ||
      normalizeCommand(command) !== normalizedCommand
    ) {
      return [];
    }
    const refs = "session_refs" in finding.evidence
      ? finding.evidence.session_refs
      : undefined;
    return Array.isArray(refs)
      ? refs.filter((ref): ref is string => typeof ref === "string")
      : [];
  });
}

function recipe(command: string): {
  suggestion: string;
  verify: string;
} {
  const descriptor = classifyCommand(command);
  if (descriptor.family === "build" || descriptor.family === "check") {
    return {
      suggestion:
        `Add or tune repository build caching for \`${command}\`, then compare its duration across several PRs.`,
      verify: command,
    };
  }
  if (descriptor.family === "test") {
    return {
      suggestion:
        `Split or affected-scope \`${command}\` while retaining it as the final full validation.`,
      verify: command,
    };
  }
  return {
    suggestion:
      `Cache or split the repeated work in \`${command}\`, then compare its duration across several PRs.`,
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
  const measuredMin = history.reduce(
    (total, record) =>
      total +
      (finitePositive(record.summary.measured_min)
        ? record.summary.measured_min
        : 0),
    0,
  );
  if (measuredMin <= 0) return [];

  const aggregates = new Map<string, CommandAggregate>();
  for (const record of history) {
    const costByCommand = new Map<string, {
      cost_min: number;
      session_refs: string[];
    }>();
    for (const cost of record.command_costs) {
      if (!finitePositive(cost.duration_min)) continue;
      const command = normalizeCommand(cost.command);
      if (command === null) continue;
      const existing = costByCommand.get(command);
      const refs = sortedUnique([
        ...(existing?.session_refs ?? []),
        ...cost.session_refs,
        ...matchingFindingRefs(record, command),
      ]);
      costByCommand.set(command, {
        cost_min: (existing?.cost_min ?? 0) + cost.duration_min,
        session_refs: refs,
      });
    }
    for (const [command, cost] of costByCommand) {
      const existing = aggregates.get(command);
      aggregates.set(command, {
        cost_min: (existing?.cost_min ?? 0) + cost.cost_min,
        presence_count: (existing?.presence_count ?? 0) + 1,
        session_refs: sortedUnique([
          ...(existing?.session_refs ?? []),
          ...cost.session_refs,
        ]),
      });
    }
  }

  return [...aggregates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([command, aggregate]) => {
      const ratio = aggregate.cost_min / measuredMin;
      if (
        aggregate.presence_count < minimumPresenceCount ||
        ratio < minimumCostRatio ||
        aggregate.session_refs.length === 0
      ) {
        return [];
      }
      const estimatedMs =
        (aggregate.cost_min / history.length) * 60_000;
      return [createFindingCandidate({
        rule_id: "R006",
        title: "Chronic command cost",
        classification: "repo",
        cause: null,
        scope: "separate_issue",
        confidence: "high",
        target: command,
        evidence: {
          session_refs: aggregate.session_refs,
          interval_ids: [],
          command,
          history_count: history.length,
          presence_count: aggregate.presence_count,
          cost_min: rounded(aggregate.cost_min),
          measured_min: rounded(measuredMin),
          cost_ratio: rounded(ratio),
          minimum_history_count: minimumHistoryCount,
          minimum_presence_count: minimumPresenceCount,
          minimum_cost_ratio: minimumCostRatio,
        },
        recoverable: {
          bound: "upper",
          estimated_ms: estimatedMs,
          intervals: [],
        },
        fix_recipe: recipe(command),
        caveats: [
          "The estimate is a historical per-analysis upper bound; actual savings require a repository change and follow-up measurement.",
        ],
      })];
    });
}
