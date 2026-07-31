import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ClaudeDiscoveryError,
  ClaudeSessionSource,
  discoverClaudeSessions,
} from "../src/sources/claude/discover.js";

const timestamp = "2026-07-31T03:00:00.000Z";

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

test("recognizes another worktree through the shared git directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-worktree-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const projects = join(root, "projects");
  const repo = join(root, "main-repo");
  const worktree = join(root, "worktree");
  const worktreeGitDir = join(repo, ".git", "worktrees", "feature");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(worktreeGitDir, { recursive: true }),
    mkdir(worktree, { recursive: true }),
  ]);
  await writeFile(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
  await writeFile(
    join(projects, "worktree.jsonl"),
    transcript({
      sessionId: "worktree-session",
      cwd: worktree,
      branch: "feature/parser",
    }),
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
