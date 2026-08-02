import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseCliArgs,
  runCli,
  USAGE,
  type CliHandlers,
} from "../src/cli.js";
import {
  runHookEventCommand,
  type HookEventCommandDependencies,
} from "../src/commands/hook-event.js";
import type { Finding } from "../src/core/model.js";
import { resolveStorePaths } from "../src/store/paths.js";

async function temporaryStore(
  callback: (
    paths: Awaited<ReturnType<typeof resolveStorePaths>>,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-event-"));
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

async function readJsonlRows(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function finding(title: string): Finding {
  return {
    finding_key: `key-${title}`,
    rule_id: "R001",
    title,
    scope: "this_pr",
    confidence: "high",
    recoverable: { min: 5, bound: "point" },
    fix_recipe: { suggestion: title },
    evidence: {},
    caveats: [],
  } as unknown as Finding;
}

test("valid JSON appends a JSONL row and returns silent success", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
    };
    const result = await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText: JSON.stringify({
          session_id: "session-1",
          hook_event_name: "Stop",
          cwd: "/repo",
        }),
        nowMs: 1_000,
      },
      dependencies,
    );

    assert.deepEqual(result, { stdout: "", warnings: [] });
    const rows = await readJsonlRows(paths.hook_events_path);
    assert.deepEqual(rows, [
      {
        received_at_ms: 1_000,
        session_id: "session-1",
        hook_event_name: "Stop",
      },
    ]);
  });
});

test("broken JSON on stdin appends nothing and returns silent success", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
    };
    for (
      const stdinText of [
        "{not json",
        "\"just a string\"",
        "42",
        "",
        JSON.stringify([{ session_id: "s", hook_event_name: "Stop" }]),
      ]
    ) {
      const result = await runHookEventCommand(
        { cwd: "/repo", stdinText, nowMs: 1_000 },
        dependencies,
      );
      assert.deepEqual(result, { stdout: "", warnings: [] });
    }
    await assert.rejects(readFile(paths.hook_events_path, "utf8"));
  });
});

test("a payload with both session_id and hook_event_name empty/absent appends nothing", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
    };
    for (
      const stdinText of [
        JSON.stringify({}),
        JSON.stringify({ cwd: "/repo" }),
        JSON.stringify({ session_id: "", hook_event_name: "" }),
        JSON.stringify({ session_id: 42, hook_event_name: null }),
      ]
    ) {
      const result = await runHookEventCommand(
        { cwd: "/repo", stdinText, nowMs: 1_000 },
        dependencies,
      );
      assert.deepEqual(result, { stdout: "", warnings: [] });
    }
    await assert.rejects(readFile(paths.hook_events_path, "utf8"));
  });
});

test("an unwritable store target returns silent success without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-event-blocked-"));
  try {
    const blockingFile = join(root, "blocked");
    await writeFile(blockingFile, "not a directory", "utf8");
    const paths = await resolveStorePaths(join(root, "repo"), {
      env: { CCPROF_DATA_DIR: join(root, "data") },
      home_dir: join(root, "home"),
    });
    const blocked = {
      ...paths,
      hook_events_path: join(blockingFile, "hook-events.jsonl"),
    };
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => blocked,
    };
    const result = await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText: JSON.stringify({
          session_id: "session-1",
          hook_event_name: "Stop",
        }),
        nowMs: 1_000,
      },
      dependencies,
    );
    assert.deepEqual(result, { stdout: "", warnings: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo resolution failure returns silent success", async () => {
  const dependencies: HookEventCommandDependencies = {
    resolveRepoRoot: async () => {
      throw new Error("not a git repository");
    },
  };
  const result = await runHookEventCommand(
    {
      cwd: "/nowhere",
      stdinText: JSON.stringify({
        session_id: "session-1",
        hook_event_name: "Stop",
      }),
      nowMs: 1_000,
    },
    dependencies,
  );
  assert.deepEqual(result, { stdout: "", warnings: [] });
});

