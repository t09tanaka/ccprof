import type Database from "better-sqlite3";

import type {
  SourceAdapterId,
  SourceAdapterVersion,
} from "../core/source-descriptor.js";

export type SourceCatalogCompleteness = "complete" | "partial";

export interface SourceCatalogEntry {
  adapter_id: SourceAdapterId;
  adapter_version: SourceAdapterVersion;
  source_identity: string;
  canonical_path: string;
  device: number | null;
  inode: number | null;
  mtime_ms: number;
  size_bytes: number;
  prefix_hash: string;
  suffix_hash: string;
  content_revision: string;
  discovery_cursor: number;
  last_parsed_offset: number;
  last_normalized_event_index: number;
  parser_version: string;
  schema_fingerprint: string;
  observed_at_ms: number;
  completeness: SourceCatalogCompleteness;
}

export type SourceCatalogErrorCode =
  | "invalid_shape"
  | "unknown_field"
  | "invalid_adapter"
  | "invalid_text"
  | "invalid_hash"
  | "invalid_integer"
  | "invalid_file_identity"
  | "invalid_boundary"
  | "invalid_completeness"
  | "observation_conflict"
  | "progress_regression";

export class SourceCatalogError extends Error {
  constructor(readonly code: SourceCatalogErrorCode) {
    super(`invalid source catalog entry: ${code}`);
    this.name = "SourceCatalogError";
  }
}

export type SourceCatalogUpsertResult =
  | "inserted"
  | "updated"
  | "unchanged"
  | "stale";

const FIELDS = [
  "adapter_id", "adapter_version", "source_identity", "canonical_path",
  "device", "inode", "mtime_ms", "size_bytes", "prefix_hash", "suffix_hash",
  "content_revision", "discovery_cursor", "last_parsed_offset",
  "last_normalized_event_index", "parser_version", "schema_fingerprint",
  "observed_at_ms", "completeness",
] as const satisfies readonly (keyof SourceCatalogEntry)[];
const FIELD_SET = new Set<PropertyKey>(FIELDS);
const INTEGER_FIELDS = [
  "device", "inode", "mtime_ms", "size_bytes", "discovery_cursor",
  "last_parsed_offset", "last_normalized_event_index", "observed_at_ms",
] as const;
const HASH_FIELDS = [
  "prefix_hash", "suffix_hash", "content_revision", "schema_fingerprint",
] as const;
const CONTENT_FIELDS = [
  "adapter_id", "adapter_version", "source_identity", "canonical_path",
  "device", "inode", "mtime_ms", "size_bytes", "prefix_hash", "suffix_hash",
  "content_revision", "parser_version", "schema_fingerprint",
] as const;
const SOURCE_ID = /^source-[a-f0-9]{64}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COLUMNS = FIELDS.join(", ");
const PARAMETERS = FIELDS.map((field) => `@${field}`).join(", ");
const UPDATE = FIELDS.filter((field) => field !== "source_identity")
  .map((field) => `${field} = excluded.${field}`).join(", ");

function fail(code: SourceCatalogErrorCode): never {
  throw new SourceCatalogError(code);
}

function validSourceIdentity(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID.test(value)) return fail("invalid_text");
  return value;
}

