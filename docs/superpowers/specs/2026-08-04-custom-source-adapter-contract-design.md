# Custom Session Source Adapter Contract Design

## Scope

Replace the implicit `SessionSource` contract (`discover()` only) with a
closed, runtime-validated v2 contract. Every built-in or injected leaf source
must declare its adapter identifier, adapter version, and provided session
capabilities before discovery begins. Invalid declarations fail before source
content can reach discovery, rules, reports, or persistence.

This PR reuses the existing source-adapter registry and capability vocabulary.
It does not add an adapter registry service, a new Store schema, source
discovery infrastructure, Report v3 fields, policy behavior, or a new CLI.

## Considered approaches

1. **Required data-only contract on every leaf `SessionSource` (selected).**
   A source owns a `contract` data property alongside `discover()`. A single
   boundary validator snapshots the exact contract and the `discover` data
   method before use. This is explicit, deterministic, and permits validation
   before any adapter code starts.
2. **Out-of-band registration in a global or weak registry.** This would keep
   source objects smaller, but adds mutable process-wide state, makes tests
   order-dependent, and creates a second registry beside `SourceDescriptor`.
3. **Infer the contract from returned sessions.** This is compatible with the
   old API, but cannot reject a missing or hostile declaration before
   `discover()` and preserves the current fail-open behavior.

The selected approach is the smallest one that satisfies the fail-closed
boundary without adding infrastructure.

## Public contract

API v2 adds one required property to every leaf source:

```ts
interface SessionSourceContract {
  adapter_id: "claude" | "codex";
  adapter_version: "1.0.0";
  capabilities: readonly SessionCapability[];
}

interface SessionSource {
  readonly contract: SessionSourceContract;
  discover(query: SessionQuery): Promise<Session[]>;
}
```

“v2” names the `SessionSource` API generation. `adapter_version` remains the
version of the registered log adapter and therefore stays `1.0.0` for the two
current adapters. The declaration is closed: it has exactly the three named
string keys, all represented by enumerable own data properties. Capabilities
are a dense, plain, sorted, unique array drawn from
`ALL_SESSION_CAPABILITIES`.

The built-in constants are immutable and explicit:

- Claude `1.0.0`: all six known capabilities in canonical order.
- Codex `1.0.0`: `edit_fragments` and `tool_timestamps`.

A custom implementation may implement either registered adapter and may
declare a narrower capability subset. Unknown adapter identifiers and adapter
versions remain unsupported until the existing registry is intentionally
extended in a later PR.

## Validation boundary

`validateSessionSource(value)` performs a content-free snapshot before
discovery:

1. Reject null, arrays, functions, and Proxy source objects.
2. Require an own `contract` data property. An accessor is invalid and is not
   invoked.
3. Require a data-valued `discover` function on the object or its non-Proxy
   prototype chain. An accessor is invalid and is not invoked.
4. Reject symbol, hidden, accessor, missing, or extra contract fields.
5. Reject unknown adapter IDs, unsupported versions, malformed capability
   containers, unknown capabilities, duplicates, and non-canonical order.
6. Return a frozen canonical wrapper which invokes the captured function with
   the original source as `this`.

Node's `util.types.isProxy` is checked before reflection, matching existing
ccprof validation patterns. Reflection failures are converted to a fixed
`SessionSourceValidationError`; input values, thrown trap text, paths, and
source content never appear in the message.

The wrapper validates discovery output before returning it to analysis.
Results must be a non-Proxy array of non-Proxy session records. Each session's
`source` must equal the validated adapter ID. Explicit session capabilities
must be known and a subset of the source declaration; their order is
canonicalized. When a session omits capabilities, the wrapper copies the
validated contract capabilities into the returned session. Thus every new
analysis has explicit capabilities even though pure legacy readers may still
interpret an old stored `Session.capabilities === undefined` as full.

Validation failures use only these stable codes:

```text
invalid_shape
unknown_field
unknown_adapter
unsupported_version
invalid_capability
invalid_discover
invalid_result
adapter_mismatch
```

The public message is always `invalid session source: <code>`.

## Combined and analysis data flow

`CombinedSessionSource` remains an internal coordinator rather than inventing
a synthetic adapter ID. Its constructor validates and snapshots every leaf;
therefore an invalid leaf prevents construction and no source starts. During
discovery it calls the validated wrappers while preserving current behavior:

- unbudgeted leaves start in parallel and results retain source order;
- budgeted leaves start sequentially and stop at the existing checkpoint;
- a valid leaf's discovery error remains available to the existing error
  callback and does not erase another valid leaf's sessions.

An injected `AnalyzeOptions.sessionSource` is validated synchronously before
its `discover()` method is invoked. The default Claude/Codex path is already
composed from validated built-ins. Normalized sessions then follow the existing
window, coverage, rule, descriptor, snapshot, report, and persistence pipeline
unchanged.

## Determinism and compatibility

Canonical capability order is code-unit order, independent of declaration or
session input order. Source descriptors continue to derive their adapter
metadata from the existing registry, while their provided capability list now
always comes from an explicit validated session value on new analyses.
Snapshot digests and rule coverage therefore receive canonical explicit input.

The TypeScript interface change intentionally requires custom integrations to
migrate to v2. Existing injected test adapters are updated mechanically with
the immutable built-in contract constants. Legacy stored reports and pure
coverage helpers retain their existing read behavior; no Store migration or
backfill is required.

## Edge cases and acceptance tests

- Missing contract, contract getter, discover getter, Proxy source, Proxy
  contract, Proxy capability array, and throwing reflection traps all fail
  without invoking user getters or leaking canary text.
- Extra string, symbol, or non-enumerable contract fields fail as
  `unknown_field`.
- Missing fields, unknown adapters, unsupported versions, unknown
  capabilities, duplicates, sparse arrays, and non-canonical order fail with a
  stable code.
- Invalid declarations never call `discover()`.
- Non-array/Proxy results, Proxy sessions, adapter mismatch, and capabilities
  outside the declaration fail before rules, reports, or persistence.
- Omitted session capabilities become an explicit immutable canonical copy;
  source-owned objects and arrays are not mutated.
- Built-in Claude and Codex declarations validate exactly.
- Combined parallel order, budget checkpoints, failure isolation, descriptor
  equality, snapshot identity, and rule coverage remain deterministic.

## File and scope budget

Production behavior is confined to the existing source boundary, built-in
adapters, coordinator, and analysis call site, and must stay below 300 added
production lines. Closing a public structural interface necessarily touches
several test fixture files; those changes are mechanical contract declarations,
not additional behavior. Design/plan documentation is committed as required.
