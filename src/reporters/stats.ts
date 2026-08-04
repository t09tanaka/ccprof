import { detectability } from "../analysis/adoption.js";
import { commandIdentityKey, formatCommandIdentityTarget } from "../analysis/command-identity.js";
import type {
  TerminalMetricAggregate,
  TerminalStatsAggregateMetadata,
  TerminalStatsAggregateResult,
  TerminalStatsCohortAggregate,
} from "../analysis/stats-aggregation.js";
import type {
  BaselineNotable,
  Bound,
  CommandIdentity,
  Finding,
  RuleId,
} from "../core/model.js";
import {
  detectChronicCost,
  type ChronicCostAggregate,
  type ChronicCostMaterializationEntry,
} from "../rules/chronic-cost.js";
import type { AnalysisRecord } from "../store/analyses.js";
import type { AdoptionMethod, AdoptionRecord } from "../store/adoptions.js";
import { sanitizeHumanText } from "./sanitize.js";
import { formatMinutes } from "./tty.js";

export interface StatsBaselineMetric extends BaselineNotable {}

export interface StatsChronicCommand {
  command: string;
  command_identity?: CommandIdentity;
  cache_state?: "cold" | "warm";
  history_count?: number;
  presence_count: number;
  sample_count?: number;
  ratio?: number;
  resource_upper_ms?: number;
  median?: number;
  p50?: number;
  p75?: number;
  mad?: number;
  cost_ratio: number;
  estimated_min: number;
}

export interface StatsRuleMinutes {
  rule_id: RuleId;
  minutes: number;
}

export type RecurringTrend =
  | "improved"
  | "worsened"
  | "flat"
  | "indeterminate";

export interface StatsRecurringFinding {
  finding_key: string;
  rule_id: RuleId;
  title: string;
  occurrence_count: number;
  first_min: number;
  first_bound: Bound;
  last_min: number;
  last_bound: Bound;
  trend: RecurringTrend;
}

export const STATS_RECURRING_TTY_LIMIT = 10;

export type StatsAdoptionStatus = "no_recurrence" | "recurred" | "no_data";

export interface StatsAdoption {
  finding_key: string;
  rule_id: RuleId;
  title: string;
  method: AdoptionMethod;
  detected_at_ms: number;
  analyses_after: number;
  recurrences_after: number;
  minutes_before: number;
  minutes_after: number;
  status: StatsAdoptionStatus;
}

export interface StatsAdoptionCoverage {
  detectable: number;
  undetectable: number;
}

export const STATS_PROJECTION = "numeric_bounded_opaque_v1" as const;

export interface StatsMetadata extends TerminalStatsAggregateMetadata {
  privacy_profile?: "strict" | "balanced" | "raw";
  projection?: typeof STATS_PROJECTION;
}

export interface StatsCohortAggregate
  extends Omit<TerminalStatsCohortAggregate, "cohort_key"> {
  cohort_key?: string;
}

export interface StatsReport {
  history_count: number;
  metadata?: StatsMetadata;
  terminal_metrics?: TerminalMetricAggregate;
  cohorts?: StatsCohortAggregate[];
  baseline_metrics: StatsBaselineMetric[];
  chronic_commands: StatsChronicCommand[];
  rule_minutes: StatsRuleMinutes[];
  recurring_findings: StatsRecurringFinding[];
  adoptions: StatsAdoption[];
  adoption_coverage: StatsAdoptionCoverage;
}

function rounded(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function numberEvidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function statsIdentity(value: unknown): CommandIdentity | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const identity = value as Record<string, unknown>;
  const cwd = identity.repo_relative_cwd;
  const argv = identity.normalized_argv;
  const executor = identity.executor;
  if (typeof cwd !== "string" || !Array.isArray(argv) || argv.length === 0 ||
    argv[0] === "" || argv.some((entry) => typeof entry !== "string") ||
    (executor !== "shell" && executor !== "native-tool")) return undefined;
  return { repo_relative_cwd: cwd, normalized_argv: [...argv] as string[], executor };
}

