import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { discoverClaudeSessions, discoverClaudeSessionsObserved } from
  "../src/sources/claude/discover.js";
import { parseClaudeTranscriptDetailed, parseClaudeTranscriptObserved } from
  "../src/sources/claude/parser.js";
import { discoverCodexSessions, discoverCodexSessionsObserved } from
  "../src/sources/codex/discover.js";
import { parseCodexSession, parseCodexSessionObserved } from
  "../src/sources/codex/parser.js";
import {
  createBuiltInSourceCoverageAccumulator,
  unavailableSourceCoverage,
} from "../src/sources/source-coverage.js";

const PARSER_STATE_FINGERPRINT: `sha256:${string}` =
  `sha256:${"a".repeat(64)}`;

async function tempRoot(t: TestContext, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), name));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function claudeRow(repo: string): string {
  return JSON.stringify({ sessionId: "coverage-claude", cwd: repo,
    gitBranch: "feature/coverage", type: "user", uuid: "coverage-user",
    timestamp: "2026-07-31T03:00:00.000Z",
    message: { role: "user", content: "observe me" } });
}

function codexRow(type: string, payload: object): string {
  return JSON.stringify({ timestamp: "2026-07-31T03:00:00.000Z", type, payload });
}

const query = (repoRoot: string) => ({ repoRoot, headBranch: "feature/coverage",
  startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
  endedAtMs: Date.parse("2026-07-31T04:00:00.000Z") });

function expectedFingerprint(adapterId: "claude" | "codex"): string {
  return `sha256:${createHash("sha256")
    .update("source-coverage-schema-v1")
    .update("\0")
    .update(JSON.stringify([
      adapterId,
      "1.0.0",
      "2.0.0",
      PARSER_STATE_FINGERPRINT,
    ]))
    .digest("hex")}`;
}

test("source coverage contract snapshots exact observations", () => {
  const accumulator = createBuiltInSourceCoverageAccumulator(
    "claude",
    "1.0.0",
    "2.0.0",
    PARSER_STATE_FINGERPRINT,
  );

  const initial = accumulator.snapshot();
  assert.deepEqual(initial, {
    status: "available",
    adapter_id: "claude",
    adapter_version: "1.0.0",
    parser_version: "2.0.0",
    schema_fingerprint: expectedFingerprint("claude"),
    files_discovered: 0,
    files_parsed: 0,
    rows_seen: 0,
    rows_accepted: 0,
    events_emitted: 0,
    completeness: "complete",
  });
  assert.equal(Object.isFrozen(initial), true);

  accumulator.recordDiscoveredFile();
  accumulator.recordParsedFile(7, 5, 3, "complete");
  const observed = accumulator.snapshot();
  assert.deepEqual(observed, {
    ...initial,
    files_discovered: 1,
    files_parsed: 1,
    rows_seen: 7,
    rows_accepted: 5,
    events_emitted: 3,
  });
  assert.notEqual(observed, initial);
  assert.equal(Object.isFrozen(observed), true);
});

test("source coverage contract fingerprints are deterministic and adapter-specific", () => {
  const create = (adapterId: "claude" | "codex") =>
    createBuiltInSourceCoverageAccumulator(
      adapterId,
      "1.0.0",
      "2.0.0",
      PARSER_STATE_FINGERPRINT,
    ).snapshot().schema_fingerprint;

  assert.equal(create("claude"), expectedFingerprint("claude"));
  assert.equal(create("claude"), create("claude"));
  assert.equal(create("codex"), expectedFingerprint("codex"));
  assert.notEqual(create("claude"), create("codex"));
  assert.match(create("claude"), /^sha256:[a-f0-9]{64}$/u);
});

test("source coverage contract keeps partial completeness monotonic", () => {
  const accumulator = createBuiltInSourceCoverageAccumulator(
    "codex", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT,
  );
  accumulator.recordDiscoveredFile();
  accumulator.recordParsedFile(1, 1, 0, "partial");
  assert.equal(accumulator.snapshot().completeness, "partial");

  accumulator.recordDiscoveredFile();
  accumulator.recordParsedFile(0, 0, 0, "complete");
  accumulator.markPartial();
  assert.equal(accumulator.snapshot().completeness, "partial");
});

