import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCommand,
  classifyCommandResult,
  normalizeCommand,
} from "../src/analysis/command.js";
import {
  discoverManifestTestMap,
  evaluateTestRelevance,
  loadExplicitTestMap,
  mergeTestMaps,
  parseExplicitTestMap,
  pathMatchesGlob,
  TestMapError,
} from "../src/analysis/test-map.js";
import {
  matchTimelineActions,
  type ActionObservation,
} from "../src/analysis/diff-matcher.js";
import type {
  DiffEvidence,
  FileDiffEvidence,
} from "../src/git/diff.js";
import type {
  TimelineAction,
  ToolResultEvent,
  ToolUseEvent,
} from "../src/core/model.js";

const fixtureDir = `${process.cwd()}/test/fixtures/manifests`;

test("normalizes whitespace and leading wrappers without reordering arguments", () => {
  assert.equal(
    normalizeCommand("  FOO=1 env BAR='two words' command npm   test -- src/z.test.ts -t thing  "),
    'npm test -- src/z.test.ts -t thing',
  );
  assert.equal(
    classifyCommand("pnpm test z.test.ts a.test.ts").normalized,
    "pnpm test z.test.ts a.test.ts",
  );
});

test("tokenizes conservatively and treats shell composition as opaque", () => {
  const composed = classifyCommand("npm test && touch sentinel");
  assert.equal(composed.opaque, true);
  assert.equal(composed.family, "other");
  assert.equal(normalizeCommand("npm test && touch sentinel"), null);
  assert.equal(classifyCommand("npm test\ntouch sentinel").opaque, true);

  const quoted = classifyCommand("npm test -- 'test/a b.test.ts'");
  assert.equal(quoted.opaque, false);
  assert.deepEqual(quoted.pathTargets, ["test/a b.test.ts"]);
});

test("recognizes required test, build, and check command families", () => {
  const cases = [
    ["npm test", "test"],
    ["npm run build", "build"],
    ["pnpm run test:unit", "test"],
    ["yarn build", "build"],
    ["bun test test/a.test.ts", "test"],
    ["cargo test crate_name", "test"],
    ["cargo build --release", "build"],
    ["cargo check", "check"],
    ["pytest tests/test_a.py::test_one", "test"],
    ["python3 -m pytest -q tests/test_b.py", "test"],
  ] as const;
  for (const [command, family] of cases) {
    assert.equal(classifyCommand(command).family, family, command);
  }
  assert.equal(classifyCommand("npm test").scope, "full");
  assert.equal(classifyCommand("pytest tests/test_a.py::test_one").scope, "targeted");
});

test("classifies only definite result signals and never guesses from opaque output", () => {
  assert.deepEqual(
    classifyCommandResult(classifyCommand("npm test"), {
      status: "unknown",
      exitCode: 1,
      output: "",
    }),
    { status: "failure", definite: true, source: "exit_code" },
  );
  assert.equal(
    classifyCommandResult(classifyCommand("pytest"), {
      status: "unknown",
      output: "12 passed in 1.2s",
    }).status,
    "success",
  );
  assert.equal(
    classifyCommandResult(classifyCommand("cargo test"), {
      status: "timeout",
      output: "1 failed",
    }).definite,
    false,
  );
  assert.equal(
    classifyCommandResult(classifyCommand("npm test | tee out"), {
      status: "unknown",
      output: "12 passed",
    }).status,
    "unknown",
  );
});

test("validates explicit maps and rejects path/glob traversal", async () => {
  const map = await loadExplicitTestMap(`${fixtureDir}/test-map.json`);
  assert.equal(map.mappings[0]?.origin, "explicit");
  assert.equal(map.mappings[0]?.confidence, "high");
  assert.equal(pathMatchesGlob("app/lib/a.ts", "app/**"), true);
  assert.equal(pathMatchesGlob("app/lib/a.ts", "app/*"), false);
  assert.throws(
    () =>
      parseExplicitTestMap({
        mappings: [
          {
            source: ["../outside/**"],
            tests: ["test/**"],
            commands: ["npm test"],
          },
        ],
      }),
    TestMapError,
  );
  assert.throws(
    () =>
      parseExplicitTestMap({
        mappings: [
          {
            source: ["src/[ab].ts"],
            tests: ["test/**"],
            commands: ["npm test"],
          },
        ],
      }),
    TestMapError,
  );
});

