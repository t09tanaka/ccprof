import type {
  AnalysisBudgetResult,
  AnalysisBudgetUsage,
  AnalysisTruncationReason,
  AnalysisBudgetMeter,
} from "../analysis/budgets.js";
import type { ReportV2 } from "../core/model.js";

export type BudgetOutputFormat = "tty" | "json" | "markdown";

export interface BudgetOutputRendering {
  output: string;
  /** The same deterministic report with its optional advisory removed. */
  withoutAdvisory?: string;
}

export interface BudgetOutputProjection {
  format: BudgetOutputFormat;
  render(report: ReportV2): BudgetOutputRendering;
}

export type AnalysisOutputProjector = (
  report: ReportV2,
) => Promise<BudgetOutputProjection>;

export interface FinalizedBudgetedOutput {
  stdout: string;
  analysisBudget: AnalysisBudgetResult;
}

export const OUTPUT_BUDGET_ENVELOPES: Readonly<
  Record<BudgetOutputFormat, string>
> = Object.freeze({
  json: '{"error":"analysis_output_budget_exceeded"}\n',
  tty: "ccprof: output omitted (analysis budget exceeded).\n",
  markdown: "## ccprof\n\nOutput omitted: analysis budget exceeded.\n",
});

interface FinalizeBudgetedOutputOptions {
  report: ReportV2;
  meter: AnalysisBudgetMeter;
  projection: BudgetOutputProjection;
  byteLength?: (value: string) => number;
}

const REASON_PRIORITY: Readonly<Record<AnalysisTruncationReason, number>> = {
  max_input_bytes: 0,
  max_input_events: 1,
  max_wall_ms: 2,
  max_cpu_ms: 3,
  max_output_bytes: 4,
  max_source_items: 5,
  source_failure: 6,
  meter_error: 7,
};

const MAX_STABILIZATION_PASSES = 32;

function measuredBytes(
  value: string,
  byteLength: (value: string) => number,
): number {
  const bytes = byteLength(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new TypeError("Invalid analysis output byte count.");
  }
  return bytes;
}

function outputUsage(
  usage: AnalysisBudgetUsage,
  outputBytes: number,
): AnalysisBudgetUsage {
  return {
    input_bytes: usage.input_bytes,
    input_events: usage.input_events,
    wall_ms: usage.wall_ms,
    cpu_ms: usage.cpu_ms,
    output_bytes: outputBytes,
    source_items: usage.source_items,
  };
}

function outputResult(
  base: AnalysisBudgetResult,
  observedBytes: number,
  consumedBytes: number,
  truncated: boolean,
): AnalysisBudgetResult {
  const existingReason = base.truncation_reason;
  const reason = !truncated
    ? existingReason
    : existingReason !== undefined &&
        REASON_PRIORITY[existingReason] < REASON_PRIORITY.max_output_bytes
      ? existingReason
      : "max_output_bytes";
  const outputCoverage = observedBytes === 0
    ? 0
    : Math.max(0, Math.min(1, consumedBytes / observedBytes));
  const coverage = truncated
    ? Math.min(base.completeness === "partial" ? base.coverage : 1, outputCoverage)
    : base.coverage;
  return {
    configured: { ...base.configured },
    consumed: outputUsage(base.consumed, consumedBytes),
    observed: outputUsage(base.observed, observedBytes),
    completeness: truncated || base.completeness === "partial"
      ? "partial"
      : "complete",
    ...(reason === undefined ? {} : { truncation_reason: reason }),
    coverage,
  };
}

function withBudget(report: ReportV2, budget: AnalysisBudgetResult): ReportV2 {
  return { ...report, analysis_budget: budget };
}

function sameBudget(
  left: AnalysisBudgetResult,
  right: AnalysisBudgetResult,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Finalizes an active output budget without ever inspecting the raw report.
 * The supplied renderer owns privacy projection and format serialization;
 * every byte count is therefore taken only from display-ready strings.
 */
export function finalizeBudgetedOutput(
  options: FinalizeBudgetedOutputOptions,
): FinalizedBudgetedOutput {
  const byteLength = options.byteLength ??
    ((value: string) => Buffer.byteLength(value, "utf8"));
  const base = options.meter.result();
  const limit = base.configured.max_output_bytes;
  let budget = outputResult(base, 0, 0, false);
  let overflow: BudgetOutputRendering | undefined;

  for (let pass = 0; pass < MAX_STABILIZATION_PASSES; pass += 1) {
    const rendered = options.projection.render(withBudget(options.report, budget));
    const bytes = measuredBytes(rendered.output, byteLength);
    if (bytes > limit) {
      overflow = rendered;
      break;
    }
    const next = outputResult(base, bytes, bytes, false);
    if (sameBudget(next, budget)) {
      return { stdout: rendered.output, analysisBudget: next };
    }
    budget = next;
  }

  // If a combined deterministic + advisory output overflowed, retry the
  // deterministic report by itself before considering a diagnostic envelope.
  if (overflow?.withoutAdvisory !== undefined) {
    const initialObserved = measuredBytes(overflow.output, byteLength);
    budget = outputResult(base, initialObserved, 0, true);
    for (let pass = 0; pass < MAX_STABILIZATION_PASSES; pass += 1) {
      const rendered = options.projection.render(
        withBudget(options.report, budget),
      );
      const deterministic = rendered.withoutAdvisory ?? rendered.output;
      const observedBytes = measuredBytes(rendered.output, byteLength);
      const consumedBytes = measuredBytes(deterministic, byteLength);
      if (consumedBytes > limit) {
        overflow = rendered;
        break;
      }
      const next = outputResult(
        base,
        observedBytes,
        consumedBytes,
        true,
      );
      if (sameBudget(next, budget)) {
        return { stdout: deterministic, analysisBudget: next };
      }
      budget = next;
    }
  }

  const envelope = OUTPUT_BUDGET_ENVELOPES[options.projection.format];
  const envelopeBytes = measuredBytes(envelope, byteLength);
  const stdout = envelopeBytes <= limit ? envelope : "";
  const consumedBytes = stdout === "" ? 0 : envelopeBytes;
  budget = outputResult(base, 0, consumedBytes, true);

  // The envelope is content-free and has a fixed size, but the attempted
  // deterministic report can contain its own final budget facts. Stabilize
  // only that observed count; the emitted bytes never change.
  for (let pass = 0; pass < MAX_STABILIZATION_PASSES; pass += 1) {
    const rendered = options.projection.render(withBudget(options.report, budget));
    const deterministic = rendered.withoutAdvisory ?? rendered.output;
    const observedBytes = measuredBytes(deterministic, byteLength);
    const next = outputResult(base, observedBytes, consumedBytes, true);
    if (sameBudget(next, budget)) {
      return { stdout, analysisBudget: next };
    }
    budget = next;
  }

  return { stdout, analysisBudget: budget };
}
