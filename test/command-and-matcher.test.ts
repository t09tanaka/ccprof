import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";

import {
  classifyCommand,
  classifyCommandResult,
  normalizeCommand,
} from "../src/analysis/command.js";
import { buildCommandIdentity, commandIdentityKey, deriveRepoRelativeCwd, formatCommandIdentityTarget } from "../src/analysis/command-identity.js";
import {
  discoverManifestTestMap,
  evaluateTestRelevance,
  loadExplicitTestMap,
  mergeTestMaps,
  parseExplicitTestMap,
  pathMatchesGlob,
  TestMapError,
  type TestMap,
  type TestMapOrigin,
} from "../src/analysis/test-map.js";
import {
  loadRepositoryConfig,
  RepositoryConfigError,
} from "../src/analysis/repository-config.js";
import {
  matchTimelineActions,
  type ActionObservation,
} from "../src/analysis/diff-matcher.js";
import type {
  DiffEvidence,
  FileDiffEvidence,
} from "../src/git/diff.js";
import type {
  CommandIdentity,
  TimelineAction,
  ToolResultEvent,
  ToolUseEvent,
} from "../src/core/model.js";

const fixtureDir = `${process.cwd()}/test/fixtures/manifests`;

async function temporaryConfigRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-config-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRepositoryConfig(
  repoRoot: string,
  value: unknown,
): Promise<void> {
  const path = join(repoRoot, ".ccprof", "config.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

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

test("derives safe repository-relative CWDs for POSIX and Windows paths", () => {
  assert.equal(deriveRepoRelativeCwd("/repo", "/repo"), ".");
  assert.equal(deriveRepoRelativeCwd("/repo", "/repo/packages/api"), "packages/api");
  assert.equal(deriveRepoRelativeCwd("/repo", "/repo/packages\\api"), "packages\\api");
  assert.equal(deriveRepoRelativeCwd("C:\\repo", "C:/repo/packages/api"), "packages/api");
  assert.equal(deriveRepoRelativeCwd("\\\\server\\share\\repo", "\\\\server\\share\\repo\\api"), "api");
});

test("rejects missing, relative, outside, different-drive, and mixed CWD evidence", () => {
  const cases: [string | undefined, string | undefined][] = [
    [undefined, "/repo"],
    ["/repo", undefined],
    ["repo", "/repo"],
    ["/repo", "packages/api"],
    ["/repo", "/repo-other"],
    ["C:\\repo", "D:\\repo"],
    ["/repo", "C:\\repo"],
    ["C:\\repo", "/repo"],
    ["\\\\server\\share\\repo", "\\\\other\\share\\repo"],
  ];
  for (const [repoRoot, cwd] of cases) assert.equal(deriveRepoRelativeCwd(repoRoot, cwd), undefined);
});

test("builds argv-aware identities and stable collision-resistant tuple keys", () => {
  const descriptor = classifyCommand(`npm test -- '' "test/a b.test.ts"`);
  const identity = buildCommandIdentity("/repo", "/repo/packages/api", descriptor);
  assert.deepEqual(identity, {
    repo_relative_cwd: "packages/api",
    normalized_argv: ["npm", "test", "--", "", "test/a b.test.ts"],
    executor: "shell",
  });
  assert.equal(
    formatCommandIdentityTarget(identity!, descriptor.normalized),
    `packages/api :: npm test -- "" "test/a b.test.ts"`,
  );
  assert.equal(formatCommandIdentityTarget({ ...identity!, repo_relative_cwd: "." }, "npm test"), ". :: npm test");
  assert.equal(buildCommandIdentity("/repo", "/repo", classifyCommand("")), undefined);
  assert.equal(buildCommandIdentity("/repo", "/repo", classifyCommand("npm test && touch x")), undefined);

  const collisionA: CommandIdentity = { repo_relative_cwd: "a|b", normalized_argv: ["c", ""], executor: "shell" };
  const collisionB: CommandIdentity = { repo_relative_cwd: "a", normalized_argv: ["b|c", ""], executor: "shell" };
  assert.notEqual(commandIdentityKey(collisionA), commandIdentityKey(collisionB));
  assert.notEqual(commandIdentityKey(collisionA), commandIdentityKey({ ...collisionA, executor: "native-tool" }));
  assert.deepEqual(JSON.parse(commandIdentityKey(collisionA)), ["a|b", ["c", ""], "shell"]);
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

test("classifies only complete provenance-aware result signals", () => {
  const output = "✓ 2 passed";
  const outputBytes = Buffer.byteLength(output);
  const unknown = { status: "unknown", source: "none", confidence: "low", definite: false } as const;
  const cases = [
    ["explicit conflict is authoritative", { statusEvidence: { status: "unknown", source: "explicit_status", confidence: "low" }, exitCode: 0, output, outputBytes }, { status: "unknown", source: "explicit_status", confidence: "low", definite: false }],
    ["adapter evidence outranks raw fields", { statusEvidence: { status: "success", source: "tool_adapter", confidence: "medium" }, exitCode: 1 }, { status: "success", source: "tool_adapter", confidence: "medium", definite: true }],
    ["exit code is the fallback", { statusEvidence: { status: "unknown", source: "none", confidence: "low" }, exitCode: 1 }, { status: "failure", source: "exit_code", confidence: "high", definite: true }],
    ["arbitrary text stays unknown", { output: "fatal error", outputBytes: Buffer.byteLength("fatal error") }, unknown],
    ["complete UTF-8 pattern", { output, outputBytes }, { status: "success", source: "output_pattern", confidence: "medium", definite: true }],
    ["UTF-16 length is not byte completeness", { output, outputBytes: output.length }, unknown],
    ["complete precomputed pattern", { statusEvidence: { status: "success", source: "output_pattern", confidence: "medium" }, output, outputBytes }, { status: "success", source: "output_pattern", confidence: "medium", definite: true }],
    ["truncated precomputed pattern", { statusEvidence: { status: "success", source: "output_pattern", confidence: "medium" }, output, outputBytes: outputBytes + 1 }, unknown],
    ["legacy scalar is accepted without evidence", { status: "success" }, { status: "success", source: "explicit_status", confidence: "high", definite: true }],
    ["present none evidence ignores scalar", { statusEvidence: { status: "unknown", source: "none", confidence: "low" }, status: "success" }, unknown],
  ] as const;
  for (const [label, signal, expected] of cases) {
    assert.deepEqual(classifyCommandResult(classifyCommand("pytest"), signal as unknown as Parameters<typeof classifyCommandResult>[1]), expected, label);
  }
  for (const bytes of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, outputBytes - 1, outputBytes + 1]) {
    const signal = bytes === undefined ? { output } : { output, outputBytes: bytes };
    assert.deepEqual(classifyCommandResult(classifyCommand("pytest"), signal), unknown, `outputBytes=${String(bytes)}`);
  }
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

test("missing repository config preserves the empty-map behavior", async (t) => {
  const repoRoot = await temporaryConfigRepository(t);
  assert.deepEqual(await loadRepositoryConfig(repoRoot), {
    mappings: [],
    caveats: [],
  });
});

test("loads and normalizes a strict repository config v1", async (t) => {
  const repoRoot = await temporaryConfigRepository(t);
  await writeRepositoryConfig(repoRoot, {
    $schema:
      "https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/config.schema.json",
    schema_version: 1,
    test_map: {
      mappings: [{
        source: ["./src/**", "src/**"],
        tests: ["./test/**"],
        commands: ["  npm   test  ", "npm test"],
      }],
    },
  });

  assert.deepEqual(await loadRepositoryConfig(repoRoot), {
    mappings: [{
      source: ["src/**"],
      tests: ["test/**"],
      commands: ["npm test"],
      confidence: "high",
      origin: "config",
      caveat: "Relevance is based on .ccprof/config.json.",
    }],
    caveats: [],
    config_schema_version: 1,
  });
});

test("repository config rejects malformed and non-closed contracts", async (t) => {
  const repoRoot = await temporaryConfigRepository(t);
  const cases: readonly [string, unknown][] = [
    ["malformed JSON", "{"],
    ["missing schema version", { test_map: { mappings: [] } }],
    ["future schema version", { schema_version: 2 }],
    ["unknown top-level key", { schema_version: 1, retention: {} }],
    ["invalid schema URI", { schema_version: 1, $schema: 7 }],
    [
      "unknown test-map key",
      { schema_version: 1, test_map: { mappings: [], extra: true } },
    ],
    [
      "unknown mapping key",
      {
        schema_version: 1,
        test_map: {
          mappings: [{
            source: ["src/**"], tests: ["test/**"],
            commands: ["npm test"], cwd: ".",
          }],
        },
      },
    ],
    [
      "missing nested required key",
      {
        schema_version: 1,
        test_map: {
          mappings: [{ source: ["src/**"], tests: ["test/**"] }],
        },
      },
    ],
    [
      "path traversal",
      {
        schema_version: 1,
        test_map: {
          mappings: [{
            source: ["../outside/**"], tests: ["test/**"],
            commands: ["npm test"],
          }],
        },
      },
    ],
    [
      "absolute path",
      {
        schema_version: 1,
        test_map: {
          mappings: [{
            source: ["/outside/**"], tests: ["test/**"],
            commands: ["npm test"],
          }],
        },
      },
    ],
    [
      "shell composition",
      {
        schema_version: 1,
        test_map: {
          mappings: [{
            source: ["src/**"], tests: ["test/**"],
            commands: ["npm test && touch sentinel"],
          }],
        },
      },
    ],
  ];

  for (const [label, value] of cases) {
    await writeRepositoryConfig(repoRoot, value);
    await assert.rejects(
      loadRepositoryConfig(repoRoot),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryConfigError, label);
        assert.match(error.message, /^\.ccprof\/config\.json:/u, label);
        assert.ok(!error.message.includes(repoRoot), label);
        return true;
      },
    );
  }
});

test("repository config errors never echo rejected paths, commands, or keys", async (t) => {
  const repoRoot = await temporaryConfigRepository(t);
  const sentinel = "CCPROF_PRIVATE_SENTINEL_92f73b";
  const absolutePath = `/Users/${sentinel}/private-repo/**`;
  const cases: readonly unknown[] = [
    { schema_version: 1, [sentinel]: true },
    {
      schema_version: 1,
      test_map: {
        mappings: [{
          source: [absolutePath], tests: ["test/**"], commands: ["npm test"],
        }],
      },
    },
    {
      schema_version: 1,
      test_map: {
        mappings: [{
          source: ["src/**"], tests: ["test/**"],
          commands: [`npm test && touch ${sentinel}`],
        }],
      },
    },
  ];

  for (const value of cases) {
    await writeRepositoryConfig(repoRoot, value);
    await assert.rejects(
      loadRepositoryConfig(repoRoot),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryConfigError);
        assert.doesNotMatch(error.message, new RegExp(sentinel, "u"));
        assert.ok(!error.message.includes(absolutePath));
        return true;
      },
    );
  }
});

test("repository config rejects symlinks and non-regular files", async (t) => {
  const repoRoot = await temporaryConfigRepository(t);
  const configPath = join(repoRoot, ".ccprof", "config.json");
  const targetPath = join(repoRoot, "outside-config.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(targetPath, '{"schema_version":1}\n', "utf8");
  await symlink(targetPath, configPath);

  await assert.rejects(loadRepositoryConfig(repoRoot), RepositoryConfigError);
  await rm(configPath);
  await mkdir(configPath);
  await assert.rejects(loadRepositoryConfig(repoRoot), RepositoryConfigError);
});

test("repository config rejects a symlinked .ccprof parent without reading outside the repository", async (t) => {
  const repoRoot = await temporaryConfigRepository(t);
  const externalDirectory = await mkdtemp(
    join(tmpdir(), "ccprof-external-config-"),
  );
  t.after(async () => rm(externalDirectory, { recursive: true, force: true }));
  const canaryPath = join(externalDirectory, "canary.txt");
  const canary = "external-canary-must-not-change\n";
  await writeFile(
    join(externalDirectory, "config.json"),
    '{"schema_version":1}\n',
    "utf8",
  );
  await writeFile(canaryPath, canary, "utf8");
  await symlink(externalDirectory, join(repoRoot, ".ccprof"), "dir");

  await assert.rejects(loadRepositoryConfig(repoRoot), RepositoryConfigError);
  assert.equal(await readFile(canaryPath, "utf8"), canary);
});

test("repository config surfaces a file close failure", async (t) => {
  const repoRoot = await temporaryConfigRepository(t);
  await writeRepositoryConfig(repoRoot, { schema_version: 1 });
  type OpenFile = typeof open;
  const cjsRequire = createRequire(import.meta.url);
  const promises = cjsRequire("node:fs/promises") as {
    open: OpenFile;
  };
  const originalOpen = promises.open;
  const failingOpen = (async (...args: Parameters<OpenFile>) => {
    const handle = await originalOpen(...args);
    const originalClose = handle.close.bind(handle);
    handle.close = async (): Promise<void> => {
      await originalClose();
      throw Object.assign(
        new Error("synthetic close failure"),
        { code: "EIO" },
      );
    };
    return handle;
  }) as OpenFile;

  try {
    promises.open = failingOpen;
    syncBuiltinESMExports();
    await assert.rejects(
      loadRepositoryConfig(repoRoot),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryConfigError);
        assert.match(error.message, /cannot be closed \(EIO\)$/u);
        return true;
      },
    );
  } finally {
    promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("the published config schema is closed and included in the npm package", async () => {
  const [schemaText, packageText] = await Promise.all([
    readFile(resolve(process.cwd(), "schemas/config.schema.json"), "utf8"),
    readFile(resolve(process.cwd(), "package.json"), "utf8"),
  ]);
  const schema = JSON.parse(schemaText) as {
    additionalProperties?: unknown;
    required?: unknown;
    properties?: Record<string, unknown>;
  };
  const manifest = JSON.parse(packageText) as { files?: unknown };

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schema_version"]);
  assert.ok(schema.properties?.schema_version);
  assert.ok(schema.properties?.test_map);
  const testMapSchema = schema.properties?.test_map as {
    required?: unknown;
    properties?: {
      mappings?: { items?: { required?: unknown } };
    };
  };
  assert.deepEqual(testMapSchema.required, ["mappings"]);
  assert.deepEqual(testMapSchema.properties?.mappings?.items?.required, [
    "source",
    "tests",
    "commands",
  ]);
  assert.ok(Array.isArray(manifest.files));
  assert.ok(manifest.files.includes("schemas"));
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

test("test-map origins resolve explicit before config before manifest", () => {
  const map = (
    origin: TestMapOrigin,
    source: string,
    confidence: "high" | "medium",
  ): TestMap => ({
    mappings: [{
      source: [`${source}/**`],
      tests: [`${source}-test/**`],
      commands: ["npm test"],
      confidence,
      origin,
      caveat: `${origin} mapping`,
    }],
    caveats: [],
    ...(origin === "config" ? { config_schema_version: 1 as const } : {}),
  });
  const explicit = map("explicit", "explicit", "high");
  const config = map("config", "config", "high");
  const manifest = map("manifest", "manifest", "medium");
  const descriptor = classifyCommand("npm test");

  const explicitResult = evaluateTestRelevance(
    descriptor,
    ["config/widget.ts"],
    mergeTestMaps(explicit, config, manifest),
  );
  assert.equal(explicitResult.origin, "explicit");
  assert.equal(explicitResult.relevant, false);

  const configResult = evaluateTestRelevance(
    descriptor,
    ["config/widget.ts"],
    mergeTestMaps(config, manifest),
  );
  assert.equal(configResult.origin, "config");
  assert.equal(configResult.confidence, "high");
  assert.equal(configResult.relevant, true);

  const manifestResult = evaluateTestRelevance(
    descriptor,
    ["manifest/widget.ts"],
    manifest,
  );
  assert.equal(manifestResult.origin, "manifest");
  assert.equal(manifestResult.confidence, "medium");
  assert.equal(manifestResult.relevant, true);

  assert.deepEqual(mergeTestMaps(manifest, config, explicit), {
    mappings: [
      ...manifest.mappings,
      ...config.mappings,
      ...explicit.mappings,
    ],
    caveats: [],
    config_schema_version: 1,
  });
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
    sessionId?: string;
    endAt?: number;
  } = {},
): ActionObservation {
  const paths = options.paths ?? [];
  const agentId = options.agentId ?? "root";
  const sessionId = options.sessionId ?? "s1";
  const use = toolUse(id, name, {
    agent_id: agentId,
    session_id: sessionId,
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
      session_id: sessionId,
      paths,
      tool_use_id: id,
      tool_name: name,
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    }),
    toolUse: use,
    toolResult: {
      ...toolResult(id, options.status),
      agent_id: agentId,
      session_id: sessionId,
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
    observe("run-1", 200, "Bash", { command: "npm test", cwd: "/repo" }),
    observe("run-2", 400, "Bash", { command: "npm   test", cwd: "/repo" }),
  ];
  const matched = matchTimelineActions(observations, {
    diff: diff([
      file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
    ]),
    testMap: explicitMap,
    repoRoot: "/repo",
  });
  assert.equal(matched[1]?.match, "contributing_run");
  assert.deepEqual(matched[0]?.relevance_paths, []);
  assert.deepEqual(matched[1]?.relevance_paths, ["src/widget.ts"]);
  assert.equal(matched[2]?.match, "redundant_run");
  assert.deepEqual(matched[2]?.relevance_paths, []);
  assert.equal(matched[2]?.normalized_command, "npm test");
  assert.match(matched[2]?.caveats.join(" ") ?? "", /explicit/i);
});

test("only valid result evidence seeds successful-run snapshots", () => {
  const scalar = observe("scalar", 0, "Bash", { command: "npm test", cwd: "/repo" });
  if (scalar.toolResult !== undefined) delete scalar.toolResult.exit_code;
  scalar.toolResult!.status_evidence = { status: "unknown", source: "none", confidence: "low" };
  const truncated = observe("truncated", 200, "Bash", {
    command: "npm test",
    cwd: "/repo",
    status: "unknown",
  });
  Object.assign(truncated.toolResult!, {
    status_evidence: { status: "success", source: "output_pattern", confidence: "medium" },
    output: "1 passed",
    output_bytes: Buffer.byteLength("1 passed") + 1,
  });
  const valid = observe("valid", 400, "Bash", {
    command: "npm test",
    cwd: "/repo",
    status: "unknown",
  });
  Object.assign(valid.toolResult!, {
    status_evidence: { status: "success", source: "output_pattern", confidence: "medium" },
    output: "1 passed",
    output_bytes: Buffer.byteLength("1 passed"),
  });
  const matched = matchTimelineActions(
    [
      scalar,
      truncated,
      valid,
      observe("repeat", 600, "Bash", { command: "npm test", cwd: "/repo" }),
    ],
    { diff: diff([]), testMap: explicitMap, repoRoot: "/repo" },
  );
  assert.deepEqual(matched.map(({ match }) => match), [
    "unexplained",
    "unexplained",
    "unexplained",
    "redundant_run",
  ]);
  assert.equal(matched[3]?.match_confidence, "medium");
});

test("scopes successful-run reuse by command identity CWD and executor", () => {
  const matched = matchTimelineActions(
    [
      observe("api-1", 0, "Bash", { command: "npm test", cwd: "/repo/packages/api" }),
      observe("api-native", 200, "NativeCommand", { command: "npm test", cwd: "/repo/packages/api" }),
      observe("web", 400, "Bash", { command: "npm test", cwd: "/repo/packages/web" }),
      observe("api-2", 600, "Bash", { command: "npm test", cwd: "/repo/packages/api" }),
    ],
    { diff: diff([]), testMap: explicitMap, repoRoot: "/repo" },
  );
  assert.deepEqual(matched.map(({ match }) => match), [
    "unexplained",
    "unexplained",
    "unexplained",
    "redundant_run",
  ]);
  assert.deepEqual(matched.map(({ target }) => target), [
    "packages/api :: npm test",
    "packages/api :: npm test",
    "packages/web :: npm test",
    "packages/api :: npm test",
  ]);
  assert.deepEqual(matched.map(({ command_identity }) => command_identity?.executor), ["shell", "native-tool", "shell", "shell"]);
  assert.equal(matched[3]?.normalized_command, "npm test");
  assert.equal(matched[3]?.command_identity?.repo_relative_cwd, "packages/api");
});

test("never shares successful-run state between identity-less commands", () => {
  const matched = matchTimelineActions(
    [
      observe("missing", 0, "Bash", { command: "npm test" }),
      observe("relative", 200, "Bash", { command: "npm test", cwd: "packages/api" }),
    ],
    { diff: diff([]), testMap: explicitMap, repoRoot: "/repo" },
  );
  assert.deepEqual(matched.map(({ match }) => match), ["unexplained", "unexplained"]);
  assert.deepEqual(matched.map(({ command_identity }) => command_identity), [undefined, undefined]);
  assert.ok(matched.every(({ caveats }) => /identity.*unavailable/i.test(caveats.join(" "))));
});

test("does not call a first or overlapping full-suite run redundant", () => {
  const matched = matchTimelineActions(
    [
      observe("run-1", 0, "Bash", { command: "npm test", cwd: "/repo" }),
      observe("run-overlap", 50, "Bash", { command: "npm test", cwd: "/repo" }),
      observe("run-after", 200, "Bash", { command: "npm test", cwd: "/repo" }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
      repoRoot: "/repo",
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
  const run = observe("run-1", 200, "Bash", {
    command: "npm test",
    cwd: "/repo/packages/api",
  });
  const inference: ActionObservation = {
    action: action("inference", 310, {
      kind: "inference",
      paths: [],
      tool_use_id: "run-1",
      tool_name: "Bash",
      command: "npm test",
      cwd: "/repo/packages/api",
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
      observe("run-2", 500, "Bash", { command: "npm test", cwd: "/repo/packages/api" }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
      repoRoot: "/repo",
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
  assert.equal(matched[2]?.cwd, "/repo/packages/api");
  assert.deepEqual(matched[2]?.command_identity, matched[1]?.command_identity);
  assert.equal(matched[2]?.target, "packages/api :: npm test");
  assert.equal(matched[2]?.normalized_command, "npm test");
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

test("caps surviving truncated fragment evidence and discloses truncation", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: [
          "export const finalWidget = true;\n[input truncated]",
        ],
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", {
          addedLines: ["export const finalWidget = true;"],
        }),
      ]),
      testMap: explicitMap,
    },
  );

  assert.equal(matched[0]?.match, "contributing_edit");
  assert.equal(matched[0]?.match_confidence, "medium");
  assert.match(matched[0]?.caveats.join(" ") ?? "", /truncat/i);
});

test("never infers rework from an absent truncated fragment", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: [
          "export const discardedApproach = makeLegacyWidget();\n[input truncated]",
        ],
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", {
          addedLines: ["export const finalWidget = true;"],
        }),
      ]),
      testMap: explicitMap,
    },
  );

  assert.equal(matched[0]?.match, "unexplained");
  assert.equal(matched[0]?.match_confidence, "low");
  assert.match(matched[0]?.caveats.join(" ") ?? "", /truncat/i);
});

