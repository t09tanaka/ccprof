import { types as utilTypes } from "node:util";

import type { AdvisoryText } from "../advisory/advisory.js";
import {
  findingCompatibilityMetadata,
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
  FindingEvidence,
  FindingScoringRationale,
  ImpactEstimate,
  JsonValue,
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

const DISPLAY_REQUIRED_FIELDS = [
  "finding_key",
  "rule_id",
  "title",
  "classification",
  "cause",
  "scope",
  "confidence",
  "evidence",
  "fix_recipe",
  "caveats",
  "recoverable",
] as const;

const DISPLAY_OPTIONAL_FIELDS = [
  "target",
  ...DISPLAY_CANONICAL_FIELDS,
  "rule_version",
  "compatibility_epoch",
] as const;

const DISPLAY_FINDING_FIELDS = new Set<string>([
  ...DISPLAY_REQUIRED_FIELDS,
  ...DISPLAY_OPTIONAL_FIELDS,
]);
const DISPLAY_RULE_IDS = new Set([
  "R001",
  "R002",
  "R003",
  "R004",
  "R005",
  "R006",
  "R007",
  "R008",
]);
const DISPLAY_CLASSIFICATIONS = new Set(["repo", "config", "behavior"]);
const DISPLAY_SCOPES = new Set(["this_pr", "separate_issue", "claude_md"]);
const DISPLAY_CONFIDENCES = new Set(["low", "medium", "high"]);
const DISPLAY_CAUSES = new Set([
  "ambiguous_task",
  "requirements_changed",
  "missing_context",
  "scope_creep",
  "tool_failure",
  "unknown",
]);

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

function displayObjectDescriptors(
  value: unknown,
): Record<string, PropertyDescriptor> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new TypeError();
  }
  return descriptors;
}

function exactDisplayObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const descriptors = displayObjectDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => descriptors[key] === undefined)
  ) throw new TypeError();
  return Object.fromEntries(keys.map((key) => {
    if (typeof key !== "string") throw new TypeError();
    return [key, displayDataValue(descriptors[key])];
  }));
}

function snapshotDisplayJson(
  value: unknown,
  active = new WeakSet<object>(),
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  ) return value;
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError();
  }
  if (active.has(value)) throw new TypeError();
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError();
      }
      const ownKeys = Reflect.ownKeys(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        ownKeys.length !== lengthDescriptor.value + 1
      ) throw new TypeError();
      const snapshot: JsonValue[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        snapshot.push(snapshotDisplayJson(displayDataValue(
          Object.getOwnPropertyDescriptor(value, String(index)),
        ), active));
      }
      return snapshot;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError();
    }
    const entries: Array<[string, JsonValue]> = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError();
      entries.push([
        key,
        snapshotDisplayJson(displayDataValue(
          Object.getOwnPropertyDescriptor(value, key),
        ), active),
      ]);
    }
    return Object.fromEntries(entries);
  } finally {
    active.delete(value);
  }
}

function snapshotDisplayStringArray(value: unknown): string[] {
  const snapshot = snapshotDisplayJson(value);
  if (
    !Array.isArray(snapshot) ||
    snapshot.some((entry) => typeof entry !== "string")
  ) throw new TypeError();
  return snapshot as string[];
}

function snapshotDisplayEvidence(value: unknown): FindingEvidence {
  const snapshot = snapshotDisplayJson(value);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    !Array.isArray(snapshot.session_refs) ||
    snapshot.session_refs.some((entry) => typeof entry !== "string") ||
    !Array.isArray(snapshot.interval_ids) ||
    snapshot.interval_ids.some((entry) => typeof entry !== "string")
  ) throw new TypeError();
  return snapshot as FindingEvidence;
}

