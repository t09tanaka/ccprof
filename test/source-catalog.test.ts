import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getSourceCatalogEntry,
  hasSourceContentChanged,
  listSourceCatalogEntries,
  type SourceCatalogError,
  type SourceCatalogEntry,
  upsertSourceCatalogEntry,
  validateSourceCatalogEntry,
} from "../src/store/source-catalog.js";
import { openStoreDatabase } from "../src/store/sqlite.js";
import { resolveStorePaths, type StorePaths } from "../src/store/paths.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

const CATALOG_FIELDS = [
  "adapter_id",
  "adapter_version",
  "source_identity",
  "canonical_path",
  "device",
  "inode",
  "mtime_ms",
  "size_bytes",
  "prefix_hash",
  "suffix_hash",
  "content_revision",
  "discovery_cursor",
  "last_parsed_offset",
  "last_normalized_event_index",
  "parser_version",
  "schema_fingerprint",
  "observed_at_ms",
  "completeness",
] as const satisfies readonly (keyof SourceCatalogEntry)[];

const INTEGER_FIELDS = [
  "device",
  "inode",
  "mtime_ms",
  "size_bytes",
  "discovery_cursor",
  "last_parsed_offset",
  "last_normalized_event_index",
  "observed_at_ms",
] as const satisfies readonly (keyof SourceCatalogEntry)[];

const HASH_FIELDS = [
  "prefix_hash",
  "suffix_hash",
  "content_revision",
  "schema_fingerprint",
] as const satisfies readonly (keyof SourceCatalogEntry)[];

function catalogEntry(
  overrides: Partial<SourceCatalogEntry> = {},
): SourceCatalogEntry {
  return {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    source_identity: `source-${"a".repeat(64)}`,
    canonical_path: "/sessions/opaque.jsonl",
    device: 1,
    inode: 2,
    mtime_ms: 10,
    size_bytes: 100,
    prefix_hash: HASH_A,
    suffix_hash: HASH_B,
    content_revision: HASH_C,
    discovery_cursor: 3,
    last_parsed_offset: 100,
    last_normalized_event_index: 4,
    parser_version: "1.0.0",
    schema_fingerprint: HASH_A,
    observed_at_ms: 20,
    completeness: "complete",
    ...overrides,
  };
}

async function temporaryStore(
  callback: (paths: StorePaths) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-source-catalog-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    const paths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
      home_dir: join(root, "home"),
    });
    await callback(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertCatalogError(
  action: () => unknown,
  code: SourceCatalogError["code"],
  forbidden = "",
): void {
  assert.throws(action, (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const failure = error as Error & { readonly code?: unknown };
    assert.equal(failure.name, "SourceCatalogError");
    assert.equal(failure.code, code);
    if (forbidden !== "") assert.doesNotMatch(String(failure), new RegExp(forbidden, "u"));
    return true;
  });
}

test("catalog validation accepts the exact contract and returns detached plain rows", () => {
  const input = catalogEntry({
    canonical_path: "C:\\Users\\agent\\sessions\\opaque.jsonl",
    device: null,
    inode: null,
  });
  const validated = validateSourceCatalogEntry(input);
  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  input.canonical_path = "mutated-after-validation";
  assert.equal(validated.canonical_path, "C:\\Users\\agent\\sessions\\opaque.jsonl");
  assert.equal(Object.getPrototypeOf(validated), Object.prototype);
});

test("catalog validation rejects shape tricks, missing, unknown, and raw-content fields", () => {
  assertCatalogError(() => validateSourceCatalogEntry(null), "invalid_shape");
  assertCatalogError(() => validateSourceCatalogEntry([]), "invalid_shape");
  assertCatalogError(
    () => validateSourceCatalogEntry(Object.create(catalogEntry()) as unknown),
    "invalid_shape",
  );

  const missing = { ...catalogEntry() } as Record<string, unknown>;
  delete missing.parser_version;
  assertCatalogError(() => validateSourceCatalogEntry(missing), "invalid_shape");

  const symbolField = { ...catalogEntry() } as Record<PropertyKey, unknown>;
  symbolField[Symbol("secret")] = "SECRET_CANARY";
  assertCatalogError(() => validateSourceCatalogEntry(symbolField), "unknown_field", "SECRET_CANARY");

  const hiddenField = { ...catalogEntry() };
  Object.defineProperty(hiddenField, "prompt", { value: "SECRET_CANARY" });
  assertCatalogError(() => validateSourceCatalogEntry(hiddenField), "unknown_field", "SECRET_CANARY");

  const hiddenRequired = { ...catalogEntry() };
  Object.defineProperty(hiddenRequired, "canonical_path", {
    value: "/hidden-required-field.jsonl",
    enumerable: false,
  });
  assertCatalogError(() => validateSourceCatalogEntry(hiddenRequired), "invalid_shape");

  let getterCalled = false;
  const accessor = { ...catalogEntry() };
  Object.defineProperty(accessor, "canonical_path", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "/must/not/be/read";
    },
  });
  assertCatalogError(() => validateSourceCatalogEntry(accessor), "invalid_shape");
  assert.equal(getterCalled, false);

  for (const field of ["transcript_body", "prompt", "secret_body"]) {
    assertCatalogError(
      () => validateSourceCatalogEntry({ ...catalogEntry(), [field]: "SECRET_CANARY" }),
      "unknown_field",
      "SECRET_CANARY",
    );
  }
});