test("source coverage contract rejects invalid identities and observations", () => {
  const create = (...values: unknown[]) =>
    createBuiltInSourceCoverageAccumulator(...values as [
      "claude", "1.0.0", string, `sha256:${string}`,
    ]);
  const invalidCreates: unknown[][] = [
    ["custom", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT],
    ["claude", "2.0.0", "2.0.0", PARSER_STATE_FINGERPRINT],
    ["claude", "1.0.0", "", PARSER_STATE_FINGERPRINT],
    ["claude", "1.0.0", "x".repeat(257), PARSER_STATE_FINGERPRINT],
    ["claude", "1.0.0", "2.0.0", "sha256:ABC"],
  ];
  for (const values of invalidCreates) assert.throws(() => create(...values), TypeError);

  const invalidCounts = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalidCounts) {
    const accumulator = create("claude", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT);
    accumulator.recordDiscoveredFile();
    assert.throws(() => accumulator.recordParsedFile(value, 0, 0, "complete"), TypeError);
    assert.throws(() => accumulator.recordParsedFile(0, value, 0, "complete"), TypeError);
    assert.throws(() => accumulator.recordParsedFile(0, 0, value, "complete"), TypeError);
  }

  const impossibleRows = create("claude", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT);
  impossibleRows.recordDiscoveredFile();
  assert.throws(() => impossibleRows.recordParsedFile(1, 2, 0, "complete"), TypeError);

  const undiscovered = create("claude", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT);
  assert.throws(() => undiscovered.recordParsedFile(0, 0, 0, "complete"), TypeError);
});

test("source coverage contract rejects non-string parser fingerprints without coercion", () => {
  let coercions = 0;
  const fingerprint = {
    toString(): string {
      coercions += 1;
      return PARSER_STATE_FINGERPRINT;
    },
  };
  assert.throws(() => createBuiltInSourceCoverageAccumulator(
    "claude", "1.0.0", "2.0.0",
    fingerprint as unknown as `sha256:${string}`,
  ), TypeError);
  assert.equal(coercions, 0);
});

test("source coverage contract rejects counter overflow", () => {
  const accumulator = createBuiltInSourceCoverageAccumulator(
    "claude", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT,
  );
  accumulator.recordDiscoveredFile();
  accumulator.recordParsedFile(Number.MAX_SAFE_INTEGER, 0, 0, "complete");
  accumulator.recordDiscoveredFile();
  assert.throws(
    () => accumulator.recordParsedFile(1, 0, 0, "complete"),
    TypeError,
  );
});

test("source coverage contract exposes one frozen unavailable value", () => {
  const first = unavailableSourceCoverage();
  const second = unavailableSourceCoverage();
  assert.deepEqual(first, { status: "unavailable" });
  assert.equal(first, second);
  assert.equal(Object.isFrozen(first), true);
});

test("cold parser coverage preserves Claude and Codex results with truthful loss", async (t) => {
  const root = await tempRoot(t, "ccprof-coverage-parser-");
  const repo = join(root, "repo");
  await mkdir(repo);
  const claudePath = join(root, "claude.jsonl");
  await writeFile(claudePath, `${claudeRow(repo)}\n{malformed\n`);
  const claudeObserved = await parseClaudeTranscriptObserved(claudePath);
  assert.deepEqual(claudeObserved.result,
    await parseClaudeTranscriptDetailed(claudePath));
  assert.deepEqual(claudeObserved.observation, {
    rows_seen: 2, rows_accepted: 1, events_emitted: 1,
    completeness: "partial",
  });

  const codexPath = join(root, "rollout-parser.jsonl");
  await writeFile(codexPath, `${[
    codexRow("session_meta", { id: "coverage-codex", cwd: repo,
      git: { branch: "feature/coverage" } }),
    codexRow("response_item", { type: "message", role: "user",
      content: "observe me" }),
    "{malformed",
  ].join("\n")}\n`);
  const codexObserved = await parseCodexSessionObserved({ sourcePath: codexPath });
  const codexLegacy = await parseCodexSession({ sourcePath: codexPath });
  assert.ok(codexObserved.result); assert.ok(codexLegacy);
  assert.deepEqual({ ...codexObserved.result, warnings: [...codexObserved.result.warnings] },
    { ...codexLegacy, warnings: [...codexLegacy.warnings] });
  for (const warnings of [codexObserved.result.warnings, codexLegacy.warnings]) {
    const descriptor = Object.getOwnPropertyDescriptor(warnings, "push");
    assert.equal(typeof descriptor?.value, "function");
    assert.deepEqual({ enumerable: descriptor?.enumerable,
      writable: descriptor?.writable, configurable: descriptor?.configurable },
    { enumerable: true, writable: true, configurable: true });
  }
  assert.deepEqual(codexObserved.observation, {
    rows_seen: 3, rows_accepted: 2, events_emitted: 1,
    completeness: "partial",
  });
});

