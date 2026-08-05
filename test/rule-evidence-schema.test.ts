import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import type { AttributedTimelineAction } from "../src/analysis/timeline.js";
import type { EventIdentity } from "../src/core/event-identity.js";
import type {
  CommandIdentity,
  CompactionEvent,
  Finding,
  FindingCandidate,
  JsonObject,
  MatchedAction,
  RuleId,
  TimelineAction,
  ToolResultEvent,
} from "../src/core/model.js";
import { resolveRuleSafetyPolicy } from "../src/policy/rule-safety.js";
import {
  detectChronicCost,
  materializeChronicCostFindings,
} from "../src/rules/chronic-cost.js";
import { detectContextBloat } from "../src/rules/context-bloat.js";
import { detectFlakyTests } from "../src/rules/flaky-test.js";
import { detectHumanWait } from "../src/rules/human-wait.js";
import { listRuleManifests } from "../src/rules/manifest.js";
import {
  detectRediscovery,
  rediscoveryReadIdentityKey,
} from "../src/rules/rediscovery.js";
import { detectRedundantRuns } from "../src/rules/redundant-runs.js";
import { detectRework } from "../src/rules/rework.js";
import { detectSerialSlack } from "../src/rules/serial-slack.js";
import type { AnalysisRecord } from "../src/store/analyses.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_PATH = "schemas/builtin-rule-evidence.schema.json";
const IDENTITY: CommandIdentity = {
  repo_relative_cwd: ".",
  normalized_argv: ["npm", "test", ""],
  executor: "shell",
};

function eventIdentity(toolUseId: string, sourceIndex: number): EventIdentity {
  return {
    source_adapter_id: "claude",
    source_instance_id: "/fixture/session.jsonl",
    session_id: "session",
    agent_id: "root",
    tool_use_id: toolUseId,
    source_index: sourceIndex,
  };
}

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
    session_id: "session",
    agent_id: "root",
    session_refs: [`session#${actionId}`],
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

function normalizedEventBase(
  entryUuid: string,
  timestampMs: number,
  sourceIndex: number,
) {
  return {
    timestamp_ms: timestampMs,
    session_id: "session",
    entry_uuid: entryUuid,
    session_ref: `session#${entryUuid}`,
    source_index: sourceIndex,
    agent_id: "root",
    is_sidechain: false,
    confidence: "high" as const,
  };
}

function toolResult(
  toolUseId: string,
  timestampMs: number,
  sourceIndex: number,
  status: "success" | "failure",
  exitCode: number,
): ToolResultEvent {
  const output = status === "failure" ? "not ok 1 - schema fixture" : "ok 1";
  return {
    ...normalizedEventBase(`${toolUseId}-result`, timestampMs, sourceIndex),
    event_identity: eventIdentity(toolUseId, sourceIndex),
    kind: "tool_result",
    tool_use_id: toolUseId,
    status,
    output,
    output_bytes: Buffer.byteLength(output),
    estimated_tokens: 4,
    exit_code: exitCode,
  };
}

function analysisRecord(
  index: number,
  overrides: Partial<AnalysisRecord> = {},
): AnalysisRecord {
  return {
    schema_version: 1,
    analysis_id: `analysis-${index}`,
    created_at_ms: index,
    unit: {
      repo: "repository",
      pr_ref: `main...feature-${index}`,
      sessions: [`history-${index}`],
    },
    summary: {
      measured_min: 10,
      idle_excluded_min: 0,
      estimated_floor_min: 10,
      recoverable_min: 0,
      human_wait_min: 0,
      unexplained_min: 0,
      baseline: null,
    },
    findings: [],
    metrics: {},
    command_costs: [],
    ...overrides,
  };
}

function one(
  findings: readonly FindingCandidate[],
  ruleId: RuleId,
): FindingCandidate {
  const finding = findings[0];
  assert.ok(finding, `fixture must emit ${ruleId}`);
  assert.equal(finding.rule_id, ruleId);
  return finding;
}

