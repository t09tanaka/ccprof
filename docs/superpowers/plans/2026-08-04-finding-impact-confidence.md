# Finding Impact and Confidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add canonical impact ranges, detailed finding confidence, deterministic severity/rationale, conservative v2 projections, and a strict high-confidence lower-bound ledger floor without adding a new ledger or storage subsystem.

**Architecture:** `src/core/model.ts` owns the exact public contracts and hostile-input snapshot validators. `src/rules/shared.ts` remains the single candidate-construction boundary: detectors supply canonical impact, causal confidence, coverage, intervals, and the policy-dependent signal; the boundary derives severity, ordered rationale codes, and Report/Store v2 compatibility fields one-way. `src/core/ledger.ts` keeps existing attribution/partition behavior but computes `estimated_floor_min` independently from the union of strict-high, critical-path, lower-bound intervals. Store readers normalize legacy records conservatively, and reporters render canonical fields with a legacy fallback.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, `node:test`, existing interval/EventIdentity/rule-manifest/Store v2 utilities, SQLite through `better-sqlite3`.

**Verification constraint:** The implementation owner writes tests and code, but every RED/GREEN run, lint/static analysis, typecheck, full test suite, and local GitHub Actions reproduction is executed by a different verification subagent. The owner must not run those commands directly.

---

## Fixed contracts and mappings

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

export type FindingSeverity = "info" | "low" | "medium" | "high";

export type FindingScoringRationale =
  | "observed_lower_bound"
  | "estimated_upper_only"
  | "resource_cost_only"
  | "policy_dependent"
  | "partial_source"
  | "legacy_projection";
```

Canonical internal fields are named `impact` and `finding_confidence`; existing v2 scalar `confidence` is not reused for the object. A future Report v3 writer may map `finding_confidence` to its schema field `confidence`, but this PR does not add Report v3.

Severity is deterministic and has no millisecond thresholds:

1. `info` when `upper_ms === 0`.
2. `high` when impact is critical-path, `lower_ms > 0`, and confidence is exactly evidence `high`, causal `high`, completeness `1`.
3. `medium` when `upper_ms > 0`, evidence and causal are each at least `medium`, and completeness is greater than `0`.
4. `low` for every other positive-upper impact.

Scoring rationale is an exact, unique array sorted in this order:

```ts
const FINDING_RATIONALE_ORDER = [
  "observed_lower_bound",
  "estimated_upper_only",
  "resource_cost_only",
  "policy_dependent",
  "partial_source",
  "legacy_projection",
] as const;
```

New-to-v2 projection uses `upper_ms` for the compatibility estimate and emits `point` only when `lower_ms === upper_ms`; otherwise it emits `upper`. Scalar confidence is the minimum of evidence, causal, and the completeness band (`0` = low, `(0, 1)` = medium, `1` = high). Every legacy finding, including a legacy `point`, normalizes to `lower_ms: 0`, `upper_ms: recoverable.min * 60_000`, no expected value, non-high causal/completeness, and a `legacy_projection` rationale; it can never confirm the floor.

## File map

- `src/core/model.ts`: exact types, strict snapshots, projection/severity/rationale helpers, legacy canonical fallback.
- `src/rules/shared.ts`: candidate builder and measured-claim-to-impact helper.
- `src/rules/{rework,redundant-runs,rediscovery,human-wait,serial-slack,chronic-cost,context-bloat,flaky-test}.ts`: explicit detector evidence/causal ratings and rationale inputs.
- `src/core/analyze.ts`: rule coverage to source-completeness wiring and canonical finding order.
- `src/core/ledger.ts`: strict eligible lower-bound interval union and floor.
- `src/store/analyses.ts`: canonical Store snapshots plus conservative legacy read normalization.
- `src/reporters/{tty,markdown,json,privacy}.ts`: range/confidence display and privacy-safe projection.
- `test/finding-contracts.test.ts`: exact/hostile contract tests.
- `test/{rules-primary,rules-secondary,capability-coverage,ledger,store,reporters-and-cli,determinism-golden,adoption}.test.ts`: focused integration/regression coverage.
- `README.md`: JSON v2 additive fields and revised floor semantics.

### Task 1: Exact contracts, validators, projections, and severity

**Files:**
- Modify: `src/core/model.ts:18-20,266-315`
- Create: `test/finding-contracts.test.ts`

- [ ] **Step 1: Write the failing public-contract tests**

Use namespace imports/casts so the baseline compiles while the new exports are still absent. Cover a valid lower/expected/upper object, expected at both inclusive boundaries, completeness `0`/`1`, and projection output:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import * as model from "../src/core/model.js";

test("snapshots exact canonical impact and confidence", () => {
  const api = model as typeof model & {
    snapshotImpactEstimate(value: unknown): model.ImpactEstimate;
    snapshotFindingConfidence(value: unknown): model.FindingConfidence;
  };
  assert.deepEqual(api.snapshotImpactEstimate({
    lower_ms: 10, expected_ms: 15, upper_ms: 20,
    kind: "critical_path_latency",
  }), { lower_ms: 10, expected_ms: 15, upper_ms: 20,
    kind: "critical_path_latency" });
  assert.deepEqual(api.snapshotFindingConfidence({
    evidence: "high", causal: "high", source_completeness: 1,
  }), { evidence: "high", causal: "high", source_completeness: 1 });
});
```