function recordOrder(
  left: AnalysisRecord,
  right: AnalysisRecord,
): number {
  return left.created_at_ms - right.created_at_ms ||
    left.analysis_id.localeCompare(right.analysis_id);
}

/**
 * Tracks findings whose stable key recurs across analyses, comparing the
 * first and latest recoverable estimates so suggestion adoption is visible.
 */
function recurringFindings(
  ordered: readonly AnalysisRecord[],
): StatsRecurringFinding[] {
  const byKey = new Map<string, {
    rule_id: RuleId;
    title: string;
    minutesPerAnalysis: number[];
    boundsPerAnalysis: Bound[];
  }>();
  for (const record of ordered) {
    const perAnalysis = new Map<string, { minutes: number; bound: Bound }>();
    for (const finding of record.findings) {
      const minutes = numberEvidence(finding.recoverable.min);
      const existing = perAnalysis.get(finding.finding_key);
      perAnalysis.set(finding.finding_key, {
        minutes: (existing?.minutes ?? 0) + Math.max(0, minutes),
        // A sum with any upper-bound contribution is itself an upper bound.
        bound: existing?.bound === "upper" ||
            finding.recoverable.bound === "upper"
          ? "upper"
          : "point",
      });
      if (!byKey.has(finding.finding_key)) {
        byKey.set(finding.finding_key, {
          rule_id: finding.rule_id,
          title: finding.title,
          minutesPerAnalysis: [],
          boundsPerAnalysis: [],
        });
      }
    }
    for (const [key, value] of perAnalysis) {
      const entry = byKey.get(key);
      if (entry === undefined) continue;
      entry.minutesPerAnalysis.push(value.minutes);
      entry.boundsPerAnalysis.push(value.bound);
    }
  }
  return [...byKey.entries()]
    .filter(([, entry]) => entry.minutesPerAnalysis.length >= 2)
    .map(([finding_key, entry]): StatsRecurringFinding => {
      const first_min = rounded(entry.minutesPerAnalysis[0] ?? 0);
      const last_min = rounded(entry.minutesPerAnalysis.at(-1) ?? 0);
      const first_bound = entry.boundsPerAnalysis[0] ?? "point";
      const last_bound = entry.boundsPerAnalysis.at(-1) ?? "point";
      return {
        finding_key,
        rule_id: entry.rule_id,
        title: entry.title,
        occurrence_count: entry.minutesPerAnalysis.length,
        first_min,
        first_bound,
        last_min,
        last_bound,
        // Comparing an upper bound against a point estimate says nothing
        // about real change, so mixed bounds stay indeterminate.
        trend: first_bound !== last_bound
          ? "indeterminate"
          : last_min < first_min
            ? "improved"
            : last_min > first_min
              ? "worsened"
              : "flat",
      };
    })
    .sort(
      (left, right) =>
        right.last_min - left.last_min ||
        left.rule_id.localeCompare(right.rule_id) ||
        left.finding_key.localeCompare(right.finding_key),
    );
}

/**
 * Compares an adoption record against the analysis history to see whether
 * the finding it targeted kept showing up afterward. Title/rule_id are
 * refreshed from the latest matching occurrence so renamed rule titles stay
 * current; when the finding never appears in history, the adoption's own
 * rule_id is used and the title is left blank.
 *
 * Re-analyzing the pre-adoption PR replays the same (immutable) session
 * data and can re-surface the same finding_key without any new work having
 * happened. Such origin-PR reruns must not count as recurrence: `origin
 * PrRefs` collects every `unit.pr_ref` that already carried this
 * finding_key at or before `detected_at_ms`, and any post-detection record
 * sharing one of those refs is excluded from `analyses_after`,
 * `recurrences_after`, and `minutes_after` (but still contributes to
 * `minutes_before` if it predates detection, which is unaffected).
 */
