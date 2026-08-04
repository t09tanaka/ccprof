import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import type {
  AnalysisSummary,
  CommandIdentity,
  Finding,
  FindingConfidence,
  ImpactEstimate,
  ReportV2,
  RuleId,
} from "../src/core/model.js";
import type { AnalysisBudgetResult } from "../src/analysis/budgets.js";
import type {
  TerminalStatsSnapshotV1 as ExportedTerminalStatsSnapshotV1,
} from "../src/analysis/stats-aggregation.js";
import { commandIdentityKey } from "../src/analysis/command-identity.js";
import { detectChronicCost } from "../src/rules/chronic-cost.js";
import { projectReportPrivacy } from "../src/reporters/privacy.js";
import {
  findingKey,
  findingKeyForCompatibility,
} from "../src/rules/shared.js";
import { ruleManifest } from "../src/rules/manifest.js";
import { selectorRefDigest } from "../src/git/pr-context.js";
import {
  canonicalRuleSafetySnapshot,
  resolveRuleSafetyPolicy,
} from "../src/policy/rule-safety.js";
import {
  loadAdoptions,
  saveAdoptions,
  type AdoptionRecord,
} from "../src/store/adoptions.js";
import {
  analysisDigest,
  computeBaseline,
  loadAnalyses,
  makeAnalysisRecord,
  saveAnalysis,
  type AnalysisRecord,
  type AnalysisSnapshotIdentity,
} from "../src/store/analyses.js";
import {
  applyDismissals,
  dismissalDecision,
  loadDismissals,
  saveDismissal,
} from "../src/store/dismissals.js";
import {
  canonicalRepoPath,
  repoHash,
  resolveStorePaths,
  type StorePaths,
} from "../src/store/paths.js";
import {
  openStoreDatabase,
  storeDatabasePath,
  STORE_SCHEMA_VERSION,
  UnsupportedStoreSchemaError,
} from "../src/store/sqlite.js";

const INCREMENTAL_SOURCES_MIGRATION = "schema-v5-incremental-sources";

const summary: AnalysisSummary = {
  measured_min: 100,
  idle_excluded_min: 10,
  estimated_floor_min: 70,
  recoverable_min: 30,
  human_wait_min: 0,
  unexplained_min: 5,
  baseline: null,
};

function commandIdentity(
  cwd: string,
  argv: string[] = ["npm", "test"],
  executor: CommandIdentity["executor"] = "shell",
): CommandIdentity {
  return { repo_relative_cwd: cwd, normalized_argv: [...argv], executor };
}

function identityEvidence(identity: CommandIdentity) {
  return { repo_relative_cwd: identity.repo_relative_cwd,
    normalized_argv: [...identity.normalized_argv], executor: identity.executor };
}

function finding(
  key: string,
  command = "npm test",
  recoverableMin = 10,
): Finding {
  const impactMs = recoverableMin * 60_000;
  return {
    finding_key: key,
    rule_id: "R002",
    title: "Repeated command",
    classification: "behavior",
    cause: null,
    scope: "this_pr",
    confidence: "high",
    impact: {
      lower_ms: impactMs,
      upper_ms: impactMs,
      kind: "critical_path_latency",
    },
    finding_confidence: {
      evidence: "high",
      causal: "high",
      source_completeness: 1,
    },
    severity: impactMs === 0 ? "info" : "high",
    scoring_rationale: impactMs === 0 ? [] : ["observed_lower_bound"],
    evidence: {
      session_refs: [`session#${key}`],
      interval_ids: [`R002:${key}`],
      command,
      duration_ms: recoverableMin * 60_000,
    },
    recoverable: { min: recoverableMin, bound: "point" },
    fix_recipe: {
      suggestion: "Run an affected-only test command.",
      verify: command,
    },
    caveats: [],
  };
}

function legacyFinding(
  key: string,
  options: {
    ruleId?: Finding["rule_id"];
    confidence?: Finding["confidence"];
    bound?: Finding["recoverable"]["bound"];
    recoverableMin?: number;
  } = {},
): Finding {
  const {
    impact: _impact,
    finding_confidence: _findingConfidence,
    severity: _severity,
    scoring_rationale: _scoringRationale,
    ...legacy
  } = finding(key, "npm test", options.recoverableMin ?? 10);
  return {
    ...legacy,
    rule_id: options.ruleId ?? legacy.rule_id,
    confidence: options.confidence ?? legacy.confidence,
    recoverable: {
      ...legacy.recoverable,
      bound: options.bound ?? legacy.recoverable.bound,
    },
  };
}

function record(
  id: string,
  createdAtMs: number,
  options: {
    measuredMin?: number;
    command?: string;
    commandMin?: number;
    metric?: number;
    includeCommand?: boolean;
    commandIdentity?: CommandIdentity | undefined;
  } = {},
): AnalysisRecord {
  const measuredMin = options.measuredMin ?? 100;
  const command = options.command ?? "npm test";
  const storedFinding = finding(`finding-${id}`, command, options.commandMin ?? 10);
  if (options.commandIdentity !== undefined) {
    storedFinding.evidence.command_identity = identityEvidence(options.commandIdentity);
  }
  return makeAnalysisRecord({
    analysis_id: id,
    created_at_ms: createdAtMs,
    unit: {
      repo: "/repo",
      pr_ref: `main...${id}`,
      sessions: [`session-${id}`],
    },
    summary: { ...summary, measured_min: measuredMin },
    findings: [storedFinding],
    metrics: {
      human_wait_ratio: options.metric ?? createdAtMs,
    },
    command_costs: options.includeCommand === false
      ? []
      : [{
          command,
          ...(options.commandIdentity === undefined ? {} : {
            command_identity: commandIdentity(options.commandIdentity.repo_relative_cwd,
              options.commandIdentity.normalized_argv, options.commandIdentity.executor),
          }),
          duration_min: options.commandMin ?? 10,
          session_refs: [`session-${id}#run`],
        }],
  });
}

function budgetResult(
  completeness: "complete" | "partial" = "complete",
): AnalysisBudgetResult {
  return {
    configured: {
      max_input_bytes: 10,
      max_input_events: 3,
      max_wall_ms: 20,
      max_cpu_ms: 15,
      max_output_bytes: 200,
      max_source_items: 2,
    },
    consumed: {
      input_bytes: completeness === "complete" ? 10 : 5,
      input_events: 3,
      wall_ms: 20,
      cpu_ms: 15,
      output_bytes: 200,
      source_items: 2,
    },
    observed: {
      input_bytes: completeness === "complete" ? 10 : 11,
      input_events: 3,
      wall_ms: 20,
      cpu_ms: 15,
      output_bytes: 200,
      source_items: 2,
    },
    completeness,
    ...(completeness === "complete"
      ? {}
      : { truncation_reason: "max_input_bytes" as const }),
    coverage: completeness === "complete" ? 1 : 5 / 11,
  };
}

function budgetRecord(
  id: string,
  createdAtMs: number,
  completeness: "complete" | "partial" = "complete",
): AnalysisRecord & { analysis_budget: AnalysisBudgetResult } {
  return {
    ...record(id, createdAtMs),
    analysis_budget: budgetResult(completeness),
  };
}

function storedBudgetRow(
  executionId: string,
  result: AnalysisBudgetResult,
) {
  return {
    execution_id: executionId,
    max_input_bytes: result.configured.max_input_bytes,
    max_input_events: result.configured.max_input_events,
    max_wall_ms: result.configured.max_wall_ms,
    max_cpu_ms: result.configured.max_cpu_ms,
    max_output_bytes: result.configured.max_output_bytes,
    max_source_items: result.configured.max_source_items,
    consumed_input_bytes: result.consumed.input_bytes,
    consumed_input_events: result.consumed.input_events,
    consumed_wall_ms: result.consumed.wall_ms,
    consumed_cpu_ms: result.consumed.cpu_ms,
    consumed_output_bytes: result.consumed.output_bytes,
    consumed_source_items: result.consumed.source_items,
    observed_input_bytes: result.observed.input_bytes,
    observed_input_events: result.observed.input_events,
    observed_wall_ms: result.observed.wall_ms,
    observed_cpu_ms: result.observed.cpu_ms,
    observed_output_bytes: result.observed.output_bytes,
    observed_source_items: result.observed.source_items,
    completeness: result.completeness,
    truncation_reason: result.truncation_reason ?? null,
    coverage: result.coverage,
  };
}

const BUDGET_ROW_COLUMNS = [
  "execution_id",
  "max_input_bytes",
  "max_input_events",
  "max_wall_ms",
  "max_cpu_ms",
  "max_output_bytes",
  "max_source_items",
  "consumed_input_bytes",
  "consumed_input_events",
  "consumed_wall_ms",
  "consumed_cpu_ms",
  "consumed_output_bytes",
  "consumed_source_items",
  "observed_input_bytes",
  "observed_input_events",
  "observed_wall_ms",
  "observed_cpu_ms",
  "observed_output_bytes",
  "observed_source_items",
  "completeness",
  "truncation_reason",
  "coverage",
] as const;

function insertBudgetRow(
  database: StoreDatabase,
  executionId: string,
  result: AnalysisBudgetResult,
): void {
  const placeholders = BUDGET_ROW_COLUMNS.map((column) => `@${column}`);
  database.prepare(`INSERT INTO analysis_budget_runs
    (${BUDGET_ROW_COLUMNS.join(", ")}) VALUES (${placeholders.join(", ")})`)
    .run(storedBudgetRow(executionId, result));
}

function snapshotOptions(sourceDigest = "1".repeat(64)) {
  return {
    snapshot: {
      repo_id: "6".repeat(64),
      base_oid: "a".repeat(40),
      head_oid: "b".repeat(40),
      merge_base_oid: "a".repeat(40),
      window: {
        started_at_ms: 1,
        start_source: "commit_anchor_lookback" as const,
        end_source: "analysis_time" as const,
        completeness: "partial" as const,
      },
      source_digest: sourceDigest,
      config_digest: "3".repeat(64),
      policy_digest: "4".repeat(64),
      history_digest: "5".repeat(64),
    },
  };
}

function canonicalJson(value: unknown): string {
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]));
    }
    return entry;
  };
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