test("does not treat deletion-only patch text as edit fragment evidence", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "apply_patch", {
        paths: ["src/widget.ts"],
        fragments: [
          [
            "*** Begin Patch",
            "*** Update File: src/widget.ts",
            "@@",
            "-export const discardedApproach = makeLegacyWidget();",
            " export const unchangedContext = true;",
            "*** End Patch",
          ].join("\n"),
        ],
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", {
          addedLines: ["export const finalWidget = true;"],
        }),
      ]),
      testMap: explicitMap,
    },
  );

  assert.equal(matched[0]?.match, "contributing_edit");
  assert.equal(matched[0]?.match_confidence, "low");
  assert.match(matched[0]?.caveats.join(" ") ?? "", /path-only/i);
});

test("retains plus-prefixed source lines as strong patch evidence", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "apply_patch", {
        paths: ["src/widget.ts"],
        fragments: [
          [
            "*** Begin Patch",
            "*** Update File: src/widget.ts",
            "@@",
            "+++currentIndex;",
            "*** End Patch",
          ].join("\n"),
        ],
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", {
          addedLines: ["++currentIndex;"],
        }),
      ]),
      testMap: explicitMap,
    },
  );

  assert.equal(matched[0]?.match, "contributing_edit");
  assert.equal(matched[0]?.match_confidence, "high");
});

