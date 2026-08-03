import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CliUsageError,
  parseCliArgs,
  runCli,
  type CliHandlers,
} from "../src/cli.js";
import {
  runDataCommand,
  type DataCommandDependencies,
} from "../src/commands/data.js";
import { loadAdoptions } from "../src/store/adoptions.js";
import { loadAnalyses } from "../src/store/analyses.js";
import { loadDismissals } from "../src/store/dismissals.js";
import {
  resolveStorePaths,
  type StorePaths,
} from "../src/store/paths.js";
import { openStoreDatabase, storeDatabasePath } from "../src/store/sqlite.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW_MS = 200 * DAY_MS;
const ANALYSIS_CUTOFF_MS = NOW_MS - (90 * DAY_MS);
const DISMISSAL_CUTOFF_MS = NOW_MS - (14 * DAY_MS);

async function withStore(
  callback: (paths: StorePaths, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-data-test-"));
  try {
    const repoRoot = join(root, "repo");
    await mkdir(repoRoot);
    const paths = await resolveStorePaths(repoRoot, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
      home_dir: join(root, "home"),
    });
    await callback(paths, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function dependencies(paths: StorePaths): DataCommandDependencies {
  return {
    resolveRepoRoot: async () => paths.canonical_repo,
    resolveStorePaths: async () => paths,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function completeMigrations(paths: StorePaths): Promise<void> {
  assert.deepEqual((await loadAnalyses(paths)).warnings, []);
  assert.deepEqual((await loadDismissals(paths)).warnings, []);
  assert.deepEqual((await loadAdoptions(paths)).warnings, []);
}

function stubHandlers(
  data: NonNullable<CliHandlers["data"]>,
): CliHandlers {
  return {
    analyze: async () => ({ stdout: "", warnings: [] }),
    stats: async () => ({ stdout: "", warnings: [] }),
    dismiss: async () => ({ stdout: "", warnings: [] }),
    hookEvent: async () => ({ stdout: "", warnings: [] }),
    hooks: async () => ({ stdout: "", warnings: [] }),
    data,
  };
}

test("data subcommands parse strictly and preserve global help precedence", () => {
  assert.deepEqual(parseCliArgs(["data", "gc"]), {
    kind: "data",
    action: "gc",
  });
  assert.deepEqual(parseCliArgs(["data", "delete"]), {
    kind: "data",
    action: "delete",
  });
  assert.deepEqual(parseCliArgs(["data", "gc", "--help"]), { kind: "help" });
  for (const args of [
    ["data"],
    ["data", "unknown"],
    ["data", "gc", "extra"],
    ["data", "delete", "--yes"],
  ]) {
    assert.throws(() => parseCliArgs(args), CliUsageError, args.join(" "));
  }
});

test("runCli dispatches data without analysis privacy and keeps failures path-free", async () => {
  const received: unknown[] = [];
  let stdout = "";
  let stderr = "";
  const code = await runCli(["data", "gc"], {
    cwd: "/repo",
    handlers: stubHandlers(async (options) => {
      received.push(options);
      return { stdout: "garbage collection complete\n", warnings: [] };
    }),
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  assert.equal(code, 0);
  assert.deepEqual(received, [{ cwd: "/repo", action: "gc" }]);
  assert.equal(stdout, "garbage collection complete\n");
  assert.equal(stderr, "");

  const privatePath = "/Users/alice/private/ccprof/store.sqlite3";
  stderr = "";
  const failed = await runCli(["data", "delete"], {
    cwd: "/repo",
    handlers: stubHandlers(async (options) => runDataCommand(options, {
      resolveRepoRoot: async () => { throw new Error(privatePath); },
    })),
    stdout: () => undefined,
    stderr: (value) => { stderr += value; },
  });
  assert.equal(failed, 5);
  assert.match(stderr, /Store deletion failed/iu);
  assert.doesNotMatch(stderr, /alice|private|store\.sqlite3/iu);
});

test("runDataCommand rejects an unknown runtime action without deleting repository data", async () => {
  await withStore(async (paths) => {
    await mkdir(paths.repo_dir, { recursive: true });
    const canary = join(paths.repo_dir, "canary.txt");
    await writeFile(canary, "keep", "utf8");
    const action = "unknown" as unknown as Parameters<
      typeof runDataCommand
    >[0]["action"];

    let rejection: unknown;
    try {
      await runDataCommand(
        { cwd: paths.canonical_repo, action },
        dependencies(paths),
      );
    } catch (error) {
      rejection = error;
    }

    assert.equal(await exists(canary), true);
    assert.equal(await readFile(canary, "utf8"), "keep");
    assert.ok(rejection instanceof Error);
  });
});

test("data gc applies retention boundaries, reachability, and legacy cleanup", async () => {
  await withStore(async (paths) => {
    await completeMigrations(paths);
    const database = openStoreDatabase(paths);
    try {
      const snapshot = database.prepare(`INSERT INTO analysis_snapshots
        (snapshot_id, created_at_ms, record_json) VALUES (?, ?, ?)`);
      const execution = database.prepare(`INSERT INTO analysis_executions
        (execution_id, snapshot_id, executed_at_ms) VALUES (?, ?, ?)`);
      snapshot.run("shared", 1, "{}");
      execution.run("shared-old", "shared", ANALYSIS_CUTOFF_MS - 1);
      execution.run("shared-boundary", "shared", ANALYSIS_CUTOFF_MS);
      snapshot.run("old-only", 1, "{}");
      execution.run("old-only-run", "old-only", ANALYSIS_CUTOFF_MS - 1);
      snapshot.run("fresh-orphan", NOW_MS, "{}");
      snapshot.run("future", NOW_MS + 1, "{}");
      execution.run("future-run", "future", NOW_MS + 1);

      const dismissal = database.prepare(`INSERT INTO dismissals
        (finding_key, dismissed_at_ms, record_json) VALUES (?, ?, '{}')`);
      dismissal.run("expired-before", DISMISSAL_CUTOFF_MS - 1);
      dismissal.run("expired-boundary", DISMISSAL_CUTOFF_MS);
      dismissal.run("active", DISMISSAL_CUTOFF_MS + 1);
      const adoption = database.prepare(`INSERT INTO adoptions
        (finding_key, detected_at_ms, record_json) VALUES (?, ?, '{}')`);
      adoption.run("old", ANALYSIS_CUTOFF_MS - 1);
      adoption.run("boundary", ANALYSIS_CUTOFF_MS);
      adoption.run("future", NOW_MS + 1);
    } finally {
      database.close();
    }

    await mkdir(paths.analyses_dir, { recursive: true });
    await writeFile(join(paths.analyses_dir, "legacy.json"), "{}", "utf8");
    await writeFile(paths.history_index_path, "{}", "utf8");
    await writeFile(paths.dismissals_path, "{}", "utf8");
    await writeFile(paths.adoptions_path, "{}", "utf8");
    const hookBoundary = JSON.stringify({
      received_at_ms: NOW_MS - (30 * DAY_MS),
      session_id: "boundary",
      hook_event_name: "Stop",
    });
    await writeFile(paths.hook_events_path, [
      JSON.stringify({
        received_at_ms: NOW_MS - (30 * DAY_MS) - 1,
        session_id: "old",
        hook_event_name: "Stop",
      }),
      "{malformed",
      hookBoundary,
      "",
    ].join("\n"), "utf8");

    const result = await runDataCommand(
      { cwd: paths.canonical_repo, action: "gc", nowMs: NOW_MS },
      dependencies(paths),
    );
    assert.equal(result.warnings.length, 0);
    assert.match(result.stdout, /garbage collection/iu);
    assert.ok(!result.stdout.includes(paths.root_dir));

    const after = openStoreDatabase(paths);
    try {
      assert.deepEqual(
        (after.prepare("SELECT execution_id FROM analysis_executions ORDER BY execution_id")
          .pluck().all() as string[]),
        ["future-run", "shared-boundary"],
      );
      assert.deepEqual(
        (after.prepare("SELECT snapshot_id FROM analysis_snapshots ORDER BY snapshot_id")
          .pluck().all() as string[]),
        ["future", "shared"],
      );
      assert.deepEqual(
        (after.prepare("SELECT finding_key FROM dismissals ORDER BY finding_key")
          .pluck().all() as string[]),
        ["active"],
      );
      assert.deepEqual(
        (after.prepare("SELECT finding_key FROM adoptions ORDER BY finding_key")
          .pluck().all() as string[]),
        ["boundary", "future"],
      );
      assert.equal(after.prepare("SELECT count(*) FROM store_migrations")
        .pluck().get(), 3);
    } finally {
      after.close();
    }
    assert.equal(await exists(paths.analyses_dir), false);
    assert.equal(await exists(paths.history_index_path), false);
    assert.equal(await exists(paths.dismissals_path), false);
    assert.equal(await exists(paths.adoptions_path), false);
    assert.equal(await readFile(paths.hook_events_path, "utf8"), `${hookBoundary}\n`);
  });
});

test("data gc rolls back every SQLite deletion group on a write failure", async () => {
  await withStore(async (paths) => {
    await completeMigrations(paths);
    const database = openStoreDatabase(paths);
    try {
      database.prepare(`INSERT INTO analysis_snapshots
        (snapshot_id, created_at_ms, record_json) VALUES ('old', 1, '{}')`).run();
      database.prepare(`INSERT INTO analysis_executions
        (execution_id, snapshot_id, executed_at_ms) VALUES ('old-run', 'old', 1)`).run();
      database.prepare(`INSERT INTO dismissals
        (finding_key, dismissed_at_ms, record_json) VALUES ('old', 1, '{}')`).run();
      database.prepare(`INSERT INTO adoptions
        (finding_key, detected_at_ms, record_json) VALUES ('old', 1, '{}')`).run();
      database.exec(`CREATE TRIGGER reject_adoption_delete
        BEFORE DELETE ON adoptions BEGIN
          SELECT RAISE(ABORT, 'forced data gc failure');
        END`);
    } finally {
      database.close();
    }

    await assert.rejects(
      runDataCommand(
        { cwd: paths.canonical_repo, action: "gc", nowMs: NOW_MS },
        dependencies(paths),
      ),
      /garbage collection failed/iu,
    );
    const after = openStoreDatabase(paths);
    try {
      for (const table of [
        "analysis_snapshots",
        "analysis_executions",
        "dismissals",
        "adoptions",
      ]) {
        assert.equal(after.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), 1);
      }
    } finally {
      after.close();
    }
  });
});

test("data gc aborts on an incomplete unsafe migration without following it", async () => {
  await withStore(async (paths, root) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const canary = join(outside, "canary.txt");
    await writeFile(canary, "keep", "utf8");
    await mkdir(paths.repo_dir, { recursive: true });
    await symlink(outside, paths.analyses_dir, "dir");

    let message = "";
    await assert.rejects(
      runDataCommand(
        { cwd: paths.canonical_repo, action: "gc", nowMs: NOW_MS },
        dependencies(paths),
      ),
      (error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
        return /garbage collection failed/iu.test(message);
      },
    );
    assert.ok(!message.includes(root));
    assert.equal(await readFile(canary, "utf8"), "keep");
    assert.equal((await lstat(paths.analyses_dir)).isSymbolicLink(), true);
    const database = openStoreDatabase(paths);
    try {
      assert.equal(database.prepare(`SELECT count(*) FROM store_migrations
        WHERE name = 'legacy-analyses-json-v1'`).pluck().get(), 0);
    } finally {
      database.close();
    }
  });
});

test("forced hook compaction refuses a symlink and does not expose its path", async () => {
  await withStore(async (paths, root) => {
    await completeMigrations(paths);
    const outside = join(root, "outside-hook.jsonl");
    await writeFile(outside, "private hook data\n", "utf8");
    await symlink(outside, paths.hook_events_path);

    let message = "";
    await assert.rejects(
      runDataCommand(
        { cwd: paths.canonical_repo, action: "gc", nowMs: NOW_MS },
        dependencies(paths),
      ),
      (error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
        return /garbage collection failed/iu.test(message);
      },
    );
    assert.ok(!message.includes(root));
    assert.equal(await readFile(outside, "utf8"), "private hook data\n");
    assert.equal((await lstat(paths.hook_events_path)).isSymbolicLink(), true);
  });
});

test("forced hook compaction rejects an lstat-to-open symlink swap", async () => {
  await withStore(async (paths, root) => {
    await completeMigrations(paths);
    await writeFile(paths.hook_events_path, `${JSON.stringify({
      received_at_ms: NOW_MS,
      session_id: "inside",
      hook_event_name: "Stop",
    })}\n`, "utf8");
    const outside = join(root, "outside-hook-canary.jsonl");
    await writeFile(outside, "outside canary\n", "utf8");

    const mutableFsPromises = createRequire(import.meta.url)(
      "node:fs/promises",
    ) as { lstat: typeof import("node:fs/promises").lstat };
    const originalLstat = mutableFsPromises.lstat;
    let swapped = false;
    mutableFsPromises.lstat = (async (...args: unknown[]) => {
      const info = await Reflect.apply(originalLstat, undefined, args) as
        Awaited<ReturnType<typeof originalLstat>>;
      if (!swapped && args[0] === paths.hook_events_path) {
        await rm(paths.hook_events_path);
        await symlink(outside, paths.hook_events_path);
        swapped = true;
      }
      return info;
    }) as typeof originalLstat;

    let rejection: unknown;
    try {
      syncBuiltinESMExports();
      try {
        await runDataCommand(
          { cwd: paths.canonical_repo, action: "gc", nowMs: NOW_MS },
          dependencies(paths),
        );
      } catch (error) {
        rejection = error;
      }
    } finally {
      mutableFsPromises.lstat = originalLstat;
      syncBuiltinESMExports();
    }

    assert.equal(swapped, true);
    assert.ok(rejection instanceof Error);
    assert.match(rejection.message, /garbage collection failed/iu);
    assert.equal(await readFile(outside, "utf8"), "outside canary\n");
  });
});

test("data delete is scoped, future-schema agnostic, idempotent, and symlink-safe", async () => {
  await withStore(async (paths, root) => {
    let result = await runDataCommand(
      { cwd: paths.canonical_repo, action: "delete" },
      dependencies(paths),
    );
    assert.equal(result.warnings.length, 0);
    assert.ok(!result.stdout.includes(root));

    await mkdir(join(paths.repo_dir, "unknown"), { recursive: true });
    await writeFile(storeDatabasePath(paths), "future schema bytes", "utf8");
    await writeFile(join(paths.repo_dir, "store.sqlite3-wal"), "wal", "utf8");
    await writeFile(join(paths.repo_dir, "unknown", "remnant"), "x", "utf8");
    result = await runDataCommand(
      { cwd: paths.canonical_repo, action: "delete" },
      dependencies(paths),
    );
    assert.match(result.stdout, /deleted/iu);
    assert.equal(await exists(paths.repo_dir), false);
    await runDataCommand(
      { cwd: paths.canonical_repo, action: "delete" },
      dependencies(paths),
    );

    const outside = join(root, "outside-delete");
    await mkdir(outside);
    const canary = join(outside, "canary");
    await writeFile(canary, "keep", "utf8");
    await mkdir(paths.root_dir, { recursive: true });
    await symlink(outside, paths.repo_dir, "dir");
    await assert.rejects(
      runDataCommand(
        { cwd: paths.canonical_repo, action: "delete" },
        dependencies(paths),
      ),
      /Store deletion failed/iu,
    );
    assert.equal(await readFile(canary, "utf8"), "keep");
    assert.equal((await lstat(paths.repo_dir)).isSymbolicLink(), true);
  });
});

test("data delete refuses a forged repository Store path", async () => {
  await withStore(async (paths, root) => {
    const outside = join(root, "forged-target");
    await mkdir(outside);
    const canary = join(outside, "canary");
    await writeFile(canary, "keep", "utf8");
    const forged: StorePaths = {
      ...paths,
      repo_hash: "a".repeat(64),
      repo_dir: outside,
    };
    await assert.rejects(
      runDataCommand(
        { cwd: paths.canonical_repo, action: "delete" },
        dependencies(forged),
      ),
      /Store deletion failed/iu,
    );
    assert.equal(await readFile(canary, "utf8"), "keep");
  });
});
