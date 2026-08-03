import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { analyze } from "../src/core/analyze.js";
import {
  encodeEventIdentity,
  type EventIdentity,
} from "../src/core/event-identity.js";
import type {
  AssistantEvent,
  CommandIdentity,
  Finding,
  GenuineUserEvent,
  MatchedAction,
  Session,
  TimelineAction,
} from "../src/core/model.js";
import { commandIdentityKey } from "../src/analysis/command-identity.js";
import {
  runCommand,
  type CommandRunner,
} from "../src/git/client.js";
import {
  loadAnalyses,
  makeAnalysisRecord,
  saveAnalysis,
  type AnalysisRecord,
  type StoredReadObservation,
} from "../src/store/analyses.js";
import { resolveStorePaths } from "../src/store/paths.js";
import type { AttributedTimelineAction } from "../src/analysis/timeline.js";
import {
  createFindingCandidate,
  findingKey,
  normalizeFindingTarget,
  recoverableClaim,
} from "../src/rules/shared.js";
import { detectRework } from "../src/rules/rework.js";
import { detectRedundantRuns } from "../src/rules/redundant-runs.js";
import {
  detectRediscovery,
  rediscoveryReadIdentityKey,
} from "../src/rules/rediscovery.js";
import {
  APPROVAL_PROMPT_PHRASES,
  detectHumanWait,
} from "../src/rules/human-wait.js";

const READ_OID_A = "a".repeat(40);
const READ_OID_B = "b".repeat(40);
const ANALYZE_NOW_MS = Date.parse("2026-08-01T00:00:00.000Z");

function timelineAction(
  actionId: string,
  startMs: number,
  endMs: number,
  overrides: Partial<TimelineAction> = {},
): TimelineAction {
  return {
    action_id: actionId,
    kind: "tool",
    interval: { start_ms: startMs, end_ms: endMs },
    session_id: "s1",
    agent_id: "root",
    session_refs: [`s1#${actionId}-start`, `s1#${actionId}-end`],
    confidence: "high",
    concurrent: false,
    paths: [],
    ...overrides,
  };
}

function matchedAction(
  actionId: string,
  startMs: number,
  endMs: number,
  match: MatchedAction["match"],
  overrides: Partial<MatchedAction> = {},
): MatchedAction {
  return {
    ...timelineAction(actionId, startMs, endMs),
    match,
    match_confidence: "high",
    relevance_paths: [],
    target: actionId,
    caveats: [],
    ...overrides,
  };
}

function tokenEstimatesByResultIdentity(
  ...entries: readonly (readonly [MatchedAction, number])[]
): ReadonlyMap<string, number> {
  return new Map(entries.map(([action, tokens]) => {
    assert.ok(action.tool_use_id);
    action.result_identity ??= {
      source_adapter_id: "claude",
      source_instance_id: "/test/session.jsonl",
      session_id: action.session_id,
      agent_id: action.agent_id,
      tool_use_id: action.tool_use_id,
      source_index: action.interval.end_ms,
    };
    return [encodeEventIdentity(action.result_identity), tokens] as const;
  }));
}

function commandIdentity(
  repoRelativeCwd: string,
  normalizedArgv: string[] = ["npm", "test"],
  executor: CommandIdentity["executor"] = "shell",
): CommandIdentity {
  return {
    repo_relative_cwd: repoRelativeCwd,
    normalized_argv: [...normalizedArgv],
    executor,
  };
}

function r002FindingKey(identity: CommandIdentity): string {
  const encoded = Buffer.from(commandIdentityKey(identity), "utf8").toString("hex");
  return findingKey("R002", `command-identity:${encoded}`);
}

function eventBase(
  entryUuid: string,
  timestampMs: number,
  sourceIndex: number,
) {
  return {
    timestamp_ms: timestampMs,
    session_id: "s1",
    entry_uuid: entryUuid,
    session_ref: `s1#${entryUuid}`,
    source_index: sourceIndex,
    agent_id: "root",
    is_sidechain: false,
    confidence: "high" as const,
  };
}

function userEvent(
  text: string,
  timestampMs = 0,
  entryUuid = "user",
): GenuineUserEvent {
  return {
    ...eventBase(entryUuid, timestampMs, 0),
    kind: "genuine_user",
    text,
  };
}

function assistantEvent(
  text: string,
  timestampMs: number,
  entryUuid: string,
): AssistantEvent {
  return {
    ...eventBase(entryUuid, timestampMs, 0),
    kind: "assistant",
    text,
  };
}

function historyRecord(
  analysisId: string,
  prRef: string,
  createdAtMs: number,
  findings: readonly Finding[],
  readObservations?: readonly StoredReadObservation[],
): AnalysisRecord {
  return {
    schema_version: 1,
    analysis_id: analysisId,
    created_at_ms: createdAtMs,
    unit: {
      repo: "/repo",
      pr_ref: prRef,
      sessions: [`session-${analysisId}`],
    },
    summary: {
      measured_min: 10,
      idle_excluded_min: 0,
      estimated_floor_min: 9,
      recoverable_min: 1,
      human_wait_min: 0,
      unexplained_min: 1,
      baseline: null,
    },
    findings: [...findings],
    metrics: {},
    command_costs: [],
    ...(readObservations === undefined
      ? {}
      : { read_observations: [...readObservations] }),
  };
}

function storedRead(
  path: string,
  durationMin: number,
  sessionRef: string,
  objectId = READ_OID_A,
  confidence: "low" | "medium" | "high" = "high",
): StoredReadObservation {
  return {
    path,
    object_id: objectId,
    duration_min: durationMin,
    session_refs: [sessionRef],
    confidence,
  } as StoredReadObservation;
}

function storedRediscoveryFinding(
  path: string,
  durationMin: number,
  sessionRef: string,
): Finding {
  return {
    finding_key: findingKey("R003", path),
    rule_id: "R003",
    title: "Repeated file rediscovery",
    classification: "behavior",
    cause: null,
    scope: "claude_md",
    confidence: "high",
    evidence: {
      session_refs: [sessionRef],
      interval_ids: ["R003:historical"],
      paths: [path],
      duration_ms: durationMin * 60_000,
    },
    recoverable: { min: durationMin, bound: "point" },
    fix_recipe: {
      suggestion: "Record the context.",
      verify: "git diff -- CLAUDE.md",
    },
    caveats: [],
  };
}