test("explicit mappings take priority over manifest mappings and retain evidence", async () => {
  const explicit = await loadExplicitTestMap(`${fixtureDir}/test-map.json`);
  const manifests = await discoverManifestTestMap(fixtureDir);
  const combined = mergeTestMaps(explicit, manifests);
  const relevance = evaluateTestRelevance(
    classifyCommand("npm test"),
    ["app/widget.ts"],
    combined,
  );
  assert.equal(relevance.relevant, true);
  assert.equal(relevance.confidence, "high");
  assert.equal(relevance.origin, "explicit");
  assert.match(relevance.caveat, /explicit/i);
});

test("does not pretend a non-path test filter maps to edited files", () => {
  const map = parseExplicitTestMap({
    mappings: [{
      source: ["src/**"],
      tests: ["test/**"],
      commands: ["npm test"],
    }],
  });
  const relevance = evaluateTestRelevance(
    classifyCommand("npm test -- -t widget"),
    ["src/widget.ts"],
    map,
  );
  assert.equal(relevance.relevant, null);
  assert.equal(
    evaluateTestRelevance(
      classifyCommand("cargo test widget"),
      ["src/widget.rs"],
      { mappings: [], caveats: [] },
    ).relevant,
    null,
  );
});

test("discovers JavaScript and Rust manifest conventions", async () => {
  const map = await discoverManifestTestMap(fixtureDir);
  assert.equal(
    map.mappings.some((mapping) => mapping.commands.includes("npm run test:unit")),
    true,
  );
  assert.equal(
    map.mappings.some((mapping) => mapping.commands.includes("cargo test")),
    true,
  );
  const rust = evaluateTestRelevance(
    classifyCommand("cargo test"),
    ["src/lib.rs"],
    map,
  );
  assert.equal(rust.relevant, true);
  assert.equal(rust.confidence, "medium");
  assert.match(rust.caveat, /Cargo\.toml/);
});

test("uses a conservative low-confidence fallback when no map applies", () => {
  const relevance = evaluateTestRelevance(
    classifyCommand("pytest tests/test_widget.py"),
    ["src/widget.py"],
    { mappings: [], caveats: [] },
  );
  assert.equal(relevance.relevant, true);
  assert.equal(relevance.confidence, "low");
  assert.equal(relevance.origin, "fallback");
  assert.match(relevance.caveat, /fallback/i);
});

function action(
  actionId: string,
  at: number,
  overrides: Partial<TimelineAction> = {},
): TimelineAction {
  return {
    action_id: actionId,
    kind: "tool",
    interval: { start_ms: at, end_ms: at + 100 },
    session_id: "s1",
    agent_id: "root",
    session_refs: [`s1#${actionId}`],
    confidence: "high",
    concurrent: false,
    paths: [],
    ...overrides,
  };
}

function toolUse(
  id: string,
  name: string,
  overrides: Partial<ToolUseEvent> = {},
): ToolUseEvent {
  return {
    kind: "tool_use",
    timestamp_ms: 0,
    session_id: "s1",
    entry_uuid: `use-${id}`,
    session_ref: `s1#use-${id}`,
    source_index: 0,
    agent_id: "root",
    is_sidechain: false,
    confidence: "high",
    tool_use_id: id,
    tool_name: name,
    input: {},
    paths: [],
    edit_fragments: [],
    ...overrides,
  };
}

function toolResult(
  id: string,
  status: ToolResultEvent["status"] = "success",
): ToolResultEvent {
  return {
    kind: "tool_result",
    timestamp_ms: 1,
    session_id: "s1",
    entry_uuid: `result-${id}`,
    session_ref: `s1#result-${id}`,
    source_index: 1,
    agent_id: "root",
    is_sidechain: false,
    confidence: "high",
    tool_use_id: id,
    status,
    output: "",
    output_bytes: 0,
    estimated_tokens: 0,
    ...(status === "success"
      ? { exit_code: 0 }
      : status === "failure"
        ? { exit_code: 1 }
        : {}),
  };
}

