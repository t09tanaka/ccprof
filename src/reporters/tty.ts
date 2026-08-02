import type { Finding, ReportV2 } from "../core/model.js";
import { sanitizeHumanText } from "./sanitize.js";

export const TTY_MAX_LINES = 18;

export interface TtyReportOptions {
  color?: boolean;
}

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

function plainLine(value: string): string {
  return sanitizeHumanText(value)
    .replace(ANSI_PATTERN, "")
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function paint(
  value: string,
  code: number,
  enabled: boolean,
): string {
  return enabled ? `\u001B[${code}m${value}\u001B[0m` : value;
}

function rounded(value: number, digits = 2): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function formatMinutes(value: number): string {
  const minutes = rounded(value);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = rounded(minutes - hours * 60);
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

function findingLine(
  finding: Finding,
  index: number,
  color: boolean,
): string {
  const rule = paint(`[${finding.rule_id}]`, 36, color);
  const bound = finding.recoverable.bound === "upper" ? " upper" : "";
  return `${index + 1}. ${rule} ${formatMinutes(finding.recoverable.min)}${bound} — ${plainLine(finding.title)}`;
}

function recipeLine(finding: Finding): string {
  return `   Fix: ${plainLine(finding.fix_recipe.suggestion)} Verify: ${plainLine(finding.fix_recipe.verify)}`;
}

export function skippedRulesLine(report: ReportV2): string | null {
  const skipped = report.skipped_rules ?? [];
  if (skipped.length === 0) return null;
  const detail = skipped
    .map((entry) => `${entry.rule_id} (${entry.missing.join(", ")})`)
    .join(", ");
  return `Skipped rules (source lacks required data): ${detail}`;
}

function caveatLines(report: ReportV2): string[] {
  const caveats = [
    ...report.caveats,
    ...report.findings.slice(0, 3).flatMap((finding) => finding.caveats),
  ].map(plainLine).filter((value) => value !== "");
  const unique = [...new Set(caveats)];
  if (unique.length <= 3) return unique.map((value) => `- ${value}`);
  return [
    ...unique.slice(0, 2).map((value) => `- ${value}`),
    `- … and ${unique.length - 2} more`,
  ];
}

export function renderTtyReport(
  report: ReportV2,
  options: TtyReportOptions = {},
): string {
  const color = options.color === true;
  const timing =
    `${formatMinutes(report.summary.measured_min)} measured (${formatMinutes(report.summary.idle_excluded_min)} idle excluded); estimated floor ${formatMinutes(report.summary.estimated_floor_min)}; ${formatMinutes(report.summary.human_wait_min)} human wait; ${formatMinutes(report.summary.unexplained_min)} unexplained.`;
  const conclusion = report.summary.recoverable_min > 0
    ? `ccprof: ${formatMinutes(report.summary.recoverable_min)} recoverable from ${timing}`
    : `ccprof: no point-recoverable time found in ${timing}`;
  const lines = [
    paint(conclusion, report.summary.recoverable_min > 0 ? 33 : 32, color),
  ];
  const findings = report.findings.slice(0, 3);
  if (findings.length === 0) {
    lines.push("No actionable findings.");
  } else {
    for (const [index, finding] of findings.entries()) {
      lines.push(findingLine(finding, index, color), recipeLine(finding));
    }
  }
  const baseline = report.summary.baseline;
  if (baseline !== null) {
    lines.push(
      `Baseline: ${baseline.prs} prior analyses; ${baseline.notable.length} comparable metrics.`,
    );
  }
  const skippedLine = skippedRulesLine(report);
  if (skippedLine !== null) {
    lines.push(skippedLine);
  }
  const caveats = caveatLines(report);
  if (caveats.length > 0) {
    lines.push("Caveats:", ...caveats);
  }
  return `${lines.slice(0, TTY_MAX_LINES).join("\n")}\n`;
}