async function gitForReadTest(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runCommand("git", args, { cwd, timeoutMs: 10_000 });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function writeReadTestFile(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function makeReadRepository(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo);
  await gitForReadTest(repo, ["init", "--initial-branch=main"]);
  await gitForReadTest(repo, ["config", "user.name", "ccprof test"]);
  await gitForReadTest(repo, [
    "config",
    "user.email",
    "ccprof@example.invalid",
  ]);
  await writeReadTestFile(join(repo, "package.json"), "{\"private\":true}\n");
  await writeReadTestFile(
    join(repo, "src/ value.ts "),
    "export const rootValue = 1;\n",
  );
  await writeReadTestFile(
    join(repo, "pkg/src/ value.ts "),
    "export const nestedValue = 1;\n",
  );
  await gitForReadTest(repo, ["add", "."]);
  await gitForReadTest(repo, ["commit", "-m", "base"]);
  for (const branch of ["feature-a", "feature-b", "feature-d", "feature-e"]) {
    await gitForReadTest(repo, ["switch", "main"]);
    await gitForReadTest(repo, ["switch", "-c", branch]);
    await writeReadTestFile(join(repo, `docs/${branch}.md`), `${branch}\n`);
    await gitForReadTest(repo, ["add", "."]);
    await gitForReadTest(repo, ["commit", "-m", branch]);
  }
  await gitForReadTest(repo, ["switch", "main"]);
  await gitForReadTest(repo, ["switch", "-c", "feature-c"]);
  await writeReadTestFile(
    join(repo, "pkg/src/ value.ts "),
    "export const nestedValue = 2;\n",
  );
  await gitForReadTest(repo, ["add", "."]);
  await gitForReadTest(repo, ["commit", "-m", "feature-c"]);
  await gitForReadTest(repo, ["switch", "main"]);
  await gitForReadTest(repo, ["switch", "-c", "feature-g"]);
  await writeReadTestFile(
    join(repo, "pkg/src/ value.ts "),
    "export const nestedValue = 2;\n",
  );
  await gitForReadTest(repo, ["add", "."]);
  await gitForReadTest(repo, ["commit", "-m", "feature-g"]);
  return await realpath(repo);
}

function readSession(
  sessionId: string,
  repo: string,
  confidence: Session["confidence"],
): Session {
  const absoluteRead = sessionId === "read-b";
  const rawPath = absoluteRead
    ? join(repo, "pkg/src/ value.ts ")
    : "src/ value.ts ";
  const cwd = absoluteRead ? undefined : join(repo, "pkg");
  const eventBase = {
    session_id: sessionId,
    agent_id: "main",
    is_sidechain: false,
    confidence: "high" as const,
  };
  return {
    session_id: sessionId,
    source: "claude",
    source_path: join(repo, `${sessionId}.jsonl`),
    observed_cwds: [cwd ?? repo],
    observed_branches: [],
    started_at_ms: ANALYZE_NOW_MS - 120_000,
    ended_at_ms: ANALYZE_NOW_MS - 60_000,
    confidence,
    warnings: [],
    events: [
      {
        ...eventBase,
        kind: "tool_use",
        timestamp_ms: ANALYZE_NOW_MS - 120_000,
        entry_uuid: `${sessionId}-use`,
        session_ref: `${sessionId}#use`,
        source_index: 0,
        tool_use_id: `${sessionId}-read`,
        tool_name: "Read",
        input: { file_path: rawPath },
        paths: [rawPath],
        edit_fragments: [],
        ...(cwd === undefined ? {} : { cwd }),
      },
      {
        ...eventBase,
        kind: "tool_result",
        timestamp_ms: ANALYZE_NOW_MS - 60_000,
        entry_uuid: `${sessionId}-result`,
        session_ref: `${sessionId}#result`,
        source_index: 1,
        tool_use_id: `${sessionId}-read`,
        status: "success",
        output: "export const value = 1;",
        output_bytes: 23,
        estimated_tokens: 25,
      },
    ],
  };
}

function readThenEditSession(
  sessionId: string,
  repo: string,
): Session {
  const session = readSession(sessionId, repo, "high");
  const [readUse, readResult] = session.events;
  assert.ok(readUse?.kind === "tool_use");
  assert.ok(readResult?.kind === "tool_result");
  const use = (
    suffix: string,
    timestamp_ms: number,
    source_index: number,
    tool_use_id: string,
  ) => ({
    ...readUse,
    timestamp_ms,
    source_index,
    entry_uuid: `${sessionId}-${suffix}`,
    session_ref: `${sessionId}#${suffix}`,
    tool_use_id,
  });
  const result = (
    suffix: string,
    timestamp_ms: number,
    source_index: number,
    tool_use_id: string,
  ) => ({
    ...readResult,
    timestamp_ms,
    source_index,
    entry_uuid: `${sessionId}-${suffix}`,
    session_ref: `${sessionId}#${suffix}`,
    tool_use_id,
  });
  return {
    ...session,
    started_at_ms: ANALYZE_NOW_MS - 300_000,
    events: [
      use("pre-use", ANALYZE_NOW_MS - 300_000, 0, "pre"),
      result("pre-result", ANALYZE_NOW_MS - 240_000, 1, "pre"),
      {
        ...use("edit-use", ANALYZE_NOW_MS - 220_000, 2, "edit"),
        tool_name: "Edit",
        input: { file_path: "src/ value.ts " },
        paths: ["src/ value.ts "],
        edit_fragments: ["export const nestedValue = 2;"],
      },
      result("edit-result", ANALYZE_NOW_MS - 180_000, 3, "edit"),
      use("post-use", ANALYZE_NOW_MS - 120_000, 4, "post"),
      result("post-result", ANALYZE_NOW_MS - 60_000, 5, "post"),
    ],
  };
}

test("schema-v1 read observations normalize while legacy records remain loadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-read-store-"));
  try {
    const paths = await resolveStorePaths(join(root, "repo"), {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const observed = makeAnalysisRecord({
      analysis_id: "observed",
      created_at_ms: 1,
      unit: {
        repo: "/repo",
        pr_ref: "main...observed",
        sessions: ["observed"],
      },
      summary: {
        measured_min: 1,
        idle_excluded_min: 0,
        estimated_floor_min: 1,
        recoverable_min: 0,
        human_wait_min: 0,
        unexplained_min: 0,
        baseline: null,
      },
      findings: [],
      metrics: {},
      command_costs: [],
      read_observations: [
        {
          path: "./src\\value.ts",
          object_id: READ_OID_A.toUpperCase(),
          duration_min: 2,
          session_refs: ["s#2", "s#1"],
        },
        storedRead("src/value.ts", 1, "s#1"),
        storedRead(" src/spaced.ts ", 0.5, "s#space", READ_OID_B),
      ],
    });
    assert.deepEqual(observed.read_observations, [
      {
        path: " src/spaced.ts ",
        object_id: READ_OID_B,
        duration_min: 0.5,
        session_refs: ["s#space"],
        confidence: "high",
      },
      {
        path: "src/value.ts",
        object_id: READ_OID_A,
        duration_min: 3,
        session_refs: ["s#1", "s#2"],
        confidence: "low",
      },
    ]);
    assert.throws(
      () =>
        makeAnalysisRecord({
          ...observed,
          analysis_id: "invalid",
          read_observations: [{
            ...storedRead("src/value.ts", 1, "s#read"),
            object_id: "not-an-object-id",
          }],
        }),
      /object_id/iu,
    );

    const legacy = historyRecord("legacy", "main...legacy", 2, []);
    assert.equal(legacy.read_observations, undefined);
    await saveAnalysis(paths, legacy);
    const loaded = await loadAnalyses(paths);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]?.read_observations, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared finding construction hashes normalized targets and stabilizes evidence", () => {
  const action = timelineAction("run", 10, 30);
  const claim = recoverableClaim("R002", " npm   test ", [action]);
  const finding = createFindingCandidate({
    rule_id: "R002",
    title: "Redundant run",
    classification: "behavior",
    cause: null,
    scope: "this_pr",
    confidence: "high",
    target: " npm   test ",
    evidence: {
      session_refs: ["s1#z", "s1#a", "s1#z"],
      interval_ids: ["R002:z", "R002:a", "R002:z"],
      paths: ["src/z.ts", "src/a.ts", "src/z.ts"],
    },
    recoverable: claim,
    fix_recipe: { suggestion: "Use a targeted test.", verify: "npm test" },
    caveats: ["z caveat", "a caveat", "z caveat"],
  });

  const expected = createHash("sha256")
    .update("R002\0npm test")
    .digest("hex");
  assert.equal(finding.finding_key, expected);
  assert.equal(finding.target, "npm test");
  assert.equal(findingKey("R002", "\tnpm test\n"), expected);
  assert.deepEqual(finding.evidence.session_refs, ["s1#a", "s1#z"]);
  assert.deepEqual(finding.evidence.interval_ids, ["R002:a", "R002:z"]);
  assert.deepEqual(finding.evidence.paths, ["src/a.ts", "src/z.ts"]);
  assert.deepEqual(finding.caveats, ["a caveat", "z caveat"]);
  assert.deepEqual(finding.recoverable.intervals, [{
    interval_id: "R002:run",
    target: "npm test",
    start_ms: 10,
    end_ms: 30,
  }]);
});

