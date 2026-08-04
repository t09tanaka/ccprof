import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AnalysisBudgetClock,
  type AnalysisBudgets,
  AnalysisBudgetMeter,
} from "../src/analysis/budgets.js";
import { analyze } from "../src/core/analyze.js";
import type { ReportV2, Session } from "../src/core/model.js";
import { runCommand, type CommandRunner } from "../src/git/client.js";
import {
  finalizeBudgetedOutput,
  OUTPUT_BUDGET_ENVELOPES,
} from "../src/reporters/budget.js";
import { renderJsonReport } from "../src/reporters/json.js";
import {
  projectReportPrivacy,
  type PrivacyProfile,
} from "../src/reporters/privacy.js";
import {
  CLAUDE_SESSION_SOURCE_CONTRACT,
  type SessionQuery,
  type SessionSource,
} from "../src/sources/session-source.js";
import { resolveStorePaths } from "../src/store/paths.js";
import {
  openStoreDatabase,
  storeDatabasePath,
} from "../src/store/sqlite.js";

const NOW_MS = Date.parse("2026-01-01T01:00:00.000Z");

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
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function makeRepository(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "ccprof test"]);
  await git(repo, ["config", "user.email", "ccprof@example.invalid"]);
  await writeFile(join(repo, "value.txt"), "base\n", "utf8");
  await git(repo, ["add", "value.txt"]);
  await git(repo, ["commit", "-m", "base"], {
    GIT_AUTHOR_DATE: "2025-12-31T23:00:00.000Z",
    GIT_COMMITTER_DATE: "2025-12-31T23:00:00.000Z",
  });
  await git(repo, ["switch", "-c", "feature"]);
  await writeFile(join(repo, "value.txt"), "feature\n", "utf8");
  await git(repo, ["add", "value.txt"]);
  await git(repo, ["commit", "-m", "feature"], {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00.000Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00.000Z",
  });
  return repo;
}

function session(repo: string, eventCount = 3): Session {
  const start = NOW_MS - 10 * 60_000;
  const shared = {
    session_id: "budget-session",
    agent_id: "main",
    is_sidechain: false,
    confidence: "high" as const,
  };
  const allEvents: Session["events"] = [
    {
      ...shared,
      kind: "genuine_user",
      timestamp_ms: start,
      entry_uuid: "u0",
      session_ref: "budget-session#u0",
      source_index: 0,
      text: "Start.",
    },
    {
      ...shared,
      kind: "assistant",
      timestamp_ms: start + 30_000,
      entry_uuid: "a1",
      session_ref: "budget-session#a1",
      source_index: 1,
      text: "Working.",
    },
    {
      ...shared,
      kind: "assistant",
      timestamp_ms: start + 60_000,
      entry_uuid: "a2",
      session_ref: "budget-session#a2",
      source_index: 2,
      text: "Done.",
    },
  ];
  const events = allEvents.slice(0, eventCount);
  return {
    session_id: "budget-session",
    source: "claude",
    source_path: join(repo, "budget-session.jsonl"),
    observed_cwds: [repo],
    observed_branches: ["feature"],
    started_at_ms: events[0]?.timestamp_ms ?? start,
    ended_at_ms: events.at(-1)?.timestamp_ms ?? start,
    confidence: "high",
    events,
    warnings: [],
  };
}

function identifiedSession(
  repo: string,
  sessionId: string,
  sourcePath: string,
): Session {
  const original = session(repo, 1);
  return {
    ...original,
    session_id: sessionId,
    source_path: sourcePath,
    events: original.events.map((event) => ({
      ...event,
      session_id: sessionId,
      agent_id: sessionId,
      entry_uuid: `${sessionId}-${event.entry_uuid}`,
      session_ref: `${sessionId}#${event.entry_uuid}`,
    })),
  };
}

