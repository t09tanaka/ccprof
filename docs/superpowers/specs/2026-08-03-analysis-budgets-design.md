# Analysis-Wide Budgets Design

## Scope

This change adds one optional, deterministic budget contract around a complete
analysis run. The same budget is shared by the built-in Claude and Codex
sources. It bounds admitted input bytes, normalized input events, wall time,
CPU time, privacy-projected output bytes, and source items without replacing
the existing per-file JSONL parser budgets.

The work is limited to budget validation, metering, source admission, report
projection, and Store persistence. R004/R005 behavior, Report v3 as a whole,
organization policy, encryption, and incremental source-catalog reuse remain
outside this change.

Omitting `budgets` preserves the current analysis, output, and persistence
path. In particular, existing CLI invocations do not acquire nondeterministic
timing fields or new truncation behavior merely by upgrading ccprof.

## Public contract

The exact configuration shape is:

```ts
export interface AnalysisBudgets {
  max_input_bytes: number;
  max_input_events: number;
  max_wall_ms: number;
  max_cpu_ms: number;
  max_output_bytes: number;
  max_source_items: number;
}
```

Every field is required. Values must be finite, nonnegative safe integers.
Validation snapshots own enumerable data properties without invoking getters.
Unknown keys, symbol keys, missing or non-enumerable fields, accessors, arrays,
and hostile Proxy/reflection failures are rejected with a fixed,
content-independent validation code. No rejected key or value is reflected in
an exception or diagnostic.

An active run publishes an additive result on `ReportV2` and its stored
analysis record:

```ts
export interface AnalysisBudgetUsage {
  input_bytes: number;
  input_events: number;
  wall_ms: number;
  cpu_ms: number;
  output_bytes: number;
  source_items: number;
}

export type AnalysisTruncationReason =
  | "max_input_bytes"
  | "max_input_events"
  | "max_wall_ms"
  | "max_cpu_ms"
  | "max_output_bytes"
  | "max_source_items"
  | "source_failure"
  | "meter_error";

export interface AnalysisBudgetResult {
  configured: AnalysisBudgets;
  consumed: AnalysisBudgetUsage;
  observed: AnalysisBudgetUsage;
  completeness: "complete" | "partial";
  truncation_reason?: AnalysisTruncationReason;
  coverage: number;
}
```

`consumed` records admitted work and emitted bytes. `observed` records the
bounded attempt that established a limit, so a one-over case is inspectable
without retaining source content. All counters are finite nonnegative safe
integers. The result is omitted when no analysis budget was supplied.

## Meter and deterministic checkpoints

`src/analysis/budgets.ts` owns strict validation and an
`AnalysisBudgetMeter`. The meter receives an injected clock with monotonic
`wall_ms()` and `cpu_ms()` readings. Production wiring uses monotonic Node
clocks through one explicit adapter; tests use scripted readings. No budget
decision reads `Date.now()`, environment variables, or ambient global state.

Checkpoints occur before and after source discovery, before every source-item
open, after normalization, before later evidence I/O, and before report/store
finalization. Inclusive semantics apply: an item that leaves consumption
exactly equal to its limit is accepted; the first unit above the limit is not.
Once a checkpoint makes the run partial, no additional transcript, diff,
manifest, hook-history, or analysis-history I/O is started. Rendering and the
single final Store transaction are permitted because they are required to
report and persist the partial outcome.

NaN, infinity, unsafe readings, or a clock moving backwards do not escape as
exceptions. They stop analysis with `meter_error`, retain the last valid
counter, and use content-free diagnostics.

When more than one condition is observed at one checkpoint, the singular
`truncation_reason` is selected by the field order in `AnalysisBudgets`, then
`source_failure`, then `meter_error`. This ordering is independent of paths,
source text, host timing, or error messages.

Coverage is always finite and clamped to `[0, 1]`. A complete run is `1`.
For a partial run it is the minimum admitted/observed ratio among resources
that caused truncation. A partial run with no observed denominator reports
`0`, never NaN or infinity.

## Shared source admission

`SessionQuery` receives an optional internal meter. Without it,
`CombinedSessionSource` retains its existing parallel behavior. With it, the
built-in Claude and Codex sources run in their declared order so they consume
one shared budget deterministically.

Both source walkers become lazy, stable-order iterators. Before yielding a
transcript they claim one source item and its inspected byte size. The
remaining run-wide byte allowance is passed into the existing
`JsonlParserBudgets.maxFileBytes`; existing line, node, depth, retained-byte,
warning, and AbortSignal behavior remains the parser authority. No second
parser budget system is introduced.

