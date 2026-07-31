import assert from "node:assert/strict";
import test from "node:test";

import type {
  CompactionEvent,
  MatchedAction,
  TimelineAction,
  ToolResultEvent,
} from "../src/core/model.js";
import { detectContextBloat } from "../src/rules/context-bloat.js";
import { detectFlakyTests } from "../src/rules/flaky-test.js";
import { findingKey } from "../src/rules/shared.js";
import { detectSerialSlack } from "../src/rules/serial-slack.js";

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

function toolResult(
  toolUseId: string,
  timestampMs: number,
  status: ToolResultEvent["status"],
  overrides: Partial<ToolResultEvent> = {},
): ToolResultEvent {
  return {
    ...eventBase(`result-${toolUseId}`, timestampMs, timestampMs),
    kind: "tool_result",
    tool_use_id: toolUseId,
    status,
    output: "",
    output_bytes: 0,
    estimated_tokens: 0,
    ...overrides,
  };
}

function compaction(
  entryUuid: string,
  timestampMs: number,
): CompactionEvent {
  return {
    ...eventBase(entryUuid, timestampMs, timestampMs),
    kind: "compaction",
    summary: "compacted",
  };
}

test("R005 detects adjacent independent reads and estimates only sum minus max", () => {
  const actions = [
    matchedAction("read-a", 0, 100, "safe_read", {
      tool_name: "Read",
      tool_use_id: "read-a",
      paths: ["src/a.ts"],
      target: "src/a.ts",
    }),
    matchedAction("read-a-inference", 100, 110, "safe_read", {
      kind: "inference",
      tool_name: "Read",
      tool_use_id: "read-a",
      paths: ["src/a.ts"],
      target: "src/a.ts",
    }),
    matchedAction("read-b", 110, 410, "safe_read", {
      tool_name: "Grep",
      tool_use_id: "read-b",
      paths: ["test/b.test.ts"],
      target: "test/b.test.ts",
    }),
  ];

  const finding = detectSerialSlack(actions)[0];
  assert.ok(finding !== undefined);
  assert.equal(finding.rule_id, "R005");
  assert.equal(finding.classification, "behavior");
  assert.equal(finding.scope, "claude_md");
  assert.equal(finding.cause, null);
  assert.equal(finding.confidence, "high");
  assert.equal(finding.recoverable.bound, "upper");
  assert.equal(finding.recoverable.estimated_ms, 100);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R005:read-a",
    "R005:read-b",
  ]);
  assert.deepEqual(finding.evidence.paths, [
    "src/a.ts",
    "test/b.test.ts",
  ]);
  assert.equal(finding.evidence.serial_duration_ms, 400);
  assert.equal(finding.evidence.longest_action_ms, 300);
  assert.equal(
    finding.finding_key,
    findingKey("R005", "src/a.ts | test/b.test.ts"),
  );
  assert.notEqual(finding.fix_recipe.suggestion, "");
  assert.notEqual(finding.fix_recipe.verify, "");
});

test("R005 accepts conservative read-only commands but rejects overlap and mutations", () => {
  const readOnly = detectSerialSlack([
    matchedAction("git-diff", 0, 80, "unexplained", {
      tool_name: "Bash",
      tool_use_id: "git-diff",
      command: "git diff -- src/a.ts",
      paths: ["src/a.ts"],
    }),
    matchedAction("head", 90, 130, "unexplained", {
      tool_name: "Bash",
      tool_use_id: "head",
      command: "head -n 20 test/b.test.ts",
      paths: ["test/b.test.ts"],
    }),
  ]);
  assert.equal(readOnly.length, 1);
  assert.equal(readOnly[0]?.recoverable.estimated_ms, 40);

  assert.deepEqual(
    detectSerialSlack([
      matchedAction("parent", 0, 100, "safe_read", {
        tool_name: "Read",
        paths: ["src"],
      }),
      matchedAction("child", 110, 210, "safe_read", {
        tool_name: "Read",
        paths: ["src/a.ts"],
      }),
    ]),
    [],
  );
  assert.deepEqual(
    detectSerialSlack([
      matchedAction("read", 0, 100, "safe_read", {
        tool_name: "Read",
        paths: ["src/a.ts"],
      }),
      matchedAction("mutate", 110, 210, "unexplained", {
        tool_name: "Bash",
        command: "rm src/b.ts",
        paths: ["src/b.ts"],
      }),
    ]),
    [],
  );

  for (const command of [
    "sed -e 'w /tmp/ccprof-sed-output' src/a.ts",
    "sed -e 'e touch /tmp/ccprof-sed-exec' src/a.ts",
    "find src -fprint /tmp/ccprof-find-output",
    "find src -exec touch /tmp/ccprof-find-exec ;",
    "find src -delete",
  ]) {
    assert.deepEqual(
      detectSerialSlack([
        matchedAction("possibly-mutating", 0, 100, "unexplained", {
          tool_name: "Bash",
          command,
          paths: ["src/a.ts"],
        }),
        matchedAction("safe-read", 110, 210, "safe_read", {
          tool_name: "Read",
          paths: ["test/b.test.ts"],
        }),
      ]),
      [],
      command,
    );
  }
});