async function temporaryStore(
  callback: (paths: StorePaths, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-store-test-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    const paths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
      home_dir: join(root, "home"),
    });
    await callback(paths, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface ConcurrentStoreWrite {
  moduleUrl: string;
  exportName: "saveDismissal" | "saveAdoptions" | "openStoreDatabase";
  args: unknown[];
}

type ConcurrentStoreWorkerReply =
  | { type: "ready" }
  | { type: "result"; value: unknown }
  | { type: "failure"; message: string; stack?: string };

const concurrentStoreWriterSource = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

(async () => {
  try {
    if (parentPort === null) throw new Error("store worker has no parent port");
    const storeModule = await import(workerData.moduleUrl);
    const write = storeModule[workerData.exportName];
    if (typeof write !== "function") {
      throw new Error("missing store export: " + workerData.exportName);
    }

    const startGate = new Int32Array(workerData.startGate);
    parentPort.postMessage({ type: "ready" });
    Atomics.wait(startGate, 0, 0);

    let value;
    if (workerData.exportName === "openStoreDatabase") {
      const database = write(workerData.paths, ...workerData.args);
      try {
        value = Number(database.pragma("user_version", { simple: true }));
      } finally {
        database.close();
      }
    } else {
      value = await write(workerData.paths, ...workerData.args);
    }
    parentPort.postMessage({ type: "result", value });
  } catch (error) {
    if (parentPort !== null) {
      parentPort.postMessage({
        type: "failure",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  } finally {
    parentPort?.close();
  }
})();
`;

async function runConcurrentStoreWrites<T>(
  paths: StorePaths,
  operations: ConcurrentStoreWrite[],
): Promise<T[]> {
  if (operations.length === 0) return [];

  const startBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const startGate = new Int32Array(startBuffer);
  const workers: Worker[] = [];
  try {
    for (const operation of operations) {
      workers.push(new Worker(concurrentStoreWriterSource, {
        eval: true,
        workerData: {
          ...operation,
          paths,
          startGate: startBuffer,
        },
      }));
    }
  } catch (error) {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    throw error;
  }

  return new Promise<T[]>((resolve, reject) => {
    const ready = operations.map(() => false);
    const received = operations.map(() => false);
    const results = new Array<T>(operations.length);
    let readyCount = 0;
    let exitCount = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      Atomics.store(startGate, 0, 1);
      Atomics.notify(startGate, 0, workers.length);
      void Promise.allSettled(workers.map((worker) => worker.terminate()))
        .then(() => reject(error));
    };

    workers.forEach((worker, index) => {
      worker.on("message", (reply: ConcurrentStoreWorkerReply) => {
        if (settled) return;
        if (reply.type === "ready") {
          if (ready[index]) {
            fail(new Error(`store worker ${index} reported ready twice`));
            return;
          }
          ready[index] = true;
          readyCount += 1;
          if (readyCount === workers.length) {
            Atomics.store(startGate, 0, 1);
            Atomics.notify(startGate, 0, workers.length);
          }
          return;
        }
        if (reply.type === "failure") {
          const error = new Error(
            `store worker ${index} failed: ${reply.message}`,
          );
          if (reply.stack !== undefined) {
            error.stack = `${error.stack}\nWorker stack:\n${reply.stack}`;
          }
          fail(error);
          return;
        }
        if (reply.type === "result") {
          results[index] = reply.value as T;
          received[index] = true;
          return;
        }
        fail(new Error(`store worker ${index} returned an unknown message`));
      });
      worker.once("error", (error) => fail(error));
      worker.once("messageerror", (error) => fail(
        error instanceof Error
          ? error
          : new Error(`store worker ${index} message could not be cloned`),
      ));
      worker.once("exit", (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error(`store worker ${index} exited with code ${code}`));
          return;
        }
        if (!received[index]) {
          fail(new Error(`store worker ${index} exited without a result`));
          return;
        }
        exitCount += 1;
        if (exitCount === workers.length) {
          settled = true;
          resolve(results);
        }
      });
    });
  });
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
}

type StoreDatabase = ReturnType<typeof openStoreDatabase>;

interface SqliteColumn {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: number;
}

function tableColumns(database: StoreDatabase, table: string): SqliteColumn[] {
  return database
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all() as SqliteColumn[];
}

function userIndexColumns(database: StoreDatabase, table: string): string[][] {
  const indexes = database
    .prepare(`PRAGMA index_list(${JSON.stringify(table)})`)
    .all() as { name: string; origin: string }[];
  return indexes
    .filter(({ origin }) => origin === "c")
    .map(({ name }) => (database
      .prepare(`PRAGMA index_info(${JSON.stringify(name)})`)
      .all() as { name: string; seqno: number }[])
      .sort((left, right) => left.seqno - right.seqno)
      .map(({ name: column }) => column))
    .sort((left, right) => {
      const leftKey = left.join("\0");
      const rightKey = right.join("\0");
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function assertConnectionPragmas(database: StoreDatabase): void {
  assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(Number(database.pragma("foreign_keys", { simple: true })), 1);
  const busyTimeout = Number(database.pragma("busy_timeout", { simple: true }));
  assert.ok(Number.isSafeInteger(busyTimeout));
  assert.ok(busyTimeout > 0 && busyTimeout <= 60_000);
}

function removeIncrementalSourceSchema(database: StoreDatabase): void {
  database.exec(`
    DROP TABLE IF EXISTS source_evidence_cache;
    DROP TABLE IF EXISTS source_discovery_roots;
  `);
  database.prepare("DELETE FROM store_migrations WHERE name = ?")
    .run(INCREMENTAL_SOURCES_MIGRATION);
}

function populatedV2Store(paths: StorePaths): StoreDatabase {
  const database = openStoreDatabase(paths);
  const downgrade = database.transaction(() => {
    removeIncrementalSourceSchema(database);
    database.exec("DROP TABLE IF EXISTS analysis_budget_runs");
    database.prepare("DELETE FROM store_migrations WHERE name = ?")
      .run("schema-v4-analysis-budgets");
    database.exec("DROP TABLE IF EXISTS source_catalog");
    database.prepare("DELETE FROM store_migrations WHERE name = ?")
      .run("schema-v3-source-catalog");
    database.pragma("user_version = 2");
  });
  downgrade.immediate();
  database.exec(`
    INSERT INTO store_migrations(name, completed_at_ms)
      VALUES ('legacy-sentinel', 11);
    INSERT INTO analysis_snapshots(snapshot_id, created_at_ms, record_json)
      VALUES ('snapshot-v2', 12, '{"schema":"v2"}');
    INSERT INTO analysis_executions(execution_id, snapshot_id, executed_at_ms)
      VALUES ('execution-v2', 'snapshot-v2', 13);
    INSERT INTO dismissals(finding_key, dismissed_at_ms, record_json)
      VALUES ('dismissal-v2', 14, '{"dismissal":true}');
    INSERT INTO adoptions(finding_key, detected_at_ms, record_json)
      VALUES ('adoption-v2', 15, '{"adoption":true}');
  `);
  return database;
}

function populatedV3Store(paths: StorePaths): StoreDatabase {
  const database = openStoreDatabase(paths);
  const downgrade = database.transaction(() => {
    removeIncrementalSourceSchema(database);
    database.exec("DROP TABLE IF EXISTS analysis_budget_runs");
    database.prepare("DELETE FROM store_migrations WHERE name = ?")
      .run("schema-v4-analysis-budgets");
    database.pragma("user_version = 3");
  });
  downgrade.immediate();
  database.exec(`
    INSERT INTO store_migrations(name, completed_at_ms)
      VALUES ('legacy-sentinel-v3', 21);
    INSERT INTO source_catalog(
      adapter_id, adapter_version, source_identity, canonical_path,
      device, inode, mtime_ms, size_bytes, prefix_hash, suffix_hash,
      content_revision, discovery_cursor, last_parsed_offset,
      last_normalized_event_index, parser_version, schema_fingerprint,
      observed_at_ms, completeness
    ) VALUES (
      'claude', '1.0.0', 'source-' || lower(hex(zeroblob(32))), '/repo/v3.jsonl',
      1, 2, 3, 4, 'sha256:' || lower(hex(zeroblob(32))),
      'sha256:' || lower(hex(zeroblob(32))),
      'sha256:' || lower(hex(zeroblob(32))), 5, 4, 6,
      'parser-v3', 'sha256:' || lower(hex(zeroblob(32))), 7, 'complete'
    );
  `);
  return database;
}

function populatedV4Store(paths: StorePaths): StoreDatabase {
  const database = openStoreDatabase(paths);
  const downgrade = database.transaction(() => {
    removeIncrementalSourceSchema(database);
    database.pragma("user_version = 4");
  });
  downgrade.immediate();
  database.exec(`
    INSERT INTO store_migrations(name, completed_at_ms)
      VALUES ('legacy-sentinel-v4', 31);
    INSERT INTO analysis_snapshots(snapshot_id, created_at_ms, record_json)
      VALUES ('snapshot-v4', 32, '{"schema":"v4"}');
    INSERT INTO analysis_executions(execution_id, snapshot_id, executed_at_ms)
      VALUES ('execution-v4', 'snapshot-v4', 33);
    INSERT INTO source_catalog(
      adapter_id, adapter_version, source_identity, canonical_path,
      device, inode, mtime_ms, size_bytes, prefix_hash, suffix_hash,
      content_revision, discovery_cursor, last_parsed_offset,
      last_normalized_event_index, parser_version, schema_fingerprint,
      observed_at_ms, completeness
    ) VALUES (
      'codex', '1.0.0', 'source-' || lower(hex(zeroblob(32))), '/repo/v4.jsonl',
      4, 5, 6, 8, 'sha256:' || lower(hex(zeroblob(32))),
      'sha256:' || lower(hex(zeroblob(32))),
      'sha256:' || lower(hex(zeroblob(32))), 9, 8, 10,
      'parser-v4', 'sha256:' || lower(hex(zeroblob(32))), 11, 'complete'
    );
  `);
  insertBudgetRow(database, "execution-v4", budgetResult());
  return database;
}

function assertPopulatedV4Rows(database: StoreDatabase): void {
  assert.deepEqual(database.prepare(
    "SELECT name, completed_at_ms FROM store_migrations WHERE name = ?",
  ).get("legacy-sentinel-v4"), {
    name: "legacy-sentinel-v4",
    completed_at_ms: 31,
  });
  assert.deepEqual(database.prepare(
    "SELECT snapshot_id, created_at_ms, record_json FROM analysis_snapshots",
  ).get(), {
    snapshot_id: "snapshot-v4",
    created_at_ms: 32,
    record_json: '{"schema":"v4"}',
  });
  assert.deepEqual(database.prepare(
    "SELECT execution_id, snapshot_id, executed_at_ms FROM analysis_executions",
  ).get(), {
    execution_id: "execution-v4",
    snapshot_id: "snapshot-v4",
    executed_at_ms: 33,
  });
  assert.deepEqual(database.prepare(`SELECT adapter_id, canonical_path,
    size_bytes, last_parsed_offset, parser_version, observed_at_ms,
    completeness FROM source_catalog`).get(), {
    adapter_id: "codex",
    canonical_path: "/repo/v4.jsonl",
    size_bytes: 8,
    last_parsed_offset: 8,
    parser_version: "parser-v4",
    observed_at_ms: 11,
    completeness: "complete",
  });
  assert.deepEqual(database.prepare(`SELECT ${BUDGET_ROW_COLUMNS.join(", ")}
    FROM analysis_budget_runs WHERE execution_id = ?`).get("execution-v4"),
  storedBudgetRow("execution-v4", budgetResult()));
}

test("canonicalRepoPath resolves a linked git worktree to the main worktree's repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-worktree-canon-"));
  try {
    const mainRepo = join(root, "main");
    await mkdir(mainRepo);
    git(["init", "-q"], mainRepo);
    git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"], mainRepo);

    const worktreePath = join(root, "worktree");
    git(["worktree", "add", "-q", "-b", "worktree-branch", worktreePath], mainRepo);

    const expected = (await realpath(mainRepo)).normalize("NFC");
    assert.equal(await canonicalRepoPath(mainRepo), expected);
    assert.equal(await canonicalRepoPath(worktreePath), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonicalRepoPath unifies worktrees of a separate-git-dir repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-separate-gitdir-canon-"));
  try {
    const mainRepo = join(root, "main");
    const gitDir = join(root, "shared-git-dir");
    await mkdir(mainRepo);
    git(["init", "-q", `--separate-git-dir=${gitDir}`], mainRepo);
    git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"], mainRepo);

    const worktreePath = join(root, "worktree");
    git(["worktree", "add", "-q", "-b", "separate-worktree-branch", worktreePath], mainRepo);

    assert.equal(
      await canonicalRepoPath(worktreePath),
      await canonicalRepoPath(mainRepo),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonicalRepoPath falls back to a realpath when the directory is not a git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-non-git-canon-"));
  try {
    const plain = join(root, "not-a-repo");
    await mkdir(plain);
    const expected = (await realpath(plain)).normalize("NFC");
    assert.equal(await canonicalRepoPath(plain), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store paths hash the canonical repository and honor data-root precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-path-test-"));
  try {
    const repo = join(root, "repo");
    const alias = join(root, "repo-alias");
    await mkdir(repo);
    await symlink(repo, alias);
    const canonical = await realpath(repo);
    assert.equal(await canonicalRepoPath(alias), canonical.normalize("NFC"));
    assert.equal(
      repoHash(canonical),
      createHash("sha256").update(canonical).digest("hex"),
    );

    const explicit = await resolveStorePaths(alias, {
      env: {
        CCPROF_DATA_DIR: join(root, "explicit"),
        XDG_DATA_HOME: join(root, "xdg"),
      },
      home_dir: join(root, "home"),
    });
    assert.equal(
      explicit.repo_dir,
      join(root, "explicit", repoHash(canonical)),
    );

    const xdg = await resolveStorePaths(repo, {
      env: { XDG_DATA_HOME: join(root, "xdg") },
      home_dir: join(root, "home"),
    });
    assert.equal(xdg.repo_dir, join(root, "xdg", "ccprof", repoHash(canonical)));

    const fallback = await resolveStorePaths(repo, {
      env: {},
      home_dir: join(root, "home"),
    });
    assert.equal(
      fallback.repo_dir,
      join(root, "home", ".local", "share", "ccprof", repoHash(canonical)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite paths are deterministic and shared by linked worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-sqlite-path-"));
  try {
    const mainRepo = join(root, "main");
    await mkdir(mainRepo);
    git(["init", "-q"], mainRepo);
    git(["-c", "user.email=test@example.com", "-c", "user.name=Test",
      "commit", "--allow-empty", "-q", "-m", "init"], mainRepo);
    const worktree = join(root, "worktree");
    git(["worktree", "add", "-q", "-b", "sqlite-path", worktree], mainRepo);

    const options = { env: { CCPROF_DATA_DIR: join(root, "data") } };
    const mainPaths = await resolveStorePaths(mainRepo, options);
    const worktreePaths = await resolveStorePaths(worktree, options);
    assert.equal(mainPaths.repo_dir, worktreePaths.repo_dir);
    assert.equal(storeDatabasePath(mainPaths), join(mainPaths.repo_dir, "store.sqlite3"));
    assert.equal(storeDatabasePath(worktreePaths), storeDatabasePath(mainPaths));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite bootstrap is private, idempotent, and creates the exact Store v5 schema", async () => {
  await temporaryStore(async (paths) => {
    assert.equal(STORE_SCHEMA_VERSION, 5);
    const databasePath = storeDatabasePath(paths);
    const first = openStoreDatabase(paths);
    const second = openStoreDatabase(paths);
    try {
      assertConnectionPragmas(first);
      assertConnectionPragmas(second);
      assert.equal(Number(first.pragma("user_version", { simple: true })), 5);
      assert.equal(Number(second.pragma("user_version", { simple: true })), 5);

      if (process.platform !== "win32") {
        assert.equal((await stat(paths.repo_dir)).mode & 0o777, 0o700);
        assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
      }

      const tables = first.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as { name: string }[];
      assert.deepEqual(tables.map(({ name }) => name), [
        "adoptions",
        "analysis_budget_runs",
        "analysis_executions",
        "analysis_snapshots",
        "dismissals",
        "source_catalog",
        "source_discovery_roots",
        "source_evidence_cache",
        "store_migrations",
      ]);

      assert.deepEqual(userIndexColumns(first, "analysis_snapshots"), [["created_at_ms"]]);
      assert.deepEqual(userIndexColumns(first, "analysis_executions"), [
        ["executed_at_ms"],
        ["snapshot_id", "executed_at_ms"],
      ]);
      assert.deepEqual(userIndexColumns(first, "dismissals"), [["dismissed_at_ms"]]);
      assert.deepEqual(userIndexColumns(first, "adoptions"), [["detected_at_ms"]]);

      const expectedColumns: Record<string, [string, string, number][]> = {
        store_migrations: [
          ["name", "TEXT", 1],
          ["completed_at_ms", "INTEGER", 0],
        ],
        analysis_snapshots: [
          ["snapshot_id", "TEXT", 1],
          ["created_at_ms", "INTEGER", 0],
          ["record_json", "TEXT", 0],
        ],
        analysis_executions: [
          ["execution_id", "TEXT", 1],
          ["snapshot_id", "TEXT", 0],
          ["executed_at_ms", "INTEGER", 0],
        ],
        analysis_budget_runs: [
          ["execution_id", "TEXT", 1],
          ["max_input_bytes", "INTEGER", 0],
          ["max_input_events", "INTEGER", 0],
          ["max_wall_ms", "INTEGER", 0],
          ["max_cpu_ms", "INTEGER", 0],
          ["max_output_bytes", "INTEGER", 0],
          ["max_source_items", "INTEGER", 0],
          ["consumed_input_bytes", "INTEGER", 0],
          ["consumed_input_events", "INTEGER", 0],
          ["consumed_wall_ms", "INTEGER", 0],
          ["consumed_cpu_ms", "INTEGER", 0],
          ["consumed_output_bytes", "INTEGER", 0],
          ["consumed_source_items", "INTEGER", 0],
          ["observed_input_bytes", "INTEGER", 0],
          ["observed_input_events", "INTEGER", 0],
          ["observed_wall_ms", "INTEGER", 0],
          ["observed_cpu_ms", "INTEGER", 0],
          ["observed_output_bytes", "INTEGER", 0],
          ["observed_source_items", "INTEGER", 0],
          ["completeness", "TEXT", 0],
          ["truncation_reason", "TEXT", 0],
          ["coverage", "REAL", 0],
        ],
        dismissals: [
          ["finding_key", "TEXT", 1],
          ["dismissed_at_ms", "INTEGER", 0],
          ["record_json", "TEXT", 0],
        ],
        adoptions: [
          ["finding_key", "TEXT", 1],
          ["detected_at_ms", "INTEGER", 0],
          ["record_json", "TEXT", 0],
        ],
        source_catalog: [
          ["adapter_id", "TEXT", 0],
          ["adapter_version", "TEXT", 0],
          ["source_identity", "TEXT", 1],
          ["canonical_path", "TEXT", 0],
          ["device", "INTEGER", 0],
          ["inode", "INTEGER", 0],
          ["mtime_ms", "INTEGER", 0],
          ["size_bytes", "INTEGER", 0],
          ["prefix_hash", "TEXT", 0],
          ["suffix_hash", "TEXT", 0],
          ["content_revision", "TEXT", 0],
          ["discovery_cursor", "INTEGER", 0],
          ["last_parsed_offset", "INTEGER", 0],
          ["last_normalized_event_index", "INTEGER", 0],
          ["parser_version", "TEXT", 0],
          ["schema_fingerprint", "TEXT", 0],
          ["observed_at_ms", "INTEGER", 0],
          ["completeness", "TEXT", 0],
        ],
        source_discovery_roots: [
          ["root_identity", "TEXT", 1],
          ["adapter_id", "TEXT", 0],
          ["canonical_root", "TEXT", 0],
          ["cursor", "INTEGER", 0],
          ["capability", "TEXT", 0],
          ["tree_json", "TEXT", 0],
          ["tree_digest", "TEXT", 0],
          ["observed_at_ms", "INTEGER", 0],
          ["completeness", "TEXT", 0],
          ["sensitivity", "TEXT", 0],
          ["retention_class", "TEXT", 0],
        ],
        source_evidence_cache: [
          ["source_identity", "TEXT", 1],
          ["repository_identity", "TEXT", 0],
          ["eligibility_identity", "TEXT", 2],
          ["adapter_id", "TEXT", 0],
          ["canonical_path", "TEXT", 0],
          ["content_revision", "TEXT", 0],
          ["parser_version", "TEXT", 0],
          ["schema_fingerprint", "TEXT", 0],
          ["last_parsed_offset", "INTEGER", 0],
          ["line_count", "INTEGER", 0],
          ["ends_with_newline", "INTEGER", 0],
          ["payload_json", "TEXT", 0],
          ["payload_digest", "TEXT", 0],
          ["descriptor_digest", "TEXT", 0],
          ["sensitivity", "TEXT", 0],
          ["retention_class", "TEXT", 0],
          ["updated_at_ms", "INTEGER", 0],
        ],
      };
      for (const [table, expected] of Object.entries(expectedColumns)) {
        const columns = tableColumns(first, table);
        assert.deepEqual(
          columns.map(({ name, type, pk }) => [name, type.toUpperCase(), pk]),
          expected,
        );
        const nullable = table === "source_catalog"
          ? new Set(["device", "inode"])
          : table === "analysis_budget_runs"
          ? new Set(["truncation_reason"])
          : new Set();
        assert.ok(columns.every(({ name, notnull }) =>
          notnull === (nullable.has(name) ? 0 : 1)
        ));
      }

      assert.deepEqual(userIndexColumns(first, "source_catalog"), []);
      assert.deepEqual(userIndexColumns(first, "source_evidence_cache"), []);
      assert.deepEqual(userIndexColumns(first, "source_discovery_roots"), []);
      assert.equal(first.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v3-source-catalog"), 1);
      assert.equal(first.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v4-analysis-budgets"), 1);
      assert.equal(first.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 1);

      const foreignKeys = first
        .prepare("PRAGMA foreign_key_list(analysis_executions)")
        .all() as { table: string; from: string; to: string; on_delete: string }[];
      assert.deepEqual(foreignKeys.map(({ table, from, to, on_delete }) => ({
        table, from, to, on_delete,
      })), [{
        table: "analysis_snapshots",
        from: "snapshot_id",
        to: "snapshot_id",
        on_delete: "CASCADE",
      }]);

      const budgetForeignKeys = first
        .prepare("PRAGMA foreign_key_list(analysis_budget_runs)")
        .all() as { table: string; from: string; to: string; on_delete: string }[];
      assert.deepEqual(budgetForeignKeys.map(({ table, from, to, on_delete }) => ({
        table, from, to, on_delete,
      })), [{
        table: "analysis_executions",
        from: "execution_id",
        to: "execution_id",
        on_delete: "CASCADE",
      }]);

      const evidenceForeignKeys = first
        .prepare("PRAGMA foreign_key_list(source_evidence_cache)")
        .all() as { table: string; from: string; to: string; on_delete: string }[];
      assert.deepEqual(evidenceForeignKeys.map(({ table, from, to, on_delete }) => ({
        table, from, to, on_delete,
      })), [{
        table: "source_catalog",
        from: "source_identity",
        to: "source_identity",
        on_delete: "CASCADE",
      }]);
      assert.deepEqual(
        first.prepare("PRAGMA foreign_key_list(source_discovery_roots)").all(),
        [],
      );
    } finally {
      second.close();
      first.close();
    }
  });
});

test("Store v5 incremental source rows enforce identities, bounds, labels, and catalog ownership", async () => {
  await temporaryStore(async (paths) => {
    const database = openStoreDatabase(paths);
    const sourceIdentity = `source-${"0".repeat(64)}`;
    try {
      database.prepare(`INSERT INTO source_catalog(
        adapter_id, adapter_version, source_identity, canonical_path,
        device, inode, mtime_ms, size_bytes, prefix_hash, suffix_hash,
        content_revision, discovery_cursor, last_parsed_offset,
        last_normalized_event_index, parser_version, schema_fingerprint,
        observed_at_ms, completeness
      ) VALUES (
        'claude', '1.0.0', ?, '/repo/source.jsonl', 1, 2, 3, 0,
        'sha256:' || lower(hex(zeroblob(32))),
        'sha256:' || lower(hex(zeroblob(32))),
        'sha256:' || lower(hex(zeroblob(32))), 1, 0, 0, '2.0.0',
        'sha256:' || lower(hex(zeroblob(32))), 4, 'complete'
      )`).run(sourceIdentity);
      database.prepare(`INSERT INTO source_evidence_cache(
        source_identity, repository_identity, eligibility_identity,
        adapter_id, canonical_path, content_revision, parser_version,
        schema_fingerprint, last_parsed_offset, line_count, ends_with_newline,
        payload_json, payload_digest, descriptor_digest, sensitivity,
        retention_class, updated_at_ms
      ) VALUES (
        @source_identity, @repository_identity, @eligibility_identity,
        'claude', '/repo/source.jsonl', 'sha256:' || lower(hex(zeroblob(32))),
        '2.0.0', 'sha256:' || lower(hex(zeroblob(32))), 0, 0, 1,
        '{"schema_version":1}', 'sha256:' || lower(hex(zeroblob(32))),
        'sha256:' || lower(hex(zeroblob(32))), 'sensitive', 'raw_evidence', 4
      )`).run({
        source_identity: sourceIdentity,
        repository_identity: "1".repeat(64),
        eligibility_identity: "2".repeat(64),
      });
      database.prepare(`INSERT INTO source_discovery_roots(
        root_identity, adapter_id, canonical_root, cursor, capability,
        tree_json, tree_digest, observed_at_ms, completeness, sensitivity,
        retention_class
      ) VALUES (
        @root_identity, 'claude', '/repo/.claude', 1, 'full_scan_required',
        '{"schema_version":1}', 'sha256:' || lower(hex(zeroblob(32))), 4,
        'complete', 'sensitive', 'source_metadata'
      )`).run({ root_identity: `root-${"3".repeat(64)}` });

      for (const [column, value] of [
        ["repository_identity", "A".repeat(64)],
        ["eligibility_identity", "2".repeat(63)],
        ["adapter_id", "other"],
        ["canonical_path", ""],
        ["canonical_path", "/repo/secret\0path"],
        ["content_revision", `sha256:${"A".repeat(64)}`],
        ["parser_version", ""],
        ["schema_fingerprint", `sha256:${"a".repeat(63)}`],
        ["last_parsed_offset", -1],
        ["line_count", 0.5],
        ["ends_with_newline", 2],
        ["payload_json", ""],
        ["payload_digest", `sha256:${"A".repeat(64)}`],
        ["descriptor_digest", `sha256:${"b".repeat(63)}`],
        ["sensitivity", "public"],
        ["retention_class", "metadata"],
        ["updated_at_ms", -1],
      ] as const) {
        assert.throws(
          () => database.prepare(`UPDATE source_evidence_cache
            SET ${column} = ?`).run(value),
          /constraint/iu,
          `source_evidence_cache.${column}`,
        );
      }

      for (const [column, value] of [
        ["root_identity", `root-${"A".repeat(64)}`],
        ["adapter_id", "other"],
        ["canonical_root", ""],
        ["canonical_root", "/repo/secret\0root"],
        ["cursor", -1],
        ["capability", "unknown"],
        ["tree_json", ""],
        ["tree_digest", `sha256:${"A".repeat(64)}`],
        ["observed_at_ms", 0.5],
        ["completeness", "unknown"],
        ["sensitivity", "public"],
        ["retention_class", "raw_evidence"],
      ] as const) {
        assert.throws(
          () => database.prepare(`UPDATE source_discovery_roots
            SET ${column} = ?`).run(value),
          /constraint/iu,
          `source_discovery_roots.${column}`,
        );
      }

      assert.throws(() => database.prepare(`INSERT INTO source_evidence_cache(
        source_identity, repository_identity, eligibility_identity,
        adapter_id, canonical_path, content_revision, parser_version,
        schema_fingerprint, last_parsed_offset, line_count, ends_with_newline,
        payload_json, payload_digest, descriptor_digest, sensitivity,
        retention_class, updated_at_ms
      ) SELECT
        ?, repository_identity, '4' || substr(eligibility_identity, 2),
        adapter_id, canonical_path, content_revision, parser_version,
        schema_fingerprint, last_parsed_offset, line_count, ends_with_newline,
        payload_json, payload_digest, descriptor_digest, sensitivity,
        retention_class, updated_at_ms
      FROM source_evidence_cache`).run(`source-${"f".repeat(64)}`), /constraint/iu);

      database.prepare("DELETE FROM source_catalog WHERE source_identity = ?")
        .run(sourceIdentity);
      assert.equal(database.prepare(
        "SELECT count(*) FROM source_evidence_cache",
      ).pluck().get(), 0);
    } finally {
      database.close();
    }
  });
});

test("Store v4 budget rows enforce typed counters, result state, and execution ownership", async () => {
  await temporaryStore(async (paths) => {
    const database = openStoreDatabase(paths);
    try {
      database.prepare(`INSERT INTO analysis_snapshots
        (snapshot_id, created_at_ms, record_json) VALUES (?, ?, ?)`)
        .run("budget-constraints-snapshot", 1, "{}");
      database.prepare(`INSERT INTO analysis_executions
        (execution_id, snapshot_id, executed_at_ms) VALUES (?, ?, ?)`)
        .run("budget-constraints", "budget-constraints-snapshot", 1);
      insertBudgetRow(database, "budget-constraints", budgetResult("partial"));

      assert.throws(() => database.prepare(`UPDATE analysis_budget_runs
        SET max_input_bytes = -1 WHERE execution_id = ?`)
        .run("budget-constraints"), /constraint/iu);
      assert.throws(() => database.prepare(`UPDATE analysis_budget_runs
        SET consumed_input_events = 0.5 WHERE execution_id = ?`)
        .run("budget-constraints"), /constraint/iu);
      assert.throws(() => database.prepare(`UPDATE analysis_budget_runs
        SET truncation_reason = 'raw-secret' WHERE execution_id = ?`)
        .run("budget-constraints"), /constraint/iu);
      assert.throws(() => database.prepare(`UPDATE analysis_budget_runs
        SET coverage = 2 WHERE execution_id = ?`)
        .run("budget-constraints"), /constraint/iu);
      assert.throws(() => database.prepare(`UPDATE analysis_budget_runs
        SET completeness = 'complete' WHERE execution_id = ?`)
        .run("budget-constraints"), /constraint/iu);
      assert.throws(() => insertBudgetRow(
        database,
        "missing-execution",
        budgetResult(),
      ), /constraint/iu);

      database.prepare("DELETE FROM analysis_executions WHERE execution_id = ?")
        .run("budget-constraints");
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_budget_runs",
      ).pluck().get(), 0);
    } finally {
      database.close();
    }
  });
});

test("SQLite connections share commits and immediate transactions roll back completely", async () => {
  await temporaryStore(async (paths) => {
    const first = openStoreDatabase(paths);
    const second = openStoreDatabase(paths);
    try {
      first.prepare(
        "INSERT INTO analysis_snapshots(snapshot_id, created_at_ms, record_json) VALUES (?, ?, ?)",
      ).run("snapshot-a", 1, "{\"snapshot\":true}");
      assert.deepEqual(second.prepare(
        "SELECT snapshot_id, record_json FROM analysis_snapshots WHERE snapshot_id = ?",
      ).get("snapshot-a"), {
        snapshot_id: "snapshot-a",
        record_json: "{\"snapshot\":true}",
      });

      const failMigration = first.transaction(() => {
        first.prepare(
          "INSERT INTO store_migrations(name, completed_at_ms) VALUES (?, ?)",
        ).run("test-rollback-marker", 2);
        throw new Error("rollback requested");
      });
      assert.throws(() => failMigration.immediate(), /rollback requested/u);
      assert.equal(first.prepare(
        "SELECT 1 FROM store_migrations WHERE name = ?",
      ).get("test-rollback-marker"), undefined);
      assert.equal(second.prepare(
        "SELECT 1 FROM store_migrations WHERE name = ?",
      ).get("test-rollback-marker"), undefined);
    } finally {
      second.close();
      first.close();
    }
  });
});

test("opening an existing v5 schema does not contend with an active writer", async () => {
  await temporaryStore(async (paths) => {
    const writer = openStoreDatabase(paths);
    let reader: StoreDatabase | undefined;
    try {
      assert.equal(Number(writer.pragma("user_version", { simple: true })), 5);
      writer.exec("BEGIN IMMEDIATE");
      reader = openStoreDatabase(paths);
      reader.close();
      reader = undefined;
    } finally {
      reader?.close();
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

test("two simultaneous Store v4 opens serialize one exact v5 migration", async () => {
  await temporaryStore(async (paths) => {
    const v4 = populatedV4Store(paths);
    v4.close();

    const moduleUrl = new URL("../src/store/sqlite.js", import.meta.url).href;
    const versions = await runConcurrentStoreWrites<number>(paths, [
      { moduleUrl, exportName: "openStoreDatabase", args: [] },
      { moduleUrl, exportName: "openStoreDatabase", args: [] },
    ]);
    assert.deepEqual(versions, [5, 5]);

    const migrated = openStoreDatabase(paths);
    try {
      assert.equal(Number(migrated.pragma("user_version", { simple: true })), 5);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 1);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM source_catalog WHERE canonical_path = ?",
      ).pluck().get("/repo/v4.jsonl"), 1);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM analysis_budget_runs WHERE execution_id = ?",
      ).pluck().get("execution-v4"), 1);
    } finally {
      migrated.close();
    }
  });
});

test("a populated Store v2 migrates transactionally through v3 and v4 to v5 without data loss", async () => {
  await temporaryStore(async (paths) => {
    populatedV2Store(paths).close();

    const migrated = openStoreDatabase(paths);
    const reopened = openStoreDatabase(paths);
    try {
      assert.equal(Number(migrated.pragma("user_version", { simple: true })), 5);
      assert.equal(Number(reopened.pragma("user_version", { simple: true })), 5);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'source_catalog'",
      ).pluck().get(), 1);
      const migrations = migrated.prepare(
        "SELECT name, completed_at_ms FROM store_migrations ORDER BY name",
      ).all() as { name: string; completed_at_ms: number }[];
      assert.deepEqual(migrations.map(({ name }) => name), [
        "legacy-sentinel",
        "schema-v3-source-catalog",
        "schema-v4-analysis-budgets",
        INCREMENTAL_SOURCES_MIGRATION,
      ]);
      assert.equal(migrations[0]?.completed_at_ms, 11);
      assert.ok(Number.isSafeInteger(migrations[1]?.completed_at_ms));
      assert.ok((migrations[1]?.completed_at_ms ?? -1) >= 0);
      assert.ok(Number.isSafeInteger(migrations[2]?.completed_at_ms));
      assert.ok((migrations[2]?.completed_at_ms ?? -1) >= 0);
      assert.ok(Number.isSafeInteger(migrations[3]?.completed_at_ms));
      assert.ok((migrations[3]?.completed_at_ms ?? -1) >= 0);
      assert.deepEqual(migrated.prepare(
        "SELECT snapshot_id, created_at_ms, record_json FROM analysis_snapshots",
      ).get(), {
        snapshot_id: "snapshot-v2",
        created_at_ms: 12,
        record_json: '{"schema":"v2"}',
      });
      assert.deepEqual(migrated.prepare(
        "SELECT execution_id, snapshot_id, executed_at_ms FROM analysis_executions",
      ).get(), {
        execution_id: "execution-v2",
        snapshot_id: "snapshot-v2",
        executed_at_ms: 13,
      });
      assert.equal(migrated.prepare("SELECT count(*) FROM dismissals").pluck().get(), 1);
      assert.equal(migrated.prepare("SELECT count(*) FROM adoptions").pluck().get(), 1);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v3-source-catalog"), 1);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v4-analysis-budgets"), 1);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'analysis_budget_runs'",
      ).pluck().get(), 1);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 1);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('source_evidence_cache', 'source_discovery_roots')",
      ).pluck().get(), 2);
    } finally {
      reopened.close();
      migrated.close();
    }
  });
});

test("Store v2 migration failure rolls back both new tables, markers, version, and preserves rows", async () => {
  await temporaryStore(async (paths) => {
    const v2 = populatedV2Store(paths);
    try {
      v2.exec(`
        CREATE TRIGGER fail_analysis_budgets_migration
        BEFORE INSERT ON store_migrations
        WHEN NEW.name = 'schema-v4-analysis-budgets'
        BEGIN
          SELECT RAISE(ABORT, 'forced Store v4 migration failure');
        END;
      `);

      assert.throws(
        () => openStoreDatabase(paths),
        /forced Store v4 migration failure/u,
      );
      assert.equal(Number(v2.pragma("user_version", { simple: true })), 2);
      assert.equal(v2.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'source_catalog'",
      ).pluck().get(), 0);
      assert.equal(v2.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v3-source-catalog"), 0);
      assert.equal(v2.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'analysis_budget_runs'",
      ).pluck().get(), 0);
      assert.equal(v2.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v4-analysis-budgets"), 0);
      assert.equal(v2.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('source_evidence_cache', 'source_discovery_roots')",
      ).pluck().get(), 0);
      assert.equal(v2.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 0);
      assert.equal(v2.prepare(
        "SELECT record_json FROM analysis_snapshots WHERE snapshot_id = ?",
      ).pluck().get("snapshot-v2"), '{"schema":"v2"}');

      v2.exec("DROP TRIGGER fail_analysis_budgets_migration");
    } finally {
      v2.close();
    }

    const retried = openStoreDatabase(paths);
    try {
      assert.equal(Number(retried.pragma("user_version", { simple: true })), 5);
      assert.equal(retried.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v3-source-catalog"), 1);
      assert.equal(retried.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v4-analysis-budgets"), 1);
      assert.equal(retried.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 1);
      assert.equal(retried.prepare("SELECT count(*) FROM analysis_snapshots").pluck().get(), 1);
    } finally {
      retried.close();
    }
  });
});

test("a populated Store v3 migrates transactionally through v4 to v5 and reopens idempotently", async () => {
  await temporaryStore(async (paths) => {
    populatedV3Store(paths).close();

    const migrated = openStoreDatabase(paths);
    const reopened = openStoreDatabase(paths);
    try {
      assert.equal(Number(migrated.pragma("user_version", { simple: true })), 5);
      assert.equal(Number(reopened.pragma("user_version", { simple: true })), 5);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM source_catalog WHERE canonical_path = ?",
      ).pluck().get("/repo/v3.jsonl"), 1);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'analysis_budget_runs'",
      ).pluck().get(), 1);
      assert.deepEqual(migrated.prepare(
        "SELECT name FROM store_migrations ORDER BY name",
      ).pluck().all(), [
        "legacy-sentinel-v3",
        "schema-v3-source-catalog",
        "schema-v4-analysis-budgets",
        INCREMENTAL_SOURCES_MIGRATION,
      ]);
    } finally {
      reopened.close();
      migrated.close();
    }
  });
});

test("Store v3 migration failure rolls back budget table, marker, and version without data loss", async () => {
  await temporaryStore(async (paths) => {
    const v3 = populatedV3Store(paths);
    try {
      v3.prepare(`INSERT INTO analysis_snapshots
        (snapshot_id, created_at_ms, record_json) VALUES (?, ?, ?)`)
        .run("snapshot-v3", 22, '{"schema":"v3"}');
      v3.prepare(`INSERT INTO analysis_executions
        (execution_id, snapshot_id, executed_at_ms) VALUES (?, ?, ?)`)
        .run("execution-v3", "snapshot-v3", 23);
      v3.exec(`
        CREATE TRIGGER fail_analysis_budgets_migration
        BEFORE INSERT ON store_migrations
        WHEN NEW.name = 'schema-v4-analysis-budgets'
        BEGIN
          SELECT RAISE(ABORT, 'forced Store v4 migration failure');
        END;
      `);

      assert.throws(
        () => openStoreDatabase(paths),
        /forced Store v4 migration failure/u,
      );
      assert.equal(Number(v3.pragma("user_version", { simple: true })), 3);
      assert.equal(v3.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'analysis_budget_runs'",
      ).pluck().get(), 0);
      assert.equal(v3.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v4-analysis-budgets"), 0);
      assert.equal(v3.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('source_evidence_cache', 'source_discovery_roots')",
      ).pluck().get(), 0);
      assert.equal(v3.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 0);
      assert.equal(v3.prepare(
        "SELECT record_json FROM analysis_snapshots WHERE snapshot_id = ?",
      ).pluck().get("snapshot-v3"), '{"schema":"v3"}');
      assert.equal(v3.prepare(
        "SELECT count(*) FROM source_catalog WHERE canonical_path = ?",
      ).pluck().get("/repo/v3.jsonl"), 1);

      v3.exec("DROP TRIGGER fail_analysis_budgets_migration");
    } finally {
      v3.close();
    }

    const retried = openStoreDatabase(paths);
    try {
      assert.equal(Number(retried.pragma("user_version", { simple: true })), 5);
      assert.equal(retried.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("schema-v4-analysis-budgets"), 1);
      assert.equal(retried.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 1);
      assert.equal(retried.prepare(
        "SELECT count(*) FROM analysis_executions WHERE execution_id = ?",
      ).pluck().get("execution-v3"), 1);
      assert.equal(retried.prepare(
        "SELECT count(*) FROM source_catalog WHERE canonical_path = ?",
      ).pluck().get("/repo/v3.jsonl"), 1);
    } finally {
      retried.close();
    }
  });
});

test("a populated Store v4 migrates additively to v5 without rewriting rows", async () => {
  await temporaryStore(async (paths) => {
    const v4 = populatedV4Store(paths);
    assertPopulatedV4Rows(v4);
    v4.close();

    const migrated = openStoreDatabase(paths);
    const reopened = openStoreDatabase(paths);
    try {
      assert.equal(Number(migrated.pragma("user_version", { simple: true })), 5);
      assert.equal(Number(reopened.pragma("user_version", { simple: true })), 5);
      assertPopulatedV4Rows(migrated);
      assert.deepEqual(migrated.prepare(
        "SELECT name FROM store_migrations ORDER BY name",
      ).pluck().all(), [
        "legacy-sentinel-v4",
        "schema-v3-source-catalog",
        "schema-v4-analysis-budgets",
        INCREMENTAL_SOURCES_MIGRATION,
      ]);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM source_evidence_cache",
      ).pluck().get(), 0);
      assert.equal(migrated.prepare(
        "SELECT count(*) FROM source_discovery_roots",
      ).pluck().get(), 0);
    } finally {
      reopened.close();
      migrated.close();
    }
  });
});

test("Store v4 migration rolls back the first v5 table when the second table creation fails", async () => {
  await temporaryStore(async (paths) => {
    const v4 = populatedV4Store(paths);
    try {
      v4.exec("CREATE TABLE source_discovery_roots(blocker TEXT NOT NULL)");

      assert.throws(
        () => openStoreDatabase(paths),
        /source_discovery_roots.*already exists|already exists.*source_discovery_roots/iu,
      );
      assert.equal(Number(v4.pragma("user_version", { simple: true })), 4);
      assert.equal(v4.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'source_evidence_cache'",
      ).pluck().get(), 0);
      assert.deepEqual(
        tableColumns(v4, "source_discovery_roots").map(({ name }) => name),
        ["blocker"],
      );
      assert.equal(v4.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 0);
      assertPopulatedV4Rows(v4);

      v4.exec("DROP TABLE source_discovery_roots");
    } finally {
      v4.close();
    }

    const retried = openStoreDatabase(paths);
    try {
      assert.equal(Number(retried.pragma("user_version", { simple: true })), 5);
      assertPopulatedV4Rows(retried);
    } finally {
      retried.close();
    }
  });
});

test("Store v4 migration rolls back both v5 tables when its marker insert fails", async () => {
  await temporaryStore(async (paths) => {
    const v4 = populatedV4Store(paths);
    try {
      v4.exec(`
        CREATE TRIGGER fail_incremental_sources_marker
        BEFORE INSERT ON store_migrations
        WHEN NEW.name = '${INCREMENTAL_SOURCES_MIGRATION}'
        BEGIN
          SELECT RAISE(ABORT, 'forced Store v5 marker failure');
        END;
      `);

      assert.throws(
        () => openStoreDatabase(paths),
        /forced Store v5 marker failure/u,
      );
      assert.equal(Number(v4.pragma("user_version", { simple: true })), 4);
      assert.equal(v4.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('source_evidence_cache', 'source_discovery_roots')",
      ).pluck().get(), 0);
      assert.equal(v4.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 0);
      assertPopulatedV4Rows(v4);

      v4.exec("DROP TRIGGER fail_incremental_sources_marker");
    } finally {
      v4.close();
    }

    const retried = openStoreDatabase(paths);
    try {
      assert.equal(Number(retried.pragma("user_version", { simple: true })), 5);
      assertPopulatedV4Rows(retried);
    } finally {
      retried.close();
    }
  });
});

test("Store v4 migration rolls back tables, marker, and version when commit fails", async () => {
  await temporaryStore(async (paths) => {
    const v4 = populatedV4Store(paths);
    try {
      v4.exec(`
        CREATE TABLE migration_failure_parent(id INTEGER PRIMARY KEY);
        CREATE TABLE migration_failure_child(
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL,
          FOREIGN KEY(parent_id) REFERENCES migration_failure_parent(id)
            DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER fail_incremental_sources_commit
        AFTER INSERT ON store_migrations
        WHEN NEW.name = '${INCREMENTAL_SOURCES_MIGRATION}'
        BEGIN
          INSERT INTO migration_failure_child(id, parent_id) VALUES (1, 999);
        END;
      `);

      assert.throws(() => openStoreDatabase(paths), /foreign key constraint/iu);
      assert.equal(Number(v4.pragma("user_version", { simple: true })), 4);
      assert.equal(v4.prepare(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN ('source_evidence_cache', 'source_discovery_roots')",
      ).pluck().get(), 0);
      assert.equal(v4.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get(INCREMENTAL_SOURCES_MIGRATION), 0);
      assert.equal(v4.prepare(
        "SELECT count(*) FROM migration_failure_child",
      ).pluck().get(), 0);
      assertPopulatedV4Rows(v4);

      v4.exec(`
        DROP TRIGGER fail_incremental_sources_commit;
        DROP TABLE migration_failure_child;
        DROP TABLE migration_failure_parent;
      `);
    } finally {
      v4.close();
    }

    const retried = openStoreDatabase(paths);
    try {
      assert.equal(Number(retried.pragma("user_version", { simple: true })), 5);
      assertPopulatedV4Rows(retried);
    } finally {
      retried.close();
    }
  });
});

test("SQLite bootstrap rejects a symlinked repository directory without touching its target", async (context) => {
  await temporaryStore(async (paths, root) => {
    const target = join(root, "repo-dir-target");
    const sentinel = join(target, "sentinel.txt");
    await mkdir(paths.root_dir, { recursive: true });
    await mkdir(target, { mode: 0o755 });
    await writeFile(sentinel, "preserve-directory-target", "utf8");
    const targetMode = (await stat(target)).mode & 0o777;
    try {
      await symlink(target, paths.repo_dir, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EACCES", "ENOSYS", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )) {
        context.skip("symbolic links are unavailable on this platform");
        return;
      }
      throw error;
    }

    let opened: StoreDatabase | undefined;
    let rejected: unknown;
    try {
      opened = openStoreDatabase(paths);
    } catch (error) {
      rejected = error;
    } finally {
      opened?.close();
    }

    assert.equal(await readFile(sentinel, "utf8"), "preserve-directory-target");
    assert.deepEqual(await readdir(target), ["sentinel.txt"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(target)).mode & 0o777, targetMode);
    }
    assert.match(String(rejected), /unsafe store path|symbolic link.*not allowed/iu);
  });
});

test("SQLite bootstrap rejects a symlinked database without touching its target", async (context) => {
  await temporaryStore(async (paths, root) => {
    await mkdir(paths.repo_dir, { recursive: true, mode: 0o700 });
    const targetPaths: StorePaths = {
      ...paths,
      repo_dir: join(root, "database-target"),
    };
    const targetPath = storeDatabasePath(targetPaths);
    const target = openStoreDatabase(targetPaths);
    try {
      target.exec(
        "CREATE TABLE symlink_sentinel(value TEXT NOT NULL); INSERT INTO symlink_sentinel VALUES ('preserve-database-target')",
      );
      target.pragma("wal_checkpoint(TRUNCATE)");
      if (process.platform !== "win32") await chmod(targetPath, 0o644);
      const targetMode = (await stat(targetPath)).mode & 0o777;
      const targetBytes = await readFile(targetPath);
      try {
        await symlink(targetPath, storeDatabasePath(paths), "file");
      } catch (error) {
        if (["EACCES", "ENOSYS", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )) {
          context.skip("symbolic links are unavailable on this platform");
          return;
        }
        throw error;
      }

      let opened: StoreDatabase | undefined;
      let rejected: unknown;
      try {
        opened = openStoreDatabase(paths);
      } catch (error) {
        rejected = error;
      } finally {
        opened?.close();
      }

      assert.equal(
        target.prepare("SELECT value FROM symlink_sentinel").pluck().get(),
        "preserve-database-target",
      );
      assert.deepEqual(await readFile(targetPath), targetBytes);
      if (process.platform !== "win32") {
        assert.equal((await stat(targetPath)).mode & 0o777, targetMode);
      }
      assert.deepEqual(await readdir(paths.repo_dir), ["store.sqlite3"]);
      assert.match(String(rejected), /unsafe store path|symbolic link.*not allowed/iu);
    } finally {
      target.close();
    }
  });
});

test("SQLite bootstrap rejects a v1 downgrade without mutation", async () => {
  await temporaryStore(async (paths) => {
    const downgraded = openStoreDatabase(paths);
    try {
      downgraded.exec(
        "CREATE TABLE downgrade_sentinel(value TEXT NOT NULL); INSERT INTO downgrade_sentinel VALUES ('preserve-me')",
      );
      downgraded.pragma("user_version = 1");

      assert.throws(() => openStoreDatabase(paths), (error: unknown) => {
        assert.ok(error instanceof UnsupportedStoreSchemaError);
        assert.equal(error.schema_version, 1);
        return true;
      });
      assert.equal(Number(downgraded.pragma("user_version", { simple: true })), 1);
      assert.equal(
        downgraded.prepare("SELECT value FROM downgrade_sentinel").pluck().get(),
        "preserve-me",
      );
    } finally {
      downgraded.close();
    }
  });
});

test("SQLite bootstrap rejects a negative schema without mutation", async () => {
  await temporaryStore(async (paths) => {
    const invalid = openStoreDatabase(paths);
    try {
      invalid.exec(
        "CREATE TABLE negative_sentinel(value TEXT NOT NULL); INSERT INTO negative_sentinel VALUES ('preserve-me')",
      );
      invalid.pragma("user_version = -1");

      assert.throws(() => openStoreDatabase(paths), (error: unknown) => {
        assert.ok(error instanceof UnsupportedStoreSchemaError);
        assert.equal(error.schema_version, -1);
        return true;
      });
      assert.equal(Number(invalid.pragma("user_version", { simple: true })), -1);
      assert.equal(
        invalid.prepare("SELECT value FROM negative_sentinel").pluck().get(),
        "preserve-me",
      );
    } finally {
      invalid.close();
    }
  });
});

test("SQLite bootstrap rejects unknown future schemas without mutation", async () => {
  await temporaryStore(async (paths) => {
    const futureVersion = STORE_SCHEMA_VERSION + 1;
    const future = openStoreDatabase(paths);
    try {
      future.exec(
        "CREATE TABLE future_sentinel(value TEXT NOT NULL); INSERT INTO future_sentinel VALUES ('preserve-me')",
      );
      future.pragma(`user_version = ${futureVersion}`);

      assert.throws(() => openStoreDatabase(paths), (error: unknown) => {
        assert.ok(error instanceof UnsupportedStoreSchemaError);
        assert.match(String(error), new RegExp(String(futureVersion), "u"));
        return true;
      });
      assert.equal(
        Number(future.pragma("user_version", { simple: true })),
        futureVersion,
      );
      assert.equal(
        future.prepare("SELECT value FROM future_sentinel").pluck().get(),
        "preserve-me",
      );
    } finally {
      future.close();
    }
  });
});

test("analysis snapshots ignore invocation identity while retaining every execution", async () => {
  await temporaryStore(async (paths) => {
    const first = record("first-execution", 100);
    const second = {
      ...first,
      analysis_id: "second-execution",
      created_at_ms: 200,
    };
    assert.deepEqual((await saveAnalysis(paths, second)).warnings, []);
    assert.deepEqual((await saveAnalysis(paths, first)).warnings, []);

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.records.length, 1);
    assert.deepEqual(loaded.records[0], first);

    const database = openStoreDatabase(paths);
    try {
      const snapshots = database.prepare(
        "SELECT snapshot_id, created_at_ms FROM analysis_snapshots",
      ).all() as { snapshot_id: string; created_at_ms: number }[];
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]?.created_at_ms, 100);
      assert.deepEqual(database.prepare(
        "SELECT execution_id, snapshot_id, executed_at_ms FROM analysis_executions ORDER BY executed_at_ms, execution_id",
      ).all(), [
        { execution_id: "first-execution", snapshot_id: snapshots[0]?.snapshot_id,
          executed_at_ms: 100 },
        { execution_id: "second-execution", snapshot_id: snapshots[0]?.snapshot_id,
          executed_at_ms: 200 },
      ]);
    } finally {
      database.close();
    }

    const files = await readdir(paths.repo_dir);
    assert.equal(files.some((path) => path.endsWith(".tmp")), false);
  });
});

test("rich snapshot input and normalized-result changes create distinct snapshots", async () => {
  await temporaryStore(async (paths) => {
    const first = record("first-input", 100);
    const second = { ...first, analysis_id: "second-input", created_at_ms: 200 };
    const changedResult = {
      ...first,
      analysis_id: "changed-result",
      created_at_ms: 300,
      summary: { ...first.summary, measured_min: 101 },
    };
    assert.deepEqual(
      (await saveAnalysis(paths, first, snapshotOptions("1".repeat(64)))).warnings,
      [],
    );
    assert.deepEqual(
      (await saveAnalysis(paths, second, snapshotOptions("2".repeat(64)))).warnings,
      [],
    );
    assert.deepEqual(
      (await saveAnalysis(paths, changedResult, snapshotOptions("1".repeat(64))))
        .warnings,
      [],
    );

    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 3);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 3);
    } finally {
      database.close();
    }
  });
});

test("snapshot envelopes retain authorized evidence but no rule policy material", async () => {
  await temporaryStore(async (paths) => {
    const approvalCanary = "STORE_UNMATCHED_APPROVAL_CANARY";
    const domainPatternCanary = "STORE_UNUSED_DOMAIN_PATTERN_CANARY";
    const domainNameCanary = "store-unused-domain-canary";
    const effective = resolveRuleSafetyPolicy(
      {
        safe_patterns: ["npm *", approvalCanary],
        allow_rule_recommendation: true,
      },
      [
        {
          match: ["npm *"],
          domain: "node-workspace",
          parallel_safe: true,
        },
        {
          match: [domainPatternCanary],
          domain: domainNameCanary,
          parallel_safe: false,
        },
      ],
    );
    const innerRuleSafetyDigest = analysisDigest(
      "effective-rule-safety-v1",
      canonicalRuleSafetySnapshot(effective),
    );
    const outerPolicyDigest = analysisDigest("analysis-policy-v1", {
      fingerprint: "ccprof-rule-policy-2026-08-04-v2",
      rule_safety_digest: innerRuleSafetyDigest,
    });
    const {
      impact: _r004Impact,
      finding_confidence: _r004Confidence,
      severity: _r004Severity,
      scoring_rationale: _r004Rationale,
      ...r004Base
    } = finding("authorized-r004");
    const {
      impact: _r005Impact,
      finding_confidence: _r005Confidence,
      severity: _r005Severity,
      scoring_rationale: _r005Rationale,
      ...r005Base
    } = finding("authorized-r005");
    const authorizedR004: Finding = {
      ...r004Base,
      rule_id: "R004",
      title: "Repeated safe approval latency",
      confidence: "medium",
      evidence: {
        session_refs: ["session#authorized-r004"],
        interval_ids: ["R004:authorized-r004"],
        latency_classification: "repeated_safe_approval_latency",
        canonical_commands: ["npm test"],
      },
      recoverable: { min: 10, bound: "upper" },
    };
    const authorizedR005: Finding = {
      ...r005Base,
      rule_id: "R005",
      title: "Path-disjoint tool calls ran serially",
      confidence: "medium",
      evidence: {
        session_refs: ["session#authorized-r005"],
        interval_ids: ["R005:authorized-r005"],
        parallelization_classification: "parallel_safe",
        resource_domain: "node-workspace",
      },
      recoverable: { min: 10, bound: "upper" },
    };
    const source = record("policy-envelope", 100);
    const storedRecord = makeAnalysisRecord({
      analysis_id: source.analysis_id,
      created_at_ms: source.created_at_ms,
      unit: source.unit,
      summary: source.summary,
      findings: [authorizedR004, authorizedR005],
      metrics: source.metrics,
      command_costs: [],
    });
    const snapshot = {
      ...snapshotOptions().snapshot,
      policy_digest: outerPolicyDigest,
    };

    assert.deepEqual(
      (await saveAnalysis(paths, storedRecord, { snapshot })).warnings,
      [],
    );
    const database = openStoreDatabase(paths);
    try {
      const serialized = String(database.prepare(
        "SELECT record_json FROM analysis_snapshots",
      ).pluck().get());
      const envelope = JSON.parse(serialized) as {
        identity: Record<string, unknown>;
        payload: { findings: Finding[] };
      };
      assert.deepEqual(Object.keys(envelope.identity).sort(), [
        "base_oid",
        "config_digest",
        "head_oid",
        "history_digest",
        "merge_base_oid",
        "policy_digest",
        "repo_id",
        "source_digest",
        "window",
      ]);
      assert.equal(envelope.identity.policy_digest, outerPolicyDigest);
      assert.deepEqual(
        envelope.payload.findings.find(({ rule_id }) => rule_id === "R004")
          ?.evidence.canonical_commands,
        ["npm test"],
      );
      assert.equal(
        envelope.payload.findings.find(({ rule_id }) => rule_id === "R005")
          ?.evidence.resource_domain,
        "node-workspace",
      );
      for (const secret of [
        approvalCanary,
        domainPatternCanary,
        domainNameCanary,
        innerRuleSafetyDigest,
        "rule_safety_digest",
        "organization_safe_patterns",
        "organization_resource_domains",
        "repository_resource_domains",
      ]) {
        assert.equal(serialized.includes(secret), false, secret);
      }
    } finally {
      database.close();
    }
  });
});

test("Store round-trips explicit epoch-one and metadata-less legacy rule findings", async () => {
  await temporaryStore(async (paths) => {
    const epochOneTarget = "legacy approval-policy-latency";
    const legacyTarget = "legacy serial-slack";
    const explicitEpochOne: Finding = {
      ...legacyFinding("explicit-epoch-one-r004", {
        ruleId: "R004",
        bound: "upper",
      }),
      finding_key: findingKeyForCompatibility(
        "R004",
        epochOneTarget,
        1,
      ),
      rule_id: "R004",
      rule_version: "1.0.0",
      compatibility_epoch: 1,
      target: epochOneTarget,
    };
    const metadataLessLegacy: Finding = {
      ...legacyFinding("metadata-less-r005", {
        ruleId: "R005",
        bound: "upper",
      }),
      finding_key: findingKeyForCompatibility("R005", legacyTarget, 1),
      rule_id: "R005",
      target: legacyTarget,
    };
    const source = record("legacy-rule-compatibility", 100);
    const input = makeAnalysisRecord({
      analysis_id: source.analysis_id,
      created_at_ms: source.created_at_ms,
      unit: source.unit,
      summary: source.summary,
      findings: [explicitEpochOne, metadataLessLegacy],
      metrics: source.metrics,
      command_costs: [],
    });
    const expected = structuredClone(input);

    const saved = await saveAnalysis(paths, input);
    assert.deepEqual(saved.warnings, []);
    assert.deepEqual(saved.record, expected);
    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.records, [expected]);

    const [loadedEpochOne, loadedLegacy] = loaded.records[0]?.findings ?? [];
    assert.equal(loadedEpochOne?.rule_version, "1.0.0");
    assert.equal(loadedEpochOne?.compatibility_epoch, 1);
    assert.equal(
      loadedEpochOne?.finding_key,
      findingKeyForCompatibility("R004", epochOneTarget, 1),
    );
    assert.equal(Object.hasOwn(loadedLegacy ?? {}, "rule_version"), false);
    assert.equal(
      Object.hasOwn(loadedLegacy ?? {}, "compatibility_epoch"),
      false,
    );
    assert.equal(
      loadedLegacy?.finding_key,
      findingKeyForCompatibility("R005", legacyTarget, 1),
    );
  });
});

test("snapshot selector validation rejects own __proto__ field attacks", async () => {
  await temporaryStore(async (paths) => {
    const selector = JSON.parse(
      '{"kind":"github_pr","extra":true,"__proto__":{"number":42}}',
    ) as AnalysisSnapshotIdentity["selector"];
    const snapshot = {
      ...snapshotOptions().snapshot,
      selector,
    } as AnalysisSnapshotIdentity;

    await assert.rejects(
      () => saveAnalysis(paths, record("selector-proto-attack", 100), { snapshot }),
      /invalid snapshot selector/u,
    );

    const database = openStoreDatabase(paths);
    try {
      assert.equal(
        database.prepare("SELECT count(*) FROM analysis_executions").pluck().get(),
        0,
      );
    } finally {
      database.close();
    }
  });
});

test("snapshot-aware history preserves records and exposes exact normalized entries", async () => {
  await temporaryStore(async (paths) => {
    const selector = {
      kind: "explicit_range",
      range: "double_dot",
      base_ref_digest: selectorRefDigest("explicit_range", "base", "main"),
      head_ref_digest: selectorRefDigest("explicit_range", "head", "feature"),
    } as const;
    const rawStateAIdentity = {
      repo_id: "A".repeat(64),
      base_oid: "B".repeat(40),
      head_oid: "C".repeat(40),
      merge_base_oid: "B".repeat(40),
      window: {
        started_at_ms: 1,
        start_source: "commit_anchor_lookback",
        end_source: "analysis_time",
        completeness: "partial",
      },
      source_digest: "D".repeat(64),
      config_digest: "E".repeat(64),
      policy_digest: "F".repeat(64),
      history_digest: "1".repeat(64),
      selector,
    } satisfies AnalysisSnapshotIdentity;
    const stateAIdentity = {
      ...rawStateAIdentity,
      repo_id: rawStateAIdentity.repo_id.toLowerCase(),
      base_oid: rawStateAIdentity.base_oid.toLowerCase(),
      head_oid: rawStateAIdentity.head_oid.toLowerCase(),
      merge_base_oid: rawStateAIdentity.merge_base_oid.toLowerCase(),
      source_digest: rawStateAIdentity.source_digest.toLowerCase(),
      config_digest: rawStateAIdentity.config_digest.toLowerCase(),
      policy_digest: rawStateAIdentity.policy_digest.toLowerCase(),
    } satisfies AnalysisSnapshotIdentity;
    const stateBIdentity = {
      ...stateAIdentity,
      head_oid: "2".repeat(40),
    } satisfies AnalysisSnapshotIdentity;
    const stateAVariantIdentity = {
      ...stateAIdentity,
      history_digest: "3".repeat(64),
    } satisfies AnalysisSnapshotIdentity;
    const selectorlessIdentity = snapshotOptions("7".repeat(64)).snapshot;

    const stateA = record("state-a", 1_000);
    const stateB = record("state-b", 2_000);
    const stateAVariant = {
      ...stateA,
      analysis_id: "state-a-variant",
      created_at_ms: 3_000,
    };
    const selectorless = record("selectorless-legacy", 4_000);
    const contentFallback = record("content-fallback-legacy", 5_000);
    const stateARerun = {
      ...stateA,
      analysis_id: "state-a-rerun",
      created_at_ms: 6_000,
    };
    await mkdir(paths.analyses_dir, { recursive: true });
    await writeFile(
      join(paths.analyses_dir, "content-fallback.json"),
      `${JSON.stringify(contentFallback)}\n`,
      "utf8",
    );

    assert.deepEqual(
      (await saveAnalysis(paths, stateA, { snapshot: rawStateAIdentity })).warnings,
      [],
    );
    assert.deepEqual(
      (await saveAnalysis(paths, stateB, { snapshot: stateBIdentity })).warnings,
      [],
    );
    assert.deepEqual(
      (await saveAnalysis(paths, stateAVariant, {
        snapshot: stateAVariantIdentity,
      })).warnings,
      [],
    );
    assert.deepEqual(
      (await saveAnalysis(paths, selectorless, {
        snapshot: selectorlessIdentity,
      })).warnings,
      [],
    );
    assert.deepEqual(
      (await saveAnalysis(paths, stateARerun, { snapshot: stateAIdentity }))
        .warnings,
      [],
    );

    const snapshotId = (
      storedRecord: AnalysisRecord,
      identity: AnalysisSnapshotIdentity | { mode: "content-fallback" },
    ): string => {
      const {
        analysis_id: _analysisId,
        created_at_ms: _createdAtMs,
        ...payload
      } = storedRecord;
      return analysisDigest("analysis-snapshot-v1", {
        schema_version: 1,
        identity,
        payload,
      });
    };
    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.records, [
      stateA,
      stateB,
      stateAVariant,
      selectorless,
      contentFallback,
    ]);
    assert.deepEqual(loaded.entries, [
      {
        snapshot_id: snapshotId(stateA, stateAIdentity),
        identity: stateAIdentity,
        record: stateA,
      },
      {
        snapshot_id: snapshotId(stateB, stateBIdentity),
        identity: stateBIdentity,
        record: stateB,
      },
      {
        snapshot_id: snapshotId(stateAVariant, stateAVariantIdentity),
        identity: stateAVariantIdentity,
        record: stateAVariant,
      },
      {
        snapshot_id: snapshotId(selectorless, selectorlessIdentity),
        identity: selectorlessIdentity,
        record: selectorless,
      },
      {
        snapshot_id: snapshotId(contentFallback, { mode: "content-fallback" }),
        identity: { mode: "content-fallback" },
        record: contentFallback,
      },
    ]);
  });
});

test("analysis budget results save and load through normalized Store v4 rows", async () => {
  await temporaryStore(async (paths) => {
    const complete = budgetRecord("budget-complete", 100, "complete");
    const partial = budgetRecord("budget-partial", 200, "partial");

    assert.deepEqual((await saveAnalysis(paths, complete)).warnings, []);
    assert.deepEqual((await saveAnalysis(paths, partial)).warnings, []);
    assert.deepEqual((await saveAnalysis(paths, complete)).warnings, []);

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.records, [complete, partial]);

    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 2);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 2);
      assert.deepEqual(database.prepare(`SELECT ${BUDGET_ROW_COLUMNS.join(", ")}
        FROM analysis_budget_runs ORDER BY execution_id`).all(), [
        storedBudgetRow(complete.analysis_id, complete.analysis_budget),
        storedBudgetRow(partial.analysis_id, partial.analysis_budget),
      ]);
    } finally {
      database.close();
    }
  });
});

test("analysis record budget descriptors fail closed without evaluating hostile input", async () => {
  await temporaryStore(async (paths) => {
    let getterReads = 0;
    const accessor = record("budget-accessor", 100) as AnalysisRecord & {
      analysis_budget?: AnalysisBudgetResult;
    };
    Object.defineProperty(accessor, "analysis_budget", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("token-canary");
      },
    });
    await assert.rejects(() => saveAnalysis(paths, accessor), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(!String(error).includes("token-canary"));
      return true;
    });
    assert.equal(getterReads, 0);

    const hidden = record("budget-hidden", 200) as AnalysisRecord & {
      analysis_budget?: AnalysisBudgetResult;
    };
    Object.defineProperty(hidden, "analysis_budget", {
      enumerable: false,
      value: budgetResult(),
    });
    await assert.rejects(() => saveAnalysis(paths, hidden), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(!String(error).includes("budget-hidden"));
      return true;
    });

    const proxy = new Proxy(budgetRecord("budget-proxy", 300), {
      ownKeys() {
        throw new Error("token-canary");
      },
    });
    await assert.rejects(() => saveAnalysis(paths, proxy), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(!String(error).includes("token-canary"));
      return true;
    });

    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 0);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_budget_runs",
      ).pluck().get(), 0);
    } finally {
      database.close();
    }
  });
});

test("legacy analysis snapshots remain readable with no synthetic budget result", async () => {
  await temporaryStore(async (paths) => {
    const legacy = record("legacy-without-budget", 100);
    assert.deepEqual((await saveAnalysis(paths, legacy)).warnings, []);

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.records, [legacy]);
    assert.deepEqual(loaded.warnings, []);
    assert.equal("analysis_budget" in (loaded.records[0] ?? {}), false);

    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_budget_runs",
      ).pluck().get(), 0);
    } finally {
      database.close();
    }
  });
});

test("analysis execution, snapshot, and budget row roll back atomically", async () => {
  await temporaryStore(async (paths) => {
    const database = openStoreDatabase(paths);
    try {
      database.exec(`CREATE TRIGGER reject_analysis_budget
        BEFORE INSERT ON analysis_budget_runs BEGIN
          SELECT RAISE(ABORT, 'forced analysis budget write failure');
        END`);
    } finally {
      database.close();
    }

    const saved = await saveAnalysis(
      paths,
      budgetRecord("budget-atomic-failure", 100, "partial"),
    );
    assert.ok(saved.warnings.some(({ code, message }) =>
      code === "analysis_write_failed" &&
      /forced analysis budget write failure/u.test(message)
    ));

    const reopened = openStoreDatabase(paths);
    try {
      assert.equal(reopened.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 0);
      assert.equal(reopened.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 0);
      assert.equal(reopened.prepare(
        "SELECT count(*) FROM analysis_budget_runs",
      ).pluck().get(), 0);
    } finally {
      reopened.close();
    }
  });
});

test("budget conflicts and mirror corruption fail closed without mutation", async () => {
  await temporaryStore(async (paths) => {
    const original = budgetRecord("budget-immutable", 100, "partial");
    assert.deepEqual((await saveAnalysis(paths, original)).warnings, []);

    const conflicting = {
      ...original,
      analysis_budget: {
        ...original.analysis_budget,
        configured: {
          ...original.analysis_budget.configured,
          max_input_bytes: 11,
        },
      },
    };
    const conflict = await saveAnalysis(paths, conflicting);
    assert.ok(conflict.warnings.some(
      ({ code }) => code === "analysis_record_conflict",
    ));

    let database = openStoreDatabase(paths);
    try {
      assert.deepEqual(database.prepare(`SELECT ${BUDGET_ROW_COLUMNS.join(", ")}
        FROM analysis_budget_runs WHERE execution_id = ?`)
        .get(original.analysis_id), storedBudgetRow(
          original.analysis_id,
          original.analysis_budget,
        ));
      database.prepare(`UPDATE analysis_budget_runs SET coverage = ?
        WHERE execution_id = ?`).run(0.25, original.analysis_id);
    } finally {
      database.close();
    }

    const replay = await saveAnalysis(paths, original);
    assert.ok(replay.warnings.some(
      ({ code }) => code === "analysis_record_conflict",
    ));
    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.records, []);
    assert.ok(loaded.warnings.some(
      ({ code }) => code === "corrupt_analysis_record",
    ));

    database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT coverage FROM analysis_budget_runs WHERE execution_id = ?",
      ).pluck().get(original.analysis_id), 0.25);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_budget_runs",
      ).pluck().get(), 1);
    } finally {
      database.close();
    }
  });
});

test("analysis execution and snapshot-envelope conflicts roll back atomically", async () => {
  await temporaryStore(async (paths) => {
    const first = record("immutable-execution", 100);
    assert.deepEqual(
      (await saveAnalysis(paths, first, snapshotOptions())).warnings,
      [],
    );

    const conflictingExecution = { ...first, created_at_ms: 200 };
    const executionConflict = await saveAnalysis(
      paths,
      conflictingExecution,
      snapshotOptions("2".repeat(64)),
    );
    assert.ok(executionConflict.warnings.length > 0);

    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 1);

      const snapshotId = database.prepare(
        "SELECT snapshot_id FROM analysis_snapshots",
      ).pluck().get() as string;
      database.prepare(
        "UPDATE analysis_snapshots SET record_json = ? WHERE snapshot_id = ?",
      ).run("{}", snapshotId);

      const envelopeConflict = await saveAnalysis(paths, {
        ...first,
        analysis_id: "new-execution",
        created_at_ms: 300,
      }, snapshotOptions());
      assert.ok(envelopeConflict.warnings.length > 0);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 1);
    } finally {
      database.close();
    }
  });
});

test("legacy analysis migration keeps valid first records, marks completion, and never rescans", async () => {
  await temporaryStore(async (paths) => {
    const first = record("legacy-id", 100);
    const duplicate = {
      ...record("different-content", 200),
      analysis_id: first.analysis_id,
    };
    await mkdir(paths.analyses_dir, { recursive: true });
    await writeFile(
      join(paths.analyses_dir, "01-valid.json"),
      `${JSON.stringify(first)}\n`,
      "utf8",
    );
    await writeFile(
      join(paths.analyses_dir, "02-duplicate.json"),
      `${JSON.stringify(duplicate)}\n`,
      "utf8",
    );
    await writeFile(join(paths.analyses_dir, "03-corrupt.json"), "{bad", "utf8");
    await writeFile(paths.history_index_path, "legacy-index-sentinel", "utf8");

    const migrated = await loadAnalyses(paths);
    assert.deepEqual(migrated.records, [first]);
    assert.ok(migrated.warnings.some(
      ({ code }) => code === "duplicate_analysis_record",
    ));
    assert.ok(migrated.warnings.some(
      ({ code }) => code === "corrupt_analysis_record",
    ));

    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-analyses-json-v1"), 1);
    } finally {
      database.close();
    }

    assert.deepEqual(await readdir(paths.analyses_dir), [
      "01-valid.json",
      "02-duplicate.json",
      "03-corrupt.json",
    ]);
    assert.equal(await readFile(paths.history_index_path, "utf8"),
      "legacy-index-sentinel");

    const late = record("late-after-marker", 300);
    await writeFile(
      join(paths.analyses_dir, "04-late.json"),
      `${JSON.stringify(late)}\n`,
      "utf8",
    );
    const loadedAgain = await loadAnalyses(paths);
    assert.deepEqual(loadedAgain.warnings, []);
    assert.deepEqual(loadedAgain.records, [first]);
  });
});

test("legacy analysis migration leaves a non-directory source incomplete and retries after repair", async () => {
  await temporaryStore(async (paths) => {
    await mkdir(paths.repo_dir, { recursive: true });
    await writeFile(paths.analyses_dir, "not a directory\n", "utf8");

    const incomplete = await loadAnalyses(paths);
    assert.deepEqual(incomplete.records, []);
    assert.ok(incomplete.warnings.some(
      ({ code }) => code === "history_read_failed",
    ));

    let database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-analyses-json-v1"), 0);
    } finally {
      database.close();
    }

    await rm(paths.analyses_dir, { force: true });
    await mkdir(paths.analyses_dir);
    const repaired = record("legacy-after-repair", 100);
    await writeFile(
      join(paths.analyses_dir, "valid.json"),
      `${JSON.stringify(repaired)}\n`,
      "utf8",
    );

    const retried = await loadAnalyses(paths);
    assert.deepEqual(retried.records, [repaired]);
    assert.deepEqual(retried.warnings, []);
    database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-analyses-json-v1"), 1);
    } finally {
      database.close();
    }
  });
});

test("legacy analysis migration rolls back rows and marker after an operational insert failure", async () => {
  await temporaryStore(async (paths) => {
    await mkdir(paths.analyses_dir, { recursive: true });
    const legacy = record("legacy-after-database-retry", 100);
    await writeFile(
      join(paths.analyses_dir, "valid.json"),
      `${JSON.stringify(legacy)}\n`,
      "utf8",
    );

    let database = openStoreDatabase(paths);
    try {
      database.exec(`CREATE TRIGGER reject_legacy_snapshot
        BEFORE INSERT ON analysis_snapshots BEGIN
          SELECT RAISE(ABORT, 'forced legacy migration failure');
        END`);
    } finally {
      database.close();
    }

    const failed = await loadAnalyses(paths);
    assert.deepEqual(failed.records, []);
    assert.ok(failed.warnings.some(
      ({ code }) => code === "history_read_failed",
    ));

    database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 0);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 0);
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-analyses-json-v1"), 0);
      database.exec("DROP TRIGGER reject_legacy_snapshot");
    } finally {
      database.close();
    }

    const retried = await loadAnalyses(paths);
    assert.deepEqual(retried.records, [legacy]);
    assert.deepEqual(retried.warnings, []);
    database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-analyses-json-v1"), 1);
    } finally {
      database.close();
    }
  });
});

test("completed legacy migration remains readable while another connection holds the writer lock", async () => {
  await temporaryStore(async (paths) => {
    const initial = await loadAnalyses(paths);
    assert.deepEqual(initial.records, []);
    assert.deepEqual(initial.warnings, []);

    const writer = openStoreDatabase(paths);
    writer.exec("BEGIN IMMEDIATE");
    try {
      const startedAtMs = Date.now();
      const loaded = await loadAnalyses(paths);
      const elapsedMs = Date.now() - startedAtMs;
      assert.deepEqual(loaded.records, []);
      assert.deepEqual(loaded.warnings, []);
      assert.ok(
        elapsedMs < 2_000,
        `marker fast path waited ${elapsedMs}ms for an unnecessary writer lock`,
      );
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

test("schema-v1 command costs aggregate by identity while legacy costs stay isolated", () => {
  const argv = ["npm", "test", "", "", "--flag"];
  const api = commandIdentity("packages/api", argv);
  const web = commandIdentity("packages/web", argv);
  const nativeApi = commandIdentity("packages/api", argv, "native-tool");
  const costs = [
    { command: "npm test", command_identity: api, duration_min: 1, session_refs: ["s#1"] },
    { command: "npm test --later-display", command_identity: api, duration_min: 2, session_refs: ["s#2"] },
    { command: "npm test", command_identity: web, duration_min: 3, session_refs: ["s#3"] },
    { command: "npm test", command_identity: nativeApi, duration_min: 4, session_refs: ["s#4"] },
    { command: "npm test", duration_min: 5, session_refs: ["legacy#1"] },
  ];
  const make = (command_costs: typeof costs) => makeAnalysisRecord({
    created_at_ms: 1,
    unit: { repo: "/repo", pr_ref: "main...feature", sessions: ["s"] },
    summary,
    findings: [],
    command_costs,
  });
  const forward = make(costs);
  const reversed = make([...costs].reverse());
  assert.equal(forward.schema_version, 1);
  assert.equal(forward.command_costs.length, 4);
  assert.deepEqual(forward.command_costs, reversed.command_costs);
  assert.equal(forward.analysis_id, reversed.analysis_id);
  const decimals = [0.1, 0.2, 0.3].map((duration_min, index) => ({
    command: "npm test", command_identity: api, duration_min, session_refs: [`s#${index}`],
  }));
  assert.deepEqual(make(decimals).command_costs, make([...decimals].reverse()).command_costs);
  assert.equal(make(decimals).analysis_id, make([...decimals].reverse()).analysis_id);
  const literalCwd = commandIdentity("packages/*-api");
  assert.deepEqual(make([{ command: "npm test", command_identity: literalCwd,
    duration_min: 1, session_refs: [] }]).command_costs[0]?.command_identity, literalCwd);
  const known = (identity: CommandIdentity) => forward.command_costs.find(
    (cost) => cost.command_identity !== undefined &&
      commandIdentityKey(cost.command_identity) === commandIdentityKey(identity),
  );
  const apiCost = known(api);
  assert.equal(apiCost?.command, "npm test");
  assert.equal(apiCost?.duration_min, 3);
  assert.deepEqual(apiCost?.session_refs, ["s#1", "s#2"]);
  assert.deepEqual(apiCost?.command_identity?.normalized_argv, argv);
  assert.notEqual(apiCost?.command_identity, api);
  assert.notEqual(apiCost?.command_identity?.normalized_argv, api.normalized_argv);
  assert.equal(known(web)?.duration_min, 3);
  assert.equal(known(nativeApi)?.duration_min, 4);
  const legacy = forward.command_costs.find((cost) => cost.command_identity === undefined);
  assert.equal(legacy?.duration_min, 5);
  assert.equal(legacy === undefined ? true : "command_identity" in legacy, false);
  api.normalized_argv[0] = "mutated";
  assert.deepEqual(apiCost?.command_identity?.normalized_argv, argv);
});

