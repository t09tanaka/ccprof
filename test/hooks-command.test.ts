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

import { parseCliArgs, runCli, USAGE, type CliHandlers } from "../src/cli.js";
import {
  CCPROF_HOOK_MARKER,
  runHooksCommand,
  type HooksCommandDependencies,
  type HooksCommandOptions,
} from "../src/commands/hooks.js";

async function withTempRepo(
  callback: (repoRoot: string, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hooks-"));
  try {
    const repoRoot = join(root, "repo");
    await mkdir(repoRoot, { recursive: true });
    await callback(repoRoot, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function settingsPathFor(repoRoot: string): string {
  return join(repoRoot, ".claude", "settings.json");
}

async function writeSettings(
  repoRoot: string,
  content: unknown,
): Promise<void> {
  await mkdir(join(repoRoot, ".claude"), { recursive: true });
  await writeFile(
    settingsPathFor(repoRoot),
    JSON.stringify(content, null, 2),
    "utf8",
  );
}

function hooksHandlers(dependencies: HooksCommandDependencies): CliHandlers {
  return {
    analyze: async () => ({ stdout: "{}\n", warnings: [] }),
    stats: async () => ({ stdout: "{}\n", warnings: [] }),
    dismiss: async () => ({ stdout: "dismissed\n", warnings: [] }),
    hookEvent: async () => ({ stdout: "", warnings: [] }),
    hooks: (options) => runHooksCommand(options, dependencies),
  };
}

test("CCPROF_HOOK_MARKER matches the installed command", () => {
  assert.equal(CCPROF_HOOK_MARKER, "ccprof hook-event");
  assert.ok("ccprof hook-event --notify".includes(CCPROF_HOOK_MARKER));
});

test("install creates .claude/settings.json when absent", async () => {
  await withTempRepo(async (repoRoot) => {
    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    const result = await runHooksCommand(
      { cwd: repoRoot, action: "install", global: false, yes: true },
      dependencies,
    );
    assert.match(result.stdout, /Installed ccprof Stop hook into/u);
    const parsed = JSON.parse(
      await readFile(settingsPathFor(repoRoot), "utf8"),
    ) as unknown;
    assert.deepEqual(parsed, {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "ccprof hook-event --notify" },
            ],
          },
        ],
      },
    });
  });
});

test("install preserves unrelated settings content", async () => {
  await withTempRepo(async (repoRoot) => {
    const existing = {
      env: { FOO: "bar" },
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }],
      },
    };
    await writeSettings(repoRoot, existing);

    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    await runHooksCommand(
      { cwd: repoRoot, action: "install", global: false, yes: true },
      dependencies,
    );

    const parsed = JSON.parse(
      await readFile(settingsPathFor(repoRoot), "utf8"),
    ) as {
      env: unknown;
      hooks: {
        PreToolUse: unknown;
        Stop: { hooks: { type: string; command: string }[] }[];
      };
    };
    assert.deepEqual(parsed.env, existing.env);
    assert.deepEqual(parsed.hooks.PreToolUse, existing.hooks.PreToolUse);
    assert.equal(parsed.hooks.Stop.length, 2);
    assert.deepEqual(parsed.hooks.Stop[0], existing.hooks.Stop[0]);
    assert.deepEqual(parsed.hooks.Stop[1], {
      hooks: [{ type: "command", command: "ccprof hook-event --notify" }],
    });
  });
});

test("install is idempotent when the marker is already present", async () => {
  await withTempRepo(async (repoRoot) => {
    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    const options: HooksCommandOptions = {
      cwd: repoRoot,
      action: "install",
      global: false,
      yes: true,
    };
    await runHooksCommand(options, dependencies);
    const firstWrite = await readFile(settingsPathFor(repoRoot), "utf8");

    const second = await runHooksCommand(options, dependencies);
    assert.equal(second.stdout, "ccprof hook entries already installed\n");
    const secondWrite = await readFile(settingsPathFor(repoRoot), "utf8");
    assert.equal(secondWrite, firstWrite);
  });
});