test("R007 uses a strict token threshold, links compaction, and claims caused latency as upper", () => {
  const largeResult = toolResult("large", 100, "success", {
    output_bytes: 250_000,
    estimated_tokens: 50_001,
  });
  const events = [
    largeResult,
    toolResult("boundary", 450, "success", {
      estimated_tokens: 50_000,
    }),
    compaction("compact", 500),
  ];
  const actions = [
    matchedAction("large-tool", 0, 100, "unexplained", {
      tool_name: "Bash",
      tool_use_id: "large",
      command: "npm test -- --reporter verbose",
    }),
    matchedAction("large-inference", 100, 400, "unexplained", {
      kind: "inference",
      tool_name: "Bash",
      tool_use_id: "large",
      command: "npm test -- --reporter verbose",
    }),
    matchedAction("boundary-tool", 410, 450, "unexplained", {
      tool_name: "Read",
      tool_use_id: "boundary",
      paths: ["src/big.ts"],
    }),
  ];

  const finding = detectContextBloat(actions, { events })[0];
  assert.ok(finding !== undefined);
  assert.equal(finding.rule_id, "R007");
  assert.equal(finding.classification, "behavior");
  assert.equal(finding.scope, "claude_md");
  assert.equal(finding.recoverable.bound, "upper");
  assert.equal(finding.recoverable.estimated_ms, 300);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R007:large-inference",
  ]);
  assert.equal(finding.evidence.result_count, 1);
  assert.equal(finding.evidence.compaction_count, 1);
  assert.equal(finding.evidence.max_estimated_tokens, 50_001);
  assert.deepEqual(finding.evidence.tool_use_ids, ["large"]);
  assert.match(finding.fix_recipe.suggestion, /head|tail/iu);

  assert.deepEqual(
    detectContextBloat([], {
      events: [
        toolResult("boundary-only", 100, "success", {
          estimated_tokens: 50_000,
        }),
      ],
    }),
    [],
  );
});

test("R007 reports compaction without inventing latency when no large result precedes it", () => {
  const finding = detectContextBloat([], {
    events: [compaction("compact-only", 100)],
  })[0];
  assert.ok(finding !== undefined);
  assert.equal(finding.target, "compaction");
  assert.equal(finding.recoverable.bound, "upper");
  assert.equal(finding.recoverable.estimated_ms, 0);
  assert.deepEqual(finding.recoverable.intervals, []);
  assert.equal(finding.evidence.compaction_count, 1);
  assert.match(finding.caveats.join("\n"), /preceding large result/iu);
});

test("R008 claims a definite unchanged fail-to-pass investigation as point time", () => {
  const actions = [
    matchedAction("failed", 0, 100, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
      target: "npm test",
    }),
    matchedAction("failed-inference", 100, 110, "contributing_run", {
      kind: "inference",
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
      target: "npm test",
    }),
    matchedAction("investigation", 110, 150, "safe_read", {
      tool_name: "Read",
      tool_use_id: "investigation",
      paths: ["src/a.ts"],
      target: "src/a.ts",
    }),
    matchedAction("passed", 200, 260, "redundant_run", {
      tool_name: "Bash",
      tool_use_id: "passed",
      command: "npm   test",
      normalized_command: "npm test",
      target: "npm test",
    }),
  ];
  const finding = detectFlakyTests(actions, {
    toolResults: [
      toolResult("failed", 100, "failure"),
      toolResult("passed", 260, "success"),
    ],
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.rule_id, "R008");
  assert.equal(finding.classification, "repo");
  assert.equal(finding.scope, "separate_issue");
  assert.equal(finding.cause, null);
  assert.equal(finding.confidence, "high");
  assert.equal(finding.target, "npm test");
  assert.equal(finding.finding_key, findingKey("R008", "npm test"));
  assert.equal(finding.recoverable.bound, "point");
  assert.equal(finding.recoverable.estimated_ms, 150);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R008:failed",
    "R008:failed-inference",
    "R008:investigation",
  ]);
  assert.deepEqual(
    finding.evidence.investigation_interval_ids,
    finding.evidence.interval_ids,
  );
  assert.equal(finding.evidence.failed_run_count, 1);
  assert.equal(finding.evidence.episode_count, 1);
  assert.equal(finding.evidence.unrelated_edit_count, 0);
  assert.equal(finding.fix_recipe.verify, "npm test");
});

test("R008 lowers confidence for proven unrelated edits and excludes them from ownership", () => {
  const actions = [
    matchedAction("failed", 0, 100, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("unrelated-edit", 110, 140, "contributing_edit", {
      tool_name: "Edit",
      tool_use_id: "unrelated-edit",
      paths: ["docs/readme.md"],
    }),
    matchedAction("investigation", 150, 180, "safe_read", {
      tool_name: "Read",
      tool_use_id: "investigation",
      paths: ["test/a.test.ts"],
    }),
    matchedAction("passed", 200, 260, "redundant_run", {
      tool_name: "Bash",
      tool_use_id: "passed",
      command: "npm test",
      normalized_command: "npm test",
    }),
  ];
  const finding = detectFlakyTests(actions, {
    toolResults: [
      toolResult("failed", 100, "failure"),
      toolResult("passed", 260, "success"),
    ],
    editRelevanceByActionId: new Map([
      ["unrelated-edit", "unrelated"],
    ]),
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.confidence, "medium");
  assert.equal(finding.evidence.unrelated_edit_count, 1);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R008:failed",
    "R008:investigation",
  ]);
  assert.ok(
    !finding.evidence.interval_ids.includes("R008:unrelated-edit"),
  );
  assert.match(finding.caveats.join("\n"), /unrelated edit/iu);
});

