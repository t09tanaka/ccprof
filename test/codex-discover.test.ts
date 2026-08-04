import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  AnalysisBudgetMeter,
  type AnalysisBudgetClock,
  type AnalysisBudgets,
} from "../src/analysis/budgets.js";
import {
  CodexSessionSource,
  discoverCodexSessions,
} from "../src/sources/codex/discover.js";

function analysisBudgets(
  overrides: Partial<AnalysisBudgets> = {},
): AnalysisBudgets {
  return {
    max_input_bytes: 1_000_000,
    max_input_events: 1_000,
    max_wall_ms: 1_000_000,
    max_cpu_ms: 1_000_000,
    max_output_bytes: 1_000_000,
    max_source_items: 1_000,
    ...overrides,
  };
}

const steadyBudgetClock: AnalysisBudgetClock = {
  wall_ms: () => 0,
  cpu_ms: () => 0,
};

function rolloutLine(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function sessionMeta(options: {
  id: string;
  cwd: string;
  branch?: string;
  at?: string;
}): string {
  return rolloutLine({
    timestamp: options.at ?? "2026-07-31T03:00:00.000Z",
    type: "session_meta",
    payload: {
      id: options.id,
      cwd: options.cwd,
      ...(options.branch === undefined
        ? {}
        : { git: { branch: options.branch } }),
    },
  });
}

function userMessage(text: string, at: string): string {
  return rolloutLine({
    timestamp: at,
    type: "response_item",
    payload: { type: "message", role: "user", content: text },
  });
}

function rollout(options: {
  id: string;
  cwd: string;
  branch?: string;
  at?: string;
}): string {
  return (
    sessionMeta(options) +
    userMessage(`hello from ${options.id}`, options.at ?? "2026-07-31T03:00:01.000Z")
  );
}

test("discovers rollout files under YYYY/MM/DD, filtering by cwd, branch, and period", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-discover-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const sessionsDir = join(root, "sessions");
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(repo, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);

  await Promise.all([
    // Matches cwd + branch inside the query window.
    writeFile(
      join(sessionsDir, "2026", "07", "31", "rollout-match.jsonl"),
      rollout({ id: "codex-match", cwd: repo, branch: "feature/codex" }),
    ),
    // Wrong branch.
    writeFile(
      join(sessionsDir, "2026", "07", "31", "rollout-wrong-branch.jsonl"),
      rollout({ id: "codex-wrong-branch", cwd: repo, branch: "main" }),
    ),
    // Outside the repo.
    writeFile(
      join(sessionsDir, "2026", "07", "31", "rollout-outside.jsonl"),
      rollout({ id: "codex-outside", cwd: outside, branch: "feature/codex" }),
    ),
    // Not a rollout file; must be ignored.
    writeFile(
      join(sessionsDir, "2026", "07", "31", "ignored.jsonl"),
      rollout({ id: "codex-ignored", cwd: repo, branch: "feature/codex" }),
    ),
  ]);

  const sessions = await discoverCodexSessions(sessionsDir, {
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.deepEqual(
    sessions.map((session) => session.session_id),
    ["codex-match"],
  );
  assert.equal(sessions[0]?.source, "codex");
});

test("excludes rollout files outside the day-prefiltered window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-period-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const sessionsDir = join(root, "sessions");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "01", "01"), { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);

  await writeFile(
    join(sessionsDir, "2026", "01", "01", "rollout-far.jsonl"),
    rollout({
      id: "codex-far",
      cwd: repo,
      branch: "feature/codex",
      at: "2026-01-01T03:00:00.000Z",
    }),
  );

  const sessions = await discoverCodexSessions(sessionsDir, {
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.deepEqual(sessions, []);
});

test("accepts a branch-less session on cwd match alone, demoting confidence to low", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-branchless-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const sessionsDir = join(root, "sessions");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);

  await writeFile(
    join(sessionsDir, "2026", "07", "31", "rollout-no-branch.jsonl"),
    rollout({ id: "codex-no-branch", cwd: repo }),
  );

  const sessions = await discoverCodexSessions(sessionsDir, {
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.confidence, "low");
});

test("returns an empty array silently when the sessions directory is missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-missing-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });

  const sessions = await discoverCodexSessions(
    join(root, "does-not-exist"),
    {
      repoRoot: repo,
      headBranch: "feature/codex",
      startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
      endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    },
  );

  assert.deepEqual(sessions, []);
});

test("budgeted Codex traversal preserves an earlier session and records a later traversal failure", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows chmod does not make a directory unreadable.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-codex-traversal-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const validDir = join(sessionsDir, "a-valid");
  const unreadableDir = join(sessionsDir, "z-unreadable");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(validDir, { recursive: true }),
    mkdir(unreadableDir, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(
    join(validDir, "rollout-survivor.jsonl"),
    rollout({
      id: "survivor",
      cwd: repo,
      branch: "feature/codex",
    }),
  );
  const meter = new AnalysisBudgetMeter(
    analysisBudgets(),
    steadyBudgetClock,
  );

  await chmod(unreadableDir, 0o000);
  let sessions: Awaited<ReturnType<typeof discoverCodexSessions>>;
  try {
    sessions = await discoverCodexSessions(sessionsDir, {
      repoRoot: repo,
      headBranch: "feature/codex",
      startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
      endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
      analysisBudgetMeter: meter,
    });
  } finally {
    await chmod(unreadableDir, 0o700);
  }

  assert.deepEqual(sessions.map(({ session_id }) => session_id), ["survivor"]);
  assert.equal(meter.result().truncation_reason, "source_failure");
  assert.equal(meter.result().coverage, 0);
});

test("oversized Codex input still records a non-budget parser failure", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows chmod does not make a file unreadable.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-codex-read-error-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions", "2026", "07", "31");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  const sourcePath = join(sessionsDir, "rollout-unreadable.jsonl");
  await writeFile(
    sourcePath,
    rollout({
      id: "unreadable",
      cwd: repo,
      branch: "feature/codex",
    }),
  );
  const meter = new AnalysisBudgetMeter(
    analysisBudgets({ max_input_bytes: 1 }),
    steadyBudgetClock,
  );

  await chmod(sourcePath, 0o000);
  let sessions: Awaited<ReturnType<typeof discoverCodexSessions>>;
  try {
    sessions = await discoverCodexSessions(join(root, "sessions"), {
      repoRoot: repo,
      headBranch: "feature/codex",
      startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
      endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
      analysisBudgetMeter: meter,
    });
  } finally {
    await chmod(sourcePath, 0o600);
  }

  assert.deepEqual(sessions, []);
  assert.equal(meter.result().truncation_reason, "max_input_bytes");
  assert.equal(meter.result().coverage, 0);
});

