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
      base_ref_digest: string;
      head_ref_digest: string;
    }
  | {
      kind: "inferred_local_range";
      base_ref_digest: string;
      head_ref_digest: string;
    };
```

An explicit `A..B` and `A...B` therefore remain distinct even though the
existing display `pr_ref` canonicalizes both to `A...B`. A current or explicitly
selected GitHub PR uses the numeric PR identity. A local fallback without GitHub
metadata uses `inferred_local_range`.

The two ref digests are produced before any display-label canonicalization.
Each input token is normalized to NFC and hashed in a role- and selector-kind-
separated domain. Thus `refs/heads/release`, `refs/tags/release`,
`refs/remotes/origin/release`, `release`, and `HEAD` remain different selector
values even when they resolve to the same object ID or later produce the same
display label. Digests use the closed `sha256:<64 lowercase hex>` form; raw ref
tokens are never persisted in selector identity or aggregate output. The range
enum separately preserves `..` versus `...`. Empty ref tokens, unsafe PR
integers, malformed digests, unknown kinds or fields, and non-canonical objects
fail validation.

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
manifest's `aggregation_policy` is applied independently to each metric of a
rule:

- `never_aggregate`: contributes zero to every KPI. R004 therefore never
  becomes confirmed or possible savings; its observed wait remains human wait.
- `union`: eligible interval slices are unioned.
- `max`: exactly one eligible candidate is chosen separately for confirmed
  critical-path, upper critical-path, and resource cost. A winner on one axis
  does not become the winner on another axis.
- `sum`: numeric resource contributions are summed; critical-path interval
  slices are collected, but the final wall-clock union still removes overlap.

Eligibility is fail closed before comparison. A candidate is rejected when its
canonical impact kind disagrees with the manifest, its rule version or
compatibility epoch is not exact, its canonical fields are incomplete, or its
required interval placement is malformed or empty. Such a rejected
critical-path candidate increments `incomplete_interval_findings`. A confirmed
critical-path candidate additionally requires high evidence confidence, high
causality confidence, and full source coverage. An upper critical-path
candidate may have medium confidence but still requires complete canonical
impact and valid interval placement. `expected_ms` is presentation/calibration
information and is never used as an eligibility score or substituted for a
missing bound.

Every critical-path candidate carries its own interval slice clipped to
measured wall time and capped by the applicable canonical bound. For a `max`
rule, the confirmed score is the duration of that candidate's placed lower
slice, the upper score is the duration of its placed upper slice, and the
resource score is canonical `upper_ms`. Winners are selected separately using:

1. greatest eligible placed score;
2. greatest applicable canonical bound;
3. lexicographically smallest canonical finding key;
4. lexicographically smallest canonical interval signature.

The winning bound and interval always come from the same candidate; aggregation
never combines one finding's bound with another finding's placement. Therefore,
for example, a strict candidate placed at lower/upper `100/100` wins the
confirmed axis while a medium-confidence candidate placed at `0/200` wins the
upper axis. Malformed placement or an impact-kind mismatch is ineligible rather
than silently compared as zero.

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
E = full manifest-eligible critical-path upper envelope, including C
P = E - C
W = observed human-wait intervals - C - P
U = ledger unexplained intervals - C - P - W
N = M - C - P - W - U
```

`P` is an internal residual-possible set only; it is not the value stored as
`estimated_critical_path_upper_ms`. The stored numeric fields are the durations
of `M`, `C`, full envelope `E`, `W`, and `U`. The upper envelope is constructed
to contain `C`. For a `max` rule, the separately selected upper winner can add
only enough uncovered placement to reach the greater of its placed upper score
and that rule's confirmed duration; it cannot cause `confirmed + upper` to be
reported as two independent quantities. Global and per-rule interval ownership
is then assigned deterministically in `(manifest id, finding key, interval
signature)` order, so confirmed rule rows sum to `duration(C)` and upper rule
rows sum to `duration(E)` without overlap across rows.

For example, a lower placement of 1,000 ms and a full upper envelope of 1,500
ms are stored as confirmed `1,000` and estimated upper `1,500`; the residual
possible portion used by the partition is 500 ms. Consumers must never add the
two stored values.

