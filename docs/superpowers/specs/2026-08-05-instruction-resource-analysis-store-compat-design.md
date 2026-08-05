# Instruction Resource Analysis Store Compatibility Design

## Context

The identity foundation defines `instruction_resource` as the neutral runtime
scope and `claude_md` as the Store v1 token. The current analysis Store accepts
only `claude_md`, so it cannot expose a neutral finding scope without changing
generated analysis identifiers, snapshot identifiers, deterministic digests, or
the authenticated SQLite JSON that existing Store v1 rows use.

This change is limited to the shared finding-scope type and the analysis Store.
It preserves the pre-existing Store v1 wire format while making in-memory
analysis records canonical. Base:
`ca46dbe1e2df380059e2c1d0c47921d717732dda`.

## Goals

- Let the migration-only `Scope` input boundary accept `FindingScope` or the
  exact `LegacyFindingScope` imported from `src/compat/instruction-resource.ts`.
- Return canonical `instruction_resource` findings from `makeAnalysisRecord()`
  and `loadAnalyses()`.
- Make semantically equivalent `claude_md` and `instruction_resource` inputs
  produce the same generated `analysis_id`, snapshot ID, deterministic digest,
  and exact SQLite `record_json`.
- Retain byte-for-byte Store v1 JSON by projecting a canonical scope to
  `claude_md` only for snapshot construction and legacy JSON migration.
- Authenticate raw snapshots before scope normalization and fail malformed raw
  values closed with existing content-free record errors.

## Non-goals

- No Report v2, analyzer, rule, reporter, fingerprint, or `CLAUDE.md` semantic
  changes.
- No Store schema or migration version, no row update/backfill, and no rewrite
  of existing JSON files or SQLite rows.
- No changes to adoption compatibility, package SDKs, or source/capability
  contracts.
- No new table, queue, cron, outbox, lease, lock, retry mechanism, or recovery
  machinery.

## Considered approaches

### 1. Canonical runtime with a Store v1 projection boundary — selected

`makeAnalysisRecord()` snapshots either accepted scope into the canonical
`instruction_resource` runtime value. `prepareAnalysis()` then derives a private
legacy snapshot payload that maps only this canonical scope to `claude_md` with
`projectLegacyFindingScope()`. This preserves every identifier and serialized
byte while making callers observe the neutral value.

### 2. Keep a legacy-or-canonical union throughout Store runtime — rejected

This would keep compatibility branching in every Store consumer and leave new
runtime code able to emit the obsolete token. It also makes the normalization
point and authenticated representation ambiguous.

### 3. Store canonical JSON and migrate existing snapshots — rejected

Changing a snapshot's canonical bytes changes its digest and ID. It needs a
schema/version change and a backfill, which this scoped change forbids.

## Architecture and data flow

`src/core/model.ts` changes only `Scope` so the Store migration boundary may
receive `FindingScope | LegacyFindingScope`; it imports the legacy type rather
than copying `claude_md` outside the compatibility module. Rules and Report v2
producers remain unchanged legacy callers during this migration.

`src/store/analyses.ts` owns the two representations:

- The public `AnalysisRecord` always has canonical findings.
- Private strict raw finding and record shapes recognize the Store v1 scope
  token exactly. Their guards inspect data descriptors and reject proxies,
  accessors, extra shape, unknown strings, case changes, whitespace, and NULs
  without reading user-controlled getters.
- Snapshot preparation clones the canonical record and projects every scope with
  `projectLegacyFindingScope()` before canonical JSON serialization and digest
  calculation. The persisted envelope, generated ID content, snapshot ID, and
  deterministic digest therefore retain Store v1 semantics.

For a generated ID, the Store first derives the canonical in-memory record and
then derives the legacy snapshot representation for every persistence identity.
The same projection is used for an in-memory save and for a legacy JSON import.
No persisted row is modified after insertion.

## Authentication and validation order

SQLite snapshot loading follows this exact sequence:

1. Parse `record_json` as JSON.
2. Require canonical JSON bytes for the parsed envelope.
3. Authenticate the snapshot digest against that unmodified raw envelope.
4. Validate the exact raw Store v1 envelope, record, and legacy finding shapes.
5. Verify execution-column mirrors.
6. Construct a fresh runtime record and normalize `claude_md` to
   `instruction_resource`.

The ordering is deliberate. A raw canonical scope token is invalid on the Store
v1 wire even when it has a valid digest. Conversely, a raw legacy token with a
digest computed over a post-normalization envelope is invalid. No normalization
may happen before authentication and exact raw validation.

Legacy JSON migration uses the same raw validation and projection rules: it
accepts a legacy file without rewriting it, derives the canonical runtime record,
and inserts a Store v1-projected snapshot. It does not add a version marker or
attempt to revisit already migrated rows.

## Invariants and edge cases

- `claude_md` and `instruction_resource` inputs are semantically identical for
  generated IDs, snapshot IDs, deterministic digests, and raw `record_json`.
- Returned and loaded findings are always `instruction_resource`; raw Store v1
  snapshots contain `claude_md`.
- `this_pr` and `separate_issue` retain their exact runtime and wire tokens.
- Exact matching rejects unknown, case-varied, whitespace-padded, and NUL-bearing
  scope values. Raw `instruction_resource` is rejected even with a valid digest.
- Proxy and accessor inputs fail with a fixed, content-free error without
  evaluating a getter; successful normalization does not mutate its input.
- Existing rows and legacy JSON files are read-only from the compatibility path.

## Testing

`test/store.test.ts` adds Store-only coverage for canonical/legacy identifier and
byte equality, canonical runtime loads, legacy raw snapshots, legacy JSON
migration without source-file rewrite, digest-before-normalization ordering, raw
canonical-token rejection, strict malformed-token rejection, hostile object
handling, input immutability, and unchanged `this_pr`/`separate_issue` scopes.
Existing Report v2, rule, fingerprint, and `CLAUDE.md` tests remain untouched;
the Store tests prove only the Store boundary does not alter their shared legacy
paths.
