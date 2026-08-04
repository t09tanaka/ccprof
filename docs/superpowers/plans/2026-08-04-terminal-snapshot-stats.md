# Terminal Snapshot Statistics and Comparable Cohorts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stats select one terminal Git state per canonical work unit, emit five non-confused impact dimensions, and publish robust distributions only for policy-sized comparable cohorts.

**Architecture:** Extend existing snapshot envelopes with selector semantics and expose read-only snapshot history entries without changing Store tables. Finalize a small numeric terminal summary from canonical findings, Rule Manifest policies, and ledger intervals during analysis. Strictly normalize history and project it to numeric/bounded/opaque aggregation inputs before terminal selection or cohort calculation; only display-safe results pass to rendering. Work-unit distributions and per-command R006 cohorts are separate, the effective policy floor is resolved before analysis, and any unknown required dimension suppresses instead of broadening the cohort.

**Tech Stack:** TypeScript 5.9, Node.js built-in test runner, better-sqlite3 Store, existing interval ledger, Rule Manifest, repository/signed-organization policy, and JSON Schema.

---

## File map

- `src/git/pr-context.ts`: preserve selector kind and explicit range operator.
- `src/core/model.ts`: additive robust baseline distribution fields.
- `src/core/ledger.ts`: expose observed wait intervals needed by the disjoint enterprise partition.
- `src/git/diff.ts`: calculate authoritative changed-line count or mark it unavailable.
- `src/analysis/stats-input.ts`: strict raw-history normalization and numeric/bounded/opaque aggregation projection.
- `src/analysis/stats-aggregation.ts`: cohort buckets, manifest reducer, terminal selector, distributions, and invariants.
- `src/store/analyses.ts`: optional terminal snapshot/cohort persistence, per-command cache state, snapshot-aware history entries, and validation.
- `src/commands/analyze.ts`: resolve canonical repository policy before invoking core analysis.
- `src/core/analyze.ts`: build selector identity, cohort dimensions, and finalized terminal statistics; consume terminal/cohort history for baseline and R006.
- `src/rules/chronic-cost.ts`: compare only terminal per-command cohorts and suppress unknown cache state.
- `src/policy/organization-policy.ts`: bounded monotonic minimum cohort size.
- `src/analysis/repository-config.ts`: repository policy parser for minimum cohort size.
- `schemas/organization-policy.schema.json`: optional signed organization floor.
- `schemas/config.schema.json`: optional tightening repository floor.
- `src/commands/stats.ts`: normalize/project snapshot entries and pass effective policy threshold to aggregation.
- `src/reporters/stats.ts`: terminal-only report model, five metrics, robust cohort metadata, and confirmed-only rule minutes.
- `src/reporters/privacy.ts`: clone/project new bounded stats fields and stamp the selected profile.
- `test/git.test.ts`: selector and diff-count tests.
- `test/store.test.ts`: Store compatibility, snapshot metadata, rerun, cohort baseline, and R006 tests.
- `test/ledger.test.ts`: observed-wait and partition fixtures.
- `test/rules-secondary.test.ts`: manifest aggregation and R006 command-cohort tests.
- `test/organization-policy.test.ts`: schema, canonical signature, bounds, and monotonicity.
- `test/reporters-and-cli.test.ts`: terminal stats, distribution, privacy, TTY/JSON, and CI tests.
- `test/analyze-integration.test.ts`: analysis-time finalized snapshot integration.
- `README.md`: user-visible terminal/cohort/statistics semantics and policy field.

## Task 1: Canonical selector semantics and snapshot-aware history

**Files:**
- Modify: `src/git/pr-context.ts`
- Modify: `src/store/analyses.ts`
- Test: `test/git.test.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Use LanguageService semantic references before changing shared contracts**

Run `mcp__ts_rename_helper__planRenameSymbol` without applying edits for
`ExplicitRange`, `PrContext`, `AnalysisSnapshotIdentity`, and
`AnalysisHistoryResult` under `tsconfig.test.json`. Also inspect semantic
references to the existing display-label canonicalizer so it is not reused for
identity. Record every production and test consumer in the task checkpoint.

- [ ] **Step 2: Write selector and history-entry RED tests**

Add exact cases proving:

```ts
assert.equal(parseExplicitRange("main..feature")?.range, "double_dot");
assert.equal(parseExplicitRange("main...feature")?.range, "triple_dot");