test("catalog validation rejects invalid text, identity, hashes, and completeness", () => {
  for (const [field, value, code] of [
    ["adapter_id", "unknown", "invalid_adapter"],
    ["adapter_version", "2.0.0", "invalid_adapter"],
    ["source_identity", "", "invalid_text"],
    ["source_identity", `source-${"A".repeat(64)}`, "invalid_text"],
    ["source_identity", `source-${"a".repeat(63)}`, "invalid_text"],
    ["canonical_path", "", "invalid_text"],
    ["canonical_path", "/sessions/evil\0body", "invalid_text"],
    ["parser_version", "", "invalid_text"],
    ["parser_version", "1\0secret", "invalid_text"],
    ["completeness", "unknown", "invalid_completeness"],
  ] as const) {
    assertCatalogError(
      () => validateSourceCatalogEntry({ ...catalogEntry(), [field]: value }),
      code,
    );
  }

  for (const field of HASH_FIELDS) {
    assertCatalogError(
      () => validateSourceCatalogEntry({ ...catalogEntry(), [field]: HASH_A.toUpperCase() }),
      "invalid_hash",
    );
    assertCatalogError(
      () => validateSourceCatalogEntry({ ...catalogEntry(), [field]: "raw-content" }),
      "invalid_hash",
    );
  }
});

test("catalog validation enforces safe integers, portable file identity, and progress bounds", () => {
  for (const field of INTEGER_FIELDS) {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1]) {
      assertCatalogError(
        () => validateSourceCatalogEntry({ ...catalogEntry(), [field]: value }),
        "invalid_integer",
      );
    }
  }

  assertCatalogError(
    () => validateSourceCatalogEntry({ ...catalogEntry(), device: null }),
    "invalid_file_identity",
  );
  assertCatalogError(
    () => validateSourceCatalogEntry({ ...catalogEntry(), inode: null }),
    "invalid_file_identity",
  );
  assertCatalogError(
    () => validateSourceCatalogEntry({ ...catalogEntry(), last_parsed_offset: 101 }),
    "invalid_boundary",
  );
  assertCatalogError(
    () => validateSourceCatalogEntry({ ...catalogEntry(), last_parsed_offset: 99 }),
    "invalid_boundary",
  );
  assert.deepEqual(
    validateSourceCatalogEntry(catalogEntry({
      completeness: "partial",
      last_parsed_offset: 99,
    })).completeness,
    "partial",
  );
});

test("catalog SQLite constraints reject invalid direct writes", async () => {
  await temporaryStore(async (paths) => {
    const database = openStoreDatabase(paths);
    try {
      const columns = CATALOG_FIELDS.join(", ");
      const parameters = CATALOG_FIELDS.map((field) => `@${field}`).join(", ");
      const insert = database.prepare(
        `INSERT INTO source_catalog(${columns}) VALUES (${parameters})`,
      );
      const invalidRows: Record<string, unknown>[] = [
        { ...catalogEntry(), size_bytes: -1 },
        { ...catalogEntry(), mtime_ms: Number.MAX_SAFE_INTEGER + 1 },
        { ...catalogEntry(), prefix_hash: "raw-content" },
        { ...catalogEntry(), canonical_path: "/bad\0path" },
        { ...catalogEntry(), inode: null },
        { ...catalogEntry(), last_parsed_offset: 101 },
        { ...catalogEntry(), completeness: "unknown" },
      ];
      for (const row of invalidRows) {
        assert.throws(() => insert.run(row), /CHECK constraint failed/u);
      }
      assert.equal(database.prepare("SELECT count(*) FROM source_catalog").pluck().get(), 0);
    } finally {
      database.close();
    }
  });
});