function adoptionOutcome(
  adoption: AdoptionRecord,
  ordered: readonly AnalysisRecord[],
): StatsAdoption {
  const originPrRefs = new Set<string>();
  for (const record of ordered) {
    if (record.created_at_ms > adoption.detected_at_ms) continue;
    const hasFinding = record.findings.some(
      (finding) => finding.finding_key === adoption.finding_key,
    );
    if (hasFinding) originPrRefs.add(record.unit.pr_ref);
  }

  let ruleId = adoption.rule_id;
  let title = "";
  let analysesAfter = 0;
  let recurrencesAfter = 0;
  let minutesBefore = 0;
  let minutesAfter = 0;
  for (const record of ordered) {
    const matches = record.findings.filter(
      (finding) => finding.finding_key === adoption.finding_key,
    );
    const latestMatch = matches.at(-1);
    if (latestMatch !== undefined) {
      ruleId = latestMatch.rule_id;
      title = latestMatch.title;
    }
    const minutes = matches.reduce(
      (sum, finding) => sum + Math.max(0, numberEvidence(finding.recoverable.min)),
      0,
    );
    if (record.created_at_ms > adoption.detected_at_ms) {
      if (originPrRefs.has(record.unit.pr_ref)) continue;
      analysesAfter += 1;
      minutesAfter += minutes;
      if (matches.length > 0) recurrencesAfter += 1;
    } else {
      minutesBefore += minutes;
    }
  }
  return {
    finding_key: adoption.finding_key,
    rule_id: ruleId,
    title,
    method: adoption.method,
    detected_at_ms: adoption.detected_at_ms,
    analyses_after: analysesAfter,
    recurrences_after: recurrencesAfter,
    minutes_before: rounded(minutesBefore),
    minutes_after: rounded(minutesAfter),
    status: analysesAfter === 0
      ? "no_data"
      : recurrencesAfter > 0
        ? "recurred"
        : "no_recurrence",
  };
}

function adoptionOutcomes(
  ordered: readonly AnalysisRecord[],
  adoptions: readonly AdoptionRecord[],
): StatsAdoption[] {
  return adoptions
    .map((adoption) => adoptionOutcome(adoption, ordered))
    .sort((left, right) => left.finding_key.localeCompare(right.finding_key));
}

/**
 * Counts, among finding keys seen in history that have no recorded
 * adoption, how many are reachable by the deterministic adoption detector
 * versus structurally invisible to it — making the detection gap explicit
 * rather than silently under-reporting adoptions.
 */
function adoptionCoverage(
  ordered: readonly AnalysisRecord[],
  adoptions: readonly AdoptionRecord[],
): StatsAdoptionCoverage {
  const adoptedKeys = new Set(adoptions.map((entry) => entry.finding_key));
  const latestByKey = new Map<string, Finding>();
  for (const record of ordered) {
    for (const finding of record.findings) {
      latestByKey.set(finding.finding_key, finding);
    }
  }
  let detectable = 0;
  let undetectable = 0;
  for (const [key, latest] of latestByKey) {
    if (adoptedKeys.has(key)) continue;
    const kind = detectability(latest);
    if (kind === "undetectable") undetectable += 1;
    else detectable += 1;
  }
  return { detectable, undetectable };
}

