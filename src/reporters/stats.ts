import type {
  BaselineNotable,
  Bound,
  RuleId,
} from "../core/model.js";
import { detectChronicCost } from "../rules/chronic-cost.js";
import type { AnalysisRecord } from "../store/analyses.js";
import { sanitizeHumanText } from "./sanitize.js";
import { formatMinutes } from "./tty.js";

export interface StatsBaselineMetric extends BaselineNotable {}

export interface StatsChronicCommand {
  command: string;
  presence_count: number;
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

export interface StatsReport {
  history_count: number;
  baseline_metrics: StatsBaselineMetric[];
  chronic_commands: StatsChronicCommand[];
  rule_minutes: StatsRuleMinutes[];
  recurring_findings: StatsRecurringFinding[];
}

function rounded(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function numberEvidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

export function summarizeStats(
  records: readonly AnalysisRecord[],
): StatsReport {
  const ordered = [...records].sort(recordOrder);
  const latest = ordered.at(-1);
  const baselineMetrics = latest?.summary.baseline?.notable ?? [];
  const chronicCommands = detectChronicCost(ordered)
    .map((finding) => ({
      command: finding.target,
      presence_count: numberEvidence(finding.evidence.presence_count),
      cost_ratio: numberEvidence(finding.evidence.cost_ratio),
      estimated_min: rounded(
        finding.recoverable.estimated_ms / 60_000,
      ),
    }))
    .sort((left, right) => left.command.localeCompare(right.command));
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
  };
}

export function renderStatsJson(stats: StatsReport): string {
  const stable: StatsReport = {
    history_count: stats.history_count,
    baseline_metrics: [...stats.baseline_metrics],
    chronic_commands: [...stats.chronic_commands],
    rule_minutes: [...stats.rule_minutes],
    recurring_findings: [...stats.recurring_findings],
  };
  return `${JSON.stringify(stable, null, 2)}\n`;
}

function oneLine(value: string): string {
  return sanitizeHumanText(value)
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function renderStatsTty(stats: StatsReport): string {
  const lines = [
    `History: ${stats.history_count} analyses`,
    "Aggregate rule minutes:",
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
    "Chronic commands:",
    ...(stats.chronic_commands.length === 0
      ? ["- none"]
      : stats.chronic_commands.map(
          (command) =>
            `- ${oneLine(command.command)}: ${formatMinutes(command.estimated_min)} avg upper (${rounded(command.cost_ratio * 100)}%, ${command.presence_count} analyses)`,
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