function runtimeEvidenceSamples(): Map<RuleId, JsonObject[]> {
  const samples = new Map<RuleId, JsonObject[]>();
  const add = (finding: FindingCandidate): FindingCandidate => {
    const current = samples.get(finding.rule_id) ?? [];
    current.push(finding.evidence);
    samples.set(finding.rule_id, current);
    return finding;
  };

  add(one(detectRework([
    matchedAction("rework", 0, 20, "rework_edit", {
      paths: ["src/value.ts"],
    }),
  ]), "R001"));

  add(one(detectRedundantRuns([
    matchedAction("first", 0, 10, "contributing_run", {
      command: "npm test",
      normalized_command: "npm test",
      command_identity: IDENTITY,
    }),
    matchedAction("repeat", 10, 30, "redundant_run", {
      command: "npm test",
      normalized_command: "npm test",
      command_identity: IDENTITY,
      paths: ["test/value.test.ts"],
    }),
  ]), "R002"));

  const historicalRead = matchedAction("historical-read", 0, 15, "safe_read", {
    paths: ["src/value.ts"],
    tool_use_id: "historical-read",
  });
  const objectId = "a".repeat(40);
  add(one(detectRediscovery([historicalRead], {
    history: [analysisRecord(1, {
      read_observations: [{
        path: "src/value.ts",
        object_id: objectId,
        duration_min: 1,
        session_refs: ["history#read"],
        confidence: "high",
      }],
    })],
    currentObjectIdsByPath: new Map([["src/value.ts", objectId]]),
    crossPrEligibleReadKeys: new Set([
      rediscoveryReadIdentityKey(historicalRead, "src/value.ts"),
    ]),
  }), "R003"));

  const genericWait: AttributedTimelineAction = {
    ...timelineAction("generic-wait", 0, 25, {
      kind: "human_wait",
      command: "npm test",
    }),
    approval: { required: true, reason: "approval required" },
  };
  add(one(detectHumanWait([genericWait]), "R004"));
  const safeApprovalPolicy = resolveRuleSafetyPolicy({
    safe_patterns: ["npm *"],
    allow_rule_recommendation: true,
  }, []);
  add(one(detectHumanWait([
    genericWait,
    {
      ...genericWait,
      action_id: "repeat-wait",
      interval: { start_ms: 30, end_ms: 55 },
      session_refs: ["session#repeat-wait"],
    },
  ], { ruleSafety: safeApprovalPolicy }), "R004"));

  const serialActions = [
    matchedAction("read-a", 0, 20, "safe_read", {
      command: "cat src/a.ts",
      paths: ["src/a.ts"],
    }),
    matchedAction("read-b", 20, 50, "safe_read", {
      command: "cat test/b.test.ts",
      paths: ["test/b.test.ts"],
    }),
  ];
  add(one(detectSerialSlack(serialActions), "R005"));
  add(one(detectSerialSlack(serialActions, {
    ruleSafety: resolveRuleSafetyPolicy(undefined, [{
      match: ["cat *"],
      domain: "read-files",
      parallel_safe: true,
    }]),
  }), "R005"));

  const chronicHistory = Array.from({ length: 5 }, (_, index) =>
    analysisRecord(index + 10, {
      command_costs: [{
        command: "npm test",
        command_identity: IDENTITY,
        duration_min: 5,
        session_refs: [`history#command-${index}`],
      }],
    }));
  add(one(detectChronicCost(chronicHistory), "R006"));
  add(one(materializeChronicCostFindings([{
    cohort_key: "b".repeat(64),
    command_key: "c".repeat(64),
    cache_state: "cold",
    history_count: 5,
    presence_count: 5,
    distribution: {
      median: 100,
      p50: 100,
      p75: 120,
      mad: 10,
      sample_count: 5,
    },
    ratio: 0.5,
    resource_upper_ms: 100,
  }], [{
    cohort_key: "b".repeat(64),
    command_key: "c".repeat(64),
    cache_state: "cold",
    command: "npm test",
    command_identity: IDENTITY,
    session_refs: ["history#materialized"],
  }]), "R006"));

  const compaction: CompactionEvent = {
    ...normalizedEventBase("compaction", 100, 0),
    kind: "compaction",
    summary: "compacted",
    estimated_tokens: 60_000,
  };
  add(one(detectContextBloat([], { events: [compaction] }), "R007"));

  const failedAction = matchedAction("failed", 0, 10, "contributing_run", {
    tool_use_id: "failed",
    command: "npm test",
    normalized_command: "npm test",
    command_identity: IDENTITY,
    event_identity: eventIdentity("failed", 0),
  });
  const passedAction = matchedAction("passed", 20, 30, "contributing_run", {
    tool_use_id: "passed",
    command: "npm test",
    normalized_command: "npm test",
    command_identity: IDENTITY,
    event_identity: eventIdentity("passed", 2),
  });
  const results = [
    toolResult("failed", 10, 1, "failure", 1),
    toolResult("passed", 30, 3, "success", 0),
  ];
  const currentFlaky = add(one(detectFlakyTests(
    [failedAction, passedAction],
    { toolResults: results },
  ), "R008"));
  const historicalFinding: Finding = {
    finding_key: "historical-flaky",
    rule_id: "R008",
    title: "Historical flaky test",
    target: "npm test",
    classification: "repo",
    cause: null,
    scope: "separate_issue",
    confidence: "high",
    evidence: currentFlaky.evidence,
    recoverable: { min: 1, bound: "point" },
    fix_recipe: { suggestion: "Fix the test", verify: "npm test" },
    caveats: [],
  };
  add(one(detectFlakyTests([failedAction, passedAction], {
    toolResults: results,
    history: [analysisRecord(99, { findings: [historicalFinding] })],
  }), "R008"));

  return samples;
}