test("shared finding construction rejects missing evidence and recipes", () => {
  assert.throws(
    () =>
      createFindingCandidate({
        rule_id: "R001",
        title: "Rework",
        classification: "behavior",
        cause: "unknown",
        scope: "separate_issue",
        confidence: "low",
        target: "src/a.ts",
        evidence: { session_refs: [], interval_ids: [] },
        recoverable: {
          bound: "point",
          estimated_ms: 0,
          intervals: [],
        },
        fix_recipe: { suggestion: "", verify: "" },
        caveats: [],
      }),
    /evidence.*recipe/iu,
  );
});

test("R001 requires proven rework and keeps only directly adjacent causal inference", () => {
  const actions = [
    matchedAction("edit-a", 100, 200, "rework_edit", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "edit-a",
      tool_name: "Edit",
    }),
    matchedAction("infer-a", 200, 260, "rework_edit", {
      kind: "inference",
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "edit-a",
      tool_name: "Edit",
    }),
    matchedAction("read", 260, 300, "safe_read", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
    }),
    matchedAction("edit-b", 300, 360, "rework_edit", {
      paths: ["src/b.ts"],
      target: "src/b.ts",
      tool_use_id: "edit-b",
      tool_name: "Edit",
    }),
    matchedAction("not-direct", 370, 450, "rework_edit", {
      kind: "inference",
      paths: ["src/b.ts"],
      target: "src/b.ts",
      tool_use_id: "edit-b",
      tool_name: "Edit",
    }),
  ];
  const findings = detectRework(actions, {
    userEvents: [userEvent("Wrong, redo it.", 90)],
  });

  assert.equal(findings.length, 2);
  const first = findings[0];
  const second = findings[1];
  assert.ok(first !== undefined);
  assert.ok(second !== undefined);
  assert.equal(first.rule_id, "R001");
  assert.equal(first.classification, "behavior");
  assert.equal(first.scope, "separate_issue");
  assert.equal(first.cause, "unknown");
  assert.equal(first.confidence, "high");
  assert.equal(first.recoverable.estimated_ms, 160);
  assert.deepEqual(first.evidence.interval_ids, [
    "R001:edit-a",
    "R001:infer-a",
  ]);
  assert.deepEqual(first.evidence.paths, ["src/a.ts"]);
  assert.deepEqual(first.evidence.session_refs, [
    "s1#edit-a-end",
    "s1#edit-a-start",
    "s1#infer-a-end",
    "s1#infer-a-start",
    "s1#user",
  ]);
  assert.notEqual(first.fix_recipe.suggestion, "");
  assert.notEqual(first.fix_recipe.verify, "");
  assert.equal(first.finding_key, findingKey("R001", "src/a.ts"));
  assert.deepEqual(second.evidence.interval_ids, ["R001:edit-b"]);

  assert.deepEqual(
    detectRework(
      [
        matchedAction("survives", 100, 200, "contributing_edit", {
          paths: ["src/a.ts"],
          target: "src/a.ts",
        }),
      ],
      { userEvents: [userEvent("Wrong, revert it.", 90)] },
    ),
    [],
  );
});

test("R001 includes contiguous matcher-proven test and build runs in a rework block", () => {
  const actions = [
    matchedAction("01-edit-a", 100, 200, "rework_edit", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "edit-a",
      tool_name: "Edit",
    }),
    matchedAction("02-edit-a-inference", 200, 220, "rework_edit", {
      kind: "inference",
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "edit-a",
      tool_name: "Edit",
    }),
    matchedAction("03-test-a", 220, 320, "contributing_run", {
      paths: [],
      relevance_paths: ["src/a.ts"],
      target: "npm test",
      tool_use_id: "test-a",
      tool_name: "Bash",
      command: "npm test",
      normalized_command: "npm test",
      caveats: ["Relevance uses an explicit test map."],
    }),
    matchedAction("04-test-a-inference", 320, 350, "contributing_run", {
      kind: "inference",
      paths: [],
      relevance_paths: ["src/a.ts"],
      target: "npm test",
      tool_use_id: "test-a",
      tool_name: "Bash",
      command: "npm test",
      normalized_command: "npm test",
      caveats: ["Relevance uses an explicit test map."],
    }),
    matchedAction("05-edit-b", 350, 420, "rework_edit", {
      paths: ["src/b.ts"],
      target: "src/b.ts",
      tool_use_id: "edit-b",
      tool_name: "Edit",
    }),
    matchedAction("06-build-b", 420, 520, "contributing_run", {
      relevance_paths: ["src/b.ts"],
      target: "npm run build",
      tool_use_id: "build-b",
      tool_name: "Bash",
      command: "npm run build",
      normalized_command: "npm run build",
      caveats: ["Relevance uses manifest conventions."],
    }),
    matchedAction("07-build-b-inference", 520, 550, "contributing_run", {
      kind: "inference",
      relevance_paths: ["src/b.ts"],
      target: "npm run build",
      tool_use_id: "build-b",
      tool_name: "Bash",
      command: "npm run build",
      normalized_command: "npm run build",
      caveats: ["Relevance uses manifest conventions."],
    }),
  ];

  const finding = detectRework(actions, {
    userEvents: [userEvent("Requirements changed: use this instead.", 90)],
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 450);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R001:01-edit-a",
    "R001:02-edit-a-inference",
    "R001:03-test-a",
    "R001:04-test-a-inference",
    "R001:05-edit-b",
    "R001:06-build-b",
    "R001:07-build-b-inference",
  ]);
  assert.deepEqual(finding.evidence.paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(finding.evidence.edit_count, 2);
  assert.ok(
    (finding.evidence.session_refs as string[]).includes(
      "s1#03-test-a-start",
    ),
  );
  assert.ok(
    (finding.evidence.session_refs as string[]).includes(
      "s1#07-build-b-inference-end",
    ),
  );
  assert.deepEqual(finding.caveats, [
    "Relevance uses an explicit test map.",
    "Relevance uses manifest conventions.",
  ]);
});

