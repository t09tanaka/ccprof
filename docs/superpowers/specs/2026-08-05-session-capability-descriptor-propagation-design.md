# Session Capability Descriptor Propagation Design

## Context

The validated `SessionSource` contract now always contains both the neutral
Capability Descriptor v1 graph and its six-token legacy projection. Discovered
`Session` values still carry only the legacy projection, so the descriptor is
lost before analysis. This slice propagates the already validated descriptor
onto normalized sessions without changing rule applicability, source/report
identity, storage, or raw parser compatibility.

## Approved boundary

`Session` gains an optional `capability_descriptor` field. Optionality is the
raw compatibility boundary: parsers, direct test fixtures, and other callers
may continue constructing legacy `Session` objects. A new `NormalizedSession`
subtype requires both a frozen `capabilities` array and a
`CapabilityDescriptorV1`.

`SessionSource.discover()` remains `Promise<Session[]>`. Only
`ValidatedSessionSource.discover()` and the internal validated-discovery
helpers narrow their result to `Promise<NormalizedSession[]>`. This exposes the
runtime guarantee without claiming that arbitrary adapters already return
normalized values.

## Semantic impact evidence

Before editing shared types or signatures, non-applying
`ts-rename-helper.planRenameSymbol` probes were run against
`tsconfig.test.json`. All probes reported `canRename: true`:

- `Session`: 215 semantic edits across 32 files;
- `Session.capabilities`: 32 edits across 12 files;
- `SessionSourceContract`: 15 edits across 5 files;
- both declared `capability_descriptor` properties: local declaration edits;
- `SessionSource.discover`: 75 edits across 15 files;
- `ValidatedSessionSource`: 2 edits in its declaration file; and
- `validateSessionSource`: 38 edits across 5 files.

No proposed rename edits were applied. The probes show that keeping the raw
`Session` and `SessionSource` surfaces compatible is necessary. The exposed
tool has no separate diagnostics endpoint, so post-edit TypeScript diagnostics
are obtained from a fresh delegated repository typecheck.

## Session normalization

Validation captures session fields as own enumerable data properties before
using them. `capabilities` retains its existing behavior:

1. omission inherits the normalized source contract's frozen legacy
   projection;
2. an explicit array is validated, sorted, frozen, and required to be a subset
   of that projection; and
3. validated output always contains an explicit detached array.

The normalized session descriptor is always the full normalized contract
descriptor. A narrower per-session legacy array does not synthesize a narrower
descriptor. This preserves neutral declarations and distinguishes the source's
evidence contract from the effective legacy evidence lanes used by current
rules.

When a raw session omits `capability_descriptor`, validation attaches the
contract descriptor directly. When it supplies one, the existing hostile-
input-safe descriptor validator canonicalizes and deeply freezes it, including
sorting declarations by capability ID. The canonical candidate must exactly
equal the normalized contract descriptor in root version fields and every
declaration field, including evidence. Canonical declaration order may differ;
state, version, version range, requirement, timestamp precision, legacy ID,
evidence quality, or evidence provenance may not. A match is replaced by the
contract object, so all normalized sessions may safely share one already
detached, deeply frozen descriptor graph.

## Fail-closed behavior

Malformed or mismatching session descriptors throw the existing fixed,
content-free `SessionSourceValidationError` with code `invalid_capability`.
Proxy, revoked Proxy, accessor, sparse-array, non-ordinary, and nested hostile
values are rejected without invoking user code. An accessor on the outer
session property remains an invalid session shape and therefore retains the
existing `invalid_result` code. Error messages never interpolate rejected
values or trapped error text.

Valid neutral namespaced declarations remain present in the descriptor but are
never projected into `Session.capabilities`, inferred from an adapter ID, or
used by rules in this slice. Revalidating an already validated source remains
valid and yields detached normalized contract/session containers.

## Transformation preservation

Current ordering, analysis-window slicing, and budget-prefix admission clone
sessions with object spread. They therefore preserve the descriptor object by
identity and do not mutate its frozen graph. Focused tests exercise both
window and budget paths. This PR does not change those transformation modules.

## Stable analysis identity

Capability Descriptor metadata is additive evidence metadata, not part of the
legacy analysis identity. `sourceSnapshot()` explicitly removes both
`source_path` and `capability_descriptor` before computing `source_digest` and
`snapshot_id`. A neutral declaration with the same legacy projection therefore
does not change:

- rule coverage or rule session lanes;
- Source Descriptor v1 or current Report v2 sources;
- the `AnalysisRecord`;
- `source_digest`, `snapshot_id`, or deterministic digest.

This omission is deliberate compatibility projection, not accidental object
spread behavior.

## Edge cases and cautions

- Raw `undefined` legacy capabilities retain the all-six interpretation only
  at the pre-validation/direct boundary; validated sessions are explicit.
- An explicit empty legacy subset is valid when the contract permits it.
- A matching descriptor in different declaration order is accepted and
  replaced by the normalized contract object.
- Any neutral declaration, supported state, declaration version, evidence, or
  root version difference fails closed even when the six-token projection is
  unchanged.
- Caller mutation after validation cannot affect normalized sessions.
- Descriptor roots, arrays, declarations, and evidence objects are frozen.
- Unknown namespaced declarations are preserved but do not become legacy
  capabilities.
- No descriptor is synthesized for direct `Session` values that bypass a
  `SessionSource` validation boundary.

## Scope exclusions

This slice does not change rules, reporters, stores, adapters/parsers, combined
source behavior, schemas, adoption/instruction-resource work, source-evidence
cache payloads, capability negotiation, or descriptor-based gating. It does
not add a migration or backfill.

## Verification strategy

Tests are committed before production changes and a fresh `gpt-5.6-terra`
worker must prove the focused RED. Focused GREEN, full `npm run check`, and
locally executable GitHub Actions are also delegated only to fresh terra
workers. Final review is ordered: independent spec compliance first, then an
independent code-quality review of the exact rebased head.
