import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type {
  AssistantEvent,
  GenuineUserEvent,
  MatchedAction,
  TimelineAction,
} from "../src/core/model.js";
import type { AttributedTimelineAction } from "../src/analysis/timeline.js";
import {
  createFindingCandidate,
  findingKey,
  recoverableClaim,
} from "../src/rules/shared.js";
import { detectRework } from "../src/rules/rework.js";
import { detectRedundantRuns } from "../src/rules/redundant-runs.js";
import { detectRediscovery } from "../src/rules/rediscovery.js";
import {
  APPROVAL_PROMPT_PHRASES,
  detectHumanWait,
} from "../src/rules/human-wait.js";

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
    target: actionId,
    caveats: [],
    ...overrides,
  };
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

test("R001 assigns only deterministic evidence-backed causes", () => {
  const cases = [
    ["The task description was ambiguous; redo this.", "ambiguous_task", "claude_md"],
    ["Requirements changed: use JSON instead.", "requirements_changed", "separate_issue"],
    ["Missing context: this must run on Windows.", "missing_context", "claude_md"],
    ["This was scope creep; remove it.", "scope_creep", "separate_issue"],
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
  const actions = [
    matchedAction("run-1", 0, 100, "contributing_run", {
      command: "npm test",
      normalized_command: "npm test",
      target: "npm test",
      tool_use_id: "run-1",
      tool_name: "Bash",
    }),
    matchedAction("run-2", 200, 500, "redundant_run", {
      command: "npm   test",
      normalized_command: "npm test",
      target: "npm test",
      paths: ["src/a.ts"],
      tool_use_id: "run-2",
      tool_name: "Bash",
      match_confidence: "high",
      caveats: ["Relevance uses an explicit test map."],
    }),
    matchedAction("run-2-inference", 500, 700, "redundant_run", {
      kind: "inference",
      command: "npm test",
      normalized_command: "npm test",
      target: "npm test",
      tool_use_id: "run-2",
      tool_name: "Bash",
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
    }),
  ];

  const finding = detectRedundantRuns(actions)[0];
  assert.ok(finding !== undefined);
  assert.equal(finding.rule_id, "R002");
  assert.equal(finding.classification, "behavior");
  assert.equal(finding.scope, "this_pr");
  assert.equal(finding.cause, null);
  assert.equal(finding.confidence, "medium");
  assert.equal(finding.target, "npm test");
  assert.equal(finding.finding_key, findingKey("R002", "npm test"));
  assert.equal(finding.evidence.count, 3);
  assert.equal(finding.evidence.irrelevant_count, 2);
  assert.equal(finding.evidence.duration_ms, 500);
  assert.deepEqual(finding.evidence.paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(finding.evidence.prior_success_required, true);
  assert.equal(finding.evidence.prior_success_proven, true);
  assert.equal(finding.evidence.prior_success_basis, "matcher-classification");
  assert.equal(finding.evidence.relevance, "irrelevant");
  assert.ok(
    (finding.evidence.session_refs as string[]).includes("s1#run-1-start"),
  );
  assert.deepEqual(finding.evidence.interval_ids, [
    "R002:run-2",
    "R002:run-3",
  ]);
  assert.equal(finding.recoverable.bound, "point");
  assert.equal(finding.recoverable.estimated_ms, 500);
  assert.notEqual(finding.fix_recipe.suggestion, "");
  assert.notEqual(finding.fix_recipe.verify, "");
  assert.deepEqual(finding.caveats, [
    "Relevance uses an explicit test map.",
    "Relevance uses manifest conventions.",
  ]);
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
    estimatedTokensByToolUseId: new Map([
      ["duplicate-1", 120],
      ["duplicate-2", 80],
    ]),
  })[0];
  assert.ok(finding !== undefined);
  assert.equal(finding.rule_id, "R003");
  assert.equal(finding.classification, "behavior");
  assert.equal(finding.scope, "claude_md");
  assert.equal(finding.cause, null);
  assert.equal(finding.confidence, "medium");
  assert.equal(finding.finding_key, findingKey("R003", "src/a.ts"));
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