function observe(
  id: string,
  at: number,
  name: string,
  options: {
    paths?: string[];
    command?: string;
    fragments?: string[];
    status?: ToolResultEvent["status"];
    cwd?: string;
    agentId?: string;
    endAt?: number;
  } = {},
): ActionObservation {
  const paths = options.paths ?? [];
  const agentId = options.agentId ?? "root";
  const use = toolUse(id, name, {
    agent_id: agentId,
    paths,
    edit_fragments: options.fragments ?? [],
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return {
    action: action(id, at, {
      interval: {
        start_ms: at,
        end_ms: options.endAt ?? at + 100,
      },
      agent_id: agentId,
      paths,
      tool_use_id: id,
      tool_name: name,
      ...(options.command === undefined ? {} : { command: options.command }),
    }),
    toolUse: use,
    toolResult: {
      ...toolResult(id, options.status),
      agent_id: agentId,
    },
  };
}

function file(
  path: string,
  overrides: Partial<FileDiffEvidence> = {},
): FileDiffEvidence {
  return {
    status: "M",
    path,
    addedLines: [],
    binary: false,
    contentComplete: true,
    ...overrides,
  };
}

function diff(
  files: FileDiffEvidence[],
  overrides: Partial<DiffEvidence> = {},
): DiffEvidence {
  return {
    files,
    changedPaths: files.flatMap((entry) =>
      entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path]
    ),
    survivingPaths: files
      .filter((entry) => entry.status !== "D")
      .map((entry) => entry.path),
    renames: [],
    truncated: false,
    caveats: [],
    commits: [],
    reverts: [],
    ...overrides,
  };
}

const explicitMap = parseExplicitTestMap({
  mappings: [
    {
      source: ["src/**"],
      tests: ["test/**"],
      commands: ["npm test"],
    },
  ],
});

test("matches the first relevant full run and a repeated unchanged successful run", () => {
  const observations = [
    observe("edit", 0, "Edit", {
      paths: ["src/widget.ts"],
      fragments: ["export const widget = true;"],
    }),
    observe("run-1", 200, "Bash", { command: "npm test" }),
    observe("run-2", 400, "Bash", { command: "npm   test" }),
  ];
  const matched = matchTimelineActions(observations, {
    diff: diff([
      file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
    ]),
    testMap: explicitMap,
  });
  assert.equal(matched[1]?.match, "contributing_run");
  assert.deepEqual(matched[0]?.relevance_paths, []);
  assert.deepEqual(matched[1]?.relevance_paths, ["src/widget.ts"]);
  assert.equal(matched[2]?.match, "redundant_run");
  assert.deepEqual(matched[2]?.relevance_paths, []);
  assert.equal(matched[2]?.normalized_command, "npm test");
  assert.match(matched[2]?.caveats.join(" ") ?? "", /explicit/i);
});

test("does not call a first or overlapping full-suite run redundant", () => {
  const matched = matchTimelineActions(
    [
      observe("run-1", 0, "Bash", { command: "npm test" }),
      observe("run-overlap", 50, "Bash", { command: "npm test" }),
      observe("run-after", 200, "Bash", { command: "npm test" }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
    },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "unexplained",
    "unexplained",
    "redundant_run",
  ]);
  assert.match(matched[0]?.caveats.join(" ") ?? "", /prior completed successful/i);
});

test("does not snapshot a cross-agent edit until it finishes", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
        agentId: "sidechain",
        endAt: 300,
      }),
      observe("run-overlap", 100, "Bash", {
        command: "npm test",
      }),
      observe("run-after-edit", 400, "Bash", {
        command: "npm test",
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", {
          addedLines: ["export const widget = true;"],
        }),
      ]),
      testMap: explicitMap,
    },
  );

  assert.deepEqual(matched.map((entry) => entry.match), [
    "contributing_edit",
    "unexplained",
    "contributing_run",
  ]);
  assert.match(matched[1]?.caveats.join(" ") ?? "", /overlap|mutation/i);
});

