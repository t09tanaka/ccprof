import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  sourceDescriptorsForSessions,
  type SourceDescriptor,
} from "../src/core/source-descriptor.js";
import type { NormalizedEvent } from "../src/core/model.js";
import {
  CLAUDE_PARSER_VERSION,
  type ClaudeParserStateV1,
  projectClaudeParserState,
  readClaudeParserState,
} from "../src/sources/claude/parser.js";
import {
  CODEX_PARSER_VERSION,
  type CodexParserStateV1,
  projectCodexParserState,
  readCodexParserState,
} from "../src/sources/codex/parser.js";
import {
  MAX_INCREMENTAL_PARSER_STATE_BYTES,
  PARSER_STATE_SCHEMA_FINGERPRINT,
} from "../src/sources/jsonl-budget.js";
import { canonicalJson } from "../src/store/legacy-json.js";
import {
  getSourceCatalogEntry,
  type SourceCatalogEntry,
  upsertSourceCatalogEntry,
} from "../src/store/source-catalog.js";
import {
  commitEligibleSourceEvidence,
  getSourceEvidencePair,
  normalizeSourceEvidenceEnvelope,
  SourceEvidenceCacheError,
  validateSourceEvidenceCacheEntry,
  type EligibleSourceEvidenceEnvelopeV1,
  type SourceEvidenceCacheEntry,
  type SourceEvidenceCacheErrorCode,
  type SourceEvidenceEnvelopeV1,
} from "../src/store/source-evidence-cache.js";
import { openStoreDatabase } from "../src/store/sqlite.js";
import { resolveStorePaths, type StorePaths } from "../src/store/paths.js";

const SECRET_CANARY = "SECRET_CANARY_DO_NOT_ECHO";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const ROOT_A = "1".repeat(64);
const ROOT_B = "2".repeat(64);
const SOURCE_A = `source-${"a".repeat(64)}`;

type DatabaseConnection = ReturnType<typeof openStoreDatabase>;

interface StoreFixture {
  database: DatabaseConnection;
  paths: StorePaths;
  repositoryRoot: string;
  root: string;
}

