import { lstat, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import { loadAdoptions } from "../store/adoptions.js";
import { loadAnalyses } from "../store/analyses.js";
import { loadDismissals } from "../store/dismissals.js";
import { resolveStorePaths, type StorePaths } from "../store/paths.js";
import { openStoreDatabase } from "../store/sqlite.js";
import type { CommandExecutionResult } from "./analyze.js";
import { compactHookEventsStrict } from "./hook-event.js";
import { resolveCurrentRepoRoot } from "./stats.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const ANALYSIS_RETENTION_MS = 90 * DAY_MS;
const DISMISSAL_RETENTION_MS = 14 * DAY_MS;
const REQUIRED_MIGRATIONS = ["legacy-analyses-json-v1",
  "legacy-dismissals-json-v1", "legacy-adoptions-json-v1"] as const;
const REPOSITORY_HASH = /^[0-9a-f]{64}$/u;

export type DataCommandAction = "gc" | "delete";

export interface DataCommandOptions {
  cwd: string; action: DataCommandAction; nowMs?: number;
}

export interface DataCommandDependencies {
  resolveRepoRoot?: (cwd: string) => Promise<string>;
  resolveStorePaths?: (repoRoot: string) => Promise<StorePaths>;
}

interface DeletionCounts {
  executions: number; snapshots: number; adoptions: number; dismissals: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function removeKnownLegacyPath(path: string): Promise<number> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  if (info.isSymbolicLink()) await unlink(path);
  else await rm(path, { recursive: info.isDirectory(), force: false });
  return 1;
}

async function completeMigrations(paths: StorePaths): Promise<string[]> {
  const database = openStoreDatabase(paths);
  try {
    const markerCount = Number(database.prepare(`SELECT count(*)
      FROM store_migrations WHERE name IN (?, ?, ?)`)
      .pluck().get(...REQUIRED_MIGRATIONS));
    if (markerCount === REQUIRED_MIGRATIONS.length) return [];
  } finally {
    database.close();
  }
  const results = [
    await loadAnalyses(paths),
    await loadDismissals(paths),
    await loadAdoptions(paths),
  ];
  return results.some((result) => result.warnings.length > 0)
    ? ["Store migration skipped invalid legacy input."]
    : [];
}

function collectDatabaseGarbage(
  paths: StorePaths,
  nowMs: number,
): DeletionCounts {
  const database = openStoreDatabase(paths);
  try {
    const markerCount = Number(database.prepare(`SELECT count(*)
      FROM store_migrations WHERE name IN (?, ?, ?)`)
      .pluck().get(...REQUIRED_MIGRATIONS));
    if (markerCount !== REQUIRED_MIGRATIONS.length) {
      throw new Error("Store migrations are incomplete");
    }

    const counts = database.transaction((): DeletionCounts => {
      const analysisCutoff = nowMs - ANALYSIS_RETENTION_MS;
      const dismissalCutoff = nowMs - DISMISSAL_RETENTION_MS;
      const executions = database.prepare(
        "DELETE FROM analysis_executions WHERE executed_at_ms < ?",
      ).run(analysisCutoff).changes;
      const snapshots = database.prepare(`DELETE FROM analysis_snapshots
        WHERE NOT EXISTS (SELECT 1 FROM analysis_executions
          WHERE analysis_executions.snapshot_id = analysis_snapshots.snapshot_id)`)
        .run().changes;
      const adoptions = database.prepare(
        "DELETE FROM adoptions WHERE detected_at_ms < ?",
      ).run(analysisCutoff).changes;
      const dismissals = database.prepare(
        "DELETE FROM dismissals WHERE dismissed_at_ms <= ?",
      ).run(dismissalCutoff).changes;
      return { executions, snapshots, adoptions, dismissals };
    }).immediate();

    database.exec("VACUUM");
    const checkpoint = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy?: unknown;
    }>;
    if (checkpoint.length !== 1 || Number(checkpoint[0]?.busy) !== 0) {
      throw new Error("Store checkpoint remained busy");
    }
    return counts;
  } finally {
    database.close();
  }
}

async function garbageCollect(
  paths: StorePaths,
  nowMs: number,
): Promise<CommandExecutionResult> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("invalid garbage collection time");
  }
  const warnings = await completeMigrations(paths);
  const counts = collectDatabaseGarbage(paths, nowMs);
  const hookEvents = await compactHookEventsStrict(paths.hook_events_path, nowMs);
  let legacyPaths = 0;
  for (const path of [
    paths.analyses_dir,
    paths.history_index_path,
    paths.dismissals_path,
    paths.adoptions_path,
  ]) {
    legacyPaths += await removeKnownLegacyPath(path);
  }
  return {
    stdout: `Store garbage collection complete: executions=${counts.executions}, snapshots=${counts.snapshots}, adoptions=${counts.adoptions}, dismissals=${counts.dismissals}, hook_events=${hookEvents}, legacy_paths=${legacyPaths}.\n`,
    warnings,
  };
}

async function deleteRepositoryStore(
  paths: StorePaths,
): Promise<CommandExecutionResult> {
  if (
    !REPOSITORY_HASH.test(paths.repo_hash) ||
    paths.repo_dir !== join(paths.root_dir, paths.repo_hash)
  ) {
    throw new Error("invalid repository Store target");
  }
  let info;
  try {
    info = await lstat(paths.repo_dir);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { stdout: "Repository Store deleted.\n", warnings: [] };
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("repository Store target is not a regular directory");
  }
  await rm(paths.repo_dir, { recursive: true, force: false });
  return { stdout: "Repository Store deleted.\n", warnings: [] };
}

export async function runDataCommand(
  options: DataCommandOptions,
  dependencies: DataCommandDependencies = {},
): Promise<CommandExecutionResult> {
  if (options.action !== "gc" && options.action !== "delete") {
    throw new Error("Unknown data action.");
  }
  try {
    const repoRoot = await (
      dependencies.resolveRepoRoot ?? resolveCurrentRepoRoot
    )(options.cwd);
    const paths = await (
      dependencies.resolveStorePaths ?? resolveStorePaths
    )(repoRoot);
    switch (options.action) {
      case "gc": return await garbageCollect(paths, options.nowMs ?? Date.now());
      case "delete": return await deleteRepositoryStore(paths);
    }
  } catch {
    throw new Error(options.action === "gc"
      ? "Store garbage collection failed."
      : "Store deletion failed.");
  }
}