assert.deepEqual(explicitContext.selector, {
  kind: "explicit_range",
  range: "double_dot",
  base_ref_digest: selectorRefDigest("explicit_range", "base", "main"),
  head_ref_digest: selectorRefDigest("explicit_range", "head", "feature"),
});
assert.deepEqual(prContext.selector, { kind: "github_pr", number: 42 });
assert.deepEqual(localContext.selector, {
  kind: "inferred_local_range",
  base_ref_digest: selectorRefDigest(
    "inferred_local_range", "base", "origin/main"),
  head_ref_digest: selectorRefDigest(
    "inferred_local_range", "head", "feature"),
});
```

Before the existing label stripper runs, create identities for
`refs/heads/release`, `refs/tags/release`,
`refs/remotes/origin/release`, `release`, and `HEAD`; assert every exact NFC
token has a different `sha256:<64 lowercase hex>` digest even when the mocked
Git runner resolves them to the same OID. Also assert the selector identity for
`release..HEAD` differs from `release...HEAD`. No raw token may occur in the
serialized snapshot selector.

In Store tests, save state A at 1,000 ms, state B at 2,000 ms, and another
snapshot variant of state A at 3,000 ms. Assert `loadAnalyses().records` stays
read-compatible and `entries` exposes exact `snapshot_id`, normalized identity,
and the oldest execution for each exact snapshot. Include an old identity with
no selector and a content-fallback legacy record.

- [ ] **Step 3: Delegate RED verification**

Delegate to a verifier subagent:

```bash
npm run build:test && node --test \
  .test-dist/test/git.test.js \
  .test-dist/test/store.test.js
```

Expected: compile or assertion failures because range kind, selector identity,
and history entries do not exist. The verifier must report failing test names
and confirm existing neighboring tests still pass.

- [ ] **Step 4: Implement the minimal selector and history contracts**

Add:

```ts
export type AnalysisSelectorIdentity =
  | { kind: "github_pr"; number: number }
  | { kind: "explicit_range"; range: "double_dot" | "triple_dot";
      base_ref_digest: string; head_ref_digest: string }
  | { kind: "inferred_local_range";
      base_ref_digest: string; head_ref_digest: string };

export interface AnalysisHistoryEntry {
  snapshot_id: string;
  identity: AnalysisSnapshotIdentity | { mode: "content-fallback" };
  record: AnalysisRecord;
}
```

Make `ExplicitRange.range` and `PrContext.selector` required for newly resolved
contexts. Build selector ref digests from the exact NFC tokens in role- and
selector-kind-separated hash domains before any display canonicalization. Add
optional `selector` to `AnalysisSnapshotIdentity`, normalize it as a closed data
object, and keep selector-less v1 envelopes valid. Return additive `entries`
from `loadAnalyses` while leaving `records` unchanged.

- [ ] **Step 5: Delegate GREEN verification, then review and commit**

Delegate the Task 1 command again. After GREEN, dispatch exact spec review and
then code-quality review. Fix each issue with a new RED/GREEN cycle. Commit:

```bash
git add src/git/pr-context.ts src/store/analyses.ts test/git.test.ts test/store.test.ts
git commit -m "feat: expose canonical analysis snapshot selectors"
```

## Task 2: Versioned minimum-cohort policy

**Files:**
- Modify: `src/policy/organization-policy.ts`
- Modify: `src/analysis/repository-config.ts`
- Modify: `schemas/organization-policy.schema.json`
- Modify: `schemas/config.schema.json`
- Test: `test/organization-policy.test.ts`

- [ ] **Step 1: Use LanguageService semantic references**

Inventory `OrganizationPolicy`, `RepositoryPolicyPreferences`,
`EffectivePolicy`, `resolveEffectivePolicy`, and
`loadRepositoryPolicyPreferences` with `planRenameSymbol` before editing.

- [ ] **Step 2: Write policy RED tests**

Add cases for the exact contract:

```ts
export const DEFAULT_MINIMUM_COHORT_SIZE = 5;
export const MINIMUM_COHORT_SIZE = 3;
export const MAXIMUM_COHORT_SIZE = 1_000;