test("uninstall removes only ccprof Stop entries and preserves the rest", async () => {
  await withTempRepo(async (repoRoot) => {
    const existing = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        Stop: [
          { hooks: [{ type: "command", command: "other-tool" }] },
          {
            hooks: [
              { type: "command", command: "ccprof hook-event --notify" },
            ],
          },
        ],
      },
    };
    await writeSettings(repoRoot, existing);

    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    const result = await runHooksCommand(
      { cwd: repoRoot, action: "uninstall", global: false, yes: true },
      dependencies,
    );
    assert.match(result.stdout, /Removed ccprof hook entries from/u);

    const parsed = JSON.parse(
      await readFile(settingsPathFor(repoRoot), "utf8"),
    ) as {
      hooks: {
        PreToolUse: unknown;
        Stop: unknown[];
      };
    };
    assert.deepEqual(parsed.hooks.PreToolUse, existing.hooks.PreToolUse);
    assert.deepEqual(parsed.hooks.Stop, [
      { hooks: [{ type: "command", command: "other-tool" }] },
    ]);
  });
});

test("uninstall drops the emptied Stop array and hooks object", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeSettings(repoRoot, {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "ccprof hook-event --notify" },
            ],
          },
        ],
      },
    });
    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    await runHooksCommand(
      { cwd: repoRoot, action: "uninstall", global: false, yes: true },
      dependencies,
    );
    const parsed = JSON.parse(
      await readFile(settingsPathFor(repoRoot), "utf8"),
    ) as unknown;
    assert.deepEqual(parsed, {});
  });
});

test("uninstall no-ops when settings file is absent", async () => {
  await withTempRepo(async (repoRoot) => {
    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    const result = await runHooksCommand(
      { cwd: repoRoot, action: "uninstall", global: false, yes: true },
      dependencies,
    );
    assert.equal(result.stdout, "No ccprof hook entries found\n");
    await assert.rejects(readFile(settingsPathFor(repoRoot), "utf8"));
  });
});

test("uninstall no-ops when no ccprof entries exist and leaves the file untouched", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeSettings(repoRoot, { foo: "bar" });
    const before = await readFile(settingsPathFor(repoRoot), "utf8");
    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    const result = await runHooksCommand(
      { cwd: repoRoot, action: "uninstall", global: false, yes: true },
      dependencies,
    );
    assert.equal(result.stdout, "No ccprof hook entries found\n");
    const after = await readFile(settingsPathFor(repoRoot), "utf8");
    assert.equal(after, before);
  });
});

test("corrupt settings JSON rejects without overwriting the file", async () => {
  await withTempRepo(async (repoRoot) => {
    await mkdir(join(repoRoot, ".claude"), { recursive: true });
    await writeFile(settingsPathFor(repoRoot), "{not valid json", "utf8");
    const before = await readFile(settingsPathFor(repoRoot), "utf8");

    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    await assert.rejects(
      runHooksCommand(
        { cwd: repoRoot, action: "install", global: false, yes: true },
        dependencies,
      ),
    );
    const after = await readFile(settingsPathFor(repoRoot), "utf8");
    assert.equal(after, before);
  });
});

test("runCli exits 5 for corrupt settings JSON", async () => {
  await withTempRepo(async (repoRoot) => {
    await mkdir(join(repoRoot, ".claude"), { recursive: true });
    await writeFile(settingsPathFor(repoRoot), "{not valid json", "utf8");

    const code = await runCli(["hooks", "install", "--yes"], {
      cwd: repoRoot,
      handlers: hooksHandlers({ resolveRepoRoot: async () => repoRoot }),
      stdout: () => undefined,
      stderr: () => undefined,
    });
    assert.equal(code, 5);
  });
});

