import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  runCommand,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "../src/git/client.js";
import {
  GH_PR_FIELDS,
  parseExplicitRange,
  parseGhMetadata,
  resolvePrContext,
} from "../src/git/pr-context.js";
import {
  collectDiffEvidence,
  parseCommitLog,
  parseNameStatus,
} from "../src/git/diff.js";

interface Call {
  command: string;
  args: string[];
  options: CommandOptions | undefined;
}

function fakeRunner(
  respond: (call: Call) => CommandResult,
): { calls: Call[]; runner: CommandRunner } {
  const calls: Call[] = [];
  return {
    calls,
    runner: async (command, args, options) => {
      const call = { command, args: [...args], options };
      calls.push(call);
      return respond(call);
    },
  };
}

function ok(stdout = "", extra: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout, stderr: "", ...extra };
}

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);

async function resolveReflogFixture(options: {
  oidLength?: 40 | 64;
  localHead?: string | null;
  reflog: CommandResult;
}) {
  const length = options.oidLength ?? 40;
  const base = "1".repeat(length);
  const head = "2".repeat(length);
  const mergeBase = "3".repeat(length);
  const localHead = options.localHead === undefined ? head : options.localHead;
  const fixture = fakeRunner(({ command, args }) => {
    if (command === "gh") {
      return ok(JSON.stringify({
        number: 7, url: "https://github.example/acme/widget/pull/7",
        baseRefName: "main", baseRefOid: base,
        headRefName: "topic", headRefOid: head, isCrossRepository: false,
        createdAt: "2026-07-01T00:00:00Z",
      }));
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
    if (args[0] === "rev-parse" && args.at(-1) === `${base}^{commit}`) return ok(`${base}\n`);
    if (args[0] === "rev-parse" && args.at(-1) === `${head}^{commit}`) return ok(`${head}\n`);
    if (args[0] === "rev-parse" && args.at(-1) === "refs/heads/topic^{commit}")
      return localHead === null ? { code: 1, stdout: "", stderr: "missing" } : ok(`${localHead}\n`);
    if (args[0] === "merge-base") return ok(`${mergeBase}\n`);
    if (args[0] === "reflog") return options.reflog;
    if (args[0] === "log") return ok("100\u0000100\n");
    return { code: 2, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  });
  const context = await resolvePrContext({ cwd: "/repo", input: "7",
    runner: fixture.runner, nowMs: 1_000_000 });
  return { context, calls: fixture.calls, head };
}

async function withFakeWindowsTaskkill(
  options: { delayMs: number; exitCode: number },
  run: () => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-taskkill-"));
  const taskkillPath = join(root, "taskkill");
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const previousPath = process.env.PATH;
  assert.ok(platformDescriptor?.configurable);
  await writeFile(
    taskkillPath,
    [
      "#!/usr/bin/env node",
      'const pidIndex = process.argv.indexOf("/PID");',
      "const pid = Number(process.argv[pidIndex + 1]);",
      `setTimeout(() => {`,
      `  if (${options.exitCode} === 0) {`,
      '    try { process.kill(pid, "SIGKILL"); } catch {}',
      "  }",
      `  process.exit(${options.exitCode});`,
      `}, ${options.delayMs});`,
    ].join("\n"),
    { mode: 0o755 },
  );
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
  process.env.PATH = `${root}:${previousPath ?? ""}`;
  try {
    await run();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
}

test("runCommand passes metacharacters literally, bounds output, and times out", async () => {
  const literal = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1])", "$(not-a-shell); *"],
    { maxOutputBytes: 100, timeoutMs: 1_000 },
  );
  assert.equal(literal.code, 0);
  assert.equal(literal.stdout, "$(not-a-shell); *");
  assert.equal(literal.stdoutTruncated, false);

  const bounded = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write('abcdefgh')"],
    { maxOutputBytes: 4, timeoutMs: 1_000 },
  );
  assert.equal(bounded.stdout, "abcd");
  assert.equal(bounded.stdoutTruncated, true);

  const timedOut = await runCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    { timeoutMs: 20 },
  );
  assert.equal(timedOut.code, 124);
  assert.equal(timedOut.timedOut, true);
});