test("--notify swallows an analyze exception and still returns silent success", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
      analyze: async () => {
        throw new Error("analyze exploded");
      },
    };
    const result = await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText: JSON.stringify({
          session_id: "session-1",
          hook_event_name: "Stop",
        }),
        nowMs: 1_000,
        notify: true,
      },
      dependencies,
    );
    assert.deepEqual(result, { stdout: "", warnings: [] });
    const rows = await readJsonlRows(paths.hook_events_path);
    assert.deepEqual(
      rows.map((row) => (row as { hook_event_name: string }).hook_event_name),
      ["Stop", "ccprof_notified"],
    );
  });
});

test("--notify reports findings count and top title when analyze succeeds", async () => {
  await temporaryStore(async (paths) => {
    let receivedOptions: Parameters<
      NonNullable<HookEventCommandDependencies["analyze"]>
    >[0] | undefined;
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
      analyze: async (options) => {
        receivedOptions = options;
        return {
          report: {
            version: 2,
            unit: { repo: "/repo", pr_ref: null, sessions: [] },
            summary: {} as never,
            findings: [finding("Rework loop"), finding("Serial slack")],
            caveats: [],
          } as never,
        };
      },
    };
    const result = await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText: JSON.stringify({
          session_id: "session-1",
          hook_event_name: "Stop",
        }),
        nowMs: 1_000,
        notify: true,
      },
      dependencies,
    );
    assert.equal(result.warnings.length, 0);
    assert.equal(result.stdout, "2 findings\nRework loop\n");
    assert.equal(receivedOptions?.persist, false);
    assert.equal(receivedOptions?.cwd, "/repo");
  });
});

test("--notify emits nothing when analyze finds zero findings", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
      analyze: async () => ({ report: { findings: [] } as never }),
    };
    const result = await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText: JSON.stringify({
          session_id: "session-1",
          hook_event_name: "Stop",
        }),
        nowMs: 1_000,
        notify: true,
      },
      dependencies,
    );
    assert.deepEqual(result, { stdout: "", warnings: [] });
  });
});

test("--notify does not surface a dismissed finding, even though allFindings still contains it", async () => {
  await temporaryStore(async (paths) => {
    // Simulates what analyze() actually returns after applying
    // dismissals: report.findings is already filtered, while allFindings
    // (unused by notify now) still carries the dismissed finding. If
    // notify ever regresses to summarizing from allFindings again, this
    // assertion catches it directly.
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
      analyze: async () => ({
        report: { findings: [] } as never,
        allFindings: [finding("Dismissed finding")],
      } as never),
    };
    const result = await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText: JSON.stringify({
          session_id: "session-1",
          hook_event_name: "Stop",
        }),
        nowMs: 1_000,
        notify: true,
      },
      dependencies,
    );
    assert.deepEqual(result, { stdout: "", warnings: [] });
  });
});

test("--notify throttles repeated analyze calls within a 10-minute window", async () => {
  await temporaryStore(async (paths) => {
    let analyzeCalls = 0;
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
      analyze: async () => {
        analyzeCalls += 1;
        return { report: { findings: [] } as never };
      },
    };
    const stdinText = JSON.stringify({
      session_id: "session-1",
      hook_event_name: "Stop",
    });

    await runHookEventCommand(
      { cwd: "/repo", stdinText, nowMs: 0, notify: true },
      dependencies,
    );
    assert.equal(analyzeCalls, 1);

    await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText,
        nowMs: 5 * 60 * 1_000,
        notify: true,
      },
      dependencies,
    );
    assert.equal(analyzeCalls, 1, "throttled within 10 minutes");

    await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText,
        nowMs: 10 * 60 * 1_000 + 1,
        notify: true,
      },
      dependencies,
    );
    assert.equal(analyzeCalls, 2, "runs again once the window elapses");
  });
});

