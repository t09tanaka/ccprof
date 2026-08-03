# Finding Impact and Confidence Design

**Date:** 2026-08-04  
**Status:** Approved for implementation

## Goal

Separate a finding's estimated impact from the confidence in the evidence and causal claim, while preserving Report/Store v2 readability. Use only strict, high-confidence lower-bound critical-path intervals to reduce the optimization ledger's remaining estimated floor.

## Public contracts

```ts
export interface ImpactEstimate {
  lower_ms: number;
  expected_ms?: number;
  upper_ms: number;
  kind: "critical_path_latency" | "resource_cost";
}

export interface FindingConfidence {
  evidence: "low" | "medium" | "high";
  causal: "low" | "medium" | "high";
  source_completeness: number;
}
```

Every newly produced candidate and finding has canonical `impact` and detailed `confidence`. `expected_ms` is present only when supported by detector evidence; it is never synthesized from bounds.

Each detector explicitly assigns the causal rating and a rationale. Severity and scoring remain deterministic and have a stable rationale based on the canonical fields.

## Compatibility boundary

Existing `recoverable` and scalar confidence fields remain Report/Store v2 compatibility projections. They are derived one-way from canonical `impact` and detailed `confidence`; they are not independent inputs for newly produced findings.

Legacy reads normalize conservatively:

- A legacy impact value becomes an upper-only estimate with `lower_ms: 0`.
- No `expected_ms` is fabricated.
- Legacy confidence never becomes confirmed: causal confidence remains below `high`, and source completeness remains below `1` unless the canonical detailed fields were present and valid.
- Legacy compatibility projections remain readable through dismissal, adoption, and Store round trips.

This change does not introduce a Report v3 envelope.

## Runtime validation and hostile inputs

Canonical impact and confidence values are exact, plain data objects. Runtime validators and snapshot/canonicalization entry points reject malformed values before reading or serializing their content.

Rejected inputs include:

- Partial or extra keys.
- Hidden/non-enumerable keys.
- Accessor properties.
- Non-plain prototypes.
- Proxies, revoked proxies, or objects whose reflection traps throw.
- Numeric values that are `NaN`, positive or negative infinity, negative, or negative zero.
- Impact bounds where `lower_ms > upper_ms`.
- `expected_ms` outside the inclusive lower/upper bounds.
- `source_completeness` outside the inclusive range `[0, 1]`.

Rejection is content-free: failures do not echo attacker-controlled property names, values, trap errors, or serialized object content. Validation order is deterministic.

Valid boundary cases include zero durations, `expected_ms` equal to either bound, and completeness exactly `0` or `1`.

## Ledger floor

The ledger computes:

```text
estimated_floor = measured - duration(union(high-confidence critical-path lower-bound intervals))
```

An interval is eligible only when all of these are true:

```text
impact.kind = critical_path_latency
impact.lower_ms > 0
confidence.evidence = high
confidence.causal = high
confidence.source_completeness = 1
```

Resource-cost estimates, upper-only estimates, medium/low confidence, and partial source coverage never reduce the floor.

Eligible lower-bound intervals reuse the existing interval intersection, union, deduplication, EventIdentity, detector/rule version and epoch, and interval ID mechanisms. No new ledger, table, queue, audit subsystem, lock, lease, or backfill is introduced.

The union calculation handles overlapping, nested, adjacent, and duplicate intervals without double counting. In mixed-confidence overlap, only eligible high-confidence intervals contribute. The result is deterministically rounded according to the existing duration convention and clamped to `[0, measured]`; `measured = 0` therefore yields a zero floor.

Partial trace coverage does not qualify even when the evidence and causal ratings are high.

## Detector behavior

Every detector that emits a candidate supplies:

- An `ImpactEstimate`, including the domain (`critical_path_latency` or `resource_cost`).
- A `FindingConfidence`.
- An explicit causal rating rationale.
- Evidence for `expected_ms` if that optional value is emitted.
- Stable inputs for deterministic severity/scoring and its explanation.

An upper-only detector emits `lower_ms: 0` and omits `expected_ms` unless evidence supports it. Resource-domain findings remain visible but do not affect the critical-path floor.

## Presentation

- TTY output shows impact as a range (and expected value when present), the impact kind, and detailed confidence.
- Markdown output presents the same information in stable, readable text.
- JSON exposes canonical `impact` and detailed `confidence` while retaining the v2 compatibility projections.
- Legacy reports without canonical fields remain readable after conservative normalization.

Formatting is deterministic across runs and does not leak hidden or rejected input content into output, digests, or errors.

## Identity, ordering, and persistence

- Existing EventIdentity, interval IDs, detector/rule version and epoch identifiers remain authoritative.
- Canonical snapshots and digests include the new canonical fields in stable key order.
- Deduplication and ordering remain deterministic when bounds or confidence differ.
- Dismissal and adoption continue to target the same finding identity.
- Store persistence round-trips canonical fields and derives compatibility projections on read/write boundaries as appropriate.

## Edge-case matrix

Implementation tests cover:

1. Numeric validation: `NaN`, positive/negative infinity, negative values, negative zero, `lower_ms > upper_ms`, zero, and rounding/clamping.
2. Expected value: absent, equal to lower bound, equal to upper bound, and outside either bound.
3. Completeness: `0`, `1`, fractional valid values, and out-of-range values.
4. Interval math: overlap, nesting, adjacency, duplicates, high/low overlap, resource/critical-path mixtures, upper-only estimates, and `measured = 0`.
5. Coverage and legacy input: partial coverage, legacy point/upper/low confidence, and the rule that legacy input is never upgraded to confirmed.
6. Hostile shapes: partial, extra, non-enumerable, accessor, proxy, revoked proxy, and throwing traps, with content-free rejection.
7. Stability and privacy: canonical digest, deterministic ordering, no rejected-content leakage, dismissal/adoption, and Store round trip.

## Implementation constraints

- Reuse existing mechanisms and keep the patch focused on impact, confidence, compatibility projection, ledger calculation, and presentation.
- Shared TypeScript types, interfaces, and function signatures are changed only after TypeScript Language Service definition/reference/diagnostic inspection.
- Development follows RED, minimal implementation, GREEN.
- Static analysis, type checking, tests, and local GitHub Actions execution are delegated to a separate verification agent.
- The design receives a self-review before its own commit, followed later by separate specification and quality/security reviews of the implementation.

## Explicitly out of scope

- R004 allowlist changes.
- R005 resource-domain behavior changes beyond carrying/displaying its impact domain and excluding it from the latency floor.
- Report v3 envelopes.
- Statistics cohorts.
- Policy or encryption changes.
- Existing-data migration, repair, or backfill.
- Exact-once delivery, automatic recovery, new concurrency control, or a new audit/ledger subsystem.