test("runCommand roundtrips UTF-8 stdin and rejects an oversized payload before spawn", async () => {
  const roundtrip = await runCommand(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { stdin: "日本語", maxStdinBytes: 9 },
  );
  assert.equal(roundtrip.code, 0);
  assert.equal(roundtrip.stdout, "日本語");

  const root = await mkdtemp(join(tmpdir(), "ccprof-stdin-cap-"));
  const marker = join(root, "spawned");
  try {
    await assert.rejects(
      runCommand(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'spawned')",
          marker,
        ],
        { stdin: "日本語", maxStdinBytes: 8 },
      ),
      /stdin exceeds maxStdinBytes/u,
    );
    await assert.rejects(access(marker), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand replaces the environment only when explicitly requested", async () => {
  const key = "CCPROF_RUNNER_PARENT_CANARY";
  const previous = process.env[key];
  process.env[key] = "parent";
  const script = [
    `process.stdout.write(process.env.${key} ?? "missing")`,
    'process.stdout.write(":" + (process.env.CCPROF_RUNNER_EXPLICIT ?? "missing"))',
  ].join(";");
  try {
    const inherited = await runCommand(process.execPath, ["-e", script], {
      env: { CCPROF_RUNNER_EXPLICIT: "child" },
    });
    assert.equal(inherited.stdout, "parent:child");

    const replaced = await runCommand(process.execPath, ["-e", script], {
      env: { CCPROF_RUNNER_EXPLICIT: "child" },
      envMode: "replace",
    });
    assert.equal(replaced.stdout, "missing:child");
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("runCommand turns a rejected stdin write into a content-free failure", async () => {
  const canary = "CCPROF_STDIN_CANARY_MUST_NOT_LEAK";
  const input = `${canary}${"x".repeat(2 * 1024 * 1024)}`;
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(0), 25)"],
    { stdin: input, timeoutMs: 2_000 },
  );

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /stdin write failed/u);
  assert.doesNotMatch(result.stderr, new RegExp(canary, "u"));
});

test("runCommand caps stdout and stderr independently", async () => {
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write('abcdefgh'); process.stderr.write('ABCDEFGH')",
    ],
    { maxOutputBytes: 4 },
  );

  assert.equal(result.stdout, "abcd");
  assert.equal(result.stderr, "ABCD");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("runCommand kills timed-out descendants when process-group termination is requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-process-group-"));
  const marker = join(root, "descendant-survived");
  const descendantScript = [
    'const { writeFileSync } = require("node:fs");',
    'setTimeout(() => writeFileSync(process.argv[1], "alive"), 500);',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}, process.argv[1]], {`,
    '  stdio: ["ignore", "ignore", "ignore"],',
    "});",
    "setInterval(() => {}, 1_000);",
  ].join("\n");

  try {
    const result = await runCommand(
      process.execPath,
      ["-e", parentScript, marker],
      { timeoutMs: 100, killProcessGroup: true },
    );
    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
    await delay(700);
    await assert.rejects(access(marker), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand waits for delayed Windows taskkill completion", async () => {
  await withFakeWindowsTaskkill({ delayMs: 250, exitCode: 0 }, async () => {
    const startedAt = Date.now();
    const result = await runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { timeoutMs: 20, killProcessGroup: true },
    );

    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
    assert.ok(
      Date.now() - startedAt >= 225,
      "timeout result settled before taskkill completed",
    );
  });
});

test("runCommand reports a delayed Windows taskkill failure before settling", async () => {
  await withFakeWindowsTaskkill({ delayMs: 250, exitCode: 7 }, async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { timeoutMs: 20, killProcessGroup: true },
    );

    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
    assert.match(result.stderr, /process termination failed: TASKKILL_7/u);
  });
});

test("runCommand rejects a zero timeout instead of disabling its bound", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", ""], { timeoutMs: 0 }),
    /timeoutMs must be a positive safe integer/,
  );
});

test("runCommand hard-settles after timeout when a descendant keeps stdout open", async () => {
  const descendantScript = "setTimeout(() => process.stdout.write('late'), 3_000)";
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {`,
    '  stdio: ["ignore", "inherit", "inherit"],',
    "});",
    'process.stdout.write("spawned");',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const startedAt = Date.now();

  const result = await runCommand(process.execPath, ["-e", parentScript], {
    timeoutMs: 1_000,
  });

  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, "spawned");
  assert.ok(
    Date.now() - startedAt < 2_500,
    "timeout settlement waited for the descendant to release inherited stdio",
  );
});