assert.equal(resolveEffectivePolicy({ request }).minimum_cohort_size, 5);
assert.equal(resolveEffectivePolicy({
  organization: policy({ minimum_cohort_size: 20 }),
  repository: { minimum_cohort_size: 10 }, request,
}).minimum_cohort_size, 20);
assert.equal(resolveEffectivePolicy({
  organization: policy({ minimum_cohort_size: 10 }),
  repository: { minimum_cohort_size: 20 }, request,
}).minimum_cohort_size, 20);
```

Reject 2, 1,001, fractional, non-finite, accessor, proxy, unknown-key, and
schema-invalid values. Prove an organization policy omitting the field retains
the exact pre-change canonical bytes; prove a present field has one fixed
canonical position and verifies under its detached signature.

- [ ] **Step 3: Delegate RED verification**

```bash
npm run build:test && node --test .test-dist/test/organization-policy.test.js
```

Expected: missing-field/type/schema assertions fail for the new optional floor.

- [ ] **Step 4: Implement bounded monotonic policy**

Add optional `minimum_cohort_size` to signed and repository policies and a
required effective value. Validate 3..1,000 safe integers. Resolve with:

```ts
minimum_cohort_size: Math.max(
  DEFAULT_MINIMUM_COHORT_SIZE,
  organization?.minimum_cohort_size ?? DEFAULT_MINIMUM_COHORT_SIZE,
  repository?.minimum_cohort_size ?? DEFAULT_MINIMUM_COHORT_SIZE,
)
```

Append the optional signed field after `required_source_coverage` in canonical
JSON so omission preserves old bytes. Add optional JSON Schema properties
without adding them to `required`.

- [ ] **Step 5: Delegate GREEN verification, review, and commit**

After the focused command is GREEN, run spec then quality review and commit:

```bash
git add src/policy/organization-policy.ts src/analysis/repository-config.ts \
  schemas/organization-policy.schema.json schemas/config.schema.json \
  test/organization-policy.test.ts
git commit -m "feat: add monotonic cohort privacy floor"
```

## Task 3: Complete diff-size and ledger inputs

**Files:**
- Modify: `src/git/diff.ts`
- Modify: `src/core/ledger.ts`
- Test: `test/git.test.ts`
- Test: `test/ledger.test.ts`

- [ ] **Step 1: Inventory shared references with LanguageService**

Use semantic rename plans for `DiffEvidence`, `FileDiffEvidence`, `LedgerResult`,
and `reconcileLedger`. Do not apply the plans.

- [ ] **Step 2: Write RED tests for observable dimensions**

Prove text patches count additions plus deletions while ignoring `+++`, `---`,
and hunk headers. Assert `changedLineCount` is absent for truncated, unpaired,
or binary patch evidence. Add a ledger assertion that
`observedHumanWaitIntervals` is the human-wait/active intersection before any
finding attribution removes it.

- [ ] **Step 3: Delegate RED verification**

```bash
npm run build:test && node --test \
  .test-dist/test/git.test.js \
  .test-dist/test/ledger.test.js
```

Expected: the new diff field and observed-wait ledger field are absent.

- [ ] **Step 4: Implement minimal fields**

Have `parsePatchSection` return addition/deletion counts while preserving
existing `addedLines`. Set `DiffEvidence.changedLineCount` only when every
section is paired, complete, non-binary, and untruncated. In the ledger, retain:

```ts
const observedHumanWaitIntervals = intersectIntervals(
  input.humanWaitIntervals ?? [],
  activeIntervals,
);
```

Use it to derive the existing post-attribution `humanWaitIntervals` and expose
a cloned canonical union in `LedgerResult`.

- [ ] **Step 5: Delegate GREEN verification, review, and commit**

After GREEN and both reviews:

```bash
git add src/git/diff.ts src/core/ledger.ts test/git.test.ts test/ledger.test.ts
git commit -m "feat: expose complete stats dimensions"
```

## Task 4: Manifest-driven terminal metric reducer

**Files:**
- Create: `src/analysis/stats-aggregation.ts`
- Modify: `src/store/analyses.ts`
- Test: `test/rules-secondary.test.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Write reducer RED tests before production code**

Drive the wished-for API:

```ts
const snapshot = buildTerminalStatsSnapshot({
  repositoryId: repoHash,
  workspaceId: workspaceHash,
  changedFiles: 4,
  changedLines: 199,
  ledger,
  candidates,
});

assert.equal(snapshot.confirmed_critical_path_ms, 1_000);
assert.equal(snapshot.estimated_critical_path_upper_ms, 1_500);
assert.equal(snapshot.human_wait_ms, 250);
assert.equal(snapshot.unexplained_ms, 125);
assert.equal(snapshot.resource_cost_ms, 4_000);
assert.ok(
  snapshot.estimated_critical_path_upper_ms +
    snapshot.human_wait_ms + snapshot.unexplained_ms <=
      snapshot.measured_wall_ms,
);
assert.ok(
  snapshot.confirmed_critical_path_ms <=
    snapshot.estimated_critical_path_upper_ms,
);
```

