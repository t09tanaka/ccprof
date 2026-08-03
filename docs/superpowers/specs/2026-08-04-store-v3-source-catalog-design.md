# Store v3 Source Catalog Design

**Status:** Approved for implementation under the enterprise-hardening program.

## Goal

Extend the existing repository-scoped Store v2 additively to Store v3 with a
persistent, privacy-bounded `source_catalog`. A populated v2 database must open
as v3 without losing or rewriting any analysis, execution, dismissal, adoption,
or legacy-migration row. A fresh database bootstraps directly to v3.

This PR provides only the durable catalog foundation. Source discovery and
parsers do not use it yet.

## Migration design

The Store has two supported open paths:

- `user_version = 0`: create the complete v3 schema in one `IMMEDIATE`
  transaction, add the v3 schema marker, then set `user_version = 3`.
- `user_version = 2`: in one `IMMEDIATE` transaction, create only
  `source_catalog`, add the v3 schema marker, then set `user_version = 3`.

`user_version = 3` is an idempotent no-op. Version 1, negative versions, and
versions above 3 are rejected before schema configuration or mutation. The
marker is `schema-v3-source-catalog` in the existing
`store_migrations(name, completed_at_ms)` table, making schema state inspectable
without replacing the legacy JSON migration markers already stored there.

The table creation, marker insert, and `user_version` update share a transaction.
An error at any intermediate statement rolls back the table, marker, version,
and leaves all existing v2 rows intact. No rebuild, backfill, or data copy occurs.

## Catalog contract

`SourceCatalogEntry` contains exactly these fields:

```ts
interface SourceCatalogEntry {
  adapter_id: "claude" | "codex";
  adapter_version: "1.0.0";
  source_identity: string; // source-<64 lowercase SHA-256 hex chars>
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
  completeness: "complete" | "partial";
}
```

All numbers are non-negative JavaScript safe integers. Parsed offset cannot
exceed size. Device and inode are both present or both null; the null pair is the
portable representation when Windows or another platform cannot provide stable
file identity. Hash fields use exact `sha256:<64 lowercase hex>` syntax.
Canonical paths and parser versions are non-empty and NUL-free. The table repeats
these invariants as SQLite `CHECK` constraints, including the safe-integer upper
bound.

Catalog rows contain metadata and cryptographic digests only. The exact-key
validator rejects additional properties, so transcript records, prompts, tool
output, tokens, and secret bodies cannot be persisted through this API.
Validation errors use stable, content-free codes and never interpolate rejected
values.

## API and ordering

- `validateSourceCatalogEntry(value)` accepts an unknown value, rejects any
  missing/extra field or invalid invariant, and returns a detached plain object.
- `upsertSourceCatalogEntry(database, value)` performs an atomic upsert and
  returns `inserted`, `updated`, `unchanged`, or `stale`.
- `getSourceCatalogEntry(database, sourceIdentity)` returns a detached validated
  row or `undefined`.
- `listSourceCatalogEntries(database)` returns detached validated rows ordered by
  `source_identity`.
- `hasSourceContentChanged(previous, candidate)` validates both inputs and is
  deterministic. A missing previous row, either row being partial, a changed
  content signal, or a parser/schema change returns `true`.

Observation time is the conflict-ordering key. An older observation never
overwrites a newer one. Replaying the exact current observation is unchanged; a
different observation at the same timestamp is rejected as a conflict; a newer
observation replaces the row. Within the same content revision, discovery cursor,
parsed offset, and normalized event index cannot regress, and complete cannot
regress to partial. A new content revision may reset progress after truncation or
rotation. Replaying the resulting row remains idempotent.

Returned rows never alias caller input, earlier reads, or list results.

## Alternatives considered

1. **Explicit additive v3 migration (selected).** It is the smallest auditable
   change and preserves current Store and legacy JSON behavior.
2. **General ordered migration registry.** Useful after several schema versions,
   but unnecessary abstraction for the single supported v2 predecessor.
3. **Rebuild v2 into a new v3 database.** Rejected because it expands failure
   surface and cannot meet the zero-copy, zero-data-loss requirement as directly.

## Edge cases

- Fresh v0 bootstrap, populated v2 migration, two simultaneous/repeated opens,
  explicit rerun, and existing legacy migration markers.
- Failure after table creation but before marker/version commit, with complete
  rollback and pre-existing row preservation.
- Version 1 downgrade/unknown predecessor and future-version rejection without
  mutation.
- Missing, unknown, symbol, or non-enumerable fields; arrays and exotic objects;
  input/output cloning and mutation after calls.
- Empty/NUL strings, raw-content-shaped extra fields, malformed/uppercase hashes,
  negative/fractional/NaN/infinite/unsafe integers, half-null file identity,
  offsets beyond file size, and Windows paths with null identity.
- Partial observations, stale/equal/newer timestamps, same-revision replay,
  progress regression, revision reset, and deterministic ordering.
- Direct SQL attempts that bypass runtime validation.

## Scope

Out of scope are discovery/parser integration, `AnalysisBudgets`, normalized
history tables, encryption/retention, source CLI commands, a rule-decision ledger,
and repair/backfill of existing data. Legacy JSON migration/read/write behavior is
preserved unchanged.