test("parseExplicitRange accepts exactly two or three dots and canonicalizes labels", () => {
  assert.deepEqual(parseExplicitRange("refs/heads/main..refs/heads/feature"), {
    baseRef: "refs/heads/main",
    headRef: "refs/heads/feature",
    baseLabel: "main",
    headLabel: "feature",
    prRef: "main...feature",
  });
  assert.deepEqual(parseExplicitRange("origin/main...feature"), {
    baseRef: "origin/main",
    headRef: "feature",
    baseLabel: "origin/main",
    headLabel: "feature",
    prRef: "origin/main...feature",
  });
  assert.equal(parseExplicitRange("main....feature"), null);
  assert.equal(parseExplicitRange("main"), null);
});

test("explicit range freezes refs, computes merge-base, and keeps time facts", async () => {
  const fixture = fakeRunner(({ command, args }) => {
    assert.equal(command, "git");
    const key = args.join("\0");
    const outputs = new Map<string, string>([
      [["rev-parse", "--show-toplevel"].join("\0"), "/repo\n"],
      [
        [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          "main^{commit}",
        ].join("\0"),
        `${BASE}\n`,
      ],
      [
        [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          "feature^{commit}",
        ].join("\0"),
        `${HEAD}\n`,
      ],
      [["merge-base", BASE, HEAD].join("\0"), `${MERGE_BASE}\n`],
      [
        ["log", "--format=%at%x00%ct", `${BASE}..${HEAD}`].join("\0"),
        `200\u0000200\n100\u0000100\n`,
      ],
    ]);
    const output = outputs.get(key);
    return output === undefined
      ? { code: 2, stdout: "", stderr: `unexpected: ${args.join(" ")}` }
      : ok(output);
  });

  const context = await resolvePrContext({
    cwd: "/work",
    input: "main..feature",
    runner: fixture.runner,
    nowMs: 999_000,
    includeBranchReflog: false,
  });

  assert.deepEqual(context, {
    repoRoot: "/repo",
    base: { label: "main", oid: BASE },
    head: { label: "feature", oid: HEAD },
    mergeBaseOid: MERGE_BASE,
    prRef: "main...feature",
    headBranch: "feature",
    earliestUniqueCommitAtMs: 100_000,
    resolvedAtMs: 999_000,
    warnings: [],
  });
  assert.deepEqual(
    fixture.calls.map(({ command, args }) => [command, ...args]),
    [
      ["git", "rev-parse", "--show-toplevel"],
      [
        "git",
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "main^{commit}",
      ],
      [
        "git",
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "feature^{commit}",
      ],
      ["git", "merge-base", BASE, HEAD],
      ["git", "log", "--format=%at%x00%ct", `${BASE}..${HEAD}`],
    ],
  );
  assert.equal(fixture.calls.some(({ args }) => args.includes("fetch")), false);
});

test("PR URL uses exact gh metadata, disables prompts, and preserves creation", async () => {
  const url = "https://github.example/acme/widget/pull/17";
  const fixture = fakeRunner(({ command, args }) => {
    if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return ok("/repo\n");
    }
    if (command === "gh") {
      return ok(
        JSON.stringify({
          number: 17,
          url,
          baseRefName: "main",
          baseRefOid: BASE,
          headRefName: "topic",
          headRefOid: HEAD,
          isCrossRepository: false,
          createdAt: "2026-07-01T02:03:04.000Z",
        }),
      );
    }
    if (args[0] === "rev-parse") {
      return ok(`${args.at(-1)?.startsWith(BASE) ? BASE : HEAD}\n`);
    }
    if (args[0] === "merge-base") {
      return ok(`${MERGE_BASE}\n`);
    }
    if (args[0] === "log") {
      return ok(`1782860000\u00001782860000\n`);
    }
    return { code: 2, stdout: "", stderr: "unexpected" };
  });

  const context = await resolvePrContext({
    cwd: "/repo/subdir",
    input: url,
    runner: fixture.runner,
    nowMs: 1_800_000_000_000,
    includeBranchReflog: false,
  });

  assert.equal(context.number, 17);
  assert.equal(context.url, url);
  assert.equal(context.isCrossRepository, false);
  assert.equal(context.createdAtMs, Date.parse("2026-07-01T02:03:04.000Z"));
  assert.equal(context.earliestUniqueCommitAtMs, 1_782_860_000_000);
  assert.deepEqual(
    fixture.calls.find(({ command }) => command === "gh"),
    {
      command: "gh",
      args: [
        "pr",
        "view",
        url,
        "--json",
        "number,url,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository,createdAt",
      ],
      options: {
        cwd: "/repo",
        env: {
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
        },
      },
    },
  );
  const verified = fixture.calls
    .filter(({ args }) => args[0] === "rev-parse" && args[1] === "--verify")
    .map(({ args }) => args.at(-1));
  assert.deepEqual(verified, [`${BASE}^{commit}`, `${HEAD}^{commit}`]);
});