test("hooks install without --yes in a non-interactive context exits 2", async () => {
  await withTempRepo(async (repoRoot) => {
    const code = await runCli(["hooks", "install"], {
      cwd: repoRoot,
      handlers: hooksHandlers({ resolveRepoRoot: async () => repoRoot }),
      stdout: () => undefined,
      stderr: () => undefined,
    });
    assert.equal(code, 2);
    await assert.rejects(readFile(settingsPathFor(repoRoot), "utf8"));
  });
});

test("hooks with a missing action is a usage error", () => {
  assert.throws(() => parseCliArgs(["hooks"]));
  assert.throws(() => parseCliArgs(["hooks", "--yes"]));
  assert.throws(() => parseCliArgs(["hooks", "bogus"]));
});

test("declining the confirmation prompt makes no changes and reports aborted", async () => {
  await withTempRepo(async (repoRoot) => {
    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    const result = await runHooksCommand(
      {
        cwd: repoRoot,
        action: "install",
        global: false,
        yes: false,
        confirm: async () => false,
      },
      dependencies,
    );
    assert.equal(result.stdout, "aborted\n");
    await assert.rejects(readFile(settingsPathFor(repoRoot), "utf8"));
  });
});

test("accepting the confirmation prompt installs the hook", async () => {
  await withTempRepo(async (repoRoot) => {
    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
    };
    let promptedMessage: string | undefined;
    const result = await runHooksCommand(
      {
        cwd: repoRoot,
        action: "install",
        global: false,
        yes: false,
        confirm: async (message) => {
          promptedMessage = message;
          return true;
        },
      },
      dependencies,
    );
    assert.match(result.stdout, /Installed ccprof Stop hook into/u);
    assert.ok(promptedMessage !== undefined && promptedMessage.length > 0);
    await readFile(settingsPathFor(repoRoot), "utf8");
  });
});

test("--global installs into the home directory settings file", async () => {
  await withTempRepo(async (repoRoot, root) => {
    const homeDir = join(root, "home");
    await mkdir(homeDir, { recursive: true });
    const dependencies: HooksCommandDependencies = {
      resolveRepoRoot: async () => repoRoot,
      homeDir: () => homeDir,
    };
    const result = await runHooksCommand(
      { cwd: repoRoot, action: "install", global: true, yes: true },
      dependencies,
    );
    const globalSettingsPath = join(homeDir, ".claude", "settings.json");
    assert.ok(result.stdout.includes(globalSettingsPath));
    await readFile(globalSettingsPath, "utf8");
    await assert.rejects(readFile(settingsPathFor(repoRoot), "utf8"));
  });
});

test("parseCliArgs recognizes hooks install/uninstall with --global and --yes", () => {
  assert.deepEqual(parseCliArgs(["hooks", "install"]), {
    kind: "hooks",
    action: "install",
    global: false,
    yes: false,
  });
  assert.deepEqual(
    parseCliArgs(["hooks", "uninstall", "--global", "--yes"]),
    { kind: "hooks", action: "uninstall", global: true, yes: true },
  );
  assert.throws(() => parseCliArgs(["hooks", "install", "--bogus"]));
});

test("USAGE documents the hooks subcommand", () => {
  assert.match(USAGE, /ccprof hooks install\|uninstall \[--global\] \[--yes\]/u);
});

test("runCli wires the hooks handler through with cwd/action/global/yes", async () => {
  let received: unknown;
  const code = await runCli(["hooks", "uninstall", "--global", "--yes"], {
    cwd: "/repo",
    handlers: {
      analyze: async () => ({ stdout: "{}\n", warnings: [] }),
      stats: async () => ({ stdout: "{}\n", warnings: [] }),
      dismiss: async () => ({ stdout: "dismissed\n", warnings: [] }),
      hookEvent: async () => ({ stdout: "", warnings: [] }),
      hooks: async (options) => {
        received = options;
        return { stdout: "ok\n", warnings: [] };
      },
    },
    stdout: () => undefined,
    stderr: () => undefined,
  });
  assert.equal(code, 0);
  assert.deepEqual(received, {
    cwd: "/repo",
    action: "uninstall",
    global: true,
    yes: true,
  });
});