test("command costs reject malformed present identities in input and persisted records", async () => {
  const base = commandIdentity("packages/api");
  const invalid = [
    { ...base, repo_relative_cwd: "/repo" },
    { ...base, repo_relative_cwd: "../api" },
    { ...base, normalized_argv: [] },
    { ...base, normalized_argv: ["", "test"] },
    { ...base, normalized_argv: ["npm", 1] },
    { ...base, executor: "process" },
  ];
  for (const identity of invalid) {
    assert.throws(() => makeAnalysisRecord({
      ...record("invalid-input", 1),
      command_costs: [{ command: "npm test", command_identity: identity as CommandIdentity,
        duration_min: 1, session_refs: ["s#1"] }],
    }), /identity/iu);
  }
  assert.throws(() => makeAnalysisRecord({
    ...record("skipped-invalid", 1), command_costs: [{ command: " ",
      command_identity: invalid[0] as CommandIdentity, duration_min: 0, session_refs: [] }],
  }), /identity/iu);
  await temporaryStore(async (paths) => {
    await mkdir(paths.analyses_dir, { recursive: true });
    for (const [index, identity] of invalid.entries()) {
      await writeFile(join(paths.analyses_dir, `invalid-${index}.json`), JSON.stringify({
        ...record(`invalid-${index}`, index + 1),
        command_costs: [{ command: "npm test", command_identity: identity,
          duration_min: 1, session_refs: ["s#1"] }],
      }), "utf8");
    }
    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.records, []);
    assert.equal(loaded.warnings.filter(({ code }) =>
      code === "corrupt_analysis_record").length, invalid.length);
  });
});