test("R001 does not extend a block with unproven, unrelated, or non-contiguous work", () => {
  const run = (
    actionId: string,
    startMs: number,
    match: MatchedAction["match"],
    overrides: Partial<MatchedAction> = {},
  ) =>
    matchedAction(actionId, startMs, startMs + 40, match, {
      paths: [],
      relevance_paths: ["src/a.ts"],
      target: "npm test",
      tool_use_id: actionId,
      tool_name: "Bash",
      command: "npm test",
      normalized_command: "npm test",
      ...overrides,
    });
  const cases = [
    {
      name: "a contributing run tied to another path",
      action: run("unrelated", 200, "contributing_run", {
        relevance_paths: ["src/other.ts"],
      }),
    },
    {
      name: "a contributing run without relation evidence",
      action: run("unproven", 200, "contributing_run", {
        relevance_paths: [],
      }),
    },
    {
      name: "an unknown run",
      action: run("unknown", 200, "unexplained"),
    },
    {
      name: "a redundant run",
      action: run("redundant", 200, "redundant_run"),
    },
    {
      name: "a safe read",
      action: matchedAction("read", 200, 240, "safe_read", {
        paths: ["src/a.ts"],
        target: "src/a.ts",
        tool_use_id: "read",
        tool_name: "Read",
      }),
    },
    {
      name: "a contributing run whose relevance paths mix a rework path with an unrelated path",
      action: run("mixed", 200, "contributing_run", {
        relevance_paths: ["src/a.ts", "src/other.ts"],
      }),
    },
    {
      name: "a non-contiguous related run",
      action: run("late", 201, "contributing_run"),
    },
    {
      name: "a related run in another agent",
      action: run("other-agent", 200, "contributing_run", {
        agent_id: "sidechain",
      }),
    },
    {
      name: "a related run in another session",
      action: run("other-session", 200, "contributing_run", {
        session_id: "s2",
      }),
    },
  ] as const;

  for (const { name, action } of cases) {
    const finding = detectRework(
      [
        matchedAction("edit", 100, 200, "rework_edit", {
          paths: ["src/a.ts"],
          target: "src/a.ts",
          tool_use_id: "edit",
          tool_name: "Edit",
        }),
        action,
        matchedAction(
          `${action.action_id}-inference`,
          action.interval.end_ms,
          action.interval.end_ms + 20,
          action.match,
          {
            kind: "inference",
            paths: [...action.paths],
            relevance_paths: [...action.relevance_paths],
            target: action.target,
            ...(action.tool_use_id === undefined
              ? {}
              : { tool_use_id: action.tool_use_id }),
            ...(action.tool_name === undefined
              ? {}
              : { tool_name: action.tool_name }),
            ...(action.command === undefined
              ? {}
              : { command: action.command }),
            ...(action.normalized_command === undefined
              ? {}
              : { normalized_command: action.normalized_command }),
            session_id: action.session_id,
            agent_id: action.agent_id,
          },
        ),
      ],
      { userEvents: [userEvent("Wrong, redo it.", 90)] },
    )[0];

    assert.ok(finding !== undefined, name);
    assert.equal(finding.recoverable.estimated_ms, 100, name);
    assert.deepEqual(finding.evidence.interval_ids, ["R001:edit"], name);
  }
});

test("R001 assigns only deterministic evidence-backed causes", () => {
  const cases = [
    ["The task description was ambiguous; redo this.", "ambiguous_task", "claude_md"],
    ["Requirements changed: use JSON instead.", "requirements_changed", "this_pr"],
    ["Missing context: this must run on Windows.", "missing_context", "claude_md"],
    ["This was scope creep; remove it.", "scope_creep", "this_pr"],
    ["The tool failed, so revert that edit.", "tool_failure", "separate_issue"],
    ["Wrong, redo it.", "unknown", "separate_issue"],
  ] as const;

  for (const [text, cause, scope] of cases) {
    const finding = detectRework(
      [
        matchedAction("edit", 100, 200, "rework_edit", {
          paths: ["src/a.ts"],
          target: "src/a.ts",
          tool_use_id: "edit",
          tool_name: "Edit",
        }),
      ],
      { userEvents: [userEvent(text, 90)] },
    )[0];
    assert.equal(finding?.cause, cause, text);
    assert.equal(finding?.scope, scope, text);
  }
});