test("gh metadata requires the cross-repository boolean", () => {
  assert.throws(
    () =>
      parseGhMetadata(
        JSON.stringify({
          number: 17,
          url: "https://github.example/acme/widget/pull/17",
          baseRefName: "main",
          baseRefOid: BASE,
          headRefName: "topic",
          headRefOid: HEAD,
          createdAt: "2026-07-01T02:03:04.000Z",
        }),
      ),
    /incomplete metadata/,
  );
});

test("gh metadata accepts only full hexadecimal base and head OIDs", () => {
  const metadata = {
    number: 17,
    url: "https://github.example/acme/widget/pull/17",
    baseRefName: "main",
    baseRefOid: "A".repeat(64),
    headRefName: "topic",
    headRefOid: HEAD,
    isCrossRepository: false,
    createdAt: "2026-07-01T02:03:04.000Z",
  };
  assert.equal(parseGhMetadata(JSON.stringify(metadata)).baseRefOid, metadata.baseRefOid);

  for (const field of ["baseRefOid", "headRefOid"] as const) {
    for (const invalidOid of ["HEAD", "a".repeat(39), "g".repeat(40), `${BASE}^{commit}`]) {
      assert.throws(
        () => parseGhMetadata(JSON.stringify({ ...metadata, [field]: invalidOid })),
        /incomplete metadata/,
      );
    }
  }
});

test("trusted branch reflogs support SHA-1/SHA-256 and use the latest creation", async () => {
  for (const oidLength of [40, 64] as const) {
    const head = "2".repeat(oidLength);
    const older = "4".repeat(oidLength);
    const oldest = "5".repeat(oidLength);
    const reflog = [
      head, "refs/heads/topic@{300}", "commit: latest",
      older, "refs/heads/topic@{200}", "branch: Created from main",
      oldest, "refs/heads/topic@{100}", "branch: Created from stale-main",
      "",
    ].join("\0");
    const resolved = await resolveReflogFixture({ oidLength, reflog: ok(reflog) });

    assert.equal(resolved.context.branchReflogStartedAtMs, 200_000);
    assert.deepEqual(resolved.context.warnings, []);
    assert.equal(resolved.calls.some(({ args }) =>
      args.join("\0") === [
        "reflog", "show", "-z", "--date=unix",
        "--format=%H%x00%gD%x00%gs", "--end-of-options", "refs/heads/topic",
      ].join("\0")
    ), true);
  }
});

test("successful but untrusted branch reflog evidence warns once", async () => {
  const validHead = HEAD;
  const cases: readonly [string, CommandResult, RegExp][] = [
    ["truncated", ok("partial", { stdoutTruncated: true }), /truncated/i],
    ["incomplete triple", ok(`${validHead}\0refs/heads/topic@{300}\0`), /malformed/i],
    ["invalid OID", ok(`invalid\0refs/heads/topic@{300}\0commit: latest\0`), /malformed/i],
    ["invalid selector", ok(`${validHead}\0refs/heads/topic@{later}\0commit: latest\0`), /malformed/i],
    ["latest row race", ok(`${"6".repeat(40)}\0refs/heads/topic@{300}\0commit: latest\0`), /frozen PR head/i],
    ["no creation", ok(`${validHead}\0refs/heads/topic@{300}\0commit: latest\0`), /creation/i],
  ];

  for (const [label, reflog, warning] of cases) {
    const { context } = await resolveReflogFixture({ reflog });
    assert.equal(context.branchReflogStartedAtMs, undefined, label);
    assert.equal(context.warnings.length, 1, label);
    assert.match(context.warnings[0] ?? "", warning, label);
  }
});