test("retains plus-prefixed source lines in an add-file patch without a hunk", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "apply_patch", {
        paths: ["src/widget.ts"],
        fragments: [
          [
            "*** Begin Patch",
            "*** Add File: src/widget.ts",
            "+++currentIndex;",
            "*** End Patch",
          ].join("\n"),
        ],
      }),
    ],
    {
      diff: diff([
        file("src/widget.ts", {
          addedLines: ["++currentIndex;"],
        }),
      ]),
      testMap: explicitMap,
    },
  );

  assert.equal(matched[0]?.match, "contributing_edit");
  assert.equal(matched[0]?.match_confidence, "high");
});

test("ignores unified diff file headers when matching edit fragments", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "apply_patch", {
        paths: ["long/path.ts"],
        fragments: [
          [
            "diff --git a/first.ts b/first.ts",
            "--- a/first.ts",
            "+++ b/first.ts",
            "@@ -0,0 +1 @@",
            "+x;",
            "--- a/long/path.ts",
            "+++ b/long/path.ts",
            "@@ -1 +0,0 @@",
            "-discarded",
          ].join("\n"),
        ],
      }),
    ],
    {
      diff: diff([
        file("long/path.ts", {
          addedLines: ["++ b/long/path.ts"],
        }),
      ]),
      testMap: explicitMap,
    },
  );

  assert.equal(matched[0]?.match, "contributing_edit");
  assert.equal(matched[0]?.match_confidence, "low");
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