test("command costs preserve finding identities without inferring legacy identity", () => {
  const root = commandIdentity(".");
  const known = finding("known");
  known.evidence.command_identity = {
    repo_relative_cwd: root.repo_relative_cwd,
    normalized_argv: [...root.normalized_argv],
    executor: root.executor,
  };
  const { command_costs: _legacyCosts, ...fallbackInput } = record("finding-costs", 1);
  const skipped = finding("skipped");
  skipped.evidence.duration_ms = 0;
  skipped.evidence.command_identity = { ...root, repo_relative_cwd: "/repo" };
  assert.throws(() => makeAnalysisRecord({ ...fallbackInput, findings: [skipped] }), /identity/iu);
  const result = makeAnalysisRecord({
    ...fallbackInput,
    findings: [known, finding("legacy")],
  });
  assert.equal(result.command_costs.length, 2);
  const identityCost = result.command_costs.find((cost) => cost.command_identity !== undefined);
  const legacyCost = result.command_costs.find((cost) => cost.command_identity === undefined);
  assert.deepEqual(identityCost?.command_identity, root);
  assert.notEqual(identityCost?.command_identity, root);
  assert.equal(legacyCost === undefined ? true : "command_identity" in legacyCost, false);
});

test("analysis write failures return warnings without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-write-failure-"));
  try {
    const blockingFile = join(root, "blocked");
    await writeFile(blockingFile, "not a directory", "utf8");
    const paths: StorePaths = {
      canonical_repo: "/repo",
      repo_hash: "hash",
      root_dir: root,
      repo_dir: blockingFile,
      analyses_dir: join(blockingFile, "analyses"),
      history_index_path: join(blockingFile, "index.json"),
      dismissals_path: join(blockingFile, "dismissals.json"),
      adoptions_path: join(blockingFile, "adoptions.json"),
      hook_events_path: join(blockingFile, "hook-events.jsonl"),
    };
    const result = await saveAnalysis(paths, record("write-failure", 100));
    assert.equal(result.record.analysis_id, "write-failure");
    assert.ok(result.warnings.some(({ code }) => code === "analysis_write_failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline uses only the previous ten analyses and stays null below three", () => {
  const histories = Array.from({ length: 12 }, (_, index) =>
    record(`history-${String(index + 1).padStart(2, "0")}`, index + 1, {
      metric: index + 1,
    })
  );
  const current = record("current", 20, { metric: 99 });

  assert.equal(computeBaseline(current, histories.slice(0, 2)), null);
  const baseline = computeBaseline(current, [...histories, current]);
  assert.ok(baseline !== null);
  assert.equal(baseline.prs, 10);
  assert.deepEqual(
    baseline.notable.find(({ metric }) => metric === "human_wait_ratio"),
    { metric: "human_wait_ratio", value: 99, baseline: 7.5 },
  );
});

test("dismissals expire exactly at 14 days and revive only strictly over twice strength", () => {
  const day = 24 * 60 * 60 * 1_000;
  const dismissal = {
    schema_version: 1 as const,
    finding_key: "finding-a",
    target: "npm test",
    dismissed_at_ms: 1_000,
    strength_min: 10,
    reason: "Not worth changing yet.",
  };

  assert.equal(
    dismissalDecision(dismissal, 20, 1_000 + (14 * day) - 1).suppressed,
    true,
  );
  assert.equal(
    dismissalDecision(dismissal, 20, 1_000 + (14 * day)).suppressed,
    false,
  );
  assert.equal(
    dismissalDecision(dismissal, 20, 1_000 + (14 * day) + 1).suppressed,
    false,
  );
  assert.equal(
    dismissalDecision(dismissal, 20, 1_001).suppressed,
    true,
  );
  const revived = dismissalDecision(dismissal, 20.01, 1_001);
  assert.equal(revived.suppressed, false);
  assert.equal(revived.revived, true);
  assert.match(revived.caveat ?? "", /Not worth changing yet\./u);

  const applied = applyDismissals(
    [finding("finding-a", "npm test", 20.01)],
    [dismissal],
    1_001,
  );
  assert.equal(applied.findings.length, 1);
  assert.match(applied.findings[0]?.caveats[0] ?? "", /Previously dismissed/u);
});

test("dismissals normalize, round-trip, and independently upsert each finding key", async () => {
  await temporaryStore(async (paths) => {
    const first = await saveDismissal(paths, {
      finding_key: "  finding-a  ",
      target: "  npm   test  ",
      dismissed_at_ms: 1_000,
      strength_min: 10,
      reason: "  Local trade-off.  ",
    });
    assert.deepEqual(first, {
      record: {
        schema_version: 1,
        finding_key: "finding-a",
        target: "npm test",
        dismissed_at_ms: 1_000,
        strength_min: 10,
        reason: "Local trade-off.",
      },
      warnings: [],
    });

    const concurrent = await runConcurrentStoreWrites<
      Awaited<ReturnType<typeof saveDismissal>>
    >(paths, [
      {
        moduleUrl: new URL(
          "../src/store/dismissals.js",
          import.meta.url,
        ).href,
        exportName: "saveDismissal",
        args: [{
          finding_key: "finding-b",
          target: "cargo test",
          dismissed_at_ms: 1_500,
          strength_min: 5,
        }],
      },
      {
        moduleUrl: new URL(
          "../src/store/dismissals.js",
          import.meta.url,
        ).href,
        exportName: "saveDismissal",
        args: [{
          finding_key: "finding-c",
          target: "pnpm test",
          dismissed_at_ms: 1_750,
          strength_min: 7,
        }],
      },
    ]);
    assert.ok(concurrent.every(({ warnings }) => warnings.length === 0));

    const replacement = await saveDismissal(paths, {
      finding_key: "finding-a",
      target: "node --test",
      // A later call remains authoritative even if its supplied timestamp is older.
      dismissed_at_ms: 500,
      strength_min: 3,
    });
    assert.deepEqual(replacement.warnings, []);

    const loaded = await loadDismissals(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.records, [
      replacement.record,
      concurrent[0]?.record,
      concurrent[1]?.record,
    ]);
    assert.equal((await readdir(paths.repo_dir)).includes("dismissals.json"), false);
  });
});

function adoption(
  key: string,
  overrides: Partial<AdoptionRecord> = {},
): AdoptionRecord {
  return {
    finding_key: key,
    rule_id: "R002",
    scope: "this_pr",
    fingerprint: `fp-${key}`,
    method: "target_file_edit",
    detected_at_ms: 1_000,
    evidence: { commit: "a".repeat(40), path: "src/foo.ts" },
    ...overrides,
  };
}

test("adoptions are additive and keep the first record for each finding key", async () => {
  await temporaryStore(async (paths) => {
    const first = adoption("finding-a", { method: "claude_md_edit" });
    assert.deepEqual(await saveAdoptions(paths, [
      first,
      adoption("finding-a", { method: "target_file_edit" }),
      adoption("finding-b"),
    ]), []);
    assert.deepEqual(await saveAdoptions(paths, [
      adoption("finding-a", {
        detected_at_ms: 2_000,
        evidence: { commit: "b".repeat(40), path: "CLAUDE.md" },
      }),
      adoption("finding-c"),
    ]), []);

    const loaded = await loadAdoptions(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.records, [
      first,
      adoption("finding-b"),
      adoption("finding-c"),
    ]);
    assert.equal((await readdir(paths.repo_dir)).includes("adoptions.json"), false);
  });
});

test("saving an empty adoption batch is an additive no-op", async () => {
  await temporaryStore(async (paths) => {
    const existing = adoption("finding-a");
    assert.deepEqual(await saveAdoptions(paths, [existing]), []);
    assert.deepEqual(await saveAdoptions(paths, []), []);
    const loaded = await loadAdoptions(paths);
    assert.deepEqual(loaded, { records: [existing], warnings: [] });
  });
});

test("concurrent adoption batches retain every distinct finding key", async () => {
  await temporaryStore(async (paths) => {
    const existing = adoption("finding-a");
    assert.deepEqual(await saveAdoptions(paths, [existing]), []);
    const warnings = await runConcurrentStoreWrites<
      Awaited<ReturnType<typeof saveAdoptions>>
    >(paths, [
      {
        moduleUrl: new URL(
          "../src/store/adoptions.js",
          import.meta.url,
        ).href,
        exportName: "saveAdoptions",
        args: [[adoption("finding-b")]],
      },
      {
        moduleUrl: new URL(
          "../src/store/adoptions.js",
          import.meta.url,
        ).href,
        exportName: "saveAdoptions",
        args: [[adoption("finding-c")]],
      },
    ]);
    assert.deepEqual(warnings, [[], []]);
    const loaded = await loadAdoptions(paths);
    assert.deepEqual(loaded, {
      records: [existing, adoption("finding-b"), adoption("finding-c")],
      warnings: [],
    });
  });
});

test("legacy dismissal and adoption JSON migrate once with their existing dedupe semantics", async () => {
  await temporaryStore(async (paths) => {
    await mkdir(paths.repo_dir, { recursive: true });
    const earlyDismissal = {
      schema_version: 1 as const,
      finding_key: "finding-a",
      target: "npm test",
      dismissed_at_ms: 1_000,
      strength_min: 10,
    };
    const latestDismissal = {
      ...earlyDismissal,
      target: "node --test",
      dismissed_at_ms: 2_000,
      strength_min: 4,
      reason: "newer decision",
    };
    const secondDismissal = {
      ...earlyDismissal,
      finding_key: "finding-b",
      dismissed_at_ms: 1_500,
    };
    const firstAdoption = adoption("finding-a", { method: "claude_md_edit" });
    const secondAdoption = adoption("finding-b");
    const dismissalJson = `${JSON.stringify({
      schema_version: 1,
      records: [earlyDismissal, latestDismissal, secondDismissal],
    })}\n`;
    const adoptionJson = `${JSON.stringify({
      schema_version: 1,
      adoptions: [
        firstAdoption,
        adoption("finding-a", { method: "target_file_edit" }),
        secondAdoption,
      ],
    })}\n`;
    await writeFile(paths.dismissals_path, dismissalJson, "utf8");
    await writeFile(paths.adoptions_path, adoptionJson, "utf8");

    assert.deepEqual(await loadDismissals(paths), {
      records: [latestDismissal, secondDismissal],
      warnings: [],
    });
    assert.deepEqual(await loadAdoptions(paths), {
      records: [firstAdoption, secondAdoption],
      warnings: [],
    });

    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare("SELECT count(*) FROM dismissals").pluck().get(), 2);
      assert.equal(database.prepare("SELECT count(*) FROM adoptions").pluck().get(), 2);
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-dismissals-json-v1"), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-adoptions-json-v1"), 1);
    } finally {
      database.close();
    }
    assert.equal(await readFile(paths.dismissals_path, "utf8"), dismissalJson);
    assert.equal(await readFile(paths.adoptions_path, "utf8"), adoptionJson);

    await writeFile(paths.dismissals_path, JSON.stringify({
      schema_version: 1,
      records: [{ ...earlyDismissal, finding_key: "late-dismissal" }],
    }), "utf8");
    await writeFile(paths.adoptions_path, JSON.stringify({
      schema_version: 1,
      adoptions: [adoption("late-adoption")],
    }), "utf8");
    assert.deepEqual((await loadDismissals(paths)).records, [
      latestDismissal,
      secondDismissal,
    ]);
    assert.deepEqual((await loadAdoptions(paths)).records, [
      firstAdoption,
      secondAdoption,
    ]);
  });
});

