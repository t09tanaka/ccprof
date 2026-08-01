import { resolve } from "node:path";

import {
  runCommand,
  type CommandRunner,
} from "../git/client.js";
import { GitContextError } from "../git/pr-context.js";
import {
  renderStatsJson,
  renderStatsTty,
  summarizeStats,
} from "../reporters/stats.js";
import {
  loadAnalyses,
  type AnalysisHistoryResult,
} from "../store/analyses.js";
import {
  resolveStorePaths,
  type StorePaths,
} from "../store/paths.js";
import type { CommandExecutionResult } from "./analyze.js";

export interface StatsCommandOptions {
  cwd: string;
  json: boolean;
}

export interface StatsCommandDependencies {
  resolveRepoRoot?: (cwd: string) => Promise<string>;
  resolveStorePaths?: (repoRoot: string) => Promise<StorePaths>;
  loadAnalyses?: (
    paths: StorePaths,
  ) => Promise<AnalysisHistoryResult>;
}

export async function resolveCurrentRepoRoot(
  cwd: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  const result = await runner(
    "git",
    ["--no-pager", "rev-parse", "--show-toplevel"],
    { cwd },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new GitContextError(
      `git rev-parse failed with exit ${result.code}${
        detail === "" ? "" : `: ${detail}`
      }`,
    );
  }
  const root = result.stdout.trim();
  if (root === "") {
    throw new GitContextError("git returned an empty repository root");
  }
  return resolve(root);
}

function warningText(
  warning: AnalysisHistoryResult["warnings"][number],
): string {
  return `[${warning.code}] ${warning.message} (${warning.path})`;
}

export async function runStatsCommand(
  options: StatsCommandOptions,
  dependencies: StatsCommandDependencies = {},
): Promise<CommandExecutionResult> {
  const repoRoot = await (
    dependencies.resolveRepoRoot ?? resolveCurrentRepoRoot
  )(options.cwd);
  const paths = await (
    dependencies.resolveStorePaths ?? resolveStorePaths
  )(repoRoot);
  const history = await (
    dependencies.loadAnalyses ?? loadAnalyses
  )(paths);
  const stats = summarizeStats(history.records);
  return {
    stdout: options.json
      ? renderStatsJson(stats)
      : renderStatsTty(stats),
    warnings: history.warnings.map(warningText),
  };
}
