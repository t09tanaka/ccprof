import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import type { Session, SourceWarning } from "../core/model.js";
import {
  sourceDescriptorsForSessions,
  type SourceAdapterId,
  type SourceDescriptor,
} from "../core/source-descriptor.js";
import {
  CLAUDE_PARSER_VERSION,
  normalizeClaudeParserState,
  projectClaudeParserState,
  type ClaudeParserStateV1,
} from "../sources/claude/parser.js";
import {
  CODEX_PARSER_VERSION,
  normalizeCodexParserState,
  projectCodexParserState,
  type CodexParserStateV1,
} from "../sources/codex/parser.js";
import {
  canonicalJsonStringBytes,
  MAX_INCREMENTAL_PARSER_STATE_BYTES,
  PARSER_STATE_SCHEMA_FINGERPRINT,
} from "../sources/jsonl-budget.js";
import { canonicalJson } from "./legacy-json.js";
import {
  getSourceCatalogEntry,
  SourceCatalogError,
  type SourceCatalogEntry,
  upsertSourceCatalogEntry,
  validateSourceCatalogEntry,
} from "./source-catalog.js";

export interface EligibleSourceEvidenceEnvelopeV1 {
  schema_version: 1;
  kind: "eligible-evidence-v1";
  adapter_id: SourceAdapterId;
  canonical_path: string;
  full_sessions: Session[];
  parse_warnings: SourceWarning[];
  continuation: ClaudeParserStateV1 | CodexParserStateV1;
}

export interface NoEvidenceMarkerV1 {
  schema_version: 1;
  kind: "no-evidence-v1";
  adapter_id: SourceAdapterId;
  canonical_path: string;
  reason: "empty" | "other-repository-only";
}

export type SourceEvidenceEnvelopeV1 =
  | EligibleSourceEvidenceEnvelopeV1
  | NoEvidenceMarkerV1;

export interface SourceEvidenceCacheEntry {
  source_identity: string;
  repository_identity: string;
  eligibility_identity: string;
  adapter_id: SourceAdapterId;
  canonical_path: string;
  content_revision: string;
  parser_version: string;
  schema_fingerprint: string;
  last_parsed_offset: number;
  line_count: number;
  ends_with_newline: boolean;
  payload_json: string;
  payload_digest: string;
  descriptor_digest: string;
  sensitivity: "sensitive";
  retention_class: "raw_evidence";
  updated_at_ms: number;
}

export interface SourceEvidencePairOptions {
  adapterId: SourceAdapterId; canonicalPath: string; repositoryIdentity: string;
  eligibilityIdentity: string; observedAtMs: number;
  observation: {
    device: number | null; inode: number | null; mtimeMs: number; sizeBytes: number;
    prefixHash: string; suffixHash: string; contentRevision: string;
  };
  parserState: ClaudeParserStateV1 | CodexParserStateV1;
  evidence: { sessions: Session[]; warnings: SourceWarning[];
    negativeReason?: NoEvidenceMarkerV1["reason"] };
}

export type SourceEvidenceCacheErrorCode =
  | "invalid_shape"
  | "unknown_field"
  | "invalid_text"
  | "invalid_hash"
  | "invalid_integer"
  | "invalid_state"
  | "foreign_binding"
  | "digest_mismatch"
  | "observation_conflict"
  | "progress_regression";

export class SourceEvidenceCacheError extends Error {
  constructor(readonly code: SourceEvidenceCacheErrorCode) {
    super(`invalid source evidence cache: ${code}`);
    this.name = "SourceEvidenceCacheError";
  }
}

export type SourceEvidenceCommitResult =
  | "inserted"
  | "updated"
  | "unchanged"
  | "stale"
  | "conflict";