test("does not let an overlapping opaque mutation enter a successful run snapshot", () => {
  const matched = matchTimelineActions(
    [
      observe("baseline", 0, "Bash", { command: "npm test" }),
      observe("opaque", 200, "Bash", {
        command: "python mutate.py > src/widget.ts",
        agentId: "sidechain",
        endAt: 500,
      }),
      observe("run-overlap", 300, "Bash", {
        command: "npm test",
      }),
      observe("run-after-mutation", 600, "Bash", {
        command: "npm test",
      }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
    },
  );

  assert.deepEqual(matched.map((entry) => entry.match), [
    "unexplained",
    "unexplained",
    "unexplained",
    "unexplained",
  ]);
  assert.match(matched[2]?.caveats.join(" ") ?? "", /overlap|mutation/i);
  assert.match(matched[3]?.caveats.join(" ") ?? "", /unknown mutation/i);
});

test("inherits a tool classification for its causal inference without creating a duplicate run", () => {
  const run = observe("run-1", 200, "Bash", { command: "npm test" });
  const inference: ActionObservation = {
    action: action("inference", 310, {
      kind: "inference",
      paths: [],
      tool_use_id: "run-1",
      tool_name: "Bash",
      command: "npm test",
    }),
    ...(run.toolUse === undefined ? {} : { toolUse: run.toolUse }),
    ...(run.toolResult === undefined ? {} : { toolResult: run.toolResult }),
  };
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
      run,
      inference,
      observe("run-2", 500, "Bash", { command: "npm test" }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
    },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "contributing_edit",
    "contributing_run",
    "contributing_run",
    "redundant_run",
  ]);
  assert.deepEqual(matched[1]?.relevance_paths, ["src/widget.ts"]);
  assert.deepEqual(matched[2]?.relevance_paths, ["src/widget.ts"]);
});

test("does not leak inherited tool evidence across session, agent, or tool identities", () => {
  const run = observe("run-1", 200, "Bash", { command: "npm test" });
  const unrelatedInferences: ActionObservation[] = [
    {
      action: action("other-session", 320, {
        kind: "inference",
        session_id: "s2",
        tool_use_id: "run-1",
        tool_name: "Bash",
        command: "npm test",
      }),
    },
    {
      action: action("other-agent", 340, {
        kind: "inference",
        agent_id: "sidechain",
        tool_use_id: "run-1",
        tool_name: "Bash",
        command: "npm test",
      }),
    },
    {
      action: action("other-tool", 360, {
        kind: "inference",
        tool_use_id: "run-2",
        tool_name: "Bash",
        command: "npm test",
      }),
    },
  ];
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
      run,
      ...unrelatedInferences,
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
    },
  );
  assert.deepEqual(matched.slice(2).map((entry) => entry.match), [
    "unexplained",
    "unexplained",
    "unexplained",
  ]);
});

test("classifies an explicitly targeted run after unrelated edits as redundant", () => {
  const matched = matchTimelineActions(
    [
      observe("edit-doc", 0, "Edit", {
        paths: ["docs/readme.md"],
        fragments: ["New documentation paragraph"],
      }),
      observe("targeted", 200, "Bash", {
        command: "npm test -- test/widget.test.ts",
      }),
    ],
    {
      diff: diff([
        file("docs/readme.md", { addedLines: ["New documentation paragraph"] }),
      ]),
      testMap: explicitMap,
    },
  );
  assert.equal(matched[1]?.match, "redundant_run");
  assert.equal(matched[1]?.match_confidence, "high");
});

test("uses surviving fragments as strong edit evidence", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const answer = 42;"],
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const answer = 42;"] }),
      ]),
      testMap: explicitMap,
    },
  );
  assert.equal(matched[0]?.match, "contributing_edit");
  assert.equal(matched[0]?.match_confidence, "high");
});

