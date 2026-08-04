import { resolve } from "node:path";

import {
  requestAdvisory,
  type AdvisoryText,
} from "../advisory/advisory.js";
import type {
  AnalysisBudgetClock,
  AnalysisBudgets,
} from "../analysis/budgets.js";
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
import {
  resolveRepositoryPolicy,
  type EffectivePolicy,
  type RepositoryPolicyResolver,
} from "../policy/organization-policy.js";

const POLICY_ADVISORY_DISABLED_WARNING =
  "[policy_advisory_disabled] Advisory execution is disabled by active policy.";

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
  budgets?: AnalysisBudgets;
  budgetClock?: AnalysisBudgetClock;
}

export interface CommandExecutionResult {
  stdout: string;
  warnings: string[];
}

type CommandAnalysis = Pick<
  AnalyzeResult,
  "report" | "warnings" | "preparedOutput"
>;

export interface AnalyzeCommandDependencies {
  analyze?: (
    options: AnalyzeOptions,
  ) => Promise<CommandAnalysis>;
  /** Runner for the external `claude` CLI behind `--advisory`. */
  runCommand?: CommandRunner;
  resolvePolicy?: RepositoryPolicyResolver;
  onPrivacyResolved?: (privacy: PrivacyProfile) => void;
}

function renderOutput(
  format: AnalyzeOutputFormat,
  report: AnalyzeResult["report"],
  color: boolean,
  advisory?: AdvisoryText,
): string {
  const advisoryOption = advisory === undefined ? {} : { advisory };
  return format === "json"
    ? renderJsonReport(report, advisoryOption)
    : format === "markdown"
      ? renderMarkdownReport(report, advisoryOption)
      : renderTtyReport(report, { color, ...advisoryOption });
}

export async function runAnalyzeCommand(
  options: AnalyzeCommandOptions,
  dependencies: AnalyzeCommandDependencies = {},
): Promise<CommandExecutionResult> {
  const analyze = dependencies.analyze ?? analyzeCore;
  const requestedPrivacy = options.privacy ??
    defaultPrivacyProfile(options.format, false);
  let resolvedPolicy:
    | { repoRoot: string; value: EffectivePolicy }
    | undefined;
  const policyFor = async (repoRoot: string): Promise<EffectivePolicy> => {
    if (resolvedPolicy?.repoRoot === repoRoot) return resolvedPolicy.value;
    const value = await (
      dependencies.resolvePolicy ?? resolveRepositoryPolicy
    )(repoRoot, {
      privacy: requestedPrivacy,
      advisory: options.advisory === true,
    });
    resolvedPolicy = { repoRoot, value };
    dependencies.onPrivacyResolved?.(value.privacy);
    return value;
  };
  const projectorWarnings: string[] = [];
  let projectorAdvisory: AdvisoryText | undefined;
  let projectorInvoked = false;
  const analyzeOptions: AnalyzeOptions = {
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
    ...(options.budgets === undefined
      ? {}
      : {
        budgets: options.budgets,
        ...(options.budgetClock === undefined
          ? {}
          : { budgetClock: options.budgetClock }),
        outputProjector: async (unprojectedReport) => {
          projectorInvoked = true;
          const repoRoot = unprojectedReport.unit.repo;
          const sessions = unprojectedReport.unit.sessions;
          const effectivePolicy = await policyFor(repoRoot);
          const privacy = effectivePolicy.privacy;
          const promptReport = projectReportPrivacy(unprojectedReport, privacy);
          if (options.advisory === true) {
            if (
              !effectivePolicy.allow_advisory ||
              !effectivePolicy.advisory_enabled
            ) {
              projectorWarnings.push(POLICY_ADVISORY_DISABLED_WARNING);
            } else {
              const outcome = await requestAdvisory(
                renderJsonReport(promptReport),
                dependencies.runCommand ?? runCommand,
              );
              if (outcome.kind === "available") {
                projectorAdvisory = {
                  ...outcome.advisory,
                  text: privacy === "strict"
                    ? "[advisory hidden by strict privacy]"
                    : sanitizePrivacyText(
                        outcome.advisory.text,
                        privacy,
                        repoRoot,
                        sessions,
                      ),
                };
              } else {
                projectorWarnings.push(sanitizeHumanText(sanitizePrivacyText(
                  `advisory unavailable: ${outcome.reason}`,
                  privacy,
                  repoRoot,
                  sessions,
                )));
              }
            }
          }
          return {
            format: options.format,
            render: (candidate) => {
              const projected = projectReportPrivacy(candidate, privacy);
              const deterministic = renderOutput(
                options.format,
                projected,
                options.color,
              );
              return projectorAdvisory === undefined
                ? { output: deterministic }
                : {
                  output: renderOutput(
                    options.format,
                    projected,
                    options.color,
                    projectorAdvisory,
                  ),
                  withoutAdvisory: deterministic,
                };
            },
          };
        },
      }),
  };
  const result = await analyze(analyzeOptions);
  const repoRoot = result.report.unit.repo;
  const effectivePolicy = await policyFor(repoRoot);
  const privacy = effectivePolicy.privacy;
  const report = projectReportPrivacy(result.report, privacy);
  const sessions = result.report.unit.sessions;
  const warnings = privacyWarningTexts(
    result.warnings, privacy, repoRoot, sessions,
  ).map((warning) => sanitizeHumanText(warning));
  warnings.push(...projectorWarnings);
  if (result.preparedOutput !== undefined) {
    return { stdout: result.preparedOutput, warnings };
  }
  // Requested only after analyze() returned, so the store write inside it
  // has already completed with the deterministic report alone: advisory
  // text can never reach AnalysisRecord or the baseline.
  let advisory = projectorAdvisory;
  if (options.advisory === true && !projectorInvoked) {
    if (
      !effectivePolicy.allow_advisory ||
      !effectivePolicy.advisory_enabled
    ) {
      warnings.push(POLICY_ADVISORY_DISABLED_WARNING);
    } else {
      const outcome = await requestAdvisory(
        renderJsonReport(report),
        dependencies.runCommand ?? runCommand,
      );
      if (outcome.kind === "available") {
        advisory = {
          ...outcome.advisory,
          text: privacy === "strict"
            ? "[advisory hidden by strict privacy]"
            : sanitizePrivacyText(
              outcome.advisory.text,
              privacy,
              repoRoot,
              sessions,
            ),
        };
      } else {
        warnings.push(sanitizeHumanText(sanitizePrivacyText(
          `advisory unavailable: ${outcome.reason}`,
          privacy,
          repoRoot,
          sessions,
        )));
      }
    }
  }
  return {
    stdout: renderOutput(options.format, report, options.color, advisory),
    warnings,
  };
}
