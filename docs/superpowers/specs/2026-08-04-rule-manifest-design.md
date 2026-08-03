# Versioned Rule Manifest Foundation Design

## Purpose

ccprof currently knows its eight rule IDs and their capability requirements in
separate TypeScript structures. Findings do not identify the rule contract that
produced them, so a future semantic rule change could accidentally share a
recurrence, dismissal, or adoption series with the old behavior. This change
adds one validated Rule Manifest catalog, derives capability requirements from
it, and publishes compatibility metadata without changing Report v2 or Store v2
schema versions.

The source requirements are the enterprise audit at lines 902-958 and the
enterprise hardening program design and plan. This PR implements only the
manifest foundation and compatibility metadata. It does not split R004, change
R004/R005 detection, introduce signed organization policy, add impact/confidence
models, create Report v3, or add a Store catalog.

## Semantic impact evidence

`ts-rename-helper` is not installed. The TypeScript 5.9 LanguageService was
therefore run directly against `tsconfig.test.json` before changing shared
types. It returned no semantic diagnostics and found these references:

- `RuleId`: 34 references across 10 files.
- `Finding`: 67 references across 17 files.
- `ReportV2`: 44 references across 12 files.
- `SessionCapability`: 27 references across 6 files.
- `findingKey`: 27 references across 8 files.
- `RULE_REQUIRED_CAPABILITIES`: 9 references across 3 files.
- `ParsedCliCommand`: 2 references in `src/cli.ts`.
- `CliHandlers`: 18 references across 6 files.
- `SourceDescriptor`: 16 references across 4 files.

The inventory supports an additive `Finding` change, preserving `RuleId`, and a
static `rules` CLI path that does not expand `CliHandlers`.

## Considered approaches

1. **One validated immutable catalog with derived consumers (selected).** One
   module owns the exact contract, validation, lookup, cloning, and ordering.
   Capability requirements, finding metadata, keys, digests, and CLI output
   read it. This removes the current capability-map duplication while staying
   within the existing architecture.
2. **Add independent metadata maps beside the capability map.** This is a
   smaller initial edit, but permits version, epoch, source, and capability
   declarations to drift. It fails the single-source-of-truth requirement.
3. **Introduce a dynamic plugin registry and Store catalog.** This could support
   third-party rules later, but needs lifecycle, persistence, trust, and policy
   decisions explicitly deferred to later waves.

## Exact manifest contract

`RuleManifest` has exactly these fields, in this order:

```ts
interface RuleManifest {
  id: RuleId;
  version: string;
  compatibility_epoch: number;
  required_capabilities: SessionCapability[];
  supported_sources: SourceAdapterId[];
  impact_kind:
    | "critical_path_latency"
    | "resource_cost"
    | "policy_latency"
    | "evidence_only";
  default_mode: "enabled" | "observe_only" | "disabled";
  aggregation_policy: "sum" | "union" | "max" | "never_aggregate";
  evidence_schema: string;
  policy_risk: "low" | "medium" | "high";
}
```

The built-in catalog is ordered by rule ID and declares:

| Rule | Version / epoch | Capabilities | Sources | Impact | Mode | Aggregation | Evidence schema | Risk |
|---|---|---|---|---|---|---|---|---|
| R001 | 1.0.0 / 1 | edit_fragments | claude, codex | critical_path_latency | enabled | union | ccprof://rules/R001/evidence/v1 | medium |
| R002 | 1.0.0 / 1 | none | claude, codex | critical_path_latency | enabled | union | ccprof://rules/R002/evidence/v1 | low |
| R003 | 1.0.0 / 1 | none | claude, codex | critical_path_latency | enabled | union | ccprof://rules/R003/evidence/v1 | low |
| R004 | 1.0.0 / 1 | none | claude, codex | policy_latency | observe_only | never_aggregate | ccprof://rules/R004/evidence/v1 | high |
| R005 | 1.0.0 / 1 | tool_timestamps | claude, codex | resource_cost | enabled | max | ccprof://rules/R005/evidence/v1 | medium |
| R006 | 1.0.0 / 1 | none | claude, codex | resource_cost | enabled | max | ccprof://rules/R006/evidence/v1 | medium |
| R007 | 1.0.0 / 1 | token_usage | claude, codex | critical_path_latency | enabled | max | ccprof://rules/R007/evidence/v1 | low |
| R008 | 1.0.0 / 1 | none | claude, codex | critical_path_latency | enabled | union | ccprof://rules/R008/evidence/v1 | medium |