test("cold parser coverage marks a dropped unknown Codex subtype partial", async (t) => {
  const root = await tempRoot(t, "ccprof-coverage-unknown-");
  const path = join(root, "rollout-unknown.jsonl");
  await writeFile(path, `${[
    codexRow("session_meta", { id: "coverage-unknown", cwd: root }),
    codexRow("response_item", { type: "future_item" }),
  ].join("\n")}\n`);
  const observed = await parseCodexSessionObserved({ sourcePath: path });
  assert.equal(observed.result, null);
  assert.equal(observed.observation.completeness, "partial");
});

test("cold parser coverage counts events before analysis-window filtering", async (t) => {
  const root = await tempRoot(t, "ccprof-coverage-window-");
  const repo = join(root, "repo"); await mkdir(repo);
  const claudePath = join(root, "claude-window.jsonl");
  const claudeEarly = JSON.parse(claudeRow(repo)) as Record<string, unknown>;
  const claudeLate = { ...claudeEarly, uuid: "coverage-late",
    timestamp: "2026-07-31T05:00:00.000Z" };
  await writeFile(claudePath,
    `${JSON.stringify(claudeEarly)}\n${JSON.stringify(claudeLate)}\n`);
  const claude = await parseClaudeTranscriptObserved(claudePath, {
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });
  assert.equal(claude.result.sessions[0]?.events.length, 1);
  assert.equal(claude.observation.events_emitted, 2);

  const codexPath = join(root, "rollout-window.jsonl");
  const timed = (timestamp: string, type: string, payload: object) =>
    JSON.stringify({ timestamp, type, payload });
  await writeFile(codexPath, `${[
    timed("2026-07-31T02:00:00.000Z", "session_meta",
      { id: "coverage-window", cwd: repo }),
    timed("2026-07-31T03:00:00.000Z", "response_item",
      { type: "message", role: "user", content: "early" }),
    timed("2026-07-31T05:00:00.000Z", "response_item",
      { type: "message", role: "user", content: "late" }),
  ].join("\n")}\n`);
  const codex = await parseCodexSessionObserved({ sourcePath: codexPath,
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z") });
  assert.equal(codex.result?.events.length, 1);
  assert.equal(codex.observation.events_emitted, 2);
});

test("cold parser coverage reports bounded reads as partial", async (t) => {
  const root = await tempRoot(t, "ccprof-coverage-budget-");
  const repo = join(root, "repo"); await mkdir(repo);
  const first = claudeRow(repo);
  const path = join(root, "bounded.jsonl");
  await writeFile(path, `${first}\n${claudeRow(repo)}\n`);
  const observed = await parseClaudeTranscriptObserved(path, {
    budgets: { maxFileBytes: Buffer.byteLength(first) + 1 },
  });
  assert.equal(observed.observation.completeness, "partial");
  assert.ok(observed.observation.rows_accepted <= observed.observation.rows_seen);
});

test("cold discovery coverage deduplicates and prefilters Claude candidates", async (t) => {
  const root = await tempRoot(t, "ccprof-coverage-claude-");
  const repo = join(root, "repo"); const projects = join(root, "projects");
  await Promise.all([mkdir(repo), mkdir(projects)]);
  const source = join(projects, "source.jsonl");
  await writeFile(source, `${claudeRow(repo)}\n`);
  await symlink(source, join(projects, "alias.jsonl"));
  const old = join(projects, "old.jsonl");
  await writeFile(old, `${claudeRow(repo)}\n`);
  const oldTime = new Date("2026-07-30T00:00:00.000Z");
  await utimes(old, oldTime, oldTime);
  await writeFile(join(projects, "ignored.txt"), "{}\n");

  const observed = await discoverClaudeSessionsObserved(projects, query(repo));
  assert.deepEqual(observed.sessions,
    await discoverClaudeSessions(projects, query(repo)));
  assert.deepEqual(observed.source_coverage, {
    status: "available", adapter_id: "claude", adapter_version: "1.0.0",
    parser_version: "2.0.0",
    schema_fingerprint: observed.source_coverage.status === "available"
      ? observed.source_coverage.schema_fingerprint : "unreachable",
    files_discovered: 1, files_parsed: 1, rows_seen: 1, rows_accepted: 1,
    events_emitted: 1, completeness: "complete",
  });
  await assert.rejects(
    discoverClaudeSessionsObserved(join(root, "missing"), query(repo)),
    { name: "ClaudeDiscoveryError" },
  );
});

test("cold discovery coverage distinguishes missing, empty, and zero-event Codex roots", async (t) => {
  const root = await tempRoot(t, "ccprof-coverage-codex-");
  const repo = join(root, "repo"); const sessions = join(root, "sessions");
  const day = join(sessions, "2026", "07", "31");
  await Promise.all([mkdir(repo), mkdir(day, { recursive: true })]);
  await writeFile(join(day, "rollout-meta.jsonl"), `${codexRow("session_meta", {
    id: "coverage-meta", cwd: repo, git: { branch: "feature/coverage" },
  })}\n`);
  const oldDay = join(sessions, "2026", "01", "01"); await mkdir(oldDay, { recursive: true });
  await writeFile(join(oldDay, "rollout-old.jsonl"), `${codexRow("session_meta", {
    id: "old", cwd: repo, git: { branch: "feature/coverage" },
  })}\n`);
  await writeFile(join(day, "ignored.jsonl"), "{}\n");

  const observed = await discoverCodexSessionsObserved(sessions, query(repo));
  assert.deepEqual(observed.sessions,
    await discoverCodexSessions(sessions, query(repo)));
  assert.equal(observed.source_coverage.status, "available");
  if (observed.source_coverage.status === "available") {
    assert.deepEqual({ ...observed.source_coverage,
      schema_fingerprint: "fingerprint" }, {
      status: "available", adapter_id: "codex", adapter_version: "1.0.0",
      parser_version: "2.0.0", schema_fingerprint: "fingerprint",
      files_discovered: 1, files_parsed: 1, rows_seen: 1, rows_accepted: 1,
      events_emitted: 0, completeness: "complete",
    });
  }
  const empty = join(root, "empty"); await mkdir(empty);
  const emptyObserved = await discoverCodexSessionsObserved(empty, query(repo));
  assert.equal(emptyObserved.source_coverage.status, "available");
  if (emptyObserved.source_coverage.status === "available")
    assert.equal(emptyObserved.source_coverage.files_discovered, 0);
  const missing = await discoverCodexSessionsObserved(join(root, "missing"), query(repo));
  assert.deepEqual(missing, { sessions: [], source_coverage: { status: "unavailable" } });

  const links = join(root, "links"); await mkdir(links);
  await symlink(join(day, "rollout-meta.jsonl"),
    join(links, "rollout-link.jsonl"));
  const linked = await discoverCodexSessionsObserved(links, query(repo));
  assert.deepEqual(linked.sessions, await discoverCodexSessions(links, query(repo)));
  assert.equal(linked.source_coverage.status, "available");
  if (linked.source_coverage.status === "available") {
    assert.equal(linked.source_coverage.files_discovered, 0);
    assert.equal(linked.source_coverage.completeness, "partial");
  }
});
