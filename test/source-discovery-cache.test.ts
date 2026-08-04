import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { canonicalJson } from "../src/store/legacy-json.js";
import {
  SourceEvidenceCacheError,
  type SourceEvidenceCacheErrorCode,
} from "../src/store/source-evidence-cache.js";
import {
  commitSourceDiscoveryRoot,
  getSourceDiscoveryRoot,
  validateSourceDiscoveryRoot,
  type SourceDiscoveryRoot,
} from "../src/store/source-discovery.js";
import { openStoreDatabase } from "../src/store/sqlite.js";
import { resolveStorePaths, type StorePaths } from "../src/store/paths.js";

const SECRET_CANARY = "SECRET_DISCOVERY_CACHE_CANARY";
const ROOT_COLUMNS = [
  "root_identity", "adapter_id", "canonical_root", "cursor", "capability",
  "tree_json", "tree_digest", "observed_at_ms", "completeness",
  "sensitivity", "retention_class",
] as const satisfies readonly (keyof SourceDiscoveryRoot)[];

type DatabaseConnection = ReturnType<typeof openStoreDatabase>;
type AdapterId = SourceDiscoveryRoot["adapter_id"];

interface StoreFixture {
  database: DatabaseConnection;
  paths: StorePaths;
}

interface DirectoryTokenV1 {
  device: string;
  inode: string;
  mtime_ns: string;
  ctime_ns: string;
}

interface DirectoryEntryV1 {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

interface DirectoryStateV1 {
  relative_path: string;
  token: DirectoryTokenV1;
  entries: DirectoryEntryV1[];
}

interface StableCapabilityV1 {
  kind: "stable_directory_token";
  evidence: {
    kind: "darwin-apfs-v1";
    platform: "darwin";
    node_major: 22 | 24;
    filesystem_type: "26";
    canonical_root: string;
    root_device: string;
    root_inode: string;
  };
}

interface FullScanCapabilityV1 {
  kind: "full_scan_required";
  reason:
    | "platform" | "node" | "filesystem" | "root_identity"
    | "directory_identity" | "timestamp" | "uncertain";
}

interface DiscoveryTreeV1 {
  schema_version: 1;
  capability: StableCapabilityV1 | FullScanCapabilityV1;
  directories: DirectoryStateV1[];
}

type UnsignedDiscoveryRoot = Omit<SourceDiscoveryRoot, "tree_digest">;

async function storeFixture(t: TestContext): Promise<StoreFixture> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-source-discovery-"));
  const repositoryRoot = join(root, "repo");
  await mkdir(repositoryRoot);
  const paths = await resolveStorePaths(repositoryRoot, {
    env: { CCPROF_DATA_DIR: join(root, "data") },
    home_dir: join(root, "home"),
  });
  const database = openStoreDatabase(paths);
  t.after(async () => {
    if (database.open) database.close();
    await rm(root, { recursive: true, force: true });
  });
  return { database, paths };
}

