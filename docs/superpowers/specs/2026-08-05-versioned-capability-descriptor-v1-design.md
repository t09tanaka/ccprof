# Versioned Capability Descriptor v1 Design

**Date:** 2026-08-05
**Status:** Approved for implementation

## Goal

Publish a neutral Capability Descriptor v1 as a packaged JSON Schema Draft
2020-12 contract. The descriptor represents namespaced, versioned capability
claims with requirement, support state, evidence, provenance, and timestamp
precision metadata. It does not change `Session.capabilities`, source adapter
contracts, or rule gating.

## Chosen publication path

Add `schemas/capability-descriptor-v1.schema.json`. The existing npm `files`
allowlist publishes the whole `schemas` directory, which is already the public
path used by the configuration and organization-policy schemas. Consumers can
load the artifact from:

```text
node_modules/ccprof/schemas/capability-descriptor-v1.schema.json
```

The schema has this stable identifier:

```text
https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/capability-descriptor-v1.schema.json
```

This PR does not add another CLI schema target. That avoids overlapping with
the concurrent Trace Envelope work in `src/cli.ts`, the installed-package
workflow, and schema command tests while reusing the established npm schema
publication path.

## Descriptor contract

The root object is closed and requires:

- `$schema`, fixed to the packaged schema identifier;
- `schema_version`, fixed to integer `1`;
- `descriptor_version`, fixed to SemVer `1.0.0`;
- `undeclared_capability_state`, fixed to `unknown`;
- a non-empty `capabilities` array.

Requiring `undeclared_capability_state: "unknown"` makes the fail-closed wire
contract machine-readable. A consumer must not infer support from an omitted
capability. The existing compatibility behavior where a legacy
`Session.capabilities === undefined` means all six capabilities remains
unchanged and is explicitly documented as a runtime-only legacy exception.

Each closed capability entry requires:

- `id`: a DNS-namespaced identifier such as
  `ccprof.dev/capabilities/tool_timestamps`;
- optional `legacy_id`: a bounded legacy token used by the canonical fixture
  to preserve every current `SessionCapability` literal exactly;
- exactly one of an exact SemVer `version` or a bounded SemVer
  `version_range`;
- `requirement`: `required` or `optional`;
- `state`: `supported_exact`, `supported_estimated`, `supported_partial`,
  `unsupported`, or `unknown`;
- closed `evidence` with `quality` and `provenance`;
- `timestamp_precision`: `nanosecond`, `microsecond`, `millisecond`,
  `second`, `unknown`, or `not_applicable`.

The capability ID grammar is intentionally open to third-party namespaces; it
is not an enum of the six built-in values. No shared identifier definition
exists on current `main`, so this schema owns the grammar locally. If a Trace
Envelope identifier contract lands before push, the branch will rebase and
reuse it only when the grammars are semantically identical.

## Evidence and contradiction rules

`evidence.quality` is one of `exact`, `estimated`, `partial`, `unknown`, or
`none`. `evidence.provenance` is one of `producer_declared`,
`adapter_declared`, `observed`, `derived`, or `unknown`.

Draft 2020-12 `if`/`then` constraints reject contradictory claims:

- `supported_exact` requires exact evidence with known provenance;
- `supported_estimated` requires estimated evidence with known provenance;
- `supported_partial` requires partial or unknown evidence with known
  provenance. Unknown evidence is the conservative projection for the legacy
  binary capability declaration, which carries no exact/estimated quality;
- `unsupported` requires `none` quality, known provenance, and
  `not_applicable` timestamp precision;
- `unknown` requires unknown quality, provenance, and timestamp precision.

Evidence is required for every supported state. Requirement and support state
are independent: a required capability may be unsupported, allowing a
negotiator to report the incompatibility rather than making the document
invalid.

## Canonical legacy fixture

`test/fixtures/protocol/capability-descriptor-v1.json` contains exactly these
six code-unit-sorted legacy IDs:

```text
approvals
branch_rows
edit_fragments
sidechains
token_usage
tool_timestamps
```

Each maps bijectively to `ccprof.dev/capabilities/<legacy_id>` and keeps the
literal in `legacy_id`. All are `optional`, matching the current built-in
source registry's empty required-capability lists. Their conservative state is
`supported_partial` with `quality: unknown` and
`provenance: adapter_declared`; the legacy boolean cannot establish exactness,
estimation method, completeness, or timestamp precision. Only
`tool_timestamps` uses `timestamp_precision: unknown`; non-timestamp
capabilities use `not_applicable`.

The fixture is a lossless projection example, not a replacement for the
Claude or Codex runtime contracts and not a claim that all adapters provide all
six capabilities.

## Validation and TDD

The existing repository has no Draft 2020-12 validator. Add `ajv@8.17.1` as a
dev dependency only and compile the real published schema in the Node test
suite. No production runtime dependency or hand-written validator is added.

Tests first establish RED because the schema and fixture do not exist. GREEN
then validates the canonical fixture and rejects:

- root and nested unknown fields;
- wrong schema and descriptor versions;
- malformed namespaced IDs, exact SemVer, and SemVer ranges;
- unknown enum values;
- exact version plus range together, or neither one;
- unsupported or unknown states carrying supported evidence;
- supported states missing evidence;
- duplicate IDs in the canonical fixture through an explicit fixture
  uniqueness assertion.

JSON Schema `uniqueItems` prevents byte-identical duplicate entries but cannot
enforce uniqueness projected only by `id`. This PR does not add a custom
validator for that cross-item invariant. The canonical fixture test proves its
own IDs and legacy IDs are unique and sorted.

## Edge cases and cautions

1. `$schema`, `schema_version`, descriptor version, capability version, and
   capability version range are separate concepts and must not be conflated.
2. Exact version and range are mutually exclusive and one is mandatory.
3. Every object layer is closed; arbitrary evidence or extension fields fail.
4. Undeclared means `unknown`, never supported, in this public contract.
5. Legacy `token_usage` cannot be upgraded to exact or estimated without new
   evidence; the fixture stays conservative.
6. Requirement does not imply support, and unsupported required capabilities
   remain representable.
7. Schema validation handles expressible contradictions; no runtime migration,
   field-level trace provenance, timestamp uncertainty model, or negotiation
   engine is introduced.
8. Runtime `Session.capabilities`, rule gating, Report v2/v3, source adapters,
   Store data, and existing schemas remain byte-for-byte behaviorally
   unchanged.
9. Before push, fetch/rebase current `origin/main` and reuse a compatible
   identifier grammar if the concurrent Trace Envelope PR has landed.

## Explicitly out of scope

- Replacing closed source unions or the current six-value runtime union.
- Adapter registration, capability negotiation, or process isolation.
- Out-of-process runtimes, queues, locks, leases, migrations, or backfills.
- Report schema changes or embedding descriptors into Report v3.
- Changing `Session.capabilities === undefined` compatibility semantics.
- A general schema registry, new CLI target, or production validator API.

## Scope limit

The implementation changes eight files: this design, its plan, one schema,
one fixture, one test, README, `package.json`, and `package-lock.json`. It adds
no production TypeScript and stays below the ten-file and 300-line production
implementation thresholds.
