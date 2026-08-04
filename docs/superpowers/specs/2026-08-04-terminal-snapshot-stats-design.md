# Terminal Snapshot Statistics and Comparable Cohorts Design

## Purpose

This change makes `ccprof stats` safe to interpret as a repository-level
measurement rather than a sum of every historical analysis execution. It fixes
audit items P0-4 and P0-5 by selecting one terminal Git state for each distinct
work unit, preserving five different impact dimensions, and emitting robust
statistics only for sufficiently large comparable cohorts.

The change remains local and deterministic. It does not add a dashboard,
collector, control plane, aggregate table, logical-repository provider, or
workspace adapter. Existing Report v2 output and Store v2 through the current
Store schema remain readable.

## Existing contracts used by this design

The Store already separates immutable `analysis_snapshots` from
`analysis_executions`. `loadAnalyses` currently selects the oldest execution of
each exact snapshot. Consequently, another execution of the same exact
snapshot does not increase the loaded population and does not change that
snapshot's first-seen time.

Every new finding has canonical `ImpactEstimate` and `FindingConfidence`
fields. The ledger already retains the interval unions for strict
high-confidence lower bounds, point attribution, observed human wait, and
unexplained time. The Rule Manifest declares each rule's impact kind and one of
`sum`, `union`, `max`, or `never_aggregate`.

These are the sources of truth. Legacy scalar `recoverable.min`, legacy
`point`/`upper`, a finding title, or a reporter's displayed minutes are never
promoted into a confirmed organization metric.

## Considered approaches

### 1. Sum all loaded records and findings

This preserves the current implementation but counts intermediate PR states,
mixes upper estimates into confirmed savings, and lets exact reruns or repeated
analysis of one PR bias frequencies. It is rejected.

### 2. Keep only the newest `created_at_ms` for each `unit.pr_ref`

This is small, but branch labels are not a work-unit identity. A GitHub PR, an
explicit offline range, and inferred default-branch analysis can share the same
display string. A later rerun of a previously superseded Git state can also
resurrect that state as terminal. It is rejected.

### 3. Snapshot-aware work units with manifest-driven metrics and explicit
cohorts (selected)

The Store exposes additive, read-only snapshot metadata alongside existing
records. A canonical selector identity distinguishes GitHub PRs, explicit
ranges, and inferred local ranges. A terminal selector first chooses the newest
first-seen Git state and then the newest analysis variant of that state.
Metrics are finalized from ledger intervals at analysis time under the Rule
Manifest. Comparable cohorts use fixed, transitive buckets and fail closed when
a required dimension is unavailable.

This approach reuses the existing Store and ledger, gives deterministic
semantics, and introduces no aggregate persistence subsystem.

## Snapshot and work-unit identity

### Selector identity

`AnalysisSnapshotIdentity` gains an optional closed `selector` field. It is
optional only so existing snapshot envelopes remain readable. Every new
snapshot supplies exactly one of:

```ts
type AnalysisSelectorIdentity =
  | { kind: "github_pr"; number: number }
  | {
      kind: "explicit_range";
      range: "double_dot" | "triple_dot";
      base_label: string;
      head_label: string;
    }
  | {
      kind: "inferred_local_range";
      base_label: string;
      head_label: string;
    };
```

An explicit `A..B` and `A...B` therefore remain distinct even though the
existing display `pr_ref` canonicalizes both to `A...B`. A current or explicitly
selected GitHub PR uses the numeric PR identity. A local fallback without GitHub
metadata uses `inferred_local_range`. Empty labels, unsafe integers, unknown
kinds or fields, and non-canonical objects fail validation.

The internal work-unit key is a domain-separated digest of the exact
repository ID and selector identity:

```text
work_unit_key = digest(repository_id, selector)
```

The Git-state key adds frozen Git identity:

```text
git_state_key = digest(
  work_unit_key,
  base_oid,
  head_oid,
  merge_base_oid
)
```

Raw repository paths, branch labels, URLs, and selector values are not emitted
as aggregate dimensions.

### Read-only history entries

`AnalysisHistoryResult` gains additive `entries`. Each entry contains the
existing `AnalysisRecord`, its `snapshot_id`, and the validated snapshot
identity. Existing callers continue to consume `records`. No field is added to
the immutable snapshot payload solely to mirror its own hash.

Content-fallback snapshots and older snapshot identities without selector
semantics stay readable through `records`, but are ineligible for terminal KPI
aggregation. They contribute a bounded suppression count instead of being
silently grouped by a display label.

### Deterministic terminal selection

