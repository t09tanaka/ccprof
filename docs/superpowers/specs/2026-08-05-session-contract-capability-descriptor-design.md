# Session Contract Capability Descriptor Boundary Design

## Context

Capability Descriptor v1 now has a hostile-input-safe runtime validator and an
explicit converter for the six legacy session capability tokens. Session
sources still expose only the legacy array, however, so the runtime cannot yet
accept a neutral descriptor from a source. This slice connects those two
protocol primitives at the `SessionSource` contract-validation boundary while
deliberately leaving `Session` and rule applicability unchanged.

## Approved approach

The source boundary is the smallest compatibility-preserving integration point.
`SessionSourceContract` accepts either the existing `capabilities` property,
the new `capability_descriptor` property, or both. Validation always returns a
separate normalized contract type with both properties required:

- `capability_descriptor` is a detached, deeply frozen, canonicalized
  `CapabilityDescriptorV1`;
- `capabilities` is the sorted, frozen six-token compatibility projection used
  by existing discovery and core code.

Two alternatives were rejected for this slice. A separate source-contract
preprocessor would duplicate the hostile-object inspection already owned by
`session-source.ts`. Changing `Session` and rule gating to carry or consume the
descriptor would combine the next dependency step with this boundary and make
it impossible to prove behavior parity here.

## Semantic impact evidence

Before changing the shared type, `ts-rename-helper.planRenameSymbol` was run
against `tsconfig.test.json` in the fresh worktree without applying edits.
Renaming `SessionSourceContract` was semantically possible and found references
in:

- `src/sources/session-source.ts`;
- `test/analyze-integration.test.ts`;
- `test/capability-coverage.test.ts`; and
- `test/session-source-contract.test.ts`.

A separate semantic probe for `SessionSourceContract.capabilities` found
production references in `src/sources/session-source.ts`,
`src/sources/claude/discover.ts`, and `src/commands/doctor.ts`, plus contract
tests. Those consumers continue to receive a required projection on validated
and built-in contracts. No semantic diagnostic tool is exposed alongside the
rename planner, so fresh TypeScript diagnostics are delegated through the
repository typecheck after implementation.

## Input and normalized types

The input-facing `SessionSourceContract` keeps `adapter_id` and
`adapter_version` required and makes the two capability representations
optional at the TypeScript surface. Runtime validation requires at least one;
the optional typing permits both old implementations and descriptor-only
implementations to satisfy `SessionSource` without an unsafe union assertion.

`NormalizedSessionSourceContract` requires both representations, and
`ValidatedSessionSource` narrows the return type of `validateSessionSource` to
that normalized contract. This makes the runtime guarantee visible without
claiming that arbitrary unvalidated source objects are already normalized.

## Normalization paths

All accepted contracts follow one of three paths:

1. Legacy-only: validate the exact sorted six-token compatibility array, then
   call `legacyCapabilitiesToDescriptor`.
2. Descriptor-only: validate and canonicalize the descriptor, then derive the
   legacy projection from supported namespaced declarations.
3. Dual input: validate both independently and accept only when the declared
   legacy array exactly equals the descriptor-derived projection.

The canonical descriptor is sorted by unique capability `id` after validation
and reconstructed in the schema's fixed root-field order. The first validation
already detaches and freezes every declaration and evidence object; the
canonical reconstruction is validated again, yielding a fully detached and
deeply frozen graph whose serialized form does not depend on declaration input
order.

Unknown non-legacy namespaced declarations remain in the canonical descriptor.
They are not added to the compatibility projection.

## Compatibility projection semantics

Each legacy token maps only to its stable namespaced identity:
`ccprof.dev/capabilities/<legacy-token>`. Projection iterates the fixed
`LEGACY_CAPABILITY_IDS` order and calls `supportsCapability` with exact
descriptor version `1.0.0` for each identity. A declaration projects as present
only when its state/evidence combination passed descriptor validation, its state
is one of the supported states, and its exact version contract matches.

`unsupported`, `unknown`, undeclared, differently versioned, and range-only
declarations do not project as supported. Range negotiation is intentionally
not inferred here because the v1 runtime support query does not claim SemVer
range evaluation. Neither projection nor agreement checks inspect adapter IDs.

## Built-in compatibility

The Claude and Codex constants become descriptor-backed normalized contracts by
converting their existing legacy arrays. Their adapter IDs, versions, legacy
arrays, object identity usage, and discovered-session behavior remain intact.
Claude still declares all six legacy capabilities; Codex still declares only
`edit_fragments` and `tool_timestamps`. Existing `Session.capabilities`, report
output, rule gating, and doctor summaries therefore retain their behavior.

## Fail-closed boundary and edge cases

The existing contract validator continues to inspect only own enumerable data
properties on an ordinary object. Proxy detection happens before reflective
inspection, and accessors are rejected without invocation. The new fields are
handled from captured property descriptors rather than direct property reads.

The following cases fail with the existing stable, content-free
`SessionSourceValidationError` code `invalid_capability` unless the outer
contract shape itself is invalid:

- neither representation is supplied;
- either present property is `undefined` or malformed;
- legacy arrays contain unknown values, duplicates, holes, non-data entries,
  extra keys, or non-canonical ordering;
- descriptors contain unknown fields, duplicate declarations, invalid state /
  evidence combinations, hostile nested values, proxies, revoked proxies, or
  accessors; and
- dual inputs disagree after descriptor support projection.

Outer missing required fields, extra fields, hidden fields, symbols, and
accessors retain their existing `invalid_shape` / `unknown_field` behavior.
No rejected value or trapped error text appears in the stable error.

Additional accepted edge cases are frozen ordinary inputs, canonical
descriptor-only contracts with no supported legacy identity, descriptors with
unsupported or unknown legacy declarations, descriptors with extra neutral
declarations, caller mutation after validation, and validating an already
normalized source again. Every successful path creates a new normalized
contract and does not retain caller-owned arrays or objects.

## Scope boundaries

This PR does not add descriptor fields to `Session`, alter
`Session.capabilities`, change rule gating, open the built-in adapter registry,
change source descriptor/report output, publish package exports or schemas,
modify storage, migrate/backfill data, or add adapter SDK behavior. It also does
not touch the unrelated Windows exact-source-evidence-cache fixture flake.

## Verification

A focused test file covers built-in parity, all three normalization paths,
agreement and mismatch, neutral declaration preservation, unsupported/unknown
projection, hostile inputs without getter/trap evaluation, deterministic
ordering, detachment/deep freezing, caller mutation, and re-validation. Clean
baseline, focused RED/GREEN, full checks, and locally executable GitHub Actions
are run only by fresh `gpt-5.6-terra` validation workers.
