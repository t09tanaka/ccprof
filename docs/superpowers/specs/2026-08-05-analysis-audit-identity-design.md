# Analysis Audit Identity Design

**Date:** 2026-08-05
**Status:** Approved for implementation

## Goal

Expose the existing immutable Store snapshot identity as side-car analysis
metadata needed by a future Report v3 producer, without changing AnalysisRecord,
SQLite, Report v2, or any current renderer bytes.

## Scope and compatibility boundary

The change adds `audit_identity` to `AnalysisSaveResult` and `AnalyzeResult`:

```ts
type AnalysisSnapshotEnvelopeIdentity =
  | AnalysisSnapshotIdentity
  | { mode: "content-fallback" };

interface AnalysisAuditIdentity {
  analysis_id: string;
  snapshot_id: string;
  created_at_ms: number;
  deterministic_digest: `sha256:${string}`;
  snapshot_identity: AnalysisSnapshotEnvelopeIdentity;
}
```

It does not add these fields to `AnalysisRecord` because doing so would make the
snapshot hash recursive. It does not change the Store schema or backfill old
data. Report v2 and JSON, TTY, and Markdown renderers remain untouched; current
`--json` output remains byte-compatible Report v2.

The future Report v3 producer may consume the four public analysis fields. The
canonical snapshot identity is internal provenance and must not be copied
wholesale to output: its `repo_id` is the local Store path hash, not Report v3's
logical repository identity. This change does not fabricate logical repository,
build, workspace, or source-coverage values.

## Canonical digest contract

One pure Store helper owns the calculation used both for returned metadata and
SQLite insertion. It first normalizes the record and optional snapshot identity,
then constructs the existing envelope:

```text
{
  schema_version: 1,
  identity: normalized AnalysisSnapshotIdentity | { mode: "content-fallback" },
  payload: AnalysisRecord excluding analysis_id and created_at_ms
}
```

`snapshot_id` is the existing domain-separated digest:

```text
SHA256("ccprof\0analysis-snapshot-v1\0" + canonicalJson(envelope))
```

`canonicalJson` recursively sorts object keys and preserves array order.
`deterministic_digest` is exactly `sha256:${snapshot_id}`; there is no second
hash contract.

The payload includes the normalized unit, summary, complete finding set,
metrics, command costs, read observations, optional analysis budget, and
terminal statistics snapshot. The envelope identity includes the normalized
local Store repository hash, Git OIDs, selector, window, source/config/policy/
history digests. `analysis_id` and `created_at_ms` are excluded because they are
invocation identity and nondeterministic execution time. Store row IDs, the
snapshot table's first-seen timestamp, warnings, advisory text, privacy
projection, and rendered output text are also excluded. Numeric output-budget
counters remain included when present because they are part of the stored
analysis payload.

## Identifier formats

- Generated `analysis_id` stays the existing 64-character lowercase hexadecimal
  digest. Explicit nonempty legacy IDs remain valid and unchanged.
- `snapshot_id` stays the existing 64-character lowercase hexadecimal digest.
- `deterministic_digest` is `sha256:` followed by that same 64-character digest.
- No `ana_` or `snap_` migration is introduced; Report v3 already accepts opaque
  nonempty identifiers.

## Data flow and failure behavior

`saveAnalysis` normalizes input, computes the side-car identity before Store
I/O, and uses the same prepared envelope for insertion. Successful writes,
idempotent replays, immutable execution conflicts, snapshot conflicts, and
ordinary write failures all return the computed identity. Existing warnings
remain the authority for persistence failure; identity presence never claims a
successful write. Validation errors still throw before any result is returned.

Core analysis uses the same helper when `persist:false`, so disabling persistence
does not disable identity calculation or touch the Store. Complete analyses pass
their canonical `AnalysisSnapshotIdentity`. Budget exhaustion before the
required snapshot inputs exist continues to use `{ mode: "content-fallback" }`,
matching current persistence. A future Report v3 producer must treat that mode
as unavailable authoritative provenance rather than inventing missing fields.

## Edge cases and cautions

1. Executions with different `analysis_id` and `created_at_ms` but identical
   normalized snapshot input have the same snapshot and deterministic digest.
2. Explicit-ended windows retain `ended_at_ms`; `analysis_time` windows omit it,
   preserving the current nondeterministic-time exclusion.
3. Snapshot identity hexadecimal values are normalized to lowercase before
   hashing; selectors retain their exact closed canonical shape.
4. A content-fallback snapshot is distinct from every canonical snapshot even
   when their record payloads match.
5. `persist:false` must not create, migrate, or mutate Store files or tables.
6. A failed transaction returns identity plus warning while leaving execution,
   snapshot, and budget rows atomic and unchanged.
7. Hash-collision conflict behavior remains fail-closed; the returned digest is
   the attempted identity, not evidence that the conflicting row was accepted.
8. The digest is a stable, linkable pseudonymous identifier, not a secret,
   authentication token, signature, or MAC. Current renderers do not expose it.
9. Hostile/Proxy-backed record and selector validation remains unchanged and
   must not be weakened by the pure helper extraction.
10. No new table, migration, backfill, queue, lock, recovery mechanism, or
    unrelated refactor is permitted.

## LSP impact audit

The TypeScript Language Service was queried read-only with
`ts-rename-helper.planRenameSymbol` before design approval:

- `AnalysisSaveResult` has production references only at its declaration and
  `saveAnalysis` return signature in `src/store/analyses.ts`.
- `AnalyzeResult` has production references in `src/core/analyze.ts`,
  `src/commands/analyze.ts`, and `src/commands/hook-event.ts`.
- `AnalysisSnapshotIdentity` has production references only in Store and core.
- `AnalysisRecord` is broad: Store, core, dismiss/stats commands and R003/R006/
  R008 rule consumers. Keeping identity side-car avoids that change surface.

No function or shared type rename is performed; the LSP result establishes that
the additive return fields can stay confined to Store and core.

## Acceptance

- Store and analyzer tests prove canonical, fallback, persistence-disabled,
  failure/conflict, idempotent, and budget-partial behavior.
- Existing Store rows contain the same snapshot IDs as returned metadata.
- `renderJsonReport(result.report)` stays Report v2 and contains no audit fields.
- No production file other than `src/store/analyses.ts` and
  `src/core/analyze.ts` changes.
- The PR changes at most seven planned files and fewer than 300 production
  TypeScript lines.
