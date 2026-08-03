import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
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
  parseRfc3339Ms,
  resolvePackageVersion,
  runCli,
  type CliHandlers,
  USAGE,
} from "../src/cli.js";
import {
  runAnalyzeCommand,
} from "../src/commands/analyze.js";
import {
  FindingReferenceAmbiguityError,
  FindingNotFoundError,
  runDismissCommand,
  runExplainCommand,
} from "../src/commands/dismiss.js";
import type {
  AnalysisSummary,
  CommandIdentity,
  Finding,
  ReportV2,
} from "../src/core/model.js";
import { commandIdentityKey } from "../src/analysis/command-identity.js";
import {
  InvalidAnalysisWindowError,
  NoAnalyzableTimestampsError,
  NoMatchingSessionsError,
} from "../src/core/analyze.js";
import { GitContextError } from "../src/git/pr-context.js";
import { renderJsonReport } from "../src/reporters/json.js";
import { renderMarkdownReport } from "../src/reporters/markdown.js";
import {
  findingPrivacyReference,
  projectReportPrivacy,
  projectStatsPrivacy,
  trustedVerificationCommand,
} from "../src/reporters/privacy.js";
import {
  renderStatsJson,
  renderStatsTty,
  summarizeStats,
  type StatsReport,
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

const PRIVACY_REPO = "/Users/alice/SecretCo/ccprof";
const PRIVACY_SOURCE =
  "/Users/alice/.claude/projects/SecretCo/session.jsonl";
const PRIVACY_STORE =
  "/Users/alice/.ccprof/SecretCo/analyses/private.json";
const PRIVACY_SESSION = "session-AZ09_SECRET_SESSION";
const PRIVACY_URL =
  "https://github.internal.example/SecretCo/tickets/ENG-421";
const PRIVACY_TICKET = "ENG-421";
const PRIVACY_TOKEN = "ghp_SECRET_TOKEN_123456789";
const PRIVACY_COMMAND =
  `curl -H "Authorization: Bearer ${PRIVACY_TOKEN}" ${PRIVACY_URL}`;
const PRIVACY_SPACED_PATH = `${PRIVACY_REPO}/private notes/plan.txt`;
const PRIVACY_EXTERNAL_BASENAME = "log.jsonl";
const PRIVACY_EXTERNAL_PATH =
  `/Users/alice/Secret Co/${PRIVACY_EXTERNAL_BASENAME}`;
const PRIVACY_FLAG_SECRET = "FLAG_SECRET";
const PRIVACY_DEPLOY_COMMAND =
  `./scripts/deploy --token ${PRIVACY_FLAG_SECRET}`;
const PRIVACY_WARNING_MESSAGES = [
  `Log ${PRIVACY_EXTERNAL_PATH} has session ${PRIVACY_SESSION}`,
  `Store ${PRIVACY_STORE} referenced ${PRIVACY_TICKET}`,
];

function privacyReport(): ReportV2 {
  return {
    version: 2,
    unit: {
      repo: PRIVACY_REPO,
      pr_ref: `${PRIVACY_URL}?token=${PRIVACY_TOKEN}`,
      sessions: [PRIVACY_SESSION],
    },
    summary: { ...summary, baseline: null },
    findings: [finding(1, {
      finding_key: `${PRIVACY_REPO}:${PRIVACY_COMMAND}`,
      title: `Investigate ${PRIVACY_COMMAND}`,
      target: `${PRIVACY_REPO}/src/private.ts`,
      evidence: {
        session_refs: [`${PRIVACY_SESSION}#entry-RAW`],
        interval_ids: [`R002:${PRIVACY_SESSION}:interval-RAW`],
        command: "npm test",
        paths: ["src/safe.test.ts", `${PRIVACY_REPO}/src/private.ts`],
        command_identity: {
          repo_relative_cwd: "packages/api",
          normalized_argv: ["npm", "test", "src/safe.test.ts"],
          executor: "shell",
        },
        unknown_detail: {
          source: PRIVACY_SOURCE,
          store: PRIVACY_STORE,
          url: PRIVACY_URL,
          token: PRIVACY_TOKEN,
          command: PRIVACY_COMMAND,
          quoted_path: `"${PRIVACY_SPACED_PATH}"`,
          deploy: PRIVACY_DEPLOY_COMMAND,
        },
      },
      fix_recipe: {
        suggestion:
          `Inspect "${PRIVACY_SPACED_PATH}"; then ${PRIVACY_DEPLOY_COMMAND}`,
        verify: `npm test && ${PRIVACY_COMMAND}`,
      },
      caveats: [`Ticket ${PRIVACY_TICKET}; store ${PRIVACY_STORE}`],
    })],
    caveats: PRIVACY_WARNING_MESSAGES.map(
      (message) => `[private-row] ${message}`,
    ),
  };
}

const privacyWarnings = PRIVACY_WARNING_MESSAGES.map((message, index) => ({
  code: "private-row",
  message,
  source: index === 0 ? PRIVACY_EXTERNAL_PATH : PRIVACY_STORE,
}));

function assertPrivacyCanariesAbsent(value: string): void {
  for (const canary of [
    PRIVACY_REPO,
    PRIVACY_SOURCE,
    PRIVACY_STORE,
    PRIVACY_SESSION,
    PRIVACY_URL,
    PRIVACY_TICKET,
    PRIVACY_TOKEN,
    PRIVACY_COMMAND,
    PRIVACY_SPACED_PATH,
    PRIVACY_EXTERNAL_PATH,
    PRIVACY_EXTERNAL_BASENAME,
    PRIVACY_FLAG_SECRET,
    PRIVACY_DEPLOY_COMMAND,
  ]) {
    assert.ok(!value.includes(canary), `privacy leak: ${canary}`);
  }
}

const STATS_PRIVACY_WINDOWS_PATH =
  String.raw`C:\Users\alice\SecretCo\ccprof\private.txt`;
const STATS_PRIVACY_UNC_PATH =
  String.raw`\\corp-files\ccprof\private.txt`;
const STATS_PRIVACY_SESSION =
  "session-550e8400-e29b-41d4-a716-446655440000";
const STATS_PRIVACY_ARGV_SECRET = "ARGV_SECRET_123456789";
const STATS_PRIVACY_KEY =
  `${PRIVACY_REPO}:${STATS_PRIVACY_SESSION}:${PRIVACY_TOKEN}`;
const STATS_PRIVACY_CANARIES = [
  PRIVACY_REPO,
  PRIVACY_SOURCE,
  STATS_PRIVACY_WINDOWS_PATH,
  STATS_PRIVACY_UNC_PATH,
  PRIVACY_URL,
  PRIVACY_TOKEN,
  STATS_PRIVACY_SESSION,
  STATS_PRIVACY_ARGV_SECRET,
] as const;

function statsPrivacyReport(): StatsReport {
  const privateText = [
    PRIVACY_REPO,
    PRIVACY_SOURCE,
    STATS_PRIVACY_WINDOWS_PATH,
    STATS_PRIVACY_UNC_PATH,
    PRIVACY_URL,
    PRIVACY_TOKEN,
    STATS_PRIVACY_SESSION,
  ].join(" ");
  return {
    history_count: 7,
    baseline_metrics: [{ metric: `metric ${privateText}`, value: 0.42, baseline: 0.17 }],
    chronic_commands: [{
      command: "npm test",
      command_identity: {
        repo_relative_cwd: ".",
        normalized_argv: ["npm", "test"],
        executor: "shell",
      },
      presence_count: 4,
      cost_ratio: 0.57,
      estimated_min: 12.25,
    }, {
      command: "[redacted-command]",
      presence_count: 3,
      cost_ratio: 0.43,
      estimated_min: 8.5,
    }, {
      command: `${PRIVACY_COMMAND} ${STATS_PRIVACY_WINDOWS_PATH}`,
      presence_count: 2,
      cost_ratio: 0.29,
      estimated_min: 6.75,
    }, {
      command: "npm test",
      command_identity: {
        repo_relative_cwd: PRIVACY_REPO,
        normalized_argv: [
          "npm",
          "test",
          `--password=${STATS_PRIVACY_ARGV_SECRET}`,
          STATS_PRIVACY_UNC_PATH,
        ],
        executor: "native-tool",
      },
      presence_count: 2,
      cost_ratio: 0.29,
      estimated_min: 5.25,
    }],
    rule_minutes: [
      { rule_id: "R001", minutes: 4.25 },
      { rule_id: "R007", minutes: 9.5 },
    ],
    recurring_findings: [{
      finding_key: STATS_PRIVACY_KEY,
      rule_id: "R002",
      title: `Recurring ${privateText}`,
      occurrence_count: 3,
      first_min: 12.5,
      first_bound: "point",
      last_min: 2.75,
      last_bound: "upper",
      trend: "indeterminate",
    }],
    adoptions: [{
      finding_key: STATS_PRIVACY_KEY,
      rule_id: "R002",
      title: `Adopted ${privateText}`,
      method: "target_file_edit",
      detected_at_ms: 1_785_628_800_123,
      analyses_after: 5,
      recurrences_after: 1,
      minutes_before: 12.5,
      minutes_after: 2.75,
      status: "recurred",
    }],
    adoption_coverage: { detectable: 8, undetectable: 2 },
  };
}

function statsPrivacyPreservedFields(stats: StatsReport): unknown {
  return {
    history_count: stats.history_count,
    baseline_metrics: stats.baseline_metrics.map(({ value, baseline }) => ({ value, baseline })),
    chronic_commands: stats.chronic_commands.map(
      ({ presence_count, cost_ratio, estimated_min }) =>
        ({ presence_count, cost_ratio, estimated_min }),
    ),
    rule_minutes: stats.rule_minutes,
    recurring_findings: stats.recurring_findings.map((entry) => ({
      rule_id: entry.rule_id,
      occurrence_count: entry.occurrence_count,
      first_min: entry.first_min,
      first_bound: entry.first_bound,
      last_min: entry.last_min,
      last_bound: entry.last_bound,
      trend: entry.trend,
    })),
    adoptions: stats.adoptions.map((entry) => ({
      rule_id: entry.rule_id,
      method: entry.method,
      detected_at_ms: entry.detected_at_ms,
      analyses_after: entry.analyses_after,
      recurrences_after: entry.recurrences_after,
      minutes_before: entry.minutes_before,
      minutes_after: entry.minutes_after,
      status: entry.status,
    })),
    adoption_coverage: stats.adoption_coverage,
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
    commandIdentity?: CommandIdentity;
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
          ...(options.commandIdentity === undefined ? {} : {
            command_identity: { ...options.commandIdentity,
              normalized_argv: [...options.commandIdentity.normalized_argv] },
          }),
          duration_min: options.commandCost,
          session_refs: [`s${index}#run`],
        }],
  });
}