test("non-notify hook events never run analyze", async () => {
  await temporaryStore(async (paths) => {
    let analyzeCalls = 0;
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
      analyze: async () => {
        analyzeCalls += 1;
        return { report: { findings: [] } as never };
      },
    };
    await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText: JSON.stringify({
          session_id: "session-1",
          hook_event_name: "Stop",
        }),
        nowMs: 1_000,
      },
      dependencies,
    );
    assert.equal(analyzeCalls, 0);
  });
});

const MAX_HOOK_EVENTS_BYTES = 1024 * 1024;
const COMPACTION_NOW_MS = 40 * 24 * 60 * 60 * 1_000; // day 40
const WITHIN_RETENTION_MS = COMPACTION_NOW_MS - 1_000; // well inside 30 days
const BEYOND_RETENTION_MS = 1_000; // day 0, older than 30 days

function eventLine(
  receivedAtMs: number,
  hookEventName = "Stop",
  sessionId = "s",
): string {
  return JSON.stringify({
    received_at_ms: receivedAtMs,
    session_id: sessionId,
    hook_event_name: hookEventName,
  });
}

/** ~1 KiB per line so ~1100 lines comfortably exceed the 1 MiB cap. */
function paddedEventLine(receivedAtMs: number): string {
  return eventLine(receivedAtMs, "Stop", "x".repeat(1024));
}

function stopPayload(): string {
  return JSON.stringify({ session_id: "session-1", hook_event_name: "Stop" });
}

test("compaction leaves a below-threshold log untouched, even with expired rows", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
    };
    const existing = [
      eventLine(BEYOND_RETENTION_MS),
      "{not json",
      eventLine(WITHIN_RETENTION_MS),
    ].map((line) => `${line}\n`).join("");
    await mkdir(join(paths.hook_events_path, ".."), { recursive: true });
    await writeFile(paths.hook_events_path, existing, "utf8");

    const result = await runHookEventCommand(
      { cwd: "/repo", stdinText: stopPayload(), nowMs: COMPACTION_NOW_MS },
      dependencies,
    );

    assert.deepEqual(result, { stdout: "", warnings: [] });
    const text = await readFile(paths.hook_events_path, "utf8");
    assert.equal(
      text,
      `${existing}${eventLine(COMPACTION_NOW_MS, "Stop", "session-1")}\n`,
      "below the size threshold nothing is rewritten, only appended",
    );
  });
});

test("compaction drops expired rows from an oversized log and keeps recent ones", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
    };
    const expired = Array.from(
      { length: 1_100 },
      () => paddedEventLine(BEYOND_RETENTION_MS),
    );
    const recent = [
      eventLine(WITHIN_RETENTION_MS - 2),
      eventLine(WITHIN_RETENTION_MS - 1),
    ];
    await mkdir(join(paths.hook_events_path, ".."), { recursive: true });
    await writeFile(
      paths.hook_events_path,
      [...expired, ...recent].map((line) => `${line}\n`).join(""),
      "utf8",
    );

    const result = await runHookEventCommand(
      { cwd: "/repo", stdinText: stopPayload(), nowMs: COMPACTION_NOW_MS },
      dependencies,
    );

    assert.deepEqual(result, { stdout: "", warnings: [] });
    const rows = await readJsonlRows(paths.hook_events_path) as {
      received_at_ms: number;
    }[];
    assert.deepEqual(
      rows.map((row) => row.received_at_ms),
      [
        WITHIN_RETENTION_MS - 2,
        WITHIN_RETENTION_MS - 1,
        COMPACTION_NOW_MS,
      ],
      "expired rows are gone, recent rows and the new append survive in order",
    );
    const info = await stat(paths.hook_events_path);
    assert.ok(info.size <= MAX_HOOK_EVENTS_BYTES);
  });
});

