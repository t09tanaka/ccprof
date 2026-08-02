import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CliUsageError,
  parseCliArgs,
  parseDurationMs,
  resolvePackageVersion,
  runCli,
  type CliHandlers,
} from "../src/cli.js";
import {
  runAnalyzeCommand,
} from "../src/commands/analyze.js";
import {
  FindingNotFoundError,
  runDismissCommand,
} from "../src/commands/dismiss.js";
import type {
  AnalysisSummary,
  Finding,
  ReportV2,
} from "../src/core/model.js";
import {
  NoAnalyzableTimestampsError,
  NoMatchingSessionsError,
} from "../src/core/analyze.js";
import { GitContextError } from "../src/git/pr-context.js";
import { renderJsonReport } from "../src/reporters/json.js";
import { renderMarkdownReport } from "../src/reporters/markdown.js";
import {
  renderStatsJson,
  renderStatsTty,
  summarizeStats,
} from "../src/reporters/stats.js";
import {
  renderTtyReport,
  TTY_MAX_LINES,
} from "../src/reporters/tty.js";
import {
  makeAnalysisRecord,
  type AnalysisRecord,
} from "../src/store/analyses.js";
import type { AdoptionRecord } from "../src/store/adoptions.js";
import { runStatsCommand } from "../src/commands/stats.js";
import type { StorePaths } from "../src/store/paths.js";

function finding(
  index: number,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    finding_key: `finding-${index}`,
    rule_id: index % 2 === 0 ? "R002" : "R001",
    title: index === 1 ? "Repeated | full test" : `Finding ${index}`,
    classification: "behavior",
    cause: null,
    scope: "this_pr",
    confidence: "high",
    evidence: {
      session_refs: [`session#${index}`],
      interval_ids: [`R002:${index}`],
      command: index === 1 ? "npm test | tee output" : "npm test",
    },
    recoverable: { min: 4 - index / 2, bound: "point" },
    fix_recipe: {
      suggestion: `Fix | recipe ${index}`,
      verify: "npm test",
    },
    caveats: index === 1 ? ["Finding | caveat"] : [],
    ...overrides,
  };
}

const summary: AnalysisSummary = {
  measured_min: 42,
  idle_excluded_min: 8,
  estimated_floor_min: 34,
  recoverable_min: 8,
  human_wait_min: 2,
  unexplained_min: 3,
  baseline: {
    prs: 4,
    notable: [{
      metric: "human_wait_ratio",
      value: 0.2,
      baseline: 0.1,
    }],
  },
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
    findings: [finding(1), finding(2), finding(3), finding(4)],
    caveats: [
      "Timestamp | precision is limited.",
      "Second caveat.",
      "Third caveat.",
      "Fourth caveat.",
    ],
  };
}

function terminalAttack(marker: string): string {
  return [
    `\u001b]0;${marker}_OSC\u0007`,
    `visible-${marker}`,
    `\u001bP1;2|${marker}_DCS\u001b\\`,
    "\u001b[31mpainted\u001b[0m",
    "\u0007",
  ].join("");
}

function assertTerminalAttackRemoved(
  output: string,
  marker: string,
): void {
  assert.doesNotMatch(output, /[\u001b\u0007]/u);
  assert.doesNotMatch(
    output,
    new RegExp(`${marker}_(?:OSC|DCS)`, "u"),
  );
  assert.match(output, new RegExp(`visible-${marker}`, "u"));
  assert.match(output, /painted/u);
}

