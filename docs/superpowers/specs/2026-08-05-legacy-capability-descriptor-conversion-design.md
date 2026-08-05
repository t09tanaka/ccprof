# Legacy Capability Descriptor Conversion Design

## Context

Capability Descriptor v1 now has a runtime validator, but existing session
sources still describe observations with a closed six-token array. This slice
adds one explicit compatibility conversion boundary. It translates a caller-
supplied legacy array into a complete neutral descriptor without connecting
that descriptor to sessions, sources, or rule applicability yet.

## Scope

The new `src/protocol/legacy-capability-descriptor.ts` module owns:

- the exact legacy six-token vocabulary and deterministic declaration order;
- a content-free validation error for malformed legacy input; and
- `legacyCapabilitiesToDescriptor(value)`, which returns a validated,
  immutable Capability Descriptor v1 snapshot.

This change does not modify `SessionCapability`, `Session`, session-source
contracts, rule gating, source descriptors, package exports, JSON Schemas, or
stored data. In particular, implicit `undefined` compatibility remains a later
session-boundary decision and is rejected by this converter.

## Compatibility identity

The converter emits all six declarations in this fixed order:

1. `approvals`
2. `branch_rows`
3. `edit_fragments`
4. `sidechains`
5. `token_usage`
6. `tool_timestamps`

Each token maps to `ccprof.dev/capabilities/<token>`, preserves the token as
`legacy_id`, declares exact version `1.0.0`, and is optional. These values are
the compatibility identity already published in the canonical Capability
Descriptor v1 fixture; no adapter or vendor identity is introduced.

## Conservative declarations

A present legacy token says only that the compatibility adapter declared some
support. It becomes:

- `state: "supported_partial"`;
- `evidence: { quality: "unknown", provenance: "adapter_declared" }`; and
- `timestamp_precision: "unknown"` only for `tool_timestamps`, otherwise
  `"not_applicable"`.

The unknown evidence quality intentionally avoids claiming that a legacy
boolean token established exact coverage. Non-temporal capabilities cannot
claim timestamp precision.

An absent token is declared explicitly rather than omitted. It becomes:

- `state: "unsupported"`;
- `evidence: { quality: "none", provenance: "adapter_declared" }`; and
- `timestamp_precision: "not_applicable"`.

Consequently, an empty input produces a six-entry all-unsupported descriptor.
Input order never changes output order or bytes after JSON serialization.

## Fail-closed input boundary

The function accepts `unknown` so the runtime boundary, rather than a TypeScript
annotation, validates hostile input. It accepts only an ordinary array whose
prototype is exactly `Array.prototype`, with at most six dense enumerable data
properties and no own properties beyond numeric indexes and `length`.

Proxy detection precedes `Array.isArray` and property inspection. The length
descriptor is checked before collecting all descriptors, bounding inspection
of oversized arrays. Sparse arrays, accessors, symbols, extra properties,
non-enumerable indexes, non-string entries, unknown tokens, duplicates,
subclass or replaced prototypes, proxies, and revoked proxies all fail with
`LegacyCapabilityValidationError`. Its stable code and message contain no
input data.

Frozen caller arrays remain valid because immutability does not change their
logical contents. The implementation retains only validated primitive strings,
builds a fresh descriptor, and passes it through
`validateCapabilityDescriptor`. That runtime kernel reconstructs and deeply
freezes the returned descriptor, declarations, evidence, and capability array.

## Verification

One focused test file covers the exact mapping and semantics, fixed ordering,
all-unsupported conversion, input detachment, deep freezing, runtime/schema
validation, and every malformed/hostile input class above. TDD requires a clean
missing-module RED before production code. Fresh focused and full checks are
delegated to `gpt-5.6-terra` workers.