test("stats reports history, baseline, chronic commands, and rule minutes", () => {
  const api = { repo_relative_cwd: "packages/api", normalized_argv: ["npm", "test"],
    executor: "shell" } satisfies CommandIdentity;
  const records = Array.from({ length: 5 }, (_, index) =>
    historyRecord(index + 1, {
      ...(index < 3 ? { commandCost: 5 } : {}),
      commandIdentity: api,
      ...(index === 4 ? { baseline: summary.baseline } : {}),
    })
  );
  const stats = summarizeStats(records);

  assert.equal(stats.history_count, 5);
  assert.equal(stats.baseline_metrics[0]?.metric, "human_wait_ratio");
  assert.equal(stats.chronic_commands[0]?.command, "npm test");
  assert.deepEqual(stats.chronic_commands[0]?.command_identity, api);
  assert.notEqual(stats.chronic_commands[0]?.command_identity?.normalized_argv,
    api.normalized_argv);
  assert.equal(stats.chronic_commands[0]?.cost_ratio, 0.3);
  assert.deepEqual(stats.rule_minutes, [{ rule_id: "R002", minutes: 10 }]);
  assert.deepEqual(JSON.parse(renderStatsJson(stats)), stats);
  assert.match(renderStatsTty(stats), /History: 5 analyses/u);
  assert.match(renderStatsTty(stats), /packages\/api :: npm test/u);
  assert.match(renderStatsTty(stats), /R002: 10m/u);
});

