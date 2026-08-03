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
  privacyWarningTexts,
  projectStatsPrivacy,
  type PrivacyProfile,
} from "../reporters/privacy.js";
import {
  loadAnalyses,
  type AnalysisHistoryResult,
} from "../store/analyses.js";
import {
  loadAdoptions,
  type AdoptionLoadResult,
} from "../store/adoptions.js";
import {
  resolveStorePaths,
  type StorePaths,
} from "../store/paths.js";
import type { CommandExecutionResult } from "./analyze.js";
import {
  resolveRepositoryPolicy,
  type RepositoryPolicyResolver,
} from "../policy/organization-policy.js";

export interface StatsCommandOptions {
  cwd: string;
  json: boolean;
  privacy: PrivacyProfile;
}

export interface StatsCommandDependencies {
  resolveRepoRoot?: (cwd: string) => Promise<string>;
  resolveStorePaths?: (repoRoot: string) => Promise<StorePaths>;
  loadAnalyses?: (
    paths: StorePaths,
  ) => Promise<AnalysisHistoryResult>;
  loadAdoptions?: (
    paths: StorePaths,
  ) => Promise<AdoptionLoadResult>;
  resolvePolicy?: RepositoryPolicyResolver;
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

export async function runStatsCommand(
  options: StatsCommandOptions,
  dependencies: StatsCommandDependencies = {},
): Promise<CommandExecutionResult> {
  const repoRoot = await (
    dependencies.resolveRepoRoot ?? resolveCurrentRepoRoot
  )(options.cwd);
  const effectivePolicy = await (
    dependencies.resolvePolicy ?? resolveRepositoryPolicy
  )(repoRoot, { privacy: options.privacy, advisory: false });
  const privacy = effectivePolicy.privacy;
  const paths = await (
    dependencies.resolveStorePaths ?? resolveStorePaths
  )(repoRoot);
  const history = await (
    dependencies.loadAnalyses ?? loadAnalyses
  )(paths);
  const adoptions = await (
    dependencies.loadAdoptions ?? loadAdoptions
  )(paths);
  const stats = projectStatsPrivacy(
    summarizeStats(history.records, adoptions.records),
    privacy,
    repoRoot,
  );
  const warnings = [...history.warnings, ...adoptions.warnings].map(
    (warning) => ({
      code: warning.code,
      message: warning.message,
      source: warning.path,
    }),
  );
  return {
    stdout: options.json
      ? renderStatsJson(stats)
      : renderStatsTty(stats),
    warnings: privacyWarningTexts(warnings, privacy, repoRoot),
  };
}
