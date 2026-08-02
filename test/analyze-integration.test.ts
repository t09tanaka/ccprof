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
  NoMatchingSessionsError,
} from "../src/core/analyze.js";
import type { Session } from "../src/core/model.js";
import { parseExplicitTestMap } from "../src/analysis/test-map.js";
import { runCommand } from "../src/git/client.js";
import {
  ClaudeDiscoveryError,
  ClaudeSessionSource,
} from "../src/sources/claude/discover.js";
import {
  loadAnalyses,
  saveAnalysis,
} from "../src/store/analyses.js";
import { loadAdoptions } from "../src/store/adoptions.js";
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

/** A Claude projects directory whose only transcript is malformed, so
 * `discoverClaudeSessions` finds zero sessions and throws
 * `ClaudeDiscoveryError` - used to exercise `defaultSessionSource`'s
 * per-source error surfacing without injecting a `sessionSource`. */
async function makeMalformedClaudeProjects(root: string): Promise<string> {
  const projects = join(root, "claude-projects-malformed");
  await write(join(projects, "malformed.jsonl"), "{malformed\n");
  return projects;
}

/** A Codex sessions directory with one valid rollout inside the repo, on
 * `branch`, with two distinct event timestamps (a single-timestamp session
 * cannot form an analyzable interval). */
async function makeCodexSessions(
  root: string,
  repo: string,
  branch: string,
): Promise<string> {
  const sessionsDir = join(root, "codex-sessions");
  const dayDir = join(sessionsDir, "2026", "01", "01");
  await mkdir(dayDir, { recursive: true });
  const rows = [
    JSON.stringify({
      timestamp: "2026-01-01T00:02:00.000Z",
      type: "session_meta",
      payload: { id: "codex-integration", cwd: repo, git: { branch } },
    }),
    JSON.stringify({
      timestamp: "2026-01-01T00:02:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: "codex integration check",
      },
    }),
    JSON.stringify({
      timestamp: "2026-01-01T00:02:11.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "on it" },
    }),
  ];
  await writeFile(
    join(dayDir, "rollout-codex-integration.jsonl"),
    `${rows.join("\n")}\n`,
  );
  return sessionsDir;
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