test("stats chronic commands stay separated and ordered by exact identity", () => {
  const identities: CommandIdentity[] = [
    { repo_relative_cwd: "packages/api", normalized_argv: ["npm", "test"], executor: "shell" },
    { repo_relative_cwd: "packages/web", normalized_argv: ["npm", "test"], executor: "shell" },
    { repo_relative_cwd: "packages/api", normalized_argv: ["npm", "test"], executor: "native-tool" },
  ];
  const records = Array.from({ length: 5 }, (_, index) => ({
    ...historyRecord(index + 20),
    command_costs: index < 3 ? identities.map((identity, lane) => ({
      command: "npm test", command_identity: identity, duration_min: 5,
      session_refs: [`s${index}#lane-${lane}`],
    })) : [],
  }));
  const forward = summarizeStats(records);
  const reverse = summarizeStats([...records].reverse());
  assert.deepEqual(forward.chronic_commands, reverse.chronic_commands);
  assert.deepEqual(forward.chronic_commands.map(({ command_identity }) => command_identity),
    [...identities].sort((left, right) => {
      const leftKey = commandIdentityKey(left), rightKey = commandIdentityKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }));
  assert.deepEqual(forward.chronic_commands.map(({ command }) => command),
    ["npm test", "npm test", "npm test"]);
  const tty = renderStatsTty(forward);
  assert.match(tty, /packages\/api :: npm test \[native-tool\]/u);
  assert.match(tty, /packages\/api :: npm test/u);
  assert.match(tty, /packages\/web :: npm test/u);

  const legacy = Array.from({ length: 5 }, (_, index) =>
    historyRecord(index + 30, { commandCost: 5 }));
  assert.deepEqual(summarizeStats(legacy).chronic_commands, []);
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
  assert.equal("command_identity" in json.chronic_commands[0]!, false);
  assert.equal(json.baseline_metrics[0]?.metric, metric);
});