The Store query continues to return one oldest execution per exact snapshot.
For each work-unit key:

1. Group snapshot entries by Git-state key.
2. Define a Git state's `first_seen_at_ms` as the minimum selected execution
   time of every exact snapshot variant with that Git-state key.
3. Select the state with greatest `(first_seen_at_ms, git_state_key)`.
4. Within that state, select the analysis variant with greatest
   `(created_at_ms, snapshot_id)`.

The minimum in step 2 is essential. If state A is first seen, state B later
supersedes it, and A is rerun after B with a changed history or policy digest,
A retains its original state first-seen time and cannot become terminal again.
Exact duplicate executions were already removed by the Store query. Equal
times are resolved by opaque canonical digests, never input order.

If the selected terminal entry lacks finalized metric or cohort metadata, the
work unit is suppressed. Stats never falls back to an older, more convenient
snapshot because that would report a non-terminal state.

## Finalized terminal snapshot metrics

Each new `AnalysisRecord` stores an optional closed
`terminal_stats_snapshot` object. It contains only versioned numeric summaries,
bounded cohort dimensions, and per-rule numeric contributions; it does not
contain evidence, paths, commands, prompts, session IDs, interval endpoints, or
finding text.

```ts
interface TerminalStatsSnapshotV1 {
  schema_version: 1;
  measured_wall_ms: number;
  confirmed_critical_path_ms: number;
  estimated_critical_path_upper_ms: number;
  resource_cost_ms: number;
  human_wait_ms: number;
  unexplained_ms: number;
  cohort: {
    repository_id: string;
    workspace_id: string;
    changed_files: number;
    changed_lines?: number;
  };
  rules: Array<{
    rule_id: RuleId;
    rule_version: string;
    compatibility_epoch: number;
    confirmed_critical_path_ms: number;
    estimated_critical_path_upper_ms: number;
    resource_cost_ms: number;
  }>;
  incomplete_interval_findings: number;
}
```

The repository ID is the current Store's canonical repository hash. Until a
logical-workspace provider exists, `workspace_id` is a separately domain-hashed
ID for the exact canonical repository root. It deliberately cannot combine
different roots or guess monorepo workspace membership.

`changed_files` is the authoritative name-status file count. `changed_lines`
is additions plus deletions parsed from a complete, non-binary Git patch. It is
omitted when the patch is truncated, unpaired, or contains binary changes; the
cohort then suppresses instead of guessing a size.

### Rule Manifest aggregation

Only findings whose canonical impact, confidence, current exact rule version,
compatibility epoch, and interval evidence validate can contribute. The
manifest's `aggregation_policy` is applied per rule:

- `never_aggregate`: contributes zero to every KPI. R004 therefore never
  becomes confirmed or possible savings; its observed wait remains human wait.
- `union`: eligible interval slices are unioned.
- `max`: the deterministic finding with the greatest eligible estimate is used;
  ties use finding key and interval signature.
- `sum`: numeric resource contributions are summed; critical-path interval
  slices are collected, but the final wall-clock union still removes overlap.

Critical-path findings use interval evidence capped by the applicable canonical
bound. An interval-less critical-path finding cannot be placed on measured wall
time and contributes zero; it increments `incomplete_interval_findings`.
`expected_ms` is presentation/calibration information and is never substituted
for a missing lower or upper bound. Legacy findings, partial canonical field
sets, missing exact rule metadata, and invalid/missing intervals always produce
zero confirmed time.

Resource cost is a separate non-wall axis. For R005 and R006 the current
manifest policy is `max`, so the largest canonical `upper_ms` for the rule is
used. R006 may contribute to `resource_cost_ms` without intervals because its
manifest explicitly permits numeric `max`; it can never contribute to
confirmed or possible critical-path wall time. A `never_aggregate` rule never
contributes even when it has a numeric estimate.

### Disjoint wall-clock partition

For measured active wall intervals `M`, aggregation constructs these interval
sets in order:

```text
C = union(manifest-eligible strict high/high/full lower-bound intervals)
P = union(manifest-eligible critical-path upper intervals) - C
W = observed human-wait intervals - C - P
U = ledger unexplained intervals - C - P - W
N = M - C - P - W - U
```

The stored numeric fields are the durations of `M`, `C`, `P`, `W`, and `U`.
All interval inputs are clipped to `M`; invalid, negative, non-finite, or
reversed intervals are ignored and recorded as incomplete. Therefore:

```text
C, P, W, U, and N are pairwise disjoint
confirmed + possible_upper + human_wait + unexplained <= measured_wall
resource_cost is not part of this wall-clock equation
```

