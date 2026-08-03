import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
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
  ClaudeDiscoveryError,
  ClaudeSessionSource,
  discoverClaudeSessions,
} from "../src/sources/claude/discover.js";

const timestamp = "2026-07-31T03:00:00.000Z";

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

function transcript(options: {
  sessionId: string;
  cwd: string;
  branch?: string;
  at?: string;
}): string {
  const branch =
    options.branch === undefined
      ? ""
      : `,"gitBranch":${JSON.stringify(options.branch)}`;
  return `${JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    cwd: options.cwd,
    sessionId: options.sessionId,
    type: "user",
    message: { role: "user", content: options.sessionId },
    uuid: `${options.sessionId}-entry`,
    timestamp: options.at ?? timestamp,
  }).replace(/}$/, "")}${branch}}\n`;
}

test("discovers recursively in lexical order and filters repo, branch, and time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-discover-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  const repoSrc = join(repo, "src");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(join(projects, "z"), { recursive: true }),
    mkdir(join(projects, "a"), { recursive: true }),
    mkdir(repoSrc, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(
      join(projects, "z", "02.jsonl"),
      transcript({
        sessionId: "session-z",
        cwd: repoSrc,
        branch: "feature/parser",
      }),
    ),
    writeFile(
      join(projects, "a", "01.jsonl"),
      transcript({
        sessionId: "session-a",
        cwd: repo,
        branch: "feature/parser",
      }),
    ),
    writeFile(
      join(projects, "a", "wrong-branch.jsonl"),
      transcript({
        sessionId: "wrong-branch",
        cwd: repo,
        branch: "main",
      }),
    ),
    writeFile(
      join(projects, "a", "outside.jsonl"),
      transcript({
        sessionId: "outside",
        cwd: outside,
        branch: "feature/parser",
      }),
    ),
    writeFile(
      join(projects, "a", "old.jsonl"),
      transcript({
        sessionId: "old",
        cwd: repo,
        branch: "feature/parser",
        at: "2026-07-30T03:00:00.000Z",
      }),
    ),
    writeFile(join(projects, "ignored.txt"), "{}\n"),
  ]);

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.deepEqual(
    sessions.map((session) => session.session_id),
    ["session-a", "session-z"],
  );
});

test("skips transcripts last written before the query window opens", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-mtime-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);

  const stale = join(projects, "stale.jsonl");
  const fresh = join(projects, "fresh.jsonl");
  await Promise.all([
    writeFile(
      stale,
      transcript({
        sessionId: "stale",
        cwd: repo,
        branch: "feature/parser",
      }),
    ),
    writeFile(
      fresh,
      transcript({
        sessionId: "fresh",
        cwd: repo,
        branch: "feature/parser",
      }),
    ),
  ]);
  const staleMtime = new Date(Date.parse("2026-07-31T01:00:00.000Z"));
  await utimes(stale, staleMtime, staleMtime);

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.deepEqual(
    sessions.map((session) => session.session_id),
    ["fresh"],
  );
  assert.deepEqual(
    sessions.flatMap((session) => session.warnings),
    [],
  );
});

test("matches canonical cwd aliases and lowers confidence when branch is absent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-canonical-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  const alias = join(root, "repo-alias");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(join(repo, "nested"), { recursive: true }),
  ]);
  await symlink(repo, alias, "dir");
  await writeFile(
    join(projects, "missing-branch.jsonl"),
    `${transcript({
      sessionId: "missing-branch",
      cwd: join(alias, "nested"),
    })}{malformed\n`,
  );

  const source = new ClaudeSessionSource(projects);
  const sessions = await source.discover({
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.confidence, "medium");
  assert.deepEqual(sessions[0]?.observed_cwds, [
    await realpath(join(repo, "nested")),
  ]);
  assert.ok(
    sessions[0]?.warnings.some(
      (warning) => warning.code === "branch_missing",
    ),
  );
  assert.ok(
    sessions[0]?.warnings.every(
      (warning) => warning.source_path === sessions[0]?.source_path,
    ),
  );
});