test("R002 groups proven redundant tool runs and retains prior-success relevance evidence", () => {
  const identity = commandIdentity(
    "packages/api",
    ["npm", "test", "", "", "--flag"],
  );
  const actions = [
    matchedAction("run-1", 0, 100, "contributing_run", {
      command: "npm test",
      normalized_command: "npm test",
      target: "npm test",
      tool_use_id: "run-1",
      tool_name: "Bash",
      command_identity: identity,
    }),
    matchedAction("run-2", 200, 500, "redundant_run", {
      command: "npm   test",
      normalized_command: "npm test --later-display",
      target: "npm test",
      paths: ["src/a.ts"],
      tool_use_id: "run-2",
      tool_name: "Bash",
      match_confidence: "high",
      caveats: ["Relevance uses an explicit test map."],
      command_identity: identity,
    }),
    matchedAction("run-2-inference", 500, 700, "redundant_run", {
      kind: "inference",
      command: "npm test",
      normalized_command: "npm test",
      target: "npm test",
      tool_use_id: "run-2",
      tool_name: "Bash",
      command_identity: identity,
    }),
    matchedAction("run-3", 800, 1_000, "redundant_run", {
      command: "npm test",
      normalized_command: "npm test",
      target: "npm test",
      paths: ["src/b.ts"],
      tool_use_id: "run-3",
      tool_name: "Bash",
      match_confidence: "medium",
      caveats: ["Relevance uses manifest conventions."],
      command_identity: identity,
    }),
  ];

  const finding = detectRedundantRuns(actions)[0];
  assert.ok(finding !== undefined);
  assert.equal(finding.rule_id, "R002");
  assert.equal(finding.classification, "behavior");
  assert.equal(finding.scope, "this_pr");
  assert.equal(finding.cause, null);
  assert.equal(finding.confidence, "medium");
  assert.equal(finding.target, "packages/api :: npm test");
  assert.equal(finding.finding_key, r002FindingKey(identity));
  assert.notEqual(finding.finding_key, findingKey("R002", "npm test"));
  assert.equal(finding.evidence.count, 3);
  assert.equal(finding.evidence.irrelevant_count, 2);
  assert.equal(finding.evidence.duration_ms, 500);
  assert.deepEqual(finding.evidence.paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(finding.evidence.prior_success_required, true);
  assert.equal(finding.evidence.prior_success_proven, true);
  assert.equal(finding.evidence.prior_success_basis, "matcher-classification");
  assert.equal(finding.evidence.relevance, "irrelevant");
  assert.equal(finding.evidence.command, "npm test");
  assert.deepEqual(finding.evidence.command_identity, identity);
  assert.ok(
    (finding.evidence.session_refs as string[]).includes("s1#run-1-start"),
  );
  assert.deepEqual(finding.evidence.interval_ids, [
    "R002:run-2",
    "R002:run-3",
  ]);
  assert.equal(finding.recoverable.bound, "point");
  assert.equal(finding.recoverable.estimated_ms, 500);
  assert.match(finding.fix_recipe.suggestion, /packages\/api/u);
  assert.equal(finding.fix_recipe.verify, "npm test");
  assert.deepEqual(finding.caveats, [
    "Relevance uses an explicit test map.",
    "Relevance uses manifest conventions.",
  ]);
});

test("R002 isolates exact identities, excludes missing and inference actions, and is permutation-stable", () => {
  const api = commandIdentity("packages/api");
  const root = commandIdentity(".");
  const native = commandIdentity("packages/api", undefined, "native-tool");
  const argvVariant = commandIdentity("packages/api", ["npm", "test", "", "--flag", ""]);
  const run = (
    id: string,
    start: number,
    identity: CommandIdentity | undefined,
    match: MatchedAction["match"] = "redundant_run",
    overrides: Partial<MatchedAction> = {},
  ) => matchedAction(id, start, start + 100, match, {
    command: "npm test",
    normalized_command: "npm test",
    tool_use_id: id,
    tool_name: "Bash",
    ...(identity === undefined ? {} : { command_identity: identity }),
    ...overrides,
  });
  const actions = [
    run("api-success", 0, api, "contributing_run"),
    run("api-redundant", 200, api, "redundant_run", { paths: ["src/api.ts"] }),
    run("root-redundant", 400, root),
    run("native-redundant", 600, native),
    run("argv-redundant", 800, argvVariant),
    run("missing-identity", 1_000, undefined),
    run("api-inference", 1_200, api, "redundant_run", { kind: "inference" }),
  ];

  const findings = detectRedundantRuns(actions);
  assert.deepEqual(findings, detectRedundantRuns([...actions].reverse()));
  assert.equal(findings.length, 4);
  assert.deepEqual(
    findings.map(({ finding_key }) => finding_key).sort(),
    [api, root, native, argvVariant].map(r002FindingKey).sort(),
  );
  const byKey = new Map(findings.map((finding) => [finding.finding_key, finding]));
  const apiFinding = byKey.get(r002FindingKey(api));
  const rootFinding = byKey.get(r002FindingKey(root));
  const nativeFinding = byKey.get(r002FindingKey(native));
  const argvFinding = byKey.get(r002FindingKey(argvVariant));
  assert.ok(apiFinding && rootFinding && nativeFinding && argvFinding);
  assert.equal(apiFinding.evidence.count, 2);
  assert.equal(apiFinding.evidence.irrelevant_count, 1);
  assert.deepEqual(apiFinding.evidence.paths, ["src/api.ts"]);
  assert.deepEqual(apiFinding.evidence.interval_ids, ["R002:api-redundant"]);
  assert.deepEqual(
    apiFinding.evidence.session_refs,
    [
      "s1#api-success-start",
      "s1#api-success-end",
      "s1#api-redundant-start",
      "s1#api-redundant-end",
    ].sort(),
  );
  assert.equal(rootFinding.target, ". :: npm test");
  assert.equal(
    rootFinding.fix_recipe.suggestion,
    "Use npm run test:affected for scoped edits in repository-relative CWD `.`, then keep `npm test` as the final full validation.",
  );
  assert.equal(nativeFinding.target, "packages/api :: npm test [native-tool]");
  assert.equal(argvFinding.target, apiFinding.target);
  assert.notEqual(argvFinding.finding_key, apiFinding.finding_key);
});

test("R003 claims duplicate reads and only their directly caused post-result inference", () => {
  const actions = [
    matchedAction("first-read", 0, 100, "safe_read", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "first-read",
      tool_name: "Read",
    }),
    matchedAction("duplicate-1", 200, 300, "duplicate_read", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "duplicate-1",
      tool_name: "Read",
    }),
    matchedAction("duplicate-1-inference", 300, 350, "duplicate_read", {
      kind: "inference",
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "duplicate-1",
      tool_name: "Read",
    }),
    matchedAction("post-edit-read", 400, 500, "safe_read", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "post-edit-read",
      tool_name: "Read",
    }),
    matchedAction("duplicate-2", 600, 700, "duplicate_read", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "duplicate-2",
      tool_name: "Read",
      match_confidence: "medium",
    }),
    matchedAction("not-adjacent-inference", 710, 800, "duplicate_read", {
      kind: "inference",
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "duplicate-2",
      tool_name: "Read",
    }),
  ];

  const finding = detectRediscovery(actions, {
    estimatedTokensByEventIdentity: tokenEstimatesByResultIdentity(
      [actions[1]!, 120],
      [actions[4]!, 80],
    ),
  })[0];
  assert.ok(finding !== undefined);
  assert.equal(finding.rule_id, "R003");
  assert.equal(finding.classification, "behavior");
  assert.equal(finding.scope, "claude_md");
  assert.equal(finding.cause, null);
  assert.equal(finding.confidence, "medium");
  assert.equal(
    finding.finding_key,
    findingKey("R003", "src/a.ts"),
  );
  assert.equal(finding.evidence.duplicate_count, 2);
  assert.equal(finding.evidence.duration_ms, 250);
  assert.equal(finding.evidence.estimated_tokens, 200);
  assert.deepEqual(finding.evidence.paths, ["src/a.ts"]);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R003:duplicate-1",
    "R003:duplicate-1-inference",
    "R003:duplicate-2",
  ]);
  assert.equal(finding.recoverable.estimated_ms, 250);
  assert.notEqual(finding.fix_recipe.suggestion, "");
  assert.notEqual(finding.fix_recipe.verify, "");
});

test("R003 uses only the selected full result identity for a 120-vs-900 collision", () => {
  const identity = (
    sourceInstanceId: string,
    sourceIndex: number,
  ): EventIdentity => ({
    source_adapter_id: "claude",
    source_instance_id: sourceInstanceId,
    session_id: "shared-session",
    agent_id: "shared-agent",
    tool_use_id: "shared-tool-id",
    source_index: sourceIndex,
  });
  const selectedResult = identity("/logs/selected.jsonl", 2);
  const collidingResult = identity("/logs/colliding.jsonl", 2);
  const safeRead = matchedAction("safe-source", 0, 10, "safe_read", {
    session_id: "shared-session",
    agent_id: "shared-agent",
    paths: ["src/a.ts"],
    target: "src/a.ts",
    tool_use_id: "shared-tool-id",
    tool_name: "Read",
    event_identity: identity("/logs/colliding.jsonl", 1),
    result_identity: collidingResult,
  });
  const duplicateRead = matchedAction(
    "duplicate-source",
    20,
    30,
    "duplicate_read",
    {
      session_id: "shared-session",
      agent_id: "shared-agent",
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "shared-tool-id",
      tool_name: "Read",
      event_identity: identity("/logs/selected.jsonl", 1),
      result_identity: selectedResult,
    },
  );
  const options = {
    estimatedTokensByEventIdentity: new Map([
      [encodeEventIdentity(selectedResult), 120],
      [encodeEventIdentity(collidingResult), 900],
    ]),
  };

  const forward = detectRediscovery([safeRead, duplicateRead], options);
  const reversed = detectRediscovery([duplicateRead, safeRead], options);

  assert.equal(forward[0]?.evidence.estimated_tokens, 120);
  assert.deepEqual(reversed, forward);
});

