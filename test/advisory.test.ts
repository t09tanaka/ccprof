import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVISORY_ENV_KEYS,
  ADVISORY_MAX_OUTPUT_BYTES,
  ADVISORY_MAX_STDIN_BYTES,
  ADVISORY_MAX_TEXT_CHARS,
  ADVISORY_TIMEOUT_MS,
  buildAdvisoryEnvironment,
  buildAdvisoryPrompt,
  requestAdvisory,
} from "../src/advisory/advisory.js";
import {
  CliUsageError,
  parseCliArgs,
  runCli,
  USAGE,
  type CliHandlers,
} from "../src/cli.js";
import {
  runAnalyzeCommand,
  type AnalyzeCommandDependencies,
  type AnalyzeOutputFormat,
} from "../src/commands/analyze.js";
import type {
  AnalysisSummary,
  ReportV2,
} from "../src/core/model.js";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "../src/git/client.js";
import { renderJsonReport } from "../src/reporters/json.js";

const EXPECTED_ADVISORY_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "ComSpec",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
] as const;

const summary: AnalysisSummary = {
  measured_min: 42,
  idle_excluded_min: 8,
  estimated_floor_min: 34,
  recoverable_min: 8,
  human_wait_min: 2,
  unexplained_min: 3,
  baseline: null,
};

function report(): ReportV2 {
  return {
    version: 2,
    unit: {
      repo: "/repo",
      pr_ref: "main...feature",
      sessions: ["s1"],
    },
    summary,
    findings: [],
    caveats: ["Timestamp precision is limited."],
  };
}

interface RunnerCall {
  command: string;
  args: readonly string[];
  options?: CommandOptions;
}

function fakeRunner(
  result: Partial<CommandResult>,
  calls: RunnerCall[] = [],
): CommandRunner {
  return async (command, args, options) => {
    calls.push({
      command,
      args,
      ...(options === undefined ? {} : { options }),
    });
    return { code: 0, stdout: "", stderr: "", ...result };
  };
}

function dependencies(
  runCommand: CommandRunner,
): AnalyzeCommandDependencies {
  return {
    analyze: async () => ({ report: report(), warnings: [] }),
    runCommand,
  };
}

async function renderWith(
  format: AnalyzeOutputFormat,
  runCommand: CommandRunner,
  advisory = true,
): Promise<{ stdout: string; warnings: string[] }> {
  return await runAnalyzeCommand(
    {
      cwd: "/repo",
      format,
      color: false,
      privacy: "raw",
      ...(advisory ? { advisory: true } : {}),
    },
    dependencies(runCommand),
  );
}