test("local branch trust failures and ordinary reflog exits fall back safely", async () => {
  const valid = ok(`${HEAD}\0refs/heads/topic@{200}\0branch: Created from main\0`);
  const mismatch = await resolveReflogFixture({ localHead: "6".repeat(40), reflog: valid });
  assert.equal(mismatch.context.branchReflogStartedAtMs, undefined);
  assert.equal(mismatch.context.warnings.length, 1);
  assert.match(mismatch.context.warnings[0] ?? "", /frozen PR head/i);
  assert.equal(mismatch.calls.some(({ args }) => args[0] === "reflog"), false);

  const missing = await resolveReflogFixture({ localHead: null, reflog: valid });
  assert.equal(missing.context.branchReflogStartedAtMs, undefined);
  assert.deepEqual(missing.context.warnings, []);

  const failed = await resolveReflogFixture({
    reflog: { code: 1, stdout: "", stderr: "no reflog" },
  });
  assert.equal(failed.context.branchReflogStartedAtMs, undefined);
  assert.deepEqual(failed.context.warnings, []);
});

test("implicit resolution falls back from gh to the remote default without fetching", async () => {
  const fixture = fakeRunner(({ command, args }) => {
    const key = [command, ...args].join("\0");
    const outputs = new Map<string, CommandResult>([
      [["git", "rev-parse", "--show-toplevel"].join("\0"), ok("/repo\n")],
      [
        ["gh", "pr", "view", "--json", GH_PR_FIELDS].join("\0"),
        { code: 1, stdout: "", stderr: "no pull requests found" },
      ],
      [
        [
          "git",
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ].join("\0"),
        ok("origin/trunk\n"),
      ],
      [
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"].join("\0"),
        ok("topic\n"),
      ],
      [
        [
          "git",
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          "origin/trunk^{commit}",
        ].join("\0"),
        ok(`${BASE}\n`),
      ],
      [
        [
          "git",
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          "HEAD^{commit}",
        ].join("\0"),
        ok(`${HEAD}\n`),
      ],
      [["git", "merge-base", BASE, HEAD].join("\0"), ok(`${MERGE_BASE}\n`)],
      [
        ["git", "log", "--format=%at%x00%ct", `${BASE}..${HEAD}`].join("\0"),
        ok(""),
      ],
    ]);
    return outputs.get(key) ?? {
      code: 2,
      stdout: "",
      stderr: `unexpected ${key}`,
    };
  });

  const context = await resolvePrContext({
    cwd: "/repo",
    runner: fixture.runner,
    nowMs: 123,
  });

  assert.equal(context.prRef, "origin/trunk...topic");
  assert.equal(context.headBranch, "topic");
  assert.equal(context.earliestUniqueCommitAtMs, undefined);
  assert.match(context.warnings[0] ?? "", /gh pr view/);
  assert.equal(
    fixture.calls.some(({ command, args }) =>
      [command, ...args].includes("fetch"),
    ),
    false,
  );
});

test("name-status parser preserves arbitrary names and R/C path pairs", () => {
  const records = parseNameStatus(
    [
      "M",
      "line\nbreak.ts",
      "R087",
      "old\tname.ts",
      "new\nname.ts",
      "C100",
      "source.ts",
      "copy.ts",
      "D",
      "--dangerous",
      "",
    ].join("\0"),
  );

  assert.deepEqual(records, [
    { status: "M", path: "line\nbreak.ts" },
    { status: "R087", oldPath: "old\tname.ts", path: "new\nname.ts" },
    { status: "C100", oldPath: "source.ts", path: "copy.ts" },
    { status: "D", path: "--dangerous" },
  ]);
});

test("truncated git log output cannot establish an earliest timestamp", async () => {
  const fixture = fakeRunner(({ args }) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return ok("/repo\n");
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return ok(`${args.at(-1)?.startsWith("main") ? BASE : HEAD}\n`);
    }
    if (args[0] === "merge-base") return ok(`${MERGE_BASE}\n`);
    if (args[0] === "log") {
      return ok(`100\u0000100\n`, { stdoutTruncated: true });
    }
    return { code: 2, stdout: "", stderr: "unexpected" };
  });

  const context = await resolvePrContext({
    cwd: "/repo",
    input: "main...topic",
    runner: fixture.runner,
    nowMs: 999_000,
  });

  assert.equal(context.earliestUniqueCommitAtMs, undefined);
  assert.match(context.warnings[0] ?? "", /git log.*truncated/i);
});

