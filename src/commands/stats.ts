import { resolve } from "node:path";

import { aggregateTerminalStats } from "../analysis/stats-aggregation.js";
import { projectStatsAggregationInput } from "../analysis/stats-input.js";
import { buildChronicCostMaterializationEntries } from "../core/analyze.js";
import {
  runCommand,
  type CommandRunner,
} from "../git/client.js";
import { GitContextError } from "../git/pr-context.js";
import {
  renderStatsJson,
  renderStatsTty,
  summarizeStats,
  summarizeTerminalStats,
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
import { buildChronicCostAggregates } from "../rules/chronic-cost.js";

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
  onPrivacyResolved?: (privacy: PrivacyProfile) => void;
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
  const paths = await (
    dependencies.resolveStorePaths ?? resolveStorePaths
  )(repoRoot);
  const policyRepoRoot = paths.canonical_repo;
  const effectivePolicy = await (
    dependencies.resolvePolicy ?? resolveRepositoryPolicy
  )(policyRepoRoot, { privacy: options.privacy, advisory: false });
  const privacy = effectivePolicy.privacy;
  dependencies.onPrivacyResolved?.(privacy);
  const history = await (
    dependencies.loadAnalyses ?? loadAnalyses
  )(paths);
  const adoptions = await (
    dependencies.loadAdoptions ?? loadAdoptions
  )(paths);
  const rawStats = history.entries === undefined
    ? summarizeStats(history.records, adoptions.records)
    : (() => {
      const mode = { mode: "stats_all_groups" } as const;
      const projected = history.entries.map((entry) =>
        projectStatsAggregationInput(entry)
      );
      const aggregate = aggregateTerminalStats(
        projected,
        mode,
        effectivePolicy.minimum_cohort_size,
      );
      const recordsBySnapshot = new Map(history.entries.map((entry) =>
        [entry.snapshot_id, entry.record] as const
      ));
      const terminalRecords = aggregate.selected_snapshot_ids.flatMap(
        (snapshotId) => {
          const record = recordsBySnapshot.get(snapshotId);
          return record === undefined ? [] : [record];
        },
      );
      const chronicAggregates = buildChronicCostAggregates(
        projected,
        mode,
        effectivePolicy.minimum_cohort_size,
      );
      const chronicEntries = buildChronicCostMaterializationEntries(
        projected,
        history.entries,
        mode,
      );
      return summarizeTerminalStats(
        aggregate,
        terminalRecords,
        adoptions.records,
        chronicAggregates,
        chronicEntries,
      );
    })();
  const stats = projectStatsPrivacy(
    rawStats,
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