async function makeClaudeProjects(root: string, repo: string): Promise<{
  directory: string;
  transcript: string;
}> {
  const directory = join(root, "claude-projects");
  const transcript = join(directory, "project", "session.jsonl");
  await mkdir(join(directory, "project"), { recursive: true });
  const rows = [
    {
      type: "user",
      sessionId: "claude-budget",
      uuid: "u0",
      timestamp: "2026-01-01T00:51:00.000Z",
      cwd: repo,
      gitBranch: "feature",
      message: { content: "Start." },
    },
    {
      type: "assistant",
      sessionId: "claude-budget",
      uuid: "a1",
      timestamp: "2026-01-01T00:51:30.000Z",
      cwd: repo,
      gitBranch: "feature",
      message: {
        id: "m1",
        content: [{ type: "text", text: "Working." }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "assistant",
      sessionId: "claude-budget",
      uuid: "a2",
      timestamp: "2026-01-01T00:52:00.000Z",
      cwd: repo,
      gitBranch: "feature",
      message: {
        id: "m2",
        content: [{ type: "text", text: "Done." }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  await writeFile(
    transcript,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  return { directory, transcript };
}

async function makeCodexSessions(root: string, repo: string): Promise<string> {
  const directory = join(root, "codex-sessions", "2026", "01", "01");
  await mkdir(directory, { recursive: true });
  const rows = [
    {
      timestamp: "2026-01-01T00:53:00.000Z",
      type: "session_meta",
      payload: { id: "codex-budget", cwd: repo, git: { branch: "feature" } },
    },
    {
      timestamp: "2026-01-01T00:53:10.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: "Start." },
    },
    {
      timestamp: "2026-01-01T00:53:40.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "Done." },
    },
  ];
  await writeFile(
    join(directory, "rollout-budget.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  return join(root, "codex-sessions");
}

function budgets(overrides: Partial<AnalysisBudgets> = {}): AnalysisBudgets {
  return {
    max_input_bytes: 1_000_000,
    max_input_events: 100,
    max_wall_ms: 1_000_000,
    max_cpu_ms: 1_000_000,
    max_output_bytes: 1_000_000,
    max_source_items: 100,
    ...overrides,
  };
}

class ScriptedClock implements AnalysisBudgetClock {
  readonly #wall: number[];
  readonly #cpu: number[];
  #wallIndex = 0;
  #cpuIndex = 0;

  constructor(wall: number[], cpu: number[]) {
    this.#wall = wall;
    this.#cpu = cpu;
  }

  wall_ms(): number {
    return this.#wall[Math.min(this.#wallIndex++, this.#wall.length - 1)]!;
  }

  cpu_ms(): number {
    return this.#cpu[Math.min(this.#cpuIndex++, this.#cpu.length - 1)]!;
  }
}

const steadyClock: AnalysisBudgetClock = {
  wall_ms: () => 0,
  cpu_ms: () => 0,
};

function outputReport(canary = "safe"): ReportV2 {
  return {
    version: 2,
    unit: {
      repo: `/private/${canary}`,
      pr_ref: "main...feature",
      sessions: [`session-${canary}`],
    },
    summary: {
      measured_min: 0,
      idle_excluded_min: 0,
      estimated_floor_min: 0,
      recoverable_min: 0,
      human_wait_min: 0,
      unexplained_min: 0,
      baseline: null,
    },
    findings: [],
    caveats: [`token ghp_${canary}_12345678`],
  };
}

function outputMeter(maxOutputBytes: number): AnalysisBudgetMeter {
  return new AnalysisBudgetMeter(
    budgets({ max_output_bytes: maxOutputBytes }),
    steadyClock,
  );
}

test("custom sources are backstopped to an exact event prefix without empty-result errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-events-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const source: SessionSource = {
      contract: CLAUDE_SESSION_SOURCE_CONTRACT,
      discover: async () => [session(repo)],
    };
    const options = {
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      sessionSource: source,
      storePaths,
      persist: false,
      budgets: budgets({ max_input_events: 1 }),
      budgetClock: steadyClock,
    };

    const result = await analyze(options);

    assert.equal(result.report.analysis_budget?.completeness, "partial");
    assert.equal(
      result.report.analysis_budget?.truncation_reason,
      "max_input_events",
    );
    assert.equal(result.report.analysis_budget?.consumed.input_events, 1);
    assert.equal(result.report.analysis_budget?.observed.input_events, 3);
    assert.equal(result.report.analysis_budget?.coverage, 1 / 3);
    assert.deepEqual(result.record.analysis_budget, result.report.analysis_budget);
    assert.deepEqual(result.report.unit.sessions, ["budget-session"]);

    const database = openStoreDatabase(storePaths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_budget_runs",
      ).pluck().get(), 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom sources cannot opt out of deterministic source and event admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-custom-backstop-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const first = identifiedSession(repo, "first", join(repo, "a.jsonl"));
    const later = identifiedSession(repo, "later", join(repo, "z.jsonl"));
    const sourceWithLegacyBypassFlag = {
      budgetCooperative: true,
      contract: CLAUDE_SESSION_SOURCE_CONTRACT,
      discover: async () => [later, first],
    };

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      sessionSource: sourceWithLegacyBypassFlag,
      storePaths,
      persist: false,
      budgets: budgets({ max_source_items: 1 }),
      budgetClock: steadyClock,
    });

    assert.equal(
      result.report.analysis_budget?.truncation_reason,
      "max_source_items",
    );
    assert.equal(result.report.analysis_budget?.consumed.source_items, 1);
    assert.equal(result.report.analysis_budget?.observed.source_items, 2);
    assert.deepEqual(result.report.unit.sessions, ["first"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom source budget order uses locale-independent code units", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-custom-order-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const upper = identifiedSession(repo, "upper", join(repo, "Z.jsonl"));
    const lower = identifiedSession(repo, "lower", join(repo, "a.jsonl"));

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => [lower, upper],
      },
      storePaths,
      persist: false,
      budgets: budgets({ max_source_items: 1 }),
      budgetClock: steadyClock,
    });

    assert.equal(
      result.report.analysis_budget?.truncation_reason,
      "max_source_items",
    );
    assert.deepEqual(result.report.unit.sessions, ["upper"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom source evidence is not admitted after its discovery clock expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-custom-clock-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const clock = new ScriptedClock([0, 0, 1], [0, 0, 0]);

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => [session(repo)],
      },
      storePaths,
      persist: false,
      budgets: budgets({ max_wall_ms: 0 }),
      budgetClock: clock,
    });

    assert.equal(
      result.report.analysis_budget?.truncation_reason,
      "max_wall_ms",
    );
    assert.equal(result.report.analysis_budget?.consumed.source_items, 0);
    assert.equal(result.report.analysis_budget?.consumed.input_events, 0);
    assert.deepEqual(result.report.unit.sessions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeline-time exhaustion returns a partial result before the no-interval error", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-timeline-clock-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    let timelineStarted = false;

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => [session(repo, 1)],
      },
      storePaths,
      persist: false,
      budgets: budgets({ max_wall_ms: 0 }),
      budgetClock: {
        wall_ms: () => timelineStarted ? 1 : 0,
        cpu_ms: () => 0,
      },
      get idleThresholdMs() {
        timelineStarted = true;
        return 30 * 60_000;
      },
    });

    assert.equal(timelineStarted, true);
    assert.equal(
      result.report.analysis_budget?.truncation_reason,
      "max_wall_ms",
    );
    assert.deepEqual(result.report.unit.sessions, ["budget-session"]);
    assert.equal(result.report.summary.measured_min, 0);
    assert.deepEqual(result.allFindings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a complete budgeted persist:false run never creates or migrates the Store", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-no-store-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const databasePath = storeDatabasePath(storePaths);

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => [session(repo)],
      },
      storePaths,
      persist: false,
      budgets: budgets(),
      budgetClock: steadyClock,
    });

    assert.equal(result.report.analysis_budget?.completeness, "complete");
    await assert.rejects(
      access(databasePath),
      (error: unknown) =>
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy unbudgeted persist:false analysis retains Store-backed reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-unbudgeted-store-reads-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const databasePath = storeDatabasePath(storePaths);

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => [session(repo)],
      },
      storePaths,
      persist: false,
    });

    assert.equal(result.report.analysis_budget, undefined);
    await access(databasePath);
    const database = openStoreDatabase(storePaths);
    try {
      const migrations = database.prepare(
        "SELECT name FROM store_migrations WHERE name LIKE 'legacy-%' ORDER BY name",
      ).pluck().all();
      assert.deepEqual(migrations, [
        "legacy-adoptions-json-v1",
        "legacy-analyses-json-v1",
        "legacy-dismissals-json-v1",
      ]);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("simultaneous wall and CPU exhaustion returns a stable empty partial result before source or evidence I/O", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-clock-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    let sourceCalls = 0;
    const gitOperations: string[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      if (command === "git") gitOperations.push(args[0] ?? "");
      return runCommand(command, args, options);
    };
    const options = {
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      runner,
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => {
          sourceCalls += 1;
          return [session(repo)];
        },
      },
      storePaths,
      persist: false,
      budgets: budgets({ max_wall_ms: 0, max_cpu_ms: 0 }),
      budgetClock: new ScriptedClock([0, 1], [0, 1]),
    };

    const result = await analyze(options);

    assert.equal(sourceCalls, 0);
    assert.equal(result.report.analysis_budget?.truncation_reason, "max_wall_ms");
    assert.equal(result.report.analysis_budget?.consumed.wall_ms, 1);
    assert.equal(result.report.analysis_budget?.consumed.cpu_ms, 1);
    assert.equal(result.report.analysis_budget?.coverage, 0);
    assert.deepEqual(result.report.unit.sessions, []);
    assert.deepEqual(result.allFindings, []);
    assert.ok(!gitOperations.includes("diff"));
    assert.ok(!gitOperations.includes("ls-tree"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a budgeted custom source failure returns content-free partial output", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-source-failure-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const source: SessionSource = {
      contract: CLAUDE_SESSION_SOURCE_CONTRACT,
      discover: async () => {
        throw new Error("token-canary");
      },
    };
    const options = {
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      sessionSource: source,
      storePaths,
      persist: false,
      budgets: budgets(),
      budgetClock: steadyClock,
    };

    const result = await analyze(options);

    assert.equal(result.report.analysis_budget?.truncation_reason, "source_failure");
    assert.equal(result.report.analysis_budget?.coverage, 0);
    assert.deepEqual(result.report.unit.sessions, []);
    assert.ok(!JSON.stringify(result).includes("token-canary"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted and non-persisted partial runs differ only in Store budget rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-persist-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const baseOptions = {
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => [session(repo)],
      },
      storePaths,
      budgets: budgets({ max_input_events: 1 }),
      budgetClock: steadyClock,
    };

    const transient = await analyze({
      ...baseOptions,
      nowMs: NOW_MS,
      persist: false,
    });
    let database = openStoreDatabase(storePaths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_budget_runs",
      ).pluck().get(), 0);
    } finally {
      database.close();
    }

    const persisted = await analyze({
      ...baseOptions,
      nowMs: NOW_MS + 1,
      persist: true,
    });
    assert.deepEqual(
      persisted.report.analysis_budget,
      transient.report.analysis_budget,
    );
    database = openStoreDatabase(storePaths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_budget_runs",
      ).pluck().get(), 1);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("built-in Claude and Codex sources share source-item capacity in declared order", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-source-order-"));
  try {
    const repo = await makeRepository(root);
    const claude = await makeClaudeProjects(root, repo);
    const codexSessionsDirectory = await makeCodexSessions(root, repo);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const options = {
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      claudeProjectsDirectory: claude.directory,
      codexSessionsDirectory,
      storePaths,
      persist: false,
      budgets: budgets({ max_source_items: 1 }),
      budgetClock: steadyClock,
    };

    const result = await analyze(options);

    assert.equal(
      result.report.analysis_budget?.truncation_reason,
      "max_source_items",
    );
    assert.equal(result.report.analysis_budget?.consumed.source_items, 1);
    assert.equal(result.report.analysis_budget?.observed.source_items, 2);
    assert.deepEqual(result.report.unit.sessions, ["claude-budget"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("built-in transcript bytes distinguish exact and one-over prefixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-source-bytes-"));
  try {
    const repo = await makeRepository(root);
    const claude = await makeClaudeProjects(root, repo);
    const emptyCodex = join(root, "empty-codex");
    await mkdir(emptyCodex);
    const fileBytes = (await stat(claude.transcript)).size;
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const run = async (maxInputBytes: number) => await analyze({
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      claudeProjectsDirectory: claude.directory,
      codexSessionsDirectory: emptyCodex,
      storePaths,
      persist: false,
      budgets: budgets({ max_input_bytes: maxInputBytes }),
      budgetClock: steadyClock,
    });

    const exact = await run(fileBytes);
    assert.equal(exact.report.analysis_budget?.completeness, "complete");
    assert.equal(exact.report.analysis_budget?.consumed.input_bytes, fileBytes);
    assert.equal(exact.report.analysis_budget?.observed.input_bytes, fileBytes);

    const oneOver = await run(fileBytes - 1);
    assert.equal(
      oneOver.report.analysis_budget?.truncation_reason,
      "max_input_bytes",
    );
    assert.equal(oneOver.report.analysis_budget?.consumed.input_bytes, fileBytes - 1);
    assert.equal(oneOver.report.analysis_budget?.observed.input_bytes, fileBytes);
    assert.deepEqual(oneOver.report.unit.sessions, ["claude-budget"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude byte truncation over a malformed huge row keeps admitted-byte coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-huge-row-"));
  try {
    const repo = await makeRepository(root);
    const projectsDirectory = join(root, "claude-projects");
    const transcriptPath = join(projectsDirectory, "huge.jsonl");
    const codexSessionsDirectory = join(root, "empty-codex");
    await Promise.all([
      mkdir(projectsDirectory, { recursive: true }),
      mkdir(codexSessionsDirectory, { recursive: true }),
    ]);
    await writeFile(
      transcriptPath,
      `{${"x".repeat(8_192)}\n`,
      "utf8",
    );
    const fileBytes = (await stat(transcriptPath)).size;
    const admittedBytes = 64;
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      sinceMs: NOW_MS - 20 * 60_000,
      nowMs: NOW_MS,
      claudeProjectsDirectory: projectsDirectory,
      codexSessionsDirectory,
      storePaths,
      persist: false,
      budgets: budgets({ max_input_bytes: admittedBytes }),
      budgetClock: steadyClock,
    });

    assert.equal(
      result.report.analysis_budget?.truncation_reason,
      "max_input_bytes",
    );
    assert.equal(
      result.report.analysis_budget?.consumed.input_bytes,
      admittedBytes,
    );
    assert.equal(
      result.report.analysis_budget?.observed.input_bytes,
      fileBytes,
    );
    assert.equal(
      result.report.analysis_budget?.coverage,
      admittedBytes / fileBytes,
    );
    assert.deepEqual(result.report.unit.sessions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projected output uses inclusive exact UTF-8 byte limits", () => {
  const output = "é";
  const maxOutputBytes = Buffer.byteLength(output, "utf8");

  const finalized = finalizeBudgetedOutput({
    report: outputReport(),
    meter: outputMeter(maxOutputBytes),
    projection: {
      format: "json",
      render: () => ({ output }),
    },
  });

  assert.equal(finalized.stdout, output);
  assert.equal(finalized.analysisBudget.completeness, "complete");
  assert.equal(
    finalized.analysisBudget.consumed.output_bytes,
    maxOutputBytes,
  );
  assert.equal(
    finalized.analysisBudget.observed.output_bytes,
    maxOutputBytes,
  );
});

test("one UTF-8 byte over the output cap is never sliced", () => {
  const output = "界";

  const finalized = finalizeBudgetedOutput({
    report: outputReport(),
    meter: outputMeter(Buffer.byteLength(output, "utf8") - 1),
    projection: {
      format: "json",
      render: () => ({ output }),
    },
  });

  assert.equal(finalized.stdout, "");
  assert.equal(
    finalized.analysisBudget.truncation_reason,
    "max_output_bytes",
  );
  assert.equal(finalized.analysisBudget.consumed.output_bytes, 0);
  assert.equal(
    finalized.analysisBudget.observed.output_bytes,
    Buffer.byteLength(output, "utf8"),
  );
});

test("overflow emits the fixed content-free envelope at its exact boundary", () => {
  const envelope = OUTPUT_BUDGET_ENVELOPES.tty;
  const maxOutputBytes = Buffer.byteLength(envelope, "utf8");
  const secret = "ghp_FIXED_ENVELOPE_SECRET";
  const output = secret.repeat(100);

  const finalized = finalizeBudgetedOutput({
    report: outputReport(secret),
    meter: outputMeter(maxOutputBytes),
    projection: {
      format: "tty",
      render: () => ({ output }),
    },
  });

  assert.equal(finalized.stdout, envelope);
  assert.ok(!finalized.stdout.includes(secret));
  assert.equal(
    finalized.analysisBudget.consumed.output_bytes,
    maxOutputBytes,
  );
  assert.equal(
    finalized.analysisBudget.observed.output_bytes,
    Buffer.byteLength(output, "utf8"),
  );
});

test("an envelope larger than the cap and a zero cap both emit zero bytes", () => {
  const envelopeBytes = Buffer.byteLength(
    OUTPUT_BUDGET_ENVELOPES.markdown,
    "utf8",
  );

  for (const maxOutputBytes of [envelopeBytes - 1, 0]) {
    const finalized = finalizeBudgetedOutput({
      report: outputReport(),
      meter: outputMeter(maxOutputBytes),
      projection: {
        format: "markdown",
        render: () => ({ output: "x".repeat(envelopeBytes + 100) }),
      },
    });

    assert.equal(finalized.stdout, "");
    assert.equal(finalized.analysisBudget.consumed.output_bytes, 0);
    assert.equal(
      finalized.analysisBudget.truncation_reason,
      "max_output_bytes",
    );
  }
});

test("an advisory that crosses the cap is omitted before the envelope", () => {
  const deterministic = "safe report\n";
  const advisory = "PRIVATE_ADVISORY_CANARY";
  const full = `${deterministic}${advisory}`;

  const finalized = finalizeBudgetedOutput({
    report: outputReport(),
    meter: outputMeter(Buffer.byteLength(deterministic, "utf8")),
    projection: {
      format: "tty",
      render: () => ({
        output: full,
        withoutAdvisory: deterministic,
      }),
    },
  });

  assert.equal(finalized.stdout, deterministic);
  assert.ok(!finalized.stdout.includes(advisory));
  assert.equal(
    finalized.analysisBudget.truncation_reason,
    "max_output_bytes",
  );
  assert.equal(
    finalized.analysisBudget.consumed.output_bytes,
    Buffer.byteLength(deterministic, "utf8"),
  );
  assert.equal(
    finalized.analysisBudget.observed.output_bytes,
    Buffer.byteLength(full, "utf8"),
  );
});

test("envelope fallback retains the full advisory attempt as observed bytes", () => {
  const deterministic = "d".repeat(1_000);
  const advisory = "a".repeat(100);
  const full = `${deterministic}${advisory}`;
  const envelope = OUTPUT_BUDGET_ENVELOPES.tty;

  const finalized = finalizeBudgetedOutput({
    report: outputReport(),
    meter: outputMeter(Buffer.byteLength(envelope, "utf8")),
    projection: {
      format: "tty",
      render: () => ({
        output: full,
        withoutAdvisory: deterministic,
      }),
    },
  });

  assert.equal(finalized.stdout, envelope);
  assert.equal(
    finalized.analysisBudget.observed.output_bytes,
    Buffer.byteLength(full, "utf8"),
  );
  assert.equal(
    finalized.analysisBudget.coverage,
    Buffer.byteLength(envelope, "utf8") / Buffer.byteLength(full, "utf8"),
  );
});

test("byte measurement receives only privacy-projected report values", () => {
  const canary = "PRIVACY_MEASUREMENT_CANARY";
  const profiles: readonly PrivacyProfile[] = ["strict", "balanced"];

  for (const profile of profiles) {
    const measured: string[] = [];
    const finalized = finalizeBudgetedOutput({
      report: outputReport(canary),
      meter: outputMeter(1_000_000),
      projection: {
        format: "json",
        render: (candidate) => ({
          output: renderJsonReport(projectReportPrivacy(candidate, profile)),
        }),
      },
      byteLength: (value) => {
        measured.push(value);
        return Buffer.byteLength(value, "utf8");
      },
    });

    assert.ok(measured.length > 0);
    assert.ok(measured.every((value) => !value.includes(canary)));
    assert.ok(!finalized.stdout.includes(canary));
    const parsed = JSON.parse(finalized.stdout) as ReportV2;
    assert.deepEqual(parsed.analysis_budget, finalized.analysisBudget);
    assert.equal(
      Buffer.byteLength(finalized.stdout, "utf8"),
      finalized.analysisBudget.consumed.output_bytes,
    );
  }
});

test("fallback bytes are identical for different raw secret inputs", () => {
  const maxOutputBytes = Buffer.byteLength(
    OUTPUT_BUDGET_ENVELOPES.json,
    "utf8",
  );
  const run = (canary: string) =>
    finalizeBudgetedOutput({
      report: outputReport(canary),
      meter: outputMeter(maxOutputBytes),
      projection: {
        format: "json",
        render: (candidate) => ({
          output: `${renderJsonReport(candidate)}${canary.repeat(100)}`,
        }),
      },
    });

  const first = run("ghp_FIRST_RAW_SECRET");
  const second = run("ghp_SECOND_RAW_SECRET");

  assert.equal(first.stdout, OUTPUT_BUDGET_ENVELOPES.json);
  assert.equal(second.stdout, OUTPUT_BUDGET_ENVELOPES.json);
  assert.equal(first.stdout, second.stdout);
});
