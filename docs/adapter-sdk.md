# Adapter SDK v1

The public TypeScript adapter contract is available from the npm subpath:

```ts
import {
  ADAPTER_PROTOCOL_VERSIONS,
  parseSourceAdapterId,
  supportsCapability,
  type AdapterRpcRequest,
  type AdapterRpcResponse,
} from "ccprof/adapter-sdk";
```

Version 1 is a JSON-RPC 2.0 request/response contract. It defines types and
shared helpers; it does not start, host, isolate, or communicate with an
adapter process.

## Lifecycle

Call the methods in this order:

1. `initialize`
2. `negotiateCapabilities`
3. `shutdown`

All three are requests, not notifications. Every request ID is a string or a
number for which `Number.isSafeInteger(id)` is true. A JSON-RPC failure may use
`id: null` only when the request ID cannot be recovered.

### Initialize

Offer supported protocol versions in preference order. The list must be
non-empty. v1 publishes exactly:

```ts
ADAPTER_PROTOCOL_VERSIONS // readonly ["1.0.0"]
```

The adapter returns one version from the offered list, a namespaced adapter ID
accepted by `parseSourceAdapterId`, and its SemVer adapter version. If no
offered protocol is supported, initialization fails and negotiation must not
start.

```ts
const request = {
  jsonrpc: "2.0",
  id: "initialize-1",
  method: "initialize",
  params: { protocol_versions: ADAPTER_PROTOCOL_VERSIONS },
} satisfies AdapterRpcRequest<"initialize">;
```

### Negotiate capabilities

Send required and optional `CapabilitySupportQuery` arrays separately. The
adapter returns its `CapabilityDescriptorV1` with one of two outcomes:

- `accepted: true` when every required query is supported;
- `accepted: false` with a non-empty `unavailable_required` list otherwise.

Each unavailable required query has one reason:

- `unsupported`: explicitly unsupported, or its exact version/range does not
  match;
- `unknown`: declared with state `unknown`;
- `undeclared`: no declaration has that namespaced ID.

Optional misses never reject negotiation. If a query appears in both arrays,
required semantics take precedence. `supportsCapability` provides the
existing conservative exact-ID and exact-version-contract check.

### Shutdown

Send `shutdown` with `{}` params. A clean adapter returns:

```ts
{ acknowledged: true }
```

Wait for the response before closing the transport. This package version does
not enforce the lifecycle or terminate processes itself.

## Public and compatibility boundary

The subpath re-exports only the protocol types plus:

- `SourceAdapterId` and `parseSourceAdapterId`;
- `CapabilityDescriptorV1` and `CapabilitySupportQuery`;
- `validateCapabilityDescriptor` and `supportsCapability`.

It does not export `SessionSource`, model/session/source-descriptor types,
analysis or Store APIs, or built-in adapters. Existing
`ccprof/dist/*`, `ccprof/schemas/*`, and `ccprof/package.json` deep imports and
the `ccprof` CLI remain available.

## Deferred runtime work

Consumers must currently enforce the normative safe-integer ID, selected-offer,
namespaced-ID, SemVer, and lifecycle invariants at their boundary. Runtime/wire
validation is deferred.

Also outside v1 are process isolation, transport framing and bounded messages,
streaming/backpressure, timeout/cancellation, progress/cursor/resume,
heartbeat/health, runtime shutdown enforcement, deny-by-default permission
manifests, filesystem/network/process/resource policies, and built-in adapter
integration or conformance. No queue, cron, outbox, lease, or lock is part of
this SDK slice.