const POSITIVE_FIELDS = [
  "schema_version", "kind", "adapter_id", "canonical_path",
  "full_sessions", "parse_warnings", "continuation",
] as const;
const NEGATIVE_FIELDS = [
  "schema_version", "kind", "adapter_id", "canonical_path", "reason",
] as const;
const CACHE_FIELDS = [
  "source_identity", "repository_identity", "eligibility_identity",
  "adapter_id", "canonical_path", "content_revision", "parser_version",
  "schema_fingerprint", "last_parsed_offset", "line_count",
  "ends_with_newline", "payload_json", "payload_digest",
  "descriptor_digest", "sensitivity", "retention_class", "updated_at_ms",
] as const satisfies readonly (keyof SourceEvidenceCacheEntry)[];
const CATALOG_FIELDS = [
  "adapter_id", "adapter_version", "source_identity", "canonical_path",
  "device", "inode", "mtime_ms", "size_bytes", "prefix_hash", "suffix_hash",
  "content_revision", "discovery_cursor", "last_parsed_offset",
  "last_normalized_event_index", "parser_version", "schema_fingerprint",
  "observed_at_ms", "completeness",
] as const satisfies readonly (keyof SourceCatalogEntry)[];
const CACHE_COLUMN_LIST = CACHE_FIELDS.join(", ");
const CACHE_PARAMETERS = CACHE_FIELDS.map((field) => `@${field}`).join(", ");
const CACHE_UPDATE = CACHE_FIELDS.filter((field) =>
  field !== "source_identity" && field !== "eligibility_identity"
).map((field) => `${field} = excluded.${field}`).join(", ");
const SOURCE_ID = /^source-[a-f0-9]{64}$/u;
const IDENTITY = /^[a-f0-9]{64}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_JSON_DEPTH = 256;

function fail(code: SourceEvidenceCacheErrorCode): never {
  throw new SourceEvidenceCacheError(code);
}

function adapter(value: unknown): SourceAdapterId {
  return value === "claude" || value === "codex"
    ? value
    : fail("invalid_state");
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    return fail("invalid_text");
  }
  return value;
}

function sourceIdentity(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) {
    return fail("invalid_text");
  }
  return value;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || !IDENTITY.test(value)) {
    return fail("invalid_hash");
  }
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    return fail("invalid_hash");
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("invalid_integer");
  }
  return value;
}

function proxyOrArray(
  value: object,
  code: SourceEvidenceCacheErrorCode,
): boolean {
  try {
    return utilTypes.isProxy(value) || Array.isArray(value);
  } catch {
    return fail(code);
  }
}

function capturedObject(value: unknown): {
  descriptors: PropertyDescriptorMap;
  keys: PropertyKey[];
} {
  if (value === null || typeof value !== "object") {
    return fail("invalid_shape");
  }
  if (proxyOrArray(value, "invalid_shape")) {
    return fail("invalid_shape");
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return fail("invalid_shape");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return { descriptors, keys: Reflect.ownKeys(descriptors) };
  } catch {
    return fail("invalid_shape");
  }
}

function dataValue(
  descriptor: PropertyDescriptor | undefined,
): unknown {
  if (
    descriptor === undefined || descriptor.enumerable !== true ||
    !("value" in descriptor)
  ) {
    return fail("invalid_shape");
  }
  return descriptor.value;
}

function captureExact(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const { descriptors, keys } = capturedObject(value);
  const allowed = new Set<PropertyKey>(fields);
  if (keys.some((key) => !allowed.has(key))) return fail("unknown_field");
  if (fields.some((field) => descriptors[field] === undefined)) {
    return fail("invalid_shape");
  }
  return Object.fromEntries(fields.map((field) => [
    field,
    dataValue(descriptors[field]),
  ]));
}

interface SnapshotContext {
  readonly active: WeakSet<object>;
  bytes: number;
}

interface SnapshotFrame {
  readonly source: object;
  readonly descriptors: Record<string, PropertyDescriptor>;
  readonly keys: PropertyKey[];
  readonly output: unknown[] | Record<string, unknown> | undefined;
  readonly arrayLength: number | undefined;
  readonly depth: number;
  index: number;
}

interface PendingSnapshot {
  readonly value: unknown;
  readonly depth: number;
  readonly parent: SnapshotFrame | undefined;
  readonly key: string | number | undefined;
}

function addSnapshotBytes(context: SnapshotContext, amount: number): void {
  const next = context.bytes + amount;
  if (
    !Number.isSafeInteger(amount) || amount < 0 ||
    !Number.isSafeInteger(next) || next > MAX_INCREMENTAL_PARSER_STATE_BYTES
  ) {
    fail("invalid_state");
  }
  context.bytes = next;
}

function addContainerBytes(
  context: SnapshotContext,
  count: number,
  depth: number,
): void {
  addSnapshotBytes(context, 2);
  if (count === 0) return;
  addSnapshotBytes(context, count + 1);
  addSnapshotBytes(context, count - 1);
  addSnapshotBytes(context, count * 2 * (depth + 1));
  addSnapshotBytes(context, 2 * depth);
}

