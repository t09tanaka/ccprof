# Neutral Trace Envelope v1 Design

**Date:** 2026-08-05
**Status:** Approved for implementation

## Goal

Publish a vendor- and forge-neutral ccprof Trace Envelope v1 as a Draft
2020-12 JSON Schema. The schema is a standalone protocol artifact and does not
change the existing `Session`, `NormalizedEvent`, ingestion, adapter, analysis,
Store, or report runtime.

## Public contract

The artifact is `schemas/trace-envelope-v1.schema.json` with the stable ID:

```text
https://schemas.ccprof.dev/trace-envelope/v1.json
```

Instances repeat that URI in `$schema` and use `protocol_version: "1.0.0"`.
The existing npm `files` entry already publishes the complete `schemas`
directory, so no package split, export map, or runtime loader is introduced.

The root requires:

```text
$schema
protocol_version
producer
trace_id
span_id
sequence
timestamp
work_unit
event
privacy
provenance
```

`parent_span_id` is optional for root spans. Every envelope-owned object is
closed. The only deliberate exception is `event.payload`, whose object members
are validated separately against the absolute URI in `event.payload_schema`.

## Identifiers and ordering

Trace IDs are exactly 32 lowercase hexadecimal characters and span IDs are
exactly 16. Negative-lookahead patterns reject the W3C-invalid all-zero values.
Uppercase, non-hex, and wrong-width encodings fail.

Producer IDs and work-unit kinds use reverse-DNS-style namespaced names. Event
types, payload-schema identities, and provenance sources are absolute
URI-shaped strings. These constraints prevent unnamespaced global names while
remaining independent of any agent vendor or forge.

`sequence` is a nonnegative JSON-safe integer, capped at
`9007199254740991`. For one `(producer.id, producer.instance_id, trace_id)`
stream, producers emit increasing values in observation order; gaps are
allowed. A single-envelope schema cannot compare two values, so this PR adds
no runtime state, lock, queue, or cross-envelope ordering validator.

## Time and precision

`wall_time_unix_ns`, `monotonic_offset_ns`, and `uncertainty_ns` are canonical
nonnegative decimal strings. `0` is valid; all other values start with a
non-zero digit. JSON numbers, signs, leading zeroes, fractions, and exponent
notation fail. A bounded maximum length prevents unbounded identifier-like
input while retaining values far beyond JavaScript's safe-integer range.

The wall clock records Unix nanoseconds. The monotonic offset is measured from
the producer instance's trace-local monotonic origin, and uncertainty is the
nonnegative estimated timing error. Cross-field or cross-envelope clock
relationships remain producer conformance semantics rather than new runtime
behavior.

## Neutral work, privacy, and provenance

`work_unit` carries a namespaced generic `kind` and opaque `id`, with an
optional opaque `parent_id`. It models tasks, sessions, changes, and other work
without forge-specific fields or enums.

`privacy` requires one bounded classification and a `content_retained` boolean.
It declares the event's retention state; it does not alter existing ccprof
storage or privacy projection.

`provenance` is a nonempty array of closed entries. Each entry identifies an
envelope field using an RFC 6901 JSON Pointer, an absolute source URI, and one
of `observed`, `reported`, `derived`, or `estimated`. The schema represents
field-level provenance without claiming it can prove that every possible
payload field has an entry.

## Payload-schema boundary

Envelope validation and payload validation are two explicit steps:

1. Validate the envelope against the ccprof Trace Envelope v1 schema.
2. Resolve an allowed/trusted `event.payload_schema` URI and validate only
   `event.payload` against that external schema.

Unknown root, producer, timestamp, work-unit, event-wrapper, privacy, and
provenance-entry fields fail closed. Arbitrary keys inside `event.payload` are
accepted by the envelope schema because only its declared external schema owns
their meaning. The ccprof schema never fetches remote schemas automatically.

## Conformance coverage

A committed `dummy-agent` fixture uses neutral producer, task, event, and
provenance identities and contains no vendor or forge literals. Draft 2020-12
validation must accept it and a clone with a valid parent span. Table-driven
negative cases cover:

- root and nested unknown fields;
- missing required fields;
- wrong-width, uppercase, non-hex, and all-zero trace/span/parent IDs;
- negative or unsafe sequence values;
- numeric, signed, fractional, exponent, leading-zero, and negative
  nanosecond representations;
- invalid producer/work-unit namespaces, absolute URIs, and JSON Pointers;
- payload-wrapper closure while preserving extensible payload keys.

The test also checks the schema dialect, stable ID, required sections,
recursive closure, intentional payload exception, package manifest inclusion,
and absence of forbidden fixture literals.

## Packaging and documentation

The schema is placed in the existing `schemas` directory already included in
the npm artifact. README documentation names the stable schema URI, packaged path,
the two-stage validation rule, ordering scope, precision rules, and the neutral
fixture. Existing package smoke already packs the entire `schemas` directory;
the conformance test locks the manifest inclusion and parses the artifact.

## Explicitly out of scope

- Runtime envelope production, ingestion, persistence, or export.
- Changes to `Session`, `NormalizedEvent`, adapters, rules, reports, or Store.
- Cross-envelope sequence or clock enforcement.
- Payload-schema downloading, trust policy, caching, or registry services.
- Adapter process isolation, capability negotiation, or any later audit wave.
- New tables, migrations, backfills, queues, cron, locks, leases, or recovery.

## Implementation limits

The change uses the existing publication layout, one schema, one fixture, one
conformance test, the minimum test-only validator dependency, README discovery
text, and the required design/plan documents. No production TypeScript or
shared interface changes are required. The implementation stays within ten
files; the JSON Schema is excluded from the 300-line implementation limit.
