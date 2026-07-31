import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
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
  assert.equal(parsed.findings.length, 3);
  assert.equal(output.trim().split(/\n(?=\{)/u).length, 1);
  assert.doesNotMatch(output, /\u001b\[/u);
  assert.ok(output.indexOf('"version"') < output.indexOf('"unit"'));
  assert.ok(output.indexOf('"unit"') < output.indexOf('"summary"'));
  assert.ok(output.indexOf('"summary"') < output.indexOf('"findings"'));
  assert.ok(output.indexOf('"findings"') < output.indexOf('"caveats"'));
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
  assert.match(plain.split("\n")[0] ?? "", /3m unexplained/u);
});

test("Markdown reporter escapes dynamic pipes and never emits ANSI", () => {
  const output = renderMarkdownReport(report());

  assert.match(output, /^## ccprof/mu);
  assert.match(output, /Repeated \\\| full test/u);
  assert.match(output, /npm test \\\| tee output/u);
  assert.match(output, /Timestamp \\\| precision/u);
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
  };

  const tty = renderStatsTty(stats);
  assert.doesNotMatch(tty, /[\u001b\u0007]/u);
  assert.doesNotMatch(
    tty,
    /STATS_OSC_ATTACK|DCS_STATS_ATTACK/u,
  );
  assert.match(tty, /npm test -- safe/u);
  assert.match(tty, /human _wait_ratio/u);

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