function attachSnapshot(
  frame: SnapshotFrame | undefined,
  key: string | number | undefined,
  value: unknown,
  setRoot: (value: unknown) => void,
): void {
  if (frame === undefined) {
    setRoot(value);
  } else if (frame.output !== undefined) {
    if (frame.arrayLength !== undefined) {
      (frame.output as unknown[]).push(value);
    } else {
      Object.defineProperty(frame.output, key as string, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
}

function omittedJsonValue(value: unknown): boolean {
  return value === undefined || typeof value === "function" ||
    typeof value === "symbol";
}

function inspectCanonicalJson(value: unknown, copy: boolean): unknown {
  const context: SnapshotContext = {
    active: new WeakSet<object>(),
    bytes: 1,
  };
  const frames: SnapshotFrame[] = [];
  let result: unknown = undefined;
  let pending: PendingSnapshot | undefined = {
    value,
    depth: 0,
    parent: undefined,
    key: undefined,
  };
  const setRoot = (next: unknown): void => {
    result = next;
  };

  while (pending !== undefined || frames.length > 0) {
    if (pending !== undefined) {
      const current = pending;
      pending = undefined;
      if (current.depth > MAX_JSON_DEPTH) return fail("invalid_state");

      const input = current.value;
      if (input === null) {
        addSnapshotBytes(context, 4);
        if (copy) attachSnapshot(current.parent, current.key, null, setRoot);
        continue;
      }
      if (typeof input === "string") {
        addSnapshotBytes(context, canonicalJsonStringBytes(input));
        if (copy) attachSnapshot(current.parent, current.key, input, setRoot);
        continue;
      }
      if (typeof input === "boolean") {
        addSnapshotBytes(context, input ? 4 : 5);
        if (copy) attachSnapshot(current.parent, current.key, input, setRoot);
        continue;
      }
      if (typeof input === "number") {
        if (!Number.isFinite(input)) {
          if (copy) return fail("invalid_state");
          addSnapshotBytes(context, 4);
          continue;
        }
        const serialized = JSON.stringify(input);
        if (serialized === undefined) return fail("invalid_state");
        addSnapshotBytes(context, Buffer.byteLength(serialized));
        if (copy) attachSnapshot(current.parent, current.key, input, setRoot);
        continue;
      }
      if (omittedJsonValue(input)) {
        if (!copy && current.parent?.arrayLength !== undefined) {
          addSnapshotBytes(context, 4);
          continue;
        }
        return fail("invalid_state");
      }
      if (
        typeof input !== "object" ||
        utilTypes.isProxy(input) || context.active.has(input)
      ) {
        return fail("invalid_state");
      }

      let descriptors: Record<string, PropertyDescriptor>;
      let keys: PropertyKey[];
      let arrayLength: number | undefined;
      try {
        if (Array.isArray(input)) {
          if (Object.getPrototypeOf(input) !== Array.prototype) {
            return fail("invalid_state");
          }
          descriptors = Object.getOwnPropertyDescriptors(input);
          const ownKeys = Reflect.ownKeys(descriptors);
          const lengthDescriptor = descriptors.length;
          if (
            lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
            !Number.isSafeInteger(lengthDescriptor.value) ||
            lengthDescriptor.value < 0 ||
            (copy && ownKeys.length !== lengthDescriptor.value + 1)
          ) {
            return fail("invalid_state");
          }
          arrayLength = lengthDescriptor.value as number;
          keys = copy ? ownKeys : [];
        } else {
          const prototype = Object.getPrototypeOf(input);
          if (prototype !== Object.prototype && prototype !== null) {
            return fail("invalid_state");
          }
          descriptors = Object.getOwnPropertyDescriptors(input);
          const ownKeys = Reflect.ownKeys(descriptors);
          keys = [];
          for (const key of ownKeys) {
            if (typeof key !== "string") {
              if (copy) return fail("invalid_state");
              continue;
            }
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor)) {
              return fail("invalid_state");
            }
            if (!copy && (
              descriptor.enumerable !== true || omittedJsonValue(descriptor.value)
            )) {
              continue;
            }
            keys.push(key);
            addSnapshotBytes(context, canonicalJsonStringBytes(key) + 2);
          }
        }
      } catch (error) {
        if (error instanceof SourceEvidenceCacheError) throw error;
        return fail("invalid_state");
      }

      const count = arrayLength ?? keys.length;
      addContainerBytes(context, count, current.depth);
      const output = copy
        ? arrayLength === undefined ? {} : []
        : undefined;
      if (copy) attachSnapshot(current.parent, current.key, output, setRoot);
      context.active.add(input);
      if (count === 0) {
        context.active.delete(input);
        continue;
      }
      frames.push({
        source: input,
        descriptors,
        keys,
        output,
        arrayLength,
        depth: current.depth,
        index: 0,
      });
      continue;
    }

    const frame = frames[frames.length - 1]!;
    const count = frame.arrayLength ?? frame.keys.length;
    if (frame.index >= count) {
      context.active.delete(frame.source);
      frames.pop();
      continue;
    }
    const key = frame.arrayLength === undefined
      ? frame.keys[frame.index] as string
      : frame.index;
    frame.index += 1;
    const descriptor = frame.descriptors[key.toString()];
    const value = !copy && frame.arrayLength !== undefined
      ? descriptor === undefined
        ? undefined
        : "value" in descriptor
          ? descriptor.value
          : fail("invalid_state")
      : dataStateValue(descriptor);
    pending = {
      value,
      depth: frame.depth + 1,
      parent: frame,
      key,
    };
  }
  return result;
}

function snapshotJson(value: unknown): unknown {
  return inspectCanonicalJson(value, true);
}

function assertCanonicalJsonCapacity(value: unknown): void {
  inspectCanonicalJson(value, false);
}

function dataStateValue(
  descriptor: PropertyDescriptor | undefined,
): unknown {
  if (
    descriptor === undefined || descriptor.enumerable !== true ||
    !("value" in descriptor)
  ) {
    return fail("invalid_state");
  }
  return descriptor.value;
}

function stateKind(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return fail("invalid_state");
  }
  if (proxyOrArray(value, "invalid_state")) {
    return fail("invalid_state");
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
    const kind = dataStateValue(descriptor);
    return typeof kind === "string" ? kind : fail("invalid_state");
  } catch (error) {
    if (error instanceof SourceEvidenceCacheError) throw error;
    return fail("invalid_state");
  }
}

