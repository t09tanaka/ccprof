import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  analyze,
  NoAnalyzableTimestampsError,
} from "../src/core/analyze.js";
import type { Session } from "../src/core/model.js";
import { parseExplicitTestMap } from "../src/analysis/test-map.js";
import { runCommand } from "../src/git/client.js";
import { ClaudeSessionSource } from "../src/sources/claude/discover.js";
import {
  loadAnalyses,
  saveAnalysis,
} from "../src/store/analyses.js";
import { saveDismissal } from "../src/store/dismissals.js";
import { resolveStorePaths } from "../src/store/paths.js";

const NOW_MS = Date.parse("2026-01-01T01:00:00.000Z");
const FEATURE_COMMIT_DATE = "2026-01-01T00:00:00.000Z";

async function git(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const result = await runCommand("git", args, {
    cwd,
    env,
    timeoutMs: 10_000,
  });
  assert.equal(
    result.code,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function makeRepository(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "ccprof test"]);
  await git(repo, ["config", "user.email", "ccprof@example.invalid"]);
  await write(
    join(repo, "package.json"),
    `${JSON.stringify({
      private: true,
      scripts: { test: "node --test" },
    }, null, 2)}\n`,
  );
  await write(join(repo, "src/value.ts"), "export const value = 1;\n");
  await git(repo, ["add", "package.json", "src/value.ts"]);
  await git(repo, ["commit", "-m", "base"], {
    GIT_AUTHOR_DATE: "2025-12-31T23:00:00.000Z",
    GIT_COMMITTER_DATE: "2025-12-31T23:00:00.000Z",
  });
  await git(repo, ["switch", "-c", "feature"]);
  await write(join(repo, "src/value.ts"), "export const value = 2;\n");
  await git(repo, ["add", "src/value.ts"]);
  await git(repo, ["commit", "-m", "feature"], {
    GIT_AUTHOR_DATE: FEATURE_COMMIT_DATE,
    GIT_COMMITTER_DATE: FEATURE_COMMIT_DATE,
  });
  return repo;
}

