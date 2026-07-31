import { resolve } from "node:path";

import {
  analyze as analyzeCore,
  type AnalyzeOptions,
  type AnalyzeResult,
  type AnalyzeWarning,
} from "../core/analyze.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderMarkdownReport } from "../reporters/markdown.js";
import { renderTtyReport } from "../reporters/tty.js";

export type AnalyzeOutputFormat = "tty" | "json" | "markdown";

export interface AnalyzeCommandOptions {
  cwd: string;
  format: AnalyzeOutputFormat;
  color: boolean;
  pr?: string;
  idleThresholdMs?: number;
  testMapPath?: string;
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
    ...(options.idleThresholdMs === undefined
      ? {}
      : { idleThresholdMs: options.idleThresholdMs }),
    ...(options.testMapPath === undefined
      ? {}
      : { testMapPath: resolve(options.cwd, options.testMapPath) }),
  });
  const stdout = options.format === "json"
    ? renderJsonReport(result.report)
    : options.format === "markdown"
      ? renderMarkdownReport(result.report)
      : renderTtyReport(result.report, { color: options.color });
  return {
    stdout,
    warnings: result.warnings.map(warningText),
  };
}