function assertWarningPaths(
  value: unknown,
  canonicalPath: string,
): asserts value is SourceWarning[] {
  if (!Array.isArray(value)) return fail("invalid_state");
  for (const warning of value) {
    if (
      warning === null || typeof warning !== "object" || Array.isArray(warning)
    ) {
      return fail("invalid_state");
    }
    const sourcePath = (warning as Record<string, unknown>).source_path;
    if (sourcePath !== canonicalPath) return fail("foreign_binding");
  }
}

function assertSessionBindings(
  value: unknown,
  source: SourceAdapterId,
  canonicalPath: string,
): asserts value is Session[] {
  if (!Array.isArray(value)) return fail("invalid_state");
  if (
    (source === "claude" && value.length === 0) ||
    (source === "codex" && value.length !== 1)
  ) {
    return fail("foreign_binding");
  }
  for (const session of value) {
    if (
      session === null || typeof session !== "object" || Array.isArray(session)
    ) {
      return fail("invalid_state");
    }
    const record = session as Record<string, unknown>;
    if (record.source !== source || record.source_path !== canonicalPath) {
      return fail("foreign_binding");
    }
    assertWarningPaths(record.warnings, canonicalPath);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function enforceEnvelopeCapacity(value: SourceEvidenceEnvelopeV1): void {
  assertCanonicalJsonCapacity(value);
}

function normalizePositive(
  captured: Record<string, unknown>,
): EligibleSourceEvidenceEnvelopeV1 {
  if (captured.schema_version !== 1) return fail("invalid_state");
  assertCanonicalJsonCapacity(captured);
  const source = adapter(captured.adapter_id);
  const canonicalPath = text(captured.canonical_path);
  const sessions = snapshotJson(captured.full_sessions);
  const warnings = snapshotJson(captured.parse_warnings);
  assertSessionBindings(sessions, source, canonicalPath);
  assertWarningPaths(warnings, canonicalPath);

  const kind = stateKind(captured.continuation);
  let continuation: ClaudeParserStateV1 | CodexParserStateV1;
  let projectedSessions: Session[];
  let projectedWarnings: SourceWarning[];
  try {
    if (kind === "claude-state-v1") {
      continuation = normalizeClaudeParserState(captured.continuation);
      if (source !== "claude" || continuation.canonical_path !== canonicalPath) {
        return fail("foreign_binding");
      }
      const projected = projectClaudeParserState(continuation);
      projectedSessions = projected.sessions;
      projectedWarnings = projected.warnings;
    } else if (kind === "codex-state-v1") {
      continuation = normalizeCodexParserState(captured.continuation);
      if (source !== "codex" || continuation.canonical_path !== canonicalPath) {
        return fail("foreign_binding");
      }
      const projected = projectCodexParserState(continuation);
      if (projected === null) return fail("foreign_binding");
      projectedSessions = [projected];
      projectedWarnings = [...projected.warnings];
    } else {
      return fail("invalid_state");
    }
  } catch (error) {
    if (error instanceof SourceEvidenceCacheError) throw error;
    return fail("invalid_state");
  }
  assertCanonicalJsonCapacity(projectedSessions);
  assertCanonicalJsonCapacity(projectedWarnings);
  if (
    !sameJson(sessions, projectedSessions) ||
    !sameJson(warnings, projectedWarnings)
  ) {
    return fail("invalid_state");
  }
  continuation = snapshotJson(continuation) as
    ClaudeParserStateV1 | CodexParserStateV1;
  const normalized: EligibleSourceEvidenceEnvelopeV1 = {
    schema_version: 1,
    kind: "eligible-evidence-v1",
    adapter_id: source,
    canonical_path: canonicalPath,
    full_sessions: sessions,
    parse_warnings: warnings,
    continuation,
  };
  enforceEnvelopeCapacity(normalized);
  return normalized;
}

export function normalizeSourceEvidenceEnvelope(
  value: unknown,
): SourceEvidenceEnvelopeV1 {
  const { descriptors } = capturedObject(value);
  const kind = dataValue(descriptors.kind);
  if (kind === "eligible-evidence-v1") {
    return normalizePositive(captureExact(value, POSITIVE_FIELDS));
  }
  if (kind === "no-evidence-v1") {
    const captured = captureExact(value, NEGATIVE_FIELDS);
    if (captured.schema_version !== 1) return fail("invalid_state");
    const source = adapter(captured.adapter_id);
    const canonicalPath = text(captured.canonical_path);
    if (captured.reason !== "empty" &&
      captured.reason !== "other-repository-only") {
      return fail("invalid_state");
    }
    const normalized: NoEvidenceMarkerV1 = {
      schema_version: 1,
      kind: "no-evidence-v1",
      adapter_id: source,
      canonical_path: canonicalPath,
      reason: captured.reason,
    };
    enforceEnvelopeCapacity(normalized);
    return normalized;
  }
  return fail("invalid_state");
}

function boundDigest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`ccprof\0${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

type CacheWithoutDigests = Omit<
  SourceEvidenceCacheEntry,
  "payload_digest" | "descriptor_digest"
>;

function cacheBinding(cache: CacheWithoutDigests): Record<string, unknown> {
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

function expectedPayloadDigest(
  cache: CacheWithoutDigests,
  envelope: SourceEvidenceEnvelopeV1,
): string {
  const negativeProgress = envelope.kind === "no-evidence-v1"
    ? {
      line_count: cache.line_count,
      ends_with_newline: cache.ends_with_newline,
    }
    : {};
  return boundDigest("source-evidence-payload-v1", {
    ...cacheBinding(cache),
    ...negativeProgress,
    payload_json: cache.payload_json,
  });
}

function expectedDescriptorDigest(
  cache: CacheWithoutDigests,
  descriptors: readonly SourceDescriptor[],
): string {
  return boundDigest("source-evidence-descriptors-v1", {
    ...cacheBinding(cache),
    descriptors,
  });
}

export function sourceEvidenceIdentity(
  adapterId: SourceAdapterId, canonicalPath: string,
): string {
  const source = adapter(adapterId);
  return `source-${createHash("sha256")
    .update(`ccprof\0source-evidence-identity-v1\0${source}\0${text(canonicalPath)}`)
    .digest("hex")}`;
}

export function createSourceEvidencePair(
  options: SourceEvidencePairOptions,
): { catalog: SourceCatalogEntry; cache: SourceEvidenceCacheEntry } {
  const source = adapter(options.adapterId);
  const canonicalPath = text(options.canonicalPath);
  const continuation = source === "claude"
    ? normalizeClaudeParserState(options.parserState)
    : normalizeCodexParserState(options.parserState);
  if (continuation.canonical_path !== canonicalPath) fail("foreign_binding");
  const envelope = normalizeSourceEvidenceEnvelope(
    options.evidence.negativeReason === undefined
      ? { schema_version: 1, kind: "eligible-evidence-v1", adapter_id: source,
          canonical_path: canonicalPath, full_sessions: options.evidence.sessions,
          parse_warnings: options.evidence.warnings, continuation }
      : { schema_version: 1, kind: "no-evidence-v1", adapter_id: source,
          canonical_path: canonicalPath, reason: options.evidence.negativeReason },
  );
  const sourceId = sourceEvidenceIdentity(source, canonicalPath);
  const parserVersion = source === "claude" ? CLAUDE_PARSER_VERSION : CODEX_PARSER_VERSION;
  const catalog = validateSourceCatalogEntry({
    adapter_id: source, adapter_version: "1.0.0", source_identity: sourceId,
    canonical_path: canonicalPath, device: options.observation.device,
    inode: options.observation.inode, mtime_ms: Math.trunc(options.observation.mtimeMs),
    size_bytes: options.observation.sizeBytes, prefix_hash: options.observation.prefixHash,
    suffix_hash: options.observation.suffixHash,
    content_revision: options.observation.contentRevision,
    discovery_cursor: options.observation.sizeBytes, last_parsed_offset: continuation.parsed_offset,
    last_normalized_event_index: options.evidence.sessions.reduce((total, session) =>
      total + session.events.length, 0),
    parser_version: parserVersion, schema_fingerprint: PARSER_STATE_SCHEMA_FINGERPRINT,
    observed_at_ms: options.observedAtMs, completeness: "complete",
  });
  const row: CacheWithoutDigests = {
    source_identity: sourceId, repository_identity: options.repositoryIdentity,
    eligibility_identity: options.eligibilityIdentity,
    adapter_id: source, canonical_path: canonicalPath,
    content_revision: options.observation.contentRevision,
    parser_version: parserVersion, schema_fingerprint: PARSER_STATE_SCHEMA_FINGERPRINT,
    last_parsed_offset: continuation.parsed_offset, line_count: continuation.line_count,
    ends_with_newline: continuation.ends_with_newline,
    payload_json: canonicalJson(envelope), sensitivity: "sensitive",
    retention_class: "raw_evidence", updated_at_ms: options.observedAtMs,
  };
  const descriptors = envelope.kind === "eligible-evidence-v1" ?
    sourceDescriptorsForSessions(envelope.full_sessions) : [];
  const cache = validateSourceEvidenceCacheEntry({
    ...row, payload_digest: expectedPayloadDigest(row, envelope),
    descriptor_digest: expectedDescriptorDigest(row, descriptors),
  });
  const pair = { catalog, cache };
  assertPairBinding(options.repositoryIdentity, options.eligibilityIdentity, pair);
  return pair;
}

export function validateSourceEvidenceCacheEntry(
  value: unknown,
): SourceEvidenceCacheEntry {
  const captured = captureExact(value, CACHE_FIELDS);
  const source = adapter(captured.adapter_id);
  const row: CacheWithoutDigests = {
    source_identity: sourceIdentity(captured.source_identity),
    repository_identity: identity(captured.repository_identity),
    eligibility_identity: identity(captured.eligibility_identity),
    adapter_id: source,
    canonical_path: text(captured.canonical_path),
    content_revision: hash(captured.content_revision),
    parser_version: text(captured.parser_version),
    schema_fingerprint: hash(captured.schema_fingerprint),
    last_parsed_offset: integer(captured.last_parsed_offset),
    line_count: integer(captured.line_count),
    ends_with_newline: typeof captured.ends_with_newline === "boolean"
      ? captured.ends_with_newline
      : fail("invalid_state"),
    payload_json: text(captured.payload_json),
    sensitivity: captured.sensitivity === "sensitive"
      ? "sensitive"
      : fail("foreign_binding"),
    retention_class: captured.retention_class === "raw_evidence"
      ? "raw_evidence"
      : fail("foreign_binding"),
    updated_at_ms: integer(captured.updated_at_ms),
  };
  const payloadDigest = hash(captured.payload_digest);
  const descriptorDigest = hash(captured.descriptor_digest);

  if (Buffer.byteLength(row.payload_json) > MAX_INCREMENTAL_PARSER_STATE_BYTES) {
    return fail("invalid_state");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch {
    return fail("invalid_state");
  }
  const envelope = normalizeSourceEvidenceEnvelope(parsed);
  if (row.payload_json !== canonicalJson(envelope)) return fail("invalid_state");
  const descriptors = envelope.kind === "eligible-evidence-v1"
    ? sourceDescriptorsForSessions(envelope.full_sessions)
    : [];
  if (
    payloadDigest !== expectedPayloadDigest(row, envelope) ||
    descriptorDigest !== expectedDescriptorDigest(row, descriptors)
  ) {
    return fail("digest_mismatch");
  }
  if (
    row.adapter_id !== envelope.adapter_id ||
    row.canonical_path !== envelope.canonical_path
  ) {
    return fail("foreign_binding");
  }
  if (
    row.parser_version !== (row.adapter_id === "claude"
      ? CLAUDE_PARSER_VERSION
      : CODEX_PARSER_VERSION) ||
    row.schema_fingerprint !== PARSER_STATE_SCHEMA_FINGERPRINT
  ) {
    return fail("foreign_binding");
  }
  if (envelope.kind === "eligible-evidence-v1") {
    if (
      row.last_parsed_offset !== envelope.continuation.parsed_offset ||
      row.line_count !== envelope.continuation.line_count ||
      row.ends_with_newline !== envelope.continuation.ends_with_newline
    ) {
      return fail("foreign_binding");
    }
  }
  return {
    ...row,
    payload_digest: payloadDigest,
    descriptor_digest: descriptorDigest,
  };
}

function validatePairInput(value: unknown): {
  catalog: SourceCatalogEntry;
  cache: SourceEvidenceCacheEntry;
} {
  const captured = captureExact(value, ["catalog", "cache"]);
  if (
    captured.catalog !== null && typeof captured.catalog === "object" &&
    utilTypes.isProxy(captured.catalog)
  ) {
    return fail("invalid_state");
  }
  let catalog: SourceCatalogEntry;
  try {
    catalog = validateSourceCatalogEntry(captured.catalog);
  } catch {
    return fail("invalid_state");
  }
  return {
    catalog,
    cache: validateSourceEvidenceCacheEntry(captured.cache),
  };
}

function assertPairBinding(
  repositoryIdentity: string,
  eligibilityIdentity: string,
  pair: { catalog: SourceCatalogEntry; cache: SourceEvidenceCacheEntry },
): void {
  const { catalog, cache } = pair;
  let emptyMarker = false;
  try {
    const envelope = JSON.parse(cache.payload_json) as SourceEvidenceEnvelopeV1;
    emptyMarker = envelope.kind === "no-evidence-v1" &&
      envelope.reason === "empty";
  } catch {
    return fail("invalid_state");
  }
  if (
    cache.repository_identity !== repositoryIdentity ||
    cache.eligibility_identity !== eligibilityIdentity ||
    cache.source_identity !== catalog.source_identity ||
    cache.adapter_id !== catalog.adapter_id ||
    cache.canonical_path !== catalog.canonical_path ||
    cache.content_revision !== catalog.content_revision ||
    cache.parser_version !== catalog.parser_version ||
    cache.schema_fingerprint !== catalog.schema_fingerprint ||
    cache.last_parsed_offset !== catalog.last_parsed_offset ||
    cache.updated_at_ms !== catalog.observed_at_ms ||
    catalog.completeness !== "complete" ||
    (emptyMarker && (
      catalog.size_bytes !== 0 || catalog.last_parsed_offset !== 0 ||
      catalog.last_normalized_event_index !== 0 ||
      cache.last_parsed_offset !== 0 || cache.line_count !== 0 ||
      cache.ends_with_newline
    ))
  ) {
    fail("foreign_binding");
  }
}

function sameCatalog(
  left: SourceCatalogEntry,
  right: SourceCatalogEntry,
): boolean {
  return CATALOG_FIELDS.every((field) => left[field] === right[field]);
}

function sameCache(
  left: SourceEvidenceCacheEntry,
  right: SourceEvidenceCacheEntry,
): boolean {
  return CACHE_FIELDS.every((field) => left[field] === right[field]);
}

function cacheDatabaseRow(cache: SourceEvidenceCacheEntry): Record<string, unknown> {
  return {
    ...cache,
    ends_with_newline: cache.ends_with_newline ? 1 : 0,
  };
}

function cacheFromDatabaseRow(value: unknown): SourceEvidenceCacheEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("invalid_shape");
  }
  const row = value as Record<string, unknown>;
  const newline = row.ends_with_newline;
  return validateSourceEvidenceCacheEntry({
    ...row,
    ends_with_newline: newline === 0 ? false : newline === 1 ? true : newline,
  });
}

function getCacheEntry(
  database: Database.Database,
  repositoryIdentity: string,
  eligibilityIdentity: string,
  wantedSourceIdentity: string,
): SourceEvidenceCacheEntry | undefined {
  const row = database.prepare(
    `SELECT ${CACHE_COLUMN_LIST} FROM source_evidence_cache
      WHERE repository_identity = ? AND eligibility_identity = ?
        AND source_identity = ?`,
  ).get(repositoryIdentity, eligibilityIdentity, wantedSourceIdentity);
  return row === undefined ? undefined : cacheFromDatabaseRow(row);
}

function joinedPair(value: Record<string, unknown>): {
  catalog: SourceCatalogEntry;
  cache: SourceEvidenceCacheEntry;
} {
  const catalog = Object.fromEntries(CATALOG_FIELDS.map((field) => [
    field,
    value[`catalog_${field}`],
  ]));
  const cache = Object.fromEntries(CACHE_FIELDS.map((field) => [
    field,
    value[`cache_${field}`],
  ]));
  if (cache.ends_with_newline === 0) cache.ends_with_newline = false;
  else if (cache.ends_with_newline === 1) cache.ends_with_newline = true;
  return {
    catalog: validateSourceCatalogEntry(catalog),
    cache: validateSourceEvidenceCacheEntry(cache),
  };
}

const JOIN_COLUMNS = [
  ...CATALOG_FIELDS.map((field) =>
    `catalog.${field} AS catalog_${field}`
  ),
  ...CACHE_FIELDS.map((field) => `cache.${field} AS cache_${field}`),
].join(", ");

export function getSourceEvidencePair(
  database: Database.Database,
  repositoryIdentityValue: unknown,
  eligibilityIdentityValue: unknown,
  sourceIdentityValue: unknown,
): { catalog: SourceCatalogEntry; cache: SourceEvidenceCacheEntry } | undefined {
  const repositoryIdentity = identity(repositoryIdentityValue);
  const eligibilityIdentity = identity(eligibilityIdentityValue);
  const wantedSourceIdentity = sourceIdentity(sourceIdentityValue);
  const row = database.prepare(`
    SELECT ${JOIN_COLUMNS}
    FROM source_catalog AS catalog
    INNER JOIN source_evidence_cache AS cache
      ON cache.source_identity = catalog.source_identity
    WHERE cache.repository_identity = ? AND cache.eligibility_identity = ?
      AND catalog.source_identity = ?
  `).get(repositoryIdentity, eligibilityIdentity, wantedSourceIdentity);
  if (row === undefined) return undefined;
  try {
    const pair = joinedPair(row as Record<string, unknown>);
    assertPairBinding(repositoryIdentity, eligibilityIdentity, pair);
    return pair;
  } catch {
    return undefined;
  }
}

function writeCache(
  database: Database.Database,
  cache: SourceEvidenceCacheEntry,
): void {
  database.prepare(`
    INSERT INTO source_evidence_cache(${CACHE_COLUMN_LIST})
    VALUES (${CACHE_PARAMETERS})
    ON CONFLICT(source_identity, eligibility_identity)
    DO UPDATE SET ${CACHE_UPDATE}
  `).run(cacheDatabaseRow(cache));
}

function catalogWrite(
  database: Database.Database,
  catalog: SourceCatalogEntry,
): void {
  try {
    upsertSourceCatalogEntry(database, catalog);
  } catch (error) {
    if (error instanceof SourceCatalogError) {
      if (error.code === "progress_regression") return fail("progress_regression");
      if (error.code === "observation_conflict") {
        return fail("observation_conflict");
      }
    }
    throw error;
  }
}

export function commitEligibleSourceEvidence(
  database: Database.Database,
  repositoryIdentityValue: unknown,
  eligibilityIdentityValue: unknown,
  pairValue: {
    catalog: SourceCatalogEntry;
    cache: SourceEvidenceCacheEntry;
  },
): SourceEvidenceCommitResult {
  const repositoryIdentity = identity(repositoryIdentityValue);
  const eligibilityIdentity = identity(eligibilityIdentityValue);
  const pair = validatePairInput(pairValue);
  assertPairBinding(repositoryIdentity, eligibilityIdentity, pair);

  const write = database.transaction((): SourceEvidenceCommitResult => {
    const currentCatalog = getSourceCatalogEntry(
      database,
      pair.catalog.source_identity,
    );
    let currentCache: SourceEvidenceCacheEntry | undefined;
    let cacheCorrupt = false;
    try {
      currentCache = getCacheEntry(
        database,
        repositoryIdentity,
        eligibilityIdentity,
        pair.catalog.source_identity,
      );
    } catch {
      cacheCorrupt = true;
    }
    if (currentCatalog !== undefined) {
      if (pair.catalog.observed_at_ms < currentCatalog.observed_at_ms) {
        return "stale";
      }
      if (pair.catalog.observed_at_ms === currentCatalog.observed_at_ms) {
        if (!sameCatalog(currentCatalog, pair.catalog) || cacheCorrupt) {
          return "conflict";
        }
        if (currentCache !== undefined) {
          return sameCache(currentCache, pair.cache) ? "unchanged" : "conflict";
        }
      }
    }

    const inserted = currentCache === undefined;
    catalogWrite(database, pair.catalog);
    const authoritative = getSourceCatalogEntry(
      database,
      pair.catalog.source_identity,
    );
    if (authoritative === undefined || !sameCatalog(authoritative, pair.catalog)) {
      return fail("foreign_binding");
    }
    writeCache(database, pair.cache);
    return inserted ? "inserted" : "updated";
  });
  return write.immediate();
}