interface EvidenceFixture {
  catalog: SourceCatalogEntry;
  cache: SourceEvidenceCacheEntry;
  envelope: SourceEvidenceEnvelopeV1;
  descriptors: SourceDescriptor[];
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundDigest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`ccprof\0${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function detachedContractValue<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function cacheBinding(
  cache: Omit<SourceEvidenceCacheEntry, "payload_digest" | "descriptor_digest">,
): Record<string, unknown> {
  return {
    repository_identity: cache.repository_identity,
    eligibility_identity: cache.eligibility_identity,
    source_identity: cache.source_identity,
    canonical_path: cache.canonical_path,
    adapter_id: cache.adapter_id,
    content_revision: cache.content_revision,
    parser_version: cache.parser_version,
    schema_fingerprint: cache.schema_fingerprint,
    sensitivity: cache.sensitivity,
    retention_class: cache.retention_class,
  };
}

function payloadDigest(
  cache: Omit<SourceEvidenceCacheEntry, "payload_digest" | "descriptor_digest">,
): string {
  return boundDigest("source-evidence-payload-v1", {
    ...cacheBinding(cache),
    payload_json: cache.payload_json,
  });
}

function descriptorDigest(
  cache: Omit<SourceEvidenceCacheEntry, "payload_digest" | "descriptor_digest">,
  descriptors: readonly SourceDescriptor[],
): string {
  return boundDigest("source-evidence-descriptors-v1", {
    ...cacheBinding(cache),
    descriptors,
  });
}

function assertEvidenceError(
  action: () => unknown,
  code: SourceEvidenceCacheErrorCode | readonly SourceEvidenceCacheErrorCode[],
  forbidden = SECRET_CANARY,
): void {
  const expected: readonly SourceEvidenceCacheErrorCode[] =
    typeof code === "string" ? [code] : code;
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SourceEvidenceCacheError);
    assert.ok(expected.includes(error.code), `${error.code} not in ${expected}`);
    assert.doesNotMatch(String(error), new RegExp(forbidden, "u"));
    return true;
  });
}

function assertEligibleEnvelope(
  value: SourceEvidenceEnvelopeV1,
): asserts value is EligibleSourceEvidenceEnvelopeV1 {
  assert.equal(value.kind, "eligible-evidence-v1");
}

function replaceFirstEventWithToolInput(
  envelope: EligibleSourceEvidenceEnvelopeV1,
  input: Record<string, unknown>,
): void {
  const session = envelope.full_sessions[0]!;
  const current = session.events[0]!;
  session.events[0] = {
    timestamp_ms: current.timestamp_ms,
    session_id: current.session_id,
    entry_uuid: current.entry_uuid,
    session_ref: current.session_ref,
    source_index: current.source_index,
    agent_id: current.agent_id,
    is_sidechain: current.is_sidechain,
    confidence: current.confidence,
    ...(current.event_identity === undefined
      ? {}
      : { event_identity: current.event_identity }),
    ...(current.parent_uuid === undefined
      ? {}
      : { parent_uuid: current.parent_uuid }),
    ...(current.branch === undefined ? {} : { branch: current.branch }),
    ...(current.branch_epoch === undefined
      ? {}
      : { branch_epoch: current.branch_epoch }),
    kind: "tool_use",
    tool_use_id: "tool-input-boundary",
    tool_name: "Read",
    input,
    paths: [],
    edit_fragments: [],
  } as unknown as NormalizedEvent;
}

async function storeFixture(t: TestContext): Promise<StoreFixture> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-source-evidence-"));
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
  return { database, paths, repositoryRoot, root };
}

function at(second: number): string {
  return new Date(Date.UTC(2026, 7, 4, 0, 0, second)).toISOString();
}

function claudeUser(sessionId: string, index: number): string {
  return JSON.stringify({
    sessionId,
    cwd: "/workspace/repo",
    type: "user",
    uuid: `${sessionId}-${index.toString(10)}`,
    timestamp: at(index),
    message: { role: "user", content: `message-${index.toString(10)}` },
  });
}

function codexRow(
  second: number,
  type: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({ timestamp: at(second), type, payload });
}

async function readClaudeState(
  path: string,
): Promise<ClaudeParserStateV1> {
  const fileHandle = await open(path, "r");
  try {
    const result = await readClaudeParserState({ sourcePath: path, fileHandle });
    assert.equal(result.completeness, "complete");
    return result.state;
  } finally {
    await fileHandle.close();
  }
}

async function readCodexState(path: string): Promise<CodexParserStateV1> {
  const fileHandle = await open(path, "r");
  try {
    const result = await readCodexParserState({ sourcePath: path, fileHandle });
    assert.equal(result.completeness, "complete");
    return result.state;
  } finally {
    await fileHandle.close();
  }
}

function catalogEntry(options: {
  adapter: "claude" | "codex";
  canonicalPath: string;
  content: string;
  parsedOffset: number;
  observedAtMs?: number;
  sourceIdentity?: string;
  discoveryCursor?: number;
}): SourceCatalogEntry {
  const bytes = Buffer.byteLength(options.content);
  return {
    adapter_id: options.adapter,
    adapter_version: "1.0.0",
    source_identity: options.sourceIdentity ?? SOURCE_A,
    canonical_path: options.canonicalPath,
    device: 7,
    inode: 11,
    mtime_ms: options.observedAtMs ?? 20,
    size_bytes: bytes,
    prefix_hash: sha256(Buffer.from(options.content).subarray(0, 32)),
    suffix_hash: sha256(Buffer.from(options.content).subarray(-32)),
    content_revision: sha256(options.content),
    discovery_cursor: options.discoveryCursor ?? 3,
    last_parsed_offset: options.parsedOffset,
    last_normalized_event_index: 2,
    parser_version: options.adapter === "claude"
      ? CLAUDE_PARSER_VERSION
      : CODEX_PARSER_VERSION,
    schema_fingerprint: PARSER_STATE_SCHEMA_FINGERPRINT,
    observed_at_ms: options.observedAtMs ?? 20,
    completeness: "complete",
  };
}

function bindCache(
  row: Omit<SourceEvidenceCacheEntry, "payload_digest" | "descriptor_digest">,
  descriptors: readonly SourceDescriptor[],
): SourceEvidenceCacheEntry {
  return {
    ...row,
    payload_digest: payloadDigest(row),
    descriptor_digest: descriptorDigest(row, descriptors),
  };
}

function cacheEntry(options: {
  catalog: SourceCatalogEntry;
  envelope: SourceEvidenceEnvelopeV1;
  repositoryIdentity: string;
  eligibilityIdentity: string;
  lineCount: number;
  endsWithNewline: boolean;
}): { cache: SourceEvidenceCacheEntry; descriptors: SourceDescriptor[] } {
  const descriptors = options.envelope.kind === "eligible-evidence-v1"
    ? sourceDescriptorsForSessions(options.envelope.full_sessions)
    : [];
  const row = {
    source_identity: options.catalog.source_identity,
    repository_identity: options.repositoryIdentity,
    eligibility_identity: options.eligibilityIdentity,
    adapter_id: options.catalog.adapter_id,
    canonical_path: options.catalog.canonical_path,
    content_revision: options.catalog.content_revision,
    parser_version: options.catalog.parser_version,
    schema_fingerprint: options.catalog.schema_fingerprint,
    last_parsed_offset: options.catalog.last_parsed_offset,
    line_count: options.lineCount,
    ends_with_newline: options.endsWithNewline,
    payload_json: canonicalJson(options.envelope),
    sensitivity: "sensitive" as const,
    retention_class: "raw_evidence" as const,
    updated_at_ms: options.catalog.observed_at_ms,
  };
  return { cache: bindCache(row, descriptors), descriptors };
}

async function claudeEvidenceFixture(
  t: TestContext,
  store: StoreFixture,
  options: {
    eligibilityIdentity?: string;
    sourceIdentity?: string;
    observedAtMs?: number;
    filename?: string;
  } = {},
): Promise<EvidenceFixture> {
  const raw = `${claudeUser("session-a", 1)}\n${claudeUser("session-b", 2)}\n`;
  const path = join(store.repositoryRoot, options.filename ?? "claude.jsonl");
  await writeFile(path, raw);
  const continuation = await readClaudeState(path);
  const projected = projectClaudeParserState(continuation);
  assert.equal(projected.sessions.length, 2);
  assert.deepEqual(projected.warnings, []);
  const envelope = detachedContractValue<SourceEvidenceEnvelopeV1>({
    schema_version: 1,
    kind: "eligible-evidence-v1",
    adapter_id: "claude",
    canonical_path: path,
    full_sessions: projected.sessions,
    parse_warnings: projected.warnings,
    continuation,
  });
  const catalog = catalogEntry({
    adapter: "claude",
    canonicalPath: path,
    content: raw,
    parsedOffset: continuation.parsed_offset,
    ...(options.observedAtMs === undefined
      ? {}
      : { observedAtMs: options.observedAtMs }),
    ...(options.sourceIdentity === undefined
      ? {}
      : { sourceIdentity: options.sourceIdentity }),
  });
  const bound = cacheEntry({
    catalog,
    envelope,
    repositoryIdentity: store.paths.repo_hash,
    eligibilityIdentity: options.eligibilityIdentity ?? ROOT_A,
    lineCount: continuation.line_count,
    endsWithNewline: continuation.ends_with_newline,
  });
  return { catalog, envelope, ...bound };
}

async function codexEnvelopeFixture(
  store: StoreFixture,
): Promise<SourceEvidenceEnvelopeV1> {
  const raw = `${[
    codexRow(1, "session_meta", {
      id: "codex-session",
      cwd: "/workspace/repo",
      git: { branch: "feature/cache" },
    }),
    codexRow(2, "response_item", {
      type: "message",
      role: "user",
      content: "cache me",
    }),
  ].join("\n")}\n`;
  const path = join(store.repositoryRoot, "codex.jsonl");
  await writeFile(path, raw);
  const continuation = await readCodexState(path);
  const session = projectCodexParserState(continuation);
  assert.ok(session !== null);
  return detachedContractValue<SourceEvidenceEnvelopeV1>({
    schema_version: 1,
    kind: "eligible-evidence-v1",
    adapter_id: "codex",
    canonical_path: path,
    full_sessions: [session],
    parse_warnings: [...session.warnings],
    continuation,
  });
}

function negativeEnvelope(
  path: string,
  adapter: "claude" | "codex" = "claude",
): SourceEvidenceEnvelopeV1 {
  return {
    schema_version: 1,
    kind: "no-evidence-v1",
    adapter_id: adapter,
    canonical_path: path,
    reason: "other-repository-only",
  };
}

function reboundFixture(
  fixture: EvidenceFixture,
  options: {
    observedAtMs: number;
    discoveryCursor?: number;
    eligibilityIdentity?: string;
    envelope?: SourceEvidenceEnvelopeV1;
  },
): EvidenceFixture {
  const catalog = {
    ...structuredClone(fixture.catalog),
    observed_at_ms: options.observedAtMs,
    mtime_ms: options.observedAtMs,
    discovery_cursor: options.discoveryCursor ?? fixture.catalog.discovery_cursor,
  };
  const envelope = structuredClone(options.envelope ?? fixture.envelope);
  const bound = cacheEntry({
    catalog,
    envelope,
    repositoryIdentity: fixture.cache.repository_identity,
    eligibilityIdentity: options.eligibilityIdentity ??
      fixture.cache.eligibility_identity,
    lineCount: fixture.cache.line_count,
    endsWithNewline: fixture.cache.ends_with_newline,
  });
  return { catalog, envelope, ...bound };
}

test("evidence envelopes normalize closed positive and no-raw negative variants as detached values", async (t) => {
  const store = await storeFixture(t);
  const positive = await claudeEvidenceFixture(t, store);
  const codex = await codexEnvelopeFixture(store);
  const negative = negativeEnvelope(join(store.repositoryRoot, "empty.jsonl"));

  for (const input of [positive.envelope, codex, negative]) {
    const snapshot = structuredClone(input);
    const normalized = normalizeSourceEvidenceEnvelope(input);
    assert.deepEqual(normalized, snapshot);
    assert.notEqual(normalized, input);
    assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
    if (normalized.kind === "eligible-evidence-v1" &&
      input.kind === "eligible-evidence-v1") {
      assert.notEqual(normalized.full_sessions, input.full_sessions);
      assert.notEqual(normalized.continuation, input.continuation);
      input.full_sessions[0]!.source_path = "/mutated-after-validation";
      assert.deepEqual(normalized, snapshot);
    }
  }
});

test("evidence envelope validation rejects hostile shapes and foreign path, adapter, warning, order, and cardinality", async (t) => {
  const store = await storeFixture(t);
  const fixture = await claudeEvidenceFixture(t, store);
  const envelope = fixture.envelope;
  assertEligibleEnvelope(envelope);

  for (const input of [null, [], Object.create(envelope)]) {
    assertEvidenceError(
      () => normalizeSourceEvidenceEnvelope(input),
      "invalid_shape",
    );
  }

  for (const traps of [
    { getPrototypeOf: () => { throw new Error(SECRET_CANARY); } },
    { ownKeys: () => { throw new Error(SECRET_CANARY); } },
    { getOwnPropertyDescriptor: () => { throw new Error(SECRET_CANARY); } },
  ] satisfies ProxyHandler<SourceEvidenceEnvelopeV1>[]) {
    assertEvidenceError(
      () => normalizeSourceEvidenceEnvelope(new Proxy(envelope, traps)),
      "invalid_shape",
    );
  }

  let getterCalled = false;
  const accessor = structuredClone(envelope);
  Object.defineProperty(accessor, "canonical_path", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error(SECRET_CANARY);
    },
  });
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(accessor),
    "invalid_shape",
  );
  assert.equal(getterCalled, false);

  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope({
      ...structuredClone(envelope),
      transcript_body: SECRET_CANARY,
    }),
    "unknown_field",
  );

  const hiddenUnknown = structuredClone(envelope) as unknown as Record<
    PropertyKey,
    unknown
  >;
  Object.defineProperty(hiddenUnknown, "raw_line", {
    enumerable: false,
    value: SECRET_CANARY,
  });
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(hiddenUnknown),
    "unknown_field",
  );
  const symbolUnknown = structuredClone(envelope) as unknown as Record<
    PropertyKey,
    unknown
  >;
  symbolUnknown[Symbol(SECRET_CANARY)] = SECRET_CANARY;
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(symbolUnknown),
    "unknown_field",
  );
  const hiddenRequired = structuredClone(envelope);
  Object.defineProperty(hiddenRequired, "adapter_id", {
    enumerable: false,
    value: "claude",
  });
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(hiddenRequired),
    "invalid_shape",
  );

  let nestedTrapCalled = false;
  const nestedProxy = structuredClone(envelope);
  nestedProxy.continuation = new Proxy(nestedProxy.continuation, {
    ownKeys() {
      nestedTrapCalled = true;
      throw new Error(SECRET_CANARY);
    },
  });
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(nestedProxy),
    "invalid_state",
  );
  assert.equal(nestedTrapCalled, false);
  const revoked = Proxy.revocable(structuredClone(envelope.continuation), {});
  revoked.revoke();
  const revokedNested = structuredClone(envelope);
  revokedNested.continuation = revoked.proxy;
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(revokedNested),
    "invalid_state",
  );

  const cases: Array<[SourceEvidenceEnvelopeV1, SourceEvidenceCacheErrorCode]> = [];
  const wrongPath = structuredClone(envelope);
  wrongPath.full_sessions[0]!.source_path = `/${SECRET_CANARY}.jsonl`;
  cases.push([wrongPath, "foreign_binding"]);
  const wrongContinuationPath = structuredClone(envelope);
  wrongContinuationPath.continuation.canonical_path = `/${SECRET_CANARY}.jsonl`;
  cases.push([wrongContinuationPath, "foreign_binding"]);
  const wrongAdapter = structuredClone(envelope);
  wrongAdapter.adapter_id = "codex";
  cases.push([wrongAdapter, "foreign_binding"]);
  const wrongParseWarning = structuredClone(envelope);
  wrongParseWarning.parse_warnings.push({
    code: "warning",
    message: SECRET_CANARY,
    source_path: `/${SECRET_CANARY}.jsonl`,
  });
  cases.push([wrongParseWarning, "foreign_binding"]);
  const wrongSessionWarning = structuredClone(envelope);
  wrongSessionWarning.full_sessions[0]!.warnings.push({
    code: "warning",
    message: SECRET_CANARY,
    source_path: `/${SECRET_CANARY}.jsonl`,
  });
  cases.push([wrongSessionWarning, "foreign_binding"]);
  const emptyClaude = structuredClone(envelope);
  emptyClaude.full_sessions = [];
  cases.push([emptyClaude, "foreign_binding"]);
  const reversed = structuredClone(envelope);
  reversed.full_sessions.reverse();
  cases.push([reversed, "invalid_state"]);

  for (const [input, code] of cases) {
    assertEvidenceError(() => normalizeSourceEvidenceEnvelope(input), code);
  }

  const codex = await codexEnvelopeFixture(store);
  assertEligibleEnvelope(codex);
  const duplicateCodex = structuredClone(codex);
  duplicateCodex.full_sessions.push(
    structuredClone(duplicateCodex.full_sessions[0]!),
  );
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(duplicateCodex),
    "foreign_binding",
  );
});

test("negative markers reject every raw-evidence field and unknown state content-free", async (t) => {
  const store = await storeFixture(t);
  const marker = negativeEnvelope(join(store.repositoryRoot, "negative.jsonl"));
  assert.deepEqual(normalizeSourceEvidenceEnvelope(marker), marker);

  for (const [field, value] of [
    ["continuation", { kind: SECRET_CANARY }],
    ["full_sessions", [{ session_id: SECRET_CANARY }]],
    ["parse_warnings", [{ message: SECRET_CANARY }]],
    ["descriptors", [{ canonical_fingerprint: SECRET_CANARY }]],
    ["raw_line", SECRET_CANARY],
  ] as const) {
    assertEvidenceError(
      () => normalizeSourceEvidenceEnvelope({ ...marker, [field]: value }),
      "unknown_field",
    );
  }

  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope({
      ...marker,
      reason: SECRET_CANARY,
    }),
    "invalid_state",
  );
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope({
      ...marker,
      adapter_id: SECRET_CANARY,
    }),
    "invalid_state",
  );
});

test("envelopes reject recursive tool inputs and payloads above the fixed 128 MiB cap", {
  timeout: 120_000,
}, async (t) => {
  const store = await storeFixture(t);
  const fixture = await claudeEvidenceFixture(t, store);
  assertEligibleEnvelope(fixture.envelope);

  const recursive = structuredClone(fixture.envelope) as typeof fixture.envelope;
  const input: Record<string, unknown> = {};
  input.self = input;
  replaceFirstEventWithToolInput(recursive, input);
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(recursive),
    "invalid_state",
  );

  const tooDeep = structuredClone(fixture.envelope) as typeof fixture.envelope;
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let depth = 0; depth < 66; depth += 1) {
    const child: Record<string, unknown> = {};
    cursor.child = child;
    cursor = child;
  }
  replaceFirstEventWithToolInput(tooDeep, root);
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(tooDeep),
    "invalid_state",
  );

  const exact = negativeEnvelope("/");
  const baseBytes = Buffer.byteLength(canonicalJson(exact));
  assert.ok(baseBytes < MAX_INCREMENTAL_PARSER_STATE_BYTES);
  exact.canonical_path += "x".repeat(
    MAX_INCREMENTAL_PARSER_STATE_BYTES - baseBytes,
  );
  assert.equal(
    Buffer.byteLength(canonicalJson(exact)),
    MAX_INCREMENTAL_PARSER_STATE_BYTES,
  );
  assert.doesNotThrow(() => normalizeSourceEvidenceEnvelope(exact));
  exact.canonical_path += "x";
  assertEvidenceError(
    () => normalizeSourceEvidenceEnvelope(exact),
    "invalid_state",
  );
});

test("cache rows validate canonical payloads, descriptor digests, and detached positive and negative values", async (t) => {
  const store = await storeFixture(t);
  const positive = await claudeEvidenceFixture(t, store);
  const normalized = normalizeSourceEvidenceEnvelope(positive.envelope);
  const validated = validateSourceEvidenceCacheEntry(positive.cache);
  assert.deepEqual(validated, positive.cache);
  assert.notEqual(validated, positive.cache);
  assert.equal(Object.getPrototypeOf(validated), Object.prototype);
  assert.equal(validated.payload_json, canonicalJson(normalized));

  positive.cache.canonical_path = "/mutated-after-validation";
  assert.notEqual(validated.canonical_path, positive.cache.canonical_path);

  const path = join(store.repositoryRoot, "negative.jsonl");
  const envelope = negativeEnvelope(path);
  const catalog = catalogEntry({
    adapter: "claude",
    canonicalPath: path,
    content: "",
    parsedOffset: 0,
    sourceIdentity: `source-${"b".repeat(64)}`,
  });
  const negative = cacheEntry({
    catalog,
    envelope,
    repositoryIdentity: store.paths.repo_hash,
    eligibilityIdentity: ROOT_B,
    lineCount: 0,
    endsWithNewline: false,
  });
  assert.deepEqual(
    validateSourceEvidenceCacheEntry(negative.cache),
    negative.cache,
  );
  assert.equal(
    negative.cache.descriptor_digest,
    descriptorDigest(
      Object.fromEntries(Object.entries(negative.cache).filter(
        ([key]) => key !== "payload_digest" && key !== "descriptor_digest",
      )) as Omit<
        SourceEvidenceCacheEntry,
        "payload_digest" | "descriptor_digest"
      >,
      [],
    ),
  );
});

test("cache validation rejects hostile rows, noncanonical JSON, bad bounds, digests, labels, and foreign copies", async (t) => {
  const store = await storeFixture(t);
  const fixture = await claudeEvidenceFixture(t, store);
  const cache = fixture.cache;

  for (const input of [null, [], Object.create(cache)]) {
    assertEvidenceError(
      () => validateSourceEvidenceCacheEntry(input),
      "invalid_shape",
    );
  }
  let getterCalled = false;
  const accessor = { ...cache };
  Object.defineProperty(accessor, "payload_json", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error(SECRET_CANARY);
    },
  });
  assertEvidenceError(
    () => validateSourceEvidenceCacheEntry(accessor),
    "invalid_shape",
  );
  assert.equal(getterCalled, false);
  assertEvidenceError(
    () => validateSourceEvidenceCacheEntry(new Proxy(cache, {
      ownKeys() {
        throw new Error(SECRET_CANARY);
      },
    })),
    "invalid_shape",
  );
  assertEvidenceError(
    () => validateSourceEvidenceCacheEntry({
      ...cache,
      prompt: SECRET_CANARY,
    }),
    "unknown_field",
  );

  for (const [field, value, code] of [
    ["source_identity", `source-${"A".repeat(64)}`, "invalid_text"],
    ["repository_identity", "a".repeat(63), "invalid_hash"],
    ["eligibility_identity", "a".repeat(65), "invalid_hash"],
    ["canonical_path", `/${SECRET_CANARY}\0`, "invalid_text"],
    ["parser_version", `v1\0${SECRET_CANARY}`, "invalid_text"],
    ["content_revision", HASH_A.toUpperCase(), "invalid_hash"],
    ["schema_fingerprint", HASH_A.slice(0, -1), "invalid_hash"],
    ["payload_digest", HASH_A.toUpperCase(), "invalid_hash"],
    ["descriptor_digest", HASH_A.slice(0, -1), "invalid_hash"],
    ["sensitivity", SECRET_CANARY, "foreign_binding"],
    ["retention_class", SECRET_CANARY, "foreign_binding"],
    ["ends_with_newline", 1, "invalid_state"],
  ] as const) {
    assertEvidenceError(
      () => validateSourceEvidenceCacheEntry({ ...cache, [field]: value }),
      code,
    );
  }

  for (const field of [
    "last_parsed_offset",
    "line_count",
    "updated_at_ms",
  ] as const) {
    for (const value of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assertEvidenceError(
        () => validateSourceEvidenceCacheEntry({
          ...cache,
          [field]: value,
        }),
        "invalid_integer",
      );
    }
  }

  for (const field of ["payload_digest", "descriptor_digest"] as const) {
    assertEvidenceError(
      () => validateSourceEvidenceCacheEntry({ ...cache, [field]: HASH_B }),
      "digest_mismatch",
    );
  }

  for (const [field, value] of [
    ["repository_identity", "3".repeat(64)],
    ["eligibility_identity", "4".repeat(64)],
    ["source_identity", `source-${"c".repeat(64)}`],
    ["content_revision", HASH_A],
    ["parser_version", "9.9.9"],
    ["schema_fingerprint", HASH_B],
  ] as const) {
    assertEvidenceError(
      () => validateSourceEvidenceCacheEntry({ ...cache, [field]: value }),
      "digest_mismatch",
    );
  }

  for (const [field, value] of [
    ["adapter_id", "codex"],
    ["canonical_path", `/${SECRET_CANARY}.jsonl`],
    ["last_parsed_offset", cache.last_parsed_offset - 1],
    ["line_count", cache.line_count - 1],
    ["ends_with_newline", !cache.ends_with_newline],
  ] as const) {
    const changed = {
      ...cache,
      [field]: value,
    } as SourceEvidenceCacheEntry;
    const withoutDigests = Object.fromEntries(Object.entries(changed).filter(
      ([key]) => key !== "payload_digest" && key !== "descriptor_digest",
    )) as Omit<
      SourceEvidenceCacheEntry,
      "payload_digest" | "descriptor_digest"
    >;
    const rebound = bindCache(withoutDigests, fixture.descriptors);
    assertEvidenceError(
      () => validateSourceEvidenceCacheEntry(rebound),
      "foreign_binding",
    );
  }

  const compactBase = {
    ...cache,
    payload_json: JSON.stringify(fixture.envelope),
  };
  const compactWithoutDigests = Object.fromEntries(Object.entries(compactBase)
    .filter(([key]) => key !== "payload_digest" && key !== "descriptor_digest")) as
    Omit<SourceEvidenceCacheEntry, "payload_digest" | "descriptor_digest">;
  const compact = bindCache(compactWithoutDigests, fixture.descriptors);
  assertEvidenceError(
    () => validateSourceEvidenceCacheEntry(compact),
    "invalid_state",
  );

  const rawEnvelope = {
    ...structuredClone(fixture.envelope),
    raw_line: SECRET_CANARY,
  };
  const rawBase = {
    ...cache,
    payload_json: canonicalJson(rawEnvelope),
  };
  const rawWithoutDigests = Object.fromEntries(Object.entries(rawBase)
    .filter(([key]) => key !== "payload_digest" && key !== "descriptor_digest")) as
    Omit<SourceEvidenceCacheEntry, "payload_digest" | "descriptor_digest">;
  const rawPayload = bindCache(rawWithoutDigests, fixture.descriptors);
  assertEvidenceError(
    () => validateSourceEvidenceCacheEntry(rawPayload),
    "unknown_field",
  );
});

test("pair reads require one valid joined complete catalog/cache pair and turn corruption into a miss", async (t) => {
  const store = await storeFixture(t);
  const fixture = await claudeEvidenceFixture(t, store);
  const { database } = store;

  for (const pair of [
    {
      catalog: fixture.catalog,
      cache: {
        ...fixture.cache,
        updated_at_ms: fixture.cache.updated_at_ms + 1,
      },
    },
    {
      catalog: {
        ...fixture.catalog,
        schema_fingerprint: HASH_B,
      },
      cache: fixture.cache,
    },
    {
      catalog: {
        ...fixture.catalog,
        completeness: "partial" as const,
      },
      cache: fixture.cache,
    },
  ]) {
    assertEvidenceError(
      () => commitEligibleSourceEvidence(
        database,
        store.paths.repo_hash,
        ROOT_A,
        pair,
      ),
      "foreign_binding",
    );
    assert.equal(
      database.prepare("SELECT count(*) FROM source_catalog").pluck().get(),
      0,
      "pair validation completes before the transaction mutates either table",
    );
    assert.equal(
      database.prepare("SELECT count(*) FROM source_evidence_cache").pluck()
        .get(),
      0,
    );
  }

  assert.equal(
    getSourceEvidencePair(
      database,
      store.paths.repo_hash,
      ROOT_A,
      fixture.catalog.source_identity,
    ),
    undefined,
  );
  assert.equal(upsertSourceCatalogEntry(database, fixture.catalog), "inserted");
  assert.equal(
    getSourceEvidencePair(
      database,
      store.paths.repo_hash,
      ROOT_A,
      fixture.catalog.source_identity,
    ),
    undefined,
    "a catalog row without its cache partner is a cold miss",
  );
  assert.equal(
    commitEligibleSourceEvidence(
      database,
      store.paths.repo_hash,
      ROOT_A,
      { catalog: fixture.catalog, cache: fixture.cache },
    ),
    "inserted",
  );
  const loaded = getSourceEvidencePair(
    database,
    store.paths.repo_hash,
    ROOT_A,
    fixture.catalog.source_identity,
  );
  assert.deepEqual(loaded, {
    catalog: fixture.catalog,
    cache: fixture.cache,
  });
  assert.notEqual(loaded?.catalog, fixture.catalog);
  assert.notEqual(loaded?.cache, fixture.cache);
  loaded!.cache.canonical_path = "/mutated-detached-read";
  assert.equal(
    getSourceEvidencePair(
      database,
      store.paths.repo_hash,
      ROOT_A,
      fixture.catalog.source_identity,
    )?.cache.canonical_path,
    fixture.catalog.canonical_path,
  );

  database.prepare(`UPDATE source_evidence_cache
    SET payload_json = ?
    WHERE source_identity = ? AND eligibility_identity = ?`).run(
      canonicalJson({ raw_line: SECRET_CANARY }),
      fixture.catalog.source_identity,
      ROOT_A,
    );
  assert.equal(
    getSourceEvidencePair(
      database,
      store.paths.repo_hash,
      ROOT_A,
      fixture.catalog.source_identity,
    ),
    undefined,
    "corrupt payload JSON is a cold miss, not a partial row",
  );
  database.prepare(`UPDATE source_evidence_cache
    SET payload_json = ?, payload_digest = ?, descriptor_digest = ?
    WHERE source_identity = ? AND eligibility_identity = ?`).run(
      fixture.cache.payload_json,
      fixture.cache.payload_digest,
      fixture.cache.descriptor_digest,
      fixture.catalog.source_identity,
      ROOT_A,
    );

  database.prepare(`UPDATE source_catalog SET content_revision = ?
    WHERE source_identity = ?`).run(HASH_A, fixture.catalog.source_identity);
  assert.equal(
    getSourceEvidencePair(
      database,
      store.paths.repo_hash,
      ROOT_A,
      fixture.catalog.source_identity,
    ),
    undefined,
    "a mixed revision across the join is a cold miss",
  );

  assertEvidenceError(
    () => getSourceEvidencePair(
      database,
      SECRET_CANARY,
      ROOT_A,
      fixture.catalog.source_identity,
    ),
    "invalid_hash",
  );
});

test("atomic pair writes cover replay, same-time conflict, newer, stale, progress, and linked-root isolation", async (t) => {
  const store = await storeFixture(t);
  const initial = await claudeEvidenceFixture(t, store);
  const { database } = store;

  assert.equal(commitEligibleSourceEvidence(
    database,
    store.paths.repo_hash,
    ROOT_A,
    { catalog: initial.catalog, cache: initial.cache },
  ), "inserted");
  assert.equal(commitEligibleSourceEvidence(
    database,
    store.paths.repo_hash,
    ROOT_A,
    {
      catalog: structuredClone(initial.catalog),
      cache: structuredClone(initial.cache),
    },
  ), "unchanged");

  const conflict = reboundFixture(initial, {
    observedAtMs: initial.catalog.observed_at_ms,
    discoveryCursor: initial.catalog.discovery_cursor + 1,
  });
  assert.equal(commitEligibleSourceEvidence(
    database,
    store.paths.repo_hash,
    ROOT_A,
    { catalog: conflict.catalog, cache: conflict.cache },
  ), "conflict");
  assert.deepEqual(getSourceEvidencePair(
    database,
    store.paths.repo_hash,
    ROOT_A,
    initial.catalog.source_identity,
  ), { catalog: initial.catalog, cache: initial.cache });

  const newer = reboundFixture(initial, {
    observedAtMs: initial.catalog.observed_at_ms + 1,
    discoveryCursor: initial.catalog.discovery_cursor + 1,
  });
  assert.equal(commitEligibleSourceEvidence(
    database,
    store.paths.repo_hash,
    ROOT_A,
    { catalog: newer.catalog, cache: newer.cache },
  ), "updated");
  assert.deepEqual(getSourceEvidencePair(
    database,
    store.paths.repo_hash,
    ROOT_A,
    initial.catalog.source_identity,
  ), { catalog: newer.catalog, cache: newer.cache });

  const stale = reboundFixture(initial, {
    observedAtMs: initial.catalog.observed_at_ms,
  });
  assert.equal(commitEligibleSourceEvidence(
    database,
    store.paths.repo_hash,
    ROOT_A,
    { catalog: stale.catalog, cache: stale.cache },
  ), "stale");
  assert.deepEqual(getSourceEvidencePair(
    database,
    store.paths.repo_hash,
    ROOT_A,
    initial.catalog.source_identity,
  ), { catalog: newer.catalog, cache: newer.cache });

  const regressed = reboundFixture(newer, {
    observedAtMs: newer.catalog.observed_at_ms + 1,
    discoveryCursor: newer.catalog.discovery_cursor - 1,
  });
  assertEvidenceError(
    () => commitEligibleSourceEvidence(
      database,
      store.paths.repo_hash,
      ROOT_A,
      { catalog: regressed.catalog, cache: regressed.cache },
    ),
    "progress_regression",
  );
  assert.deepEqual(getSourceEvidencePair(
    database,
    store.paths.repo_hash,
    ROOT_A,
    initial.catalog.source_identity,
  ), { catalog: newer.catalog, cache: newer.cache });

  const marker = negativeEnvelope(newer.catalog.canonical_path);
  const otherRootBound = cacheEntry({
    catalog: newer.catalog,
    envelope: marker,
    repositoryIdentity: store.paths.repo_hash,
    eligibilityIdentity: ROOT_B,
    lineCount: newer.cache.line_count,
    endsWithNewline: newer.cache.ends_with_newline,
  });
  assert.equal(commitEligibleSourceEvidence(
    database,
    store.paths.repo_hash,
    ROOT_B,
    {
      catalog: structuredClone(newer.catalog),
      cache: otherRootBound.cache,
    },
  ), "inserted");
  assert.equal(
    JSON.parse(getSourceEvidencePair(
      database,
      store.paths.repo_hash,
      ROOT_A,
      initial.catalog.source_identity,
    )!.cache.payload_json).kind,
    "eligible-evidence-v1",
  );
  assert.equal(
    JSON.parse(getSourceEvidencePair(
      database,
      store.paths.repo_hash,
      ROOT_B,
      initial.catalog.source_identity,
    )!.cache.payload_json).kind,
    "no-evidence-v1",
  );

  const copiedAcrossRoots = {
    ...newer.cache,
    eligibility_identity: ROOT_B,
  };
  assertEvidenceError(
    () => commitEligibleSourceEvidence(
      database,
      store.paths.repo_hash,
      ROOT_B,
      { catalog: newer.catalog, cache: copiedAcrossRoots },
    ),
    "digest_mismatch",
  );
  assertEvidenceError(
    () => commitEligibleSourceEvidence(
      database,
      "3".repeat(64),
      ROOT_A,
      { catalog: newer.catalog, cache: newer.cache },
    ),
    "foreign_binding",
  );
});

test("a cache-write failure rolls the catalog and cache pair back together", async (t) => {
  const store = await storeFixture(t);
  const initial = await claudeEvidenceFixture(t, store);
  const { database } = store;
  assert.equal(commitEligibleSourceEvidence(
    database,
    store.paths.repo_hash,
    ROOT_A,
    { catalog: initial.catalog, cache: initial.cache },
  ), "inserted");
  const newer = reboundFixture(initial, {
    observedAtMs: initial.catalog.observed_at_ms + 1,
    discoveryCursor: initial.catalog.discovery_cursor + 1,
  });

  database.exec(`CREATE TEMP TRIGGER reject_evidence_cache_update
    BEFORE UPDATE ON source_evidence_cache
    BEGIN
      SELECT RAISE(ABORT, 'forced evidence cache rollback');
    END`);
  assert.throws(
    () => commitEligibleSourceEvidence(
      database,
      store.paths.repo_hash,
      ROOT_A,
      { catalog: newer.catalog, cache: newer.cache },
    ),
    /forced evidence cache rollback/u,
  );
  assert.deepEqual(getSourceEvidencePair(
    database,
    store.paths.repo_hash,
    ROOT_A,
    initial.catalog.source_identity,
  ), { catalog: initial.catalog, cache: initial.cache });
  assert.deepEqual(
    getSourceCatalogEntry(database, initial.catalog.source_identity),
    initial.catalog,
  );
});

test("a second WAL connection observes an old or new complete pair, never the writer's mixed intermediate state", async (t) => {
  const store = await storeFixture(t);
  const initial = await claudeEvidenceFixture(t, store);
  const writer = store.database;
  const reader = openStoreDatabase(store.paths);
  try {
    assert.equal(commitEligibleSourceEvidence(
      writer,
      store.paths.repo_hash,
      ROOT_A,
      { catalog: initial.catalog, cache: initial.cache },
    ), "inserted");
    const newer = reboundFixture(initial, {
      observedAtMs: initial.catalog.observed_at_ms + 1,
      discoveryCursor: initial.catalog.discovery_cursor + 1,
    });
    const observed: Array<ReturnType<typeof getSourceEvidencePair>> = [];
    writer.function("observe_source_pair", () => {
      observed.push(getSourceEvidencePair(
        reader,
        store.paths.repo_hash,
        ROOT_A,
        initial.catalog.source_identity,
      ));
      return 1;
    });
    writer.exec(`CREATE TEMP TRIGGER observe_catalog_before_cache
      AFTER UPDATE ON source_catalog
      WHEN NEW.source_identity = '${initial.catalog.source_identity}'
      BEGIN
        SELECT observe_source_pair();
      END`);

    assert.equal(commitEligibleSourceEvidence(
      writer,
      store.paths.repo_hash,
      ROOT_A,
      { catalog: newer.catalog, cache: newer.cache },
    ), "updated");
    assert.deepEqual(observed, [{
      catalog: initial.catalog,
      cache: initial.cache,
    }]);
    assert.deepEqual(getSourceEvidencePair(
      reader,
      store.paths.repo_hash,
      ROOT_A,
      initial.catalog.source_identity,
    ), { catalog: newer.catalog, cache: newer.cache });
  } finally {
    reader.close();
  }
});