test("malformed and non-regular legacy stores warn once and still complete migration", async () => {
  await temporaryStore(async (paths) => {
    await mkdir(paths.repo_dir, { recursive: true });
    await writeFile(paths.dismissals_path, "{not json", "utf8");
    await mkdir(paths.adoptions_path);

    const dismissals = await loadDismissals(paths);
    const adoptions = await loadAdoptions(paths);
    assert.deepEqual(dismissals.records, []);
    assert.ok(dismissals.warnings.some(({ code }) => code === "corrupt_dismissals"));
    assert.deepEqual(adoptions.records, []);
    assert.ok(adoptions.warnings.some(({ code }) => code === "corrupt_adoptions"));

    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-dismissals-json-v1"), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-adoptions-json-v1"), 1);
    } finally {
      database.close();
    }
    assert.deepEqual(await loadDismissals(paths), { records: [], warnings: [] });
    assert.deepEqual(await loadAdoptions(paths), { records: [], warnings: [] });
  });
});

test("a legacy file close failure remains operational and retryable", async () => {
  await temporaryStore(async (paths) => {
    await mkdir(paths.repo_dir, { recursive: true });
    const legacyDismissal = {
      schema_version: 1 as const,
      finding_key: "finding-close-failure",
      target: "npm test",
      dismissed_at_ms: 1_000,
      strength_min: 10,
    };
    await writeFile(paths.dismissals_path, JSON.stringify({
      schema_version: 1,
      records: [legacyDismissal],
    }), "utf8");
    openStoreDatabase(paths).close();

    const mutableFs = createRequire(import.meta.url)("node:fs") as {
      closeSync: typeof import("node:fs").closeSync;
    };
    const originalCloseSync = mutableFs.closeSync;
    mutableFs.closeSync = (descriptor: number): void => {
      originalCloseSync(descriptor);
      const error = new Error("forced legacy close failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    };
    syncBuiltinESMExports();
    try {
      const failed = await loadDismissals(paths);
      assert.deepEqual(failed.records, []);
      assert.ok(failed.warnings.some(({ code }) => code === "corrupt_dismissals"));
      const database = openStoreDatabase(paths);
      try {
        assert.equal(database.prepare("SELECT count(*) FROM dismissals").pluck().get(), 0);
        assert.equal(database.prepare(
          "SELECT count(*) FROM store_migrations WHERE name = ?",
        ).pluck().get("legacy-dismissals-json-v1"), 0);
      } finally {
        database.close();
      }
    } finally {
      mutableFs.closeSync = originalCloseSync;
      syncBuiltinESMExports();
    }

    assert.deepEqual(await loadDismissals(paths), {
      records: [legacyDismissal],
      warnings: [],
    });
    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare("SELECT count(*) FROM dismissals").pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-dismissals-json-v1"), 1);
    } finally {
      database.close();
    }
  });
});

test("operational migration failures retain committed rows, block saves, and retry", async () => {
  await temporaryStore(async (paths) => {
    await mkdir(paths.repo_dir, { recursive: true });
    const legacyDismissal = {
      schema_version: 1 as const,
      finding_key: "finding-a",
      target: "npm test",
      dismissed_at_ms: 1_000,
      strength_min: 10,
    };
    const legacyAdoption = adoption("finding-a");
    const existingDismissal = {
      ...legacyDismissal,
      finding_key: "existing-dismissal",
      dismissed_at_ms: 500,
    };
    const existingAdoption = adoption("existing-adoption");
    await writeFile(paths.dismissals_path, JSON.stringify({
      schema_version: 1,
      records: [legacyDismissal],
    }), "utf8");
    await writeFile(paths.adoptions_path, JSON.stringify({
      schema_version: 1,
      adoptions: [legacyAdoption],
    }), "utf8");

    let database = openStoreDatabase(paths);
    try {
      database.prepare(
        "INSERT INTO dismissals(finding_key, dismissed_at_ms, record_json) VALUES (?, ?, ?)",
      ).run(existingDismissal.finding_key, existingDismissal.dismissed_at_ms,
        canonicalJson(existingDismissal));
      database.prepare(
        "INSERT INTO adoptions(finding_key, detected_at_ms, record_json) VALUES (?, ?, ?)",
      ).run(existingAdoption.finding_key, existingAdoption.detected_at_ms,
        canonicalJson(existingAdoption));
      database.exec(`CREATE TRIGGER reject_legacy_dismissal
        BEFORE INSERT ON dismissals WHEN NEW.finding_key = 'finding-a' BEGIN
          SELECT RAISE(ABORT, 'forced dismissal migration failure');
        END`);
      database.exec(`CREATE TRIGGER reject_legacy_adoption
        BEFORE INSERT ON adoptions WHEN NEW.finding_key = 'finding-a' BEGIN
          SELECT RAISE(ABORT, 'forced adoption migration failure');
        END`);
    } finally {
      database.close();
    }

    const failedDismissals = await loadDismissals(paths);
    const failedAdoptions = await loadAdoptions(paths);
    assert.deepEqual(failedDismissals.records, [existingDismissal]);
    assert.ok(failedDismissals.warnings.some(({ code }) => code === "corrupt_dismissals"));
    assert.deepEqual(failedAdoptions.records, [existingAdoption]);
    assert.ok(failedAdoptions.warnings.some(({ code }) => code === "corrupt_adoptions"));

    const blockedDismissal = await saveDismissal(paths, {
      finding_key: "save-must-not-run",
      target: "node --test",
      dismissed_at_ms: 3_000,
      strength_min: 1,
    });
    assert.ok(blockedDismissal.warnings.some(
      ({ code }) => code === "dismissal_write_failed"));
    const blockedAdoption = await saveAdoptions(paths, [adoption("save-must-not-run")]);
    assert.ok(blockedAdoption.some(({ code }) => code === "adoption_write_failed"));

    database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare("SELECT count(*) FROM dismissals").pluck().get(), 1);
      assert.equal(database.prepare("SELECT count(*) FROM adoptions").pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM dismissals WHERE finding_key = ?",
      ).pluck().get("save-must-not-run"), 0);
      assert.equal(database.prepare(
        "SELECT count(*) FROM adoptions WHERE finding_key = ?",
      ).pluck().get("save-must-not-run"), 0);
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-dismissals-json-v1"), 0);
      assert.equal(database.prepare(
        "SELECT count(*) FROM store_migrations WHERE name = ?",
      ).pluck().get("legacy-adoptions-json-v1"), 0);
      database.exec("DROP TRIGGER reject_legacy_dismissal");
      database.exec("DROP TRIGGER reject_legacy_adoption");
    } finally {
      database.close();
    }

    assert.deepEqual(await loadDismissals(paths), {
      records: [existingDismissal, legacyDismissal],
      warnings: [],
    });
    assert.deepEqual(await loadAdoptions(paths), {
      records: [existingAdoption, legacyAdoption],
      warnings: [],
    });
  });
});