test("JSON reporter emits one stable v2 document with at most three findings", () => {
  const output = renderJsonReport(report());
  const parsed = JSON.parse(output) as ReportV2;

  assert.equal(parsed.version, 2);
  assert.equal(parsed.summary.unexplained_min, 3);
  assert.equal(parsed.summary.human_wait_min, 2);
  assert.equal(parsed.findings.length, 3);
  assert.equal(output.trim().split(/\n(?=\{)/u).length, 1);
  assert.doesNotMatch(output, /\u001b\[/u);
  assert.ok(output.indexOf('"version"') < output.indexOf('"unit"'));
  assert.ok(output.indexOf('"unit"') < output.indexOf('"summary"'));
  assert.ok(output.indexOf('"summary"') < output.indexOf('"findings"'));
  assert.ok(output.indexOf('"findings"') < output.indexOf('"caveats"'));
});

test("JSON reporter carries skipped_rules through and omits it when absent", () => {
  const withSkips = report();
  withSkips.skipped_rules = [
    { rule_id: "R001", missing: ["edit_fragments"] },
    { rule_id: "R007", missing: ["token_usage"] },
  ];
  const parsedWithSkips = JSON.parse(renderJsonReport(withSkips)) as ReportV2;
  assert.deepEqual(parsedWithSkips.skipped_rules, [
    { rule_id: "R001", missing: ["edit_fragments"] },
    { rule_id: "R007", missing: ["token_usage"] },
  ]);

  const withoutSkips = JSON.parse(renderJsonReport(report())) as ReportV2;
  assert.equal(withoutSkips.skipped_rules, undefined);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(withoutSkips, "skipped_rules"),
  );
});

test("TTY and Markdown reporters show a skipped-rules line near caveats only when present", () => {
  const withSkips = report();
  withSkips.skipped_rules = [{ rule_id: "R007", missing: ["token_usage"] }];

  const tty = renderTtyReport(withSkips, { color: false });
  assert.match(
    tty,
    /Skipped rules \(source lacks required data\): R007 \(token_usage\)/u,
  );
  const markdown = renderMarkdownReport(withSkips);
  assert.match(
    markdown,
    /Skipped rules \(source lacks required data\): R007 \(token_usage\)/u,
  );

  const withoutSkips = report();
  assert.doesNotMatch(renderTtyReport(withoutSkips, { color: false }), /Skipped rules/u);
  assert.doesNotMatch(renderMarkdownReport(withoutSkips), /Skipped rules/u);
});

test("TTY reporter is conclusion-first, compact, and colors only by opt-in", () => {
  const plain = renderTtyReport(report(), { color: false });
  const colored = renderTtyReport(report(), { color: true });

  assert.match(plain.split("\n")[0] ?? "", /^ccprof:/u);
  assert.doesNotMatch(plain, /\u001b\[/u);
  assert.match(colored, /\u001b\[/u);
  assert.ok(plain.trimEnd().split("\n").length <= TTY_MAX_LINES);
  assert.match(plain, /Timestamp \| precision/u);
  assert.match(plain, /1\. \[R001\]/u);
  assert.match(plain.split("\n")[0] ?? "", /8m idle excluded/u);
  assert.match(plain.split("\n")[0] ?? "", /2m human wait/u);
  assert.match(plain.split("\n")[0] ?? "", /3m unexplained/u);
});

test("Markdown reporter escapes dynamic pipes and never emits ANSI", () => {
  const output = renderMarkdownReport(report());

  assert.match(output, /^## ccprof/mu);
  assert.match(output, /Repeated \\\| full test/u);
  assert.match(output, /npm test \\\| tee output/u);
  assert.match(output, /Timestamp \\\| precision/u);
  assert.match(output, /\| Human wait \| 2 \|/u);
  assert.doesNotMatch(output, /\u001b\[/u);
});

test("human report renderers remove terminal control strings without changing JSON values", () => {
  const oscTitle =
    "\u001b]0;OSC_TITLE_ATTACK\u0007Visible title";
  const oscClipboard =
    "\u001b]52;c;CLIPBOARD_ATTACK\u001b\\Visible suggestion";
  const dcsPath =
    "/repo/\u001bP1;2|DCS_ATTACK\u001b\\safe-path";
  const controlled = report();
  controlled.findings = [finding(1, {
    title: oscTitle,
    evidence: {
      session_refs: ["session#1"],
      interval_ids: ["R001:1"],
      command:
        "npm test \u001b]0;COMMAND_ATTACK\u0007-- safe",
      paths: [dcsPath],
    },
    fix_recipe: {
      suggestion: oscClipboard,
      verify: "npm \u001b[31mtest\u001b[0m\u0007",
    },
    caveats: [
      `Read ${dcsPath}`,
    ],
  })];
  controlled.caveats = [
    `Source ${dcsPath}`,
  ];

  const tty = renderTtyReport(controlled, { color: false });
  const markdown = renderMarkdownReport(controlled);
  for (const output of [tty, markdown]) {
    assert.doesNotMatch(output, /[\u001b\u0007]/u);
    assert.doesNotMatch(
      output,
      /OSC_TITLE_ATTACK|CLIPBOARD_ATTACK|COMMAND_ATTACK|DCS_ATTACK/u,
    );
  }
  assert.match(tty, /Visible title/u);
  assert.match(tty, /Visible suggestion/u);
  assert.match(markdown, /Visible title/u);
  assert.match(markdown, /Visible suggestion/u);

  const json = JSON.parse(renderJsonReport(controlled)) as ReportV2;
  assert.equal(json.findings[0]?.title, oscTitle);
  assert.equal(
    json.findings[0]?.fix_recipe.suggestion,
    oscClipboard,
  );
  assert.equal(json.caveats[0], `Source ${dcsPath}`);
});

function historyRecord(
  index: number,
  options: {
    commandCost?: number;
    baseline?: AnalysisSummary["baseline"];
  } = {},
): AnalysisRecord {
  return makeAnalysisRecord({
    analysis_id: `history-${index}`,
    created_at_ms: index,
    unit: {
      repo: "/repo",
      pr_ref: `main...feature-${index}`,
      sessions: [`s${index}`],
    },
    summary: {
      ...summary,
      measured_min: 10,
      baseline: options.baseline ?? null,
    },
    findings: [finding(index, {
      rule_id: "R002",
      recoverable: { min: 2, bound: "point" },
    })],
    metrics: { human_wait_ratio: index / 10 },
    command_costs: options.commandCost === undefined
      ? []
      : [{
          command: "npm test",
          duration_min: options.commandCost,
          session_refs: [`s${index}#run`],
        }],
  });
}

test("stats reports history, baseline, chronic commands, and rule minutes", () => {
  const records = Array.from({ length: 5 }, (_, index) =>
    historyRecord(index + 1, {
      ...(index < 3 ? { commandCost: 5 } : {}),
      ...(index === 4 ? { baseline: summary.baseline } : {}),
    })
  );
  const stats = summarizeStats(records);

  assert.equal(stats.history_count, 5);
  assert.equal(stats.baseline_metrics[0]?.metric, "human_wait_ratio");
  assert.equal(stats.chronic_commands[0]?.command, "npm test");
  assert.equal(stats.chronic_commands[0]?.cost_ratio, 0.3);
  assert.deepEqual(stats.rule_minutes, [{ rule_id: "R002", minutes: 10 }]);
  assert.deepEqual(JSON.parse(renderStatsJson(stats)), stats);
  assert.match(renderStatsTty(stats), /History: 5 analyses/u);
  assert.match(renderStatsTty(stats), /R002: 10m/u);
});

test("stats TTY removes stored control strings while stats JSON preserves values", () => {
  const command =
    "npm \u001b[32mtest\u001b[0m \u001b]52;c;STATS_OSC_ATTACK\u0007\u001bPpayload:DCS_STATS_ATTACK\u001b\\-- safe";
  const metric = "human\u0007_wait\u001b[31m_ratio\u001b[0m";
  const stats = {
    history_count: 1,
    baseline_metrics: [{
      metric,
      value: 0.2,
      baseline: 0.1,
    }],
    chronic_commands: [{
      command,
      presence_count: 3,
      cost_ratio: 0.3,
      estimated_min: 2,
    }],
    rule_minutes: [],
    recurring_findings: [{
      finding_key: "recurring-attack",
      rule_id: "R002" as const,
      title: "Recurring\u0007 title\u001b[31m attack\u001b[0m",
      occurrence_count: 2,
      first_min: 3,
      first_bound: "point" as const,
      last_min: 1,
      last_bound: "point" as const,
      trend: "improved" as const,
    }],
    adoptions: [],
    adoption_coverage: { detectable: 0, undetectable: 0 },
  };

  const tty = renderStatsTty(stats);
  assert.doesNotMatch(tty, /[\u001b\u0007]/u);
  assert.doesNotMatch(
    tty,
    /STATS_OSC_ATTACK|DCS_STATS_ATTACK/u,
  );
  assert.match(tty, /npm test -- safe/u);
  assert.match(tty, /human _wait_ratio/u);
  assert.match(tty, /Recurring title attack/u);

  const json = JSON.parse(renderStatsJson(stats)) as typeof stats;
  assert.equal(json.chronic_commands[0]?.command, command);
  assert.equal(json.baseline_metrics[0]?.metric, metric);
});

test("CLI parser accepts direct analyze, optional PR selectors, durations, stats, and dismiss", () => {
  assert.deepEqual(parseCliArgs([]), {
    kind: "analyze",
    format: "tty",
    color: false,
  });
  assert.deepEqual(parseCliArgs(["--pr", "--json"]), {
    kind: "analyze",
    format: "json",
    color: false,
  });
  for (const selector of [
    "123",
    "https://github.com/acme/repo/pull/123",
    "main...feature",
  ]) {
    assert.equal(
      (parseCliArgs(["--pr", selector]) as { pr?: string }).pr,
      selector,
    );
  }
  assert.deepEqual(
    parseCliArgs([
      "--pr=42",
      "--md",
      "--idle-threshold",
      "90s",
      "--test-map",
      "test-map.json",
      "--color",
    ]),
    {
      kind: "analyze",
      pr: "42",
      format: "markdown",
      color: true,
      idleThresholdMs: 90_000,
      testMapPath: "test-map.json",
    },
  );
  assert.equal(parseDurationMs("1.5"), 90_000);
  assert.equal(parseDurationMs("2m"), 120_000);
  assert.equal(parseDurationMs("0.5h"), 1_800_000);
  assert.deepEqual(parseCliArgs(["stats", "--json"]), {
    kind: "stats",
    json: true,
  });
  assert.deepEqual(
    parseCliArgs(["dismiss", "finding-key", "--reason", "local trade-off"]),
    {
      kind: "dismiss",
      findingKey: "finding-key",
      reason: "local trade-off",
    },
  );
  assert.throws(
    () => parseCliArgs(["--json", "--md"]),
    CliUsageError,
  );
});

function handlers(
  analyze: CliHandlers["analyze"] = async () => ({
    stdout: renderJsonReport(report()),
    warnings: ["fixture warning"],
  }),
): CliHandlers {
  return {
    analyze,
    stats: async () => ({ stdout: "{}\n", warnings: [] }),
    dismiss: async () => ({ stdout: "dismissed\n", warnings: [] }),
  };
}

test("CLI routes clean stdout, warnings to stderr, and returns success", async () => {
  let stdout = "";
  let stderr = "";
  const code = await runCli(["--json"], {
    cwd: "/repo",
    handlers: handlers(),
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });

  assert.equal(code, 0);
  assert.equal((JSON.parse(stdout) as ReportV2).version, 2);
  assert.doesNotMatch(stdout, /fixture warning/u);
  assert.match(stderr, /fixture warning/u);
});

test("CLI enables default color only for human TTY output and honors explicit color", async () => {
  const colors: Array<[string, boolean]> = [];
  const scenarioHandlers = handlers(async (options) => {
    colors.push([options.format, options.color]);
    return { stdout: "ok", warnings: [] };
  });
  const output = (_value: string): void => undefined;
  const plainRuntime = {
    handlers: scenarioHandlers,
    stdout: output,
    stderr: output,
  };
  const ttyRuntime = { ...plainRuntime, stdoutIsTTY: true };
  const forcedRuntime = { ...plainRuntime, stdoutIsTTY: false };

  await runCli([], plainRuntime);
  await runCli([], ttyRuntime);
  await runCli(["--color"], forcedRuntime);
  await runCli(["--json"], ttyRuntime);

  assert.deepEqual(colors, [
    ["tty", false],
    ["tty", true],
    ["tty", true],
    ["json", false],
  ]);
});

test("CLI sanitizes warnings and caught errors before writing stderr", async () => {
  const warningAttack = terminalAttack("WARNING");
  let warningStdout = "";
  let warningStderr = "";
  const warningCode = await runCli(["--json"], {
    handlers: handlers(async () => ({
      stdout: renderJsonReport(report()),
      warnings: [warningAttack],
    })),
    stdout: (value) => {
      warningStdout += value;
    },
    stderr: (value) => {
      warningStderr += value;
    },
  });

  assert.equal(warningCode, 0);
  assert.equal((JSON.parse(warningStdout) as ReportV2).version, 2);
  assertTerminalAttackRemoved(warningStderr, "WARNING");

  for (const scenario of [
    {
      args: [terminalAttack("ARGUMENT")],
      expectedCode: 2,
      marker: "ARGUMENT",
      scenarioHandlers: handlers(),
    },
    {
      args: [] as string[],
      expectedCode: 5,
      marker: "OPERATIONAL",
      scenarioHandlers: handlers(async () => {
        throw new Error(terminalAttack("OPERATIONAL"));
      }),
    },
  ]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(scenario.args, {
      handlers: scenario.scenarioHandlers,
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    });

    assert.equal(code, scenario.expectedCode);
    assert.equal(stdout, "");
    assertTerminalAttackRemoved(stderr, scenario.marker);
  }
});

test("CLI maps usage, git context, no-session, and unknown failures to 2/3/4/5", async () => {
  const silent = {
    stdout: (_value: string): void => undefined,
    stderr: (_value: string): void => undefined,
  };
  assert.equal(
    await runCli(["--json", "--md"], {
      ...silent,
      handlers: handlers(),
    }),
    2,
  );
  assert.equal(
    await runCli([], {
      ...silent,
      handlers: handlers(async () => {
        throw new GitContextError("not a repository");
      }),
    }),
    3,
  );
  assert.equal(
    await runCli([], {
      ...silent,
      handlers: handlers(async () => {
        throw new NoMatchingSessionsError();
      }),
    }),
    4,
  );
  assert.equal(
    await runCli([], {
      ...silent,
      handlers: handlers(async () => {
        throw new Error("store unavailable");
      }),
    }),
    5,
  );
});

test("CLI maps no analyzable timestamps to exit 4 with empty stdout", async () => {
  let stdout = "";
  let stderr = "";
  const code = await runCli([], {
    handlers: handlers(async () => {
      throw new NoAnalyzableTimestampsError();
    }),
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });

  assert.equal(code, 4);
  assert.equal(stdout, "");
  assert.match(stderr, /not contain enough valid timestamps/u);
});

test("analyze command renders injected analysis without mixing warnings into JSON", async () => {
  const result = await runAnalyzeCommand(
    {
      cwd: "/repo",
      format: "json",
      color: false,
    },
    {
      analyze: async () => ({
        report: report(),
        warnings: [{
          code: "fixture",
          message: "partial data",
        }],
      }),
    },
  );

  assert.equal((JSON.parse(result.stdout) as ReportV2).version, 2);
  assert.deepEqual(result.warnings, ["[fixture] partial data"]);
});

const storePaths: StorePaths = {
  canonical_repo: "/repo",
  repo_hash: "hash",
  root_dir: "/data",
  repo_dir: "/data/hash",
  analyses_dir: "/data/hash/analyses",
  history_index_path: "/data/hash/index.json",
  dismissals_path: "/data/hash/dismissals.json",
  adoptions_path: "/data/hash/adoptions.json",
};

test("dismiss rejects unknown finding keys before any write", async () => {
  let saves = 0;
  await assert.rejects(
    runDismissCommand(
      {
        cwd: "/repo",
        findingKey: "missing",
      },
      {
        resolveRepoRoot: async () => "/repo",
        resolveStorePaths: async () => storePaths,
        loadAnalyses: async () => ({ records: [], warnings: [] }),
        saveDismissal: async () => {
          saves += 1;
          throw new Error("must not be called");
        },
        now: () => 1_000,
      },
    ),
    FindingNotFoundError,
  );
  assert.equal(saves, 0);
});

test("dismiss success text sanitizes its stored finding key", async () => {
  const findingKey = terminalAttack("DISMISS");
  const stored = historyRecord(1);
  stored.findings = [finding(1, { finding_key: findingKey })];

  const result = await runDismissCommand(
    {
      cwd: "/repo",
      findingKey,
    },
    {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => storePaths,
      loadAnalyses: async () => ({ records: [stored], warnings: [] }),
      saveDismissal: async (_paths, input) => ({
        record: {
          schema_version: 1,
          finding_key: input.finding_key,
          target: input.target,
          dismissed_at_ms: input.dismissed_at_ms,
          strength_min: input.strength_min,
          ...(input.reason === undefined
            ? {}
            : { reason: input.reason }),
        },
        warnings: [],
      }),
      now: () => 1_000,
    },
  );

  assertTerminalAttackRemoved(result.stdout, "DISMISS");
  assert.match(result.stdout, /^Dismissed /u);
  assert.match(result.stdout, / for 14 days\.\n$/u);
});

test("the built CLI runs through an npm-link-style symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-bin-link-"));
  try {
    const builtCli = resolve(process.cwd(), ".test-dist/src/cli.js");
    const linkedCli = join(root, "ccprof");
    await symlink(builtCli, linkedCli);

    const result = spawnSync(process.execPath, [linkedCli, "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: ccprof/u);

    const version = spawnSync(process.execPath, [linkedCli, "--version"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, `ccprof ${await packageVersion()}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function packageVersion(): Promise<string> {
  const manifest = await readFile(
    resolve(process.cwd(), "package.json"),
    "utf8",
  );
  return (JSON.parse(manifest) as { version: string }).version;
}

test("--version and -v report the package version and exit 0", async () => {
  assert.deepEqual(parseCliArgs(["--version"]), { kind: "version" });
  assert.deepEqual(parseCliArgs(["-v"]), { kind: "version" });

  const expected = await packageVersion();
  assert.equal(resolvePackageVersion(), expected);

  for (const args of [["--version"], ["-v"], ["--pr", "--version"]]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    });
    assert.equal(code, 0, args.join(" "));
    assert.equal(stdout, `ccprof ${expected}\n`);
    assert.equal(stderr, "");
  }
});

test("--help wins over --version when both are supplied", async () => {
  let stdout = "";
  const code = await runCli(["--version", "--help"], {
    stdout: (value) => {
      stdout += value;
    },
  });
  assert.equal(code, 0);
  assert.match(stdout, /^Usage: ccprof/u);
  assert.match(stdout, /ccprof --version/u);
});

function recurringRecord(
  index: number,
  findings: Finding[],
): AnalysisRecord {
  return makeAnalysisRecord({
    analysis_id: `recurring-${index}`,
    created_at_ms: index,
    unit: {
      repo: "/repo",
      pr_ref: `main...recurring-${index}`,
      sessions: [`s${index}`],
    },
    summary: { ...summary, baseline: null },
    findings,
    metrics: {},
    command_costs: [],
  });
}

function recurringFinding(
  key: string,
  ruleId: Finding["rule_id"],
  min: number,
  title = `Title ${key}`,
  bound: Finding["recoverable"]["bound"] = "point",
): Finding {
  return finding(1, {
    finding_key: key,
    rule_id: ruleId,
    title,
    recoverable: { min, bound },
  });
}

test("stats reports recurring findings with per-analysis sums and trends", () => {
  const records = [
    recurringRecord(1, [
      recurringFinding("improved-key", "R002", 12.5, "Redundant test or build runs"),
      recurringFinding("worsened-key", "R001", 1),
      recurringFinding("flat-key", "R003", 2),
      recurringFinding("dup-key", "R005", 1),
      recurringFinding("dup-key", "R005", 2),
      recurringFinding("single-key", "R004", 9),
    ]),
    recurringRecord(2, [
      recurringFinding("improved-key", "R002", 8.2, "Redundant test or build runs"),
      recurringFinding("worsened-key", "R001", 3),
      recurringFinding("flat-key", "R003", 2),
      recurringFinding("dup-key", "R005", 3),
    ]),
  ];
  const stats = summarizeStats(records);

  assert.deepEqual(stats.recurring_findings, [
    {
      finding_key: "improved-key",
      rule_id: "R002",
      title: "Redundant test or build runs",
      occurrence_count: 2,
      first_min: 12.5,
      first_bound: "point",
      last_min: 8.2,
      last_bound: "point",
      trend: "improved",
    },
    {
      finding_key: "worsened-key",
      rule_id: "R001",
      title: "Title worsened-key",
      occurrence_count: 2,
      first_min: 1,
      first_bound: "point",
      last_min: 3,
      last_bound: "point",
      trend: "worsened",
    },
    {
      finding_key: "dup-key",
      rule_id: "R005",
      title: "Title dup-key",
      occurrence_count: 2,
      first_min: 3,
      first_bound: "point",
      last_min: 3,
      last_bound: "point",
      trend: "flat",
    },
    {
      finding_key: "flat-key",
      rule_id: "R003",
      title: "Title flat-key",
      occurrence_count: 2,
      first_min: 2,
      first_bound: "point",
      last_min: 2,
      last_bound: "point",
      trend: "flat",
    },
  ]);

  const tty = renderStatsTty(stats);
  assert.match(tty, /Recurring findings:/u);
  assert.match(
    tty,
    /- \[R002\] 12\.5m -> 8\.2m \(improved, seen 2x\) Redundant test or build runs/u,
  );
  assert.match(tty, /- \[R001\] 1m -> 3m \(worsened, seen 2x\)/u);
  assert.doesNotMatch(tty, /single-key|Title single-key/u);
});

test("stats marks mixed-bound recurrences as indeterminate", () => {
  const stats = summarizeStats([
    recurringRecord(1, [
      recurringFinding("mixed-key", "R007", 5, "Oversized tool result", "point"),
    ]),
    recurringRecord(2, [
      recurringFinding("mixed-key", "R007", 2, "Oversized tool result", "upper"),
    ]),
  ]);
  assert.deepEqual(stats.recurring_findings, [{
    finding_key: "mixed-key",
    rule_id: "R007",
    title: "Oversized tool result",
    occurrence_count: 2,
    first_min: 5,
    first_bound: "point",
    last_min: 2,
    last_bound: "upper",
    trend: "indeterminate",
  }]);
  assert.match(
    renderStatsTty(stats),
    /- \[R007\] 5m -> 2m \(indeterminate, seen 2x\) Oversized tool result/u,
  );
});

test("stats reports no recurring findings for a single analysis", () => {
  const stats = summarizeStats([
    recurringRecord(1, [recurringFinding("only-key", "R002", 5)]),
  ]);
  assert.deepEqual(stats.recurring_findings, []);
  assert.match(renderStatsTty(stats), /Recurring findings:\n- none/u);
});

test("stats TTY caps recurring findings at ten while JSON keeps all", () => {
  const keys = Array.from(
    { length: 12 },
    (_, index) => `key-${String(index).padStart(2, "0")}`,
  );
  const records = [1, 2].map((index) =>
    recurringRecord(
      index,
      keys.map((key, position) => recurringFinding(key, "R002", 24 - position)),
    )
  );
  const stats = summarizeStats(records);
  assert.equal(stats.recurring_findings.length, 12);

  const tty = renderStatsTty(stats);
  const lines = tty.split("\n").filter((line) => line.startsWith("- [R002]"));
  assert.equal(lines.length, 10);
  assert.match(tty, /and 2 more/u);

  const json = JSON.parse(renderStatsJson(stats)) as typeof stats;
  assert.equal(json.recurring_findings.length, 12);
});

function adoptionFinding(
  key: string,
  overrides: Partial<Finding> = {},
): Finding {
  return finding(1, {
    finding_key: key,
    recoverable: { min: 0, bound: "point" },
    ...overrides,
  });
}

function adoptionAnalysisRecord(
  id: string,
  createdAtMs: number,
  findings: Finding[],
  prRef: string = `main...${id}`,
): AnalysisRecord {
  return makeAnalysisRecord({
    analysis_id: id,
    created_at_ms: createdAtMs,
    unit: { repo: "/repo", pr_ref: prRef, sessions: [id] },
    summary: { ...summary, baseline: null },
    findings,
    metrics: {},
    command_costs: [],
  });
}

function adoptionRecordFixture(
  overrides: Partial<AdoptionRecord> = {},
): AdoptionRecord {
  return {
    finding_key: "key",
    rule_id: "R001",
    scope: "this_pr",
    fingerprint: "fingerprint",
    method: "claude_md_edit",
    detected_at_ms: 0,
    evidence: {
      commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      path: "CLAUDE.md",
    },
    ...overrides,
  };
}

const ADOPTION_DAY0_MS = Date.UTC(2026, 7, 1, 12, 0, 0);

function adoptionFixtureRecords(): AnalysisRecord[] {
  return [
    adoptionAnalysisRecord("a1", ADOPTION_DAY0_MS - 100_000, [
      adoptionFinding("adopted-key", {
        rule_id: "R003",
        title: "Cache the build output",
        scope: "claude_md",
        recoverable: { min: 12, bound: "point" },
      }),
      adoptionFinding("recurred-key", {
        rule_id: "R002",
        title: "Redundant test runs",
        scope: "this_pr",
        recoverable: { min: 5, bound: "point" },
      }),
      adoptionFinding("no-data-key", {
        rule_id: "R004",
        title: "Missing changelog entry",
        scope: "this_pr",
        target: "docs/CHANGELOG.md",
        recoverable: { min: 3, bound: "point" },
      }),
      adoptionFinding("stable-detectable-key", {
        rule_id: "R001",
        title: "Add CLAUDE.md guidance",
        scope: "claude_md",
        recoverable: { min: 1, bound: "point" },
      }),
      adoptionFinding("stable-undetectable-key", {
        rule_id: "R002",
        title: "Misc pattern",
        scope: "this_pr",
        recoverable: { min: 1, bound: "point" },
      }),
    ]),
    adoptionAnalysisRecord("a2", ADOPTION_DAY0_MS + 100_000, [
      adoptionFinding("recurred-key", {
        rule_id: "R002",
        title: "Redundant test runs",
        scope: "this_pr",
        recoverable: { min: 2, bound: "point" },
      }),
    ]),
    adoptionAnalysisRecord("a3", ADOPTION_DAY0_MS + 200_000, []),
    adoptionAnalysisRecord("a4", ADOPTION_DAY0_MS + 300_000, []),
  ];
}

function adoptionFixtureAdoptions(): AdoptionRecord[] {
  return [
    adoptionRecordFixture({
      finding_key: "adopted-key",
      rule_id: "R003",
      method: "claude_md_edit",
      detected_at_ms: ADOPTION_DAY0_MS,
    }),
    adoptionRecordFixture({
      finding_key: "recurred-key",
      rule_id: "R002",
      method: "target_file_edit",
      detected_at_ms: ADOPTION_DAY0_MS + 50_000,
    }),
    adoptionRecordFixture({
      finding_key: "no-data-key",
      rule_id: "R004",
      method: "claude_md_edit",
      detected_at_ms: ADOPTION_DAY0_MS + 400_000,
    }),
    adoptionRecordFixture({
      finding_key: "orphan-key",
      rule_id: "R005",
      method: "claude_md_edit",
      detected_at_ms: ADOPTION_DAY0_MS - 200_000,
    }),
  ];
}

test("stats reports adoption outcomes and coverage without altering existing keys", () => {
  const records = adoptionFixtureRecords();
  const adoptions = adoptionFixtureAdoptions();

  const stats = summarizeStats(records, adoptions);

  assert.deepEqual(stats.adoptions, [
    {
      finding_key: "adopted-key",
      rule_id: "R003",
      title: "Cache the build output",
      method: "claude_md_edit",
      detected_at_ms: ADOPTION_DAY0_MS,
      analyses_after: 3,
      recurrences_after: 0,
      minutes_before: 12,
      minutes_after: 0,
      status: "no_recurrence",
    },
    {
      finding_key: "no-data-key",
      rule_id: "R004",
      title: "Missing changelog entry",
      method: "claude_md_edit",
      detected_at_ms: ADOPTION_DAY0_MS + 400_000,
      analyses_after: 0,
      recurrences_after: 0,
      minutes_before: 3,
      minutes_after: 0,
      status: "no_data",
    },
    {
      finding_key: "orphan-key",
      rule_id: "R005",
      title: "",
      method: "claude_md_edit",
      detected_at_ms: ADOPTION_DAY0_MS - 200_000,
      analyses_after: 4,
      recurrences_after: 0,
      minutes_before: 0,
      minutes_after: 0,
      status: "no_recurrence",
    },
    {
      finding_key: "recurred-key",
      rule_id: "R002",
      title: "Redundant test runs",
      method: "target_file_edit",
      detected_at_ms: ADOPTION_DAY0_MS + 50_000,
      analyses_after: 3,
      recurrences_after: 1,
      minutes_before: 5,
      minutes_after: 2,
      status: "recurred",
    },
  ]);

  assert.deepEqual(stats.adoption_coverage, { detectable: 1, undetectable: 1 });

  // Existing keys stay byte-for-byte identical to the pre-adoption shape.
  const legacyStats = summarizeStats(records);
  assert.equal(stats.history_count, legacyStats.history_count);
  assert.deepEqual(stats.baseline_metrics, legacyStats.baseline_metrics);
  assert.deepEqual(stats.chronic_commands, legacyStats.chronic_commands);
  assert.deepEqual(stats.rule_minutes, legacyStats.rule_minutes);
  assert.deepEqual(stats.recurring_findings, legacyStats.recurring_findings);

  const json = JSON.parse(renderStatsJson(stats)) as typeof stats;
  assert.deepEqual(json, stats);
});

test("summarizeStats defaults adoptions to an empty array for backward compatibility", () => {
  const records = adoptionFixtureRecords();
  const stats = summarizeStats(records);
  assert.deepEqual(stats.adoptions, []);
  // No adoptions recorded yet, so every distinct finding is un-tracked.
  assert.deepEqual(stats.adoption_coverage, { detectable: 2, undetectable: 3 });
});

test("stats TTY renders adopted suggestions with the caveat and coverage lines", () => {
  const stats = summarizeStats(
    adoptionFixtureRecords(),
    adoptionFixtureAdoptions(),
  );
  const tty = renderStatsTty(stats);

  assert.match(tty, /Adopted suggestions:/u);
  assert.ok(
    tty.includes(
      "- [R003] adopted 2026-08-01 (claude_md_edit): no recurrence in 3 analyses, 12m -> 0m",
    ),
  );
  assert.ok(
    tty.includes(
      "- [R004] adopted 2026-08-01 (claude_md_edit): no data yet, 3m -> 0m",
    ),
  );
  assert.ok(
    tty.includes(
      "- [R005] adopted 2026-08-01 (claude_md_edit): no recurrence in 4 analyses, 0m -> 0m",
    ),
  );
  assert.ok(
    tty.includes(
      "- [R002] adopted 2026-08-01 (target_file_edit): recurred in 1/3 analyses, 5m -> 2m",
    ),
  );
  assert.ok(
    tty.includes(
      "  (observational only: recurrence absence does not prove causation)",
    ),
  );
  assert.ok(
    tty.includes("Adoption coverage: 1 findings detectable, 1 undetectable (not tracked)"),
  );

  const recurringIndex = tty.indexOf("Recurring findings:");
  const adoptedIndex = tty.indexOf("Adopted suggestions:");
  const caveatIndex = tty.indexOf(
    "(observational only: recurrence absence does not prove causation)",
  );
  const coverageIndex = tty.indexOf("Adoption coverage:");
  const chronicIndex = tty.indexOf("Chronic commands:");
  assert.ok(recurringIndex < adoptedIndex);
  assert.ok(adoptedIndex < caveatIndex);
  assert.ok(caveatIndex < coverageIndex);
  assert.ok(coverageIndex < chronicIndex);
});

test("stats TTY omits the caveat line and shows none when there are no adoptions", () => {
  const stats = summarizeStats(adoptionFixtureRecords());
  const tty = renderStatsTty(stats);
  assert.match(tty, /Adopted suggestions:\n- none/u);
  assert.doesNotMatch(
    tty,
    /observational only: recurrence absence does not prove causation/u,
  );
  assert.match(
    tty,
    /Adoption coverage: 2 findings detectable, 3 undetectable \(not tracked\)/u,
  );
});

test("stats marks an adoption with zero follow-up analyses as no_data", () => {
  const records = [
    adoptionAnalysisRecord("only", ADOPTION_DAY0_MS - 1_000, [
      adoptionFinding("solo-key", {
        rule_id: "R006",
        title: "Solo finding",
        scope: "this_pr",
        recoverable: { min: 4, bound: "point" },
      }),
    ]),
  ];
  const adoptions = [
    adoptionRecordFixture({
      finding_key: "solo-key",
      rule_id: "R006",
      method: "target_file_edit",
      detected_at_ms: ADOPTION_DAY0_MS,
    }),
  ];
  const stats = summarizeStats(records, adoptions);
  assert.equal(stats.adoptions[0]?.status, "no_data");
  assert.equal(stats.adoptions[0]?.analyses_after, 0);
  assert.equal(stats.adoptions[0]?.recurrences_after, 0);
  assert.equal(stats.adoptions[0]?.minutes_before, 4);
  assert.equal(stats.adoptions[0]?.minutes_after, 0);
});

test("stats excludes origin-PR reruns from analyses_after/recurrences_after but still counts a genuine new-PR recurrence", () => {
  const detectedAtMs = ADOPTION_DAY0_MS;
  const records = [
    adoptionAnalysisRecord("origin", detectedAtMs - 100_000, [
      adoptionFinding("rerun-key", {
        rule_id: "R007",
        title: "Flaky rerun finding",
        scope: "this_pr",
        recoverable: { min: 6, bound: "point" },
      }),
    ]),
    // Re-analyzing the pre-adoption PR replays the same immutable session
    // data and resurfaces the same finding_key under the same pr_ref; this
    // must not be treated as recurrence.
    adoptionAnalysisRecord(
      "origin-rerun",
      detectedAtMs + 10_000,
      [
        adoptionFinding("rerun-key", {
          rule_id: "R007",
          title: "Flaky rerun finding",
          scope: "this_pr",
          recoverable: { min: 6, bound: "point" },
        }),
      ],
      "main...origin",
    ),
    // A genuinely different PR reproduces the finding after adoption.
    adoptionAnalysisRecord("fresh", detectedAtMs + 20_000, [
      adoptionFinding("rerun-key", {
        rule_id: "R007",
        title: "Flaky rerun finding",
        scope: "this_pr",
        recoverable: { min: 3, bound: "point" },
      }),
    ]),
  ];
  const adoptions = [
    adoptionRecordFixture({
      finding_key: "rerun-key",
      rule_id: "R007",
      method: "claude_md_edit",
      detected_at_ms: detectedAtMs,
    }),
  ];

  const stats = summarizeStats(records, adoptions);
  assert.equal(stats.adoptions.length, 1);
  const [outcome] = stats.adoptions;
  assert.equal(outcome?.analyses_after, 1);
  assert.equal(outcome?.recurrences_after, 1);
  assert.equal(outcome?.minutes_before, 6);
  assert.equal(outcome?.minutes_after, 3);
  assert.equal(outcome?.status, "recurred");
});

test("stats keeps status no_recurrence when the only post-adoption match is an origin-PR rerun", () => {
  const detectedAtMs = ADOPTION_DAY0_MS;
  const records = [
    adoptionAnalysisRecord("origin2", detectedAtMs - 100_000, [
      adoptionFinding("rerun-only-key", {
        rule_id: "R007",
        title: "Flaky rerun finding",
        scope: "this_pr",
        recoverable: { min: 6, bound: "point" },
      }),
    ]),
    // Origin-PR rerun: excluded from both the numerator and denominator.
    adoptionAnalysisRecord(
      "origin2-rerun",
      detectedAtMs + 10_000,
      [
        adoptionFinding("rerun-only-key", {
          rule_id: "R007",
          title: "Flaky rerun finding",
          scope: "this_pr",
          recoverable: { min: 6, bound: "point" },
        }),
      ],
      "main...origin2",
    ),
    // An unrelated, genuine post-adoption analysis keeps analyses_after > 0
    // so the status reflects "no recurrence" rather than "no data".
    adoptionAnalysisRecord("other", detectedAtMs + 20_000, []),
  ];
  const adoptions = [
    adoptionRecordFixture({
      finding_key: "rerun-only-key",
      rule_id: "R007",
      method: "claude_md_edit",
      detected_at_ms: detectedAtMs,
    }),
  ];

  const stats = summarizeStats(records, adoptions);
  assert.equal(stats.adoptions.length, 1);
  const [outcome] = stats.adoptions;
  assert.equal(outcome?.analyses_after, 1);
  assert.equal(outcome?.recurrences_after, 0);
  assert.equal(outcome?.minutes_before, 6);
  assert.equal(outcome?.minutes_after, 0);
  assert.equal(outcome?.status, "no_recurrence");
});

test("runStatsCommand loads adoptions and threads them into the summary", async () => {
  const paths: StorePaths = {
    canonical_repo: "/repo",
    repo_hash: "hash",
    root_dir: "/repo/.ccprof",
    repo_dir: "/repo/.ccprof/hash",
    analyses_dir: "/repo/.ccprof/hash/analyses",
    history_index_path: "/repo/.ccprof/hash/history.json",
    dismissals_path: "/repo/.ccprof/hash/dismissals.json",
    adoptions_path: "/repo/.ccprof/hash/adoptions.json",
  };
  const adoptions = adoptionFixtureAdoptions();
  const records = adoptionFixtureRecords();
  let loadAdoptionsCalledWith: StorePaths | undefined;

  const result = await runStatsCommand(
    { cwd: "/repo", json: true },
    {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => paths,
      loadAnalyses: async () => ({ records, warnings: [] }),
      loadAdoptions: async (calledPaths) => {
        loadAdoptionsCalledWith = calledPaths;
        return { records: adoptions, warnings: [] };
      },
    },
  );

  assert.deepEqual(loadAdoptionsCalledWith, paths);
  const parsed = JSON.parse(result.stdout) as ReturnType<typeof summarizeStats>;
  assert.deepEqual(parsed.adoptions.map((entry) => entry.finding_key).sort(), [
    "adopted-key",
    "no-data-key",
    "orphan-key",
    "recurred-key",
  ]);
});