export function summarizeStats(
  records: readonly AnalysisRecord[],
  adoptions: readonly AdoptionRecord[] = [],
): StatsReport {
  const ordered = [...records].sort(recordOrder);
  const latest = ordered.at(-1);
  const baselineMetrics = latest?.summary.baseline?.notable ?? [];
  const chronicCommands = detectChronicCost(ordered)
    .flatMap((finding) => {
      const command = finding.evidence.command;
      const identity = statsIdentity(finding.evidence.command_identity);
      if (typeof command !== "string" || identity === undefined) return [];
      return [{
      command,
      command_identity: identity,
      presence_count: numberEvidence(finding.evidence.presence_count),
      cost_ratio: numberEvidence(finding.evidence.cost_ratio),
      estimated_min: rounded(
        finding.recoverable.estimated_ms / 60_000,
      ),
    }];
    })
    .sort((left, right) => {
      const leftKey = commandIdentityKey(left.command_identity);
      const rightKey = commandIdentityKey(right.command_identity);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const byRule = new Map<RuleId, number>();
  for (const record of ordered) {
    for (const finding of record.findings) {
      const minutes = finding.recoverable.min;
      if (!Number.isFinite(minutes) || minutes <= 0) continue;
      byRule.set(
        finding.rule_id,
        (byRule.get(finding.rule_id) ?? 0) + minutes,
      );
    }
  }
  return {
    history_count: ordered.length,
    baseline_metrics: baselineMetrics
      .map((metric) => ({ ...metric }))
      .sort((left, right) => left.metric.localeCompare(right.metric)),
    chronic_commands: chronicCommands,
    rule_minutes: [...byRule.entries()]
      .map(([rule_id, minutes]) => ({
        rule_id,
        minutes: rounded(minutes),
      }))
      .sort((left, right) => left.rule_id.localeCompare(right.rule_id)),
    recurring_findings: recurringFindings(ordered),
    adoptions: adoptionOutcomes(ordered, adoptions),
    adoption_coverage: adoptionCoverage(ordered, adoptions),
  };
}

function cloneCohortDistributions(
  distributions: NonNullable<StatsCohortAggregate["distributions"]>,
): NonNullable<StatsCohortAggregate["distributions"]> {
  return Object.fromEntries(Object.entries(distributions).map(
    ([axis, distribution]) => [axis, { ...distribution }],
  )) as NonNullable<TerminalStatsCohortAggregate["distributions"]>;
}

function chronicLaneKey(entry: {
  cohort_key: string;
  command_key: string;
  cache_state: "cold" | "warm";
}): string {
  return `${entry.cohort_key}\0${entry.command_key}\0${entry.cache_state}`;
}

function chronicCommandRows(
  aggregates: readonly ChronicCostAggregate[],
  entries: readonly ChronicCostMaterializationEntry[],
): StatsChronicCommand[] {
  const labels = new Map<string, ChronicCostMaterializationEntry>();
  const invalid = new Set<string>();
  for (const entry of entries) {
    const key = chronicLaneKey(entry);
    if (labels.has(key)) {
      labels.delete(key);
      invalid.add(key);
    } else if (!invalid.has(key)) {
      labels.set(key, entry);
    }
  }
  return aggregates.flatMap((aggregate): StatsChronicCommand[] => {
    const key = chronicLaneKey(aggregate);
    const label = labels.get(key);
    if (label === undefined || invalid.has(key)) return [];
    return [{
      command: label.command,
      command_identity: {
        ...label.command_identity,
        normalized_argv: [...label.command_identity.normalized_argv],
      },
      cache_state: aggregate.cache_state,
      history_count: aggregate.history_count,
      presence_count: aggregate.presence_count,
      sample_count: aggregate.distribution.sample_count,
      ratio: aggregate.ratio,
      resource_upper_ms: aggregate.resource_upper_ms,
      median: aggregate.distribution.median,
      p50: aggregate.distribution.p50,
      p75: aggregate.distribution.p75,
      mad: aggregate.distribution.mad,
      cost_ratio: aggregate.ratio,
      estimated_min: Math.round(
        aggregate.resource_upper_ms / 60_000 * 10_000,
      ) / 10_000,
    }];
  });
}

export function summarizeTerminalStats(
  aggregate: TerminalStatsAggregateResult,
  terminalRecords: readonly AnalysisRecord[],
  adoptions: readonly AdoptionRecord[] = [],
  chronicAggregates?: readonly ChronicCostAggregate[],
  chronicEntries: readonly ChronicCostMaterializationEntry[] = [],
): StatsReport {
  const observational = summarizeStats(terminalRecords, adoptions);
  return {
    history_count: aggregate.metadata.distinct_work_unit_count,
    metadata: {
      ...aggregate.metadata,
      reason_codes: [...aggregate.metadata.reason_codes],
    },
    ...(aggregate.terminal_metrics === undefined ? {} : {
      terminal_metrics: { ...aggregate.terminal_metrics },
    }),
    cohorts: aggregate.cohorts.map((cohort) => ({
      cohort_key: cohort.cohort_key,
      metadata: {
        ...cohort.metadata,
        reason_codes: [...cohort.metadata.reason_codes],
      },
      ...(cohort.distributions === undefined ? {} : {
        distributions: cloneCohortDistributions(cohort.distributions),
      }),
    })),
    baseline_metrics: observational.baseline_metrics,
    chronic_commands: chronicAggregates === undefined
      ? observational.chronic_commands
      : chronicCommandRows(chronicAggregates, chronicEntries),
    rule_minutes: aggregate.rule_minutes.map((entry) => ({ ...entry })),
    recurring_findings: observational.recurring_findings,
    adoptions: observational.adoptions,
    adoption_coverage: observational.adoption_coverage,
  };
}

export function renderStatsJson(stats: StatsReport): string {
  const stable: StatsReport = {
    history_count: stats.history_count,
    ...(stats.metadata === undefined ? {} : { metadata: {
      ...stats.metadata,
      reason_codes: [...stats.metadata.reason_codes],
    } }),
    ...(stats.terminal_metrics === undefined ? {} : {
      terminal_metrics: { ...stats.terminal_metrics },
    }),
    ...(stats.cohorts === undefined ? {} : {
      cohorts: stats.cohorts.map((cohort) => ({
        ...cohort,
        metadata: {
          ...cohort.metadata,
          reason_codes: [...cohort.metadata.reason_codes],
        },
        ...(cohort.distributions === undefined ? {} : {
          distributions: cloneCohortDistributions(cohort.distributions),
        }),
      })),
    }),
    baseline_metrics: [...stats.baseline_metrics],
    chronic_commands: stats.chronic_commands.map((entry) => ({
      ...entry,
      ...(entry.command_identity === undefined ? {} : { command_identity: {
        ...entry.command_identity,
        normalized_argv: [...entry.command_identity.normalized_argv],
      } }),
    })),
    rule_minutes: [...stats.rule_minutes],
    recurring_findings: [...stats.recurring_findings],
    adoptions: [...stats.adoptions],
    adoption_coverage: { ...stats.adoption_coverage },
  };
  return `${JSON.stringify(stable, null, 2)}\n`;
}

function oneLine(value: string): string {
  return sanitizeHumanText(value)
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function adoptionStatusText(entry: StatsAdoption): string {
  if (entry.status === "no_data") return "no data yet";
  if (entry.status === "recurred") {
    return `recurred in ${entry.recurrences_after}/${entry.analyses_after} analyses`;
  }
  return `no recurrence in ${entry.analyses_after} analyses`;
}

function adoptionLine(entry: StatsAdoption): string {
  return `- [${entry.rule_id}] adopted ${utcDate(entry.detected_at_ms)} (${entry.method}): ${
    adoptionStatusText(entry)
  }, ${formatMinutes(entry.minutes_before)} -> ${formatMinutes(entry.minutes_after)}`;
}

function chronicCommandLabel(entry: StatsChronicCommand): string {
  const identity = entry.command_identity;
  return identity === undefined
    ? entry.command
    : formatCommandIdentityTarget(identity, entry.command) +
      (identity.executor === "native-tool" ? " [native-tool]" : "");
}

function chronicCommandDetail(entry: StatsChronicCommand): string {
  if (
    entry.cache_state !== undefined &&
    entry.history_count !== undefined &&
    entry.sample_count !== undefined &&
    entry.ratio !== undefined &&
    entry.resource_upper_ms !== undefined &&
    entry.median !== undefined &&
    entry.p50 !== undefined &&
    entry.p75 !== undefined &&
    entry.mad !== undefined
  ) {
    return `${entry.cache_state}, ${entry.presence_count}/${entry.history_count}, ${
      rounded(entry.ratio * 100)
    }%, ${entry.resource_upper_ms} ms avg upper, median ${entry.median}, p50 ${
      entry.p50
    }, p75 ${entry.p75}, MAD ${entry.mad}`;
  }
  return `${formatMinutes(entry.estimated_min)} avg upper (${rounded(
    entry.cost_ratio * 100,
  )}%, ${entry.presence_count} analyses)`;
}

const TERMINAL_METRIC_LABELS = [
  ["confirmed_critical_path_ms", "Confirmed critical path"],
  ["estimated_critical_path_upper_ms", "Estimated critical-path upper"],
  ["resource_cost_ms", "Resource cost"],
  ["human_wait_ms", "Human wait"],
  ["unexplained_ms", "Unexplained"],
] as const;

function terminalMetricLines(stats: StatsReport): string[] {
  if (stats.metadata === undefined) return [];
  const population = stats.metadata;
  const status = `suppressed (${population.sample_count}/${
    population.minimum_cohort_size
  } comparable samples)`;
  const metricLines = stats.terminal_metrics === undefined
    ? [`Terminal metrics: ${status}`]
    : [
        "Terminal metrics:",
        ...TERMINAL_METRIC_LABELS.map(([axis, label]) =>
          `- ${label}: ${formatMinutes(stats.terminal_metrics![axis] / 60_000)}`),
      ];
  const cohortLines = stats.cohorts === undefined || stats.cohorts.length === 0
    ? []
    : [
        "Comparable cohort distributions:",
        ...stats.cohorts.flatMap((cohort, index) => {
          if (cohort.distributions === undefined) {
            return [`- Cohort ${index + 1}: suppressed (${
              cohort.metadata.sample_count
            }/${cohort.metadata.minimum_cohort_size} comparable samples)`];
          }
          return [
            `- Cohort ${index + 1}:`,
            ...TERMINAL_METRIC_LABELS.map(([axis, label]) => {
              const distribution = cohort.distributions![axis];
              return `  ${label}: median ${distribution.median} ms, p50 ${
                distribution.p50
              }, p75 ${distribution.p75}, MAD ${distribution.mad}, samples ${
                distribution.sample_count
              }`;
            }),
          ];
        }),
      ];
  return [
    ...(population.privacy_profile === undefined ? [] : [
      `Privacy: ${population.privacy_profile} (${population.projection})`,
    ]),
    ...metricLines,
    ...cohortLines,
  ];
}

export function renderStatsTty(stats: StatsReport): string {
  const terminalStats = stats.metadata !== undefined;
  const lines = [
    `History: ${stats.history_count} ${
      terminalStats ? "terminal work units" : "analyses"
    }`,
    ...terminalMetricLines(stats),
    terminalStats
      ? "Confirmed critical-path minutes by rule:"
      : "Aggregate rule minutes:",
    ...(stats.rule_minutes.length === 0
      ? ["- none"]
      : stats.rule_minutes.map(
          (rule) => `- ${rule.rule_id}: ${formatMinutes(rule.minutes)}`,
        )),
    "Recurring findings:",
    ...(stats.recurring_findings.length === 0
      ? ["- none"]
      : [
          ...stats.recurring_findings
            .slice(0, STATS_RECURRING_TTY_LIMIT)
            .map(
              (entry) =>
                `- [${entry.rule_id}] ${formatMinutes(entry.first_min)} -> ${formatMinutes(entry.last_min)} (${entry.trend}, seen ${entry.occurrence_count}x) ${oneLine(entry.title)}`,
            ),
          ...(stats.recurring_findings.length > STATS_RECURRING_TTY_LIMIT
            ? [
                `- … and ${stats.recurring_findings.length - STATS_RECURRING_TTY_LIMIT} more`,
              ]
            : []),
        ]),
    "Adopted suggestions:",
    ...(stats.adoptions.length === 0
      ? ["- none"]
      : [
          ...stats.adoptions.map(adoptionLine),
          "  (observational only: recurrence absence does not prove causation)",
        ]),
    `Adoption coverage: ${stats.adoption_coverage.detectable} findings detectable, ${stats.adoption_coverage.undetectable} undetectable (not tracked)`,
    "Chronic commands:",
    ...(stats.chronic_commands.length === 0
      ? ["- none"]
      : stats.chronic_commands.map(
          (command) =>
            `- ${oneLine(chronicCommandLabel(command))}: ${chronicCommandDetail(command)}`,
        )),
    "Baseline metrics:",
    ...(stats.baseline_metrics.length === 0
      ? ["- unavailable"]
      : stats.baseline_metrics.map(
          (metric) =>
            `- ${oneLine(metric.metric)}: ${metric.value} vs ${metric.baseline}`,
        )),
  ];
  return `${lines.join("\n")}\n`;
}