test("completed dismissal and adoption migrations stay readable under a writer lock", async () => {
  await temporaryStore(async (paths) => {
    assert.deepEqual(await loadDismissals(paths), { records: [], warnings: [] });
    assert.deepEqual(await loadAdoptions(paths), { records: [], warnings: [] });

    const writer = openStoreDatabase(paths);
    try {
      assert.equal(writer.prepare(
        "SELECT count(*) FROM store_migrations WHERE name IN (?, ?)",
      ).pluck().get("legacy-dismissals-json-v1", "legacy-adoptions-json-v1"), 2);
      writer.exec("BEGIN IMMEDIATE");
      const startedAtMs = Date.now();
      const [dismissals, adoptions] = await Promise.all([
        loadDismissals(paths),
        loadAdoptions(paths),
      ]);
      const elapsedMs = Date.now() - startedAtMs;
      assert.deepEqual(dismissals, { records: [], warnings: [] });
      assert.deepEqual(adoptions, { records: [], warnings: [] });
      assert.ok(elapsedMs < 2_000, `marker fast paths waited ${elapsedMs}ms`);
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
  });
});

test("non-canonical and mismatched SQLite records cannot disable healthy keys", async () => {
  await temporaryStore(async (paths) => {
    assert.deepEqual(await loadDismissals(paths), { records: [], warnings: [] });
    assert.deepEqual(await loadAdoptions(paths), { records: [], warnings: [] });
    const healthyDismissal = {
      schema_version: 1 as const,
      finding_key: "dismissal-healthy",
      target: "npm test",
      dismissed_at_ms: 1_000,
      strength_min: 5,
    };
    const healthyAdoption = adoption("adoption-healthy");

    const database = openStoreDatabase(paths);
    try {
      database.prepare(
        "INSERT INTO dismissals(finding_key, dismissed_at_ms, record_json) VALUES (?, ?, ?)",
      ).run(healthyDismissal.finding_key, healthyDismissal.dismissed_at_ms,
        canonicalJson(healthyDismissal));
      database.prepare(
        "INSERT INTO dismissals(finding_key, dismissed_at_ms, record_json) VALUES (?, ?, ?)",
      ).run("dismissal-mismatch", 2_000, canonicalJson({
        ...healthyDismissal,
        finding_key: "different-dismissal-key",
        dismissed_at_ms: 2_000,
      }));
      const noncanonicalDismissal = {
        ...healthyDismissal,
        finding_key: "dismissal-noncanonical",
        dismissed_at_ms: 2_500,
      };
      database.prepare(
        "INSERT INTO dismissals(finding_key, dismissed_at_ms, record_json) VALUES (?, ?, ?)",
      ).run(noncanonicalDismissal.finding_key, noncanonicalDismissal.dismissed_at_ms,
        JSON.stringify(noncanonicalDismissal));
      database.prepare(
        "INSERT INTO adoptions(finding_key, detected_at_ms, record_json) VALUES (?, ?, ?)",
      ).run(healthyAdoption.finding_key, healthyAdoption.detected_at_ms,
        canonicalJson(healthyAdoption));
      database.prepare(
        "INSERT INTO adoptions(finding_key, detected_at_ms, record_json) VALUES (?, ?, ?)",
      ).run("adoption-mismatch", 2_000, canonicalJson({
        ...adoption("adoption-mismatch"),
        detected_at_ms: 3_000,
      }));
      const noncanonicalAdoption = adoption("adoption-noncanonical");
      database.prepare(
        "INSERT INTO adoptions(finding_key, detected_at_ms, record_json) VALUES (?, ?, ?)",
      ).run(noncanonicalAdoption.finding_key, noncanonicalAdoption.detected_at_ms,
        JSON.stringify(noncanonicalAdoption));
    } finally {
      database.close();
    }

    const dismissals = await loadDismissals(paths);
    const adoptions = await loadAdoptions(paths);
    assert.deepEqual(dismissals.records, [healthyDismissal]);
    assert.ok(dismissals.warnings.some(({ code }) => code === "corrupt_dismissals"));
    assert.deepEqual(adoptions.records, [healthyAdoption]);
    assert.ok(adoptions.warnings.some(({ code }) => code === "corrupt_adoptions"));
  });
});

test("blocked SQLite store paths retain dismissal and adoption warning codes", async () => {
  await temporaryStore(async (paths, root) => {
    const blockingFile = join(root, "store-block");
    await writeFile(blockingFile, "not a directory", "utf8");
    const blocked: StorePaths = {
      ...paths,
      repo_dir: blockingFile,
      dismissals_path: join(blockingFile, "dismissals.json"),
      adoptions_path: join(blockingFile, "adoptions.json"),
    };
    assert.ok((await loadDismissals(blocked)).warnings.some(
      ({ code }) => code === "corrupt_dismissals"));
    assert.ok((await loadAdoptions(blocked)).warnings.some(
      ({ code }) => code === "corrupt_adoptions"));
    const dismissal = await saveDismissal(blocked, {
      finding_key: "finding-a",
      target: "npm test",
      dismissed_at_ms: 1_000,
      strength_min: 1,
    });
    assert.ok(dismissal.warnings.some(
      ({ code }) => code === "dismissal_write_failed"));
    assert.ok((await saveAdoptions(blocked, [adoption("finding-a")])).some(
      ({ code }) => code === "adoption_write_failed"));
  });
});

function r006FindingKey(identity: CommandIdentity): string {
  return findingKey("R006", `command-identity:${Buffer.from(
    commandIdentityKey(identity), "utf8").toString("hex")}`);
}
test("R006 requires five histories, identity presence in three, and a 30 percent cost ratio", () => {
  const api = commandIdentity("packages/api");
  const qualifying = Array.from({ length: 5 }, (_, index) =>
    record(`r006-${index}`, index, {
      commandMin: index < 3 ? 50 : 0,
      includeCommand: index < 3,
      commandIdentity: api,
    })
  );
  const findings = detectChronicCost(qualifying);
  assert.equal(findings.length, 1);
  const chronic = findings[0];
  assert.ok(chronic !== undefined);
  assert.equal(chronic.rule_id, "R006");
  assert.equal(chronic.classification, "repo");
  assert.equal(chronic.scope, "separate_issue");
  assert.equal(chronic.target, "packages/api :: npm test");
  assert.equal(chronic.finding_key, r006FindingKey(api));
  assert.deepEqual(chronic.evidence.command_identity, api);
  assert.equal(chronic.evidence.history_count, 5);
  assert.equal(chronic.evidence.presence_count, 3);
  assert.equal(chronic.evidence.cost_ratio, 0.3);
  assert.equal(chronic.evidence.minimum_history_count, 5);
  assert.equal(chronic.evidence.minimum_presence_count, 3);
  assert.equal(chronic.evidence.minimum_cost_ratio, 0.3);
  assert.equal(chronic.recoverable.bound, "upper");
  assert.deepEqual(chronic.impact, {
    lower_ms: 0,
    upper_ms: chronic.recoverable.estimated_ms,
    kind: "resource_cost",
  });
  assert.deepEqual(chronic.finding_confidence, {
    evidence: "high",
    causal: "medium",
    source_completeness: 1,
  });
  assert.equal(chronic.severity, "medium");
  assert.deepEqual(chronic.scoring_rationale, [
    "estimated_upper_only",
    "resource_cost_only",
  ]);
  assert.equal(chronic.confidence, "medium");
  assert.equal(chronic.fix_recipe.verify, "npm test");
  assert.match(chronic.fix_recipe.suggestion, /packages\/api/u);

  assert.deepEqual(detectChronicCost(qualifying.slice(0, 4)), []);
  assert.deepEqual(
    detectChronicCost(
      qualifying.map((entry, index) =>
        index < 2 ? entry : record(`presence-${index}`, index, {
          includeCommand: false,
        })
      ),
    ),
    [],
  );
  assert.deepEqual(
    detectChronicCost(
      Array.from({ length: 5 }, (_, index) =>
        record(`ratio-${index}`, index, {
          commandMin: index < 3 ? 49.99 : 0,
          includeCommand: index < 3,
          commandIdentity: api,
        })
      ),
    ),
    [],
  );
});

test("R006 isolates identity lanes and accepts only exact-identity finding refs", () => {
  const api = commandIdentity("packages/api");
  const web = commandIdentity("packages/web");
  const native = commandIdentity("packages/api", undefined, "native-tool");
  const cost = (identity: CommandIdentity | undefined, duration_min: number, ref: string) => ({
    command: "npm test", ...(identity === undefined ? {} : { command_identity: identity }),
    duration_min, session_refs: [ref],
  });
  const histories = Array.from({ length: 5 }, (_, index) => ({
    ...record(`lanes-${index}`, index, { includeCommand: false }),
    command_costs: [
      ...(index < 3 ? [cost(api, 50, `api-cost-${index}`)] : []),
      ...(index < 2 ? [cost(web, 80, `web-cost-${index}`),
        cost(native, 80, `native-cost-${index}`)] : []),
      cost(undefined, 100, `legacy-cost-${index}`),
    ],
  }));
  const evidence = (key: string, identity?: CommandIdentity) => {
    const value = finding(key, `different display ${key}`);
    value.evidence.session_refs = [`${key}#finding`];
    if (identity !== undefined) value.evidence.command_identity = identityEvidence(identity);
    return value;
  };
  const malformed = evidence("malformed", api);
  malformed.evidence.command_identity = { ...identityEvidence(api), repo_relative_cwd: "/repo" };
  histories[0]!.findings = [evidence("api", api), evidence("web", web),
    evidence("native", native), evidence("legacy"), malformed];
  const chronic = detectChronicCost(histories)[0];
  assert.ok(chronic !== undefined);
  assert.equal(chronic.evidence.cost_min, 150);
  assert.equal(chronic.evidence.presence_count, 3);
  assert.deepEqual(chronic.evidence.session_refs,
    ["api-cost-0", "api-cost-1", "api-cost-2", "api#finding"]);
});
test("R006 ignores legacy presence and sums duplicate decimal costs deterministically", () => {
  const api = commandIdentity("packages/api");
  const legacy = Array.from({ length: 5 }, (_, index) =>
    record(`legacy-${index}`, index, { commandMin: 100, commandIdentity: undefined }));
  assert.deepEqual(detectChronicCost(legacy), []);
  assert.deepEqual(detectChronicCost(legacy.map((_, index) =>
    record(`mixed-${index}`, index, { commandMin: 100,
      commandIdentity: index < 2 ? api : undefined }))), []);
  const fractional = Array.from({ length: 5 }, (_, index) => ({
    ...record(`fractional-${index}`, index, { measuredMin: 1, includeCommand: false }),
    command_costs: [0.1, 0.2, 0.3].map((duration_min, costIndex) => ({
      command: "npm test", command_identity: api, duration_min,
      session_refs: [`fractional-${index}#${costIndex}`],
    })),
  }));
  const reversed = fractional.map((entry) => ({
    ...entry, command_costs: [...entry.command_costs].reverse(),
  })).reverse();
  const findings = detectChronicCost(fractional);
  assert.deepEqual(findings, detectChronicCost(reversed));
  assert.equal(findings[0]?.evidence.cost_min, 3);
  assert.equal(findings[0]?.evidence.presence_count, 5);
});
test("R006 distinguishes a native identity and clones its exact argv", () => {
  const argv = ["npm", "test", "", "--flag", "--flag"];
  const native = commandIdentity("packages/api", argv, "native-tool");
  const histories = Array.from({ length: 5 }, (_, index) => record(`native-${index}`, index, {
    commandMin: index < 3 ? 50 : 0, includeCommand: index < 3, commandIdentity: native,
  }));
  const chronic = detectChronicCost(histories)[0];
  assert.ok(chronic !== undefined);
  assert.equal(chronic.target, "packages/api :: npm test [native-tool]");
  assert.equal(chronic.finding_key, r006FindingKey(native));
  assert.notEqual(chronic.finding_key, r006FindingKey(commandIdentity("packages/api", argv)));
  assert.deepEqual(chronic.evidence.command_identity, native);
  assert.notEqual(chronic.evidence.command_identity?.normalized_argv, argv);
});
test("R006 defensively ignores malformed finding evidence at its boundary", () => {
  const api = commandIdentity("packages/api");
  const histories = Array.from({ length: 5 }, (_, index) =>
    record(`defensive-${index}`, index, {
      commandMin: index < 3 ? 50 : 0,
      includeCommand: index < 3,
      commandIdentity: api,
    })
  );
  histories[0] = {
    ...histories[0] as AnalysisRecord,
    findings: [null] as unknown as Finding[],
  };
  histories[1] = {
    ...histories[1] as AnalysisRecord,
    findings: [{
      ...finding("bad-evidence"),
      evidence: null,
    }] as unknown as Finding[],
  };

  assert.equal(detectChronicCost(histories).length, 1);
});

test("loads a legacy analysis record without human_wait_min and no warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-legacy-summary-"));
  try {
    const paths = await resolveStorePaths(join(root, "repo"), {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const legacy = {
      schema_version: 1,
      analysis_id: "legacy-record",
      created_at_ms: 1,
      unit: {
        repo: "/repo",
        pr_ref: "main...legacy",
        sessions: ["legacy"],
      },
      summary: {
        measured_min: 10,
        idle_excluded_min: 1,
        estimated_floor_min: 9,
        recoverable_min: 1,
        unexplained_min: 2,
        baseline: null,
      },
      findings: [],
      metrics: { measured_min: 10 },
      command_costs: [{ command: "npm test", duration_min: 2, session_refs: ["legacy#run"] }],
    };
    await mkdir(paths.analyses_dir, { recursive: true });
    await writeFile(
      join(paths.analyses_dir, "legacy.json"),
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf8",
    );

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.analysis_id, "legacy-record");
    assert.deepEqual(loaded.records[0]?.command_costs, legacy.command_costs);
    assert.equal("command_identity" in loaded.records[0]!.command_costs[0]!, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes legacy finding bounds, domains, and confidence conservatively", () => {
  const input = record("legacy-finding-contracts", 1);
  const normalized = makeAnalysisRecord({
    ...input,
    findings: [
      legacyFinding("legacy-point-high", {
        confidence: "high",
        bound: "point",
        recoverableMin: 2,
      }),
      legacyFinding("legacy-upper-medium", {
        ruleId: "R005",
        confidence: "medium",
        bound: "upper",
        recoverableMin: 3,
      }),
      legacyFinding("legacy-upper-low", {
        ruleId: "R006",
        confidence: "low",
        bound: "upper",
        recoverableMin: 4,
      }),
    ],
  });
  const byKey = new Map(
    normalized.findings.map((entry) => [entry.finding_key, entry]),
  );

  assert.deepEqual(byKey.get("legacy-point-high"), {
    ...legacyFinding("legacy-point-high", {
      confidence: "high",
      bound: "point",
      recoverableMin: 2,
    }),
    confidence: "medium",
    impact: {
      lower_ms: 0,
      upper_ms: 120_000,
      kind: "critical_path_latency",
    },
    finding_confidence: {
      evidence: "high",
      causal: "medium",
      source_completeness: 0.5,
    },
    severity: "medium",
    scoring_rationale: [
      "estimated_upper_only",
      "partial_source",
      "legacy_projection",
    ],
    recoverable: { min: 2, bound: "upper" },
  });
  assert.deepEqual(byKey.get("legacy-upper-medium")?.impact, {
    lower_ms: 0,
    upper_ms: 180_000,
    kind: "resource_cost",
  });
  assert.deepEqual(byKey.get("legacy-upper-medium")?.finding_confidence, {
    evidence: "medium",
    causal: "medium",
    source_completeness: 0.5,
  });
  assert.equal(byKey.get("legacy-upper-medium")?.confidence, "medium");
  assert.equal(byKey.get("legacy-upper-medium")?.severity, "medium");
  assert.deepEqual(byKey.get("legacy-upper-medium")?.scoring_rationale, [
    "estimated_upper_only",
    "resource_cost_only",
    "partial_source",
    "legacy_projection",
  ]);
  assert.deepEqual(byKey.get("legacy-upper-low")?.finding_confidence, {
    evidence: "low",
    causal: "low",
    source_completeness: 0,
  });
  assert.equal(byKey.get("legacy-upper-low")?.confidence, "low");
  assert.equal(byKey.get("legacy-upper-low")?.severity, "low");
  assert.deepEqual(byKey.get("legacy-upper-low")?.scoring_rationale, [
    "estimated_upper_only",
    "resource_cost_only",
    "partial_source",
    "legacy_projection",
  ]);
});

test("legacy finding normalization is idempotent across save, load, and migration", async () => {
  const legacy = {
    ...record("legacy-idempotent", 2),
    findings: [legacyFinding("legacy-idempotent-finding", {
      confidence: "high",
      bound: "point",
      recoverableMin: 2,
    })],
  };
  const normalized = makeAnalysisRecord(legacy);
  assert.deepEqual(makeAnalysisRecord(normalized), normalized);

  const fabricated = finding("fabricated-legacy-flag", "npm test", 2);
  fabricated.impact = {
    lower_ms: 0,
    upper_ms: 120_000,
    kind: "critical_path_latency",
  };
  fabricated.finding_confidence = {
    evidence: "high",
    causal: "high",
    source_completeness: 1,
  };
  fabricated.severity = "medium";
  fabricated.scoring_rationale = [
    "estimated_upper_only",
    "legacy_projection",
  ];
  fabricated.recoverable = { min: 2, bound: "upper" };
  assert.throws(
    () => makeAnalysisRecord({ ...legacy, findings: [fabricated] }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "invalid finding");
      return true;
    },
  );

  const mismatchedDomain = structuredClone(
    normalized.findings[0] as Finding,
  );
  mismatchedDomain.impact = {
    ...mismatchedDomain.impact as ImpactEstimate,
    kind: "resource_cost",
  };
  mismatchedDomain.scoring_rationale = [
    "estimated_upper_only",
    "resource_cost_only",
    "partial_source",
    "legacy_projection",
  ];
  assert.throws(
    () => makeAnalysisRecord({ ...legacy, findings: [mismatchedDomain] }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "invalid finding");
      return true;
    },
  );

  await temporaryStore(async (paths) => {
    const saved = await saveAnalysis(paths, legacy);
    assert.deepEqual(saved.warnings, []);
    assert.deepEqual(saved.record, normalized);
    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.records, [normalized]);
    assert.deepEqual(loaded.warnings, []);
    const savedAgain = await saveAnalysis(paths, loaded.records[0]!);
    assert.deepEqual(savedAgain, { record: normalized, warnings: [] });
    const loadedAgain = await loadAnalyses(paths);
    assert.deepEqual(loadedAgain.records, [normalized]);
    assert.deepEqual(loadedAgain.warnings, []);
  });

  await temporaryStore(async (paths) => {
    await mkdir(paths.analyses_dir, { recursive: true });
    await writeFile(
      join(paths.analyses_dir, "legacy-finding.json"),
      `${JSON.stringify(legacy)}\n`,
      "utf8",
    );
    const migrated = await loadAnalyses(paths);
    assert.deepEqual(migrated.records, [normalized]);
    assert.deepEqual(migrated.warnings, []);
    const loadedAgain = await loadAnalyses(paths);
    assert.deepEqual(loadedAgain.records, [normalized]);
    assert.deepEqual(loadedAgain.warnings, []);
  });
});