This fixture must prove that the stored upper is the full envelope: confirmed
1,000 plus only a 500 residual partition, never an upper value of 500 and never
a `confirmed + stored upper` wall equation.

Cover each current manifest policy: R001/R002/R003/R008 union, R007 max,
R005/R006 resource max, and R004 never. Cover overlaps across rules, a max tie,
sum through an injected manifest fixture, expected-only variation, missing
intervals, intervals outside measured wall, fractional bounds, reversed input,
legacy/partial canonical findings, non-high confidence, incomplete source, and
R006 without intervals. Add deterministic permutation loops and a seeded
property loop asserting the partition equation and per-rule/total consistency.

Add an exact `max` fixture with a strict lower/upper `100/100` candidate and a
medium-confidence lower/upper `0/200` candidate. Assert the strict candidate
wins confirmed at 100 while the medium candidate wins the full upper at 200.
Assert winner comparison is, independently per metric: greatest eligible
placed score, greatest applicable canonical bound, lexicographically smallest
finding key, then smallest interval signature. An impact-kind mismatch,
malformed/empty critical interval, wrong version/epoch, or partial canonical
impact must fail closed and increment the bounded incomplete count where
applicable. Never combine one candidate's bound with another candidate's
interval.

- [ ] **Step 2: Delegate RED verification**

```bash
npm run build:test && node --test \
  .test-dist/test/rules-secondary.test.js \
  .test-dist/test/store.test.js
```

Expected: module/API missing failures only; fixture construction must compile up
to the missing import.

- [ ] **Step 3: Implement the reducer and closed validator**

Export `TerminalStatsSnapshotV1`, `buildTerminalStatsSnapshot`, and
`normalizeTerminalStatsSnapshot`. Implement deterministic interval slicing and
global wall union with:

```text
C = eligible lower union
E = full eligible upper envelope including C
P = E - C
W = observed wait - C - P
U = unexplained - C - P - W
```

Store `duration(E)` as `estimated_critical_path_upper_ms`; `P` exists only for
the disjoint partition. Use `ruleManifest(rule_id)` for every decision. Reject
impact-kind mismatch, wrong version/epoch, partial canonical data, and invalid
critical placement before comparison. Critical paths without valid interval
placement contribute zero and increment the incomplete count. Apply `max`
separately to confirmed placement, upper placement, and resource upper; apply
numeric sum/max only to the resource axis. Keep each candidate's bound and
interval attached through winner selection. For a `max` rule, begin its upper
envelope with confirmed placement and add only enough uncovered upper-winner
placement to reach `max(confirmed duration, upper winner score)`. Assign
overlapping per-rule wall contributions in
`(manifest id, finding key, interval signature)` order so
confirmed rows sum to `duration(C)` and upper rows sum to `duration(E)`.

The normalizer must snapshot plain data without invoking accessors/proxies and
reject unknown fields, invalid IDs/versions, duplicate or unsorted rule rows,
negative/non-finite/-0 metrics, `confirmed > estimated_upper`,
`estimated_upper + W + U > M`, or rule sums inconsistent with totals.

- [ ] **Step 4: Persist the optional snapshot summary compatibly**

Add `terminal_stats_snapshot?: TerminalStatsSnapshotV1` to
`AnalysisRecordInput` and `AnalysisRecord`. `makeAnalysisRecord` clones and
normalizes it; `isRecord`, legacy reads, snapshot writes, and snapshot reads
accept omission but reject malformed presence. Do not add a SQLite table or
migration.

- [ ] **Step 5: Delegate GREEN verification, review, and commit**

After GREEN and two-stage review:

```bash
git add src/analysis/stats-aggregation.ts src/store/analyses.ts \
  test/rules-secondary.test.ts test/store.test.ts
git commit -m "feat: finalize manifest-driven terminal metrics"
```

## Task 5: Analysis integration and robust work-unit baseline

