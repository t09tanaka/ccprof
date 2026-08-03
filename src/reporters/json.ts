import type { AdvisoryText } from "../advisory/advisory.js";
import type { ReportV2 } from "../core/model.js";

export interface JsonReportOptions {
  advisory?: AdvisoryText;
}

/**
 * Display-only shape: `advisory` extends the rendered JSON, never
 * `ReportV2` itself, so the store and baselines cannot carry LLM output.
 * The field is omitted entirely without `--advisory`, keeping existing
 * output byte-identical (same additive-optional stance as
 * `skipped_rules`).
 */
type DisplayReport = ReportV2 & { advisory?: AdvisoryText };

function reportForDisplay(
  report: ReportV2,
  advisory?: AdvisoryText,
): DisplayReport {
  return {
    version: 2,
    unit: {
      repo: report.unit.repo,
      pr_ref: report.unit.pr_ref,
      sessions: [...report.unit.sessions],
    },
    ...(report.sources === undefined
      ? {}
      : {
        sources: report.sources.map((source) => ({
          adapter_id: source.adapter_id,
          adapter_version: source.adapter_version,
          source_instance_id: source.source_instance_id,
          source_kind: source.source_kind,
          provided_capabilities: [...source.provided_capabilities],
          required_capabilities: [...source.required_capabilities],
          provenance: source.provenance,
          sensitivity: source.sensitivity,
          retention_class: source.retention_class,
          canonical_fingerprint: source.canonical_fingerprint,
        })),
      }),
    summary: {
      measured_min: report.summary.measured_min,
      idle_excluded_min: report.summary.idle_excluded_min,
      estimated_floor_min: report.summary.estimated_floor_min,
      recoverable_min: report.summary.recoverable_min,
      human_wait_min: report.summary.human_wait_min,
      unexplained_min: report.summary.unexplained_min,
      baseline: report.summary.baseline,
    },
    findings: report.findings.slice(0, 3),
    caveats: [...report.caveats],
    ...(report.rule_coverage === undefined
      ? {}
      : {
        rule_coverage: report.rule_coverage.map((entry) => ({
          rule_id: entry.rule_id,
          eligible_sessions: entry.eligible_sessions,
          total_sessions: entry.total_sessions,
          status: entry.status,
          missing_capabilities: [...entry.missing_capabilities],
          completeness: entry.completeness,
          truncated: entry.truncated,
        })),
      }),
    ...(report.skipped_rules === undefined
      ? {}
      : {
        skipped_rules: report.skipped_rules.map((skipped) => ({
          rule_id: skipped.rule_id,
          missing: [...skipped.missing],
        })),
      }),
    ...(advisory === undefined
      ? {}
      : { advisory: { source: advisory.source, text: advisory.text } }),
  };
}

export function renderJsonReport(
  report: ReportV2,
  options: JsonReportOptions = {},
): string {
  return `${
    JSON.stringify(reportForDisplay(report, options.advisory), null, 2)
  }\n`;
}