test("canonicalizes tool event cwd to the same real path as observed cwds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-event-cwd-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  const repoNested = join(repo, "nested");
  const alias = join(root, "repo-alias");
  const aliasNested = join(alias, "nested");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repoNested, { recursive: true }),
  ]);
  await symlink(repo, alias, "dir");
  const assistantEntry = JSON.stringify({
    parentUuid: "canonical-event-entry",
    isSidechain: false,
    cwd: aliasNested,
    gitBranch: "feature/parser",
    sessionId: "canonical-event",
    type: "assistant",
    message: {
      id: "canonical-event-message",
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "canonical-event-tool",
        name: "Read",
        input: { file_path: "src/value.ts" },
      }],
    },
    uuid: "canonical-assistant-entry",
    timestamp: "2026-07-31T03:00:01.000Z",
  });
  await writeFile(
    join(projects, "canonical-event.jsonl"),
    `${transcript({
      sessionId: "canonical-event",
      cwd: aliasNested,
      branch: "feature/parser",
    })}${assistantEntry}\n`,
  );

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  const session = sessions[0];
  const canonicalCwd = await realpath(repoNested);
  assert.deepEqual(session?.observed_cwds, [canonicalCwd]);
  const toolUse = session?.events.find((event) =>
    event.kind === "tool_use" &&
    event.tool_use_id === "canonical-event-tool"
  );
  assert.ok(toolUse?.kind === "tool_use");
  assert.equal(toolUse.cwd, canonicalCwd);
  assert.equal(toolUse.entry_uuid, "canonical-assistant-entry");
});

test("recognizes another worktree through the shared git directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-worktree-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "main-repo");
  const worktree = join(root, "worktree");
  const worktreeNested = join(worktree, "nested");
  const repoNested = join(repo, "nested");
  const worktreeGitDir = join(repo, ".git", "worktrees", "feature");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(worktreeGitDir, { recursive: true }),
    mkdir(worktreeNested, { recursive: true }),
    mkdir(repoNested, { recursive: true }),
  ]);
  await writeFile(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
  const assistantEntry = JSON.stringify({
    parentUuid: "worktree-session-entry",
    isSidechain: false,
    cwd: worktreeNested,
    gitBranch: "feature/parser",
    sessionId: "worktree-session",
    type: "assistant",
    message: {
      id: "worktree-message",
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "worktree-read",
        name: "Read",
        input: { file_path: "value.ts" },
      }],
    },
    uuid: "worktree-assistant-entry",
    timestamp: "2026-07-31T03:00:01.000Z",
  });
  await writeFile(
    join(projects, "worktree.jsonl"),
    `${transcript({
      sessionId: "worktree-session",
      cwd: worktreeNested,
      branch: "feature/parser",
    })}${assistantEntry}\n`,
  );

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.deepEqual(
    sessions.map((session) => session.session_id),
    ["worktree-session"],
  );
  assert.deepEqual(sessions[0]?.observed_cwds, [
    await realpath(repoNested),
  ]);
  const toolUse = sessions[0]?.events.find((event) =>
    event.kind === "tool_use" && event.tool_use_id === "worktree-read"
  );
  assert.ok(toolUse?.kind === "tool_use");
  assert.equal(toolUse.cwd, await realpath(repoNested));
  assert.deepEqual(toolUse.paths, ["value.ts"]);
});

test("keeps copied transcripts separate even when their session ids and message ids match", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-copies-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  const content = transcript({
    sessionId: "copied-session",
    cwd: repo,
    branch: "feature/parser",
  });
  await Promise.all([
    writeFile(join(projects, "copy-a.jsonl"), content),
    writeFile(join(projects, "copy-b.jsonl"), content),
  ]);

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0]?.source_path, sessions[1]?.source_path);
});