**Files:**
- Modify: `src/commands/analyze.ts`
- Create: `src/analysis/stats-input.ts`
- Modify: `src/core/model.ts`
- Modify: `src/core/analyze.ts`
- Modify: `src/store/analyses.ts`
- Modify: `src/analysis/stats-aggregation.ts`
- Test: `test/analyze-integration.test.ts`
- Test: `test/organization-policy.test.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Inventory baseline and analysis contracts with LanguageService**

Use semantic plans for `BaselineNotable`, `BaselineComparison`,
`AnalysisRecord`, `computeBaseline`, `AnalyzeOptions`,
`AnalyzeCommandDependencies`, and `snapshotIdentity`.

- [ ] **Step 2: Write RED integration and distribution tests**

Assert a normal analysis writes selector identity and a terminal summary with
exact repository/workspace hashes, file/line counts, ledger-derived fields, and
manifest rows. A truncated or binary diff omits changed lines and later
suppresses its cohort.

For `cohortDistribution([1, 2, 3, 100])`, assert:

```ts
assert.deepEqual(cohortDistribution([1, 2, 3, 100]), {
  median: 2.5,
  p50: 2.5,
  p75: 27.25,
  mad: 1,
  sample_count: 4,
});
```

Prove fixed bucket boundaries, input permutation invariance, exact-repository
and workspace matching, missing-line suppression, terminal-only prior samples,
and threshold behavior at 4/5 and 5/5. Through `runAnalyzeCommand`, capture the
options passed to core analysis and prove policy resolution occurs first using
the canonical Store repo root. Assert an omitted policy passes effective 5; a
signed organization floor of 20 passes 20, suppresses a 5-snapshot baseline,
and emits at 20. A repository floor below 20 must not weaken it. Identical
analysis inputs under floors 5 and 20 must produce different
`policy_digest` values. Assert legacy mean-only baseline fields remain readable
but are not presented as robust distributions.

Project history for baseline selection and cover the A-at-1,000/B-at-2,000/
A-variant-at-3,000 sequence here: B must remain terminal because Git-state
first-seen is the minimum across A variants. The baseline helper must accept
only projected numeric/bounded/opaque inputs, not `AnalysisRecord`. Pass the
current opaque work-unit key separately and prove every state of that exact work
unit is excluded. Also give a different explicit/inferred selector the same
display `unit.pr_ref` and prove it remains in the cohort; no raw `pr_ref`
prefilter is permitted.

- [ ] **Step 3: Delegate RED verification**

```bash
npm run build:test && node --test \
  .test-dist/test/analyze-integration.test.js \
  .test-dist/test/organization-policy.test.js \
  .test-dist/test/store.test.js
```

- [ ] **Step 4: Implement analysis finalization and robust baseline**

Build one cohort context immediately after diff and ledger finalization. Use the
Store repo hash for `repository_id` and a domain-separated hash of the exact
canonical repo root for `workspace_id`. Pass finalized metrics to every full
record save path, including budgeted output after finalization; partial early
budget exits omit it.

At the start of `runAnalyzeCommand`, resolve `StorePaths` from the requested
working directory, resolve the existing effective policy once against
`paths.canonical_repo`, and only then call core analysis. Pass the paths and
`effectivePolicy.minimum_cohort_size` through `AnalyzeOptions`. Reuse that same
resolved policy for output privacy/advisory decisions. Direct core callers that
omit the option receive the constant default 5; command callers never silently
fall back after resolution. Include the effective minimum in the fixed
`analysis-policy-v1` material used by `snapshotIdentity().policy_digest`.

Extend `BaselineNotable` additively with optional `median`, `p50`, `p75`, `mad`,
and `sample_count`. Replace the recent-10 arithmetic mean in new baseline
generation with terminal work-unit cohort selection and the configured/default
minimum passed through `AnalyzeOptions`. Create the strict
`projectStatsAggregationInput` boundary and terminal selector needed by this
baseline now; neither `computeBaseline` nor the selector may accept raw records.
Replace the existing display-`pr_ref` history prefilter with exact projected
`work_unit_key !== currentWorkUnitKey` filtering after terminal selection. Keep
`baseline` equal to `median` for the existing scalar field.

- [ ] **Step 5: Delegate GREEN verification, review, and commit**

```bash
git add src/commands/analyze.ts src/analysis/stats-input.ts src/core/model.ts \
  src/core/analyze.ts src/store/analyses.ts src/analysis/stats-aggregation.ts \
  test/analyze-integration.test.ts test/organization-policy.test.ts \
  test/store.test.ts
git commit -m "feat: build comparable work-unit baselines"
```

## Task 6: Terminal selector and stats aggregation

**Files:**
- Modify: `src/analysis/stats-input.ts`
- Modify: `src/analysis/stats-aggregation.ts`
- Modify: `src/reporters/stats.ts`
- Test: `test/reporters-and-cli.test.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Write terminal selection RED tests**

Construct entries for two repositories, colliding PR display labels under
different selector kinds, explicit double/triple ranges, several Git states,
exact execution duplicates, and the A/B/A-rerun sequence. Assert:

```ts
const selected = selectTerminalSnapshots(entries);
assert.deepEqual(selected.terminals.map((entry) => entry.snapshot_id), [stateB]);
assert.equal(selected.metadata.superseded_snapshot_count, 2);
assert.equal(selected.metadata.ineligible_snapshot_count, 0);
```

Then make the terminal entry incomplete while an older entry is complete and
assert the work unit is suppressed rather than falling back. Prove exact-time
ties use state/snapshot digests.

Pass each raw history fixture through `projectStatsAggregationInput` before
selection. Its closed output may contain only opaque snapshot/work-unit/
Git-state/repository/workspace/command digests, created time, finite
non-negative numeric values, canonical rule rows, and bounded size/cache/status
enums. Inject unique canaries into selector tokens, repo paths, command
argv/cwd/executor, findings, evidence, intervals, titles, URLs, prompts, and
session IDs; assert the serialized projection contains none and that no raw
record reference is reachable. Hostile accessors/proxies and unknown fields
must be rejected before the selector is called.

- [ ] **Step 2: Write stats RED tests**

At an effective minimum of 5, assert four eligible terminals produce absent
aggregate values plus `below_minimum`; five produce exact sums of the five
separate metrics and confirmed-only `rule_minutes`. Assert resource, possible,
wait, and unexplained never enter confirmed rule minutes. Recurring/adoption
counts must use terminals only.

- [ ] **Step 3: Delegate RED verification**

```bash
npm run build:test && node --test \
  .test-dist/test/reporters-and-cli.test.js \
  .test-dist/test/store.test.js
```

- [ ] **Step 4: Implement terminal-only stats**

Implement state first-seen selection from projected snapshot inputs. Replace
the selector API with one that accepts only `readonly StatsAggregationInput[]`.
`StatsAggregationInput` is built in `src/analysis/stats-input.ts` after closed
Store validation and carries optional finalized numeric metrics plus only the
opaque/bounded fields listed above. It never carries `AnalysisRecord`, finding,
evidence, raw selector/ref, raw repository/workspace path, command identity, or
interval fields. Replace the population passed through aggregate stats sections
with projected terminal inputs. Add bounded
metadata carrying stored, terminal, superseded, ineligible, and sample counts,
effective minimum, status, and stable reason codes. Emit one numeric terminal
aggregate only when the terminal eligible sample count meets the floor.

Keep `history_count` for compatibility but set it to distinct terminal work
units and render `History: N terminal work units`. Return selected opaque
snapshot IDs so the orchestrator may join normalized terminal records for the
legacy observational recurrence/adoption sections and privacy-governed command
display outside the aggregator. Keep JSON keys stable and add the new metric and
metadata objects in fixed order.

- [ ] **Step 5: Delegate GREEN verification, review, and commit**

```bash
git add src/analysis/stats-input.ts src/analysis/stats-aggregation.ts \
  src/reporters/stats.ts \
  test/reporters-and-cli.test.ts test/store.test.ts
git commit -m "feat: aggregate terminal work-unit snapshots"
```

## Task 7: Comparable per-command R006 cohorts

**Files:**
- Modify: `src/store/analyses.ts`
- Modify: `src/analysis/stats-input.ts`
- Modify: `src/rules/chronic-cost.ts`
- Modify: `src/core/analyze.ts`
- Modify: `src/reporters/stats.ts`
- Test: `test/store.test.ts`
- Test: `test/rules-secondary.test.ts`
- Test: `test/reporters-and-cli.test.ts`

- [ ] **Step 1: Inventory changed R006 contracts with LanguageService**

Use semantic plans without applying edits for `detectChronicCost`,
`StoredCommandCost`, `FindingCandidate`, and `StatsChronicCommand`. Record every
production and test caller before replacing the detector with the planned new
`ChronicCostAggregate`, `buildChronicCostAggregates`, and
`materializeChronicCostFindings` boundaries.

- [ ] **Step 2: Write R006 RED tests**

Add optional `cache_state` fixtures to individual command costs. Prove:

- duplicate/superseded snapshots do not raise history or presence counts;
- different work-unit buckets, command identities, or cold/warm states do not
  join;
- a population snapshot where the pair is absent increases `history_count` and
  the measured-wall denominator but not `presence_count`/`sample_count`;
- multiple same-pair rows within one snapshot sum into one positive sample;
- any missing/unknown cache state makes that row ineligible rather than joining
  an `unknown` bucket;
- `cold` and `warm` create different finding keys and bounded output rows;
- both `history_count` and positive `sample_count === presence_count` must meet
  the exact effective minimum before median/p50/p75/MAD or a finding is emitted;