test("stores normalized paths on safe and duplicate multi-path reads", () => {
  const paths = ["src/a.ts", "/repo/pkg/src/b.ts"];
  const matched = matchTimelineActions(
    [
      observe("mixed-read-1", 0, "Read", { paths, cwd: "/repo/pkg" }),
      observe("mixed-read-2", 200, "Read", { paths, cwd: "/repo/pkg" }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
      repoRoot: "/repo",
    },
  );

  assert.deepEqual(matched.map(({ match }) => match), [
    "safe_read",
    "duplicate_read",
  ]);
  assert.deepEqual(matched[0]?.paths, [
    "pkg/src/a.ts",
    "pkg/src/b.ts",
  ]);
  assert.deepEqual(matched[1]?.paths, matched[0]?.paths);
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

test("caps duplicate-read confidence by complete output-pattern evidence", () => {
  const reads = ["first", "repeat"].map((id, index) => observe(
    id, index * 200, "Read", { paths: ["src/widget.ts"], status: "unknown" },
  ));
  for (const read of reads) Object.assign(read.toolResult!, {
    status_evidence: { status: "success", source: "output_pattern", confidence: "medium" },
    output: "read complete",
    output_bytes: Buffer.byteLength("read complete"),
  });
  const matched = matchTimelineActions(reads, { diff: diff([]), testMap: explicitMap });
  assert.deepEqual(matched.map(({ match }) => match), ["safe_read", "duplicate_read"]);
  assert.deepEqual(matched.map(({ match_confidence }) => match_confidence), ["medium", "medium"]);
});

test("scopes duplicate reads to the same session and agent context", () => {
  const matched = matchTimelineActions(
    [
      observe("root-read", 0, "Read", { paths: ["src/widget.ts"] }),
      observe("agent-first", 200, "Read", {
        paths: ["src/widget.ts"],
        agentId: "sidechain",
      }),
      observe("session-first", 400, "Read", {
        paths: ["src/widget.ts"],
        sessionId: "s2",
      }),
      observe("root-repeat", 600, "Read", {
        paths: ["src/widget.ts"],
      }),
      observe("agent-repeat", 800, "Read", {
        paths: ["src/widget.ts"],
        agentId: "sidechain",
      }),
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
    },
  );

  assert.deepEqual(matched.map((entry) => entry.match), [
    "safe_read",
    "safe_read",
    "safe_read",
    "duplicate_read",
    "duplicate_read",
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

test("failed or missing-result reads are unexplained and never seed duplicates", () => {
  const missingResult = observe("read-missing", 400, "Read", {
    paths: ["src/widget.ts"],
  });
  delete missingResult.toolResult;
  const matched = matchTimelineActions(
    [
      observe("read-1", 0, "Read", {
        paths: ["src/widget.ts"],
        status: "failure",
      }),
      observe("read-2", 200, "Read", { paths: ["src/widget.ts"] }),
      missingResult,
    ],
    {
      diff: diff([]),
      testMap: explicitMap,
    },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "unexplained",
    "safe_read",
    "unexplained",
  ]);
  assert.equal(matched[0]?.match_confidence, "low");
  assert.match(matched[0]?.caveats.join("\n") ?? "", /successful/iu);
});

test("recognizes vcs and inspect command families deterministically", () => {
  assert.equal(classifyCommand("git status").family, "vcs");
  assert.equal(classifyCommand("git status").opaque, false);
  assert.equal(classifyCommand("gh pr view 12").family, "vcs");
  assert.equal(classifyCommand("ls -la").family, "inspect");
  assert.equal(classifyCommand("rg pattern src").family, "inspect");
  const composed = classifyCommand("git status && unknown-tool");
  assert.equal(composed.opaque, true);
  assert.equal(composed.family, "other");
});

test("recognizes additional read-only executables and write-mode sed conservatively", () => {
  for (const [command, family] of [
    ["echo done", "inspect"],
    ["printf %s x", "inspect"],
    ["date -u", "inspect"],
    ["sed -n 1p src/a.ts", "inspect"],
    ["sed s/a/b/ src/a.ts", "inspect"],
    ["sed -i.bak s/a/b/ src/a.ts", "other"],
    ["sed -i s/a/b/ src/a.ts", "other"],
    ["sed --in-place=.bak s/a/b/ src/a.ts", "other"],
    ["sed -ni s/a/b/ src/a.ts", "other"],
    ["sed -nEi.bak s/a/b/ src/a.ts", "other"],
    ["xargs rm", "other"],
    ["mkdir build", "other"],
  ] as const) {
    assert.equal(classifyCommand(command).family, family, command);
  }
  const composite = classifyCommand("echo foo && git add x");
  assert.equal(composite.opaque, false);
  assert.equal(composite.family, "vcs");
});

test("keeps writable variants of find, sort, and awk unrecognized", () => {
  for (const [command, family] of [
    ["find src -name *.ts", "inspect"],
    ["find . -delete", "other"],
    ["find . -exec rm {} \\;", "other"],
    ["find . -execdir chmod +x {} \\;", "other"],
    ["find . -fprintf log %p", "other"],
    ["sort file.txt", "inspect"],
    ["sort -u file.txt", "inspect"],
    ["sort -o out.txt file.txt", "other"],
    ["sort --output=out.txt file.txt", "other"],
    ["awk {print} file.txt", "other"],
  ] as const) {
    assert.equal(classifyCommand(command).family, family, command);
  }
});

test("only all-and composites keep a definite success and never a definite failure", () => {
  const piped = classifyCommand("npm test 2>&1 | tail -1");
  const unknown = { status: "unknown", definite: false, source: "none", confidence: "low" } as const;
  for (const raw of [piped, classifyCommand("npm test ; true"), classifyCommand("npm test || true")]) {
    assert.deepEqual(
      classifyCommandResult(raw, { exitCode: 0 }),
      unknown,
      raw.raw,
    );
  }
  assert.deepEqual(
    classifyCommandResult(piped, { statusEvidence: { status: "timeout", source: "explicit_status", confidence: "high" } }),
    { status: "timeout", definite: false, source: "explicit_status", confidence: "high" },
  );

  const allAnd = classifyCommand("npm test && npm run build");
  assert.deepEqual(
    classifyCommandResult(allAnd, { statusEvidence: { status: "success", source: "tool_adapter", confidence: "medium" } }),
    { status: "success", definite: true, source: "tool_adapter", confidence: "medium" },
  );
  const failed = classifyCommandResult(allAnd, { exitCode: 1 });
  assert.equal(failed.status, "failure");
  assert.equal(failed.definite, false);

  const redirectOnly = classifyCommand("npm test 2>&1");
  assert.deepEqual(
    classifyCommandResult(redirectOnly, { exitCode: 1 }),
    { status: "failure", definite: true, source: "exit_code", confidence: "high" },
  );
});

test("a piped test success does not seed the redundant-run history", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
      observe("run-1", 200, "Bash", { command: "npm test 2>&1 | tail -1" }),
      observe("run-2", 400, "Bash", { command: "npm test 2>&1 | tail -1" }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
    },
  );
  // The piped success is not definite, so no successful-run snapshot is
  // recorded and the repeat can never be classified as redundant.
  assert.equal(matched[1]?.match, "contributing_run");
  assert.equal(matched[2]?.match, "contributing_run");
});

test("classifies composite commands whose segments are all recognized", () => {
  const cdTest = classifyCommand("cd backend && npm test");
  assert.equal(cdTest.opaque, false);
  assert.equal(cdTest.family, "test");
  assert.equal(cdTest.scope, "full");
  assert.equal(cdTest.normalized, "cd backend && npm test");

  const piped = classifyCommand("npm test 2>&1 | tail -20");
  assert.equal(piped.opaque, false);
  assert.equal(piped.family, "test");
  assert.equal(piped.scope, "full");

  const vcs = classifyCommand("git add -A && git commit -m x");
  assert.equal(vcs.opaque, false);
  assert.equal(vcs.family, "vcs");
  assert.equal(vcs.scope, "unknown");
  assert.deepEqual(vcs.targets, []);

  const redirected = classifyCommand("npm test > out.txt");
  assert.equal(redirected.opaque, false);
  assert.equal(redirected.family, "test");

  const inspectOnly = classifyCommand("ls -la | sort | uniq");
  assert.equal(inspectOnly.opaque, false);
  assert.equal(inspectOnly.family, "inspect");
  assert.equal(inspectOnly.scope, "unknown");
});

test("composite normalized commands round-trip through classification", () => {
  const normalized = normalizeCommand("cd backend  &&  npm test 2>&1 | tail -20");
  assert.ok(normalized !== null);
  assert.equal(classifyCommand(normalized).family, "test");
  assert.equal(normalizeCommand(normalized), normalized);
});

test("keeps composite commands with unknown segments or substitution opaque", () => {
  for (const raw of [
    "ls && unknown-tool",
    "echo $(date)",
    "npm test && touch sentinel",
    "npm test &",
    "npm test >",
    "cd backend && cd frontend",
  ]) {
    const descriptor = classifyCommand(raw);
    assert.equal(descriptor.opaque, true, raw);
    assert.equal(descriptor.family, "other", raw);
  }
});

test("a composite with multiple test or build segments keeps an unknown scope", () => {
  const doubled = classifyCommand("npm test && npm run build");
  assert.equal(doubled.opaque, false);
  assert.equal(doubled.family, "test");
  assert.equal(doubled.scope, "unknown");
  assert.deepEqual(doubled.targets, []);
});

test("classifies known coordination tools while unknown non-MCP tools stay unexplained", () => {
  const matched = matchTimelineActions(
    [
      observe("todo", 0, "TodoWrite"),
      observe("unknown", 200, "SomeUnknownTool"),
      observe("fetch", 400, "WebFetch"),
      observe("agent", 600, "Agent"),
      observe("skill", 800, "Skill"),
    ],
    { diff: diff([]), testMap: explicitMap },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "coordination",
    "unexplained",
    "coordination",
    "coordination",
    "coordination",
  ]);
  assert.equal(matched[0]?.match_confidence, "high");
  assert.match(
    matched[1]?.caveats.join("\n") ?? "",
    /not known well enough/iu,
  );
});

test("classifies an unrecognized mcp__ tool as coordination by server prefix", () => {
  const matched = matchTimelineActions(
    [observe("mcp", 0, "mcp__foo__bar")],
    { diff: diff([]), testMap: explicitMap },
  );
  assert.equal(matched[0]?.match, "coordination");
  assert.equal(matched[0]?.match_confidence, "low");
  assert.match(
    matched[0]?.caveats.join("\n") ?? "",
    /MCP tool classified by server prefix\.$/u,
  );
});

test("classifies an mcp__ tool whose server id starts with an underscore as coordination", () => {
  const matched = matchTimelineActions(
    [observe("mcp-underscore-server", 0, "mcp___hypothesi_tauri-mcp-server__driver_session")],
    { diff: diff([]), testMap: explicitMap },
  );
  assert.equal(matched[0]?.match, "coordination");
  assert.equal(matched[0]?.match_confidence, "low");
  assert.match(
    matched[0]?.caveats.join("\n") ?? "",
    /MCP tool classified by server prefix\.$/u,
  );
});

test("keeps a non-MCP unknown tool unexplained even with an mcp-like name shape", () => {
  const matched = matchTimelineActions(
    [
      observe("mcp-single-underscore", 0, "mcp_foo_bar"),
      observe("mcp-no-suffix", 200, "mcp__"),
    ],
    { diff: diff([]), testMap: explicitMap },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "unexplained",
    "unexplained",
  ]);
});

test("classifies known commands and retains identity only for safe nonopaque commands", () => {
  const matched = matchTimelineActions(
    [
      observe("git", 0, "Bash", { command: "git status" }),
      observe("ls", 200, "Bash", { command: "ls -la" }),
      observe("mix", 400, "Bash", { command: "git status && unknown-tool", cwd: "/repo" }),
      observe("other", 600, "NativeCommand", { command: "python script.py", cwd: "/repo" }),
    ],
    { diff: diff([]), testMap: explicitMap, repoRoot: "/repo" },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "coordination",
    "coordination",
    "unexplained",
    "unexplained",
  ]);
  assert.equal(matched[0]?.match_confidence, "high");
  assert.equal(matched[0]?.normalized_command, "git status");
  assert.equal(matched[1]?.normalized_command, "ls -la");
  assert.equal(matched[2]?.normalized_command, undefined);
  assert.equal(matched[2]?.command_identity, undefined);
  assert.equal(matched[3]?.normalized_command, undefined);
  assert.equal(matched[3]?.command_identity?.executor, "native-tool");
  assert.deepEqual(matched.slice(2).map(({ target }) => target), ['git status "&&" unknown-tool', ". :: python script.py"]);
});

test("classifies composite test runs so repeats become redundant", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
      observe("run-1", 200, "Bash", { command: "cd backend && npm test", cwd: "/repo" }),
      observe("run-2", 400, "Bash", { command: "cd backend  &&  npm test", cwd: "/repo" }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
      repoRoot: "/repo",
    },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "contributing_edit",
    "contributing_run",
    "redundant_run",
  ]);
  assert.equal(matched[1]?.normalized_command, "cd backend && npm test");
  assert.equal(matched[2]?.normalized_command, "cd backend && npm test");
});