function snapshotDisplayBaseFinding(
  descriptors: Record<string, PropertyDescriptor>,
): Finding {
  const read = (field: (typeof DISPLAY_REQUIRED_FIELDS)[number]): unknown =>
    displayDataValue(descriptors[field]);
  const findingKey = read("finding_key");
  const ruleId = read("rule_id");
  const title = read("title");
  const classification = read("classification");
  const cause = read("cause");
  const scope = read("scope");
  const confidence = read("confidence");
  if (
    typeof findingKey !== "string" ||
    typeof ruleId !== "string" ||
    !DISPLAY_RULE_IDS.has(ruleId) ||
    typeof title !== "string" ||
    typeof classification !== "string" ||
    !DISPLAY_CLASSIFICATIONS.has(classification) ||
    (cause !== null &&
      (typeof cause !== "string" || !DISPLAY_CAUSES.has(cause))) ||
    typeof scope !== "string" ||
    !DISPLAY_SCOPES.has(scope) ||
    typeof confidence !== "string" ||
    !DISPLAY_CONFIDENCES.has(confidence)
  ) throw new TypeError();

  const recoverable = exactDisplayObject(read("recoverable"), ["min", "bound"]);
  if (
    typeof recoverable.min !== "number" ||
    !Number.isFinite(recoverable.min) ||
    recoverable.min < 0 ||
    Object.is(recoverable.min, -0) ||
    (recoverable.bound !== "point" && recoverable.bound !== "upper")
  ) throw new TypeError();
  const recipe = exactDisplayObject(read("fix_recipe"), ["suggestion", "verify"]);
  if (
    typeof recipe.suggestion !== "string" ||
    typeof recipe.verify !== "string"
  ) throw new TypeError();

  const target = descriptors.target === undefined
    ? undefined
    : displayDataValue(descriptors.target);
  if (target !== undefined && typeof target !== "string") {
    throw new TypeError();
  }

  const compatibilitySource: Record<string, unknown> = {};
  const versionDescriptor = descriptors.rule_version;
  const epochDescriptor = descriptors.compatibility_epoch;
  if (
    versionDescriptor !== undefined &&
    epochDescriptor !== undefined &&
    versionDescriptor.enumerable === true &&
    epochDescriptor.enumerable === true &&
    "value" in versionDescriptor &&
    "value" in epochDescriptor
  ) {
    Object.defineProperties(compatibilitySource, {
      rule_version: { enumerable: true, value: versionDescriptor.value },
      compatibility_epoch: { enumerable: true, value: epochDescriptor.value },
    });
  }
  const compatibility = findingCompatibilityMetadata(compatibilitySource);

  return {
    finding_key: findingKey,
    rule_id: ruleId as Finding["rule_id"],
    ...(compatibility.valid && compatibility.metadata !== undefined
      ? compatibility.metadata
      : {}),
    title,
    ...(target === undefined ? {} : { target }),
    classification: classification as Finding["classification"],
    cause: cause as Finding["cause"],
    scope: scope as Finding["scope"],
    confidence: confidence as Finding["confidence"],
    evidence: snapshotDisplayEvidence(read("evidence")),
    recoverable: {
      min: recoverable.min,
      bound: recoverable.bound,
    } as Finding["recoverable"],
    fix_recipe: {
      suggestion: recipe.suggestion,
      verify: recipe.verify,
    },
    caveats: snapshotDisplayStringArray(read("caveats")),
  };
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

function rebuildDisplayFinding(
  descriptors: Record<string, PropertyDescriptor>,
  base: Finding,
  impact: ImpactEstimate,
  confidence: FindingConfidence,
  rationale: FindingScoringRationale[],
): Finding {
  const projected: Finding = {
    ...base,
    confidence: projectFindingConfidence(confidence),
    impact,
    finding_confidence: confidence,
    severity: findingSeverity(impact, confidence),
    scoring_rationale: rationale,
    recoverable: projectFindingRecoverable(impact),
  };
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new TypeError();
    if (Object.hasOwn(projected, key)) {
      entries.push([key, projected[key as keyof Finding]]);
    }
  }
  for (const field of DISPLAY_CANONICAL_FIELDS) {
    if (descriptors[field] === undefined) {
      entries.push([field, projected[field]]);
    }
  }
  return Object.fromEntries(entries) as unknown as Finding;
}