test("R008 rejects related or unknown edit relevance and non-definite failures", () => {
  const actions = [
    matchedAction("failed", 0, 100, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("edit", 110, 140, "contributing_edit", {
      tool_name: "Edit",
      tool_use_id: "edit",
      paths: ["src/a.ts"],
    }),
    matchedAction("passed", 200, 260, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "passed",
      command: "npm test",
      normalized_command: "npm test",
    }),
  ];
  const results = [
    toolResult("failed", 100, "failure"),
    toolResult("passed", 260, "success"),
  ];

  assert.deepEqual(
    detectFlakyTests(actions, {
      toolResults: results,
      editRelevanceByActionId: new Map([["edit", "related"]]),
    }),
    [],
  );
  assert.deepEqual(
    detectFlakyTests(actions, { toolResults: results }),
    [],
  );
  assert.deepEqual(
    detectFlakyTests(
      actions.filter((action) => action.action_id !== "edit"),
      {
        toolResults: [
          toolResult("failed", 100, "timeout", {
            output: "1 failed",
          }),
          toolResult("passed", 260, "success"),
        ],
      },
    ),
    [],
  );
});

test("R008 rejects opaque or otherwise unknown mutations between failure and success", () => {
  const results = [
    toolResult("failed", 100, "failure"),
    toolResult("passed", 260, "success"),
  ];

  const mutations: {
    toolName: string;
    command?: string;
  }[] = [
    {
      toolName: "Bash",
      command: "python fix_test.py",
    },
    {
      toolName: "Bash",
      command: "python fix_test.py > test/a.test.ts",
    },
    {
      toolName: "Edit",
    },
  ];
  for (const mutation of mutations) {
    const actions = [
      matchedAction("failed", 0, 100, "contributing_run", {
        tool_name: "Bash",
        tool_use_id: "failed",
        command: "npm test",
        normalized_command: "npm test",
      }),
      matchedAction("unknown-mutation", 110, 140, "unexplained", {
        tool_name: mutation.toolName,
        ...(mutation.command === undefined
          ? {}
          : { command: mutation.command }),
        paths: ["test/a.test.ts"],
      }),
      matchedAction("passed", 200, 260, "contributing_run", {
        tool_name: "Bash",
        tool_use_id: "passed",
        command: "npm test",
        normalized_command: "npm test",
      }),
    ];

    assert.deepEqual(
      detectFlakyTests(actions, { toolResults: results }),
      [],
      mutation.command ?? mutation.toolName,
    );
  }
});

test("R008 rejects unknown and relevant edits that overlap either causal-window boundary", () => {
  const results = [
    toolResult("failed", 100, "failure"),
    toolResult("passed", 260, "success"),
  ];
  const overlaps = [
    {
      actionId: "leading-unknown",
      startMs: 90,
      endMs: 120,
      match: "unexplained" as const,
      toolName: "Bash",
      command: "python fix_test.py",
    },
    {
      actionId: "trailing-unknown",
      startMs: 190,
      endMs: 210,
      match: "unexplained" as const,
      toolName: "Edit",
    },
    {
      actionId: "leading-related",
      startMs: 90,
      endMs: 120,
      match: "contributing_edit" as const,
      toolName: "Edit",
    },
    {
      actionId: "trailing-related",
      startMs: 190,
      endMs: 210,
      match: "rework_edit" as const,
      toolName: "Edit",
    },
  ];

  for (const overlap of overlaps) {
    const actions = [
      matchedAction("failed", 0, 100, "contributing_run", {
        tool_name: "Bash",
        tool_use_id: "failed",
        command: "npm test",
        normalized_command: "npm test",
      }),
      matchedAction(
        overlap.actionId,
        overlap.startMs,
        overlap.endMs,
        overlap.match,
        {
          agent_id: "side-agent",
          tool_name: overlap.toolName,
          ...(overlap.command === undefined
            ? {}
            : { command: overlap.command }),
          paths: ["test/a.test.ts"],
        },
      ),
      matchedAction("passed", 200, 260, "contributing_run", {
        tool_name: "Bash",
        tool_use_id: "passed",
        command: "npm test",
        normalized_command: "npm test",
      }),
    ];
    const editRelevanceByActionId = overlap.match === "unexplained"
      ? undefined
      : new Map([[overlap.actionId, "related" as const]]);

    assert.deepEqual(
      detectFlakyTests(actions, {
        toolResults: results,
        ...(editRelevanceByActionId === undefined
          ? {}
          : { editRelevanceByActionId }),
      }),
      [],
      overlap.actionId,
    );
  }
});