test("canonical finding snapshots derive v2 projections and stabilize nested key order", async () => {
  const canonical = finding("canonical-range", "npm test", 2);
  canonical.confidence = "low";
  canonical.recoverable = { min: 999, bound: "point" };
  canonical.impact = {
    lower_ms: 60_000,
    expected_ms: 90_000,
    upper_ms: 120_000,
    kind: "critical_path_latency",
  };
  canonical.finding_confidence = {
    evidence: "high",
    causal: "high",
    source_completeness: 1,
  };
  canonical.severity = "high";
  canonical.scoring_rationale = ["observed_lower_bound"];
  const reordered = {
    ...canonical,
    impact: {
      kind: "critical_path_latency",
      upper_ms: 120_000,
      expected_ms: 90_000,
      lower_ms: 60_000,
    },
    finding_confidence: {
      source_completeness: 1,
      causal: "high",
      evidence: "high",
    },
  } as Finding;
  const { analysis_id: _id, ...base } = record("ignored", 10);
  const first = makeAnalysisRecord({ ...base, findings: [canonical] });
  const second = makeAnalysisRecord({ ...base, findings: [reordered] });

  assert.equal(first.analysis_id, second.analysis_id);
  assert.deepEqual(first.findings, second.findings);
  assert.equal(first.findings[0]?.confidence, "high");
  assert.deepEqual(first.findings[0]?.recoverable, {
    min: 2,
    bound: "upper",
  });
  assert.deepEqual(first.findings[0]?.impact, {
    lower_ms: 60_000,
    expected_ms: 90_000,
    upper_ms: 120_000,
    kind: "critical_path_latency",
  });
  canonical.impact.lower_ms = 0;
  canonical.finding_confidence.evidence = "low";
  assert.equal(first.findings[0]?.impact?.lower_ms, 60_000);
  assert.equal(first.findings[0]?.finding_confidence?.evidence, "high");

  await temporaryStore(async (paths) => {
    assert.deepEqual((await saveAnalysis(paths, first)).warnings, []);
    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.records, [first]);
  });
});