- the ratio is `sum(pair cost) / sum(measured wall for all history rows)`, uses
  the existing `>= 0.30` threshold, and suppresses zero/missing wall time;
- a default floor of 5 emits at history 5, but an organization floor of 20
  remains suppressed at history 20/presence 3 and emits only at history
  20/presence 20;
- the exact current `work_unit_key` is removed after terminal selection, while
  a different selector with the same display `pr_ref` remains in the population;
- the projected evaluator returns a bounded `ChronicCostAggregate` without raw
  command/session/fix data; core materialization joins a valid aggregate to a
  normalized opaque-key lookup and produces a valid actionable candidate with
  real session refs, while a missing/invalid join emits no candidate;
- a cohort below the minimum emits no R006 finding or chronic-command row;
- the R006 finding remains interval-less `resource_cost`, and the snapshot
  reducer applies manifest `max` only on the separate resource axis.

- [ ] **Step 3: Delegate RED verification**

```bash
npm run build:test && node --test \
  .test-dist/test/store.test.js \
  .test-dist/test/rules-secondary.test.js \
  .test-dist/test/reporters-and-cli.test.js
```

- [ ] **Step 4: Implement projected cohort evaluation and candidate materialization**

Normalize `StoredCommandCost.cache_state` as absent, `cold`, or `warm` without
accessors. In `projectStatsAggregationInput`, replace every eligible canonical
command identity with a domain-separated opaque digest and retain only that
digest, exact cache enum, and finite non-negative cost. Replace the current
detector with `buildChronicCostAggregates`, accepting projected terminal
history, a current opaque work-unit key/cohort, and the already-resolved
`AnalyzeOptions.minimumCohortSize`. Remove that exact work-unit key only after
terminal selection; never prefilter on display `pr_ref`. The comparable
population is every remaining terminal with the same repository/workspace and
file/line buckets; its size is
`history_count` even when the pair is absent. Within it, group by exact opaque
command digest plus exact cache state. Combine duplicate rows to one
per-snapshot positive cost and return closed `ChronicCostAggregate` objects
containing no raw history reference. Set
`presence_count = sample_count` from positive rows only, but divide summed cost
by measured wall summed across the full `history_count` population. Require
both history and positive sample count at the effective floor, ratio at least
0.30, and a positive finite denominator.

Outside the evaluator, build an internal normalized command lookup from the
selected records, keyed by opaque command digest.
`materializeChronicCostFindings` joins a qualifying aggregate to canonical
command identity/display plus deterministic session refs, then calls the
existing finding-candidate boundary so target and fix recipe remain actionable.
Missing/invalid joins suppress rather than invent evidence. Stats consumes the
bounded aggregate and joins a display label only outside aggregation before
privacy projection.

Include opaque command digest and cache state in the finding key. Expose bounded
`cache_state`, `history_count`, `presence_count`, `sample_count`, ratio, median,
p50, p75, and MAD in aggregate evidence/stats output. Ensure cold and warm never
collide. Do not pass raw command values, identities, session refs, or lookup
objects into the cohort evaluator or `ChronicCostAggregate`.

Do not attach one command key to the snapshot cohort. Do not infer cache state.

- [ ] **Step 5: Delegate GREEN verification, review, and commit**

```bash
git add src/store/analyses.ts src/analysis/stats-input.ts \
  src/rules/chronic-cost.ts src/core/analyze.ts src/reporters/stats.ts \
  test/store.test.ts test/rules-secondary.test.ts \
  test/reporters-and-cli.test.ts
git commit -m "feat: scope chronic costs to command cohorts"
```

## Task 8: Privacy-projected CLI output and documentation

**Files:**
- Modify: `src/commands/stats.ts`
- Modify: `src/reporters/privacy.ts`
- Modify: `src/reporters/stats.ts`
- Modify: `README.md`
- Test: `test/reporters-and-cli.test.ts`
- Test: `test/organization-policy.test.ts`

- [ ] **Step 1: Use LanguageService semantic references**

Inventory `StatsCommandDependencies`, `StatsReport`, `projectStatsPrivacy`,
`renderStatsJson`, and `renderStatsTty` before the shared signature changes.

- [ ] **Step 2: Write privacy and CLI RED tests**

Inject canaries into repository paths, selector labels, command identities,
finding text, evidence, intervals, URLs, prompts, session IDs, and malformed
snapshot metadata. Assert canaries are absent from the serialized
`StatsAggregationInput` as well as strict and balanced JSON/TTY. Assert the
output carries exactly the selected privacy profile, projection marker,
effective minimum, bounded counts/reasons, five metric names, robust
distribution names, and the label
`Confirmed critical-path minutes by rule`.