R004's declaration is observational policy latency; it does not make the
current approval detector policy-aware. R005's `max`/`resource_cost`
declaration reflects its current upper-bound serial-slack contract and does not
assert that calls are actually parallel-safe.

## Registry and validation

The built-in registry is validated at module initialization and held as frozen
entries with frozen arrays. Public list and lookup APIs return deep copies, so
caller mutation cannot alter later analysis or another caller's result.

Validation fails closed with a typed code plus catalog index and field when
applicable. It rejects:

- non-array catalogs, non-object entries, missing fields, and unknown fields;
- duplicate IDs after NFC, trim, and invariant-uppercase normalization;
- non-canonical or unknown rule IDs, a missing R001-R008 entry, and a catalog
  with anything other than the eight built-ins;
- non-stable SemVer, leading zeroes, major version zero, a non-positive or
  unsafe epoch, and a SemVer major that differs from the epoch;
- duplicate, unsorted, or unknown capabilities and source adapter IDs;
- unknown impact, mode, aggregation, or policy-risk values; and
- an evidence schema other than `ccprof://rules/<id>/evidence/v<epoch>`.

Validation normalizes only to detect collisions. Accepted data must already be
canonical; it is never silently repaired.

## Finding and compatibility behavior

`Finding` gains optional `rule_version` and `compatibility_epoch` fields. Their
optionality is solely the legacy-read contract: absence means an epoch-1 legacy
finding. Every finding newly produced by `analyze` is decorated from its
manifest before Store persistence, dismissal projection, and Report v2 output.
Strict and balanced privacy projections retain the two static fields; reports
that lack them keep their old serialized shape.

The stable key preimage remains exactly `rule_id + NUL + normalized_target` for
epoch 1, preserving all current finding keys and therefore existing dismissal
and adoption records. Epochs greater than 1 use
`rule_id + "@" + epoch + NUL + normalized_target`. Version changes inside one
compatibility epoch keep a series; an epoch change creates a different series.
This isolates recurrence, dismissal, and adoption without a Store migration or
backfill.

The canonical manifest array is included in the existing analysis policy
digest. Thus a catalog contract change changes deterministic snapshot identity
even when no finding is emitted.

## Capability source of truth

The manifest owns `required_capabilities`. The existing exported
`RULE_REQUIRED_CAPABILITIES` compatibility surface is derived once from the
validated catalog and frozen. Coverage, applicability, and rule session lanes
continue using their existing APIs, but there is no separately authored map.

## Machine API and CLI

The manifest module exports deterministic list and exact-ID lookup APIs. Both
return copies ordered by rule ID. Lookup rejects an unknown or non-canonical ID
with an actionable error listing the supported IDs.

`ccprof rules list` prints the complete ordered catalog as pretty JSON.
`ccprof rules explain R00x` prints the exact selected manifest as pretty JSON.
Both commands require no repository, Store, transcript, network, or environment
data, so their output is privacy-safe in local and CI contexts. Extra arguments,
unknown actions, and unknown rule IDs are usage errors with exit code 2.

## Edge cases and failure behavior

- Returned catalog objects and nested arrays may be mutated by a caller without
  aliasing the registry.
- IDs that collide only after normalization are rejected as duplicates rather
  than accepted or overwritten.
- SemVer and epoch boundary failures are distinct and actionable.
- A manifest source that is not the current `claude` or `codex` adapter ID is
  rejected; capability names must be from `ALL_SESSION_CAPABILITIES`.
- Legacy Store v2 findings and Report v2 values missing compatibility metadata
  remain readable and serialize without invented fields.
- Epoch changes cannot match an epoch-1 dismissal/adoption key, while the
  current epoch-1 key bytes remain unchanged.
- Catalog order, capability/source array order, CLI JSON, and policy-digest
  input are deterministic.
- Unknown CLI rules fail without reading repository or session data.
- Manifest and compatibility fields contain only fixed public identifiers and
  remain unchanged under strict/balanced privacy projection.

## Testing and scope boundary

One focused test file covers exact catalog values, every validation class,
mutation isolation, derived capabilities, stable key compatibility, finding
decoration, legacy Store/Report behavior, privacy projection, deterministic
digest input, and CLI parsing/rendering/errors. Existing focused tests plus the
repository's local Actions equivalents guard integration.

The implementation is limited to ten changed files and fewer than 300 added
production lines. Report v3, Store catalogs/migrations, signed policy,
ImpactEstimate/FindingConfidence, R004 splitting/gating, and R005 semantic
changes remain follow-up work.