test("coordination tools (including unknown mcp__ tools) count as normal time while delegation still invalidates frozen-head reads and truly unknown tools stay unexplained", async () => {
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

    const mcp = await analyzeWith("mcp__custom__tool", "mcp-session");
    assert.equal(mcp.ledger.totals_ms.normal, 120_000);
    assert.equal(mcp.ledger.totals_ms.unexplained, 60_000);
    assert.equal(mcp.record.read_observations?.length, 1);

    const unknown = await analyzeWith("CustomUnknownTool", "unknown-session");
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

test("a multi-branch session only counts head-branch work and avoids false rework", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-window-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const projects = join(root, "claude-projects");
    const row = (value: Record<string, unknown>): string =>
      JSON.stringify({ sessionId: "multi-branch", cwd: repo, ...value });
    const rows = [
      row({
        type: "user",
        uuid: "old-u0",
        timestamp: "2026-01-01T00:01:00.000Z",
        gitBranch: "feature/old",
        message: { role: "user", content: "Work on the previous PR." },
      }),
      row({
        type: "assistant",
        uuid: "old-a1",
        timestamp: "2026-01-01T00:01:10.000Z",
        gitBranch: "feature/old",
        message: {
          id: "old-m1",
          content: [{
            type: "tool_use",
            id: "edit-old",
            name: "Edit",
            input: {
              file_path: "docs/note.md",
              old_string: "",
              new_string: "note that never reaches the current diff",
            },
          }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
      row({
        type: "user",
        uuid: "old-r1",
        timestamp: "2026-01-01T00:01:30.000Z",
        gitBranch: "feature/old",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "edit-old",
            content: "updated",
            is_error: false,
          }],
        },
      }),
      row({
        type: "user",
        uuid: "new-u0",
        timestamp: "2026-01-01T00:10:00.000Z",
        gitBranch: "feature",
        message: { role: "user", content: "Implement the current PR." },
      }),
      row({
        type: "assistant",
        uuid: "new-a1",
        timestamp: "2026-01-01T00:10:10.000Z",
        gitBranch: "feature",
        message: {
          id: "new-m1",
          content: [{
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: "src/value.ts" },
          }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
      row({
        type: "user",
        uuid: "new-r1",
        timestamp: "2026-01-01T00:10:40.000Z",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "read-1",
            content: "export const value = 2;",
            is_error: false,
          }],
        },
      }),
    ];
    await write(
      join(projects, "fixture", "multi-branch.jsonl"),
      `${rows.join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: new ClaudeSessionSource(projects),
    });

    assert.deepEqual(result.report.unit.sessions, ["multi-branch"]);
    assert.equal(
      result.allFindings.some(({ rule_id }) => rule_id === "R001"),
      false,
    );
    assert.equal(result.ledger.totals_ms.measured, 40_000);
    assert.ok(
      result.warnings.some(({ code }) => code === "branch_scoped"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("time between head-branch segments is not counted as the current PR", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-gap-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const projects = join(root, "claude-projects");
    const row = (
      uuid: string,
      at: string,
      branch: string | undefined,
      text: string,
    ): string =>
      JSON.stringify({
        sessionId: "segmented",
        cwd: repo,
        type: "user",
        uuid,
        timestamp: at,
        ...(branch === undefined ? {} : { gitBranch: branch }),
        message: { role: "user", content: text },
      });
    const rows = [
      row("h-1", "2026-01-01T00:05:00.000Z", "feature", "head work"),
      row("h-2", "2026-01-01T00:05:30.000Z", undefined, "still head"),
      row("o-1", "2026-01-01T00:06:00.000Z", "feature/other", "other pr"),
      row("o-2", "2026-01-01T00:07:00.000Z", undefined, "still other"),
      row("h-3", "2026-01-01T00:08:00.000Z", "feature", "back on head"),
      row("h-4", "2026-01-01T00:08:20.000Z", undefined, "finishing"),
    ];
    await write(
      join(projects, "fixture", "segmented.jsonl"),
      `${rows.join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: new ClaudeSessionSource(projects),
    });

    assert.deepEqual(result.report.unit.sessions, ["segmented"]);
    // 30s in the first head segment plus 20s in the second; the other-branch
    // interlude (00:05:30 -> 00:08:00) must not bridge into measured time.
    assert.equal(result.ledger.totals_ms.raw_observed, 50_000);
    assert.equal(result.ledger.totals_ms.measured, 50_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a branch departure visible only on non-event rows still splits the segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-epoch-gap-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const projects = join(root, "claude-projects");
    const userRow = (
      uuid: string,
      at: string,
      branch: string | undefined,
      text: string,
    ): string =>
      JSON.stringify({
        sessionId: "epoch-gap",
        cwd: repo,
        type: "user",
        uuid,
        timestamp: at,
        ...(branch === undefined ? {} : { gitBranch: branch }),
        message: { role: "user", content: text },
      });
    const rows = [
      userRow("h-1", "2026-01-01T00:05:00.000Z", "feature", "head work"),
      userRow("h-2", "2026-01-01T00:05:30.000Z", undefined, "still head"),
      // The other-branch interlude is visible only on a non-event system row.
      JSON.stringify({
        sessionId: "epoch-gap",
        cwd: repo,
        type: "system",
        uuid: "sys-other",
        timestamp: "2026-01-01T00:06:00.000Z",
        gitBranch: "feature/other",
      }),
      userRow("h-3", "2026-01-01T00:08:00.000Z", "feature", "back on head"),
      userRow("h-4", "2026-01-01T00:08:20.000Z", undefined, "finishing"),
    ];
    await write(
      join(projects, "fixture", "epoch-gap.jsonl"),
      `${rows.join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: new ClaudeSessionSource(projects),
    });

    assert.deepEqual(result.report.unit.sessions, ["epoch-gap"]);
    // 30s before and 20s after the departure; the 00:05:30 -> 00:08:00 span
    // spent on the other branch must not be bridged into this PR.
    assert.equal(result.ledger.totals_ms.raw_observed, 50_000);
    assert.equal(result.ledger.totals_ms.measured, 50_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an other-branch sidechain does not split the main agent's head segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-sidechain-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const projects = join(root, "claude-projects");
    const mainRow = (
      uuid: string,
      at: string,
      branch: string | undefined,
      text: string,
    ): string =>
      JSON.stringify({
        sessionId: "side-mix",
        cwd: repo,
        type: "user",
        uuid,
        timestamp: at,
        ...(branch === undefined ? {} : { gitBranch: branch }),
        message: { role: "user", content: text },
      });
    const sideRow = (uuid: string, at: string, branch?: string): string =>
      JSON.stringify({
        sessionId: "side-mix",
        cwd: repo,
        type: "user",
        uuid,
        timestamp: at,
        isSidechain: true,
        agentId: "side",
        ...(branch === undefined ? {} : { gitBranch: branch }),
        message: { role: "user", content: `sidechain ${uuid}` },
      });
    const rows = [
      mainRow("m-1", "2026-01-01T00:05:00.000Z", "feature", "head work"),
      mainRow("m-2", "2026-01-01T00:05:30.000Z", undefined, "continues"),
      sideRow("s-1", "2026-01-01T00:06:00.000Z", "feature/other"),
      sideRow("s-2", "2026-01-01T00:07:00.000Z"),
      mainRow("m-3", "2026-01-01T00:08:00.000Z", undefined, "still head"),
      mainRow("m-4", "2026-01-01T00:08:20.000Z", undefined, "finish"),
    ];
    await write(
      join(projects, "fixture", "side-mix.jsonl"),
      `${rows.join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: new ClaudeSessionSource(projects),
    });

    assert.deepEqual(result.report.unit.sessions, ["side-mix"]);
    // The main agent stays on the head branch from 00:05:00 to 00:08:20, so
    // its 200s span must stay whole; the sidechain's other-branch time is
    // excluded and must add nothing.
    assert.equal(result.ledger.totals_ms.raw_observed, 200_000);
    assert.equal(result.ledger.totals_ms.measured, 200_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyze detects and persists a CLAUDE.md adoption of a prior PR's suggestion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-"));
  try {
    const repo = await makeRepository(root);
    const projects = await makeClaudeProjects(root, repo);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    // Seed a finding from a *different* PR so it counts as prior history:
    // adoption tracking is a cross-PR signal, not an intra-PR rerun signal.
    const priorFindingKey = "seed-r005-deploy-checklist";
    const priorSuggestion = "Explain the deploy checklist steps in CLAUDE.md.";
    await saveAnalysis(storePaths, {
      analysis_id: "history-adoption-seed",
      created_at_ms: NOW_MS - 5_000,
      unit: {
        repo,
        pr_ref: "main...prior-pr",
        sessions: ["prior-session"],
      },
      summary: seedSummary(),
      findings: [{
        finding_key: priorFindingKey,
        rule_id: "R005",
        title: "Independent tool calls ran serially",
        classification: "behavior",
        cause: null,
        scope: "claude_md",
        confidence: "medium",
        evidence: { session_refs: ["prior-session#u0"], interval_ids: [] },
        fix_recipe: { suggestion: priorSuggestion, verify: "ccprof --json" },
        caveats: [],
        recoverable: { min: 3, bound: "point" },
      }],
      metrics: {},
      command_costs: [],
    });

    const options = {
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
    } as const;

    const first = await analyze(options);
    assert.deepEqual(
      first.adoptions,
      [],
      "no CLAUDE.md commit exists yet, so nothing can be adopted",
    );
    const storedBeforeFix = await loadAdoptions(storePaths);
    assert.deepEqual(storedBeforeFix.records, []);

    // Address the suggestion by editing CLAUDE.md after recorded_at_ms.
    await write(
      join(repo, "CLAUDE.md"),
      "# Team notes\n\n## Deploy checklist\nFollow the steps before merging.\n",
    );
    await git(repo, ["add", "CLAUDE.md"]);
    await git(repo, ["commit", "-m", "docs: add deploy checklist"], {
      GIT_AUTHOR_DATE: "2026-01-01T00:59:58.000Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:59:58.000Z",
    });
    const fixCommit = await git(repo, ["rev-parse", "HEAD"]);

    const second = await analyze(options);
    const adopted = second.adoptions.find(
      ({ finding_key }) => finding_key === priorFindingKey,
    );
    assert.ok(adopted, "the seeded suggestion must be reported as adopted");
    assert.equal(adopted?.method, "claude_md_edit");
    assert.equal(adopted?.evidence.path, "CLAUDE.md");
    assert.equal(adopted?.evidence.commit, fixCommit);
    assert.equal(adopted?.rule_id, "R005");
    assert.equal(adopted?.scope, "claude_md");
    assert.equal(adopted?.detected_at_ms, NOW_MS);
    assert.deepEqual(
      second.adoptions.map(({ finding_key }) => finding_key),
      [...second.adoptions]
        .map(({ finding_key }) => finding_key)
        .sort((left, right) => left.localeCompare(right)),
      "adoptions must be sorted by finding_key",
    );

    const storedAfterFix = await loadAdoptions(storePaths);
    assert.deepEqual(
      storedAfterFix.records.map(({ finding_key }) => finding_key),
      [priorFindingKey],
      "the adoption must be persisted to the adoptions store",
    );

    const third = await analyze(options);
    assert.equal(
      third.adoptions.filter(({ finding_key }) => finding_key === priorFindingKey).length,
      1,
      "a rerun must not duplicate an already-recorded adoption",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("propagates the underlying source error, not NoMatchingSessionsError, when every source found nothing and one threw", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-source-error-empty-"));
  try {
    const repo = await makeRepository(root);
    const claudeProjects = await makeMalformedClaudeProjects(root);
    const emptyCodexSessions = join(root, "codex-sessions-empty");
    await mkdir(emptyCodexSessions, { recursive: true });
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    // No sessionSource is injected here on purpose: this exercises
    // defaultSessionSource's CombinedSessionSource([claude, codex]) wiring,
    // with the Claude arm forced to fail and the Codex arm contributing
    // nothing, so the combined result is empty.
    await assert.rejects(
      analyze({
        cwd: repo,
        pr: "main...feature",
        nowMs: NOW_MS,
        storePaths,
        claudeProjectsDirectory: claudeProjects,
        codexSessionsDirectory: emptyCodexSessions,
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof ClaudeDiscoveryError,
          "the underlying discovery error must propagate as-is, not be swallowed",
        );
        assert.ok(
          !(error instanceof NoMatchingSessionsError),
          "a real source failure must not be masked as NoMatchingSessionsError",
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continues analysis with a session_source_error warning when sessions were found despite one source throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-source-error-partial-"));
  try {
    const repo = await makeRepository(root);
    const claudeProjects = await makeMalformedClaudeProjects(root);
    const codexSessions = await makeCodexSessions(root, repo, "feature");
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      claudeProjectsDirectory: claudeProjects,
      codexSessionsDirectory: codexSessions,
    });

    assert.deepEqual(result.report.unit.sessions, ["codex-integration"]);
    const sourceErrorWarning = result.warnings.find(
      (warning) => warning.code === "session_source_error",
    );
    assert.ok(
      sourceErrorWarning,
      "the Claude source failure must surface as a session_source_error warning",
    );
    assert.ok(
      sourceErrorWarning?.message.startsWith(
        "Claude session discovery failed for one or more sources.",
      ),
      "the base message must be preserved",
    );
    assert.ok(
      sourceErrorWarning?.message.includes(
        join(claudeProjects, "malformed.jsonl"),
      ),
      "the failing source's path must be included so the warning is actionable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips rules whose required capability is missing from a mixed Codex+Claude session set", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-skipped-rules-"));
  try {
    const repo = await makeRepository(root);
    const claudeProjects = await makeClaudeProjects(root, repo);
    const codexSessions = await makeCodexSessions(root, repo, "feature");
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      claudeProjectsDirectory: claudeProjects,
      codexSessionsDirectory: codexSessions,
    });

    // Sanity check: both sources actually contributed a session, so the
    // capability mix (full Claude session + tool_timestamps-only Codex
    // session) is really in play below.
    assert.deepEqual(result.report.unit.sessions, [
      "codex-integration",
      "e2e-session",
    ]);

    assert.ok(
      !result.allFindings.some(({ rule_id }) => rule_id === "R001"),
      "R001 requires edit_fragments, which the Codex session lacks",
    );
    assert.ok(
      !result.allFindings.some(({ rule_id }) => rule_id === "R007"),
      "R007 requires token_usage, which the Codex session lacks",
    );
    // R005 requires only tool_timestamps, which the Codex session does
    // declare, so mixing in a Codex session must not skip it.
    assert.ok(
      result.report.skipped_rules?.every(
        (entry) => entry.rule_id !== "R005",
      ) ?? true,
    );

    assert.deepEqual(result.report.skipped_rules, [
      { rule_id: "R001", missing: ["edit_fragments"] },
      { rule_id: "R007", missing: ["token_usage"] },
    ]);

    const skipWarnings = result.warnings.filter(
      (warning) => warning.code === "rule_skipped_missing_capability",
    );
    assert.deepEqual(
      skipWarnings.map((warning) => warning.message).sort(),
      [
        "R001 skipped: session source lacks edit_fragments",
        "R007 skipped: session source lacks token_usage",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full-capability (Claude-only) analyses omit skipped_rules and emit no capability-skip warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-no-skipped-rules-"));
  try {
    const repo = await makeRepository(root);
    const projects = await makeClaudeProjects(root, repo);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
    });

    assert.equal(result.report.skipped_rules, undefined);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result.report, "skipped_rules"),
      "skipped_rules must be entirely omitted, not present-but-empty",
    );
    assert.deepEqual(
      result.warnings.filter(
        (warning) => warning.code === "rule_skipped_missing_capability",
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