test("budgeted Codex discovery re-checks wall time after adapter startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-codex-clock-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(
    join(sessionsDir, "2026", "07", "31", "rollout-must-not-open.jsonl"),
    rollout({
      id: "must-not-open",
      cwd: repo,
      branch: "feature/codex",
    }),
  );
  const wallReadings = [0, 0, 1];
  let wallIndex = 0;
  const meter = new AnalysisBudgetMeter(
    analysisBudgets({ max_wall_ms: 0 }),
    {
      wall_ms: () =>
        wallReadings[Math.min(wallIndex++, wallReadings.length - 1)]!,
      cpu_ms: () => 0,
    },
  );

  const sessions = await discoverCodexSessions(sessionsDir, {
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    analysisBudgetMeter: meter,
  });

  assert.deepEqual(sessions, []);
  assert.equal(meter.result().truncation_reason, "max_wall_ms");
  assert.equal(meter.result().observed.source_items, 0);
});

test("budgeted Codex discovery claims a zero source-item budget before stat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-codex-item-first-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  const dayDirectory = join(sessionsRoot, "2026", "07", "31");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(dayDirectory, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  const sourcePath = join(dayDirectory, "rollout-vanishing.jsonl");
  await writeFile(
    sourcePath,
    rollout({
      id: "vanishing",
      cwd: repo,
      branch: "feature/codex",
    }),
  );
  let wallReads = 0;
  const meter = new AnalysisBudgetMeter(
    analysisBudgets({ max_source_items: 0 }),
    {
      wall_ms: () => {
        wallReads += 1;
        if (wallReads === 13) unlinkSync(sourcePath);
        return 0;
      },
      cpu_ms: () => 0,
    },
  );

  const sessions = await discoverCodexSessions(sessionsRoot, {
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    analysisBudgetMeter: meter,
  });

  assert.deepEqual(sessions, []);
  assert.equal(meter.result().truncation_reason, "max_source_items");
  assert.equal(meter.result().observed.source_items, 1);
});