All interval inputs are clipped to `M`; invalid, negative, non-finite, or
reversed intervals are ignored and recorded as incomplete. Because `C` is a
subset of `E`:

```text
C, P=(E-C), W, U, and N are pairwise disjoint
estimated_upper + human_wait + unexplained <= measured_wall
confirmed <= estimated_upper
resource_cost is not part of this wall-clock equation
```

Property tests generate overlaps, permutations, fractional bounds, missing
intervals, and hostile legacy records to hold this invariant. The terminal
snapshot validator independently rejects negative/non-finite values, a wall
sum `estimated_upper + human_wait + unexplained` over `measured_wall_ms`,
`confirmed > estimated_upper`, duplicate/non-canonical rule rows, or a rule-row
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

Analysis-time baseline and R006 comparisons receive the current opaque
`work_unit_key` separately. After projection and terminal selection, every
history entry with that exact key is excluded before cohort construction. The
raw display `unit.pr_ref` is never used as a prefilter: an older state of the
same work unit cannot become its own baseline, while a different selector with
the same display label remains an independent comparable work unit. Stats-wide
aggregation, which has no current work unit, keeps every selected terminal.

### R006 command cohorts

R006 does not reuse a single command key attached to the whole snapshot. Its
comparable population is all selected terminal snapshots with the same exact
repository ID, workspace ID, changed-file bucket, and changed-line bucket as
the current work unit. `history_count` is the size of that entire population,
including snapshots on which the command/cache pair is absent.

Within the population, the exact cohort key is a domain-separated opaque digest
of canonical `CommandIdentity` plus the exact cache state `cold` or `warm`.
`StoredCommandCost` gains an optional `cache_state: "cold" | "warm"`. A row
with an absent or unknown cache state is ineligible and is never placed into an
`unknown` cohort. Current sources do not reliably observe cache state, so this
intentionally suppresses R006 for ordinary current data until a source can
provide the dimension; complete programmatic/test records exercise the contract
now.

Multiple matching command rows in one terminal snapshot are deterministically
summed into one non-negative per-snapshot cost. `presence_count` is the number
of population snapshots whose combined cost is positive, so at most one sample
comes from each work unit. The distribution sample contains only those positive
per-snapshot costs and therefore `sample_count === presence_count`; absence is
not inserted as a zero distribution observation. The cost ratio is:

```text
sum(positive per-snapshot command/cache costs)
--------------------------------------------------------------
sum(measured_wall_ms across all history_count population rows)
```

Missing, non-finite, or zero population wall time suppresses the result. A
finding is emitted only when both `history_count` and
`sample_count === presence_count` meet the effective policy minimum and the
ratio is at least 0.30. This also subsumes the existing chronic-cost minimum of
3 because the effective policy floor is never below 5. Thus absence affects the
population denominator but not the positive-cost distribution, and a large
work-unit population can never expose a command/cache distribution built from a
smaller-than-policy sample.

The R006 finding key includes the opaque command-identity digest and cache
state. Its bounded evidence and stats output include `cache_state`,
`history_count`, `presence_count`, distribution `sample_count`, median, p50,
p75, MAD, and ratio. Cold and warm observations always produce distinct
findings and rows. The finding remains interval-less `resource_cost` with the
manifest's `max` aggregation policy.

The projected `buildChronicCostAggregates` evaluator returns closed
`ChronicCostAggregate` values containing only the opaque command key, cache
enum, bounded counts, distribution, ratio, and resource estimate. It does not
construct a `FindingCandidate` and never receives a raw command, command
identity, session reference, or fix recipe. For analysis only, core code outside
the evaluator builds a separate lookup from already-normalized selected terminal
records, keyed by the same opaque command digest. It joins a qualifying
aggregate back to its canonical command identity/display and deterministically
unioned session references through `materializeChronicCostFindings`, then uses
the existing candidate-construction boundary to retain an actionable target and
fix recipe. A missing or invalid join suppresses the finding rather than
fabricating session evidence. Stats consumes the bounded aggregate directly and
performs its optional command-label join outside the aggregator before the
existing display privacy projection. No raw lookup or joined object becomes
reachable from `StatsAggregationInput` or `ChronicCostAggregate`.

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

