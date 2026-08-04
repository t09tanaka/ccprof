import { types as utilTypes } from "node:util";

import type { AdvisoryText } from "../advisory/advisory.js";
import {
  findingScoringRationale,
  findingSeverity,
  projectFindingConfidence,
  projectFindingRecoverable,
  snapshotFindingConfidence,
  snapshotImpactEstimate,
} from "../core/model.js";
import type {
  Finding,
  FindingConfidence,
  FindingScoringRationale,
  ImpactEstimate,
  ReportV2,
} from "../core/model.js";
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

const DISPLAY_CANONICAL_FIELDS = [
  "impact",
  "finding_confidence",
  "severity",
  "scoring_rationale",
] as const;

function displayDataValue(
  descriptor: PropertyDescriptor | undefined,
): unknown {
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !("value" in descriptor)
  ) throw new TypeError();
  return descriptor.value;
}

function snapshotDisplayRationale(value: unknown): FindingScoringRationale[] {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) throw new TypeError();
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    ownKeys.length !== lengthDescriptor.value + 1
  ) throw new TypeError();
  const snapshot: FindingScoringRationale[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const entry = displayDataValue(
      Object.getOwnPropertyDescriptor(value, String(index)),
    );
    if (typeof entry !== "string") throw new TypeError();
    snapshot.push(entry as FindingScoringRationale);
  }
  return snapshot;
}

function exactRationale(
  actual: readonly FindingScoringRationale[],
  expected: readonly FindingScoringRationale[],
): boolean {
  return actual.length === expected.length &&
    actual.every((entry, index) => entry === expected[index]);
}

function validLegacyProjection(
  impact: ImpactEstimate,
  confidence: FindingConfidence,
): boolean {
  return impact.lower_ms === 0 &&
    !("expected_ms" in impact) &&
    ((confidence.evidence === "low" &&
      confidence.causal === "low" &&
      confidence.source_completeness === 0) ||
      ((confidence.evidence === "medium" || confidence.evidence === "high") &&
        confidence.causal === "medium" &&
        confidence.source_completeness === 0.5));
}

export function findingForDisplay(finding: Finding): Finding {
  try {
    if (
      finding === null ||
      typeof finding !== "object" ||
      Array.isArray(finding) ||
      utilTypes.isProxy(finding) ||
      Object.getPrototypeOf(finding) !== Object.prototype
    ) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(finding);
    const presentCanonicalFields = DISPLAY_CANONICAL_FIELDS.filter(
      (field) => descriptors[field] !== undefined,
    );
    if (
      presentCanonicalFields.length !== 0 &&
      presentCanonicalFields.length !== DISPLAY_CANONICAL_FIELDS.length
    ) throw new TypeError();

    if (presentCanonicalFields.length === 0) {
      const impact: ImpactEstimate = {
        lower_ms: 0,
        upper_ms: finding.recoverable.min * 60_000,
        kind: finding.rule_id === "R005" || finding.rule_id === "R006"
          ? "resource_cost"
          : "critical_path_latency",
      };
      const confidence: FindingConfidence = finding.confidence === "low"
        ? { evidence: "low", causal: "low", source_completeness: 0 }
        : {
          evidence: finding.confidence,
          causal: "medium",
          source_completeness: 0.5,
        };
      return {
        ...finding,
        confidence: projectFindingConfidence(confidence),
        impact,
        finding_confidence: confidence,
        severity: findingSeverity(impact, confidence),
        scoring_rationale: findingScoringRationale(impact, confidence, {
          ...(finding.rule_id === "R004" ? { policy_dependent: true } : {}),
          legacy_projection: true,
        }),
        recoverable: projectFindingRecoverable(impact),
      };
    }

    const impact = snapshotImpactEstimate(
      displayDataValue(descriptors.impact),
    );
    const confidence = snapshotFindingConfidence(
      displayDataValue(descriptors.finding_confidence),
    );
    const severity = findingSeverity(impact, confidence);
    if (displayDataValue(descriptors.severity) !== severity) {
      throw new TypeError();
    }
    const rationale = snapshotDisplayRationale(
      displayDataValue(descriptors.scoring_rationale),
    );
    const legacyProjection = rationale.includes("legacy_projection");
    const expectedRationale = findingScoringRationale(impact, confidence, {
      ...(finding.rule_id === "R004" ? { policy_dependent: true } : {}),
      ...(legacyProjection ? { legacy_projection: true } : {}),
    });
    if (
      !exactRationale(rationale, expectedRationale) ||
      (legacyProjection && !validLegacyProjection(impact, confidence))
    ) throw new TypeError();
    return {
      ...finding,
      confidence: projectFindingConfidence(confidence),
      impact,
      finding_confidence: confidence,
      severity,
      scoring_rationale: rationale,
      recoverable: projectFindingRecoverable(impact),
    };
  } catch {
    throw new TypeError("invalid finding");
  }
}

export function formatFindingImpact(finding: Finding): string {
  const impact = findingForDisplay(finding).impact as ImpactEstimate;
  const expected = impact.expected_ms === undefined
    ? ""
    : `expected ${formatMinutes(impact.expected_ms / 60_000)}; `;
  const kind = impact.kind === "critical_path_latency"
    ? "critical path"
    : "resource cost";
  return `${formatMinutes(impact.lower_ms / 60_000)}–${
    formatMinutes(impact.upper_ms / 60_000)
  } (${expected}${kind})`;
}

function findingLine(
  finding: Finding,
  index: number,
  color: boolean,
): string {
  const displayed = findingForDisplay(finding);
  const confidence = displayed.finding_confidence as FindingConfidence;
  const rule = paint(`[${displayed.rule_id}]`, 36, color);
  const rationale = displayed.scoring_rationale?.join(",") || "none";
  return `${index + 1}. ${rule} Impact ${formatFindingImpact(displayed)}; severity ${displayed.severity}; confidence evidence=${confidence.evidence} causal=${confidence.causal} completeness=${confidence.source_completeness}; rationale ${rationale} — ${plainLine(displayed.title)}`;
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

export function analysisBudgetLine(report: ReportV2): string | null {
  const budget = report.analysis_budget;
  if (budget === undefined) return null;
  const coverage = Math.round(budget.coverage * 10_000) / 100;
  const reason = budget.truncation_reason === undefined
    ? ""
    : ` — ${budget.truncation_reason}`;
  return `Analysis budget: ${budget.completeness}${reason} (${coverage}% coverage).`;
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
  const budgetSummary = analysisBudgetLine(report);
  if (budgetSummary !== null) lines.push(budgetSummary);
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