Property tests generate overlaps, permutations, fractional bounds, missing
intervals, and hostile legacy records to hold this invariant. The terminal
snapshot validator independently rejects negative/non-finite values, a wall
sum over `measured_wall_ms`, duplicate/non-canonical rule rows, or a rule-row
sum inconsistent with its snapshot totals.

## Comparable cohorts

### Work-unit cohorts

Terminal aggregation and the report baseline use only selected terminal
snapshots. A work-unit cohort requires exact repository and workspace IDs plus
equal deterministic size buckets:

```text
changed files: 0 | 1 | 2-4 | 5-9 | 10-19 | 20-49 | 50+
changed lines: 0 | 1-9 | 10-49 | 50-199 | 200-999 | 1000+
```

Fixed buckets are selected over relative tolerances because relative
"similarity" is not transitive and can make results depend on traversal order.
Exact counts are rejected as unnecessarily suppressive. A missing repository,
workspace, or changed-line dimension suppresses the cohort with a stable reason.

The baseline compares each current numeric work-unit metric with prior terminal
work units in the same cohort. It reports:

```ts
interface CohortDistribution {
  median: number;
  p50: number;
  p75: number;
  mad: number;
  sample_count: number;
}
```

Quantiles use sorted linear interpolation at `(n - 1) * p`; therefore `p50`
equals the median. MAD is the median absolute deviation from that median.
Finite inputs are sorted before every sum or interpolation and results are
rounded once to four decimal places.

### R006 command cohorts

R006 does not reuse a single command key attached to the whole snapshot. For
each stored command cost it builds a separate cohort requiring:

- the same work-unit repository, workspace, and size buckets;
- the exact canonical `CommandIdentity`;
- the exact per-command cache state when it was observed.

`StoredCommandCost` gains an optional `cache_state: "cold" | "warm"`. Current
sources do not reliably observe cache state, so an absent value suppresses that
command cohort. Unknown cache states are never grouped together and no
cold/warm guess is made. This intentionally makes current R006 conservative
until a source can provide the dimension; complete programmatic/test records
exercise the command cohort contract now.

R006's history count, presence count, ratio denominator, and median/p50/p75/MAD
are calculated from the command's comparable terminal cohort, not every
analysis. Its resulting finding remains `resource_cost` with the manifest's
`max` aggregation policy.

## Minimum cohort policy

The signed organization policy and repository `policy` object gain an optional
bounded `minimum_cohort_size` integer in schema version 1. The valid range is
3 through 1,000 and the default is 5. The effective value is:

```text
max(5, organization.minimum_cohort_size, repository.minimum_cohort_size)
```

The repository can tighten but never weaken the signed organization floor.
There is no CLI override. Omission preserves the exact existing canonical
organization-policy bytes and signatures; when present, the field is appended
in one fixed canonical position. Invalid or unknown policy values continue to
fail closed.

The effective threshold gates both terminal aggregate emission and comparable
cohort distributions in `stats`. Analysis-time baseline and R006 use the same
default of 5 when no resolved policy is available. A smaller function-level
threshold may be injected only by tests; it is not a CLI or persisted policy
bypass.

At fewer samples, metric values are absent rather than zero and metadata gives
`status: "suppressed"`, the effective threshold, actual sample count, and a
bounded reason code. No broader repository, size, command, or cache cohort is
used as a fallback.

## Stats report and privacy flow

`runStatsCommand` passes the complete history entries and effective minimum
cohort size to summarization. Summarization selects terminals and creates only
in-memory totals. The existing stats privacy projection then produces the only
object handed to JSON or TTY rendering:

```text
raw Store history
  -> validate entries
  -> select terminal snapshots
  -> aggregate numeric summaries/cohorts in memory
  -> project selected privacy profile
  -> render JSON or TTY
```

The additive stats metadata includes the privacy profile, effective minimum,
stored snapshot count, distinct work-unit count, superseded count, ineligible
count, terminal sample count, and bounded suppression reasons. No raw selector,
repository/workspace ID, command, path, interval, or finding evidence is added
to aggregate output. Existing chronic-command display remains behind the
current command privacy projection; strict output never exposes its identity.

`rule_minutes` remains for JSON compatibility but is redefined and labeled in
TTY as confirmed critical-path minutes by rule. It is derived only from the
disjoint per-rule confirmed contributions in eligible terminal snapshots.
Upper, resource, human-wait, and unexplained values never enter it. Recurrence
and adoption sections remain observational, but operate on terminal records so
intermediate snapshots do not bias their counts.