Every CLI analysis resolves the effective policy before invoking core analysis,
using the existing canonical repository-root and signed-policy resolver. The
resolved `minimum_cohort_size` is passed through `AnalyzeOptions` to both the
analysis-time work-unit baseline and R006 detector; neither component silently
falls back to 5 after a policy has been resolved. The stats command uses the
same resolver and passes the same effective value to aggregation. A direct
programmatic core caller that supplies no resolved policy may use the default
of 5, but there is no CLI or persisted-policy bypass.

The effective value is included in the canonical policy material used by
`AnalysisSnapshotIdentity.policy_digest`. Changing the floor therefore changes
snapshot identity as well as behavior, while remaining an analysis variant of
the same Git state for terminal selection. Tests cover default 5 and an
organization floor of 20: a five-snapshot cohort emits under the default but
both baseline and R006 remain suppressed under the organization floor until 20
comparable snapshots and at least 20 matching command/cache samples exist. A
repository value below 20 cannot weaken that floor.

The effective threshold gates terminal aggregate emission and every comparable
cohort distribution in `stats`, and it gates analysis-time baseline and R006 at
the point where those values are computed.

At fewer samples, metric values are absent rather than zero and metadata gives
`status: "suppressed"`, the effective threshold, actual sample count, and a
bounded reason code. No broader repository, size, command, or cache cohort is
used as a fallback.

## Stats report and privacy flow

Raw `AnalysisRecord` values are never inputs to the terminal/cohort aggregator.
`runStatsCommand` first uses the Store normalizers to validate a closed snapshot
of every history entry without invoking accessors or proxy traps. It then calls
`projectStatsAggregationInput`, whose return type contains only:

- opaque canonical digests for snapshot, work-unit, Git-state, repository,
  workspace, and command identity;
- finite non-negative times and counts;
- closed size-bucket and cache-state enums;
- finalized numeric metric and canonical per-rule rows.

The closed shape is equivalent to:

```ts
interface StatsAggregationInput {
  schema_version: 1;
  snapshot_id: OpaqueDigest;
  created_at_ms: number;
  work_unit_key?: OpaqueDigest;
  git_state_key?: OpaqueDigest;
  repository_key?: OpaqueDigest;
  workspace_key?: OpaqueDigest;
  changed_files_bucket?: ChangedFilesBucket;
  changed_lines_bucket?: ChangedLinesBucket;
  terminal_metrics?: {
    measured_wall_ms: number;
    confirmed_critical_path_ms: number;
    estimated_critical_path_upper_ms: number;
    resource_cost_ms: number;
    human_wait_ms: number;
    unexplained_ms: number;
    rules: readonly CanonicalNumericRuleRow[];
  };
  baseline_metrics: readonly {
    metric: BoundedBaselineMetric;
    value: number;
  }[];
  command_costs: readonly {
    command_key: OpaqueDigest;
    cache_state: "cold" | "warm";
    duration_ms: number;
  }[];
  reason_codes: readonly StatsInputReason[];
}
```

`BoundedBaselineMetric`, both bucket types, and `StatsInputReason` are closed
allowlists; unknown legacy metric names are ignored rather than copied. Missing
optional keys are enough to count and explain an ineligible row without carrying
the raw value that failed eligibility.

It contains no raw selector token, repository path, command argv/cwd/executor,
finding, evidence, interval, title, URL, prompt, or session data. The terminal
selector, metric reducer, distributions, and R006 cohort code accept only
`readonly StatsAggregationInput[]`; their public types do not expose the source
record. Canary tests serialize the projection and inspect the aggregator input
to prove raw values are unavailable, not merely omitted at render time.

The full flow is:

```text
raw Store history
  -> strict closed validation/snapshot
  -> project numeric/bounded/opaque StatsAggregationInput
  -> select terminals and aggregate metrics/cohorts in memory
  -> optionally join selected opaque snapshot/command keys to normalized
     records for legacy observational and privacy-governed command display
  -> project the selected display privacy profile
  -> render JSON or TTY
```

