import type { AdvisoryText } from "../advisory/advisory.js";
import type { Finding, ReportV2 } from "../core/model.js";
import { sanitizeHumanText } from "./sanitize.js";
import {
  analysisBudgetLine,
  findingForDisplay,
  formatFindingImpact,
  formatMinutes,
  skippedRulesLine,
  sourcesLine,
} from "./tty.js";

export interface MarkdownReportOptions {
  advisory?: AdvisoryText;
}

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

// Advisory lines come from LLM output and are inserted as top-level
// Markdown lines, so a leading "#", ">", or list marker would otherwise
// become real document structure instead of text.
function escapeLeadingMarkdown(value: string): string {
  return value
    .replace(/^([#>*+-])/u, "\\$1")
    .replace(/^(\d+)([.)])/u, "$1\\$2");
}

function findingMarkdown(
  finding: Finding,
  index: number,
): string[] {
  const displayed = findingForDisplay(finding);
  const command = displayed.evidence.command;
  const confidence = displayed.finding_confidence;
  return [
    `${index + 1}. **[${displayed.rule_id}] ${markdownText(displayed.title)}**`,
    `   - Impact: ${formatFindingImpact(displayed)}`,
    `   - Severity: ${displayed.severity}`,
    `   - Confidence: evidence=${confidence?.evidence}; causal=${confidence?.causal}; completeness=${confidence?.source_completeness}`,
    `   - Rationale: ${displayed.scoring_rationale?.join(", ") || "none"}`,
    `   - Finding key: ${markdownText(displayed.finding_key)}`,
    `   - Suggestion: ${markdownText(displayed.fix_recipe.suggestion)}`,
    `   - Verify: ${markdownText(displayed.fix_recipe.verify)}`,
    ...(typeof command === "string" && command.trim() !== ""
      ? [`   - Evidence command: ${markdownText(command)}`]
      : []),
  ];
}

export function renderMarkdownReport(
  report: ReportV2,
  options: MarkdownReportOptions = {},
): string {
  const lines = [
    "## ccprof",
    "",
    `**Conclusion:** ${formatMinutes(report.summary.recoverable_min)} point-recoverable from ${formatMinutes(report.summary.measured_min)} measured; estimated floor ${formatMinutes(report.summary.estimated_floor_min)}.`,
    ...(analysisBudgetLine(report) === null
      ? []
      : [analysisBudgetLine(report) as string]),
    ...(sourcesLine(report) === null
      ? []
      : [`**${sourcesLine(report)?.replace(/^Sources: /u, "Sources:** ")}`]),
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
  const skippedLine = skippedRulesLine(report);
  if (skippedLine !== null) {
    lines.push("", skippedLine);
  }
  if (report.caveats.length > 0) {
    lines.push(
      "",
      "### Caveats",
      "",
      ...report.caveats.map((caveat) => `- ${markdownText(caveat)}`),
    );
  }
  const advisory = options.advisory;
  if (advisory !== undefined) {
    lines.push(
      "",
      "## Advisory (LLM)",
      "",
      "_This section is opt-in LLM output and is separate from the deterministic findings above._",
      "",
      ...advisory.text
        .split(/\r?\n/u)
        .map((value) => escapeLeadingMarkdown(markdownText(value)))
        .filter((value) => value !== ""),
    );
  }
  return `${lines.join("\n")}\n`;
}
