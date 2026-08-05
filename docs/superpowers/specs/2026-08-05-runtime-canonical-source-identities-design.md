# Runtime Canonical Source Identities Design

## Scope

Move the validated `SessionSource` boundary to canonical built-in adapter IDs:

- `ccprof.dev/adapters/claude`
- `ccprof.dev/adapters/codex`

Raw built-in source contracts and direct `discover()` results remain the legacy
`claude` and `codex` shapes. Only `validateSessionSource()` and the runtime data
behind that boundary use canonical IDs. This change does not open third-party
adapters, change source kinds, connect capability descriptors to rules, migrate
stored data, or modify schemas.

## Boundary normalization

Contract adapter IDs accept either the legacy or canonical spelling for the two
built-ins. The validated contract always exposes the canonical spelling. A
discovered session similarly accepts legacy or canonical spelling and is
returned with the canonical spelling when it denotes the same built-in as the
contract.

The accepted combinations are legacy contract plus legacy result, legacy
contract plus canonical result, canonical contract plus legacy result, and
canonical contract plus canonical result. Claude/Codex mismatches fail with
`adapter_mismatch` regardless of spelling.
Unknown unnamespaced contract IDs and third-party namespaced contract IDs fail
with `unknown_adapter`; invalid or mismatching result IDs fail with
`adapter_mismatch`. Identity parser details and input content never appear in
the existing stable validation messages.

## Compatibility projections

Event Identity v1 and Source Descriptor v1 remain legacy wire contracts. An
Event Identity derived from either a legacy or canonical built-in `Session`
projects its adapter ID to `claude` or `codex` before encoding. A supplied event
identity may spell a built-in either way, but validation compares canonical
meaning and snapshots the legacy v1 spelling. Source Descriptor derivation uses
the legacy registry entry before calculating `source_instance_id` and
`canonical_fingerprint`, so legacy and canonical sessions produce byte-identical
descriptors.

Analysis lane keys that participate in finding/adoption identity also use the
Event Identity v1 projection. The persisted `analysis-source-v1` snapshot also
projects `Session.source` to its legacy v1 spelling before calculating
`source_digest`, `snapshot_id`, and `deterministic_digest`. Source Descriptor v1
validation remains a strict legacy-wire reader: a presented canonical
`adapter_id` is rejected, while derivation from a canonical runtime Session is
projected to the legacy descriptor. No Report v2, Store, cache, catalog,
parser, fixture, SQLite schema, or fingerprint bytes change.

## Runtime transition branches

Temporary built-in-specific branches that remain in core recognize both legacy
and canonical spellings through one compatibility helper. This applies only to
Claude branch-transition evidence, hook attribution, verified timeline tails,
and Claude line-number semantics during budget truncation. Direct legacy
`Session` callers continue to behave as before while validated sessions use the
canonical spelling.

## Edge cases and cautions

- `SourceAdapterId` is an open string type, so TypeScript cannot catch a missed
  literal comparison. Semantic rename probes and focused branch tests enumerate
  the transition sites.
- Contract normalization is fail-closed: a syntactically valid third-party
  namespace is still unsupported because this PR adds no adapter metadata or
  capability negotiation.
- Raw `ClaudeSessionSource` and `CodexSessionSource` contracts and direct
  discovery bytes must remain legacy.
- A supplied Event Identity must match source instance, session, agent, source
  index, and optional tool-use identity after adapter normalization.
- Canonicalization must not change descriptor ordering, report source shapes,
  finding keys, adoption lookup identity, cache keys, or stored rows.
- There is no backfill or migration. Existing legacy data remains authoritative
  at serialization boundaries.

## Verification

Focused tests cover raw-versus-validated contracts, all four supported mixed
representations, mismatch/error stability, supplied Event Identity projection,
Event Identity encoding equality, Source Descriptor equality and strict v1
validation, persisted audit identity equality, and the four Claude transition
branches. The focused test must fail before production code is edited and pass
afterward. A fresh verifier then runs the repository's full `npm run check`
command.

## Semantic impact record

Before editing, non-applying TypeScript rename plans were requested for
`Session.source`, `SessionSourceContract.adapter_id`, `validateSessionSource`,
`eventIdentity`, and `deriveSourceDescriptor`; all returned `canRename: true`.
The `Session.source` plan found production references in parsers, analysis,
timeline, event identity, descriptor, hooks, and the source boundary, plus test
constructors. The other plans confirmed the boundary and compatibility call
sites described above. No LSP diagnostics tool is available in this workspace,
so no diagnostics operation can be recorded; the semantic rename plans are not
applied.