test("a piped test command with redirects matches the explicit test map", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
      observe("run", 200, "Bash", { command: "npm test 2>&1 | tail -20" }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
    },
  );
  assert.equal(matched[1]?.match, "contributing_run");
  assert.equal(matched[1]?.match_confidence, "high");
  assert.deepEqual(matched[1]?.relevance_paths, ["src/widget.ts"]);
});

test("classifies a composite vcs command as coordination", () => {
  const matched = matchTimelineActions(
    [
      observe("commit", 0, "Bash", {
        command: "git add -A && git commit -m x",
      }),
    ],
    { diff: diff([]), testMap: explicitMap },
  );
  assert.equal(matched[0]?.match, "coordination");
  assert.equal(
    matched[0]?.normalized_command,
    "git add -A && git commit -m x",
  );
});

test("a composite with an output redirect still invalidates duplicate-read state", () => {
  const matched = matchTimelineActions(
    [
      observe("read-1", 0, "Read", { paths: ["src/widget.ts"] }),
      observe("redirected", 200, "Bash", { command: "npm test > out.txt" }),
      observe("read-2", 400, "Read", { paths: ["src/widget.ts"] }),
    ],
    { diff: diff([]), testMap: explicitMap },
  );
  assert.equal(matched[0]?.match, "safe_read");
  assert.equal(matched[2]?.match, "safe_read");
});

