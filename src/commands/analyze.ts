import { resolve } from "node:path";

import {
  requestAdvisory,
  type AdvisoryText,
} from "../advisory/advisory.js";
import {
  analyze as analyzeCore,
  type AnalyzeOptions,
  type AnalyzeResult,
} from "../core/analyze.js";
import { runCommand, type CommandRunner } from "../git/client.js";
import { renderJsonReport } from "../reporters/json.js";
import { renderMarkdownReport } from "../reporters/markdown.js";
import {
  defaultPrivacyProfile,
  privacyWarningTexts,
  projectReportPrivacy,
  sanitizePrivacyText,
  type PrivacyProfile,
} from "../reporters/privacy.js";
import { sanitizeHumanText } from "../reporters/sanitize.js";
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
  privacy?: PrivacyProfile;
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
  const privacy = options.privacy ?? defaultPrivacyProfile(options.format, false);
  const repoRoot = result.report.unit.repo;
  const report = projectReportPrivacy(result.report, privacy);
  const sessions = result.report.unit.sessions;
  const warnings = privacyWarningTexts(
    result.warnings, privacy, repoRoot, sessions,
  ).map((warning) => sanitizeHumanText(warning));
  // Requested only after analyze() returned, so the store write inside it
  // has already completed with the deterministic report alone: advisory
  // text can never reach AnalysisRecord or the baseline.
  let advisory: AdvisoryText | undefined;
  if (options.advisory === true) {
    const outcome = await requestAdvisory(
      renderJsonReport(report),
      dependencies.runCommand ?? runCommand,
    );
    if (outcome.kind === "available") {
      advisory = {
        ...outcome.advisory,
        text: privacy === "strict"
          ? "[advisory hidden by strict privacy]"
          : sanitizePrivacyText(outcome.advisory.text, privacy, repoRoot, sessions),
      };
    } else {
      warnings.push(sanitizeHumanText(sanitizePrivacyText(
        `advisory unavailable: ${outcome.reason}`, privacy, repoRoot, sessions,
      )));
    }
  }
  const advisoryOption = advisory === undefined ? {} : { advisory };
  const stdout = options.format === "json"
    ? renderJsonReport(report, advisoryOption)
    : options.format === "markdown"
      ? renderMarkdownReport(report, advisoryOption)
      : renderTtyReport(report, {
        color: options.color,
        ...advisoryOption,
      });
  return {
    stdout,
    warnings,
  };
}