test("R003 keeps source-distinct reads with the same action id", () => {
  const read = (
    sourceInstanceId: string,
    startMs: number,
    endMs: number,
  ): MatchedAction => {
    const eventIdentity: EventIdentity = {
      source_adapter_id: "claude",
      source_instance_id: sourceInstanceId,
      session_id: "shared-session",
      agent_id: "shared-agent",
      tool_use_id: "shared-tool-id",
      source_index: 1,
    };
    return matchedAction(
      "shared-action-id",
      startMs,
      endMs,
      "duplicate_read",
      {
        session_id: "shared-session",
        agent_id: "shared-agent",
        paths: ["src/a.ts"],
        target: "src/a.ts",
        tool_use_id: "shared-tool-id",
        tool_name: "Read",
        event_identity: eventIdentity,
        result_identity: { ...eventIdentity, source_index: 2 },
      },
    );
  };
  const reads = [
    read("/logs/a.jsonl", 0, 10),
    read("/logs/b.jsonl", 0, 10),
    read("/logs/c.jsonl", 20, 30),
  ];
  const options = {
    estimatedTokensByEventIdentity: tokenEstimatesByResultIdentity(
      [reads[0]!, 10],
      [reads[1]!, 20],
      [reads[2]!, 30],
    ),
  };

  const forward = detectRediscovery(reads, options)[0];
  const reversed = detectRediscovery([...reads].reverse(), options)[0];
  const unique = recoverableClaim("R003", "src/a.ts", [reads[0]!]);

  assert.ok(forward);
  assert.deepEqual(reversed, forward);
  assert.equal(unique.intervals[0]?.interval_id, "R003:shared-action-id");
  assert.equal(forward.recoverable.estimated_ms, 20);
  assert.equal(forward.recoverable.intervals.length, 3);
  assert.equal(forward.evidence.estimated_tokens, 60);
  assert.equal(forward.evidence.interval_ids.length, 3);
  assert.equal(new Set(forward.evidence.interval_ids).size, 3);
  assert.ok(forward.evidence.interval_ids.every((intervalId) =>
    /^R003:shared-action-id:[0-9a-f]{32}$/u.test(intervalId)
  ));
  assert.equal(JSON.stringify(forward).includes("/logs/"), false);
});

test("R003 preserves missing token evidence when a read has no selected result identity", () => {
  const read = matchedAction("missing-result", 0, 10, "duplicate_read", {
    paths: ["src/a.ts"],
    target: "src/a.ts",
    tool_use_id: "missing-result",
    tool_name: "Read",
  });
  delete read.result_identity;

  const finding = detectRediscovery([read])[0];

  assert.ok(finding);
  assert.equal(finding.evidence.estimated_tokens, 0);
  assert.ok(finding.caveats.some((caveat) =>
    caveat.includes("Token-size evidence was unavailable")
  ));
});