test("budgeted Codex traversal uses locale-independent code-unit order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-codex-order-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  const upperDirectory = join(sessionsRoot, "Z");
  const lowerDirectory = join(sessionsRoot, "a");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(upperDirectory, { recursive: true }),
    mkdir(lowerDirectory, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(upperDirectory, "rollout-upper.jsonl"),
      rollout({ id: "upper", cwd: repo, branch: "feature/codex" }),
    ),
    writeFile(
      join(lowerDirectory, "rollout-lower.jsonl"),
      rollout({ id: "lower", cwd: repo, branch: "feature/codex" }),
    ),
  ]);
  const meter = new AnalysisBudgetMeter(
    analysisBudgets({ max_source_items: 1 }),
    steadyBudgetClock,
  );

  const sessions = await discoverCodexSessions(sessionsRoot, {
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    analysisBudgetMeter: meter,
  });

  assert.deepEqual(sessions.map(({ session_id }) => session_id), ["upper"]);
  assert.equal(meter.result().truncation_reason, "max_source_items");
});

test("a truncated Codex prefix cannot turn a known branch mismatch into branchless acceptance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-codex-branch-prefix-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  const dayDirectory = join(sessionsRoot, "2026", "07", "31");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(dayDirectory, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  const functionCall = (callId: string, at: string): string => rolloutLine({
    timestamp: at,
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: callId,
      arguments: JSON.stringify({ cmd: "pwd", workdir: repo }),
    },
  });
  await writeFile(
    join(dayDirectory, "rollout-wrong-branch-prefix.jsonl"),
    sessionMeta({ id: "wrong-branch", cwd: repo, branch: "main" }) +
      functionCall("call-first", "2026-07-31T03:00:01.000Z") +
      functionCall("call-second", "2026-07-31T03:00:02.000Z"),
  );
  const meter = new AnalysisBudgetMeter(
    analysisBudgets({ max_input_events: 1 }),
    steadyBudgetClock,
  );

  const sessions = await discoverCodexSessions(sessionsRoot, {
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    analysisBudgetMeter: meter,
  });

  assert.deepEqual(sessions, []);
  assert.equal(meter.result().truncation_reason, "max_input_events");
});

test("unbudgeted Codex discovery preserves legacy locale ordering and read errors", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows chmod does not make a file unreadable.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-legacy-order-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  const repo = join(root, "repo");
  const paths = [
    join(sessionsRoot, "Z", "rollout-upper.jsonl"),
    join(sessionsRoot, "a", "rollout-lower.jsonl"),
  ];
  const unreadable = join(sessionsRoot, "z", "rollout-unreadable.jsonl");
  await Promise.all([
    ...paths.map((path) => mkdir(join(path, ".."), { recursive: true })),
    mkdir(join(unreadable, ".."), { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      paths[0]!,
      rollout({ id: "upper", cwd: repo, branch: "feature/codex" }),
    ),
    writeFile(
      paths[1]!,
      rollout({ id: "lower", cwd: repo, branch: "feature/codex" }),
    ),
    writeFile(
      unreadable,
      rollout({ id: "unreadable", cwd: repo, branch: "feature/codex" }),
    ),
  ]);
  await chmod(unreadable, 0o000);
  let sessions: Awaited<ReturnType<typeof discoverCodexSessions>>;
  try {
    sessions = await discoverCodexSessions(sessionsRoot, {
      repoRoot: repo,
      headBranch: "feature/codex",
      startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
      endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    });
  } finally {
    await chmod(unreadable, 0o600);
  }
  const expected = [...paths]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => path.includes("rollout-upper") ? "upper" : "lower");

  assert.deepEqual(sessions.map(({ session_id }) => session_id), expected);
  assert.ok(sessions.every((session) =>
    session.warnings.some(({ code }) => code === "codex_source_read_error")
  ));
});

