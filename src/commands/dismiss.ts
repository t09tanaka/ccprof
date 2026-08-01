import type { Finding } from "../core/model.js";
import {
  loadAnalyses,
  type AnalysisHistoryResult,
  type AnalysisRecord,
} from "../store/analyses.js";
import {
  saveDismissal,
  type DismissalInput,
  type DismissalSaveResult,
} from "../store/dismissals.js";
import {
  resolveStorePaths,
  type StorePaths,
} from "../store/paths.js";
import { sanitizeHumanText } from "../reporters/sanitize.js";
import type { CommandExecutionResult } from "./analyze.js";
import { resolveCurrentRepoRoot } from "./stats.js";

export interface DismissCommandOptions {
  cwd: string;
  findingKey: string;
  reason?: string;
}

export interface DismissCommandDependencies {
  resolveRepoRoot?: (cwd: string) => Promise<string>;
  resolveStorePaths?: (repoRoot: string) => Promise<StorePaths>;
  loadAnalyses?: (
    paths: StorePaths,
  ) => Promise<AnalysisHistoryResult>;
  saveDismissal?: (
    paths: StorePaths,
    input: DismissalInput,
  ) => Promise<DismissalSaveResult>;
  now?: () => number;
}

export class FindingNotFoundError extends Error {
  constructor(findingKey: string) {
    super(`Unknown finding key: ${findingKey}`);
    this.name = "FindingNotFoundError";
  }
}

export class DismissalPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DismissalPersistenceError";
  }
}

function recordOrder(
  left: AnalysisRecord,
  right: AnalysisRecord,
): number {
  return right.created_at_ms - left.created_at_ms ||
    right.analysis_id.localeCompare(left.analysis_id);
}

function findStoredFinding(
  records: readonly AnalysisRecord[],
  findingKey: string,
): Finding | undefined {
  for (const record of [...records].sort(recordOrder)) {
    const finding = record.findings.find(
      (candidate) => candidate.finding_key === findingKey,
    );
    if (finding !== undefined) return finding;
  }
  return undefined;
}

function evidenceTarget(finding: Finding): string {
  for (const key of ["command", "path", "target"] as const) {
    const value = finding.evidence[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  const paths = finding.evidence.paths;
  if (
    Array.isArray(paths) &&
    paths.every((value) => typeof value === "string")
  ) {
    const target = paths.join(" | ").trim();
    if (target !== "") return target;
  }
  return finding.title;
}

function warningText(
  warning: AnalysisHistoryResult["warnings"][number],
): string {
  return `[${warning.code}] ${warning.message} (${warning.path})`;
}

export async function runDismissCommand(
  options: DismissCommandOptions,
  dependencies: DismissCommandDependencies = {},
): Promise<CommandExecutionResult> {
  const findingKey = options.findingKey.trim();
  if (findingKey === "") {
    throw new FindingNotFoundError(options.findingKey);
  }
  const repoRoot = await (
    dependencies.resolveRepoRoot ?? resolveCurrentRepoRoot
  )(options.cwd);
  const paths = await (
    dependencies.resolveStorePaths ?? resolveStorePaths
  )(repoRoot);
  const history = await (
    dependencies.loadAnalyses ?? loadAnalyses
  )(paths);
  const finding = findStoredFinding(history.records, findingKey);
  if (finding === undefined) {
    throw new FindingNotFoundError(findingKey);
  }
  const save = dependencies.saveDismissal ?? saveDismissal;
  const saved = await save(paths, {
    finding_key: findingKey,
    target: evidenceTarget(finding),
    dismissed_at_ms: (dependencies.now ?? Date.now)(),
    strength_min: finding.recoverable.min,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  });
  const failed = saved.warnings.find(
    (warning) => warning.code === "dismissal_write_failed",
  );
  if (failed !== undefined) {
    throw new DismissalPersistenceError(failed.message);
  }
  return {
    stdout: `Dismissed ${sanitizeHumanText(findingKey)} for 14 days.\n`,
    warnings: [
      ...history.warnings.map(warningText),
      ...saved.warnings.map(warningText),
    ],
  };
}
