# Capability Descriptor Runtime Design

## Context

`schemas/capability-descriptor-v1.schema.json` publishes ccprof's neutral,
versioned capability declaration, but runtime code still has only the six
legacy string tokens. This slice adds a dependency-free TypeScript boundary
that can validate the published descriptor and answer conservative support
queries. It does not connect descriptors to sessions or rule gating yet.

## Scope

The new `src/protocol/capability-descriptor.ts` module owns:

- TypeScript types and stable constants for Capability Descriptor v1.
- A content-free validator that returns a detached, deeply frozen snapshot.
- A conservative capability support query keyed only by namespaced `id`.

This change does not modify the JSON Schema, session or source models, rule
gating, source descriptors, package exports, or existing legacy behavior.
`Session.capabilities === undefined` therefore remains fail-open until the
next boundary-integration slice. External package extraction is also separate.

## Runtime contract

The public constants reproduce the schema identifier and fixed versions:

```ts
CAPABILITY_DESCRIPTOR_SCHEMA_ID
CAPABILITY_DESCRIPTOR_SCHEMA_VERSION // 1
CAPABILITY_DESCRIPTOR_VERSION // "1.0.0"
CAPABILITY_UNDECLARED_STATE // "unknown"
```

`CapabilityDescriptorV1`, `CapabilityDeclarationV1`, and
`CapabilityEvidenceV1` mirror the schema exactly. The declaration represents
the version choice as an exclusive union: one exact `version` or one
`version_range`, never both or neither.

`validateCapabilityDescriptor(value)` accepts `unknown`. It verifies all root,
capability, and evidence constraints published by the schema, plus duplicate
namespaced capability IDs. JSON Schema `uniqueItems` only rejects identical
objects, so the duplicate-ID check is an intentional runtime strengthening.

The validator accepts only ordinary data objects and dense ordinary arrays.
It rejects proxies (including revoked proxies), arrays where objects are
required, non-plain prototypes, accessors, symbols, non-enumerable data fields,
holes, unknown fields, and missing fields. Proxy detection happens before
property inspection, and property descriptors are read before values, so
rejected getters are never invoked. A successful result is reconstructed from
validated primitive values and deeply frozen; no caller-owned object or array
is retained.

Validation failures throw `CapabilityDescriptorValidationError`. Its stable
code is `invalid_descriptor`, and its message contains only that code.
Rejected input is never interpolated.

## Schema parity and evidence consistency

The runtime uses the exact schema grammars and maximum lengths for capability
IDs, legacy IDs, SemVer strings, and SemVer ranges. Regexes use an absolute end
assertion rather than JavaScript `$`, preventing trailing LF, CR, U+2028, and
U+2029 from being accepted.

State and evidence combinations match the schema:

- `supported_exact`: exact quality and known provenance.
- `supported_estimated`: estimated quality and known provenance.
- `supported_partial`: partial or unknown quality and known provenance.
- `unsupported`: none quality, known provenance, and `not_applicable`
  timestamp precision.
- `unknown`: unknown quality, unknown provenance, and `unknown` timestamp
  precision.

Known provenance is `producer_declared`, `adapter_declared`, `observed`, or
`derived`. Supported states never pass with unknown provenance.

## Support query

`supportsCapability(descriptor, query)` returns a boolean. A query contains a
namespaced `id` and exactly one of `version` or `version_range`. It returns true
only when:

1. a declaration's namespaced `id` exactly matches the query `id`;
2. its state is `supported_exact`, `supported_estimated`, or
   `supported_partial`; and
3. its declared version contract is exactly the same kind and string value as
   the requested contract.

The query never matches `legacy_id`. Invalid query syntax, undeclared IDs,
unsupported or unknown states, different exact versions, exact-vs-range
mismatches, and non-identical ranges all return false.

This is deliberately a version-contract identity query, not a SemVer range
solver. Schema-valid ranges are accepted and preserved by validation, but
semantic range intersection or containment is not claimed. Requiring identical
range text is the smallest explicit fail-closed contract for this slice.

## Deferred next PR: legacy conversion

The exact six-token legacy-to-namespaced mapping and explicit
`legacyCapabilitiesToDescriptor(array)` boundary are intentionally deferred to
the next PR. That slice will declare all six capabilities deterministically,
distinguish present partial support from absent unsupported capabilities, and
reject implicit or hostile legacy arrays. This runtime-kernel PR neither
accepts legacy capability arrays nor claims to close the session-boundary gap.

## Verification

Focused tests cover the canonical fixture, all five states, malformed and
contradictory values, duplicate IDs, exact/range exclusivity, proxies,
accessors, revoked proxies, line terminators, detached freezing, fail-closed
support lookup, immutability, and prohibition on `legacy_id` matching. The
existing schema test imports the runtime schema constants to catch drift
without changing the schema itself. A fresh full `npm run check` must remain
green.