function validLegacyProjection(
  base: Finding,
  impact: ImpactEstimate,
  confidence: FindingConfidence,
): boolean {
  const expectedKind = base.rule_id === "R005" || base.rule_id === "R006"
    ? "resource_cost"
    : "critical_path_latency";
  const projectedRecoverable = projectFindingRecoverable(impact);
  return impact.kind === expectedKind &&
    impact.lower_ms === 0 &&
    !("expected_ms" in impact) &&
    ((confidence.evidence === "low" &&
      confidence.causal === "low" &&
      confidence.source_completeness === 0) ||
      ((confidence.evidence === "medium" || confidence.evidence === "high") &&
        confidence.causal === "medium" &&
        confidence.source_completeness === 0.5)) &&
    base.confidence === projectFindingConfidence(confidence) &&
    base.recoverable.min === projectedRecoverable.min &&
    base.recoverable.bound === projectedRecoverable.bound;
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
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) =>
        typeof key !== "string" || !DISPLAY_FINDING_FIELDS.has(key)
      ) ||
      DISPLAY_REQUIRED_FIELDS.some((field) => descriptors[field] === undefined)
    ) throw new TypeError();
    const base = snapshotDisplayBaseFinding(descriptors);
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
        upper_ms: base.recoverable.min * 60_000,
        kind: base.rule_id === "R005" || base.rule_id === "R006"
          ? "resource_cost"
          : "critical_path_latency",
      };
      const confidence: FindingConfidence = base.confidence === "low"
        ? { evidence: "low", causal: "low", source_completeness: 0 }
        : {
          evidence: base.confidence,
          causal: "medium",
          source_completeness: 0.5,
        };
      return rebuildDisplayFinding(
        descriptors,
        base,
        impact,
        confidence,
        findingScoringRationale(impact, confidence, {
          ...(base.rule_id === "R004" ? { policy_dependent: true } : {}),
          legacy_projection: true,
        }),
      );
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
      ...(base.rule_id === "R004" ? { policy_dependent: true } : {}),
      ...(legacyProjection ? { legacy_projection: true } : {}),
    });
    if (
      !exactRationale(rationale, expectedRationale) ||
      (legacyProjection &&
        !validLegacyProjection(base, impact, confidence))
    ) throw new TypeError();
    return rebuildDisplayFinding(
      descriptors,
      base,
      impact,
      confidence,
      rationale,
    );
  } catch {
    throw new TypeError("invalid finding");
  }
}

function formatDisplayedFindingImpact(finding: Finding): string {
  const impact = finding.impact as ImpactEstimate;
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

export function formatFindingImpact(finding: Finding): string {
  return formatDisplayedFindingImpact(findingForDisplay(finding));
}

function findingLine(
  finding: Finding,
  index: number,
  color: boolean,
): string {
  const confidence = finding.finding_confidence as FindingConfidence;
  const rule = paint(`[${finding.rule_id}]`, 36, color);
  const rationale = finding.scoring_rationale?.join(",") || "none";
  return `${index + 1}. ${rule} Impact ${formatDisplayedFindingImpact(finding)}; severity ${finding.severity}; confidence evidence=${confidence.evidence} causal=${confidence.causal} completeness=${confidence.source_completeness}; rationale ${rationale} — ${plainLine(finding.title)}`;
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

function caveatLines(report: ReportV2, findings: readonly Finding[]): string[] {
  const caveats = [
    ...report.caveats,
    ...findings.flatMap((finding) => finding.caveats),
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
  const findings = report.findings.slice(0, 3).map(findingForDisplay);
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
  const caveats = caveatLines(report, findings);
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