async function schemaBundle(): Promise<Record<string, unknown>> {
  const raw = await readFile(resolve(process.cwd(), SCHEMA_PATH), "utf8");
  const value: unknown = JSON.parse(raw);
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function validators(
  bundle: Record<string, unknown>,
): Map<RuleId, ValidateFunction> {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictTuples: false,
  });
  ajv.addSchema(bundle);
  return new Map(listRuleManifests().map((manifest) => {
    const validate = ajv.getSchema(manifest.evidence_schema);
    assert.ok(validate, `missing schema resource ${manifest.evidence_schema}`);
    assert.equal(
      (validate.schema as Record<string, unknown>).$id,
      manifest.evidence_schema,
    );
    assert.equal(
      (validate.schema as Record<string, unknown>).$schema,
      DRAFT_2020_12,
    );
    assert.match(
      manifest.evidence_schema,
      new RegExp(`/evidence/v${manifest.compatibility_epoch}$`, "u"),
    );
    assert.equal(
      ajv.getSchema(
        manifest.evidence_schema.replace(
          /v\d+$/u,
          `v${manifest.compatibility_epoch + 1}`,
        ),
      ),
      undefined,
    );
    return [manifest.id, validate] as const;
  }));
}

test("all manifest evidence URIs resolve and accept current runtime evidence", async () => {
  const bundle = await schemaBundle();
  assert.equal(bundle.$schema, DRAFT_2020_12);
  const validateByRule = validators(bundle);
  const samples = runtimeEvidenceSamples();

  assert.deepEqual([...samples.keys()], listRuleManifests().map(({ id }) => id));
  for (const [ruleId, ruleSamples] of samples) {
    assert.ok(ruleSamples.length > 0);
    for (const evidence of ruleSamples) {
      const validate = validateByRule.get(ruleId);
      assert.ok(validate);
      assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
    }
  }
});

test("every rule evidence resource rejects missing, mistyped, extra, and crossed data", async () => {
  const validateByRule = validators(await schemaBundle());
  const samples = runtimeEvidenceSamples();
  const manifests = listRuleManifests();

  for (const [index, manifest] of manifests.entries()) {
    const validate = validateByRule.get(manifest.id);
    const evidence = samples.get(manifest.id)?.[0];
    assert.ok(validate && evidence);

    const missing = structuredClone(evidence);
    delete missing.session_refs;
    assert.equal(validate(missing), false, `${manifest.id} accepted missing data`);

    const mistyped = structuredClone(evidence);
    mistyped.session_refs = "not-an-array";
    assert.equal(validate(mistyped), false, `${manifest.id} accepted wrong type`);

    const extra = structuredClone(evidence);
    extra.undeclared_field = true;
    assert.equal(validate(extra), false, `${manifest.id} accepted extra data`);

    const other = manifests[(index + 1) % manifests.length];
    assert.ok(other);
    const crossed = validateByRule.get(other.id);
    assert.ok(crossed);
    assert.equal(crossed(evidence), false, `${other.id} accepted ${manifest.id}`);
  }
});

test("the npm artifact includes the built-in evidence schema bundle", async () => {
  const cache = await mkdtemp(join(tmpdir(), "ccprof-schema-npm-"));
  try {
    const npmArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
    const npmExecPath = process.env.npm_execpath;
    const packed = spawnSync(
      npmExecPath !== undefined
        ? process.execPath
        : process.platform === "win32"
        ? process.env.ComSpec ?? "cmd.exe"
        : "npm",
      npmExecPath !== undefined
        ? [npmExecPath, ...npmArgs]
        : process.platform === "win32"
        ? ["/d", "/s", "/c", "npm.cmd", ...npmArgs]
        : npmArgs,
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_CACHE: cache },
      },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const result: unknown = JSON.parse(packed.stdout);
    assert.ok(Array.isArray(result));
    const first = result[0] as
      | { files?: Array<{ path?: string }> }
      | undefined;
    assert.ok(first?.files?.some(({ path }) => path === SCHEMA_PATH));
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
