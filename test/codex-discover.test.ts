import assert from "node:assert/strict";
import {
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
  CodexSessionSource,
  discoverCodexSessions,
} from "../src/sources/codex/discover.js";

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
