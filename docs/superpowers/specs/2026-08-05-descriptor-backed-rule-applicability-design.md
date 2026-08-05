# Descriptor-Backed Rule Applicability Design

## Context

Rule manifests currently publish a `supported_sources` allow-list containing
the built-in adapter IDs `claude` and `codex`. Runtime applicability does not
actually consult that field: it treats a missing per-session legacy capability
array as full support and otherwise checks only the array. The manifest field
therefore advertises adapter admission as if it were an evidence guarantee,
while the runtime can accept required evidence without consulting the
validated Capability Descriptor v1 carried by a normalized session.

This change makes evidence, rather than producer identity, the only basis for
rule applicability and branch-row use. It removes `supported_sources` from the
manifest catalog and its API/CLI projections, requires source-wide descriptor
support and the per-session legacy subset to agree, and replaces the Claude
adapter branch with the neutral `branch_rows` capability.

## Architecture

The existing boundaries remain intact:

- `src/rules/manifest.ts` owns the closed R001-R008 rule catalog and its
  validator. It stops importing source adapter IDs and no longer accepts,
  stores, clones, freezes, or emits `supported_sources`.
- `src/rules/capabilities.ts` owns the applicability predicate. A required
  legacy capability is mapped to its namespaced descriptor ID
  `ccprof.dev/capabilities/<legacy-token>` at Capability Descriptor v1 version
  `1.0.0`. The predicate requires both descriptor support and membership in
  the session's explicit legacy subset.
- `src/core/analyze.ts` keeps the existing branch-transition scan and boundary
  checks, but candidates come only from sessions satisfying `branch_rows`
  through the same descriptor-backed predicate. No adapter ID is consulted.

No new abstraction or admission layer is introduced. The implementation
reuses the protocol's hostile-input-safe `supportsCapability` function, whose
validation admits `supported_exact`, `supported_estimated`, and
`supported_partial` only when the complete descriptor and declaration/evidence
tuple are valid.

## Data flow

For a rule with required capabilities, each normalized `Session` follows this
path:

1. Read the rule's legacy requirements from the manifest-derived
   `RULE_REQUIRED_CAPABILITIES` map.
2. For every requirement, require an explicit `session.capabilities` array
   containing that token.
3. Require `session.capability_descriptor` and query it for the corresponding
   namespaced capability at version `1.0.0`.
4. Let `supportsCapability` revalidate the whole descriptor and declaration.
   A valid exact, estimated, or partial supported state returns true;
   undeclared, unknown, unsupported, wrong-version, or invalid input returns
   false.
5. A session is eligible only if all requirements pass both gates. Coverage is
   computed from eligible sessions as before.

Rules with an empty requirement list short-circuit to applicable. This keeps
history-only and evidence-independent rules available even when a session has
no descriptor or legacy subset.

The same predicate gates branch transitions with the `branch_rows` token.
Once a session passes that gate, the existing event checks still require a
valid timestamp, head-branch equality, a positive `branch_epoch`, analysis-end
containment, commit-anchor containment, and conservative earliest-event
ordering.

## Fail-closed semantics and locked edge cases

Descriptor support and the per-session legacy subset form an intersection,
not alternatives. Descriptor-only support is false, and legacy-subset-only
support is false. For a rule that requires evidence, each of the following is
inapplicable:

- absent descriptor;
- absent legacy subset;
- absent or undeclared descriptor capability;
- missing legacy token;
- `unknown` or `unsupported` declaration state;
- wrong capability version or range-only mismatch; and
- any invalid descriptor root, declaration, evidence, provenance, quality, or
  state/quality tuple.

All three supported states pass only when the entire descriptor validates.
This deliberately preserves the built-in legacy projection
`supported_partial` plus evidence quality `unknown` and known provenance
`adapter_declared`. Exact and estimated declarations retain their protocol
constraints. Required-empty rules remain applicable, and empty-session
coverage remains finite full coverage with completeness `1`.

Coverage's public `missing_capabilities` field remains the exact legacy
six-token vocabulary. Namespaced descriptor IDs never enter Report v2.

Branch gating is source-neutral. A normalized session whose source is a valid
namespaced dummy producer can establish a transition when it has both
`branch_rows` in the session subset and valid namespaced descriptor evidence.
A Claude session without either side of that capability intersection cannot.
This does not admit an external `SessionSource`; it only removes an adapter-ID
condition from already normalized `Session` values.

The existing branch, epoch, time, earliest-event, and commit-anchor boundaries
are unchanged.

## Compatibility

The RuleManifest shape changes intentionally: `supported_sources` disappears
from `RuleManifest`, the built-in catalog, `listRuleManifests`, `ruleManifest`,
the report policy's `rule_manifest`, and `ccprof rules list/explain` JSON. The
validator's closed field set makes an old object containing
`supported_sources` fail with `unknown_field`; it is not silently ignored.

Report v2 schemas and `missing_capabilities` bytes are unchanged. No Store
payload, analysis record, report bytes, digest, fingerprint, audit identity,
or source descriptor is changed. The manifest policy digest may naturally
reflect the intentionally changed manifest object, but no digest algorithm or
stored identity format changes.

Legacy direct session fixtures that omit descriptor metadata no longer qualify
for rules requiring evidence. Tests that mean to model normalized evidence
must provide both forms. Fixtures for requirement-empty rules need no change.

## Exact scope

Production changes are limited to:

- `src/rules/manifest.ts` for manifest field removal;
- `src/rules/capabilities.ts` for descriptor-backed intersection semantics;
- `src/core/analyze.ts` for neutral `branch_rows` gating.

Regression changes are limited to:

- `test/rule-manifest.cases.ts`;
- `test/capability-coverage.test.ts`;
- `test/model.test.ts`;
- `test/analysis-window.test.ts`; and
- `test/session-source-capability-descriptor.test.ts`.

Together with this design and its implementation plan, that is the complete
ten-file change set. Production changes remain below 300 changed lines.

## Non-goals

This work does not modify `session-source.ts`, `source-descriptor.ts`, report
schemas, Store code, protocol/package SDK code, parser adapters, migrations,
backfills, tables, queues, cron jobs, locks, admission registries, descriptor
normalization, or delivery guarantees. It does not add external
`SessionSource` admission or rescue historical sessions lacking descriptors.

## Test strategy

The work proceeds in three strict red/green cycles, with tests edited before
their production files:

1. Manifest tests remove the field from exact API/catalog/CLI output and prove
   that old-shaped input is rejected as an unknown field.
2. Applicability tests cover both halves of the intersection, missing and
   invalid evidence, every supported state, legacy partial/unknown evidence,
   required-empty rules, empty-session coverage, stable legacy missing tokens,
   order independence, and report/analysis lane behavior.
3. Branch-transition tests prove neutral dummy support, Claude denial without
   capability evidence, and preservation of all existing transition
   boundaries.

Every verification command is delegated to a fresh `gpt-5.6-terra` worker.
This editing agent does not run tests, lint, typecheck, builds, or local GitHub
Actions. A genuine focused RED must be reported before this agent changes the
corresponding production behavior; fresh workers then report focused GREEN and
the final full `npm run check` result.