test("skips JSONL symlinks escaping the projects directory and reports source warnings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-symlink-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  await writeFile(
    join(projects, "valid.jsonl"),
    transcript({
      sessionId: "valid-inside",
      cwd: repo,
      branch: "feature/parser",
    }),
  );
  await writeFile(join(projects, "malformed.jsonl"), "{malformed\n");
  const escapedTarget = join(outside, "escaped.jsonl");
  await writeFile(
    escapedTarget,
    transcript({
      sessionId: "must-not-parse",
      cwd: repo,
      branch: "feature/parser",
    }),
  );
  await symlink(escapedTarget, join(projects, "escape.jsonl"));
  await symlink(
    join(outside, "missing.jsonl"),
    join(projects, "broken.jsonl"),
  );

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.deepEqual(
    sessions.map((session) => session.session_id),
    ["valid-inside"],
  );
  assert.ok(
    sessions[0]?.warnings.some(
      (warning) => warning.code === "source_symlink_escape",
    ),
  );
  assert.ok(
    sessions[0]?.warnings.some(
      (warning) => warning.code === "source_read_error",
    ),
  );
  assert.ok(
    sessions[0]?.warnings.some(
      (warning) => warning.code === "source_parse_error",
    ),
  );
});

test("budgeted Claude traversal preserves an earlier session and records a later traversal failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-claude-traversal-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(
    join(projects, "a-valid.jsonl"),
    transcript({
      sessionId: "survivor",
      cwd: repo,
      branch: "feature/parser",
    }),
  );
  await symlink(
    join(root, "missing.jsonl"),
    join(projects, "z-broken.jsonl"),
  );
  const meter = new AnalysisBudgetMeter(
    analysisBudgets(),
    steadyBudgetClock,
  );

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    analysisBudgetMeter: meter,
  });

  assert.deepEqual(sessions.map(({ session_id }) => session_id), ["survivor"]);
  assert.equal(meter.result().truncation_reason, "source_failure");
  assert.equal(meter.result().coverage, 0);
});

test("budgeted Claude discovery re-checks wall time after adapter startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-claude-clock-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(
    join(projects, "must-not-open.jsonl"),
    transcript({
      sessionId: "must-not-open",
      cwd: repo,
      branch: "feature/parser",
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

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    analysisBudgetMeter: meter,
  });

  assert.deepEqual(sessions, []);
  assert.equal(meter.result().truncation_reason, "max_wall_ms");
  assert.equal(meter.result().observed.source_items, 0);
});

test("budgeted Claude discovery claims a zero source-item budget before lstat", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-claude-item-first-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  const sourcePath = join(projects, "vanishing.jsonl");
  await writeFile(
    sourcePath,
    transcript({
      sessionId: "vanishing",
      cwd: repo,
      branch: "feature/parser",
    }),
  );
  let wallReads = 0;
  const meter = new AnalysisBudgetMeter(
    analysisBudgets({ max_source_items: 0 }),
    {
      wall_ms: () => {
        wallReads += 1;
        if (wallReads === 7) unlinkSync(sourcePath);
        return 0;
      },
      cpu_ms: () => 0,
    },
  );

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    analysisBudgetMeter: meter,
  });

  assert.deepEqual(sessions, []);
  assert.equal(meter.result().truncation_reason, "max_source_items");
  assert.equal(meter.result().observed.source_items, 1);
});

test("budgeted Claude discovery claims an item before resolving a transcript symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-budget-claude-symlink-first-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await symlink(
    join(root, "missing.jsonl"),
    join(projects, "broken.jsonl"),
  );
  const meter = new AnalysisBudgetMeter(
    analysisBudgets({ max_source_items: 0 }),
    steadyBudgetClock,
  );

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/parser",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    analysisBudgetMeter: meter,
  });

  assert.deepEqual(sessions, []);
  assert.equal(meter.result().truncation_reason, "max_source_items");
  assert.equal(meter.result().observed.source_items, 1);
});

test("throws a typed discovery error when malformed-only sources yield no sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-source-error-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(join(projects, "malformed.jsonl"), "{malformed\n");

  await assert.rejects(
    discoverClaudeSessions(projects, {
      repoRoot: repo,
      headBranch: "feature/parser",
      startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
      endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
    }),
    (error: unknown) =>
      error instanceof ClaudeDiscoveryError &&
      error.warnings.some((warning) => warning.code === "invalid_json"),
  );
});