export function validateSourceCatalogEntry(value: unknown): SourceCatalogEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("invalid_shape");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail("invalid_shape");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => !FIELD_SET.has(key))) return fail("unknown_field");
  if (FIELDS.some((field) => descriptors[field] === undefined)) return fail("invalid_shape");
  if (FIELDS.some((field) => !("value" in descriptors[field]!) ||
    descriptors[field]!.enumerable !== true)) return fail("invalid_shape");
  const row = Object.fromEntries(FIELDS.map((field) =>
    [field, descriptors[field]!.value]
  )) as Record<keyof SourceCatalogEntry, unknown>;

  if ((row.adapter_id !== "claude" && row.adapter_id !== "codex") ||
    row.adapter_version !== "1.0.0") return fail("invalid_adapter");
  validSourceIdentity(row.source_identity);
  for (const field of ["canonical_path", "parser_version"] as const) {
    const text = row[field];
    if (typeof text !== "string" || text.length === 0 || text.includes("\0")) {
      return fail("invalid_text");
    }
  }
  for (const field of HASH_FIELDS) {
    if (typeof row[field] !== "string" || !SHA256.test(row[field])) {
      return fail("invalid_hash");
    }
  }
  for (const field of INTEGER_FIELDS) {
    const number = row[field];
    if ((field === "device" || field === "inode") && number === null) continue;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
      return fail("invalid_integer");
    }
  }
  if ((row.device === null) !== (row.inode === null)) {
    return fail("invalid_file_identity");
  }
  if (row.completeness !== "complete" && row.completeness !== "partial") {
    return fail("invalid_completeness");
  }
  if ((row.last_parsed_offset as number) > (row.size_bytes as number) ||
    (row.completeness === "complete" && row.last_parsed_offset !== row.size_bytes)) {
    return fail("invalid_boundary");
  }
  const validated = (Object.fromEntries(
    FIELDS.map((field) => [field, row[field]]),
  )) as unknown as SourceCatalogEntry;
  return validated;
}

function sameEntry(left: SourceCatalogEntry, right: SourceCatalogEntry): boolean {
  return FIELDS.every((field) => left[field] === right[field]);
}

export function getSourceCatalogEntry(
  database: Database.Database,
  sourceIdentity: unknown,
): SourceCatalogEntry | undefined {
  const row = database.prepare(
    `SELECT ${COLUMNS} FROM source_catalog WHERE source_identity = ?`,
  ).get(validSourceIdentity(sourceIdentity));
  return row === undefined ? undefined : validateSourceCatalogEntry(row);
}

export function listSourceCatalogEntries(
  database: Database.Database,
): SourceCatalogEntry[] {
  return database.prepare(
    `SELECT ${COLUMNS} FROM source_catalog ORDER BY source_identity`,
  ).all().map(validateSourceCatalogEntry);
}

export function upsertSourceCatalogEntry(
  database: Database.Database,
  value: unknown,
): SourceCatalogUpsertResult {
  const candidate = validateSourceCatalogEntry(value);
  const write = database.transaction((): SourceCatalogUpsertResult => {
    const current = getSourceCatalogEntry(database, candidate.source_identity);
    if (current !== undefined) {
      if (candidate.observed_at_ms < current.observed_at_ms) return "stale";
      if (candidate.observed_at_ms === current.observed_at_ms) {
        if (sameEntry(current, candidate)) return "unchanged";
        return fail("observation_conflict");
      }
      if (candidate.content_revision === current.content_revision &&
        (candidate.discovery_cursor < current.discovery_cursor ||
          candidate.last_parsed_offset < current.last_parsed_offset ||
          candidate.last_normalized_event_index < current.last_normalized_event_index ||
          (current.completeness === "complete" && candidate.completeness === "partial"))) {
        return fail("progress_regression");
      }
    }
    database.prepare(`
      INSERT INTO source_catalog(${COLUMNS}) VALUES (${PARAMETERS})
      ON CONFLICT(source_identity) DO UPDATE SET ${UPDATE}
    `).run(candidate as unknown as Record<string, unknown>);
    return current === undefined ? "inserted" : "updated";
  });
  return write.immediate();
}

export function hasSourceContentChanged(
  previous: unknown | undefined,
  candidate: unknown,
): boolean {
  const next = validateSourceCatalogEntry(candidate);
  if (previous === undefined) return true;
  const current = validateSourceCatalogEntry(previous);
  if (current.completeness === "partial" || next.completeness === "partial") return true;
  return CONTENT_FIELDS.some((field) => current[field] !== next[field]);
}