test("a composite vcs mutation between runs still blocks redundancy", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
      observe("run-1", 200, "Bash", { command: "npm test", cwd: "/repo" }),
      observe("pull", 400, "Bash", { command: "git fetch && git merge" }),
      observe("run-2", 600, "Bash", { command: "npm test", cwd: "/repo" }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
      repoRoot: "/repo",
    },
  );
  assert.equal(matched[2]?.match, "coordination");
  assert.equal(matched[3]?.match, "unexplained");
});

test("prefers explicit test-map classification over vcs coordination", () => {
  const mappedVcsMap = parseExplicitTestMap({
    mappings: [
      {
        source: ["src/**"],
        tests: ["test/**"],
        commands: ["git testcmd"],
      },
    ],
  });
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
      observe("run", 200, "Bash", { command: "git testcmd" }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: mappedVcsMap,
    },
  );
  assert.equal(matched[1]?.match, "contributing_run");
});

test("delegation tools invalidate duplicate-read state but recording tools do not", () => {
  const matched = matchTimelineActions(
    [
      observe("read-1", 0, "Read", { paths: ["src/widget.ts"] }),
      observe("todo", 200, "TodoWrite"),
      observe("read-2", 400, "Read", { paths: ["src/widget.ts"] }),
      observe("agent", 600, "Agent"),
      observe("read-3", 800, "Read", { paths: ["src/widget.ts"] }),
    ],
    { diff: diff([]), testMap: explicitMap },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "safe_read",
    "coordination",
    "duplicate_read",
    "coordination",
    "safe_read",
  ]);
});