test("compaction discards malformed lines from an oversized log", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
    };
    const garbage = Array.from(
      { length: 1_100 },
      () => `{broken json ${"x".repeat(1024)}`,
    );
    const valid = [
      eventLine(WITHIN_RETENTION_MS - 1),
      JSON.stringify({ received_at_ms: "not-a-number" }),
      eventLine(WITHIN_RETENTION_MS),
    ];
    await mkdir(join(paths.hook_events_path, ".."), { recursive: true });
    await writeFile(
      paths.hook_events_path,
      [...garbage, ...valid].map((line) => `${line}\n`).join(""),
      "utf8",
    );

    const result = await runHookEventCommand(
      { cwd: "/repo", stdinText: stopPayload(), nowMs: COMPACTION_NOW_MS },
      dependencies,
    );

    assert.deepEqual(result, { stdout: "", warnings: [] });
    const rows = await readJsonlRows(paths.hook_events_path) as {
      received_at_ms: number;
    }[];
    assert.deepEqual(
      rows.map((row) => row.received_at_ms),
      [WITHIN_RETENTION_MS - 1, WITHIN_RETENTION_MS, COMPACTION_NOW_MS],
      "only structurally valid rows survive compaction",
    );
  });
});

test("compaction enforces the byte cap newest-first even within retention", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
    };
    const firstMs = COMPACTION_NOW_MS - 1_100;
    const lines = Array.from(
      { length: 1_100 },
      (_, index) => paddedEventLine(firstMs + index),
    );
    await mkdir(join(paths.hook_events_path, ".."), { recursive: true });
    await writeFile(
      paths.hook_events_path,
      lines.map((line) => `${line}\n`).join(""),
      "utf8",
    );

    const result = await runHookEventCommand(
      { cwd: "/repo", stdinText: stopPayload(), nowMs: COMPACTION_NOW_MS },
      dependencies,
    );

    assert.deepEqual(result, { stdout: "", warnings: [] });
    const info = await stat(paths.hook_events_path);
    assert.ok(
      info.size <= MAX_HOOK_EVENTS_BYTES,
      `size ${info.size} must not exceed the 1 MiB cap`,
    );
    const rows = await readJsonlRows(paths.hook_events_path) as {
      received_at_ms: number;
    }[];
    assert.ok(rows.length > 0 && rows.length < 1_101);
    const timestamps = rows.map((row) => row.received_at_ms);
    assert.equal(
      timestamps.at(-1),
      COMPACTION_NOW_MS,
      "the newest row (the fresh append) is always retained",
    );
    assert.ok(
      timestamps[0] !== undefined && timestamps[0] > firstMs,
      "the oldest rows are the ones sacrificed to the cap",
    );
    for (let i = 1; i < timestamps.length; i += 1) {
      const previous = timestamps[i - 1];
      const current = timestamps[i];
      assert.ok(
        previous !== undefined && current !== undefined &&
          previous <= current,
        "relative order is preserved",
      );
    }
  });
});

test("a failing compaction is swallowed and leaves the log intact", async () => {
  await temporaryStore(async (paths) => {
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
    };
    const lines = Array.from(
      { length: 1_100 },
      () => paddedEventLine(BEYOND_RETENTION_MS),
    );
    const existing = lines.map((line) => `${line}\n`).join("");
    await mkdir(join(paths.hook_events_path, ".."), { recursive: true });
    await writeFile(paths.hook_events_path, existing, "utf8");
    // Write-only log: the append (O_WRONLY|O_APPEND) still succeeds, but
    // compaction's readFile fails with EACCES and must be swallowed.
    await chmod(paths.hook_events_path, 0o200);
    try {
      const result = await runHookEventCommand(
        { cwd: "/repo", stdinText: stopPayload(), nowMs: COMPACTION_NOW_MS },
        dependencies,
      );
      assert.deepEqual(result, { stdout: "", warnings: [] });
    } finally {
      await chmod(paths.hook_events_path, 0o600);
    }
    const text = await readFile(paths.hook_events_path, "utf8");
    assert.equal(
      text,
      `${existing}${eventLine(COMPACTION_NOW_MS, "Stop", "session-1")}\n`,
      "the append landed and the unreadable log was left as-is",
    );
  });
});