test("validates an existing snapshot digest before normalizing its legacy finding", async () => {
  await temporaryStore(async (paths) => {
    const legacy = {
      ...record("legacy-snapshot-execution", 20),
      findings: [legacyFinding("legacy-snapshot-finding", {
        confidence: "high",
        bound: "point",
        recoverableMin: 2,
      })],
    };
    const {
      analysis_id: executionId,
      created_at_ms: executedAtMs,
      ...payload
    } = legacy;
    const envelope = {
      schema_version: 1 as const,
      identity: { mode: "content-fallback" as const },
      payload,
    };
    const recordJson = canonicalJson(envelope);
    const snapshotId = analysisDigest("analysis-snapshot-v1", envelope);
    const database = openStoreDatabase(paths);
    try {
      database.prepare(`INSERT INTO analysis_snapshots
        (snapshot_id, created_at_ms, record_json) VALUES (?, ?, ?)`)
        .run(snapshotId, executedAtMs, recordJson);
      database.prepare(`INSERT INTO analysis_executions
        (execution_id, snapshot_id, executed_at_ms) VALUES (?, ?, ?)`)
        .run(executionId, snapshotId, executedAtMs);
    } finally {
      database.close();
    }

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.equal(loaded.records[0]?.analysis_id, executionId);
    assert.equal(
      loaded.records[0]?.findings[0]?.finding_key,
      "legacy-snapshot-finding",
    );
    assert.deepEqual(loaded.records[0]?.findings[0]?.impact, {
      lower_ms: 0,
      upper_ms: 120_000,
      kind: "critical_path_latency",
    });
    assert.deepEqual(loaded.records[0]?.findings[0]?.recoverable, {
      min: 2,
      bound: "upper",
    });
  });
});

test("rejects hostile canonical finding shapes without invoking or disclosing them", () => {
  const source = finding("hostile-canonical", "npm test", 2);
  const canary = "ATTACKER_CANARY";
  let getterCalled = false;
  const accessorImpact = {
    upper_ms: 120_000,
    kind: "critical_path_latency",
  } as unknown as ImpactEstimate;
  Object.defineProperty(accessorImpact, "lower_ms", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error(canary);
    },
  });
  const hiddenImpact: ImpactEstimate = {
    lower_ms: 120_000,
    upper_ms: 120_000,
    kind: "critical_path_latency",
  };
  Object.defineProperty(hiddenImpact, canary, { value: 1, enumerable: false });
  const throwingImpactTarget: ImpactEstimate = {
    lower_ms: 120_000,
    upper_ms: 120_000,
    kind: "critical_path_latency",
  };
  const throwingImpact = new Proxy(throwingImpactTarget, {
    ownKeys() {
      throw new Error(canary);
    },
  });
  const revocableTarget: ImpactEstimate = {
    lower_ms: 120_000,
    upper_ms: 120_000,
    kind: "critical_path_latency",
  };
  const revocable = Proxy.revocable(revocableTarget, {});
  revocable.revoke();
  const hostileValues: Finding[] = [
    { ...source, impact: {
      lower_ms: 120_000,
      upper_ms: 120_000,
    } as unknown as ImpactEstimate },
    { ...source, impact: {
      ...source.impact!,
      [canary]: true,
    } as unknown as ImpactEstimate },
    { ...source, impact: hiddenImpact },
    { ...source, impact: accessorImpact },
    { ...source, impact: Object.create({ inherited: canary }) as ImpactEstimate },
    { ...source, impact: new Proxy(source.impact!, {}) },
    { ...source, impact: throwingImpact },
    { ...source, impact: revocable.proxy },
    { ...source, finding_confidence: {
      ...source.finding_confidence!,
      [canary]: true,
    } as unknown as FindingConfidence },
    { ...source, finding_confidence: new Proxy(
      source.finding_confidence!,
      {},
    ) },
    { ...source, scoring_rationale: new Proxy(
      source.scoring_rationale!,
      {},
    ) },
  ];
  const topLevelAccessor = { ...source };
  Object.defineProperty(topLevelAccessor, "impact", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error(canary);
    },
  });
  hostileValues.push(topLevelAccessor);

  for (const hostile of hostileValues) {
    assert.throws(
      () => makeAnalysisRecord({
        ...record("hostile-record", 30),
        findings: [hostile],
      }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, "invalid finding");
        assert.equal(error.message.includes(canary), false);
        return true;
      },
    );
  }
  assert.equal(getterCalled, false);
});

test("rejects hostile finding containers without invoking or disclosing them", () => {
  const source = finding("hostile-container", "npm test", 2);
  const canary = "FINDINGS_CONTAINER_CANARY";
  let getterCalled = false;
  const accessor = new Array<Finding>(1);
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error(canary);
    },
  });
  const nonEnumerable = [source];
  Object.defineProperty(nonEnumerable, "0", {
    value: source,
    enumerable: false,
  });
  const extra = [source];
  Object.defineProperty(extra, "extra", { value: canary, enumerable: true });
  const symbol = [source];
  Object.defineProperty(symbol, Symbol(canary), {
    value: canary,
    enumerable: true,
  });
  const revocable = Proxy.revocable([source], {});
  revocable.revoke();
  const hostileContainers: readonly (readonly Finding[])[] = [
    new Proxy([source], {}),
    revocable.proxy,
    new Array<Finding>(1),
    extra,
    symbol,
    nonEnumerable,
    accessor,
  ];

  const outcomes = hostileContainers.map((findings) => {
    try {
      makeAnalysisRecord({
        ...record("hostile-container-record", 31),
        findings,
      });
      return "accepted";
    } catch (error) {
      return error instanceof TypeError ? error.message : "unexpected error";
    }
  });
  assert.deepEqual({ outcomes, getterCalled }, {
    outcomes: hostileContainers.map(() => "invalid finding"),
    getterCalled: false,
  });
});

test("privacy projections preserve canonical numeric and fixed finding fields", () => {
  const canonical = finding("privacy-canonical", "npm test", 2);
  const report: ReportV2 = {
    version: 2,
    unit: { repo: "/repo", pr_ref: "main...feature", sessions: ["s1"] },
    summary,
    findings: [canonical],
    caveats: [],
  };
  for (const profile of ["strict", "balanced"] as const) {
    const projected = projectReportPrivacy(report, profile).findings[0];
    assert.deepEqual(projected?.impact, canonical.impact);
    assert.deepEqual(
      projected?.finding_confidence,
      canonical.finding_confidence,
    );
    assert.equal(projected?.severity, canonical.severity);
    assert.deepEqual(projected?.scoring_rationale, canonical.scoring_rationale);
    assert.notEqual(projected?.impact, canonical.impact);
    assert.notEqual(
      projected?.finding_confidence,
      canonical.finding_confidence,
    );
    assert.notEqual(projected?.scoring_rationale, canonical.scoring_rationale);
  }
});

interface TerminalStatsSnapshotV1 {
  schema_version: 1;
  measured_wall_ms: number;
  confirmed_critical_path_ms: number;
  estimated_critical_path_upper_ms: number;
  resource_cost_ms: number;
  human_wait_ms: number;
  unexplained_ms: number;
  cohort: {
    repository_id: string;
    workspace_id: string;
    changed_files: number;
    changed_lines?: number;
  };
  rules: Array<{
    rule_id: RuleId;
    rule_version: string;
    compatibility_epoch: number;
    confirmed_critical_path_ms: number;
    estimated_critical_path_upper_ms: number;
    resource_cost_ms: number;
  }>;
  incomplete_interval_findings: number;
}

type StoredTerminalStatsExportContract =
  ExportedTerminalStatsSnapshotV1 extends TerminalStatsSnapshotV1
    ? true
    : false;
const storedTerminalStatsExportContract: StoredTerminalStatsExportContract = true;
void storedTerminalStatsExportContract;

type AnalysisRecordWithTerminalSnapshot = AnalysisRecord & {
  terminal_stats_snapshot?: TerminalStatsSnapshotV1;
};

function storedTerminalStatsSnapshot(): TerminalStatsSnapshotV1 {
  const ruleIds: readonly RuleId[] = [
    "R001", "R002", "R003", "R004", "R005", "R006", "R007", "R008",
  ];
  return {
    schema_version: 1,
    measured_wall_ms: 1_000,
    confirmed_critical_path_ms: 100,
    estimated_critical_path_upper_ms: 200,
    resource_cost_ms: 300,
    human_wait_ms: 50,
    unexplained_ms: 25,
    cohort: {
      repository_id: "1".repeat(64),
      workspace_id: "2".repeat(64),
      changed_files: 4,
      changed_lines: 199,
    },
    rules: ruleIds.map((ruleId) => {
      const manifest = ruleManifest(ruleId);
      return {
        rule_id: ruleId,
        rule_version: manifest.version,
        compatibility_epoch: manifest.compatibility_epoch,
        confirmed_critical_path_ms: ruleId === "R001" ? 100 : 0,
        estimated_critical_path_upper_ms: ruleId === "R001" ? 200 : 0,
        resource_cost_ms: ruleId === "R005" ? 300 : 0,
      };
    }),
    incomplete_interval_findings: 2,
  };
}

test("analysis records clone and persist optional terminal stats snapshots", async () => {
  const source = storedTerminalStatsSnapshot();
  const expected = structuredClone(source);
  const input = {
    ...record("terminal-stats-round-trip", 100),
    terminal_stats_snapshot: source,
  };
  const normalized = makeAnalysisRecord(input) as AnalysisRecordWithTerminalSnapshot;

  assert.deepEqual(normalized.terminal_stats_snapshot, expected);
  assert.notEqual(normalized.terminal_stats_snapshot, source);
  assert.notEqual(normalized.terminal_stats_snapshot?.cohort, source.cohort);
  assert.notEqual(normalized.terminal_stats_snapshot?.rules, source.rules);
  source.cohort.changed_files = 99;
  source.rules[0]!.confirmed_critical_path_ms = 99;
  assert.deepEqual(normalized.terminal_stats_snapshot, expected);

  await temporaryStore(async (paths) => {
    assert.deepEqual((await saveAnalysis(paths, normalized)).warnings, []);
    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.records, [normalized]);
    const loadedRecord = loaded.records[0] as
      AnalysisRecordWithTerminalSnapshot | undefined;
    assert.deepEqual(loadedRecord?.terminal_stats_snapshot, expected);
    assert.notEqual(
      loadedRecord?.terminal_stats_snapshot,
      normalized.terminal_stats_snapshot,
    );
  });
});

test("legacy records omit rather than synthesize terminal stats snapshots", () => {
  const legacy = makeAnalysisRecord(record("legacy-terminal-stats", 101)) as
    AnalysisRecordWithTerminalSnapshot;
  assert.equal("terminal_stats_snapshot" in legacy, false);

  const omitted = { ...record("omitted-terminal-stats", 102) };
  const normalized = makeAnalysisRecord(omitted) as
    AnalysisRecordWithTerminalSnapshot;
  assert.equal("terminal_stats_snapshot" in normalized, false);
});

test("analysis records reject malformed terminal stats snapshot presence", () => {
  const canonical = storedTerminalStatsSnapshot();
  const malformed: unknown[] = [
    null,
    { ...canonical, schema_version: 2 },
    { ...canonical, measured_wall_ms: -1 },
    { ...canonical, unknown: "raw/private/path" },
    { ...canonical, confirmed_critical_path_ms: 201 },
    { ...canonical, resource_cost_ms: 301 },
  ];

  for (const terminalStats of malformed) {
    const input = {
      ...record("malformed-terminal-stats", 103),
      terminal_stats_snapshot: terminalStats,
    };
    assert.throws(
      () => makeAnalysisRecord(
        input as unknown as Parameters<typeof makeAnalysisRecord>[0],
      ),
      TypeError,
    );
  }
});

test("terminal stats descriptors fail closed without evaluating hostile input", () => {
  const canary = "TERMINAL_STORE_CANARY";
  let reads = 0;
  const accessor = record("terminal-stats-accessor", 104) as
    AnalysisRecordWithTerminalSnapshot;
  Object.defineProperty(accessor, "terminal_stats_snapshot", {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error(canary);
    },
  });
  const hidden = record("terminal-stats-hidden", 105) as
    AnalysisRecordWithTerminalSnapshot;
  Object.defineProperty(hidden, "terminal_stats_snapshot", {
    enumerable: false,
    value: storedTerminalStatsSnapshot(),
  });
  const proxiedSnapshot = new Proxy(storedTerminalStatsSnapshot(), {
    get() {
      reads += 1;
      throw new Error(canary);
    },
  });

  for (const input of [
    accessor,
    hidden,
    {
      ...record("terminal-stats-proxy", 106),
      terminal_stats_snapshot: proxiedSnapshot,
    },
  ]) {
    assert.throws(
      () => makeAnalysisRecord(input),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.equal(String(error).includes(canary), false);
        return true;
      },
    );
  }
  assert.equal(reads, 0);
});

test("snapshot reads reject malformed terminal stats despite a valid digest", async () => {
  await temporaryStore(async (paths) => {
    const stored = record("malformed-terminal-read", 107);
    const { analysis_id: executionId, created_at_ms: executedAtMs, ...payload } =
      stored;
    const envelope = {
      schema_version: 1 as const,
      identity: { mode: "content-fallback" as const },
      payload: {
        ...payload,
        terminal_stats_snapshot: {
          ...storedTerminalStatsSnapshot(),
          measured_wall_ms: -1,
        },
      },
    };
    const recordJson = canonicalJson(envelope);
    const snapshotId = analysisDigest("analysis-snapshot-v1", envelope);
    const database = openStoreDatabase(paths);
    try {
      database.prepare(`INSERT INTO analysis_snapshots
        (snapshot_id, created_at_ms, record_json) VALUES (?, ?, ?)`)
        .run(snapshotId, executedAtMs, recordJson);
      database.prepare(`INSERT INTO analysis_executions
        (execution_id, snapshot_id, executed_at_ms) VALUES (?, ?, ?)`)
        .run(executionId, snapshotId, executedAtMs);
    } finally {
      database.close();
    }

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.records, []);
    assert.ok(loaded.warnings.some(
      ({ code }) => code === "corrupt_analysis_record",
    ));
  });
});