test("CLI parser accepts direct analyze, optional PR selectors, durations, stats, and dismiss", () => {
  assert.deepEqual(parseCliArgs([]), {
    kind: "analyze",
    format: "tty",
    color: false,
    advisory: false,
  });
  assert.deepEqual(parseCliArgs(["--pr", "--json"]), {
    kind: "analyze",
    format: "json",
    color: false,
    advisory: false,
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
      advisory: false,
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

test("CLI parser accepts privacy profiles once in separated or inline form", () => {
  for (const privacy of ["strict", "balanced", "raw"] as const) {
    assert.equal(
      (parseCliArgs(["--privacy", privacy]) as { privacy?: string }).privacy,
      privacy,
    );
    assert.equal(
      (parseCliArgs([`--privacy=${privacy}`]) as { privacy?: string }).privacy,
      privacy,
    );
  }
  for (const args of [
    ["--privacy"],
    ["--privacy="],
    ["--privacy", "unknown"],
    ["--privacy=STRICT"],
    ["--privacy=strict", "--privacy", "raw"],
  ]) {
    assert.throws(() => parseCliArgs(args), CliUsageError, args.join(" "));
  }
});

test("stats CLI parser accepts privacy profiles with analyze-equivalent errors", () => {
  for (const privacy of ["strict", "balanced", "raw"] as const) {
    assert.deepEqual(parseCliArgs(["stats", "--privacy", privacy, "--json"]), {
      kind: "stats",
      json: true,
      privacy,
    });
    assert.deepEqual(parseCliArgs(["stats", `--privacy=${privacy}`]), {
      kind: "stats",
      json: false,
      privacy,
    });
  }

  for (const [args, message] of [
    [["--privacy"], "--privacy requires a value"],
    [["--privacy="], "--privacy requires a value"],
    [["--privacy", "unknown"], "--privacy must be strict, balanced, or raw"],
    [["--privacy=STRICT"], "--privacy must be strict, balanced, or raw"],
    [["--privacy=strict", "--privacy", "raw"], "--privacy was specified twice"],
  ] as const) {
    assert.throws(
      () => parseCliArgs(["stats", ...args]),
      (error) => error instanceof CliUsageError && error.message === message,
      args.join(" "),
    );
  }
});

test("CLI parser accepts exactly one finding reference for explain", () => {
  assert.deepEqual(parseCliArgs(["explain", "finding-reference"]), {
    kind: "explain",
    findingKey: "finding-reference",
  });
  for (const args of [
    ["explain"],
    ["explain", "--json"],
    ["explain", "finding-reference", "extra"],
  ]) {
    assert.throws(() => parseCliArgs(args), CliUsageError, args.join(" "));
  }
});

test("analysis-window CLI options accept strict RFC3339 and duration forms", () => {
  assert.equal(parseRfc3339Ms("1970-01-01T00:00:00Z"), 0);
  assert.equal(
    parseRfc3339Ms("2026-08-03T12:34:56.123+09:00"),
    Date.UTC(2026, 7, 3, 3, 34, 56, 123),
  );
  assert.equal(
    parseRfc3339Ms("2026-08-03t12:34:56.123456z"),
    Date.UTC(2026, 7, 3, 12, 34, 56, 123),
  );
  assert.deepEqual(
    parseCliArgs([
      "--since",
      "1970-01-01T00:00:00Z",
      "--commit-lookback=2h",
    ]),
    {
      kind: "analyze",
      format: "tty",
      color: false,
      advisory: false,
      sinceMs: 0,
      commitAnchorLookbackMs: 7_200_000,
    },
  );
  assert.deepEqual(
    parseCliArgs([
      "--since=2026-08-03T12:34:56-04:30",
      "--commit-lookback",
      "90m",
    ]),
    {
      kind: "analyze",
      format: "tty",
      color: false,
      advisory: false,
      sinceMs: Date.UTC(2026, 7, 3, 17, 4, 56),
      commitAnchorLookbackMs: 5_400_000,
    },
  );
  assert.deepEqual(
    parseCliArgs([
      "--pr",
      "--since=1970-01-01T00:00:00Z",
      "--commit-lookback",
      "0",
    ]),
    {
      kind: "analyze",
      format: "tty",
      color: false,
      advisory: false,
      sinceMs: 0,
      commitAnchorLookbackMs: 0,
    },
  );
});

test("analysis-window CLI options reject ambiguous, impossible, missing, and duplicate values", () => {
  for (const value of [
    "2026-08-03",
    "2026-08-03T12:34:56",
    "yesterday",
    "2026-02-30T12:34:56Z",
    "2026-08-03T24:00:00Z",
    "2026-08-03T12:34:60Z",
    "2026-08-03T12:34:56+24:00",
    "2026-08-03T12:34:56+09:60",
  ]) {
    assert.throws(() => parseRfc3339Ms(value), CliUsageError, value);
  }
  assert.throws(
    () => parseRfc3339Ms("1969-12-31T23:59:59Z"),
    /outside the supported date range/u,
  );
  for (const args of [
    ["--since"],
    ["--since="],
    ["--commit-lookback"],
    ["--commit-lookback="],
    ["--since=2026-08-03T00:00:00Z", "--since", "2026-08-03T00:00:00Z"],
    ["--commit-lookback=1h", "--commit-lookback", "2h"],
  ]) {
    assert.throws(() => parseCliArgs(args), CliUsageError, args.join(" "));
  }
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
    explain: async () => ({ stdout: "explained\n", warnings: [] }),
    hookEvent: async () => ({ stdout: "", warnings: [] }),
    hooks: async () => ({ stdout: "", warnings: [] }),
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

test("CLI and analyze command forward analysis-window values including epoch zero", async () => {
  let dispatchedSince: number | undefined;
  let dispatchedLookback: number | undefined;
  const code = await runCli(
    ["--since", "1970-01-01T00:00:00Z", "--commit-lookback=5m"],
    {
      handlers: handlers(async (options) => {
        dispatchedSince = options.sinceMs;
        dispatchedLookback = options.commitAnchorLookbackMs;
        return { stdout: "ok", warnings: [] };
      }),
      stdout: () => undefined,
      stderr: () => undefined,
    },
  );
  assert.equal(code, 0);
  assert.equal(dispatchedSince, 0);
  assert.equal(dispatchedLookback, 300_000);

  let coreSince: number | undefined;
  let coreLookback: number | undefined;
  await runAnalyzeCommand(
    {
      cwd: "/repo",
      format: "json",
      color: false,
      sinceMs: 0,
      commitAnchorLookbackMs: 300_000,
    },
    {
      analyze: async (options) => {
        coreSince = options.sinceMs;
        coreLookback = options.commitAnchorLookbackMs;
        return { report: report(), warnings: [] };
      },
    },
  );
  assert.equal(coreSince, 0);
  assert.equal(coreLookback, 300_000);
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
    ci: false,
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
      ci: false,
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

test("CLI maps an invalid analysis window to exit 2 and prints usage", async () => {
  let stdout = "";
  let stderr = "";
  const code = await runCli([], {
    ci: false,
    handlers: handlers(async () => {
      throw new InvalidAnalysisWindowError(
        "explicit analysis start must not be after analysis resolution",
      );
    }),
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });

  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(
    stderr,
    /explicit analysis start must not be after analysis resolution/u,
  );
  assert.match(stderr, /^Usage: ccprof/mu);
});

test("CLI maps no analyzable timestamps to exit 4 with empty stdout", async () => {
  let stdout = "";
  let stderr = "";
  const code = await runCli([], {
    ci: false,
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

test("analyze privacy defaults are balanced for JSON/TTY and strict for Markdown", async () => {
  const analyze = async () => ({ report: privacyReport(), warnings: [] });
  const json = await runAnalyzeCommand(
    { cwd: PRIVACY_REPO, format: "json", color: false },
    { analyze },
  );
  const tty = await runAnalyzeCommand(
    { cwd: PRIVACY_REPO, format: "tty", color: false },
    { analyze },
  );
  const markdown = await runAnalyzeCommand(
    { cwd: PRIVACY_REPO, format: "markdown", color: false },
    { analyze },
  );

  assert.match(json.stdout, /npm test/u);
  assert.match(json.stdout, /src\/safe\.test\.ts/u);
  assertPrivacyCanariesAbsent(json.stdout);
  assertPrivacyCanariesAbsent(tty.stdout);
  assertPrivacyCanariesAbsent(markdown.stdout);
  assert.doesNotMatch(markdown.stdout, /src\/safe\.test\.ts/u);
  assert.doesNotMatch(markdown.stdout, /Evidence command/u);
});

test("strict privacy covers report, warnings, and the advisory prompt", async () => {
  let advisoryPrompt = "";
  const result = await runAnalyzeCommand(
    {
      cwd: PRIVACY_REPO,
      format: "json",
      color: false,
      privacy: "strict",
      advisory: true,
    },
    {
      analyze: async () => ({
        report: privacyReport(),
        warnings: privacyWarnings,
      }),
      runCommand: async (_command, args) => {
        advisoryPrompt = args[1] ?? "";
        return {
          code: 0,
          stdout:
            `- ${PRIVACY_COMMAND} "${PRIVACY_SPACED_PATH}" ${PRIVACY_DEPLOY_COMMAND}\n`,
          stderr: "",
        };
      },
    },
  );

  assertPrivacyCanariesAbsent(result.stdout);
  const warningText = result.warnings.join("\n");
  assertPrivacyCanariesAbsent(warningText);
  assertPrivacyCanariesAbsent(advisoryPrompt);
  assert.equal(result.warnings.length, 1);
  assert.match(warningText, /private-row/u);
  assert.match(warningText, /2/u);
  const projected = JSON.parse(result.stdout) as ReportV2 & {
    advisory?: { text: string };
  };
  assert.equal(
    projected.advisory?.text,
    "[advisory hidden by strict privacy]",
  );
  const parserCaveats = projected.caveats.filter((caveat) =>
    caveat.includes("private-row")
  );
  assert.equal(parserCaveats.length, 1);
  assert.match(parserCaveats[0] ?? "", /2/u);
  for (const message of PRIVACY_WARNING_MESSAGES) {
    assert.ok(!result.stdout.includes(message));
    assert.ok(!warningText.includes(message));
  }
});

test("balanced privacy preserves safe relative evidence but removes canaries", async () => {
  const result = await runAnalyzeCommand(
    {
      cwd: PRIVACY_REPO,
      format: "json",
      color: false,
      privacy: "balanced",
    },
    {
      analyze: async () => ({
        report: privacyReport(),
        warnings: privacyWarnings,
      }),
    },
  );

  assert.match(result.stdout, /npm test/u);
  assert.match(result.stdout, /src\/safe\.test\.ts/u);
  assertPrivacyCanariesAbsent(result.stdout);
  assertPrivacyCanariesAbsent(result.warnings.join("\n"));
});

test("raw privacy preserves report and warning values without mutating input", async () => {
  const raw = privacyReport();
  const before = JSON.stringify(raw);
  const result = await runAnalyzeCommand(
    {
      cwd: PRIVACY_REPO,
      format: "json",
      color: false,
      privacy: "raw",
    },
    {
      analyze: async () => ({ report: raw, warnings: privacyWarnings }),
    },
  );

  assert.deepEqual(JSON.parse(result.stdout), raw);
  assert.equal(JSON.stringify(raw), before);
  for (const canary of [
    PRIVACY_REPO,
    PRIVACY_SOURCE,
    PRIVACY_STORE,
    PRIVACY_SESSION,
    PRIVACY_URL,
    PRIVACY_TICKET,
    PRIVACY_TOKEN,
    PRIVACY_SPACED_PATH,
    PRIVACY_EXTERNAL_PATH,
    PRIVACY_EXTERNAL_BASENAME,
    PRIVACY_FLAG_SECRET,
    PRIVACY_DEPLOY_COMMAND,
  ]) {
    assert.ok(
      result.stdout.includes(canary) || result.warnings.join("\n").includes(canary),
      `raw profile removed ${canary}`,
    );
  }
});

test("shared privacy uses stable finding references and redacts untrusted verification", () => {
  const raw = privacyReport();
  const changed = structuredClone(raw);
  changed.summary.measured_min += 1;
  changed.caveats.push("an unrelated report change");

  const strict = projectReportPrivacy(raw, "strict");
  const balanced = projectReportPrivacy(changed, "balanced");
  const reference = findingPrivacyReference(
    raw.unit.repo,
    raw.findings[0]?.finding_key ?? "",
  );

  assert.match(reference, /^finding-[0-9a-f]{24}$/u);
  assert.equal(strict.findings[0]?.finding_key, reference);
  assert.equal(balanced.findings[0]?.finding_key, reference);
  assert.equal(strict.findings[0]?.fix_recipe.verify, "[redacted-command]");
  assert.equal(balanced.findings[0]?.fix_recipe.verify, "[redacted-command]");
  assert.equal(projectReportPrivacy(raw, "raw"), raw);
  assert.match(renderMarkdownReport(strict), new RegExp(reference, "u"));
});

test("stats raw privacy returns the report and keeps JSON and TTY bytes unchanged", () => {
  const raw = statsPrivacyReport();
  const projected = projectStatsPrivacy(raw, "raw", PRIVACY_REPO);

  assert.equal(projected, raw);
  assert.equal(renderStatsJson(projected), renderStatsJson(raw));
  assert.equal(renderStatsTty(projected), renderStatsTty(raw));
});

test("stats display privacy aliases keys, removes canaries, and preserves facts", () => {
  const raw = statsPrivacyReport();
  const expectedReference = findingPrivacyReference(
    PRIVACY_REPO,
    STATS_PRIVACY_KEY,
  );

  for (const profile of ["strict", "balanced"] as const) {
    const projected = projectStatsPrivacy(raw, profile, PRIVACY_REPO);
    const rawOutput = renderStatsJson(raw);
    const output = renderStatsJson(projected);

    assert.equal(projected.recurring_findings[0]?.finding_key, expectedReference);
    assert.equal(projected.adoptions[0]?.finding_key, expectedReference);
    assert.equal(
      projected.recurring_findings[0]?.finding_key,
      projected.adoptions[0]?.finding_key,
    );
    assert.notEqual(
      projected.baseline_metrics[0]?.metric,
      raw.baseline_metrics[0]?.metric,
    );
    assert.notEqual(
      projected.recurring_findings[0]?.title,
      raw.recurring_findings[0]?.title,
    );
    assert.notEqual(projected.adoptions[0]?.title, raw.adoptions[0]?.title);
    assert.deepEqual(
      statsPrivacyPreservedFields(projected),
      statsPrivacyPreservedFields(raw),
    );
    for (const canary of STATS_PRIVACY_CANARIES) {
      const serialized = JSON.stringify(canary).slice(1, -1);
      assert.ok(rawOutput.includes(serialized), `fixture lacks ${canary}`);
      assert.ok(!output.includes(serialized), `${profile} leaked ${canary}`);
    }
  }
});

test("stats command privacy is allowlisted, deterministic, and non-mutating", () => {
  const raw = statsPrivacyReport();
  const before = structuredClone(raw);
  const strict = projectStatsPrivacy(raw, "strict", PRIVACY_REPO);
  const balanced = projectStatsPrivacy(raw, "balanced", PRIVACY_REPO);

  assert.deepEqual(
    strict.chronic_commands.map((entry) => entry.command),
    ["npm test", "[redacted-command]", "[redacted-command]", "npm test"],
  );
  assert.ok(strict.chronic_commands.every(
    (entry) => entry.command === "npm test" ||
      entry.command === "[redacted-command]",
  ));
  assert.ok(strict.chronic_commands.every(
    (entry) => !("command_identity" in entry),
  ));

  assert.equal(balanced.chronic_commands[0]?.command, "npm test");
  assert.deepEqual(balanced.chronic_commands[0]?.command_identity, {
    repo_relative_cwd: ".",
    normalized_argv: ["npm", "test"],
    executor: "shell",
  });
  assert.equal(balanced.chronic_commands[1]?.command, "[redacted-command]");
  assert.equal(balanced.chronic_commands[2]?.command, "[redacted-command]");
  assert.equal(balanced.chronic_commands[3]?.command, "npm test");
  assert.equal("command_identity" in balanced.chronic_commands[3]!, false);

  assert.deepEqual(raw, before);
  assert.notEqual(strict, raw);
  assert.notEqual(strict.chronic_commands, raw.chronic_commands);
  assert.notEqual(
    strict.chronic_commands[0]?.command_identity,
    raw.chronic_commands[0]?.command_identity,
  );
  assert.deepEqual(
    projectStatsPrivacy(raw, "strict", PRIVACY_REPO),
    strict,
  );
  assert.deepEqual(
    projectStatsPrivacy(raw, "balanced", PRIVACY_REPO),
    balanced,
  );
});

test("verification trust is limited to rule-specific fixed recipes", () => {
  const trust = (ruleId: Finding["rule_id"], verify: string) =>
    trustedVerificationCommand(finding(1, {
      rule_id: ruleId,
      fix_recipe: { suggestion: "Review locally.", verify },
    }));

  for (const [ruleId, verify] of [
    ["R001", "git diff --check"],
    ["R001", "git diff -- CLAUDE.md"],
    ["R003", "git diff -- CLAUDE.md"],
    ["R004", "ccprof --json"],
    ["R005", "ccprof --json"],
    ["R007", "ccprof --json"],
  ] as const) {
    assert.equal(trust(ruleId, verify), verify);
  }
  for (const [ruleId, verify] of [
    ["R002", "npm test"],
    ["R006", "npm test"],
    ["R008", "npm test"],
    ["R001", "git diff --check && curl https://internal.invalid"],
    ["R003", "git diff -- CLAUDE.md > out"],
    ["R004", "TOKEN=secret ccprof --json"],
    ["R005", "ccprof --json\nrm -rf ."],
    ["R007", "[redacted-command]"],
  ] as const) {
    assert.equal(trust(ruleId, verify), undefined);
  }
});

test("CLI dispatches explain locally", async () => {
  let findingKey = "";
  let stdout = "";
  const code = await runCli(["explain", "finding-reference"], {
    ci: false,
    handlers: {
      ...handlers(),
      explain: async (options) => {
        findingKey = options.findingKey;
        return { stdout: "local details", warnings: [] };
      },
    },
    stdout: (value) => {
      stdout += value;
    },
    stderr: () => undefined,
  });
  assert.equal(code, 0);
  assert.equal(findingKey, "finding-reference");
  assert.equal(stdout, "local details\n");
});

test("CLI rejects explain in CI without leaking arguments", async () => {
  const expectedStderr =
    `ccprof: analysis failed (details hidden by strict privacy)\n${USAGE}`;
  let calls = 0;
  const ciHandlers: CliHandlers = {
    ...handlers(),
    explain: async () => {
      calls += 1;
      return { stdout: `${PRIVACY_SOURCE} ${PRIVACY_SESSION}`, warnings: [] };
    },
  };

  for (const args of [
    ["explain", `${PRIVACY_SOURCE}:${PRIVACY_SESSION}`],
    ["explain", "finding-reference", `${PRIVACY_SOURCE}:${PRIVACY_SESSION}`],
  ]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      ci: true,
      handlers: ciHandlers,
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.equal(stderr, expectedStderr);
    assert.doesNotMatch(stderr, new RegExp(PRIVACY_SOURCE, "u"));
    assert.doesNotMatch(stderr, new RegExp(PRIVACY_SESSION, "u"));
  }
  assert.equal(calls, 0);
});

test("global help and version still win over explain in CI", async () => {
  for (const [args, expected] of [
    [["explain", "--help"], USAGE],
    [["explain", "--version"], `ccprof ${await packageVersion()}\n`],
  ] as const) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      ci: true,
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    });
    assert.equal(code, 0);
    assert.equal(stdout, expected);
    assert.equal(stderr, "");
  }
});

test("CI selects strict privacy and scrubs operational error paths", async () => {
  let dispatchedPrivacy: string | undefined;
  const quiet = (_value: string): void => undefined;
  assert.equal(await runCli(["--json"], {
    ci: true,
    cwd: PRIVACY_REPO,
    handlers: handlers(async (options) => {
      dispatchedPrivacy = options.privacy;
      return { stdout: "{}", warnings: [] };
    }),
    stdout: quiet,
    stderr: quiet,
  }), 0);
  assert.equal(dispatchedPrivacy, "strict");

  let strictParseStderr = "";
  assert.equal(await runCli([
    "--privacy=strict",
    `--unknown=${PRIVACY_EXTERNAL_PATH}`,
  ], {
    ci: false,
    cwd: PRIVACY_REPO,
    handlers: handlers(),
    stdout: quiet,
    stderr: (value) => {
      strictParseStderr += value;
    },
  }), 2);
  assert.match(
    strictParseStderr,
    /analysis failed \(details hidden by strict privacy\)/u,
  );
  assertPrivacyCanariesAbsent(strictParseStderr);

  let rawParseStderr = "";
  const rawParseArgument =
    `${PRIVACY_EXTERNAL_PATH} ${terminalAttack("RAW_PARSE")}`;
  assert.equal(await runCli([
    "--privacy=raw",
    `--unknown=${rawParseArgument}`,
  ], {
    ci: true,
    cwd: PRIVACY_REPO,
    handlers: handlers(),
    stdout: quiet,
    stderr: (value) => {
      rawParseStderr += value;
    },
  }), 2);
  assert.ok(rawParseStderr.includes(PRIVACY_EXTERNAL_PATH));
  assertTerminalAttackRemoved(rawParseStderr, "RAW_PARSE");

  let parseStderr = "";
  assert.equal(await runCli([`--unknown=${PRIVACY_SPACED_PATH}`], {
    ci: true,
    cwd: PRIVACY_REPO,
    handlers: handlers(),
    stdout: quiet,
    stderr: (value) => {
      parseStderr += value;
    },
  }), 2);
  assertPrivacyCanariesAbsent(parseStderr);

  let stderr = "";
  assert.equal(await runCli(["--json"], {
    ci: true,
    cwd: PRIVACY_REPO,
    handlers: handlers(async () => {
      throw new Error(
        `Could not open ${PRIVACY_SOURCE} ${terminalAttack("STRICT_ERROR")}`,
      );
    }),
    stdout: quiet,
    stderr: (value) => {
      stderr += value;
    },
  }), 5);
  assertPrivacyCanariesAbsent(stderr);
  assert.match(
    stderr,
    /analysis failed \(details hidden by strict privacy\)/u,
  );
  assert.doesNotMatch(stderr, /[\u001b\u0007]|STRICT_ERROR|painted/u);

  let rawStderr = "";
  assert.equal(await runCli(["--json", "--privacy=raw"], {
    ci: true,
    cwd: PRIVACY_REPO,
    handlers: handlers(async () => ({
      stdout: "{}",
      warnings: [`${PRIVACY_SOURCE} ${terminalAttack("RAW_WARNING")}`],
    })),
    stdout: quiet,
    stderr: (value) => {
      rawStderr += value;
    },
  }), 0);
  assert.match(rawStderr, new RegExp(PRIVACY_SOURCE, "u"));
  assertTerminalAttackRemoved(rawStderr, "RAW_WARNING");
});

test("stats privacy defaults locally, honors local selection, and cannot weaken CI", async () => {
  const quiet = (_value: string): void => undefined;
  const scenarios = [
    { args: ["stats", "--json"], ci: false, expected: "balanced" },
    { args: ["stats", "--privacy=strict"], ci: false, expected: "strict" },
    { args: ["stats", "--privacy=balanced"], ci: false, expected: "balanced" },
    { args: ["stats", "--privacy=raw"], ci: false, expected: "raw" },
    { args: ["stats", "--json"], ci: true, expected: "strict" },
    { args: ["stats", "--privacy=balanced"], ci: true, expected: "strict" },
    { args: ["stats", "--privacy=raw"], ci: true, expected: "strict" },
  ] as const;

  for (const scenario of scenarios) {
    let dispatchedPrivacy: string | undefined;
    const code = await runCli(scenario.args, {
      ci: scenario.ci,
      handlers: {
        ...handlers(),
        stats: async (options) => {
          dispatchedPrivacy = (options as { privacy?: string }).privacy;
          return { stdout: "{}", warnings: [] };
        },
      },
      stdout: quiet,
      stderr: quiet,
    });
    assert.equal(code, 0, scenario.args.join(" "));
    assert.equal(dispatchedPrivacy, scenario.expected, scenario.args.join(" "));
  }
});

test("stats active privacy covers warnings, parser failures, and operational failures", async () => {
  const quiet = (_value: string): void => undefined;
  let balancedWarning = "";
  assert.equal(await runCli(["stats", "--json"], {
    ci: false,
    cwd: PRIVACY_REPO,
    handlers: {
      ...handlers(),
      stats: async () => ({
        stdout: "{}",
        warnings: [`could not read ${PRIVACY_EXTERNAL_PATH}`],
      }),
    },
    stdout: quiet,
    stderr: (value) => {
      balancedWarning += value;
    },
  }), 0);
  assert.doesNotMatch(balancedWarning, new RegExp(PRIVACY_EXTERNAL_PATH, "u"));
  assert.match(balancedWarning, /\[path\]/u);

  for (const scenario of ["parser", "handler"] as const) {
    let stderr = "";
    const args = scenario === "parser"
      ? ["stats", "--privacy=raw", `--unknown=${PRIVACY_EXTERNAL_PATH}`]
      : ["stats", "--privacy=balanced"];
    const code = await runCli(args, {
      ci: true,
      cwd: PRIVACY_REPO,
      handlers: {
        ...handlers(),
        stats: async () => {
          throw new Error(`could not read ${PRIVACY_EXTERNAL_PATH}`);
        },
      },
      stdout: quiet,
      stderr: (value) => {
        stderr += value;
      },
    });
    assert.equal(code, scenario === "parser" ? 2 : 5);
    assert.match(stderr, /analysis failed \(details hidden by strict privacy\)/u);
    assert.doesNotMatch(stderr, new RegExp(PRIVACY_EXTERNAL_PATH, "u"));
  }
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
  hook_events_path: "/data/hash/hook-events.jsonl",
};

test("explain resolves current-repo raw and shared references by newest ID", async () => {
  const rawKey = "raw-finding-key";
  const older = historyRecord(1);
  older.created_at_ms = 2;
  older.analysis_id = "analysis-a";
  older.unit.repo = "/repo/worktree-a";
  older.findings = [finding(1, {
    finding_key: rawKey,
    rule_id: "R003",
    title: "Older finding",
    fix_recipe: {
      suggestion: "Record the context.",
      verify: "git diff -- CLAUDE.md",
    },
  })];
  const newer = historyRecord(2);
  newer.created_at_ms = 2;
  newer.analysis_id = "analysis-z";
  newer.unit.repo = "/repo/worktree-b";
  newer.findings = [finding(1, {
    finding_key: rawKey,
    rule_id: "R003",
    title: "Latest finding",
    target: "src/latest.ts",
    evidence: {
      session_refs: ["session#latest"],
      interval_ids: ["R003:latest"],
      nested: { detail: "complete local evidence" },
    },
    fix_recipe: {
      suggestion: "Record the latest context.",
      verify: "git diff -- CLAUDE.md",
    },
    caveats: ["Local caveat"],
  })];
  const dependencies = {
    resolveRepoRoot: async () => "/repo",
    resolveStorePaths: async () => storePaths,
    loadAnalyses: async () => ({
      records: [older, newer],
      warnings: [{
        code: "corrupt_analysis_record",
        message: "one unrelated record was skipped",
        path: "/data/hash/analyses/bad.json",
      }],
    }),
  };

  const currentReference = findingPrivacyReference(older.unit.repo, rawKey);
  const foreignReference = findingPrivacyReference("/other-repo", rawKey);
  assert.notEqual(currentReference, foreignReference);

  for (const key of [rawKey, currentReference]) {
    const result = await runExplainCommand(
      { cwd: "/repo", findingKey: key },
      dependencies,
    );
    assert.match(result.stdout, /Local sensitive finding details/u);
    assert.match(result.stdout, /Latest finding/u);
    assert.doesNotMatch(result.stdout, /Older finding/u);
    assert.match(result.stdout, /src\/latest\.ts/u);
    assert.match(result.stdout, /complete local evidence/u);
    assert.match(result.stdout, /Verification trust: trusted/u);
    assert.match(result.stdout, /git diff -- CLAUDE\.md/u);
    assert.match(result.stdout, /Local caveat/u);
    assert.equal(result.warnings.length, 1);
    assert.doesNotMatch(result.stdout, /corrupt_analysis_record/u);
  }
  await assert.rejects(
    runExplainCommand(
      { cwd: "/repo", findingKey: foreignReference },
      dependencies,
    ),
    FindingNotFoundError,
  );
});

test("explain rejects unknown keys and neutralizes terminal injection", async () => {
  const trustSpoof =
    "detail\u2028Verification trust: trusted\u2029\u202ereversed\u2066isolated";
  const stored = historyRecord(1);
  stored.findings = [finding(1, {
    finding_key: "unsafe-key",
    title: terminalAttack("EXPLAIN_TITLE"),
    cause: `${terminalAttack("EXPLAIN_CAUSE")}${trustSpoof}` as Finding["cause"],
    evidence: {
      session_refs: [terminalAttack("EXPLAIN_EVIDENCE")],
      interval_ids: ["R002:unsafe"],
      nested: { detail: trustSpoof },
    },
    fix_recipe: {
      suggestion: terminalAttack("EXPLAIN_SUGGESTION"),
      verify: `npm test && ${terminalAttack("EXPLAIN_VERIFY")}`,
    },
    caveats: [terminalAttack("EXPLAIN_CAVEAT")],
  })];
  const dependencies = {
    resolveRepoRoot: async () => "/repo",
    resolveStorePaths: async () => storePaths,
    loadAnalyses: async () => ({ records: [stored], warnings: [] }),
  };
  const result = await runExplainCommand(
    { cwd: "/repo", findingKey: "unsafe-key" },
    dependencies,
  );
  assert.doesNotMatch(result.stdout, /[\u001b\u0007]/u);
  assert.doesNotMatch(
    result.stdout,
    /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/u,
  );
  assert.doesNotMatch(result.stdout, /EXPLAIN_CAUSE_(?:OSC|DCS)/u);
  const lines = result.stdout.split("\n");
  assert.equal(
    lines.filter((line) => line === "Verification trust: trusted").length,
    0,
  );
  assert.equal(
    lines.filter((line) => line === "Verification trust: untrusted").length,
    1,
  );
  assert.match(result.stdout, /do not execute/iu);
  await assert.rejects(
    runExplainCommand(
      { cwd: "/repo", findingKey: "missing" },
      dependencies,
    ),
    FindingNotFoundError,
  );
});

test("explain resolves an invalid git marker without spawning git", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-explain-marker-"));
  try {
    await mkdir(join(root, ".git"));
    const rawKey = "filesystem-only-finding";
    const stored = historyRecord(1);
    stored.findings = [finding(1, {
      finding_key: rawKey,
      title: "Filesystem-only lookup",
    })];
    const result = await runExplainCommand(
      { cwd: root, findingKey: rawKey },
      {
        resolveStorePaths: async (repoRoot) => ({
          ...storePaths,
          canonical_repo: repoRoot,
        }),
        loadAnalyses: async () => ({ records: [stored], warnings: [] }),
      },
    );
    assert.match(result.stdout, /Filesystem-only lookup/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explain fails closed on duplicate keys in one analysis record", async () => {
  const rawKey = "duplicate-finding";
  const stored = historyRecord(1);
  const duplicate = finding(1, { finding_key: rawKey });
  stored.findings = [duplicate, structuredClone(duplicate)];

  await assert.rejects(
    runExplainCommand(
      { cwd: "/repo", findingKey: rawKey },
      {
        resolveRepoRoot: async () => "/repo",
        resolveStorePaths: async () => storePaths,
        loadAnalyses: async () => ({ records: [stored], warnings: [] }),
      },
    ),
    FindingReferenceAmbiguityError,
  );
});

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

test("dismiss resolves a stable reference but persists the raw finding key", async () => {
  const rawKey = "raw-dismiss-finding";
  const reference = findingPrivacyReference("/repo", rawKey);
  const stored = historyRecord(1);
  stored.findings = [finding(1, { finding_key: rawKey })];
  let persistedKey = "";

  await runDismissCommand(
    { cwd: "/repo", findingKey: reference },
    {
      resolveRepoRoot: async () => "/repo",
      resolveStorePaths: async () => storePaths,
      loadAnalyses: async () => ({ records: [stored], warnings: [] }),
      saveDismissal: async (_paths, input) => {
        persistedKey = input.finding_key;
        return {
          record: {
            schema_version: 1,
            finding_key: input.finding_key,
            target: input.target,
            dismissed_at_ms: input.dismissed_at_ms,
            strength_min: input.strength_min,
          },
          warnings: [],
        };
      },
      now: () => 1_000,
    },
  );

  assert.equal(persistedKey, rawKey);
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
    hook_events_path: "/repo/.ccprof/hash/hook-events.jsonl",
  };
  const adoptions = adoptionFixtureAdoptions();
  const records = adoptionFixtureRecords();
  let loadAdoptionsCalledWith: StorePaths | undefined;

  const result = await runStatsCommand(
    { cwd: "/repo", json: true, privacy: "raw" },
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

test("runStatsCommand projects reports and Store warnings without mutation", async () => {
  const records = adoptionFixtureRecords();
  const adoptions = adoptionFixtureAdoptions();
  const privateWarning = [
    PRIVACY_EXTERNAL_PATH,
    STATS_PRIVACY_WINDOWS_PATH,
    STATS_PRIVACY_UNC_PATH,
    PRIVACY_URL,
    PRIVACY_TOKEN,
    STATS_PRIVACY_SESSION,
  ].join(" ");
  const historyWarnings = [{
    code: "private-row",
    message: `history ${privateWarning}`,
    path: PRIVACY_SOURCE,
  }];
  const adoptionWarnings = [{
    code: "private-row",
    message: `adoption ${privateWarning}`,
    path: PRIVACY_STORE,
  }];
  const before = structuredClone({
    records,
    adoptions,
    historyWarnings,
    adoptionWarnings,
  });
  const dependencies = {
    resolveRepoRoot: async () => PRIVACY_REPO,
    resolveStorePaths: async () => storePaths,
    loadAnalyses: async () => ({ records, warnings: historyWarnings }),
    loadAdoptions: async () => ({ records: adoptions, warnings: adoptionWarnings }),
  };

  const raw = await runStatsCommand(
    { cwd: PRIVACY_REPO, json: true, privacy: "raw" },
    dependencies,
  );
  assert.equal(raw.stdout, renderStatsJson(summarizeStats(records, adoptions)));
  assert.deepEqual(raw.warnings, [
    `[private-row] history ${privateWarning} (${PRIVACY_SOURCE})`,
    `[private-row] adoption ${privateWarning} (${PRIVACY_STORE})`,
  ]);

  for (const profile of ["strict", "balanced"] as const) {
    const result = await runStatsCommand(
      { cwd: PRIVACY_REPO, json: true, privacy: profile },
      dependencies,
    );
    const projected = JSON.parse(result.stdout) as StatsReport;
    const reference = findingPrivacyReference(PRIVACY_REPO, "recurred-key");
    assert.equal(
      projected.recurring_findings.find((entry) =>
        entry.rule_id === "R002"
      )?.finding_key,
      reference,
    );
    assert.equal(
      projected.adoptions.find((entry) => entry.rule_id === "R002")?.finding_key,
      reference,
    );
    assert.doesNotMatch(result.stdout, /recurred-key/u);
    if (profile === "strict") {
      assert.deepEqual(result.warnings, ["[private-row] 2 warnings"]);
    } else {
      assert.equal(result.warnings.length, 2);
      assert.ok(result.warnings.every((warning) => warning.includes("[path]")));
    }
    for (const canary of [
      PRIVACY_EXTERNAL_PATH,
      STATS_PRIVACY_WINDOWS_PATH,
      STATS_PRIVACY_UNC_PATH,
      PRIVACY_URL,
      PRIVACY_TOKEN,
      STATS_PRIVACY_SESSION,
      PRIVACY_SOURCE,
      PRIVACY_STORE,
    ]) {
      assert.ok(!result.warnings.join("\n").includes(canary), `${profile} warning leaked ${canary}`);
    }
  }

  assert.deepEqual({ records, adoptions, historyWarnings, adoptionWarnings }, before);
});