function multiBranchRow(options: {
  sessionId: string;
  uuid: string;
  at: string;
  cwd: string;
  branch?: string;
  text?: string;
}): string {
  return JSON.stringify({
    sessionId: options.sessionId,
    type: "user",
    uuid: options.uuid,
    timestamp: options.at,
    cwd: options.cwd,
    ...(options.branch === undefined ? {} : { gitBranch: options.branch }),
    message: { role: "user", content: options.text ?? options.uuid },
  });
}

test("scopes a multi-branch session to the queried head branch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-scope-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  const rows = [
    multiBranchRow({
      sessionId: "multi",
      uuid: "a-1",
      at: "2026-07-31T03:00:00.000Z",
      cwd: repo,
      branch: "feature/a",
    }),
    multiBranchRow({
      sessionId: "multi",
      uuid: "a-2",
      at: "2026-07-31T03:01:00.000Z",
      cwd: repo,
      branch: "feature/a",
    }),
    multiBranchRow({
      sessionId: "multi",
      uuid: "b-1",
      at: "2026-07-31T03:10:00.000Z",
      cwd: repo,
      branch: "feature/b",
    }),
    multiBranchRow({
      sessionId: "multi",
      uuid: "b-tail",
      at: "2026-07-31T03:11:00.000Z",
      cwd: repo,
    }),
  ];
  await writeFile(
    join(projects, "multi.jsonl"),
    `${rows.join("\n")}\n`,
  );
  await writeFile(
    join(projects, "lead.jsonl"),
    `${[
      multiBranchRow({
        sessionId: "lead",
        uuid: "lead-1",
        at: "2026-07-31T03:05:00.000Z",
        cwd: repo,
      }),
      multiBranchRow({
        sessionId: "lead",
        uuid: "lead-2",
        at: "2026-07-31T03:06:00.000Z",
        cwd: repo,
        branch: "feature/b",
      }),
      multiBranchRow({
        sessionId: "lead",
        uuid: "lead-3",
        at: "2026-07-31T03:07:00.000Z",
        cwd: repo,
        branch: "feature/a",
      }),
    ].join("\n")}\n`,
  );

  const query = {
    repoRoot: repo,
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  };
  const forB = await discoverClaudeSessions(projects, {
    ...query,
    headBranch: "feature/b",
  });
  const multiForB = forB.find((session) => session.session_id === "multi");
  assert.ok(multiForB);
  assert.deepEqual(
    multiForB.events.map((event) => event.entry_uuid),
    ["b-1", "b-tail"],
  );
  assert.equal(
    multiForB.started_at_ms,
    Date.parse("2026-07-31T03:10:00.000Z"),
  );
  assert.equal(
    multiForB.ended_at_ms,
    Date.parse("2026-07-31T03:11:00.000Z"),
  );
  assert.ok(
    multiForB.warnings.some((warning) => warning.code === "branch_scoped"),
  );
  assert.equal(multiForB.confidence, "high");

  const leadForB = forB.find((session) => session.session_id === "lead");
  assert.ok(leadForB);
  assert.deepEqual(
    leadForB.events.map((event) => event.entry_uuid),
    ["lead-1", "lead-2"],
  );

  const forA = await discoverClaudeSessions(projects, {
    ...query,
    headBranch: "feature/a",
  });
  const multiForA = forA.find((session) => session.session_id === "multi");
  assert.ok(multiForA);
  assert.deepEqual(
    multiForA.events.map((event) => event.entry_uuid),
    ["a-1", "a-2"],
  );
  assert.equal(
    multiForA.ended_at_ms,
    Date.parse("2026-07-31T03:01:00.000Z"),
  );
});