Assert detected CI plus requested raw still resolves strict for stats and that
a repository threshold cannot lower a signed organization threshold. Prove raw
output is a clone rather than an alias of the unprojected object.

- [ ] **Step 3: Delegate RED verification**

```bash
npm run build:test && node --test \
  .test-dist/test/reporters-and-cli.test.js \
  .test-dist/test/organization-policy.test.js
```

- [ ] **Step 4: Wire policy, projection, rendering, and docs**

Strictly normalize `history.entries`, pass them through
`projectStatsAggregationInput`, and pass only that projected array plus
`effectivePolicy.minimum_cohort_size` into terminal/cohort summarization. Use
the returned opaque selected snapshot IDs to join already-normalized records
for legacy recurrence/adoption sections, and opaque command keys to join command
display labels, outside the aggregator; do not retain a raw record reference in
aggregation input or output. Then project/clone every display object in
`projectStatsPrivacy`; never emit internal selector or cohort IDs. Render
suppressed values as
`suppressed (N/M comparable samples)` rather than zero. Document terminal
work units, the five dimensions, robust distribution method, default/bounded
policy, cache-state suppression, and the fact that no aggregate table exists.

- [ ] **Step 5: Delegate GREEN verification, spec review, quality review, and commit**

```bash
git add src/commands/stats.ts src/reporters/privacy.ts src/reporters/stats.ts \
  README.md test/reporters-and-cli.test.ts test/organization-policy.test.ts
git commit -m "feat: render privacy-safe terminal statistics"
```

## Task 9: Whole-branch verification, review, rebase, and PR lifecycle

**Files:**
- Review: every file changed by Tasks 1-8

- [ ] **Step 1: Dispatch final spec-compliance review**

Give the reviewer the complete design acceptance list and the branch base/head.
Require explicit checks for selector collision, A/B/A rerun, manifest policies,
per-metric `max`, full-upper/residual wall partition invariant, legacy confirmed
zero, terminal-before-eligibility, separate work-unit/R006 populations and
denominators, exact current-work-unit exclusion by opaque key after terminal
selection, effective-policy floors on both R006 history and positive sample
counts, bounded R006 aggregate-to-finding materialization, pre-analysis
monotonic threshold resolution, and raw-to-opaque projection before
terminal/cohort aggregation. Fix every P0-P2 issue through a test-first commit
and re-review.

- [ ] **Step 2: Dispatch final code-quality/security review**

Require hostile object/accessor/proxy, bounded metadata, deterministic sort,
integer/fractional time, Store compatibility, and privacy-canary inspection.
Fix every P0-P2 issue through a new commit and re-review.

- [ ] **Step 3: Delegate focused and full verification**

The owner must not run tests/static checks. Delegate:

```bash
npm run check
```

Require exit 0, complete test counts, no warnings, and LanguageService
diagnostics with zero errors. Then delegate `/run-github-actions-locally` and
require every workflow selected by the branch diff to pass before push.

- [ ] **Step 4: Rebase latest main and revalidate**

```bash
git fetch origin main
git rebase origin/main
```

Do not resolve semantic conflicts by choosing a side blindly. After a clean
rebase, delegate `npm run check`, LanguageService diagnostics, and local Actions
again. Do not amend; any correction is a new commit.

- [ ] **Step 5: Push and create the PR**

```bash
git push -u origin feature/terminal-snapshot-stats
gh pr create --base main \
  --title "feat: add terminal snapshot statistics" \
  --body "Implements snapshot-aware stats, five separated impact metrics, comparable cohorts, monotonic cohort policy, and privacy-safe terminal aggregation."
```

- [ ] **Step 6: Complete remote CI and review**

Run `/pr-complete`. Monitor every remote job. If all jobs fail within five
seconds with the documented account-payment annotation, use the fresh delegated
local Actions result as the green evidence and report the external billing
block. Otherwise fix code failures test-first, push a new commit, and repeat CI
and both reviews until approved.

- [ ] **Step 7: Merge the approved PR and clean up**

The user has pre-approved merge. Merge through GitHub only; never merge locally.
After GitHub reports merged, read and execute
`/Users/tanakatakuto/.claude/skills/worktree-pr-flow:cleanup/SKILL.md` to remove
the clean worktree and local feature branch. Report the PR URL, merge commit,
fresh validation evidence, review fixes, and cleanup result.
