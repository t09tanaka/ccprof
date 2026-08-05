# Adapter SDK Handshake v1 Design

**Date:** 2026-08-05  
**Status:** Approved for implementation

## Goal and scope

Publish a compatibility-preserving `ccprof/adapter-sdk` npm subpath containing
the TypeScript contract for a JSON-RPC 2.0 adapter handshake. Version 1 covers
three request/response methods in order: `initialize`,
`negotiateCapabilities`, and `shutdown`.

This is a contract-only slice. It adds no adapter host, transport, process,
registry, or runtime wire validator. Existing built-in adapters and ccprof's
model, session, source-descriptor, analysis, and Store paths remain unchanged.

Before designing the re-export surface, semantic LSP probes found these shared
contracts and consumers: `SourceAdapterId` (35 references in 9 files),
`parseSourceAdapterId` (7 in 2), `CapabilityDescriptorV1` (35 in 7),
`CapabilitySupportQuery` (2 in 1), `validateCapabilityDescriptor` (31 in 6),
and `supportsCapability` (14 in 3). The SDK re-exports them without changing
their definitions or signatures.

## JSON-RPC contract

`src/adapter-sdk/protocol.ts` defines readonly JSON-RPC 2.0 request,
notification, success, failure, error, and response shapes. A request has an
ID; a notification cannot have one. Success has `result` and failure has
`error`. A failure may use `id: null` only when the peer cannot recover the
request ID. A success never has a null ID.

`JsonRpcStringId` is `string`. `JsonRpcSafeIntegerId` is represented by
TypeScript's `number`, with the normative invariant
`Number.isSafeInteger(id) === true`; fractions, infinities, NaN, and unsafe
integers are invalid on the wire. `JsonRpcId` is their union. TypeScript cannot
encode the safe-integer predicate, so enforcement belongs to the deferred wire
validator.

The supported protocol tuple is immutable and exact:

```ts
export const ADAPTER_PROTOCOL_VERSIONS = Object.freeze(["1.0.0"] as const);
```

`AdapterRpcMethodMap` has exactly three keys and maps each method to its params
and result. `AdapterRpcParams<M>`, `AdapterRpcResult<M>`,
`AdapterRpcRequest<M>`, and `AdapterRpcResponse<M, ErrorData>` preserve the
method/params/result relationship.

## Lifecycle methods

### `initialize`

```ts
interface AdapterInitializeParams {
  readonly protocol_versions:
    readonly [AdapterProtocolVersion, ...AdapterProtocolVersion[]];
}

interface AdapterInitializeResult {
  readonly protocol_version: AdapterProtocolVersion;
  readonly adapter_id: SourceAdapterId;
  readonly adapter_version: AdapterSemanticVersion;
}
```

`protocol_versions` is a non-empty, ordered preference list. The adapter must
select a value that was offered and that it supports. `adapter_id` must pass
`parseSourceAdapterId`; `adapter_version` must be SemVer. These cross-message
and string-format requirements are normative but are not runtime-validated in
this PR. If no offered version is supported, the adapter returns a JSON-RPC
failure and does not proceed to capability negotiation.

### `negotiateCapabilities`

Params contain separate readonly `required` and `optional` arrays of the
existing `CapabilitySupportQuery`. Both preserve sender order. The result is a
discriminated union and always carries the adapter's existing
`CapabilityDescriptorV1`:

```ts
type AdapterNegotiateCapabilitiesResult =
  | {
      readonly accepted: true;
      readonly capability_descriptor: CapabilityDescriptorV1;
    }
  | {
      readonly accepted: false;
      readonly capability_descriptor: CapabilityDescriptorV1;
      readonly unavailable_required: readonly [
        UnavailableRequiredCapability,
        ...UnavailableRequiredCapability[],
      ];
    };
```

Every unavailable required query is reported in request order with exactly one
reason:

- `unsupported`: an explicit unsupported declaration or a version/version
  range mismatch;
- `unknown`: a matching declaration whose state is `unknown`;
- `undeclared`: no declaration has the requested namespaced ID.

All required queries must satisfy `supportsCapability` for success. Optional
misses never reject negotiation. If the same query is both required and
optional, required semantics win. Duplicate required entries remain ordered
and are reported per occurrence; normalization is not part of this contract.
Malformed queries are wire-validation failures, not capability outcomes.

### `shutdown`

`shutdown` takes a closed empty params object and returns exactly
`{ acknowledged: true }`. The host waits for that response before closing the
transport. Lifecycle ordering and close enforcement are deferred runtime work.

## Public surface and package compatibility

`src/adapter-sdk/index.ts` exports protocol v1 and only these existing shared
symbols:

- `SourceAdapterId` and `parseSourceAdapterId`;
- `CapabilityDescriptorV1` and `CapabilitySupportQuery`;
- `validateCapabilityDescriptor` and `supportsCapability`.

It does not export `SessionSource`, model/session types, source descriptors,
analysis APIs, Store APIs, or built-in adapters.

Adding package `exports` could accidentally close imports that currently work.
The map therefore publishes `./adapter-sdk` while retaining `./dist/*`,
`./schemas/*`, and `./package.json`. It deliberately does not invent a root
export. `npm pack` continues to run `prepack` and build declarations under
`dist/adapter-sdk`.

The package-smoke job installs the tarball globally for the existing CLI
checks and locally into a clean consumer. The consumer runtime-imports
`ccprof/adapter-sdk`, compiles an `.mts` file against the packaged `.d.ts`, and
imports one legacy `ccprof/dist/...` module.

## Edge cases and cautions

1. `0`, negative safe integers, and strings are valid IDs; null is limited to
   an unrecoverable failure response.
2. Notifications cannot be used for lifecycle methods because shutdown must be
   acknowledged and negotiation must return an outcome.
3. An empty offered-version list, selecting a non-offered version, malformed
   adapter IDs, and non-SemVer adapter versions are invalid even though this
   type-only slice cannot validate all of them at runtime.
4. `unknown` and `undeclared` are distinct failure reasons despite the
   descriptor's fail-closed undeclared state.
5. Version mismatch is `unsupported`, not `unknown`.
6. A negotiation failure must contain at least one unavailable required query;
   optional misses alone cannot produce failure.
7. No existing deep import or CLI package smoke may regress.

## Alternatives and tradeoffs

- A new standalone package would create release/versioning overhead and risk
  dependency drift; a subpath keeps one artifact and one source of truth.
- Re-exporting all core/source modules would be convenient but would freeze
  internal models as SDK API; a curated facade is intentionally smaller.
- Runtime parsers and a process host would provide stronger guarantees, but
  mix transport/security work into the public type contract. They are separate
  Wave 2 slices.

## Explicit non-scope

Deferred work includes runtime/wire validation, process isolation, transport
framing and message bounds, streaming and backpressure, timeouts and
cancellation, progress/cursor/resume, heartbeat and health, runtime shutdown
enforcement, deny-by-default permission manifests, filesystem/network/process
and resource policies, and built-in adapter integration/conformance. This PR
also adds no queue, cron, outbox, lease, lock, migration, or backfill.

The change is limited to nine files and at most 300 production lines across
`protocol.ts` and `index.ts`.