test("keeps single-branch and branchless sessions unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-single-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(
    join(projects, "single.jsonl"),
    `${[
      multiBranchRow({
        sessionId: "single",
        uuid: "s-1",
        at: "2026-07-31T03:00:00.000Z",
        cwd: repo,
        branch: "feature/only",
      }),
      multiBranchRow({
        sessionId: "single",
        uuid: "s-2",
        at: "2026-07-31T03:01:00.000Z",
        cwd: repo,
      }),
    ].join("\n")}\n`,
  );
  await writeFile(
    join(projects, "branchless.jsonl"),
    `${[
      multiBranchRow({
        sessionId: "branchless",
        uuid: "n-1",
        at: "2026-07-31T03:00:00.000Z",
        cwd: repo,
      }),
    ].join("\n")}\n`,
  );

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/only",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });
  const single = sessions.find((session) => session.session_id === "single");
  assert.ok(single);
  assert.deepEqual(
    single.events.map((event) => event.entry_uuid),
    ["s-1", "s-2"],
  );
  assert.equal(
    single.warnings.some((warning) => warning.code === "branch_scoped"),
    false,
  );
  const branchless = sessions.find(
    (session) => session.session_id === "branchless",
  );
  assert.ok(branchless);
  assert.deepEqual(
    branchless.events.map((event) => event.entry_uuid),
    ["n-1"],
  );
});

test("splits head-other-head sessions into separate segments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-split-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(repo, { recursive: true }),
  ]);
  await writeFile(
    join(projects, "split.jsonl"),
    `${[
      multiBranchRow({
        sessionId: "split",
        uuid: "h-1",
        at: "2026-07-31T03:00:00.000Z",
        cwd: repo,
        branch: "feature/head",
      }),
      multiBranchRow({
        sessionId: "split",
        uuid: "h-2",
        at: "2026-07-31T03:01:00.000Z",
        cwd: repo,
      }),
      multiBranchRow({
        sessionId: "split",
        uuid: "o-1",
        at: "2026-07-31T03:10:00.000Z",
        cwd: repo,
        branch: "feature/other",
      }),
      multiBranchRow({
        sessionId: "split",
        uuid: "o-2",
        at: "2026-07-31T03:20:00.000Z",
        cwd: repo,
      }),
      multiBranchRow({
        sessionId: "split",
        uuid: "h-3",
        at: "2026-07-31T03:30:00.000Z",
        cwd: repo,
        branch: "feature/head",
      }),
      multiBranchRow({
        sessionId: "split",
        uuid: "h-4",
        at: "2026-07-31T03:31:00.000Z",
        cwd: repo,
      }),
    ].join("\n")}\n`,
  );

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo,
    headBranch: "feature/head",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((session) => session.session_id),
    ["split", "split"],
  );
  assert.deepEqual(
    sessions.map((session) => session.events.map((event) => event.entry_uuid)),
    [["h-1", "h-2"], ["h-3", "h-4"]],
  );
  assert.deepEqual(
    sessions.map((session) => [session.started_at_ms, session.ended_at_ms]),
    [
      [
        Date.parse("2026-07-31T03:00:00.000Z"),
        Date.parse("2026-07-31T03:01:00.000Z"),
      ],
      [
        Date.parse("2026-07-31T03:30:00.000Z"),
        Date.parse("2026-07-31T03:31:00.000Z"),
      ],
    ],
  );
  // Segments must not collapse into one timeline lane, so their source
  // identities must differ.
  assert.notEqual(sessions[0]?.source_path, sessions[1]?.source_path);
});

test("discovery forwards the frozen end into Claude parsing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-discover-end-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const projects = join(root, "projects");
  const repo = join(root, "repo");
  await Promise.all([mkdir(projects), mkdir(repo)]);
  const before = transcript({ sessionId: "snapshot", cwd: repo,
    branch: "feature/end", at: "2026-07-31T04:00:00.000Z" })
    .replace("snapshot-entry", "snapshot-before");
  const future = transcript({ sessionId: "snapshot", cwd: repo,
    branch: "feature/end", at: "2026-07-31T05:00:00.000Z" })
    .replace("snapshot-entry", "snapshot-future");
  await writeFile(join(projects, "snapshot.jsonl"), before + future);

  const sessions = await discoverClaudeSessions(projects, {
    repoRoot: repo, headBranch: "feature/end",
    startedAtMs: Date.parse("2026-07-31T03:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });
  assert.deepEqual(sessions[0]?.events.map((event) => event.entry_uuid),
    ["snapshot-before"]);
});