- [ ] **Step 2: Add the hostile/numeric RED matrix**

Test `NaN`, both infinities, negatives, negative zero, `lower_ms > upper_ms`, missing/out-of-range expected, completeness below `0`/above `1`, partial/extra/symbol/hidden keys, accessors, non-plain prototypes, transparent Proxy, throwing traps, revoked Proxy, and content-free errors. Assert errors are exactly `invalid impact estimate` or `invalid finding confidence` and contain none of the input key/value/trap text.

- [ ] **Step 3: Delegate RED verification**

Verifier runs:

```bash
npm run build:test
node --test .test-dist/test/finding-contracts.test.js
```

Expected: the test fails because the snapshot/projection exports are absent, not because of a test syntax error.

- [ ] **Step 4: Implement the exact types and strict snapshots**

Add the fixed contracts above. Use `types.isProxy` from `node:util` before reflection. Accept only `Object.prototype`, exact enumerable own string data properties, no symbols/accessors/hidden/extra keys, and clone returned objects. Numeric predicate:

```ts
function validNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && !Object.is(value, -0);
}
```

Wrap all reflection and validation failures in the two fixed, content-free `TypeError` messages. `expected_ms` is optional only by absence and, when present, is within inclusive bounds.

- [ ] **Step 5: Implement deterministic compatibility/severity/rationale helpers**

Add pure helpers with these signatures:

```ts
export function projectFindingConfidence(value: FindingConfidence): Confidence;
export function projectFindingRecoverable(
  impact: ImpactEstimate,
): { min: number; bound: Bound };
export function findingSeverity(
  impact: ImpactEstimate,
  confidence: FindingConfidence,
): FindingSeverity;
export function findingScoringRationale(
  impact: ImpactEstimate,
  confidence: FindingConfidence,
  options?: { policy_dependent?: boolean; legacy_projection?: boolean },
): FindingScoringRationale[];
export function isStrictHighConfidence(value: FindingConfidence): boolean;
```

`projectFindingRecoverable().min` is `impact.upper_ms / 60_000`; rounding remains the ledger/public boundary's existing responsibility. Extend candidates with required `impact`, `finding_confidence`, `severity`, and `scoring_rationale`. Keep those fields optional on `Finding` only so a runtime v2 object can reach the normalization boundary; every new ledger/store output must populate them.

- [ ] **Step 6: Delegate GREEN verification**

Verifier repeats the two commands and reports all contract tests passing with no diagnostics.