test("a rollout file with no events (parseCodexSession returns null) is skipped silently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-empty-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const sessionsDir = join(root, "sessions");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(
    join(sessionsDir, "2026", "07", "31", "rollout-empty.jsonl"),
    sessionMeta({ id: "codex-empty", cwd: repo, branch: "feature/codex" }),
  );

  const sessions = await discoverCodexSessions(sessionsDir, {
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.deepEqual(sessions, []);
});

test("CodexSessionSource honors CCPROF_CODEX_SESSIONS_DIR from an injected env", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-env-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const sessionsDir = join(root, "sessions");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(
    join(sessionsDir, "2026", "07", "31", "rollout-env.jsonl"),
    rollout({ id: "codex-env", cwd: repo, branch: "feature/codex" }),
  );

  const source = new CodexSessionSource({
    env: { CCPROF_CODEX_SESSIONS_DIR: sessionsDir },
  });
  const sessions = await source.discover({
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.deepEqual(
    sessions.map((session) => session.session_id),
    ["codex-env"],
  );
});

test("CodexSessionSource sessionsDirectory option takes priority over env", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-priority-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const sessionsDir = join(root, "sessions");
  const envSessionsDir = join(root, "env-sessions");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(join(envSessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(
    join(sessionsDir, "2026", "07", "31", "rollout-direct.jsonl"),
    rollout({ id: "codex-direct", cwd: repo, branch: "feature/codex" }),
  );
  await writeFile(
    join(envSessionsDir, "2026", "07", "31", "rollout-env.jsonl"),
    rollout({ id: "codex-env-should-not-be-used", cwd: repo, branch: "feature/codex" }),
  );

  const source = new CodexSessionSource({
    sessionsDirectory: sessionsDir,
    env: { CCPROF_CODEX_SESSIONS_DIR: envSessionsDir },
  });
  const sessions = await source.discover({
    repoRoot: repo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.deepEqual(
    sessions.map((session) => session.session_id),
    ["codex-direct"],
  );
});

test("future Codex metadata cannot make an in-bound metadata-less rollout eligible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-end-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsDir = join(root, "sessions");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(repo),
  ]);
  await writeFile(
    join(sessionsDir, "2026", "07", "31", "rollout-future-meta.jsonl"),
    userMessage("in boundary", "2026-07-31T03:00:00.000Z") +
      sessionMeta({ id: "future", cwd: repo, branch: "feature/end",
        at: "2026-07-31T05:00:00.000Z" }),
  );

  const sessions = await discoverCodexSessions(sessionsDir, {
    repoRoot: repo, headBranch: "feature/end",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });
  assert.deepEqual(sessions, []);
});

test("rebases a main-checkout Codex cwd into the queried linked worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-worktree-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const sessionsDir = join(root, "sessions");
  const mainRepo = join(root, "main-repo");
  const linkedRepo = join(root, "linked-repo");
  const mainNested = join(mainRepo, "packages", "app");
  const linkedNested = join(linkedRepo, "packages", "app");
  const linkedGitDir = join(mainRepo, ".git", "worktrees", "linked");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(mainNested, { recursive: true }),
    mkdir(linkedNested, { recursive: true }),
    mkdir(linkedGitDir, { recursive: true }),
  ]);
  await writeFile(join(linkedRepo, ".git"), `gitdir: ${linkedGitDir}\n`);
  await writeFile(
    join(sessionsDir, "2026", "07", "31", "rollout-worktree.jsonl"),
    sessionMeta({
      id: "codex-worktree",
      cwd: mainNested,
      branch: "feature/codex",
    }) + rolloutLine({
      timestamp: "2026-07-31T03:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-worktree",
        arguments: JSON.stringify({ cmd: "pwd", workdir: mainNested }),
      },
    }),
  );

  const sessions = await discoverCodexSessions(sessionsDir, {
    repoRoot: linkedRepo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.equal(sessions.length, 1);
  const expectedCwd = await realpath(linkedNested);
  assert.deepEqual(sessions[0]?.observed_cwds, [expectedCwd]);
  const tool = sessions[0]?.events.find((event) => event.kind === "tool_use");
  assert.ok(tool?.kind === "tool_use");
  assert.equal(tool.cwd, expectedCwd);
});