test("--notify throttling still works after compaction rewrites the log", async () => {
  await temporaryStore(async (paths) => {
    let analyzeCalls = 0;
    const dependencies: HookEventCommandDependencies = {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
      analyze: async () => {
        analyzeCalls += 1;
        return { report: { findings: [] } as never };
      },
    };
    const expired = Array.from(
      { length: 1_100 },
      () => paddedEventLine(BEYOND_RETENTION_MS),
    );
    const notified = eventLine(
      COMPACTION_NOW_MS - 60_000,
      "ccprof_notified",
    );
    await mkdir(join(paths.hook_events_path, ".."), { recursive: true });
    await writeFile(
      paths.hook_events_path,
      [...expired, notified].map((line) => `${line}\n`).join(""),
      "utf8",
    );

    const result = await runHookEventCommand(
      {
        cwd: "/repo",
        stdinText: stopPayload(),
        nowMs: COMPACTION_NOW_MS,
        notify: true,
      },
      dependencies,
    );

    assert.deepEqual(result, { stdout: "", warnings: [] });
    assert.equal(
      analyzeCalls,
      0,
      "the recent ccprof_notified row survives compaction and throttles",
    );
    const rows = await readJsonlRows(paths.hook_events_path) as {
      hook_event_name: string;
    }[];
    assert.deepEqual(
      rows.map((row) => row.hook_event_name),
      ["ccprof_notified", "Stop"],
      "compaction ran before the throttle check and kept only recent rows",
    );
  });
});

test("parseCliArgs recognizes hook-event and its --notify flag", () => {
  assert.deepEqual(parseCliArgs(["hook-event"]), {
    kind: "hook-event",
    notify: false,
  });
  assert.deepEqual(parseCliArgs(["hook-event", "--notify"]), {
    kind: "hook-event",
    notify: true,
  });
  assert.throws(() => parseCliArgs(["hook-event", "--bogus"]));
});

test("USAGE documents the hook-event subcommand", () => {
  assert.match(USAGE, /ccprof hook-event \[--notify\]/u);
});

function handlers(overrides: Partial<CliHandlers> = {}): CliHandlers {
  return {
    analyze: async () => ({ stdout: "{}\n", warnings: [] }),
    stats: async () => ({ stdout: "{}\n", warnings: [] }),
    dismiss: async () => ({ stdout: "dismissed\n", warnings: [] }),
    hookEvent: async () => ({ stdout: "", warnings: [] }),
    hooks: async () => ({ stdout: "", warnings: [] }),
    ...overrides,
  };
}

test("runCli passes injected stdinText to the hook-event handler and returns 0", async () => {
  let received: string | undefined;
  const code = await runCli(["hook-event", "--notify"], {
    cwd: "/repo",
    stdinText: "the-payload",
    handlers: handlers({
      hookEvent: async (options) => {
        received = options.stdinText;
        assert.equal(options.notify, true);
        assert.equal(options.cwd, "/repo");
        return { stdout: "1 finding\ntitle\n", warnings: ["a warning"] };
      },
    }),
    stdout: () => undefined,
    stderr: () => undefined,
  });
  assert.equal(code, 0);
  assert.equal(received, "the-payload");
});

test("runCli always returns 0 for hook-event, even when the handler throws", async () => {
  const code = await runCli(["hook-event"], {
    cwd: "/repo",
    stdinText: "{}",
    handlers: handlers({
      hookEvent: async () => {
        throw new Error("handler exploded");
      },
    }),
    stdout: () => undefined,
    stderr: () => undefined,
  });
  assert.equal(code, 0);
});

test("runCli returns 0 for hook-event even with an unknown flag", async () => {
  const code = await runCli(["hook-event", "--bogus"], {
    cwd: "/repo",
    stdinText: "{}",
    handlers: handlers({
      hookEvent: async () => {
        throw new Error("should not be called");
      },
    }),
    stdout: () => undefined,
    stderr: () => undefined,
  });
  assert.equal(code, 0);
});

