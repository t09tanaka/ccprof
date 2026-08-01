import assert from "node:assert/strict";
import test from "node:test";

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
        ["log", "--format=%at", `${BASE}..${HEAD}`].join("\0"),
        `200\n100\n`,
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
      ["git", "log", "--format=%at", `${BASE}..${HEAD}`],
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
      return ok(`1782860000\n`);
    }
    return { code: 2, stdout: "", stderr: "unexpected" };
  });

  const context = await resolvePrContext({
    cwd: "/repo/subdir",
    input: url,
    runner: fixture.runner,
    nowMs: 1_800_000_000_000,
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
        ["git", "log", "--format=%at", `${BASE}..${HEAD}`].join("\0"),
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
      return ok(`100\n`, { stdoutTruncated: true });
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

test("earliestUniqueCommit uses git log author timestamps and picks the minimum", async () => {
  const fixture = fakeRunner(({ args }) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return ok("/repo\n");
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      return ok(`${args.at(-1)?.startsWith("main") ? BASE : HEAD}\n`);
    }
    if (args[0] === "merge-base") return ok(`${MERGE_BASE}\n`);
    if (args[0] === "log") {
      assert.deepEqual(args, ["log", "--format=%at", `${BASE}..${HEAD}`]);
      return ok(`300\n100\n200\n`);
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
      return ok(`200\nnot-a-timestamp\n100\n\n`);
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