test("catalog upsert/get/list are detached, ordered, and exact-replay idempotent", async () => {
  await temporaryStore(async (paths) => {
    const database = openStoreDatabase(paths);
    try {
      const second = catalogEntry({
        source_identity: `source-${"b".repeat(64)}`,
        canonical_path: "/sessions/b.jsonl",
      });
      const first = catalogEntry({
        source_identity: `source-${"a".repeat(64)}`,
        canonical_path: "/sessions/a.jsonl",
      });
      assert.equal(upsertSourceCatalogEntry(database, second), "inserted");
      assert.equal(upsertSourceCatalogEntry(database, first), "inserted");
      assert.equal(upsertSourceCatalogEntry(database, first), "unchanged");

      first.canonical_path = "/mutated-input";
      const loaded = getSourceCatalogEntry(database, `source-${"a".repeat(64)}`);
      assert.equal(loaded?.canonical_path, "/sessions/a.jsonl");
      assert.notEqual(loaded, first);
      loaded!.canonical_path = "/mutated-read";
      assert.equal(
        getSourceCatalogEntry(database, `source-${"a".repeat(64)}`)?.canonical_path,
        "/sessions/a.jsonl",
      );

      const listed = listSourceCatalogEntries(database);
      assert.deepEqual(listed.map((item: { source_identity: string }) => item.source_identity), [
        `source-${"a".repeat(64)}`,
        `source-${"b".repeat(64)}`,
      ]);
      listed[0]!.canonical_path = "/mutated-list";
      assert.equal(listSourceCatalogEntries(database)[0]?.canonical_path, "/sessions/a.jsonl");
      assert.equal(getSourceCatalogEntry(database, `source-${"c".repeat(64)}`), undefined);
      assertCatalogError(() => getSourceCatalogEntry(database, "bad"), "invalid_text");
    } finally {
      database.close();
    }
  });
});

test("catalog upsert orders observations and enforces same-revision progress", async () => {
  await temporaryStore(async (paths) => {
    const database = openStoreDatabase(paths);
    try {
      const partial = catalogEntry({
        completeness: "partial",
        discovery_cursor: 5,
        last_parsed_offset: 50,
        last_normalized_event_index: 2,
        observed_at_ms: 100,
      });
      assert.equal(upsertSourceCatalogEntry(database, partial), "inserted");
      assert.equal(upsertSourceCatalogEntry(database, partial), "unchanged");
      assert.equal(upsertSourceCatalogEntry(database, {
        ...partial,
        canonical_path: "/stale.jsonl",
        observed_at_ms: 99,
      }), "stale");
      assert.equal(getSourceCatalogEntry(database, partial.source_identity)?.canonical_path,
        partial.canonical_path);

      assertCatalogError(() => upsertSourceCatalogEntry(database, {
        ...partial,
        canonical_path: "/equal-time-conflict.jsonl",
      }), "observation_conflict");

      const progressed = {
        ...partial,
        discovery_cursor: 6,
        last_parsed_offset: 75,
        last_normalized_event_index: 3,
        observed_at_ms: 101,
      };
      assert.equal(upsertSourceCatalogEntry(database, progressed), "updated");
      assertCatalogError(() => upsertSourceCatalogEntry(database, {
        ...progressed,
        last_parsed_offset: 74,
        observed_at_ms: 102,
      }), "progress_regression");

      const complete = {
        ...progressed,
        completeness: "complete" as const,
        last_parsed_offset: 100,
        observed_at_ms: 103,
      };
      assert.equal(upsertSourceCatalogEntry(database, complete), "updated");
      assertCatalogError(() => upsertSourceCatalogEntry(database, {
        ...complete,
        completeness: "partial",
        observed_at_ms: 104,
      }), "progress_regression");

      const rotated = {
        ...complete,
        prefix_hash: HASH_B,
        suffix_hash: HASH_C,
        content_revision: HASH_A,
        discovery_cursor: 0,
        last_parsed_offset: 10,
        last_normalized_event_index: 0,
        size_bytes: 20,
        completeness: "partial" as const,
        observed_at_ms: 105,
      };
      assert.equal(upsertSourceCatalogEntry(database, rotated), "updated");
      assert.deepEqual(getSourceCatalogEntry(database, rotated.source_identity), rotated);
    } finally {
      database.close();
    }
  });
});

test("changed-content decisions are deterministic and fail closed for partial data", () => {
  const current = catalogEntry();
  assert.equal(hasSourceContentChanged(undefined, current), true);
  assert.equal(hasSourceContentChanged(current, { ...current }), false);
  assert.equal(hasSourceContentChanged(current, {
    ...current,
    discovery_cursor: 99,
    observed_at_ms: 99,
  }), false);

  for (const changed of [
    { canonical_path: "/sessions/replaced.jsonl" },
    { device: 3, inode: 4 },
    { mtime_ms: 11 },
    { size_bytes: 101, last_parsed_offset: 101 },
    { prefix_hash: HASH_B },
    { suffix_hash: HASH_C },
    { content_revision: HASH_A },
    { parser_version: "1.0.1" },
    { schema_fingerprint: HASH_B },
  ]) {
    assert.equal(hasSourceContentChanged(current, { ...current, ...changed }), true);
  }
  assert.equal(hasSourceContentChanged(current, {
    ...current,
    completeness: "partial",
  }), true);
  assert.equal(hasSourceContentChanged({
    ...current,
    completeness: "partial",
  }, current), true);
});