test("R003 requires exact blob identity, aggregates analyses per PR, and claims current work", () => {
  const currentRead = matchedAction("current-read", 0, 120, "safe_read", {
    paths: ["pkg/src/a.ts"],
    target: "pkg/src/a.ts",
    tool_use_id: "current-read",
    tool_name: "Read",
  });
  const prior = [
    historyRecord("old-a-1", "main...old-a", 1, [], [
      storedRead("pkg/src/a.ts", 1, "old-a#read-1"),
    ]),
    historyRecord("old-a-2", "main...old-a", 2, [], [
      storedRead("pkg/src/a.ts", 2, "old-a#read-2"),
    ]),
    historyRecord("old-b", "main...old-b", 3, [], [
      storedRead("pkg/src/a.ts", 0.5, "old-b#read"),
    ]),
    historyRecord("root-path", "main...root", 4, [], [
      storedRead("src/a.ts", 9, "root#read"),
    ]),
    historyRecord("changed", "main...old-d", 5, [], [
      storedRead("pkg/src/a.ts", 8, "old-d#read", READ_OID_B),
    ]),
    historyRecord("legacy", "main...legacy", 6, [
      storedRediscoveryFinding("src/a.ts", 10, "legacy#read"),
    ]),
  ];

  const finding = detectRediscovery([currentRead], {
    history: prior,
    currentObjectIdsByPath: new Map([
      ["pkg/src/a.ts", READ_OID_A],
      ["src/a.ts", READ_OID_A],
    ]),
    estimatedTokensByEventIdentity: tokenEstimatesByResultIdentity(
      [currentRead, 250],
    ),
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.target, "pkg/src/a.ts");
  assert.equal(
    finding.finding_key,
    findingKey("R003", "pkg/src/a.ts"),
  );
  assert.equal(finding.recoverable.estimated_ms, 120);
  assert.deepEqual(finding.evidence.interval_ids, ["R003:current-read"]);
  assert.equal(finding.evidence.duplicate_count, 0);
  assert.equal(finding.evidence.current_read_count, 1);
  assert.equal(finding.evidence.estimated_tokens, 250);
  assert.deepEqual(finding.evidence.historical_prs, [
    "main...old-a",
    "main...old-b",
  ]);
  assert.equal(finding.evidence.historical_duration_min, 2.5);
  assert.deepEqual(finding.evidence.historical_session_refs, [
    "old-a#read-1",
    "old-a#read-2",
    "old-b#read",
  ]);
  assert.match(finding.caveats.join("\n"), /2 prior PRs/iu);
  assert.deepEqual(
    detectRediscovery([currentRead], {
      history: [
        historyRecord("old-a", "main...old-a", 1, [], [
          storedRead("pkg/src/a.ts", 1, "old-a#read"),
        ]),
      ],
      currentObjectIdsByPath: new Map([["pkg/src/a.ts", READ_OID_B]]),
    }),
    [],
  );

  const absoluteRead = {
    ...currentRead,
    action_id: "absolute-read",
    tool_use_id: "absolute-read",
  };
  assert.equal(
    detectRediscovery([absoluteRead], {
      history: prior,
      currentObjectIdsByPath: new Map([["pkg/src/a.ts", READ_OID_A]]),
    })[0]?.target,
    "pkg/src/a.ts",
  );
});

test("R003 gives a multi-path duplicate one canonical verified-history group", () => {
  const read = matchedAction("multi-read", 0, 50, "duplicate_read", {
    paths: ["src/a.ts", "src/b.ts"],
    target: "src/a.ts, src/b.ts",
    tool_use_id: "multi-read",
    tool_name: "Read",
  });
  const findings = detectRediscovery([read], {
    history: [
      historyRecord("old", "main...old", 1, [], [
        storedRead("src/b.ts", 1, "old#read"),
      ]),
    ],
    currentObjectIdsByPath: new Map([["src/b.ts", READ_OID_A]]),
  });

  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.ok(finding);
  assert.equal(finding.target, "src/b.ts");
  assert.equal(finding.recoverable.estimated_ms, 50);
  assert.equal(finding.evidence.historical_duration_min, 1);
});

test("R003 never cross-PR claims a safe multi-path read", () => {
  const read = matchedAction("safe-multi", 0, 50, "safe_read", {
    paths: ["src/a.ts", "src/b.ts"],
    target: "src/a.ts, src/b.ts",
    tool_use_id: "safe-multi",
    tool_name: "Read",
  });
  const eligible = (path: string) => rediscoveryReadIdentityKey(read, path);
  const currentObjectIdsByPath = new Map([
    ["src/a.ts", READ_OID_A],
    ["src/b.ts", READ_OID_A],
  ]);
  const onePathHistory = [historyRecord("old-a", "main...old-a", 1, [], [
    storedRead("src/a.ts", 1, "old-a#read"),
  ])];
  assert.deepEqual(detectRediscovery([read], {
    history: onePathHistory,
    currentObjectIdsByPath,
    crossPrEligibleReadKeys: new Set([eligible("src/a.ts")]),
    estimatedTokensByEventIdentity: tokenEstimatesByResultIdentity(
      [read, 300],
    ),
  }), []);

  const findings = detectRediscovery([read], {
    history: [historyRecord("old-both", "main...old-both", 2, [], [
      storedRead("src/a.ts", 1, "old-both#a"),
      storedRead("src/b.ts", 1, "old-both#b"),
    ])],
    currentObjectIdsByPath,
    crossPrEligibleReadKeys: new Set([
      eligible("src/a.ts"),
      eligible("src/b.ts"),
    ]),
    estimatedTokensByEventIdentity: tokenEstimatesByResultIdentity(
      [read, 300],
    ),
  });
  assert.deepEqual(findings, []);
});

test("R003 finding keys preserve exact path whitespace deterministically", () => {
  const paths = ["src/a b.ts", "src/a  b.ts", "src/trailing.ts "];
  const keys = paths.map((path, index) => {
    const finding = detectRediscovery([
      matchedAction(`read-${index}`, index * 100, index * 100 + 50, "duplicate_read", {
        paths: [path],
        target: path,
        tool_use_id: `read-${index}`,
        tool_name: "Read",
      }),
    ])[0];
    assert.ok(finding);
    assert.equal(
      finding.finding_key,
      findingKey(
        "R003",
        normalizeFindingTarget(path) === path
          ? path
          : `\0path:${Buffer.from(path, "utf16le").toString("hex")}`,
      ),
    );
    return finding.finding_key;
  });
  assert.equal(new Set(keys).size, paths.length);

  const loneSurrogate = "src/a  \ud800.ts";
  const finding = detectRediscovery([
    matchedAction("surrogate", 400, 450, "duplicate_read", {
      paths: [loneSurrogate],
      target: loneSurrogate,
      tool_use_id: "surrogate",
      tool_name: "Read",
    }),
  ])[0];
  assert.ok(finding);
  assert.equal(
    finding.finding_key,
    findingKey(
      "R003",
      `\0path:${Buffer.from(loneSurrogate, "utf16le").toString("hex")}`,
    ),
  );

  const unicodeKeys = ["src/\ud800.ts", "src/\ufffd.ts"].map((path, index) => {
    const candidate = detectRediscovery([
      matchedAction(`unicode-${index}`, 500 + index * 100, 550 + index * 100, "duplicate_read", {
        paths: [path],
        target: path,
        tool_use_id: `unicode-${index}`,
        tool_name: "Read",
      }),
    ])[0];
    assert.ok(candidate);
    return candidate.finding_key;
  });
  assert.equal(new Set(unicodeKeys).size, 2);
});

test("R003 ignores legacy positive findings without versioned read observations", () => {
  const firstSafeRead = matchedAction("first-safe", 0, 100, "safe_read", {
    paths: ["src/a.ts"],
    target: "src/a.ts",
    tool_use_id: "first-safe",
    tool_name: "Read",
  });
  assert.deepEqual(detectRediscovery([firstSafeRead], {
    history: [
      historyRecord("legacy", "main...legacy", 1, [
        storedRediscoveryFinding("src/a.ts", 1, "legacy#duplicate"),
      ]),
    ],
    currentObjectIdsByPath: new Map([["src/a.ts", READ_OID_A]]),
  }), []);
});

test("R003 claims an exact cross-PR read plus its within-PR duplicate once each", () => {
  const actions = [
    matchedAction("first", 0, 50, "safe_read", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "first",
      tool_name: "Read",
    }),
    matchedAction("duplicate", 100, 200, "duplicate_read", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "duplicate",
      tool_name: "Read",
    }),
  ];
  const history = [
    historyRecord("old", "main...old", 1, [], [
      storedRead("src/a.ts", 1, "old#read"),
    ]),
  ];

  const finding = detectRediscovery(actions, {
    history,
    currentObjectIdsByPath: new Map([["src/a.ts", READ_OID_A]]),
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 150);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R003:duplicate",
    "R003:first",
  ]);
  assert.equal(finding.evidence.duplicate_count, 1);
  assert.equal(finding.evidence.current_read_count, 2);
});

test("R003 exact history claims current reads and inference but not historical time", () => {
  const actions = [
    matchedAction("first", 0, 50, "safe_read", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "first",
      tool_name: "Read",
    }),
    matchedAction("first-inference", 50, 90, "safe_read", {
      kind: "inference",
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "first",
      tool_name: "Read",
    }),
    matchedAction("duplicate", 100, 200, "duplicate_read", {
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "duplicate",
      tool_name: "Read",
    }),
    matchedAction("duplicate-inference", 200, 230, "duplicate_read", {
      kind: "inference",
      paths: ["src/a.ts"],
      target: "src/a.ts",
      tool_use_id: "duplicate",
      tool_name: "Read",
    }),
  ];
  const history = [
    historyRecord("old", "main...old", 1, [], [
      storedRead("src/a.ts", 1, "old#read"),
    ]),
  ];

  const finding = detectRediscovery(actions, {
    history,
    currentObjectIdsByPath: new Map([["src/a.ts", READ_OID_A]]),
    estimatedTokensByEventIdentity: tokenEstimatesByResultIdentity(
      [actions[0]!, 1_000],
      [actions[2]!, 200],
    ),
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 220);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R003:duplicate",
    "R003:duplicate-inference",
    "R003:first",
    "R003:first-inference",
  ]);
  assert.equal(finding.evidence.duration_ms, 220);
  assert.equal(finding.evidence.read_duration_ms, 150);
  assert.equal(finding.evidence.post_result_inference_ms, 70);
  assert.equal(finding.evidence.estimated_tokens, 1_200);
  assert.equal(finding.evidence.historical_duration_min, 1);
  assert.deepEqual(finding.evidence.historical_prs, ["main...old"]);
});

test("R003 includes historical observation confidence in its minimum", () => {
  const read = matchedAction("current", 0, 50, "safe_read", {
    paths: ["src/a.ts"],
    target: "src/a.ts",
    tool_use_id: "current",
    tool_name: "Read",
  });
  const finding = detectRediscovery([read], {
    history: [historyRecord("old", "main...old", 1, [], [
      storedRead("src/a.ts", 1, "old#read", READ_OID_A, "low"),
    ])],
    currentObjectIdsByPath: new Map([["src/a.ts", READ_OID_A]]),
  })[0];
  assert.ok(finding);
  assert.equal(finding.confidence, "low");
});