test("earliestUniqueCommit conservatively uses the earliest author or committer timestamp", async () => {
  const fixture = fakeRunner(({ args }) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return ok("/repo\n");
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return ok(`${args.at(-1)?.startsWith("main") ? BASE : HEAD}\n`);
    }
    if (args[0] === "merge-base") return ok(`${MERGE_BASE}\n`);
    if (args[0] === "log") {
      assert.deepEqual(args, ["log", "--format=%at%x00%ct", `${BASE}..${HEAD}`]);
      return ok(`300\u0000400\n50\u0000500\n200\u0000200\n`);
    }
    return { code: 2, stdout: "", stderr: "unexpected" };
  });

  const context = await resolvePrContext({
    cwd: "/repo",
    input: "main...topic",
    runner: fixture.runner,
    nowMs: 999_000,
  });

  assert.equal(context.earliestUniqueCommitAtMs, 50_000);
  assert.deepEqual(context.warnings, []);
});

test("malformed git log rows are ignored and reported as warnings", async () => {
  const fixture = fakeRunner(({ args }) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return ok("/repo\n");
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return ok(`${args.at(-1)?.startsWith("main") ? BASE : HEAD}\n`);
    }
    if (args[0] === "merge-base") return ok(`${MERGE_BASE}\n`);
    if (args[0] === "log") {
      return ok(`200\u0000200\nnot-a-timestamp\u0000300\n100\u0000100\n\n`);
    }
    return { code: 2, stdout: "", stderr: "unexpected" };
  });

  const context = await resolvePrContext({
    cwd: "/repo",
    input: "main...topic",
    runner: fixture.runner,
    nowMs: 999_000,
  });

  assert.equal(context.earliestUniqueCommitAtMs, 100_000);
  assert.equal(context.warnings.length, 1);
  assert.match(context.warnings[0] ?? "", /ignored malformed git log row/);
  assert.match(context.warnings[0] ?? "", /not-a-timestamp/);
});

test("collectDiffEvidence pairs status with patch order and parses only hunk additions", async () => {
  const binaryPath = "assets/a\nb.bin";
  const status = [
    "M",
    "src/a.ts",
    "R090",
    "src/old.ts",
    "src/new.ts",
    "A",
    binaryPath,
    "D",
    "src/gone.ts",
    "",
  ].join("\0");
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1,2 @@",
    "-old",
    "+new",
    " context",
    "+diff --git is content",
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 90%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "diff --git \"a/assets/a\\nb.bin\" \"b/assets/a\\nb.bin\"",
    "new file mode 100644",
    "GIT binary patch",
    "literal 1",
    "A",
    "diff --git a/src/gone.ts b/src/gone.ts",
    "deleted file mode 100644",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "",
  ].join("\n");
  const revertOid = "a".repeat(40);
  const revertedOid = "b".repeat(40);
  const ordinaryOid = "c".repeat(40);
  const log = [
    revertOid,
    "200",
    'Revert "bad change"',
    `Revert "bad change"\n\nThis reverts commit ${revertedOid}.\n`,
    "",
    "\nM",
    "src/a.ts",
    ordinaryOid,
    "100",
    'Revert "not generated"',
    'Revert "not generated"\n\nNo standard trailer.\n',
    "",
    "\nR100",
    "old\tpath",
    "new\npath",
    "",
  ].join("\0");
  const fixture = fakeRunner(({ args }) => {
    if (args[1] === "diff" && args.includes("--name-status")) {
      return ok(status);
    }
    if (args[1] === "diff") {
      return ok(patch);
    }
    if (args[1] === "log") {
      return ok(log);
    }
    return { code: 2, stdout: "", stderr: "unexpected" };
  });

  const evidence = await collectDiffEvidence({
    cwd: "/repo",
    baseOid: BASE,
    headOid: HEAD,
    runner: fixture.runner,
  });

  assert.deepEqual(
    fixture.calls.map(({ command, args }) => [command, ...args]),
    [
      [
        "git",
        "--no-pager",
        "diff",
        "--find-renames",
        "--binary",
        "--patch",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--end-of-options",
        `${BASE}...${HEAD}`,
        "--",
      ],
      [
        "git",
        "--no-pager",
        "diff",
        "--find-renames",
        "--name-status",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--end-of-options",
        `${BASE}...${HEAD}`,
        "--",
      ],
      [
        "git",
        "--no-pager",
        "log",
        "--no-show-signature",
        "--format=%H%x00%ct%x00%s%x00%B%x00",
        "--name-status",
        "--find-renames",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--end-of-options",
        `${BASE}..${HEAD}`,
        "--",
      ],
    ],
  );
  assert.deepEqual(evidence.changedPaths, [
    "src/a.ts",
    "src/old.ts",
    "src/new.ts",
    binaryPath,
    "src/gone.ts",
  ]);
  assert.deepEqual(evidence.survivingPaths, [
    "src/a.ts",
    "src/new.ts",
    binaryPath,
  ]);
  assert.deepEqual(evidence.renames, [
    {
      kind: "rename",
      from: "src/old.ts",
      to: "src/new.ts",
      similarity: 90,
    },
  ]);
  assert.deepEqual(evidence.files[0]?.addedLines, [
    "new",
    "diff --git is content",
  ]);
  assert.equal(evidence.files[0]?.contentComplete, true);
  assert.equal(evidence.files[2]?.binary, true);
  assert.equal(evidence.files[2]?.contentComplete, false);
  assert.deepEqual(evidence.reverts, [
    {
      commitOid: revertOid,
      revertedCommitOid: revertedOid,
      subject: 'Revert "bad change"',
      paths: ["src/a.ts"],
    },
  ]);
  assert.equal(evidence.commits[1]?.changes[0]?.oldPath, "old\tpath");
  assert.equal(evidence.commits[1]?.changes[0]?.path, "new\npath");
});