- [ ] **Step 7: Self-review and commit**

Check exact keys, error privacy, Proxy rejection before traps, optional expected semantics, ordering uniqueness, and absence of fabricated expected values. Commit only Task 1 files:

```bash
git add src/core/model.ts test/finding-contracts.test.ts
git commit -m "feat: add finding impact and confidence contracts"
```

### Task 2: Canonical candidate construction and explicit detector confidence

**Files:**
- Modify: `src/core/model.ts:266-315`
- Modify: `src/rules/shared.ts:17-22,86-128`
- Modify: `src/rules/rework.ts:229-293`
- Modify: `src/rules/redundant-runs.ts:53-140`
- Modify: `src/rules/rediscovery.ts:179-290`
- Modify: `src/rules/human-wait.ts:29-165`
- Modify: `src/rules/serial-slack.ts:217-290`
- Modify: `src/rules/chronic-cost.ts:136-243`
- Modify: `src/rules/context-bloat.ts:120-285`
- Modify: `src/rules/flaky-test.ts:496-700`
- Modify: `src/core/analyze.ts:900-947,1164-1166,1293-1300`
- Test: `test/rules-primary.test.ts`
- Test: `test/rules-secondary.test.ts`
- Test: `test/capability-coverage.test.ts`
- Test: `test/ledger.test.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Write RED tests for canonical candidates**

Assert representative critical-path (`R002`), policy-dependent (`R004`), resource (`R005`/`R006`), upper-only (`R007`), and partial-coverage candidates contain exact impact/confidence, projected scalar fields, severity, and ordered rationale. Assert no detector supplies `expected_ms` without evidence.

- [ ] **Step 2: Delegate focused RED verification**

Verifier runs `npm run build:test`, then:

```bash
node --test .test-dist/test/rules-primary.test.js .test-dist/test/rules-secondary.test.js .test-dist/test/capability-coverage.test.js
```

Expected: assertions fail because existing candidates expose only scalar confidence/recoverable.

- [ ] **Step 3: Make `createFindingCandidate` the one-way projection boundary**

Change `FindingCandidateInput` to omit `confidence` and `recoverable`; require canonical `impact`, `finding_confidence`, and `intervals`. Snapshot canonical inputs, derive scalar confidence/recoverable/severity/rationale, clone intervals, and keep existing finding key/evidence/caveat normalization.

Provide a measured claim helper:

```ts
export function impactFromClaim(
  claim: RecoverableClaim,
  kind: ImpactEstimate["kind"],
): ImpactEstimate {
  return claim.bound === "point"
    ? { lower_ms: claim.estimated_ms, upper_ms: claim.estimated_ms, kind }
    : { lower_ms: 0, upper_ms: claim.estimated_ms, kind };
}
```

`createFindingCandidate` rebuilds compatibility `recoverable` from canonical upper/bound plus `input.intervals`; it never trusts a caller-provided compatibility value.

- [ ] **Step 4: Assign detector evidence and causal ratings explicitly**

Use existing minimum-confidence evidence calculations as `finding_confidence.evidence`. Assign causal rating per detector from its actual causal proof: R001 correction/diff proof, R002 matcher irrelevance, R003 claimed duplicate-read linkage, R004 explicit versus phrase approval, R005 parallel-safety upper estimate, R006 historical correlation, R007 caused-inference linkage, and R008 no-relevant-edit episode. R004 supplies `policy_dependent: true`; R005/R006 use `resource_cost`; all others use `critical_path_latency`. Add no R004 allowlist or R005 semantic behavior.

- [ ] **Step 5: Wire source completeness from existing coverage**

Pass per-rule completeness through `ruleCandidates`. Use:

```ts
function findingSourceCompleteness(entry: RuleCoverage): number {
  return entry.truncated ? 0 : entry.completeness;
}
```

Direct detector unit calls default to `1`; the analyze path always passes the coverage-derived value. Partial windows, truncated parsers, and incomplete capability coverage therefore cannot become strict-high.

- [ ] **Step 6: Delegate GREEN verification**

Verifier repeats the Task 2 focused commands. Fix only direct failures in candidate contracts or detector expectations.

- [ ] **Step 7: Spec compliance review, quality/security review, and commit**

First reviewer checks all eight detectors, explicit causal decisions, domains, completeness, expected omission, and no R004/R005 scope expansion. After approval, a separate reviewer checks projection direction, deterministic arrays, and privacy. Commit:

```bash
git add src/core/analyze.ts src/rules/*.ts test/rules-primary.test.ts test/rules-secondary.test.ts test/capability-coverage.test.ts
git commit -m "feat: emit canonical finding impact and confidence"
```

### Task 3: Strict high-confidence lower-bound ledger floor

**Files:**
- Modify: `src/core/ledger.ts:31-72,140-183,185-323`
- Modify: `src/core/analyze.ts:661-667`
- Test: `test/ledger.test.ts`
- Test: `test/analyze-integration.test.ts`

- [ ] **Step 1: Write the ledger RED matrix**

Add table/subtests for eligible high/high/1 critical lower bounds and exclusions for resource cost, lower `0`, evidence/causal medium or low, completeness below `1`, and legacy-normalized candidates. Cover overlap, nesting, adjacency, duplicate interval IDs, high+low overlap, resource+critical mix, measured `0`, active-window clipping, lower smaller than interval duration, rounding, and floor clamp.

- [ ] **Step 2: Delegate RED verification**

Verifier runs `npm run build:test` and:

```bash
node --test .test-dist/test/ledger.test.js .test-dist/test/analyze-integration.test.js
```

Expected: new floor assertions fail because the current floor subtracts every point projection.

- [ ] **Step 3: Build lower-bound intervals from existing interval evidence**

For each strict-eligible candidate, intersect its existing recoverable intervals with active intervals, union/deduplicate them, and deterministically take at most `impact.lower_ms` from sorted intervals (slice only the final interval if needed). Union all eligible slices across candidates. Do not add a table, ID, queue, lock, or audit subsystem.

- [ ] **Step 4: Compute and expose the strict floor**

Add `highConfidenceLowerBoundIntervals` to `LedgerResult`. Keep existing attribution/partition/recoverable compatibility calculations. Compute:

```ts
const confirmedHundredths = Math.min(
  measuredHundredths,
  roundedHundredths(durationMs(highConfidenceLowerBoundIntervals)),
);
estimated_floor_min: minutesFromHundredths(
  Math.max(0, measuredHundredths - confirmedHundredths),
)
```

Only `kind === "critical_path_latency"`, `lower_ms > 0`, and exact high/high/1 enter this set.

- [ ] **Step 5: Make ranking canonical and stable**

Order public findings by `impact.upper_ms`, then `impact.lower_ms`, then severity/confidence rank, rule ID, finding key. Keep existing interval signature/EventIdentity/rule version+epoch/finding-key mechanisms unchanged.

- [ ] **Step 6: Delegate GREEN verification and commit**

Verifier repeats Task 3 commands. After clean output and self-review of all interval cases:

```bash
git add src/core/ledger.ts src/core/analyze.ts test/ledger.test.ts test/analyze-integration.test.ts
git commit -m "feat: floor ledger on confirmed lower bounds"
```

### Task 4: Store v2 normalization, hostile snapshots, and round trips

**Files:**
- Modify: `src/store/analyses.ts:14-24,147-269,420-457,468-522,654-659,708-727`
- Modify: `src/reporters/privacy.ts:155-189`
- Test: `test/store.test.ts`
- Test: `test/adoption.test.ts`

- [ ] **Step 1: Write Store/legacy RED tests**

Cover legacy `point`, `upper`, and low scalar confidence; assert all normalize to canonical lower `0`, original upper magnitude, missing expected, non-high detailed confidence, non-high severity, and `legacy_projection`. Add canonical Store roundtrip/digest-order tests and malformed partial/extra/non-enumerable/accessor/Proxy/revoked/throwing-trap nested inputs with content-free errors. Confirm finding key, rule version/epoch, dismissal, and adoption identity remain unchanged.

- [ ] **Step 2: Delegate RED verification**

Verifier runs `npm run build:test` and:

```bash
node --test .test-dist/test/store.test.js .test-dist/test/adoption.test.js
```

Expected: legacy canonical-field assertions and hostile snapshot rejection assertions fail.

- [ ] **Step 3: Normalize canonical and legacy Store findings**

Snapshot every new canonical finding through the strict nested validators and derive its compatibility fields. When canonical fields are absent, infer only the domain (`R005`/`R006` resource, all other current rules critical), set lower `0`, upper from legacy minutes, omit expected, use conservative detailed confidence/completeness, and add legacy rationale. Normalize after validating the original SQLite snapshot digest so old hashes remain readable; new snapshots/digests include stable canonical fields.

- [ ] **Step 4: Reject hostile snapshot shapes without disclosure**

Reject accessors instead of invoking them, reject proxies before reflection, require exact enumerable nested keys, and collapse failures to the existing generic invalid-record/finding messages. Do not interpolate attacker keys, values, serialized content, or trap errors.

- [ ] **Step 5: Preserve privacy and identity behavior**

Privacy projections copy numeric impact, detailed confidence, severity, and fixed rationale codes. Strict evidence stripping remains unchanged. Dismissal/adoption continue to use existing `finding_key`; no schema/table/migration/backfill is added.

- [ ] **Step 6: Delegate GREEN verification, review, and commit**

Verifier repeats Task 4 commands. Run spec review before quality/security review, fix only direct regressions, then commit:

```bash
git add src/store/analyses.ts src/reporters/privacy.ts test/store.test.ts test/adoption.test.ts
git commit -m "feat: normalize finding contracts in store v2"
```

### Task 5: TTY, Markdown, JSON, and compatibility presentation

**Files:**
- Modify: `src/reporters/tty.ts:30-55,111-163`
- Modify: `src/reporters/markdown.ts:31-45,47-106`
- Modify: `src/reporters/json.ts:17-79`
- Modify: `README.md:280-369`
- Test: `test/reporters-and-cli.test.ts`
- Test: `test/determinism-golden.test.ts`

- [ ] **Step 1: Write presentation RED tests**

Assert TTY and Markdown show `lower–upper`, optional expected value only when present, `critical path`/`resource cost`, evidence/causal/completeness, severity, and rationale codes without exceeding existing deterministic line bounds. Assert JSON contains canonical fields and v2 projections. Pass a legacy runtime report and assert all three renderers remain readable through conservative normalization.

- [ ] **Step 2: Delegate RED verification**

Verifier runs `npm run build:test` and:

```bash
node --test .test-dist/test/reporters-and-cli.test.js .test-dist/test/determinism-golden.test.js
```

Expected: range/confidence strings and canonical JSON fields are absent.

- [ ] **Step 3: Implement shared deterministic display formatting**

Render impact milliseconds as minute values using existing rounding. Use `lower–upper`, append `expected X` only when the property exists, and render the detailed confidence triple and severity. Normalize legacy findings at the display boundary; never invent expected values.

- [ ] **Step 4: Update README and golden JSON**

Document additive `impact`, `finding_confidence`, `severity`, and `scoring_rationale`, while retaining scalar `confidence` and `recoverable`. Replace the old floor statement with the strict high-confidence critical lower-bound union formula and explain that resource/upper/partial/medium/low estimates stay visible but do not reduce it.

- [ ] **Step 5: Delegate GREEN verification and commit**

Verifier repeats Task 5 commands. After output/privacy/order self-review:

```bash
git add src/reporters/tty.ts src/reporters/markdown.ts src/reporters/json.ts README.md test/reporters-and-cli.test.ts test/determinism-golden.test.ts
git commit -m "feat: render finding ranges and confidence"
```

### Task 6: Integrated verification and PR completion

**Files:**
- Modify only direct implementation/test failures from Tasks 1-5.

- [ ] **Step 1: Delegate fresh TypeScript diagnostics**

The verifier runs `npm run typecheck` and reports the complete diagnostics. The implementation owner fixes only direct contract-change failures; unrelated existing code/test infrastructure remains untouched.

- [ ] **Step 2: Delegate the full suite**

Verifier runs:

```bash
npm test
```

Expected: all tests pass, including the baseline 670 plus new tests, with zero failures.

- [ ] **Step 3: Run final specification review**

A fresh reviewer checks the approved design line by line: exact public fields, all detectors, conservative legacy normalization, hostile inputs, strict floor predicate/union, domain exclusions, ordering/digest/privacy, Store/dismissal/adoption, and TTY/Markdown/JSON. Remove extras and close every direct gap.

- [ ] **Step 4: Run final quality/security review**

After spec approval, a different reviewer checks trap/accessor safety, content-free errors, numeric boundaries, projection direction, interval double-counting, deterministic output, and scope exclusions. Re-review after any fix.

- [ ] **Step 5: Commit review fixes without amend**

```bash
git add src/core/model.ts src/core/ledger.ts src/core/analyze.ts src/rules/shared.ts src/rules/rework.ts src/rules/redundant-runs.ts src/rules/rediscovery.ts src/rules/human-wait.ts src/rules/serial-slack.ts src/rules/chronic-cost.ts src/rules/context-bloat.ts src/rules/flaky-test.ts src/store/analyses.ts src/reporters/tty.ts src/reporters/markdown.ts src/reporters/json.ts src/reporters/privacy.ts README.md test/finding-contracts.test.ts test/rules-primary.test.ts test/rules-secondary.test.ts test/capability-coverage.test.ts test/ledger.test.ts test/analyze-integration.test.ts test/store.test.ts test/adoption.test.ts test/reporters-and-cli.test.ts test/determinism-golden.test.ts
git commit -m "fix: address finding contract review"
```

Skip the commit if there are no review fixes. Never use `git commit --amend`.

- [ ] **Step 6: Delegate local GitHub Actions reproduction before push**

Use `/run-github-actions-locally` in a verification subagent. It identifies the affected workflow and runs every applicable local check. Push only after the delegated result is green.

- [ ] **Step 7: Push and create the default-branch PR**

```bash
git push -u origin feature/finding-impact-confidence
gh pr create --base main --head feature/finding-impact-confidence --title "[Findings] feat: separate impact from confidence" --body "Adds canonical impact ranges, detailed confidence, deterministic severity/rationale, conservative v2 compatibility, and a strict high-confidence lower-bound ledger floor. Verification: delegated local CI and full tests."
```

Monitor all remote checks. If every job dies within five seconds with the documented payment/spending annotation, use the delegated local CI result as the green code signal; otherwise fix only direct failures in new commits and re-run local verification before pushing.

- [ ] **Step 8: Merge and clean up**

After CI and review are complete, merge through the PR (never a local merge). Then use `/worktree-pr-flow:cleanup` to remove `/Users/tanakatakuto/Documents/GitHub/ccprof/.worktrees/finding-impact-confidence` and local branch `feature/finding-impact-confidence`, reporting the PR URL, checks, review fixes, merge, and cleanup result.

## Explicit exclusions

- No R004 allowlist behavior.
- No R005 resource-domain semantic redesign.
- No Report v3 envelope/writer/schema.
- No stats cohorts.
- No policy/encryption work.
- No new table, ledger, queue, cron, outbox, lease, lock, migration, repair, or backfill.
- No automatic recovery or exactly-once subsystem.