test("CLI parser accepts --advisory once and rejects duplicates", () => {
  assert.equal(
    (parseCliArgs(["--advisory"]) as { advisory: boolean }).advisory,
    true,
  );
  assert.equal(
    (parseCliArgs(["--pr", "123", "--json"]) as { advisory: boolean })
      .advisory,
    false,
  );
  assert.throws(
    () => parseCliArgs(["--advisory", "--advisory"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.message === "--advisory was specified twice",
  );
  assert.match(USAGE, /\[--advisory\]/u);
});

test("markdown neutralizes leading structural markers in advisory lines", async () => {
  const llmOutput = [
    "### Injected heading",
    "> injected quote",
    "1. injected item",
  ].join("\n");
  const markdown = await renderWith("markdown", fakeRunner({ stdout: llmOutput }));

  assert.match(markdown.stdout, /^\\### Injected heading$/mu);
  assert.match(markdown.stdout, /^\\> injected quote$/mu);
  assert.match(markdown.stdout, /^1\\\. injected item$/mu);
  assert.doesNotMatch(markdown.stdout, /^### Injected heading$/mu);
});

test("advisory sends the complete display prompt only through bounded stdin", async () => {
  const calls: RunnerCall[] = [];
  await renderWith("json", fakeRunner({ stdout: "- fine" }, calls));

  assert.equal(calls.length, 1);
  const call = calls[0] as RunnerCall;
  assert.equal(call.command, "claude");
  assert.deepEqual(call.args, ["-p"]);
  assert.equal(
    call.options?.stdin,
    buildAdvisoryPrompt(renderJsonReport(report())),
  );
  assert.equal(
    call.options?.maxStdinBytes,
    ADVISORY_MAX_STDIN_BYTES,
  );
  assert.equal(
    call.options?.maxOutputBytes,
    ADVISORY_MAX_OUTPUT_BYTES,
  );
  assert.equal(call.options?.envMode, "replace");
  assert.equal(call.options?.killProcessGroup, true);
  assert.equal(call.options?.timeoutMs, ADVISORY_TIMEOUT_MS);
  assert.equal(ADVISORY_TIMEOUT_MS, 60_000);
});

test("advisory environment is an exact minimal allowlist", () => {
  assert.deepEqual(ADVISORY_ENV_KEYS, EXPECTED_ADVISORY_ENV_KEYS);
  assert.equal(ADVISORY_MAX_STDIN_BYTES, 1024 * 1024);
  assert.equal(ADVISORY_MAX_OUTPUT_BYTES, 64 * 1024);

  const forbidden = [
    "NODE_OPTIONS",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "npm_config_registry",
    "HTTPS_PROXY",
  ] as const;
  const source: NodeJS.ProcessEnv = Object.fromEntries([
    ...EXPECTED_ADVISORY_ENV_KEYS.map((key) => [key, `kept:${key}`]),
    ...forbidden.map((key) => [key, `excluded:${key}`]),
  ]);
  const projected = buildAdvisoryEnvironment(source);

  assert.deepEqual(Object.keys(projected), [...EXPECTED_ADVISORY_ENV_KEYS]);
  for (const key of EXPECTED_ADVISORY_ENV_KEYS) {
    assert.equal(projected[key], `kept:${key}`);
  }
  for (const key of forbidden) assert.equal(projected[key], undefined);
});

test("advisory report canary never enters argv, environment, or failure text", async () => {
  const canary = "CCPROF_ADVISORY_REPORT_CANARY";
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({
      command,
      args,
      ...(options === undefined ? {} : { options }),
    });
    throw new Error(`lower layer echoed ${String(options?.stdin)}`);
  };
  const canaryReport = { ...report(), caveats: [canary] };
  const result = await runAnalyzeCommand(
    {
      cwd: "/repo",
      format: "json",
      color: false,
      privacy: "raw",
      advisory: true,
    },
    {
      analyze: async () => ({ report: canaryReport, warnings: [] }),
      runCommand: runner,
    },
  );

  assert.equal(calls.length, 1);
  const call = calls[0] as RunnerCall;
  assert.match(String(call.options?.stdin), new RegExp(canary, "u"));
  assert.doesNotMatch(call.args.join("\u0000"), new RegExp(canary, "u"));
  assert.doesNotMatch(
    Object.values(call.options?.env ?? {}).join("\u0000"),
    new RegExp(canary, "u"),
  );
  assert.equal(result.warnings.length, 1);
  assert.doesNotMatch(result.warnings[0] ?? "", new RegExp(canary, "u"));
});

test("advisory rejects a prompt one UTF-8 byte over the cap without calling the runner", async () => {
  const prefixBytes = Buffer.byteLength(buildAdvisoryPrompt(""), "utf8");
  const remaining = ADVISORY_MAX_STDIN_BYTES - prefixBytes;
  const reportJson = `${"界".repeat(Math.floor(remaining / 3))}${"x".repeat((remaining % 3) + 1)}`;
  assert.equal(
    Buffer.byteLength(buildAdvisoryPrompt(reportJson), "utf8"),
    ADVISORY_MAX_STDIN_BYTES + 1,
  );
  const calls: RunnerCall[] = [];

  const outcome = await requestAdvisory(
    reportJson,
    fakeRunner({ stdout: "must not run" }, calls),
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(outcome, {
    kind: "unavailable",
    reason: "advisory input exceeds 1048576-byte limit",
  });
});

test("advisory success renders a separated, sanitized section in every format", async () => {
  const llmOutput = [
    "- First\u001b[31m painted\u001b[0m suggestion",
    "\u001b]0;EVIL_OSC\u0007- Second | suggestion\u0007",
    "- Third suggestion",
  ].join("\n");
  const runner = fakeRunner({ stdout: llmOutput });

  const tty = await renderWith("tty", runner);
  assert.match(tty.stdout, /Advisory \(LLM, opt-in — non-deterministic\):/u);
  assert.match(tty.stdout, /First painted suggestion/u);
  assert.match(tty.stdout, /Third suggestion/u);
  assert.doesNotMatch(tty.stdout, /[\u001b\u0007]/u);
  assert.doesNotMatch(tty.stdout, /EVIL_OSC/u);
  assert.ok(
    tty.stdout.indexOf("Caveats:") <
      tty.stdout.indexOf("Advisory (LLM"),
    "advisory renders after the deterministic report body",
  );

  const markdown = await renderWith("markdown", runner);
  assert.match(markdown.stdout, /## Advisory \(LLM\)/u);
  assert.match(
    markdown.stdout,
    /opt-in LLM output and is separate from the deterministic findings/u,
  );
  assert.doesNotMatch(markdown.stdout, /[\u001b\u0007]/u);

  const json = await renderWith("json", runner);
  const parsed = JSON.parse(json.stdout) as ReportV2 & {
    advisory?: { source: string; text: string };
  };
  assert.equal(parsed.version, 2);
  assert.equal(parsed.advisory?.source, "llm");
  assert.match(parsed.advisory?.text ?? "", /Second \| suggestion/u);
  assert.doesNotMatch(parsed.advisory?.text ?? "", /[\u001b\u0007]/u);
  assert.deepEqual(json.warnings, []);
});

test("advisory text is truncated to the display limit", async () => {
  const result = await renderWith(
    "json",
    fakeRunner({ stdout: "a".repeat(ADVISORY_MAX_TEXT_CHARS + 500) }),
  );
  const parsed = JSON.parse(result.stdout) as {
    advisory?: { text: string };
  };
  assert.equal(parsed.advisory?.text.length, ADVISORY_MAX_TEXT_CHARS);
});

test("advisory failures degrade to one warning without touching the report", async () => {
  const baseline = renderJsonReport(report());
  const failures: Array<[CommandRunner, RegExp]> = [
    [
      fakeRunner({ code: 1, stderr: "boom" }),
      /^advisory unavailable: claude CLI exited with code 1$/u,
    ],
    [
      fakeRunner({ code: 127 }),
      /^advisory unavailable: claude CLI exited with code 127$/u,
    ],
    [
      fakeRunner({ code: 124, timedOut: true }),
      /^advisory unavailable: claude CLI timed out$/u,
    ],
    [
      fakeRunner({ stdout: "partial", stdoutTruncated: true }),
      /^advisory unavailable: claude CLI output exceeded 65536-byte limit$/u,
    ],
    [
      fakeRunner({ code: 0, stdout: " \n " }),
      /^advisory unavailable: claude CLI produced no output$/u,
    ],
    [
      async () => {
        throw new Error("spawn failure with PRIVATE_DETAIL");
      },
      /^advisory unavailable: claude CLI could not be started$/u,
    ],
  ];

  for (const [runner, expected] of failures) {
    const result = await renderWith("json", runner);
    assert.equal(result.stdout, baseline);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] as string, expected);
  }
});

test("requestAdvisory reports unavailable outcomes directly", async () => {
  const timedOut = await requestAdvisory(
    "{}",
    fakeRunner({ code: 124, timedOut: true }),
  );
  assert.deepEqual(timedOut, {
    kind: "unavailable",
    reason: "claude CLI timed out",
  });

  const ok = await requestAdvisory("{}", fakeRunner({ stdout: "- hi" }));
  assert.deepEqual(ok, {
    kind: "available",
    advisory: { source: "llm", text: "- hi" },
  });
});

test("without --advisory the JSON output is byte-identical and never calls the CLI", async () => {
  const calls: RunnerCall[] = [];
  const result = await renderWith(
    "json",
    fakeRunner({ stdout: "- must not appear" }, calls),
    false,
  );

  assert.equal(calls.length, 0);
  assert.equal(result.stdout, renderJsonReport(report()));
  assert.ok(!("advisory" in (JSON.parse(result.stdout) as object)));
});

test("CLI forwards --advisory, keeps exit code 0, and routes the warning to stderr", async () => {
  let seenAdvisory: boolean | undefined;
  const handlers: CliHandlers = {
    analyze: async (options) => {
      seenAdvisory = options.advisory;
      return await runAnalyzeCommand(
        options,
        dependencies(fakeRunner({ code: 1 })),
      );
    },
    stats: async () => ({ stdout: "", warnings: [] }),
    dismiss: async () => ({ stdout: "", warnings: [] }),
    hookEvent: async () => ({ stdout: "", warnings: [] }),
    hooks: async () => ({ stdout: "", warnings: [] }),
  };
  let stdout = "";
  let stderr = "";
  const code = await runCli(["--json", "--advisory"], {
    cwd: "/repo",
    handlers,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });

  assert.equal(code, 0);
  assert.equal(seenAdvisory, true);
  assert.equal((JSON.parse(stdout) as ReportV2).version, 2);
  assert.doesNotMatch(stdout, /advisory unavailable/u);
  assert.match(stderr, /advisory unavailable: claude CLI exited with code 1/u);
});