Detected CI retains the existing non-weakenable strict policy path. This change
does not add another rendering or privacy bypass.

## Compatibility and persistence

- Existing `AnalysisRecord` JSON remains schema version 1. New cohort,
  terminal-metric, and command cache fields are optional for reading.
- New analyses always write a validated `terminal_stats_snapshot` when diff and
  ledger finalization complete. Budget-truncated partial analyses that cannot
  finalize it remain readable but are ineligible for terminal KPI output.
- Existing Store tables and migrations are unchanged. No raw detailed payload
  is copied into a new aggregate table.
- Existing Report v2 fields and JSON rendering stay additive-compatible.
  Robust distribution fields are optional when reading older baseline objects;
  old mean-only baselines are not re-labeled as cohort medians.
- Existing callers of `loadAnalyses().records` keep working. Snapshot-aware
  consumers use additive `entries`.
- Existing stats JSON sections remain present. Their populations become
  terminal work units and `rule_minutes` becomes confirmed-only; new metadata
  explains the changed basis.

## Edge cases and fail-closed behavior

1. Multiple executions of one exact snapshot count once.
2. Rerunning a superseded Git state after a newer state cannot resurrect it.
3. Two snapshots first seen at the same millisecond use canonical digest ties.
4. A GitHub PR, explicit `..`, explicit `...`, and inferred local range never
   share a work-unit bucket merely because their display labels match.
5. Different repositories with the same PR number remain distinct.
6. Legacy/content-fallback snapshots and malformed or absent selector metadata
   remain readable but are not enterprise KPI samples.
7. A terminal snapshot missing metrics is suppressed; an older complete
   snapshot is not substituted.
8. Unknown workspace, truncated/binary diff size, malformed bucket data, and
   non-finite or unsafe counts suppress instead of broadening a cohort.
9. Size-bucket boundary values are inclusive exactly as listed.
10. Missing, malformed, or secret-bearing command identities cannot form an
    R006 cohort.
11. Missing command cache state suppresses R006; `cold` and `warm` never mix.
12. A cohort one below the effective minimum is suppressed; one exactly at it
    is emitted.
13. Repository policy below the organization minimum has no effect; a higher
    repository minimum tightens it.
14. Odd/even cohorts, repeated values, zero MAD, fractional values, and input
    permutations produce deterministic distributions.
15. Overlapping findings within and across rules never double-count wall time.
16. `never_aggregate` findings remain outside KPIs even if high confidence.
17. `max`, `union`, and `sum` use their manifest meanings; expected-only and
    interval-less critical impacts never become confirmed wall time.
18. R006's interval-less historical upper can appear only on the separate
    resource axis under manifest `max`.
19. Legacy scalar point estimates, partial canonical fields, non-high evidence
    or causality, incomplete source coverage, and invalid intervals all produce
    zero confirmed time.
20. Resource cost never participates in the measured-wall partition equation.
21. Strict and balanced stats output contains no raw selector, repository,
    workspace, command identity, path, URL, token, or evidence payload.
22. Aggregate and cohort values are never persisted to a new table, and stats
    never modifies raw snapshot records.

## Verification strategy

- Store tests prove additive selector parsing, history entry metadata, exact
  execution deduplication, and superseded-state rerun behavior.
- Git-context tests prove selector-kind and `..`/`...` distinctions.
- Ledger/aggregation unit and property tests prove manifest policy behavior,
  interval clipping/deduplication, fail-closed legacy handling, and the wall
  partition invariant.
- Cohort tests prove bucket boundaries, terminal-only populations, robust
  distributions, separate R006 command cohorts, cache suppression, and minimum
  threshold boundaries.
- Policy/config tests prove bounds, canonical signature compatibility, and
  organization-over-repository monotonicity.
- Reporter/CLI tests prove additive JSON and TTY output, strict privacy,
  non-weakenable CI behavior, and absence of raw detail.
- Existing Store compatibility, analysis, reporter, policy, rule, and
  deterministic golden suites remain green. Full repository checks run before
  push on every supported local lane available to the existing workflow.

## Out of scope

- Central collection, dashboards, employee or team rankings, and control plane.
- Logical-repository providers, monorepo workspace discovery, or cross-workspace
  authorization.
- Cache-state inference or a new cache instrumentation subsystem.
- Aggregate/history SQL tables, rolling materialized views, backfill, or
  rewriting existing snapshot payloads.
- Report v3, export, encryption, quota, retention, R004/R005 redesign, and
  machine/provider/network/model cohort dimensions.
