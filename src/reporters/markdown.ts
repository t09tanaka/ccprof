import type { Finding, ReportV2 } from "../core/model.js";
import { sanitizeHumanText } from "./sanitize.js";
import { formatMinutes } from "./tty.js";

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

function markdownText(value: string): string {
  return sanitizeHumanText(value)
    .replace(ANSI_PATTERN, "")
    .replace(/[\r\n]+/gu, " ")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`")
    .trim();
}

function findingMarkdown(
  finding: Finding,
  index: number,
): string[] {
  const command = finding.evidence.command;
  return [
    `${index + 1}. **[${finding.rule_id}] ${markdownText(finding.title)}** — ${formatMinutes(finding.recoverable.min)} (${finding.recoverable.bound})`,
    `   - Suggestion: ${markdownText(finding.fix_recipe.suggestion)}`,
    `   - Verify: ${markdownText(finding.fix_recipe.verify)}`,
    ...(typeof command === "string" && command.trim() !== ""
      ? [`   - Evidence command: ${markdownText(command)}`]
      : []),
  ];
}

export function renderMarkdownReport(report: ReportV2): string {
  const lines = [
    "## ccprof",
    "",
    `**Conclusion:** ${formatMinutes(report.summary.recoverable_min)} point-recoverable from ${formatMinutes(report.summary.measured_min)} measured; estimated floor ${formatMinutes(report.summary.estimated_floor_min)}.`,
    "",
    "| Metric | Minutes |",
    "| --- | ---: |",
    `| Measured | ${report.summary.measured_min} |`,
    `| Idle excluded | ${report.summary.idle_excluded_min} |`,
    `| Point recoverable | ${report.summary.recoverable_min} |`,
    `| Estimated floor | ${report.summary.estimated_floor_min} |`,
    `| Human wait | ${report.summary.human_wait_min} |`,
    `| Unexplained | ${report.summary.unexplained_min} |`,
    "",
    "### Findings",
    "",
  ];
  const findings = report.findings.slice(0, 3);
  if (findings.length === 0) {
    lines.push("No actionable findings.");
  } else {
    findings.forEach((finding, index) => {
      lines.push(...findingMarkdown(finding, index));
    });
  }
  if (report.caveats.length > 0) {
    lines.push(
      "",
      "### Caveats",
      "",
      ...report.caveats.map((caveat) => `- ${markdownText(caveat)}`),
    );
  }
  return `${lines.join("\n")}\n`;
}