Normalized events are admitted in physical source order. If a parsed source
contains more events than remain, only the exact prefix is retained, the run
becomes partial, and neither the iterator nor the next adapter is resumed.
Malformed rows remain parser warnings and consume only the bytes actually
admitted. An unreadable source records a content-free `source_failure`; usable
prefixes from earlier items remain reportable.

Injected/custom `SessionSource` implementations remain source-compatible
because the query field is optional. Core applies the same deterministic
post-discovery source/event admission as a fail-closed backstop, although only
the built-in sources can guarantee stopping their own I/O at checkpoints.

## Core flow and partial results

`AnalyzeOptions` accepts optional `budgets`, `budgetClock`, and an internal
output projection callback. Budget validation and the initial clock snapshot
happen before analysis work. A budget-exhausted run does not throw
`NoMatchingSessionsError` or `NoAnalyzableTimestampsError`; it returns a valid
zero-ledger partial report and record. The unbudgeted path keeps both existing
errors unchanged.

If the meter stops before diff, test-map, or history reads, core skips those
operations and produces no findings from absent evidence. Already accepted
sessions and warnings remain deterministic. `persist: false` performs no
Store write, including no budget row, while still returning the same budget
result that would have been stored.

## Privacy-safe output limiting

Output bytes are measured only after applying the selected privacy projection
and rendering the requested format. For an active budget, the command supplies
one asynchronous projector that prepares the exact outbound bytes and returns
them to core without placing those bytes in the analysis record. Core awaits
that result, finalizes the meter, performs its normal Store transaction, and
returns the prepared output for the command to emit without re-rendering.
Direct programmatic core calls use the strict JSON projection as the safe
default. The unbudgeted command retains its current render-after-save order.

The limiter never slices UTF-8 or serialized JSON. If the complete projected
report fits, it is emitted unchanged. If it does not fit, the run is marked
`partial` with `max_output_bytes` and a fixed format-specific, content-free
budget envelope is emitted. If that envelope itself is larger than the limit,
stdout is empty. Thus a zero output budget emits zero bytes, and no path,
prompt, command, secret, rejected value, or raw exception can enter the
fallback diagnostic.

The optional advisory remains separately bounded by its existing input and
process-output controls. The active-budget projector may prepare advisory text
before the Store transaction solely to measure the combined outbound bytes;
only its byte count participates in the budget, and the text is never included
in the deterministic report, analysis record, snapshot, or budget table. If
the combined output does not fit, the advisory is omitted before the fixed
budget envelope is considered.

## Store v4

Opening a Store upgrades schema v3 to v4 by adding
`analysis_budget_runs` and the inspectable marker
`schema-v4-analysis-budgets`. A populated v2 Store performs the existing v3
source-catalog step and the v4 budget step in the same immediate transaction.
A fresh v0 Store creates the complete v4 schema directly. v1 and future
versions remain rejected before mutation.

The table is keyed by analysis execution ID, references
`analysis_executions`, and stores every configured, consumed, and observed
counter plus completeness, nullable truncation reason, and coverage in typed
columns with SQLite constraints. The analysis snapshot carries the same
optional result so normal `loadAnalyses()` callers can inspect it. Saving the
execution, snapshot, and budget row is atomic and idempotent; an exact replay
is a no-op and conflicting budget content fails closed. Migration failure
rolls back table, marker, and `user_version` while preserving every v2/v3 row.

## Edge cases and acceptance

- Zero, exact-boundary, and one-over values are distinct and deterministic.
- Claude and Codex share one allowance; stable source order decides which
  source consumes the last available unit.
- Malformed and huge rows remain bounded by the existing JSONL controls.
- A partial source failure preserves earlier accepted evidence and reports a
  content-free reason.
- Wall/CPU NaN, infinity, unsafe values, and backwards movement fail closed.
- An output envelope larger than its cap is never partially serialized.
- Simultaneous reasons follow the fixed precedence above.
- Partial coverage with denominator zero is `0`; complete empty coverage is
  `1`.
- `persist: false` leaves every Store table unchanged.
- Interrupted v2/v3 migrations roll back without data loss; reopening is
  idempotent.
- Unknown, extra, hidden, accessor, and Proxy-backed budget inputs fail without
  evaluating or reflecting attacker-controlled content.
- After exhaustion, no new analysis/evidence I/O is initiated.
- Omitted budgets preserve existing CLI output and programmatic behavior.
