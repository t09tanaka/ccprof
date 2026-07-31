import type { ReportV2 } from "../core/model.js";

function reportForDisplay(report: ReportV2): ReportV2 {
  return {
    version: 2,
    unit: {
      repo: report.unit.repo,
      pr_ref: report.unit.pr_ref,
      sessions: [...report.unit.sessions],
    },
    summary: {
      measured_min: report.summary.measured_min,
      idle_excluded_min: report.summary.idle_excluded_min,
      estimated_floor_min: report.summary.estimated_floor_min,
      recoverable_min: report.summary.recoverable_min,
      unexplained_min: report.summary.unexplained_min,
      baseline: report.summary.baseline,
    },
    findings: report.findings.slice(0, 3),
    caveats: [...report.caveats],
  };
}

export function renderJsonReport(report: ReportV2): string {
  return `${JSON.stringify(reportForDisplay(report), null, 2)}\n`;
}