test("analyze stores frozen-head reads, caps session confidence, and omits unverifiable identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-read-analysis-"));
  try {
    const repo = await makeReadRepository(root);
    const paths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const analyzeBranch = async (
      branch: string,
      sessionId: string,
      confidence: Session["confidence"],
      runner?: CommandRunner,
    ) =>
      await analyze({
        cwd: repo,
        pr: `main...${branch}`,
        nowMs: ANALYZE_NOW_MS,
        storePaths: paths,
        sessionSource: {
          discover: async () => [readSession(sessionId, repo, confidence)],
        },
        ...(runner === undefined ? {} : { runner }),
      });

    const first = await analyzeBranch("feature-a", "read-a", "high");
    const blobOid = await gitForReadTest(repo, [
      "rev-parse",
      "feature-a:pkg/src/ value.ts ",
    ]);
    assert.deepEqual(first.record.read_observations, [{
      path: "pkg/src/ value.ts ",
      object_id: blobOid,
      duration_min: 1,
      session_refs: ["read-a#result", "read-a#use"],
      confidence: "high",
    }]);
    assert.equal(
      first.record.read_observations?.some(
        ({ path }) => path === "src/ value.ts ",
      ),
      false,
    );

    const second = await analyzeBranch("feature-b", "read-b", "medium");
    const rediscovery = second.allFindings.find(
      ({ rule_id }) => rule_id === "R003",
    );
    assert.ok(rediscovery);
    assert.equal(rediscovery.confidence, "medium");
    assert.equal(rediscovery.recoverable.min, 1);
    assert.deepEqual(rediscovery.evidence.interval_ids, [
      "R003:read-b#use:tool:read-b-read",
    ]);

    const changed = await analyzeBranch("feature-c", "read-c", "high");
    assert.equal(
      changed.allFindings.some(({ rule_id }) => rule_id === "R003"),
      false,
    );

    const edited = await analyze({
      cwd: repo,
      pr: "main...feature-g",
      nowMs: ANALYZE_NOW_MS,
      storePaths: paths,
      sessionSource: {
        discover: async () => [readThenEditSession("edited", repo)],
      },
    });
    assert.deepEqual(edited.record.read_observations, [{
      path: "pkg/src/ value.ts ",
      object_id: await gitForReadTest(repo, [
        "rev-parse",
        "feature-g:pkg/src/ value.ts ",
      ]),
      duration_min: 1,
      session_refs: ["edited#post-result", "edited#post-use"],
      confidence: "high",
    }]);
    assert.deepEqual(
      edited.allFindings.find(({ rule_id }) => rule_id === "R003")
        ?.evidence.interval_ids,
      ["R003:edited#post-use:tool:post"],
    );

    const failed = await analyze({
      cwd: repo,
      pr: "main...feature-a",
      nowMs: ANALYZE_NOW_MS,
      storePaths: paths,
      sessionSource: {
        discover: async () => [{
          ...readSession("failed", repo, "high"),
          events: readSession("failed", repo, "high").events.map((event) =>
            event.kind === "tool_result"
              ? { ...event, status: "failure" as const }
              : event
          ),
        }],
      },
    });
    assert.deepEqual(failed.record.read_observations, []);

    const malformedRunner: CommandRunner = async (command, args, options) => {
      if (command === "git" && args.includes("ls-tree")) {
        return {
          code: 0,
          stdout: "100644 blob truncated\tpkg/src/ value.ts \0",
          stderr: "",
        };
      }
      return await runCommand(command, args, options);
    };
    const malformed = await analyzeBranch(
      "feature-d",
      "read-d",
      "high",
      malformedRunner,
    );
    assert.deepEqual(malformed.record.read_observations, []);
    assert.ok(
      malformed.warnings.some(
        ({ code }) => code === "read_observation_unavailable",
      ),
    );
    assert.equal(
      malformed.allFindings.some(({ rule_id }) => rule_id === "R003"),
      false,
    );

    const symlinkRunner: CommandRunner = async (command, args, options) => {
      if (command === "git" && args.includes("ls-tree")) {
        return {
          code: 0,
          stdout: `120000 blob ${blobOid}\tpkg/src/ value.ts \0`,
          stderr: "",
        };
      }
      return await runCommand(command, args, options);
    };
    const symlink = await analyzeBranch(
      "feature-e",
      "read-e",
      "high",
      symlinkRunner,
    );
    assert.deepEqual(symlink.record.read_observations, []);
    assert.ok(
      symlink.warnings.some(
        ({ code }) => code === "read_observation_unavailable",
      ),
    );
    assert.equal(
      symlink.allFindings.some(({ rule_id }) => rule_id === "R003"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R004 reports all active wait but claims only explicit or tightly phrased approvals", () => {
  assert.deepEqual(APPROVAL_PROMPT_PHRASES, [
    "allow this command",
    "approval required",
    "permission required",
    "please approve",
    "実行を許可",
    "承認が必要",
    "許可が必要",
  ]);
  const waits: AttributedTimelineAction[] = [
    {
      ...timelineAction("explicit", 0, 120, { kind: "human_wait" }),
      approval: { required: true, reason: "Bash requires approval" },
    },
    {
      ...timelineAction("ordinary", 200, 700, { kind: "human_wait" }),
    },
    {
      ...timelineAction("phrase", 800, 1_000, {
        kind: "human_wait",
        session_refs: ["s1#approval-prompt", "s1#phrase-end"],
      }),
    },
    {
      ...timelineAction("away", 1_000, 5_000, { kind: "away" }),
      approval: { required: true },
    },
  ];

  const finding = detectHumanWait(waits, {
    assistantEvents: [
      assistantEvent(
        "Permission required. Please approve this command.",
        800,
        "approval-prompt",
      ),
    ],
  })[0];
  assert.ok(finding !== undefined);
  assert.equal(finding.rule_id, "R004");
  assert.equal(finding.classification, "config");
  assert.equal(finding.scope, "separate_issue");
  assert.equal(finding.cause, null);
  assert.equal(finding.confidence, "medium");
  assert.equal(finding.finding_key, findingKey("R004", "approval-wait"));
  assert.equal(finding.evidence.count, 3);
  assert.equal(finding.evidence.approval_count, 2);
  assert.equal(finding.evidence.total_wait_ms, 820);
  assert.equal(finding.evidence.approval_wait_ms, 320);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R004:explicit",
    "R004:ordinary",
    "R004:phrase",
  ]);
  assert.deepEqual(finding.recoverable.intervals.map((entry) => entry.interval_id), [
    "R004:explicit",
    "R004:phrase",
  ]);
  assert.equal(finding.recoverable.estimated_ms, 320);
  assert.equal(finding.recoverable.bound, "point");
  assert.notEqual(finding.fix_recipe.suggestion, "");
  assert.notEqual(finding.fix_recipe.verify, "");
  assert.ok(
    finding.caveats.some((caveat) => /evidence only/iu.test(caveat)),
  );
  assert.ok(
    finding.caveats.some((caveat) => /phrase/iu.test(caveat)),
  );
});