test("normalizes contained absolute Claude paths from cwd or explicit repo root", () => {
  const fromCwd = matchTimelineActions(
    [
      observe("edit-cwd", 0, "Edit", {
        paths: ["/repo/src/widget.ts"],
        fragments: ["export const widget = true;"],
        cwd: "/repo",
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
    },
  );
  const fromRepoRoot = matchTimelineActions(
    [
      observe("edit-root", 0, "Edit", {
        paths: ["/repo/src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
      repoRoot: "/repo",
    },
  );
  assert.equal(fromCwd[0]?.match, "contributing_edit");
  assert.equal(fromCwd[0]?.target, "src/widget.ts");
  assert.equal(fromRepoRoot[0]?.match, "contributing_edit");
  assert.equal(fromRepoRoot[0]?.target, "src/widget.ts");
});

test("keeps absolute paths outside known repository contexts unexplained", () => {
  const matched = matchTimelineActions(
    [
      observe("outside", 0, "Edit", {
        paths: ["/outside/widget.ts"],
        fragments: ["export const widget = true;"],
        cwd: "/repo",
      }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
      repoRoot: "/repo",
    },
  );
  assert.equal(matched[0]?.match, "unexplained");
  assert.match(matched[0]?.caveats.join(" ") ?? "", /outside|contain/i);
});

test("does not use an out-of-repository cwd when repo root is known", () => {
  const absoluteOutside = matchTimelineActions(
    [
      observe("outside-cwd", 0, "Edit", {
        paths: ["/outside/src/widget.ts"],
        fragments: ["export const widget = true;"],
        cwd: "/outside",
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", {
          addedLines: ["export const widget = true;"],
        }),
      ]),
      testMap: explicitMap,
      repoRoot: "/repo",
    },
  );
  const relativeOutside = matchTimelineActions(
    [
      observe("relative-outside-cwd", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
        cwd: "/outside",
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", {
          addedLines: ["export const widget = true;"],
        }),
      ]),
      testMap: explicitMap,
      repoRoot: "/repo",
    },
  );
  const contained = matchTimelineActions(
    [
      observe("contained-cwd", 0, "Edit", {
        paths: ["/repo/packages/widget/src/index.ts"],
        fragments: ["export const widget = true;"],
        cwd: "/repo/packages/widget",
      }),
    ],
    {
      diff: diff([
        file("packages/widget/src/index.ts", {
          addedLines: ["export const widget = true;"],
        }),
      ]),
      testMap: explicitMap,
      repoRoot: "/repo",
    },
  );

  assert.equal(absoluteOutside[0]?.match, "unexplained");
  assert.match(absoluteOutside[0]?.caveats.join(" ") ?? "", /outside|contain/i);
  assert.equal(relativeOutside[0]?.match, "unexplained");
  assert.match(relativeOutside[0]?.caveats.join(" ") ?? "", /repository-relative/i);
  assert.equal(contained[0]?.match, "contributing_edit");
  assert.equal(contained[0]?.target, "packages/widget/src/index.ts");
});

test("uses strong fragment absence only with complete unambiguous text evidence", () => {
  const candidate = observe("edit", 0, "Edit", {
    paths: ["src/widget.ts"],
    fragments: ["export const discardedApproach = makeLegacyWidget();"],
  });
  const complete = matchTimelineActions([candidate], {
    diff: diff([file("src/widget.ts", { addedLines: ["export const widget = true;"] })]),
    testMap: explicitMap,
  });
  assert.equal(complete[0]?.match, "rework_edit");
  assert.equal(complete[0]?.match_confidence, "high");

  for (const ambiguous of [
    diff([file("src/widget.ts", { contentComplete: false })], { truncated: true }),
    diff([file("src/widget.ts", { binary: true, contentComplete: false })]),
    diff([
      file("src/widget.ts", {
        status: "D",
        contentComplete: false,
      }),
    ]),
    diff([
      file("src/widget.ts", {
        status: "R100",
        oldPath: "src/old-widget.ts",
        contentComplete: true,
      }),
    ], {
      renames: [{
        kind: "rename",
        from: "src/old-widget.ts",
        to: "src/widget.ts",
        similarity: 100,
      }],
    }),
  ]) {
    const result = matchTimelineActions([candidate], {
      diff: ambiguous,
      testMap: explicitMap,
    });
    assert.equal(result[0]?.match, "unexplained");
  }
});

test("treats a path-only edit to a changed text file as lower-confidence contribution", () => {
  const matched = matchTimelineActions(
    [observe("edit", 0, "Write", { paths: ["src/widget.ts"] })],
    {
      diff: diff([file("src/widget.ts", { addedLines: ["changed"] })]),
      testMap: explicitMap,
    },
  );
  assert.equal(matched[0]?.match, "contributing_edit");
  assert.equal(matched[0]?.match_confidence, "low");
  assert.match(matched[0]?.caveats.join(" ") ?? "", /path-only/i);
});

test("keeps opaque shell, invalid paths, and ambiguous mutations unexplained", () => {
  const matched = matchTimelineActions(
    [
      observe("shell", 0, "Bash", {
        command: "python mutate.py > src/widget.ts",
      }),
      observe("escape", 200, "Edit", {
        paths: ["../outside.ts"],
        fragments: ["strong fragment outside repository"],
      }),
    ],
    {
      diff: diff([file("src/widget.ts")]),
      testMap: explicitMap,
    },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "unexplained",
    "unexplained",
  ]);
});

