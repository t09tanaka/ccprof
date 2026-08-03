import type { AdvisoryText } from "../advisory/advisory.js";
import type { Finding, ReportV2 } from "../core/model.js";
import { sanitizeHumanText } from "./sanitize.js";

export const TTY_MAX_LINES = 18;

export interface TtyReportOptions {
  color?: boolean;
  advisory?: AdvisoryText;
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
  if (report.rule_coverage !== undefined && report.rule_coverage.length > 0) {
    const detail = [...report.rule_coverage]
      .sort((left, right) => left.rule_id.localeCompare(right.rule_id))
      .map((entry) => {
        const qualifiers = [
          ...(entry.missing_capabilities.length === 0
            ? []
            : [`missing ${entry.missing_capabilities.join(", ")}`]),
          ...(entry.truncated ? ["truncated"] : []),
        ];
        return `${entry.rule_id} ${entry.eligible_sessions}/${entry.total_sessions} ${entry.status}${
          qualifiers.length === 0 ? "" : ` (${qualifiers.join("; ")})`
        }`;
      })
      .join(", ");
    return `Rule coverage: ${detail}.`;
  }
  const skipped = report.skipped_rules ?? [];
  if (skipped.length === 0) return null;
  const detail = skipped
    .map((entry) => `${entry.rule_id} (${entry.missing.join(", ")})`)
    .join(", ");
  return `Skipped rules (source lacks required data): ${detail}`;
}

export function sourcesLine(report: ReportV2): string | null {
  if (report.sources === undefined || report.sources.length === 0) return null;
  const counts = new Map<string, number>();
  for (const source of report.sources) {
    const key = `${source.adapter_id}@${source.adapter_version}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const detail = [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key} (${count})`)
    .join(", ");
  return `Sources: ${detail}.`;
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
  const sourceSummary = sourcesLine(report);
  if (sourceSummary !== null) lines.push(sourceSummary);
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
  const output = lines.slice(0, TTY_MAX_LINES);
  // The advisory section is appended after the deterministic report is
  // capped, so it can never displace a deterministic line and always
  // renders as a clearly separated trailer.
  const advisory = options.advisory;
  if (advisory !== undefined) {
    output.push(
      "Advisory (LLM, opt-in — non-deterministic):",
      ...advisory.text
        .split(/\r?\n/u)
        .map(plainLine)
        .filter((value) => value !== ""),
    );
  }
  return `${output.join("\n")}\n`;
}