test("an inspect command does not invalidate duplicate-read state but a vcs command does", () => {
  const matched = matchTimelineActions(
    [
      observe("read-1", 0, "Read", { paths: ["src/widget.ts"] }),
      observe("ls", 200, "Bash", { command: "ls -la" }),
      observe("read-2", 400, "Read", { paths: ["src/widget.ts"] }),
      observe("git", 600, "Bash", { command: "git checkout main" }),
      observe("read-3", 800, "Read", { paths: ["src/widget.ts"] }),
    ],
    { diff: diff([]), testMap: explicitMap },
  );
  assert.deepEqual(matched.map((entry) => entry.match), [
    "safe_read",
    "coordination",
    "duplicate_read",
    "coordination",
    "safe_read",
  ]);
});

test("a vcs command between runs still blocks redundancy conservatively", () => {
  const matched = matchTimelineActions(
    [
      observe("edit", 0, "Edit", {
        paths: ["src/widget.ts"],
        fragments: ["export const widget = true;"],
      }),
      observe("run-1", 200, "Bash", { command: "npm test", cwd: "/repo" }),
      observe("checkout", 400, "Bash", { command: "git checkout main" }),
      observe("run-2", 600, "Bash", { command: "npm test", cwd: "/repo" }),
    ],
    {
      diff: diff([
        file("src/widget.ts", { addedLines: ["export const widget = true;"] }),
      ]),
      testMap: explicitMap,
      repoRoot: "/repo",
    },
  );
  assert.equal(matched[1]?.match, "contributing_run");
  assert.equal(matched[2]?.match, "coordination");
  assert.equal(matched[3]?.match, "unexplained");
  assert.match(
    matched[3]?.caveats.join("\n") ?? "",
    /unknown mutation scope/iu,
  );
});

test("inherits a coordination classification for its causal inference", () => {
  const todo = observe("todo", 0, "TodoWrite");
  const inference: ActionObservation = {
    action: action("todo-inference", 110, {
      kind: "inference",
      paths: [],
      tool_use_id: "todo",
      tool_name: "TodoWrite",
    }),
    ...(todo.toolUse === undefined ? {} : { toolUse: todo.toolUse }),
    ...(todo.toolResult === undefined ? {} : { toolResult: todo.toolResult }),
  };
  const matched = matchTimelineActions([todo, inference], {
    diff: diff([]),
    testMap: explicitMap,
  });
  assert.deepEqual(matched.map((entry) => entry.match), [
    "coordination",
    "coordination",
  ]);
});