test("does not use an invalid-path edit as proof that a later run was unrelated", () => {
  const matched = matchTimelineActions(
    [
      observe("escape", 0, "Edit", {
        paths: ["../outside.ts"],
        fragments: ["strong fragment outside repository"],
      }),
      observe("run", 200, "Bash", { command: "npm test" }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
    },
  );
  assert.equal(matched[1]?.match, "unexplained");
});

test("uses explicit revert-path evidence to support otherwise ambiguous rework", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/legacy.bin"],
        fragments: ["opaque but reverted payload"],
      }),
    ],
    {
      diff: diff([
        file("src/legacy.bin", { binary: true, contentComplete: false }),
      ], {
        reverts: [{
          commitOid: "a".repeat(40),
          revertedCommitOid: "b".repeat(40),
          subject: 'Revert "legacy experiment"',
          paths: ["src/legacy.bin"],
        }],
      }),
      testMap: explicitMap,
    },
  );
  assert.equal(matched[0]?.match, "rework_edit");
  assert.equal(matched[0]?.match_confidence, "medium");
});

test("prefers surviving fragment and path evidence over path-only revert history", () => {
  const revert = {
    commitOid: "a".repeat(40),
    revertedCommitOid: "b".repeat(40),
    subject: 'Revert "earlier experiment"',
    paths: ["src/widget.ts"],
  };
  const fragment = matchTimelineActions(
    [
      observe("edit-fragment", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const finalWidget = true;"],
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", {
          addedLines: ["export const finalWidget = true;"],
        }),
      ], { reverts: [revert] }),
      testMap: explicitMap,
    },
  );
  const pathOnly = matchTimelineActions(
    [observe("edit-path", 0, "Write", { paths: ["src/widget.ts"] })],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["final content"] }),
      ], { reverts: [revert] }),
      testMap: explicitMap,
    },
  );
  assert.equal(fragment[0]?.match, "contributing_edit");
  assert.equal(pathOnly[0]?.match, "contributing_edit");
});

test("detects successful duplicate reads but excludes a read after an edit", () => {
  const matched = matchTimelineActions(
    [
      observe("read-1", 0, "Read", { paths: ["src/widget.ts"] }),
      observe("read-2", 200, "Read", { paths: ["src/widget.ts"] }),
      observe("edit", 400, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
      observe("read-3", 600, "Read", { paths: ["src/widget.ts"] }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
    },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "safe_read",
    "duplicate_read",
    "contributing_edit",
    "safe_read",
  ]);
});

test("requires the first read to finish before a duplicate begins", () => {
  const matched = matchTimelineActions(
    [
      observe("read-1", 0, "Read", { paths: ["src/widget.ts"] }),
      observe("read-overlap", 50, "Read", { paths: ["src/widget.ts"] }),
      observe("read-after", 200, "Read", { paths: ["src/widget.ts"] }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
    },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "safe_read",
    "safe_read",
    "duplicate_read",
  ]);
});

test("invalid-path edits and opaque shell actions invalidate duplicate-read state", () => {
  const matched = matchTimelineActions(
    [
      observe("read-1", 0, "Read", { paths: ["src/widget.ts"] }),
      observe("invalid-edit", 200, "Edit", { paths: ["../unknown.ts"] }),
      observe("read-2", 400, "Read", { paths: ["src/widget.ts"] }),
      observe("opaque-shell", 600, "Bash", {
        command: "python mutate.py > src/widget.ts",
      }),
      observe("read-3", 800, "Read", { paths: ["src/widget.ts"] }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
    },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "safe_read",
    "unexplained",
    "safe_read",
    "unexplained",
    "safe_read",
  ]);
});

test("does not call a second read duplicate when the first read failed", () => {
  const matched = matchTimelineActions(
    [
      observe("read-1", 0, "Read", {
        paths: ["src/widget.ts"],
        status: "failure",
      }),
      observe("read-2", 200, "Read", { paths: ["src/widget.ts"] }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
    },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "safe_read",
    "safe_read",
  ]);
});
