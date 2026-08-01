import assert from "node:assert/strict";
import test from "node:test";

import type {
  CompactionEvent,
  Finding,
  MatchedAction,
  TimelineAction,
  ToolResultEvent,
} from "../src/core/model.js";
import { buildFlakyEditRelevance } from "../src/core/analyze.js";
import { parseExplicitTestMap } from "../src/analysis/test-map.js";
import type { AnalysisRecord } from "../src/store/analyses.js";
import { detectContextBloat } from "../src/rules/context-bloat.js";
import {
  detectFlakyTests,
  flakyEditRelevanceKey,
} from "../src/rules/flaky-test.js";
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
    relevance_paths: [],
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

function historyRecord(
  analysisId: string,
  prRef: string,
  findings: readonly Finding[],
): AnalysisRecord {
  return {
    schema_version: 1,
    analysis_id: analysisId,
    created_at_ms: Number(analysisId.replace(/\D/gu, "")) || 1,
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
      unexplained_min: 1,
      baseline: null,
    },
    findings: [...findings],
    metrics: {},
    command_costs: [],
  };
}

function storedFlakyFinding(
  command: string,
  durationMin: number,
  sessionRef: string,
): Finding {
  return {
    finding_key: findingKey("R008", command),
    rule_id: "R008",
    title: "Test failed then passed without a relevant edit",
    classification: "repo",
    cause: null,
    scope: "separate_issue",
    confidence: "high",
    evidence: {
      session_refs: [sessionRef],
      interval_ids: ["R008:historical"],
      command,
    },
    recoverable: { min: durationMin, bound: "point" },
    fix_recipe: {
      suggestion: "Fix or quarantine the flaky behavior.",
      verify: command,
    },
    caveats: [],
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

test("R005 uses command relevance paths for independent test build and check commands", () => {
  const findings = detectSerialSlack([
    matchedAction("test", 0, 100, "contributing_run", {
      tool_name: "Bash",
      command: "npm test",
      paths: [],
      relevance_paths: ["test/unit.test.ts"],
    }),
    matchedAction("build", 110, 310, "contributing_run", {
      tool_name: "Bash",
      command: "npm run build",
      paths: [],
      relevance_paths: ["src/app.ts"],
    }),
    matchedAction("check", 320, 470, "contributing_run", {
      tool_name: "Bash",
      command: "cargo check -p helper",
      paths: [],
      relevance_paths: ["crates/helper/src/lib.rs"],
    }),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.recoverable.estimated_ms, 250);
  assert.deepEqual(findings[0]?.evidence.paths, [
    "crates/helper/src/lib.rs",
    "src/app.ts",
    "test/unit.test.ts",
  ]);
});

test("R005 accepts independently mapped custom validation commands", () => {
  const findings = detectSerialSlack([
    matchedAction("mapped-a", 0, 100, "contributing_run", {
      tool_name: "Bash",
      command: "make test-a",
      normalized_command: "make test-a",
      relevance_paths: ["src/a.ts"],
    }),
    matchedAction("mapped-b", 110, 230, "redundant_run", {
      tool_name: "Bash",
      command: "make test-b",
      normalized_command: "make test-b",
      relevance_paths: ["src/b.ts"],
    }),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.recoverable.estimated_ms, 100);
  assert.doesNotMatch(
    findings[0]?.fix_recipe.suggestion ?? "",
    /read-only/iu,
  );
  assert.match(
    findings[0]?.fix_recipe.suggestion ?? "",
    /validation/iu,
  );
});

test("R005 rejects validation commands without proven disjoint relevance", () => {
  for (const actions of [
    [
      matchedAction("unknown-scope", 0, 100, "contributing_run", {
        tool_name: "Bash",
        command: "npm test",
        relevance_paths: [],
      }),
      matchedAction("known-scope", 110, 210, "contributing_run", {
        tool_name: "Bash",
        command: "cargo check",
        relevance_paths: ["src/a.ts"],
      }),
    ],
    [
      matchedAction("overlap-parent", 0, 100, "contributing_run", {
        tool_name: "Bash",
        command: "npm test",
        relevance_paths: ["src"],
      }),
      matchedAction("overlap-child", 110, 210, "contributing_run", {
        tool_name: "Bash",
        command: "npm run build",
        relevance_paths: ["src/a.ts"],
      }),
    ],
    [
      matchedAction("opaque", 0, 100, "contributing_run", {
        tool_name: "Bash",
        command: "npm test && npm run build",
        relevance_paths: ["test/a.test.ts"],
      }),
      matchedAction("check", 110, 210, "contributing_run", {
        tool_name: "Bash",
        command: "cargo check",
        relevance_paths: ["src/b.ts"],
      }),
    ],
    [
      matchedAction("write", 0, 100, "unexplained", {
        tool_name: "Bash",
        command: "node scripts/write-output.js",
        normalized_command: "node scripts/write-output.js",
        relevance_paths: ["generated/output.json"],
      }),
      matchedAction("test", 110, 210, "contributing_run", {
        tool_name: "Bash",
        command: "npm test",
        relevance_paths: ["test/a.test.ts"],
      }),
    ],
    [
      matchedAction("unexplained-mapped", 0, 100, "unexplained", {
        tool_name: "Bash",
        command: "make test-a",
        normalized_command: "make test-a",
        relevance_paths: ["src/a.ts"],
      }),
      matchedAction("mapped", 110, 210, "contributing_run", {
        tool_name: "Bash",
        command: "make test-b",
        normalized_command: "make test-b",
        relevance_paths: ["src/b.ts"],
      }),
    ],
    [
      matchedAction("opaque-mapped", 0, 100, "contributing_run", {
        tool_name: "Bash",
        command: "make test-a && touch generated.txt",
        normalized_command: "make test-a",
        relevance_paths: ["src/a.ts"],
      }),
      matchedAction("mapped", 110, 210, "contributing_run", {
        tool_name: "Bash",
        command: "make test-b",
        normalized_command: "make test-b",
        relevance_paths: ["src/b.ts"],
      }),
    ],
  ]) {
    assert.deepEqual(detectSerialSlack(actions), []);
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
    matchedAction("investigation-inference", 150, 170, "safe_read", {
      kind: "inference",
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
  assert.equal(finding.recoverable.estimated_ms, 140);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R008:failed",
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

test("R008 does not treat an unexplained failed run as its own mutation", () => {
  const actions = [
    matchedAction("failed", 0, 100, "unexplained", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
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
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 100);
  assert.deepEqual(finding.evidence.interval_ids, ["R008:failed"]);
  assert.equal(finding.evidence.failed_run_count, 1);
  assert.equal(finding.evidence.episode_count, 1);
});

test("R008 does not treat a failed run's causal inference as a mutation", () => {
  const actions = [
    matchedAction("failed", 0, 100, "unexplained", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("failed-inference", 100, 120, "unexplained", {
      kind: "inference",
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
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
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 100);
  assert.deepEqual(finding.evidence.interval_ids, ["R008:failed"]);
  assert.equal(finding.evidence.investigation_action_count, 1);
});

test("R008 does not treat another definite failed run as a mutation", () => {
  const actions = [
    matchedAction("failed-first", 0, 50, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed-first",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("failed-second", 50, 100, "unexplained", {
      tool_name: "Bash",
      tool_use_id: "failed-second",
      command: "npm test",
      normalized_command: "npm test",
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
      toolResult("failed-first", 50, "failure"),
      toolResult("failed-second", 100, "failure"),
      toolResult("passed", 260, "success"),
    ],
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 100);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R008:failed-first",
    "R008:failed-second",
  ]);
  assert.equal(finding.evidence.failed_run_count, 2);
  assert.equal(finding.evidence.investigation_action_count, 2);
});

test("R008 connects fail-to-pass episodes across sessions and agents", () => {
  const actions = [
    matchedAction("failed", 0, 100, "contributing_run", {
      session_id: "s-fail",
      agent_id: "root",
      session_refs: ["s-fail#failed-start", "s-fail#failed-end"],
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("investigation", 110, 140, "safe_read", {
      session_id: "s-investigation",
      agent_id: "reader",
      session_refs: [
        "s-investigation#read-start",
        "s-investigation#read-end",
      ],
      tool_name: "Read",
      tool_use_id: "investigation",
      paths: ["test/a.test.ts"],
    }),
    matchedAction("passed", 200, 260, "redundant_run", {
      session_id: "s-pass",
      agent_id: "tester",
      session_refs: ["s-pass#passed-start", "s-pass#passed-end"],
      tool_name: "Bash",
      tool_use_id: "passed",
      command: "npm   test",
      normalized_command: "npm test",
    }),
  ];
  const finding = detectFlakyTests(actions, {
    toolResults: [
      toolResult("failed", 100, "failure", {
        session_id: "s-fail",
        agent_id: "root",
        session_ref: "s-fail#result-failed",
      }),
      toolResult("passed", 260, "success", {
        session_id: "s-pass",
        agent_id: "tester",
        session_ref: "s-pass#result-passed",
      }),
    ],
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 130);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R008:failed",
    "R008:investigation",
  ]);
  assert.deepEqual(finding.evidence.session_refs, [
    "s-fail#failed-end",
    "s-fail#failed-start",
    "s-fail#result-failed",
    "s-investigation#read-end",
    "s-investigation#read-start",
    "s-pass#passed-end",
    "s-pass#passed-start",
    "s-pass#result-passed",
  ]);
  assert.equal(finding.evidence.failed_run_count, 1);
  assert.equal(finding.evidence.passing_run_count, 1);
  assert.equal(finding.evidence.investigation_action_count, 2);
});

test("R008 owns every failed run even when failure intervals overlap", () => {
  const actions = [
    matchedAction("failed-a", 0, 100, "contributing_run", {
      session_id: "s-a",
      agent_id: "root",
      tool_name: "Bash",
      tool_use_id: "failed-a",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("failed-b", 80, 140, "contributing_run", {
      session_id: "s-b",
      agent_id: "worker",
      tool_name: "Bash",
      tool_use_id: "failed-b",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("passed", 200, 260, "redundant_run", {
      session_id: "s-pass",
      agent_id: "tester",
      tool_name: "Bash",
      tool_use_id: "passed",
      command: "npm test",
      normalized_command: "npm test",
    }),
  ];
  const finding = detectFlakyTests(actions, {
    toolResults: [
      toolResult("failed-a", 100, "failure", {
        session_id: "s-a",
        agent_id: "root",
      }),
      toolResult("failed-b", 140, "failure", {
        session_id: "s-b",
        agent_id: "worker",
      }),
      toolResult("passed", 260, "success", {
        session_id: "s-pass",
        agent_id: "tester",
      }),
    ],
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 140);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R008:failed-a",
    "R008:failed-b",
  ]);
  assert.equal(finding.evidence.failed_run_count, 2);
  assert.equal(finding.evidence.investigation_action_count, 2);
});

test("R008 rejects a passing run that starts before the failure ends", () => {
  const actions = [
    matchedAction("failed", 0, 150, "contributing_run", {
      session_id: "s-fail",
      agent_id: "root",
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("passed", 100, 200, "redundant_run", {
      session_id: "s-pass",
      agent_id: "tester",
      tool_name: "Bash",
      tool_use_id: "passed",
      command: "npm test",
      normalized_command: "npm test",
    }),
  ];

  assert.deepEqual(
    detectFlakyTests(actions, {
      toolResults: [
        toolResult("failed", 150, "failure", {
          session_id: "s-fail",
          agent_id: "root",
        }),
        toolResult("passed", 200, "success", {
          session_id: "s-pass",
          agent_id: "tester",
        }),
      ],
    }),
    [],
  );
});

test("R008 retains failures after an overlapping success for a later pass", () => {
  const actions = [
    matchedAction("failed", 0, 300, "contributing_run", {
      session_id: "s-fail",
      agent_id: "root",
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("overlapping-pass", 100, 200, "redundant_run", {
      session_id: "s-overlap",
      agent_id: "tester-a",
      tool_name: "Bash",
      tool_use_id: "overlapping-pass",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("later-pass", 400, 500, "redundant_run", {
      session_id: "s-later",
      agent_id: "tester-b",
      tool_name: "Bash",
      tool_use_id: "later-pass",
      command: "npm test",
      normalized_command: "npm test",
    }),
  ];
  const finding = detectFlakyTests(actions, {
    toolResults: [
      toolResult("failed", 300, "failure", {
        session_id: "s-fail",
        agent_id: "root",
      }),
      toolResult("overlapping-pass", 200, "success", {
        session_id: "s-overlap",
        agent_id: "tester-a",
      }),
      toolResult("later-pass", 500, "success", {
        session_id: "s-later",
        agent_id: "tester-b",
      }),
    ],
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 300);
  assert.deepEqual(finding.evidence.interval_ids, ["R008:failed"]);
  assert.equal(finding.evidence.failed_run_count, 1);
  assert.equal(finding.evidence.passing_run_count, 1);
  assert.equal(finding.evidence.episode_count, 1);
});

test("R008 retains only unresolved failures after an accepted episode", () => {
  const actions = [
    matchedAction("failed-short", 0, 100, "contributing_run", {
      session_id: "s-short",
      agent_id: "root",
      tool_name: "Bash",
      tool_use_id: "failed-short",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("failed-long", 50, 300, "contributing_run", {
      session_id: "s-long",
      agent_id: "worker",
      tool_name: "Bash",
      tool_use_id: "failed-long",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("passed-first", 200, 250, "redundant_run", {
      session_id: "s-first-pass",
      agent_id: "tester-a",
      tool_name: "Bash",
      tool_use_id: "passed-first",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("passed-later", 400, 500, "redundant_run", {
      session_id: "s-later-pass",
      agent_id: "tester-b",
      tool_name: "Bash",
      tool_use_id: "passed-later",
      command: "npm test",
      normalized_command: "npm test",
    }),
  ];
  const finding = detectFlakyTests(actions, {
    toolResults: [
      toolResult("failed-short", 100, "failure", {
        session_id: "s-short",
        agent_id: "root",
      }),
      toolResult("failed-long", 300, "failure", {
        session_id: "s-long",
        agent_id: "worker",
      }),
      toolResult("passed-first", 250, "success", {
        session_id: "s-first-pass",
        agent_id: "tester-a",
      }),
      toolResult("passed-later", 500, "success", {
        session_id: "s-later-pass",
        agent_id: "tester-b",
      }),
    ],
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 300);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R008:failed-long",
    "R008:failed-short",
  ]);
  assert.equal(finding.evidence.failed_run_count, 2);
  assert.equal(finding.evidence.passing_run_count, 2);
  assert.equal(finding.evidence.investigation_action_count, 2);
  assert.equal(finding.evidence.episode_count, 2);
});

test("R008 excludes a zero-duration passing action from investigation", () => {
  const actions = [
    matchedAction("failed", 0, 100, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("investigation", 110, 140, "safe_read", {
      tool_name: "Read",
      tool_use_id: "investigation",
      paths: ["test/a.test.ts"],
    }),
    matchedAction("passed", 200, 200, "redundant_run", {
      tool_name: "Bash",
      tool_use_id: "passed",
      command: "npm test",
      normalized_command: "npm test",
    }),
  ];
  const finding = detectFlakyTests(actions, {
    toolResults: [
      toolResult("failed", 100, "failure"),
      toolResult("passed", 200, "success"),
    ],
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 130);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R008:failed",
    "R008:investigation",
  ]);
  assert.equal(finding.evidence.investigation_action_count, 2);
  assert.equal(finding.evidence.passing_run_count, 1);
});

test("R008 connects current flakiness to prior PRs without adding historical time to the claim", () => {
  const actions = [
    matchedAction("failed", 0, 100, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("passed", 200, 260, "redundant_run", {
      tool_name: "Bash",
      tool_use_id: "passed",
      command: "npm test",
      normalized_command: "npm test",
    }),
  ];
  const history = [
    historyRecord("history-1", "main...old-a", [
      storedFlakyFinding("npm   test", 1, "old-a#run-1"),
    ]),
    historyRecord("history-2", "main...old-a", [
      storedFlakyFinding("npm test", 2, "old-a#run-2"),
    ]),
    historyRecord("history-3", "main...old-b", [
      storedFlakyFinding("npm test", 0.5, "old-b#run"),
    ]),
    historyRecord("history-4", "main...old-c", [{
      ...storedFlakyFinding("npm test", 8, "old-c#run"),
      evidence: {
        session_refs: [1],
        interval_ids: [],
        command: { malformed: true },
      },
    } as unknown as Finding]),
  ];

  const finding = detectFlakyTests(actions, {
    toolResults: [
      toolResult("failed", 100, "failure"),
      toolResult("passed", 260, "success"),
    ],
    history,
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 100);
  assert.deepEqual(finding.evidence.interval_ids, ["R008:failed"]);
  assert.deepEqual(finding.evidence.historical_prs, [
    "main...old-a",
    "main...old-b",
  ]);
  assert.equal(finding.evidence.historical_duration_min, 2.5);
  assert.deepEqual(finding.evidence.historical_session_refs, [
    "old-a#run-1",
    "old-a#run-2",
    "old-b#run",
  ]);
  assert.match(finding.caveats.join("\n"), /2 prior PRs.*2.5 minutes/iu);
});

test("R008 never creates a current finding from history alone", () => {
  const history = [
    historyRecord("history-1", "main...old", [
      storedFlakyFinding("npm test", 3, "old#run"),
    ]),
  ];

  assert.deepEqual(
    detectFlakyTests([], { toolResults: [], history }),
    [],
  );
});

test("R008 claims only proven unrelated rework edits", () => {
  const actions = [
    matchedAction("failed", 0, 100, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("unrelated-contributing", 110, 140, "contributing_edit", {
      tool_name: "Edit",
      tool_use_id: "unrelated-contributing",
      paths: ["docs/final.md"],
    }),
    matchedAction("unrelated-rework", 140, 150, "rework_edit", {
      tool_name: "Edit",
      tool_use_id: "unrelated-rework",
      paths: ["docs/scratch.md"],
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
      ["unrelated-contributing", "unrelated"],
      ["unrelated-rework", "unrelated"],
    ]),
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.confidence, "medium");
  assert.equal(finding.recoverable.estimated_ms, 140);
  assert.equal(finding.evidence.unrelated_edit_count, 2);
  assert.deepEqual(finding.evidence.interval_ids, [
    "R008:failed",
    "R008:investigation",
    "R008:unrelated-rework",
  ]);
  assert.ok(
    !finding.evidence.interval_ids.includes("R008:unrelated-contributing"),
  );
  assert.match(finding.caveats.join("\n"), /unrelated edit/iu);
});

test("R008 never claims contributing edits with read-only commands", () => {
  const actions = [
    matchedAction("failed", 0, 100, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("contributing-edit", 110, 140, "contributing_edit", {
      tool_name: "Bash",
      tool_use_id: "contributing-edit",
      command: "git diff",
      paths: ["src/a.ts"],
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
      ["contributing-edit", "unrelated"],
    ]),
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 100);
  assert.deepEqual(finding.evidence.interval_ids, ["R008:failed"]);
  assert.equal(finding.evidence.unrelated_edit_count, 1);
});

test("R008 never claims non-failed contributing runs with read-only commands", () => {
  const actions = [
    matchedAction("failed", 0, 100, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed",
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("contributing-run", 110, 140, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "contributing-run",
      command: "git diff",
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
  })[0];

  assert.ok(finding !== undefined);
  assert.equal(finding.recoverable.estimated_ms, 100);
  assert.deepEqual(finding.evidence.interval_ids, ["R008:failed"]);
  assert.equal(finding.evidence.investigation_action_count, 1);
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

test("R008 rejects mutations during a failed run across contexts", () => {
  const failed = matchedAction("failed", 0, 100, "contributing_run", {
    tool_name: "Bash",
    tool_use_id: "failed",
    command: "npm test",
    normalized_command: "npm test",
  });
  const passed = matchedAction("passed", 200, 260, "redundant_run", {
    tool_name: "Bash",
    tool_use_id: "passed",
    command: "npm test",
    normalized_command: "npm test",
  });
  const cases = [
    {
      blocker: matchedAction("related-edit", 50, 80, "contributing_edit", {
        session_id: "s-related",
        agent_id: "editor",
        tool_name: "Edit",
        paths: ["test/a.test.ts"],
      }),
      relevance: new Map([["related-edit", "related" as const]]),
    },
    {
      blocker: matchedAction("unknown-mutation", 50, 80, "unexplained", {
        session_id: "s-unknown",
        agent_id: "mutator",
        tool_name: "Bash",
        command: "python fix_test.py",
        paths: ["test/a.test.ts"],
      }),
    },
  ];
  const results = [
    toolResult("failed", 100, "failure"),
    toolResult("passed", 260, "success"),
  ];

  assert.deepEqual(
    cases.map(({ blocker, relevance }) =>
      detectFlakyTests([failed, blocker, passed], {
        toolResults: results,
        ...(relevance === undefined
          ? {}
          : { editRelevanceByActionId: relevance }),
      }).length
    ),
    [0, 0],
  );
});

test("R008 edit relevance wiring is conservative across current test commands", () => {
  const testMap = parseExplicitTestMap({
    mappings: [{
      source: ["src/**"],
      tests: ["test/**"],
      commands: ["npm test", "cargo test"],
    }],
  });
  const commands = [
    matchedAction("npm-test", 0, 10, "contributing_run", {
      command: "npm test",
      normalized_command: "npm test",
    }),
    matchedAction("cargo-test", 20, 30, "contributing_run", {
      command: "cargo test",
      normalized_command: "cargo test",
    }),
  ];
  const relevance = buildFlakyEditRelevance([
    ...commands,
    matchedAction("related", 40, 50, "contributing_edit", {
      paths: ["src/value.ts"],
    }),
    matchedAction("unrelated", 60, 70, "rework_edit", {
      paths: ["docs/readme.md"],
    }),
    matchedAction("pathless", 80, 90, "contributing_edit"),
  ], testMap);

  assert.equal(
    relevance.get(flakyEditRelevanceKey("related", "npm test")),
    "related",
  );
  assert.equal(
    relevance.get(flakyEditRelevanceKey("unrelated", "cargo test")),
    "unrelated",
  );
  assert.equal(relevance.has("pathless"), false);

  const unknown = buildFlakyEditRelevance([
    matchedAction("targeted-test", 0, 10, "contributing_run", {
      command: "npm test -- -t widget",
      normalized_command: "npm test -- -t widget",
    }),
    matchedAction("edit", 20, 30, "contributing_edit", {
      paths: ["docs/readme.md"],
    }),
  ], testMap);
  assert.equal(
    unknown.has("edit"),
    false,
    "a non-path target keeps edit relevance unknown instead of allowing R008",
  );

  const opaque = buildFlakyEditRelevance([
    ...commands,
    matchedAction("opaque-test", 35, 38, "unexplained", {
      command: "npm test && echo done",
      normalized_command: "npm test && echo done",
    }),
    matchedAction("edit", 40, 50, "contributing_edit", {
      paths: ["docs/readme.md"],
    }),
  ], testMap);
  assert.equal(
    opaque.has("edit"),
    false,
    "an opaque command keeps edit relevance unknown",
  );
});

test("R008 scopes edit relevance to the failing normalized command", () => {
  const testMap = parseExplicitTestMap({
    mappings: [
      {
        source: ["src/suite-a/**"],
        tests: ["test/suite-a/**"],
        commands: ["npm run test:a"],
      },
      {
        source: ["src/suite-b/**"],
        tests: ["test/suite-b/**"],
        commands: ["npm run test:b"],
      },
    ],
  });
  const actions = [
    matchedAction("failed-a", 0, 40, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed-a",
      command: "npm run test:a",
      normalized_command: "npm run test:a",
    }),
    matchedAction("suite-b-edit", 50, 60, "contributing_edit", {
      tool_name: "Edit",
      tool_use_id: "suite-b-edit",
      paths: ["src/suite-b/value.ts"],
    }),
    matchedAction("passed-a", 70, 100, "redundant_run", {
      tool_name: "Bash",
      tool_use_id: "passed-a",
      command: "npm run test:a",
      normalized_command: "npm run test:a",
    }),
    matchedAction("observed-b", 110, 130, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "observed-b",
      command: "npm run test:b",
      normalized_command: "npm run test:b",
    }),
  ];

  const findings = detectFlakyTests(actions, {
    toolResults: [
      toolResult("failed-a", 40, "failure"),
      toolResult("passed-a", 100, "success"),
    ],
    editRelevanceByActionId: buildFlakyEditRelevance(actions, testMap),
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.target, "npm run test:a");
  assert.equal(findings[0]?.evidence.unrelated_edit_count, 1);
});

test("R008 keeps command-scoped unknown edit relevance conservative", () => {
  const testMap = parseExplicitTestMap({
    mappings: [
      {
        source: ["src/suite-b/**"],
        tests: ["test/suite-b/**"],
        commands: ["npm run test:b"],
      },
      {
        source: ["src/suite-c/**"],
        tests: ["test/suite-c/**"],
        commands: ["npm test -- -t suite-c"],
      },
    ],
  });
  const actions = [
    matchedAction("failed-c", 0, 40, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "failed-c",
      command: "npm test -- -t suite-c",
      normalized_command: "npm test -- -t suite-c",
    }),
    matchedAction("suite-b-edit", 50, 60, "contributing_edit", {
      tool_name: "Edit",
      tool_use_id: "suite-b-edit",
      paths: ["src/suite-b/value.ts"],
    }),
    matchedAction("passed-c", 70, 100, "redundant_run", {
      tool_name: "Bash",
      tool_use_id: "passed-c",
      command: "npm test -- -t suite-c",
      normalized_command: "npm test -- -t suite-c",
    }),
    matchedAction("observed-b", 110, 130, "contributing_run", {
      tool_name: "Bash",
      tool_use_id: "observed-b",
      command: "npm run test:b",
      normalized_command: "npm run test:b",
    }),
  ];
  const relevance = buildFlakyEditRelevance(actions, testMap);

  assert.equal(
    relevance.has(
      flakyEditRelevanceKey(
        "suite-b-edit",
        "npm test -- -t suite-c",
      ),
    ),
    false,
  );
  assert.deepEqual(
    detectFlakyTests(actions, {
      toolResults: [
        toolResult("failed-c", 40, "failure"),
        toolResult("passed-c", 100, "success"),
      ],
      editRelevanceByActionId: relevance,
    }),
    [],
  );
});