async function makeClaudeProjects(
  root: string,
  repo: string,
): Promise<string> {
  const projects = join(root, "claude-projects");
  const fixturePath = join(
    process.cwd(),
    "test/fixtures/e2e/session.jsonl",
  );
  const fixture = await readFile(fixturePath, "utf8");
  const escapedRepo = JSON.stringify(repo).slice(1, -1);
  const editRows = [
    {
      type: "assistant",
      sessionId: "e2e-session",
      uuid: "a5-unrelated-edit",
      timestamp: "2026-01-01T00:02:42.000Z",
      cwd: repo,
      gitBranch: "feature",
      message: {
        id: "m5-unrelated-edit",
        content: [{
          type: "tool_use",
          id: "edit-unrelated",
          name: "Edit",
          input: {
            file_path: "docs/readme.md",
            old_string: "",
            new_string: "temporary unrelated documentation note",
          },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
    {
      type: "user",
      sessionId: "e2e-session",
      uuid: "r5-unrelated-edit",
      timestamp: "2026-01-01T00:02:48.000Z",
      cwd: repo,
      gitBranch: "feature",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "edit-unrelated",
          content: "updated",
          is_error: false,
        }],
      },
    },
  ].map((row) => JSON.stringify(row));
  const rendered = fixture
    .replaceAll("__REPO_ROOT__", escapedRepo)
    .replace("__LARGE_OUTPUT__", "x".repeat(200_004))
    .split("\n")
    .flatMap((line) =>
      line.includes('"uuid":"a6"') ? [...editRows, line] : [line]
    )
    .join("\n");
  await write(join(projects, "fixture", "e2e-session.jsonl"), rendered);
  return projects;
}

function seedSummary() {
  return {
    measured_min: 10,
    idle_excluded_min: 0,
    estimated_floor_min: 9,
    recoverable_min: 1,
    human_wait_min: 0,
    unexplained_min: 1,
    baseline: null,
  } as const;
}

test("orchestrates a deterministic PR analysis, stores all findings, and applies dismissal only to display", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-analyze-"));
  try {
    const repo = await makeRepository(root);
    const projects = await makeClaudeProjects(root, repo);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    for (let index = 0; index < 3; index += 1) {
      await saveAnalysis(storePaths, {
        analysis_id: `history-${index}`,
        created_at_ms: NOW_MS - ((index + 1) * 1_000),
        unit: {
          repo,
          pr_ref: `main...history-${index}`,
          sessions: [`history-${index}`],
        },
        summary: seedSummary(),
        findings: [],
        metrics: { human_wait_ratio: 0.1 + (index * 0.1) },
        command_costs: [],
      });
    }

    const options = {
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
    } as const;
    const first = await analyze(options);
    const second = await analyze(options);

    assert.deepEqual(second.report, first.report);
    assert.deepEqual(second.allFindings, first.allFindings);
    assert.deepEqual(first.report.unit.sessions, ["e2e-session"]);
    assert.equal(first.report.summary.baseline?.prs, 3);
    assert.ok(
      first.warnings.some(({ code }) => code === "invalid_json"),
      "source warnings must survive orchestration",
    );

    const expectedRules = ["R001", "R002", "R003", "R004", "R007", "R008"];
    assert.deepEqual(
      [...new Set(first.allFindings.map(({ rule_id }) => rule_id))].sort(),
      expectedRules,
    );
    assert.equal(
      first.allFindings.find(({ rule_id }) => rule_id === "R007")
        ?.recoverable.bound,
      "upper",
    );
    assert.ok(
      Number(
        first.allFindings.find(({ rule_id }) => rule_id === "R007")
          ?.evidence.max_estimated_tokens,
      ) > 50_000,
    );
    const flaky = first.allFindings.find(({ rule_id }) => rule_id === "R008");
    assert.equal(flaky?.confidence, "medium");
    assert.equal(flaky?.evidence.unrelated_edit_count, 1);
    assert.deepEqual(flaky?.evidence.unrelated_edit_paths, [
      "docs/readme.md",
    ]);

    const expectedTop = [...first.allFindings]
      .filter(({ recoverable }) => recoverable.min > 0)
      .sort(
        (left, right) =>
          right.recoverable.min - left.recoverable.min ||
          left.rule_id.localeCompare(right.rule_id) ||
          left.finding_key.localeCompare(right.finding_key),
      )
      .slice(0, 3)
      .map(({ finding_key }) => finding_key);
    assert.deepEqual(
      first.report.findings.map(({ finding_key }) => finding_key),
      expectedTop,
    );

    assert.equal(
      first.report.summary.measured_min,
      first.ledger.normal_min +
        first.report.summary.recoverable_min +
        first.report.summary.human_wait_min +
        first.report.summary.unexplained_min,
    );
    assert.equal(
      first.ledger.raw_observed_min,
      first.report.summary.measured_min +
        first.report.summary.idle_excluded_min,
    );
    assert.equal(
      first.report.summary.estimated_floor_min,
      first.report.summary.measured_min -
        first.report.summary.recoverable_min,
    );

    const stored = await loadAnalyses(storePaths);
    const current = stored.records.find(
      ({ unit }) => unit.pr_ref === "main...feature",
    );
    assert.ok(current);
    assert.equal(
      stored.records.filter(({ unit }) => unit.pr_ref === "main...feature")
        .length,
      1,
      "a deterministic rerun must reuse the immutable record",
    );
    assert.deepEqual(
      current.findings.map(({ finding_key }) => finding_key),
      first.allFindings.map(({ finding_key }) => finding_key),
    );
    assert.equal(current.summary.baseline?.prs, 3);
    assert.equal(
      current.command_costs.find(({ command }) => command === "npm test")
        ?.duration_min,
      1,
      "overlapping runs of the same normalized command use wall-clock union",
    );

    const approval = first.allFindings.find(
      ({ rule_id }) => rule_id === "R004",
    );
    assert.ok(approval);
    await saveDismissal(storePaths, {
      finding_key: approval.finding_key,
      target: "approval-wait",
      dismissed_at_ms: NOW_MS - 1,
      strength_min: approval.recoverable.min,
      reason: "accepted for this workflow",
    });
    const dismissed = await analyze(options);
    assert.ok(
      dismissed.allFindings.some(
        ({ finding_key }) => finding_key === approval.finding_key,
      ),
      "dismissed findings remain in the complete stored population",
    );
    assert.ok(
      dismissed.report.findings.every(
        ({ finding_key }) => finding_key !== approval.finding_key,
      ),
      "dismissal filters only the displayed top findings",
    );
    assert.ok(dismissed.suppressedKeys.includes(approval.finding_key));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a matched session with only one valid timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-single-timestamp-"));
  try {
    const repo = await makeRepository(root);
    const projects = join(root, "claude-projects");
    await write(
      join(projects, "fixture", "single-timestamp.jsonl"),
      `${JSON.stringify({
        type: "user",
        sessionId: "single-timestamp",
        uuid: "only-event",
        timestamp: "2026-01-01T00:00:30.000Z",
        cwd: repo,
        gitBranch: "feature",
        message: {
          content: "This session has no measurable interval.",
        },
      })}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    await assert.rejects(
      analyze({
        cwd: repo,
        pr: "main...feature",
        nowMs: NOW_MS,
        sessionSource: new ClaudeSessionSource(projects),
        storePaths,
      }),
      NoAnalyzableTimestampsError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R008 excludes manifest build/check commands but keeps explicit custom tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-flaky-command-family-"));
  try {
    const repo = await makeRepository(root);
    await write(
      join(repo, "package.json"),
      `${JSON.stringify({
        private: true,
        scripts: {
          test: "node --test",
          build: "tsc",
          check: "tsc --noEmit",
        },
      }, null, 2)}\n`,
    );
    const projects = join(root, "claude-projects");
    const commands = [
      "npm run build",
      "npm run check",
      "make test",
      "make test && touch generated.txt",
    ];
    const rows: object[] = [{
      type: "user",
      sessionId: "command-families",
      uuid: "request",
      timestamp: "2026-01-01T00:00:05.000Z",
      cwd: repo,
      gitBranch: "feature",
      message: { content: "Validate the change." },
    }];
    let seconds = 10;
    const timestamp = (): string =>
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1_000)
        .toISOString();
    for (const [index, command] of commands.entries()) {
      for (const outcome of ["fail", "pass"] as const) {
        const toolUseId = `${outcome}-${index}`;
        rows.push({
          type: "assistant",
          sessionId: "command-families",
          uuid: `assistant-${toolUseId}`,
          timestamp: timestamp(),
          cwd: repo,
          gitBranch: "feature",
          message: {
            id: `message-${toolUseId}`,
            content: [{
              type: "tool_use",
              id: toolUseId,
              name: "Bash",
              input: { command },
            }],
          },
        });
        seconds += 5;
        rows.push({
          type: "user",
          sessionId: "command-families",
          uuid: `result-${toolUseId}`,
          timestamp: timestamp(),
          cwd: repo,
          gitBranch: "feature",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: toolUseId,
              content: outcome === "fail" ? "1 failed" : "1 passed",
              is_error: outcome === "fail",
            }],
          },
        });
      }
    }
    await write(
      join(projects, "fixture", "command-families.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const explicitTestMap = parseExplicitTestMap({
      mappings: [{
        source: ["src/**"],
        tests: ["test/**"],
        commands: ["make test"],
      }],
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
      testMap: {
        ...explicitTestMap,
        mappings: [
          ...explicitTestMap.mappings,
          {
            confidence: "high",
            origin: "explicit",
            caveat: "Unvalidated typed API input used by this regression.",
            source: ["src/**"],
            tests: ["test/**"],
            commands: ["make test && touch generated.txt"],
          },
        ],
      },
    });

    assert.deepEqual(
      result.allFindings
        .filter(({ rule_id }) => rule_id === "R008")
        .flatMap(({ evidence }) =>
          typeof evidence.command === "string" ? [evidence.command] : []
        )
        .sort(),
      ["make test"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function coordinationSession(
  sessionId: string,
  repo: string,
  toolName: string,
): Session {
  const shared = {
    session_id: sessionId,
    agent_id: "main",
    is_sidechain: false,
    confidence: "high" as const,
  };
  const t0 = NOW_MS - 600_000;
  return {
    session_id: sessionId,
    source: "claude",
    source_path: join(repo, `${sessionId}.jsonl`),
    observed_cwds: [repo],
    observed_branches: ["feature"],
    started_at_ms: t0,
    ended_at_ms: t0 + 180_000,
    confidence: "high",
    warnings: [],
    events: [
      {
        ...shared,
        kind: "tool_use",
        timestamp_ms: t0,
        entry_uuid: "read-use",
        session_ref: `${sessionId}#read-use`,
        source_index: 0,
        tool_use_id: "read-1",
        tool_name: "Read",
        input: {},
        paths: ["src/value.ts"],
        edit_fragments: [],
        cwd: repo,
      },
      {
        ...shared,
        kind: "tool_result",
        timestamp_ms: t0 + 60_000,
        entry_uuid: "read-result",
        session_ref: `${sessionId}#read-result`,
        source_index: 1,
        tool_use_id: "read-1",
        status: "success",
        output: "export const value = 2;",
        output_bytes: 24,
        estimated_tokens: 6,
      },
      {
        ...shared,
        kind: "tool_use",
        timestamp_ms: t0 + 120_000,
        entry_uuid: "tool-use",
        session_ref: `${sessionId}#tool-use`,
        source_index: 2,
        tool_use_id: "coord-1",
        tool_name: toolName,
        input: {},
        paths: [],
        edit_fragments: [],
        ...(toolName === "Bash" ? { command: "git status" } : {}),
      },
      {
        ...shared,
        kind: "tool_result",
        timestamp_ms: t0 + 180_000,
        entry_uuid: "tool-result",
        session_ref: `${sessionId}#tool-result`,
        source_index: 3,
        tool_use_id: "coord-1",
        status: "success",
        output: "ok",
        output_bytes: 2,
        estimated_tokens: 1,
      },
    ],
  };
}

test("coordination tools count as normal time while delegation still invalidates frozen-head reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-coordination-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const analyzeWith = async (toolName: string, sessionId: string) =>
      await analyze({
        cwd: repo,
        pr: "main...feature",
        nowMs: NOW_MS,
        storePaths,
        sessionSource: {
          discover: async () => [
            coordinationSession(sessionId, repo, toolName),
          ],
        },
      });

    const todo = await analyzeWith("TodoWrite", "todo-session");
    assert.equal(todo.ledger.totals_ms.measured, 180_000);
    assert.equal(todo.ledger.totals_ms.normal, 120_000);
    assert.equal(todo.ledger.totals_ms.unexplained, 60_000);
    assert.equal(todo.record.read_observations?.length, 1);
    assert.equal(todo.record.read_observations?.[0]?.path, "src/value.ts");

    const agent = await analyzeWith("Agent", "agent-session");
    assert.equal(agent.ledger.totals_ms.normal, 120_000);
    assert.deepEqual(agent.record.read_observations, []);

    const unknown = await analyzeWith("mcp__custom__tool", "mcp-session");
    assert.equal(unknown.ledger.totals_ms.normal, 60_000);
    assert.equal(unknown.ledger.totals_ms.unexplained, 120_000);

    const vcs = await analyzeWith("Bash", "vcs-session");
    assert.equal(vcs.ledger.totals_ms.normal, 120_000);
    assert.deepEqual(vcs.record.read_observations, []);
    assert.deepEqual(
      vcs.record.command_costs.map(({ command, duration_min }) => ({
        command,
        duration_min,
      })),
      [{ command: "git status", duration_min: 1 }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function humanWaitSession(sessionId: string, repo: string): Session {
  const shared = {
    session_id: sessionId,
    agent_id: "main",
    is_sidechain: false,
    confidence: "high" as const,
  };
  const t0 = NOW_MS - 600_000;
  const at = (
    kind: "genuine_user" | "assistant",
    entryUuid: string,
    offsetMs: number,
    sourceIndex: number,
    text: string,
  ) => ({
    ...shared,
    kind,
    timestamp_ms: t0 + offsetMs,
    entry_uuid: entryUuid,
    session_ref: `${sessionId}#${entryUuid}`,
    source_index: sourceIndex,
    text,
  });
  return {
    session_id: sessionId,
    source: "claude",
    source_path: join(repo, `${sessionId}.jsonl`),
    observed_cwds: [repo],
    observed_branches: ["feature"],
    started_at_ms: t0,
    ended_at_ms: t0 + 160_000,
    confidence: "high",
    warnings: [],
    events: [
      at("genuine_user", "u0", 0, 0, "Start the task."),
      at("assistant", "a1", 10_000, 1, "Which option should I take?"),
      at("genuine_user", "u1", 70_000, 2, "Take the first option."),
      at("assistant", "a2", 80_000, 3, "Asking a follow-up."),
      {
        ...shared,
        kind: "tool_use",
        timestamp_ms: t0 + 90_000,
        entry_uuid: "ask-use",
        session_ref: `${sessionId}#ask-use`,
        source_index: 4,
        tool_use_id: "ask-1",
        tool_name: "AskUserQuestion",
        input: {},
        paths: [],
        edit_fragments: [],
      },
      {
        ...shared,
        kind: "tool_result",
        timestamp_ms: t0 + 150_000,
        entry_uuid: "ask-result",
        session_ref: `${sessionId}#ask-result`,
        source_index: 5,
        tool_use_id: "ask-1",
        status: "success",
        output: "answered",
        output_bytes: 8,
        estimated_tokens: 2,
      },
      at("assistant", "a3", 160_000, 6, "Continuing with the answer."),
    ],
  };
}

test("turn waits and AskUserQuestion waits land in human_wait_min instead of unexplained", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-human-wait-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: {
        discover: async () => [humanWaitSession("wait-session", repo)],
      },
    });

    assert.equal(result.ledger.totals_ms.measured, 160_000);
    assert.equal(result.ledger.totals_ms.human_wait, 120_000);
    assert.equal(result.report.summary.human_wait_min, 2);
    assert.equal(result.report.summary.unexplained_min, 0.67);
    assert.equal(result.ledger.totals_ms.normal, 0);
    assert.equal(
      result.report.summary.measured_min,
      result.ledger.normal_min +
        result.report.summary.recoverable_min +
        result.report.summary.human_wait_min +
        result.report.summary.unexplained_min,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
