# Built-in Rule Evidence Schemas Design

**Date:** 2026-08-05
**Status:** Approved for implementation

## Goal

Publish the evidence contracts already declared by the built-in R001-R008 Rule
Manifest as real JSON Schema Draft 2020-12 resources in the npm package. The
change is contract publication only: it does not alter rule detection,
thresholds, severity, Report v3, privacy scopes, or external-rule execution.

The source audit identifies the exact gap: every manifest row has an
`evidence_schema` URI, but the package contains no resource with that `$id`.
The current manifest and detector payloads on `origin/main` are authoritative;
the audit's older `main@009f561` behavior is not reimplemented.

## Selected approach

Add one packaged schema bundle at
`schemas/builtin-rule-evidence.schema.json`. Its root declares Draft 2020-12,
and its `$defs` contain eight embedded schema resources. Each embedded
resource has a `$id` byte-for-byte equal to the corresponding manifest URI:

```text
ccprof://rules/R001/evidence/v1
ccprof://rules/R002/evidence/v1
ccprof://rules/R003/evidence/v1
ccprof://rules/R004/evidence/v2
ccprof://rules/R005/evidence/v2
ccprof://rules/R006/evidence/v2
ccprof://rules/R007/evidence/v1
ccprof://rules/R008/evidence/v1
```

The bundle reuses the existing npm publication path: `package.json` already
includes the complete `schemas` directory. No CLI target, runtime loader,
schema registry, or production TypeScript is added. A package dry-run test
guards that the bundle remains in the npm artifact.

Separate files per rule were considered and rejected because they duplicate
common definitions and add eight package paths. Generating schemas from
detector source was also rejected: it would require a new generator and would
make the published contract depend on TypeScript implementation structure.

## Contract structure

Every rule resource is a closed object. It requires the shared
`session_refs` and `interval_ids` arrays plus all fields that its detector
always emits. Nested command identities are also closed and require
`repo_relative_cwd`, non-empty `normalized_argv`, and an executor of `shell`
or `native-tool`. Arrays use item types and uniqueness constraints; counters
and millisecond values are bounded to nonnegative safe integers where the
runtime emits integer values.

Rule-specific variants are represented exactly:

- R003 and R008 optionally add the historical PR, duration, and session-ref
  fields as one all-or-none group.
- R004 has generic approval evidence without `canonical_commands` and
  repeated-safe evidence with that required non-empty array.
- R005 omits `resource_domain` only for `investigation_candidate`; the
  `parallel_safe` and `parallel_unsafe` forms require it.
- R006 epoch 2 accepts both currently emitted forms: the direct historical
  aggregate and the cohort-materialized distribution. A closed `oneOf`
  prevents mixing their fields.
- Empty arrays remain valid where the runtime can emit them, including R006
  interval IDs, R007 optional command/tool collections, and R008 failed test
  names.

Because each resource has a different required closed shape, evidence from a
different built-in rule is rejected. Epoch selection is bound to the resource
URI: only the URI declared by the current manifest resolves from the bundle.

## Conformance testing

The focused conformance test loads the bundle with Ajv's Draft 2020-12
implementation and resolves every manifest URI with `getSchema`. It asserts:

1. the bundle and each embedded resource use Draft 2020-12;
2. the manifest URI equals the resolved resource `$id` and all eight built-ins
   resolve exactly once;
3. representative evidence emitted by each current detector validates,
   including both R006 epoch-2 forms and optional historical forms;
4. deleting each required field, changing a representative field type, or
   adding an undeclared field fails closed;
5. validating a fixture against another rule's resource fails; and
6. `npm pack --dry-run --json --ignore-scripts` lists the bundle.

Using detector outputs rather than schema-only handwritten examples makes a
future payload change fail the schema test until the published contract is
updated deliberately. Ajv is a development-only dependency; it is not shipped
as runtime code.

## Scope boundary

This PR does not change rule logic, impact or confidence calculations,
thresholds, severity, `claude_md` scope, Report v3, Store schemas, adapters,
SARIF/NDJSON/OTLP, external rule SDKs, process isolation, migrations,
backfills, queues, cron, outboxes, leases, or locks. No shared TypeScript type,
interface, or function signature changes, so an LSP rename/reference operation
is not required.

