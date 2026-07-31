import type {
  BaselineNotable,
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

export interface StatsReport {
  history_count: number;
  baseline_metrics: StatsBaselineMetric[];
  chronic_commands: StatsChronicCommand[];
  rule_minutes: StatsRuleMinutes[];
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
  };
}

export function renderStatsJson(stats: StatsReport): string {
  const stable: StatsReport = {
    history_count: stats.history_count,
    baseline_metrics: [...stats.baseline_metrics],
    chronic_commands: [...stats.chronic_commands],
    rule_minutes: [...stats.rule_minutes],
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
