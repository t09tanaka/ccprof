import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
          allFindings: [finding("Rework loop"), finding("Serial slack")],
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
      analyze: async () => ({ allFindings: [] }),
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
        return { allFindings: [] };
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
        return { allFindings: [] };
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

