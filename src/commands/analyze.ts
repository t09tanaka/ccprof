import { resolve } from "node:path";

import {
  requestAdvisory,
  type AdvisoryText,
} from "../advisory/advisory.js";
import {
  analyze as analyzeCore,
  type AnalyzeOptions,
  type AnalyzeResult,
  type AnalyzeWarning,
} from "../core/analyze.js";
import { runCommand, type CommandRunner } from "../git/client.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderMarkdownReport } from "../reporters/markdown.js";
import { renderTtyReport } from "../reporters/tty.js";

export type AnalyzeOutputFormat = "tty" | "json" | "markdown";

export interface AnalyzeCommandOptions {
  cwd: string;
  format: AnalyzeOutputFormat;
  color: boolean;
  pr?: string;
  sinceMs?: number;
  commitAnchorLookbackMs?: number;
  idleThresholdMs?: number;
  testMapPath?: string;
  advisory?: boolean;
}

export interface CommandExecutionResult {
  stdout: string;
  warnings: string[];
}

type CommandAnalysis = Pick<AnalyzeResult, "report" | "warnings">;

export interface AnalyzeCommandDependencies {
  analyze?: (
    options: AnalyzeOptions,
  ) => Promise<CommandAnalysis>;
  /** Runner for the external `claude` CLI behind `--advisory`. */
  runCommand?: CommandRunner;
}

function warningText(warning: AnalyzeWarning): string {
  return `[${warning.code}] ${warning.message}${
    warning.source === undefined ? "" : ` (${warning.source})`
  }`;
}

export async function runAnalyzeCommand(
  options: AnalyzeCommandOptions,
  dependencies: AnalyzeCommandDependencies = {},
): Promise<CommandExecutionResult> {
  const analyze = dependencies.analyze ?? analyzeCore;
  const result = await analyze({
    cwd: options.cwd,
    ...(options.pr === undefined ? {} : { pr: options.pr }),
    ...(options.sinceMs === undefined ? {} : { sinceMs: options.sinceMs }),
    ...(options.commitAnchorLookbackMs === undefined
      ? {}
      : { commitAnchorLookbackMs: options.commitAnchorLookbackMs }),
    ...(options.idleThresholdMs === undefined
      ? {}
      : { idleThresholdMs: options.idleThresholdMs }),
    ...(options.testMapPath === undefined
      ? {}
      : { testMapPath: resolve(options.cwd, options.testMapPath) }),
  });
  const warnings = result.warnings.map(warningText);
  // Requested only after analyze() returned, so the store write inside it
  // has already completed with the deterministic report alone: advisory
  // text can never reach AnalysisRecord or the baseline.
  let advisory: AdvisoryText | undefined;
  if (options.advisory === true) {
    const outcome = await requestAdvisory(
      renderJsonReport(result.report),
      dependencies.runCommand ?? runCommand,
    );
    if (outcome.kind === "available") {
      advisory = outcome.advisory;
    } else {
      warnings.push(`advisory unavailable: ${outcome.reason}`);
    }
  }
  const advisoryOption = advisory === undefined ? {} : { advisory };
  const stdout = options.format === "json"
    ? renderJsonReport(result.report, advisoryOption)
    : options.format === "markdown"
      ? renderMarkdownReport(result.report, advisoryOption)
      : renderTtyReport(result.report, {
        color: options.color,
        ...advisoryOption,
      });
  return {
    stdout,
    warnings,
  };
}
