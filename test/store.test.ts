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
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AnalysisSummary,
  CommandIdentity,
  Finding,
} from "../src/core/model.js";
import { commandIdentityKey } from "../src/analysis/command-identity.js";
import { detectChronicCost } from "../src/rules/chronic-cost.js";
import { findingKey } from "../src/rules/shared.js";
import {
  loadAdoptions,
  saveAdoptions,
  type AdoptionRecord,
} from "../src/store/adoptions.js";
import {
  computeBaseline,
  loadAnalyses,
  makeAnalysisRecord,
  saveAnalysis,
  type AnalysisRecord,
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
  return {
    finding_key: key,
    rule_id: "R002",
    title: "Repeated command",
    classification: "behavior",
    cause: null,
    scope: "this_pr",
    confidence: "high",
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

test("SQLite bootstrap is private, idempotent, and creates the Store v2 schema", async () => {
  await temporaryStore(async (paths) => {
    assert.equal(STORE_SCHEMA_VERSION, 2);
    const databasePath = storeDatabasePath(paths);
    const first = openStoreDatabase(paths);
    const second = openStoreDatabase(paths);
    try {
      assertConnectionPragmas(first);
      assertConnectionPragmas(second);
      assert.equal(Number(first.pragma("user_version", { simple: true })), 2);
      assert.equal(Number(second.pragma("user_version", { simple: true })), 2);

      if (process.platform !== "win32") {
        assert.equal((await stat(paths.repo_dir)).mode & 0o777, 0o700);
        assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
      }

      const tables = first.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as { name: string }[];
      assert.deepEqual(tables.map(({ name }) => name), [
        "adoptions",
        "analysis_executions",
        "analysis_snapshots",
        "dismissals",
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
      };
      for (const [table, expected] of Object.entries(expectedColumns)) {
        const columns = tableColumns(first, table);
        assert.deepEqual(
          columns.map(({ name, type, pk }) => [name, type.toUpperCase(), pk]),
          expected,
        );
        assert.ok(columns.every(({ notnull }) => notnull === 1));
      }

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
    } finally {
      second.close();
      first.close();
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

test("opening an existing v2 schema does not contend with an active writer", async () => {
  await temporaryStore(async (paths) => {
    const writer = openStoreDatabase(paths);
    let reader: StoreDatabase | undefined;
    try {
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

test("analysis records are immutable, complete, atomically indexed, and stably ordered", async () => {
  await temporaryStore(async (paths) => {
    const later = record("later", 200);
    const earlier = record("earlier", 100);
    assert.deepEqual((await saveAnalysis(paths, later)).warnings, []);
    assert.deepEqual((await saveAnalysis(paths, earlier)).warnings, []);

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(
      loaded.records.map(({ analysis_id }) => analysis_id),
      ["earlier", "later"],
    );
    assert.deepEqual(loaded.records[1]?.findings, later.findings);
    assert.equal(loaded.records[1]?.findings.length, 1);

    const index = JSON.parse(await readFile(paths.history_index_path, "utf8")) as {
      analyses: { analysis_id: string }[];
    };
    assert.deepEqual(
      index.analyses.map(({ analysis_id }) => analysis_id),
      ["earlier", "later"],
    );
    const files = [
      ...(await readdir(paths.repo_dir)),
      ...(await readdir(paths.analyses_dir)),
    ];
    assert.equal(files.some((path) => path.endsWith(".tmp")), false);
  });
});

test("corrupt indexes rebuild from immutable records and corrupt records are skipped", async () => {
  await temporaryStore(async (paths) => {
    await saveAnalysis(paths, record("good", 100));
    await writeFile(paths.history_index_path, "{not json", "utf8");
    await writeFile(join(paths.analyses_dir, "broken.json"), "{bad", "utf8");
    await writeFile(
      join(paths.analyses_dir, "null-finding.json"),
      JSON.stringify({
        ...record("null-finding", 200),
        findings: [null],
      }),
      "utf8",
    );
    await writeFile(
      join(paths.analyses_dir, "bad-evidence.json"),
      JSON.stringify({
        ...record("bad-evidence", 300),
        findings: [{
          ...finding("bad-evidence"),
          evidence: null,
        }],
      }),
      "utf8",
    );

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(
      loaded.records.map(({ analysis_id }) => analysis_id),
      ["good"],
    );
    assert.ok(
      loaded.warnings.some(({ code }) => code === "corrupt_history_index"),
    );
    assert.ok(
      loaded.warnings.some(({ code }) => code === "corrupt_analysis_record"),
    );
    assert.equal(
      loaded.warnings.filter(
        ({ code }) => code === "corrupt_analysis_record",
      ).length,
      3,
    );
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

test("dismissals persist reasons and report write failures as warnings", async () => {
  await temporaryStore(async (paths, root) => {
    const saved = await saveDismissal(paths, {
      finding_key: "finding-a",
      target: "npm test",
      dismissed_at_ms: 1_000,
      strength_min: 10,
      reason: "Local trade-off.",
    });
    assert.deepEqual(saved.warnings, []);
    const loaded = await loadDismissals(paths);
    assert.equal(loaded.records[0]?.reason, "Local trade-off.");

    const blockingFile = join(root, "dismissal-block");
    await writeFile(blockingFile, "not a directory", "utf8");
    const blocked: StorePaths = {
      ...paths,
      repo_dir: blockingFile,
      dismissals_path: join(blockingFile, "dismissals.json"),
    };
    const failed = await saveDismissal(blocked, {
      finding_key: "finding-b",
      target: "cargo test",
      dismissed_at_ms: 2_000,
      strength_min: 5,
    });
    assert.ok(
      failed.warnings.some(({ code }) => code === "dismissal_write_failed"),
    );
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

test("adoptions round-trip through the store", async () => {
  await temporaryStore(async (paths) => {
    const warnings = await saveAdoptions(paths, [adoption("finding-a")]);
    assert.deepEqual(warnings, []);
    const loaded = await loadAdoptions(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.records, [adoption("finding-a")]);
  });
});

test("corrupt adoption files degrade to a warning and an empty result", async () => {
  await temporaryStore(async (paths) => {
    await mkdir(paths.repo_dir, { recursive: true });
    await writeFile(paths.adoptions_path, "{not json", "utf8");
    const loaded = await loadAdoptions(paths);
    assert.deepEqual(loaded.records, []);
    assert.ok(
      loaded.warnings.some(({ code }) => code === "corrupt_adoptions"),
    );
  });
});

test("adoptions dedupe by finding_key, keeping the first entry", async () => {
  await temporaryStore(async (paths) => {
    await saveAdoptions(paths, [
      adoption("finding-a", { method: "claude_md_edit" }),
      adoption("finding-a", { method: "target_file_edit" }),
    ]);
    const loaded = await loadAdoptions(paths);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.method, "claude_md_edit");
  });
});

test("adoption write failures return warnings without throwing", async () => {
  await temporaryStore(async (paths, root) => {
    const blockingFile = join(root, "adoption-block");
    await writeFile(blockingFile, "not a directory", "utf8");
    const blocked: StorePaths = {
      ...paths,
      repo_dir: blockingFile,
      adoptions_path: join(blockingFile, "adoptions.json"),
    };
    const warnings = await saveAdoptions(blocked, [adoption("finding-a")]);
    assert.ok(
      warnings.some(({ code }) => code === "adoption_write_failed"),
    );
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