test("patch/status mismatch does not attribute patch content by shifted index", async () => {
  const fixture = fakeRunner(({ args }) => {
    if (args[1] === "diff" && args.includes("--name-status")) {
      return ok("M\0src/first.ts\0M\0src/second.ts\0");
    }
    if (args[1] === "diff") {
      return ok(
        [
          "diff --git a/src/second.ts b/src/second.ts",
          "--- a/src/second.ts",
          "+++ b/src/second.ts",
          "@@ -0,0 +1 @@",
          "+belongs to second",
          "",
        ].join("\n"),
      );
    }
    return ok("");
  });

  const evidence = await collectDiffEvidence({
    cwd: "/repo",
    baseOid: BASE,
    headOid: HEAD,
    runner: fixture.runner,
  });

  assert.deepEqual(
    evidence.files.map(({ path, addedLines, contentComplete }) => ({
      path,
      addedLines,
      contentComplete,
    })),
    [
      { path: "src/first.ts", addedLines: [], contentComplete: false },
      { path: "src/second.ts", addedLines: [], contentComplete: false },
    ],
  );
  assert.match(evidence.caveats[0] ?? "", /paired completely/i);
});

test("truncated patch marks textual content incomplete without losing status evidence", async () => {
  const fixture = fakeRunner(({ args }) => {
    if (args[1] === "diff" && args.includes("--name-status")) {
      return ok("M\0src/a.ts\0");
    }
    if (args[1] === "diff") {
      return ok(
        "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n+x",
        { stdoutTruncated: true },
      );
    }
    return ok("");
  });

  const evidence = await collectDiffEvidence({
    cwd: "/repo",
    baseOid: BASE,
    headOid: HEAD,
    runner: fixture.runner,
  });

  assert.equal(evidence.truncated, true);
  assert.equal(evidence.files[0]?.contentComplete, false);
  assert.match(evidence.caveats[0] ?? "", /truncated/i);
});

test("mid-record commit-log truncation returns incomplete evidence instead of throwing", async () => {
  const partialLog = ["a".repeat(40), "100", "subject without body"].join("\0");
  const fixture = fakeRunner(({ args }) => {
    if (args[1] === "log") {
      return ok(partialLog, { stdoutTruncated: true });
    }
    return ok("");
  });

  const evidence = await collectDiffEvidence({
    cwd: "/repo",
    baseOid: BASE,
    headOid: HEAD,
    runner: fixture.runner,
  });

  assert.equal(evidence.truncated, true);
  assert.deepEqual(evidence.commits, []);
  assert.deepEqual(evidence.reverts, []);
  assert.match(
    evidence.caveats.find((caveat) => /commit-log/i.test(caveat)) ?? "",
    /truncated/i,
  );
});

test("commit log requires the standard git-revert trailer as evidence", () => {
  const commit = "d".repeat(40);
  const target = "e".repeat(40);
  const parsed = parseCommitLog(
    [
      commit,
      "10",
      'Revert "looks like one"',
      `Revert "looks like one"\n\nMentions ${target}, but lacks the trailer.\n`,
      "",
      "\nM",
      "file.ts",
      "",
    ].join("\0"),
  );

  assert.equal(parsed.commits.length, 1);
  assert.deepEqual(parsed.reverts, []);
});