function domainHex(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`ccprof\0${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex");
}

function rootIdentity(adapterId: AdapterId, canonicalRoot: string): string {
  return `root-${domainHex("source-discovery-root-identity-v1", {
    adapter_id: adapterId,
    canonical_root: canonicalRoot,
  })}`;
}

function treeDigest(root: UnsignedDiscoveryRoot): string {
  return `sha256:${domainHex("source-discovery-tree-v1", root)}`;
}

function unsignedRoot(root: SourceDiscoveryRoot): UnsignedDiscoveryRoot {
  return {
    root_identity: root.root_identity,
    adapter_id: root.adapter_id,
    canonical_root: root.canonical_root,
    cursor: root.cursor,
    capability: root.capability,
    tree_json: root.tree_json,
    observed_at_ms: root.observed_at_ms,
    completeness: root.completeness,
    sensitivity: root.sensitivity,
    retention_class: root.retention_class,
  };
}

function bindRoot(root: UnsignedDiscoveryRoot): SourceDiscoveryRoot {
  return { ...root, tree_digest: treeDigest(root) };
}

function rebindRoot(
  root: SourceDiscoveryRoot,
  overrides: Partial<UnsignedDiscoveryRoot>,
): SourceDiscoveryRoot {
  return bindRoot({ ...unsignedRoot(root), ...overrides });
}

function directory(
  relativePath: string,
  inode: string,
  entries: DirectoryEntryV1[],
): DirectoryStateV1 {
  return {
    relative_path: relativePath,
    token: {
      device: "7",
      inode,
      mtime_ns: "1000000001",
      ctime_ns: "1000000002",
    },
    entries,
  };
}

function stableTree(canonicalRoot: string): DiscoveryTreeV1 {
  return {
    schema_version: 1,
    capability: {
      kind: "stable_directory_token",
      evidence: {
        kind: "darwin-apfs-v1",
        platform: "darwin",
        node_major: 24,
        filesystem_type: "26",
        canonical_root: canonicalRoot,
        root_device: "7",
        root_inode: "11",
      },
    },
    directories: [
      directory("", "11", [
        { name: "Z", kind: "directory" },
        { name: "a", kind: "directory" },
        { name: "root.jsonl", kind: "file" },
      ]),
      directory("Z", "12", [
        { name: "session.jsonl", kind: "file" },
      ]),
      directory("a", "13", [
        { name: "link.jsonl", kind: "symlink" },
        { name: "socket", kind: "other" },
      ]),
    ],
  };
}

function fullScanTree(
  canonicalRoot: string,
  reason: FullScanCapabilityV1["reason"] = "platform",
): DiscoveryTreeV1 {
  const tree = stableTree(canonicalRoot);
  return {
    ...tree,
    capability: { kind: "full_scan_required", reason },
  };
}

function discoveryRoot(options: {
  adapterId?: AdapterId;
  canonicalRoot?: string;
  cursor?: number;
  observedAtMs?: number;
  completeness?: SourceDiscoveryRoot["completeness"];
  tree?: DiscoveryTreeV1;
} = {}): SourceDiscoveryRoot {
  const adapterId = options.adapterId ?? "claude";
  const canonicalRoot = options.canonicalRoot ?? "/sessions/claude";
  const tree = options.tree ?? stableTree(canonicalRoot);
  return bindRoot({
    root_identity: rootIdentity(adapterId, canonicalRoot),
    adapter_id: adapterId,
    canonical_root: canonicalRoot,
    cursor: options.cursor ?? 7,
    capability: tree.capability.kind,
    tree_json: canonicalJson(tree),
    observed_at_ms: options.observedAtMs ?? 100,
    completeness: options.completeness ?? "complete",
    sensitivity: "sensitive",
    retention_class: "source_metadata",
  });
}

function withTree(
  root: SourceDiscoveryRoot,
  tree: DiscoveryTreeV1,
): SourceDiscoveryRoot {
  return rebindRoot(root, {
    capability: tree.capability.kind,
    tree_json: canonicalJson(tree),
  });
}

function assertDiscoveryError(
  action: () => unknown,
  code: SourceEvidenceCacheErrorCode | readonly SourceEvidenceCacheErrorCode[],
  forbidden = SECRET_CANARY,
): void {
  const expected = typeof code === "string" ? [code] : code;
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SourceEvidenceCacheError);
    assert.ok(expected.includes(error.code), `${error.code} not in ${expected}`);
    assert.doesNotMatch(String(error), new RegExp(forbidden, "u"));
    return true;
  });
}

function cloneTree(root: SourceDiscoveryRoot): DiscoveryTreeV1 {
  return JSON.parse(root.tree_json) as DiscoveryTreeV1;
}

test("discovery roots validate exact stable and full-scan rows as detached values", () => {
  const node22Tree = stableTree("/sessions/claude-node22");
  assert.equal(node22Tree.capability.kind, "stable_directory_token");
  node22Tree.capability.evidence.node_major = 22;
  const rows = [
    discoveryRoot(),
    discoveryRoot({
      canonicalRoot: "/sessions/claude-node22",
      tree: node22Tree,
    }),
    discoveryRoot({
      adapterId: "codex",
      canonicalRoot: "/sessions/codex",
      tree: fullScanTree("/sessions/codex", "filesystem"),
    }),
    discoveryRoot({ completeness: "partial" }),
  ];
  for (const reason of [
    "platform", "node", "filesystem", "root_identity",
    "directory_identity", "timestamp", "uncertain",
  ] as const) {
    rows.push(discoveryRoot({
      canonicalRoot: `/sessions/full-scan-${reason}`,
      tree: fullScanTree(`/sessions/full-scan-${reason}`, reason),
    }));
  }

  for (const input of rows) {
    const snapshot = structuredClone(input);
    const validated = validateSourceDiscoveryRoot(input);
    assert.deepEqual(validated, snapshot);
    assert.notEqual(validated, input);
    assert.equal(Object.getPrototypeOf(validated), Object.prototype);
    input.canonical_root = "/mutated-after-validation";
    assert.deepEqual(validated, snapshot);
  }

  const stable = JSON.parse(rows[0]!.tree_json) as DiscoveryTreeV1;
  assert.deepEqual(stable.capability, {
    kind: "stable_directory_token",
    evidence: {
      kind: "darwin-apfs-v1",
      platform: "darwin",
      node_major: 24,
      filesystem_type: "26",
      canonical_root: "/sessions/claude",
      root_device: "7",
      root_inode: "11",
    },
  });
});

test("discovery root validation rejects hostile descriptors and closed-shape violations without traps", () => {
  const row = discoveryRoot();
  for (const input of [null, [], Object.create(row)]) {
    assertDiscoveryError(
      () => validateSourceDiscoveryRoot(input),
      "invalid_shape",
    );
  }

  const missing = { ...row } as Record<string, unknown>;
  delete missing.tree_digest;
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(missing),
    "invalid_shape",
  );
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot({ ...row, raw_body: SECRET_CANARY }),
    "unknown_field",
  );

  const hidden = { ...row } as Record<PropertyKey, unknown>;
  Object.defineProperty(hidden, "hidden_source", {
    value: SECRET_CANARY,
  });
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(hidden),
    "unknown_field",
  );
  const symbol = { ...row } as Record<PropertyKey, unknown>;
  symbol[Symbol(SECRET_CANARY)] = SECRET_CANARY;
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(symbol),
    "unknown_field",
  );

  let getterCalls = 0;
  const accessor = { ...row };
  Object.defineProperty(accessor, "tree_json", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(SECRET_CANARY);
    },
  });
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(accessor),
    "invalid_shape",
  );

  const hostile = (): never => {
    getterCalls += 1;
    throw new Error(SECRET_CANARY);
  };
  for (const traps of [
    { get: hostile },
    { getPrototypeOf: hostile },
    { ownKeys: hostile },
    { getOwnPropertyDescriptor: hostile },
  ] satisfies ProxyHandler<SourceDiscoveryRoot>[]) {
    assertDiscoveryError(
      () => validateSourceDiscoveryRoot(new Proxy(row, traps)),
      "invalid_shape",
    );
  }
  const revoked = Proxy.revocable(structuredClone(row), {});
  revoked.revoke();
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(revoked.proxy),
    "invalid_shape",
  );
  assert.equal(getterCalls, 0);
});

test("discovery trees reject unknown fields, noncanonical order, and invalid stable tokens", () => {
  const row = discoveryRoot();
  const invalid: unknown[] = [];

  const unknownTree = cloneTree(row) as DiscoveryTreeV1 & {
    raw_body?: string;
  };
  unknownTree.raw_body = SECRET_CANARY;
  invalid.push(unknownTree);

  const unknownDirectory = cloneTree(row) as DiscoveryTreeV1;
  (unknownDirectory.directories[0] as DirectoryStateV1 & {
    canonical_path?: string;
  }).canonical_path = SECRET_CANARY;
  invalid.push(unknownDirectory);

  const unknownEntry = cloneTree(row);
  (unknownEntry.directories[0]!.entries[0] as DirectoryEntryV1 & {
    body?: string;
  }).body = SECRET_CANARY;
  invalid.push(unknownEntry);

  const reversedDirectories = cloneTree(row);
  reversedDirectories.directories.reverse();
  invalid.push(reversedDirectories);

  const reversedEntries = cloneTree(row);
  reversedEntries.directories[0]!.entries.reverse();
  invalid.push(reversedEntries);

  const duplicateDirectory = cloneTree(row);
  duplicateDirectory.directories.push(
    structuredClone(duplicateDirectory.directories[1]!),
  );
  invalid.push(duplicateDirectory);

  const absoluteChild = cloneTree(row);
  absoluteChild.directories[1]!.relative_path = "/escape";
  invalid.push(absoluteChild);

  const parentEscape = cloneTree(row);
  parentEscape.directories[1]!.relative_path = "../escape";
  invalid.push(parentEscape);

  const nestedEntryName = cloneTree(row);
  nestedEntryName.directories[0]!.entries[0]!.name = "nested/file";
  invalid.push(nestedEntryName);

  const unknownKind = cloneTree(row);
  unknownKind.directories[0]!.entries[0]!.kind = "socket" as "file";
  invalid.push(unknownKind);

  for (const [field, value] of [
    ["device", "07"],
    ["inode", "0"],
    ["mtime_ns", "-1"],
    ["ctime_ns", "1.5"],
  ] as const) {
    const invalidToken = cloneTree(row);
    invalidToken.directories[0]!.token[field] = value;
    invalid.push(invalidToken);
  }

  const tokenExtra = cloneTree(row);
  (tokenExtra.directories[0]!.token as DirectoryTokenV1 & {
    raw_stat?: string;
  }).raw_stat = SECRET_CANARY;
  invalid.push(tokenExtra);

  for (const tree of invalid) {
    const candidate = withTree(row, tree as DiscoveryTreeV1);
    assertDiscoveryError(
      () => validateSourceDiscoveryRoot(candidate),
      ["invalid_shape", "unknown_field", "invalid_state"],
    );
  }
});

test("capability evidence and row digests bind the exact root, adapter, cursor, and labels", () => {
  const row = discoveryRoot();

  const invalidCapabilities: Array<[
    DiscoveryTreeV1,
    SourceEvidenceCacheErrorCode | readonly SourceEvidenceCacheErrorCode[],
  ]> = [];
  for (const [field, value] of [
    ["kind", "other-apfs"],
    ["platform", "win32"],
    ["node_major", 20],
    ["filesystem_type", "27"],
    ["root_device", "07"],
    ["root_inode", "0"],
  ] as const) {
    const tree = cloneTree(row);
    assert.equal(tree.capability.kind, "stable_directory_token");
    (tree.capability.evidence as unknown as Record<string, unknown>)[field] = value;
    invalidCapabilities.push([tree, "invalid_state"]);
  }

  const wrongEvidenceRoot = cloneTree(row);
  assert.equal(wrongEvidenceRoot.capability.kind, "stable_directory_token");
  wrongEvidenceRoot.capability.evidence.canonical_root = `/${SECRET_CANARY}`;
  invalidCapabilities.push([wrongEvidenceRoot, "foreign_binding"]);

  const wrongRootDevice = cloneTree(row);
  assert.equal(wrongRootDevice.capability.kind, "stable_directory_token");
  wrongRootDevice.capability.evidence.root_device = "8";
  invalidCapabilities.push([wrongRootDevice, "foreign_binding"]);

  const extraEvidence = cloneTree(row);
  assert.equal(extraEvidence.capability.kind, "stable_directory_token");
  (extraEvidence.capability.evidence as unknown as Record<string, unknown>)
    .raw_mount = SECRET_CANARY;
  invalidCapabilities.push([extraEvidence, "unknown_field"]);

  const badReason = fullScanTree(row.canonical_root);
  assert.equal(badReason.capability.kind, "full_scan_required");
  badReason.capability.reason = "guess" as "uncertain";
  invalidCapabilities.push([badReason, "invalid_state"]);

  for (const [tree, code] of invalidCapabilities) {
    assertDiscoveryError(
      () => validateSourceDiscoveryRoot(withTree(row, tree)),
      code,
    );
  }

  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(rebindRoot(row, {
      capability: "full_scan_required",
    })),
    "foreign_binding",
  );
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(rebindRoot(row, {
      canonical_root: `/${SECRET_CANARY}`,
    })),
    "foreign_binding",
  );
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(rebindRoot(row, {
      adapter_id: "codex",
    })),
    "foreign_binding",
  );
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(rebindRoot(row, {
      root_identity: `root-${"f".repeat(64)}`,
    })),
    "foreign_binding",
  );

  for (const changed of [
    { ...row, cursor: row.cursor + 1 },
    { ...row, tree_json: canonicalJson(fullScanTree(row.canonical_root)) },
    { ...row, completeness: "partial" as const },
  ]) {
    assertDiscoveryError(
      () => validateSourceDiscoveryRoot(changed),
      "digest_mismatch",
    );
  }

  for (const changed of [
    { ...row, sensitivity: "public" },
    { ...row, retention_class: "raw_evidence" },
  ]) {
    assertDiscoveryError(
      () => validateSourceDiscoveryRoot(changed),
      "foreign_binding",
    );
  }

  for (const [field, value, code] of [
    ["root_identity", `root-${"A".repeat(64)}`, "invalid_text"],
    ["canonical_root", "relative/root", "invalid_text"],
    ["canonical_root", `/bad\0${SECRET_CANARY}`, "invalid_text"],
    ["capability", "unknown", "invalid_state"],
    ["tree_digest", `sha256:${"A".repeat(64)}`, "invalid_hash"],
    ["cursor", -1, "invalid_integer"],
    ["observed_at_ms", Number.MAX_SAFE_INTEGER + 1, "invalid_integer"],
    ["completeness", "unknown", "invalid_state"],
  ] as const) {
    assertDiscoveryError(
      () => validateSourceDiscoveryRoot({ ...row, [field]: value }),
      code,
    );
  }

  const compact = rebindRoot(row, {
    tree_json: JSON.stringify(cloneTree(row)),
  });
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(compact),
    "invalid_state",
  );
  const corrupt = rebindRoot(row, { tree_json: `{${SECRET_CANARY}` });
  assertDiscoveryError(
    () => validateSourceDiscoveryRoot(corrupt),
    "invalid_state",
  );
});

test("discovery reads return detached rows and turn corrupt persisted state into a miss", async (t) => {
  const store = await storeFixture(t);
  const row = discoveryRoot();
  assert.equal(
    getSourceDiscoveryRoot(store.database, row.root_identity),
    undefined,
  );
  assert.equal(commitSourceDiscoveryRoot(store.database, row), "inserted");

  const loaded = getSourceDiscoveryRoot(store.database, row.root_identity);
  assert.deepEqual(loaded, row);
  assert.notEqual(loaded, row);
  loaded!.canonical_root = "/mutated-detached-read";
  assert.equal(
    getSourceDiscoveryRoot(store.database, row.root_identity)?.canonical_root,
    row.canonical_root,
  );

  store.database.prepare(`UPDATE source_discovery_roots SET tree_json = ?
    WHERE root_identity = ?`).run(`{${SECRET_CANARY}`, row.root_identity);
  assert.equal(
    getSourceDiscoveryRoot(store.database, row.root_identity),
    undefined,
  );
  store.database.prepare(`UPDATE source_discovery_roots SET tree_json = ?
    WHERE root_identity = ?`).run(row.tree_json, row.root_identity);

  store.database.prepare(`UPDATE source_discovery_roots SET tree_digest = ?
    WHERE root_identity = ?`).run(`sha256:${"b".repeat(64)}`, row.root_identity);
  assert.equal(
    getSourceDiscoveryRoot(store.database, row.root_identity),
    undefined,
  );
  store.database.prepare(`UPDATE source_discovery_roots SET tree_digest = ?
    WHERE root_identity = ?`).run(row.tree_digest, row.root_identity);

  store.database.prepare(`UPDATE source_discovery_roots SET completeness = 'partial'
    WHERE root_identity = ?`).run(row.root_identity);
  assert.equal(
    getSourceDiscoveryRoot(store.database, row.root_identity),
    undefined,
    "completeness cannot be upgraded or downgraded outside its bound digest",
  );
  store.database.prepare(`UPDATE source_discovery_roots SET completeness = 'complete'
    WHERE root_identity = ?`).run(row.root_identity);
  assert.deepEqual(
    getSourceDiscoveryRoot(store.database, row.root_identity),
    row,
  );

  const partial = discoveryRoot({
    canonicalRoot: "/sessions/partial",
    cursor: 3,
    completeness: "partial",
  });
  assert.equal(commitSourceDiscoveryRoot(store.database, partial), "inserted");
  assert.equal(
    getSourceDiscoveryRoot(store.database, partial.root_identity)?.completeness,
    "partial",
    "partial rows remain inspectable but are not reusable as complete state",
  );

  assertDiscoveryError(
    () => getSourceDiscoveryRoot(store.database, SECRET_CANARY),
    "invalid_text",
  );
});

test("directory cursor commits cover replay, conflict, generation advance, stale, and partial precedence", async (t) => {
  const store = await storeFixture(t);
  const initial = discoveryRoot();
  assert.equal(commitSourceDiscoveryRoot(store.database, initial), "inserted");
  assert.equal(
    commitSourceDiscoveryRoot(store.database, structuredClone(initial)),
    "unchanged",
  );

  const changedTree = cloneTree(initial);
  changedTree.directories[0]!.entries.push({
    name: "z-new.jsonl",
    kind: "file",
  });
  const sameCursorConflict = withTree(initial, changedTree);
  assert.equal(
    commitSourceDiscoveryRoot(store.database, sameCursorConflict),
    "conflict",
  );
  assert.equal(
    commitSourceDiscoveryRoot(store.database, rebindRoot(initial, {
      observed_at_ms: initial.observed_at_ms + 1,
    })),
    "conflict",
  );
  assert.deepEqual(
    getSourceDiscoveryRoot(store.database, initial.root_identity),
    initial,
  );

  const next = rebindRoot(initial, {
    cursor: initial.cursor + 1,
    observed_at_ms: initial.observed_at_ms + 1,
  });
  assert.equal(commitSourceDiscoveryRoot(store.database, next), "updated");
  assert.deepEqual(
    getSourceDiscoveryRoot(store.database, initial.root_identity),
    next,
    "an unchanged complete generation N is persisted as N + 1",
  );

  assert.equal(commitSourceDiscoveryRoot(store.database, initial), "stale");
  const sameCursorPartial = rebindRoot(next, { completeness: "partial" });
  assert.equal(
    commitSourceDiscoveryRoot(store.database, sameCursorPartial),
    "conflict",
    "partial work preserves N and cannot replace complete N",
  );
  const stalePartial = rebindRoot(initial, { completeness: "partial" });
  assert.equal(
    commitSourceDiscoveryRoot(store.database, stalePartial),
    "stale",
    "partial work cannot replace a newer complete generation",
  );
  const advancingPartial = rebindRoot(next, {
    cursor: next.cursor + 1,
    observed_at_ms: next.observed_at_ms + 1,
    completeness: "partial",
  });
  assertDiscoveryError(
    () => commitSourceDiscoveryRoot(store.database, advancingPartial),
    "progress_regression",
  );
  assert.deepEqual(
    getSourceDiscoveryRoot(store.database, initial.root_identity),
    next,
  );

  const partial = discoveryRoot({
    canonicalRoot: "/sessions/new-partial",
    cursor: 1,
    completeness: "partial",
  });
  assert.equal(commitSourceDiscoveryRoot(store.database, partial), "inserted");
  assert.equal(commitSourceDiscoveryRoot(store.database, partial), "unchanged");
  const completed = rebindRoot(partial, {
    cursor: partial.cursor + 1,
    observed_at_ms: partial.observed_at_ms + 1,
    completeness: "complete",
  });
  assert.equal(commitSourceDiscoveryRoot(store.database, completed), "updated");
});

test("a discovery-root write failure rolls back and keeps the prior generation", async (t) => {
  const store = await storeFixture(t);
  const initial = discoveryRoot();
  assert.equal(commitSourceDiscoveryRoot(store.database, initial), "inserted");
  const next = rebindRoot(initial, {
    cursor: initial.cursor + 1,
    observed_at_ms: initial.observed_at_ms + 1,
  });

  store.database.exec(`CREATE TEMP TRIGGER reject_discovery_root_update
    BEFORE UPDATE ON source_discovery_roots
    BEGIN
      SELECT RAISE(ABORT, 'forced discovery root rollback');
    END`);
  assert.throws(
    () => commitSourceDiscoveryRoot(store.database, next),
    /forced discovery root rollback/u,
  );
  assert.deepEqual(
    getSourceDiscoveryRoot(store.database, initial.root_identity),
    initial,
  );
});

test("a WAL reader sees the old or new discovery generation, never an intermediate row", async (t) => {
  const store = await storeFixture(t);
  const writer = store.database;
  const reader = openStoreDatabase(store.paths);
  const initial = discoveryRoot();
  try {
    assert.equal(commitSourceDiscoveryRoot(writer, initial), "inserted");
    const next = rebindRoot(initial, {
      cursor: initial.cursor + 1,
      observed_at_ms: initial.observed_at_ms + 1,
    });
    const observed: Array<ReturnType<typeof getSourceDiscoveryRoot>> = [];
    writer.function("observe_discovery_root", () => {
      observed.push(getSourceDiscoveryRoot(reader, initial.root_identity));
      return 1;
    });
    writer.exec(`CREATE TEMP TRIGGER observe_discovery_root_update
      AFTER UPDATE ON source_discovery_roots
      WHEN NEW.root_identity = '${initial.root_identity}'
      BEGIN
        SELECT observe_discovery_root();
      END`);

    assert.equal(commitSourceDiscoveryRoot(writer, next), "updated");
    assert.deepEqual(observed, [initial]);
    assert.deepEqual(
      getSourceDiscoveryRoot(reader, initial.root_identity),
      next,
    );
  } finally {
    reader.close();
  }
});

test("the discovery-root SQL projection stays exact and no helper writes extra columns", async (t) => {
  const store = await storeFixture(t);
  const row = discoveryRoot();
  assert.equal(commitSourceDiscoveryRoot(store.database, row), "inserted");
  const persisted = store.database.prepare(
    `SELECT ${ROOT_COLUMNS.join(", ")} FROM source_discovery_roots
      WHERE root_identity = ?`,
  ).get(row.root_identity) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted), [...ROOT_COLUMNS]);
  assert.deepEqual(persisted, row);
});