Malformed objects, accessors, and proxies fail before aggregation. The optional
display join is outside the terminal/cohort aggregator, is keyed only by its
opaque selections, and its result must still pass through the existing display
privacy projection. No raw record reference is retained in aggregation input or
output.

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
   `refs/heads/x`, `refs/tags/x`, `refs/remotes/origin/x`, and `x` remain
   distinct even when they resolve to the same object ID.
5. Different repositories with the same PR number remain distinct.
6. Legacy/content-fallback snapshots and malformed or absent selector metadata
   remain readable but are not enterprise KPI samples.
7. A terminal snapshot missing metrics is suppressed; an older complete
   snapshot is not substituted.
8. Unknown workspace, truncated/binary diff size, malformed bucket data, and
   non-finite or unsafe counts suppress instead of broadening a cohort.
9. Size-bucket boundary values are inclusive exactly as listed.
10. Missing or malformed command identities cannot form an R006 cohort; valid
    identities are converted to opaque digests before aggregation.
11. Missing command cache state suppresses R006; `cold` and `warm` never mix or
    share finding keys.
12. R006 history includes comparable terminal snapshots where the command is
    absent, presence and distribution include only positive per-snapshot cost,
    and the ratio denominator includes measured wall for the full population.
    Both population and positive command/cache sample count must meet the
    effective policy floor.
13. A cohort one below the effective minimum is suppressed; one exactly at it
    is emitted.
14. Default 5 and a resolved organization floor of 20 affect analysis-time
    baseline, R006, snapshot policy digest, and stats consistently. Repository
    policy below the organization minimum has no effect; a higher value tightens
    it.
15. Odd/even cohorts, repeated values, zero MAD, fractional values, and input
    permutations produce deterministic distributions.
16. Overlapping findings within and across rules never double-count wall time.
17. A 1,000 ms lower placement with a 1,500 ms full upper envelope reports
    confirmed 1,000 and upper 1,500; the partition uses only the 500 ms residual
    and consumers never add confirmed to upper.
18. `never_aggregate` findings remain outside KPIs even if high confidence.
19. `max`, `union`, and `sum` use their manifest meanings. `max` selects each
    metric independently: strict `100/100` can win confirmed while medium
    `0/200` wins upper. Malformed placement and impact-kind mismatch fail
    closed; expected-only and interval-less critical impacts never become
    confirmed wall time.
20. R006's interval-less historical upper can appear only on the separate
    resource axis under manifest `max`.
21. Legacy scalar point estimates, partial canonical fields, non-high evidence
    or causality, incomplete source coverage, and invalid intervals all produce
    zero confirmed time.
22. Resource cost never participates in the measured-wall partition equation.
23. Aggregation input contains no raw selector, repository, workspace, command,
    path, URL, token, finding, interval, or evidence data.
24. Strict and balanced stats output contains no raw selector, repository,
    workspace, command identity, path, URL, token, or evidence payload.
25. Aggregate and cohort values are never persisted to a new table, and stats
    never modifies raw snapshot records.

## Verification strategy

- Store tests prove additive selector parsing, history entry metadata, exact
  execution deduplication, and superseded-state rerun behavior.
- Git-context tests prove selector-kind, `..`/`...`, and exact ref-domain digest
  distinctions across local, branch, tag, and remote-qualified tokens.
- Ledger/aggregation unit and property tests prove manifest policy behavior,
  per-metric `max` winners, full-upper versus residual partition semantics,
  interval clipping/deduplication, fail-closed legacy handling, and the wall
  partition invariant.
- Cohort tests prove bucket boundaries, terminal-only populations, robust
  distributions, separate R006 command/cache populations and denominators,
  cache suppression, current-work-unit exclusion by opaque key, bounded
  aggregate-to-finding materialization, and default-5/organization-20
  population-and-sample threshold boundaries.
- Policy/config tests prove bounds, canonical signature compatibility, and
  organization-over-repository monotonicity, analysis-time resolution, and
  effective-floor inclusion in snapshot policy identity.
- Reporter/CLI tests prove additive JSON and TTY output, strict privacy,
  numeric/opaque aggregation projection before terminal selection,
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
