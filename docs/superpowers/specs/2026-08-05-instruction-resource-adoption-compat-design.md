# Instruction Resource Adoption Compatibility Design

## Context

The identity foundation merged in PR #86 defines neutral runtime identities
`instruction_resource` and `instruction_resource_edit`, plus explicit mappings to
the existing `claude_md` and `claude_md_edit` wire tokens. Adoption detection,
Store records, finding fingerprints, and Stats still use the legacy identities.

This change connects only the adoption runtime and its existing Store and Stats
boundaries. It intentionally leaves the shared Finding model, analysis Store,
Report v2, schemas, rule producers, and source/capability contracts unchanged.

Base: `origin/main@71d958135c86f3e9c877c34b74b8a5ea470a7527`.

## Goals

- Make in-memory adoption records use `instruction_resource` and
  `instruction_resource_edit`.
- Accept a legacy or canonical finding scope at the adoption detector boundary,
  normalize immediately, and route the neutral resource internally.
- Keep the only concrete instruction-resource detector fixed to `CLAUDE.md`, with
  its existing Git command, keyword matching, timestamps, oldest-match selection,
  error, and truncation semantics.
- Preserve every existing finding fingerprint by hashing the explicit legacy scope
  projection.
- Preserve legacy JSON and SQLite adoption bytes by authenticating the legacy wire
  record before normalization and projecting canonical records before writes.
- Preserve Stats JSON and TTY method tokens through an explicit display projection.
- Reject malformed identity tokens at each boundary with fixed, content-free errors.

## Non-goals

- No edit to `src/core/model.ts`, `src/store/analyses.ts`, Report v2 renderers,
  schemas, source/session/capability files, or rule producers.
- No database schema change, migration version, update, backfill, or rewrite of an
  existing adoption row.
- No support claim for `AGENTS.md`, arbitrary resource paths, resource discovery,
  precedence, or multiple instruction resources.
- No queue, cron, outbox, lock, retry framework, or adjacent Store hardening.

## Considered approaches

### 1. Canonical runtime with explicit legacy Store and display projections — selected

Adoption candidates normalize at entry, records remain canonical in memory, and
legacy identities exist only in Store and Stats projections. This makes the neutral
identity observable to core consumers while preserving existing durable and public
bytes.

### 2. Carry a legacy-or-canonical union throughout runtime — rejected

This would move compatibility ambiguity into every consumer and allow new code to
continue branching on `claude_md`. It would also make it unclear which identity is
valid at serialization boundaries.

### 3. Rewrite stored rows to canonical identities — rejected

Changing durable bytes requires a migration and backfill, invalidates existing
record authentication expectations, and is explicitly outside this audit PR.

## Runtime model

`AdoptionRecord.scope` uses `FindingScope` and `AdoptionRecord.method` uses the
canonical `AdoptionMethod` from the identity foundation. The Store module re-exports
`AdoptionMethod` so existing consumers do not need an unrelated import edit.

`AdoptionCandidateFinding.scope` accepts the current legacy Finding scope or the
canonical scope because the current analyzer still produces legacy Findings. Both
`detectability` and record construction call `normalizeFindingScopeIdentity`
immediately. The detectability result is `instruction_resource`, `target_file`, or
`undetectable`; no internal result is named `claude_md`.

The instruction-resource detector reads the frozen
`CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY` descriptor for its exact path and
canonical method. The implementation does not accept a configurable path. Git log
formatting, added-line extraction, suggestion keyword rules, strict post-recorded
timestamp comparison, deterministic oldest qualifying commit, and partial-output
handling remain unchanged.

## Fingerprint compatibility

`findingFingerprint` first normalizes its supplied scope and then calls
`projectLegacyFindingScope`. Its SHA-256 input therefore remains:

```text
legacy_scope NUL rule_id NUL target_or_empty NUL normalized_suggestion
```

`claude_md` and `instruction_resource` consequently produce the same digest. The
projection is explicit; no conditional duplicate hashing implementation is added.
Malformed scopes fail through the identity foundation's fixed content-free error.

## Store boundary and authentication order

The Store defines a private legacy wire record whose scope and method use
`LegacyFindingScope` and `LegacyAdoptionMethod`. Raw legacy JSON and SQLite data are
handled in this exact order:

1. parse JSON without normalization;
2. validate the raw record shape and exact legacy identity tokens;
3. require `canonicalJson(raw) === record_json` for a SQLite row;
4. require the raw finding key and detected timestamp to match their row columns;
5. only then normalize scope and method into a canonical `AdoptionRecord`.

The order prevents a canonical token or non-canonical byte sequence from becoming a
valid row merely because normalization would map it to a supported runtime value.
The legacy JSON importer validates and deduplicates raw records, writes their legacy
canonical JSON unchanged, and lets the normal SQLite reader perform the authenticated
normalization.

`saveAdoptions` accepts canonical runtime records. Before opening SQLite, it validates
and projects each record to a private legacy record using
`projectLegacyFindingScope` and `projectLegacyAdoptionMethod`. Unknown, differently
cased, whitespace-padded, NUL-bearing, or already-legacy identities fail closed.
The existing catch boundary returns `adoption_write_failed`; no input content is
included and no row is inserted. Dedupe remains first-record-wins by finding key.

## Stats projection

Aggregation consumes canonical `AdoptionRecord` values and produces canonical
`StatsAdoption` values. `renderStatsJson` projects each method to its legacy identity
while constructing the serialized copy. The TTY adoption line projects the method at
formatting time. Neither renderer mutates the supplied report.

This preserves existing JSON and terminal output (`claude_md_edit`) while keeping
the in-memory report neutral. Privacy projection continues to operate on the
canonical report and the final renderer continues to own wire compatibility.

## Edge cases and errors

- Identity matching is exact: case variants, leading/trailing whitespace, embedded
  NUL, unknown strings, and canonical tokens on the legacy Store wire are rejected.
- Passing `claude_md` or `claude_md_edit` directly to canonical-only projectors is
  rejected by the existing fixed validation errors.
- A raw row is never normalized before byte authentication or column mirror checks.
- Invalid save input is rejected before any insert and yields the existing
  `adoption_write_failed` warning code.
- Duplicate inputs and existing rows keep the first record for each finding key.
- Target-file adoption behavior and tokens are unchanged.
- The fixed `CLAUDE.md` detector does not imply support for other instruction files.

## Testing

Tests cover:

- exact fingerprint identity for legacy and canonical scopes;
- canonical detector routing and canonical records from both legacy and canonical
  candidates, with unchanged `CLAUDE.md` evidence and oldest-commit semantics;
- a legacy JSON/SQLite fixture whose canonical raw bytes remain identical while the
  loaded record is canonical;
- canonical save input producing exact legacy `record_json` bytes;
- authentication before normalization, row-mirror validation, canonical wire-token
  rejection, and malformed token rejection;
- invalid save input returning `adoption_write_failed` without a row;
- unchanged first-record-wins behavior;
- canonical Stats aggregation with legacy JSON and TTY method output.

## Risks and controls

- Normalizing before authentication could accept altered bytes. The raw parser and
  normalization functions are separate and called in a fixed reviewed order.
- A renderer could leak the canonical token into Report v2-era output. Focused JSON
  and TTY assertions pin the legacy projection.
- A detector rename could broaden path support accidentally. The frozen compatibility
  descriptor supplies the one fixed path and tests reject any implied alternative.
- Existing analyzer callers still provide `Scope`. The candidate boundary keeps that
  input compatible while returning only canonical records.
