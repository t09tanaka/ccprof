# Analysis-Wide Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one strict six-field resource budget across a complete Claude-plus-Codex analysis and expose deterministic partial outcomes in privacy-projected output and Store v4.

**Architecture:** Add a strict injected meter, pass it cooperatively through the existing source query and JSONL controls, and retain a core post-discovery backstop. Finalize output only after privacy projection, then persist the immutable analysis and normalized budget row together. When budgets are omitted, execute the existing path unchanged.

**Tech Stack:** TypeScript ESM, Node monotonic clocks, existing streaming JSONL parsers, `better-sqlite3`, Node test runner, TypeScript LanguageService.

---

## File map

- Create `src/analysis/budgets.ts`: exact validation, monotonic meter, usage,
  reason precedence, coverage, and detached snapshots.
- Create `src/reporters/budget.ts`: privacy-projected byte measurement and
  content-free output envelopes.
- Modify `src/core/model.ts`: additive budget report contracts.
- Modify `src/sources/session-source.ts`, `src/sources/combined.ts`,
  `src/sources/claude/discover.ts`, and `src/sources/codex/discover.ts`: optional
  cooperative shared meter and stable early-stop source admission.
- Modify `src/core/analyze.ts`: budget checkpoints, partial fast path, output
  finalization, and optional record result.
- Modify `src/commands/analyze.ts`: selected privacy/format projector and exact
  prepared-output emission.
- Modify `src/reporters/privacy.ts`, `src/reporters/json.ts`,
  `src/reporters/tty.ts`, and `src/reporters/markdown.ts`: clone/render additive
  budget facts without leaking raw content.
- Modify `src/store/sqlite.ts` and `src/store/analyses.ts`: Store v4 migration,
  constrained budget rows, atomic save, and legacy-compatible reads.
- Create `test/analysis-budgets.test.ts`: validator/meter unit contract.
- Create `test/analysis-budgets-integration.test.ts`: shared source/core/output
  behavior.
- Modify `test/store.test.ts`, `test/analyze-integration.test.ts`,
  `test/combined-source.test.ts`, and `test/reporters-and-cli.test.ts`: migration
  and integration coverage.

## Task 1: Semantic impact map and RED budget contract

**Files:**
- Create: `test/analysis-budgets.test.ts`
- Inspect: `src/core/model.ts`, `src/core/analyze.ts`,
  `src/sources/session-source.ts`, `src/store/analyses.ts`

- [ ] **Step 1: Run TypeScript LanguageService impact analysis**

Use the installed `typescript` compiler API to create a LanguageService from
`tsconfig.test.json`. Record definitions, references, and semantic diagnostics
for `ReportV2`, `AnalyzeOptions`, `AnalyzeResult`, `SessionQuery`,
`AnalysisRecordInput`, and `AnalysisRecord`. `ts-rename-helper` is unavailable,
so this compiler LanguageService is the required semantic source; do not rely
only on text search.

- [ ] **Step 2: Write exact-shape RED tests**

Define a valid fixture with exactly:

```ts
const limits = {
  max_input_bytes: 10,
  max_input_events: 3,
  max_wall_ms: 20,
  max_cpu_ms: 15,
  max_output_bytes: 200,
  max_source_items: 2,
};
```

Test detached normalization and rejection of every missing field, negative,
fractional, NaN, infinity, unsafe integer, extra/symbol/non-enumerable field,
accessor, sparse/array input, and throwing Proxy trap. Assert only stable error
codes, never attacker-controlled values.

- [ ] **Step 3: Write meter RED tests**

Use scripted wall/CPU readings and assert zero, exact boundary, one over,
prefix admission, stable multi-reason precedence, backwards/NaN clocks,
complete-empty coverage `1`, partial-zero-denominator coverage `0`, detached
snapshots, and counters that remain safe integers.

- [ ] **Step 4: Delegate RED verification**

Run:

```sh
npm run build:test
node --test .test-dist/test/analysis-budgets.test.js
```

Expected: compilation fails only because `src/analysis/budgets.ts` and its
exports do not exist.

- [ ] **Step 5: Commit the contract tests**

```sh
git add test/analysis-budgets.test.ts
git commit -m "test: define analysis budget contract"
```

## Task 2: GREEN strict meter

**Files:**
- Create: `src/analysis/budgets.ts`
- Modify: `src/core/model.ts`
- Test: `test/analysis-budgets.test.ts`

- [ ] **Step 1: Implement the exact public types**

Export `AnalysisBudgets`, `AnalysisBudgetUsage`,
`AnalysisTruncationReason`, and `AnalysisBudgetResult` with the exact fields
from the design. Add optional `analysis_budget?: AnalysisBudgetResult` to
`ReportV2`.

- [ ] **Step 2: Implement guarded normalization**

Use guarded `Reflect.ownKeys` and property descriptors. Require six own,
enumerable, data properties and reject every other shape with
`AnalysisBudgetValidationError` carrying only a fixed code. Return a frozen,
detached value.

- [ ] **Step 3: Implement the injected meter**

Provide explicit methods to checkpoint clocks, admit source items/bytes/event
prefixes, record source failures, reserve projected output, query `stopped`,
and return a detached result. Inclusive limits and reason precedence must
match the design; never throw for bad clock readings.

- [ ] **Step 4: Delegate GREEN verification**

Run the Task 1 commands. Expected: every budget unit test passes with no
warnings or diagnostics.

- [ ] **Step 5: Re-run LanguageService diagnostics**

Confirm zero semantic diagnostics in the new module and every reference site
reported in Task 1.

- [ ] **Step 6: Commit**

```sh
git add src/analysis/budgets.ts src/core/model.ts test/analysis-budgets.test.ts
git commit -m "feat: add strict analysis budget meter"
```

## Task 3: RED Store v4 migration and persistence

**Files:**
- Modify: `test/store.test.ts`
- Modify: `test/analysis-budgets.test.ts`

- [ ] **Step 1: Add Store migration RED tests**

Assert fresh v0, populated v2, populated v3, exact v4 reopen, and concurrent
double-open behavior. Verify `analysis_budget_runs` columns/constraints and
`schema-v4-analysis-budgets`. Inject migration failure and prove table, marker,
and `user_version` roll back while every legacy/source-catalog row survives.

- [ ] **Step 2: Add atomic save/load RED tests**

Save one analysis with a full result and one with a partial result. Query all
configured/consumed/observed columns, completeness, reason, and coverage.
Assert exact replay is a no-op, conflicting content is rejected without
mutation, legacy snapshots without a budget still load with the property
absent, and `persist: false` creates no row.

- [ ] **Step 3: Delegate RED verification**

```sh
npm run build:test
node --test .test-dist/test/store.test.js .test-dist/test/analysis-budgets.test.js
```

Expected: focused failures identify Store version 3 and the missing table/save
path; unrelated legacy assertions remain green.

- [ ] **Step 4: Commit RED tests**

```sh
git add test/store.test.ts test/analysis-budgets.test.ts
git commit -m "test(store): define analysis budget persistence"
```

## Task 4: GREEN Store v4

**Files:**
- Modify: `src/store/sqlite.ts`
- Modify: `src/store/analyses.ts`
- Test: `test/store.test.ts`, `test/analysis-budgets.test.ts`

- [ ] **Step 1: Implement one v4 schema transaction**

Set `STORE_SCHEMA_VERSION` to `4`. Fresh v0 creates the full schema; v2 creates
the source catalog and budget table in one immediate transaction; v3 creates
only the budget table. Insert both applicable markers and set `user_version`
only at commit. Reject v1/future versions before mutation.

- [ ] **Step 2: Add constrained budget rows**

Create `analysis_budget_runs` keyed to `analysis_executions`. Store all 18
limit/consumed/observed integers plus completeness, nullable reason, and
coverage with exact SQLite checks.

- [ ] **Step 3: Save and load atomically**

Extend record normalization with an optional detached budget result. Insert
the execution, snapshot, and mirrored budget row in the existing immediate
transaction. Verify an existing row byte-for-byte before treating replay as a
no-op. Join and validate rows on load while keeping legacy absence additive.

- [ ] **Step 4: Delegate focused GREEN**

Run the Task 3 commands. Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```sh
git add src/store/sqlite.ts src/store/analyses.ts test/store.test.ts test/analysis-budgets.test.ts
git commit -m "feat(store): persist analysis budget outcomes"
```

## Task 5: RED shared source and core enforcement

**Files:**
- Create: `test/analysis-budgets-integration.test.ts`
- Modify: `test/combined-source.test.ts`
- Modify: `test/analyze-integration.test.ts`

- [ ] **Step 1: Add shared-source RED cases**

Use instrumented Claude/Codex source fixtures that record each I/O checkpoint.
Cover deterministic first-source consumption, source/item and byte zero,
exact/one-over bytes and events, malformed/huge rows, partial source failure,
and proof that no source/file/evidence callback runs after exhaustion.

- [ ] **Step 2: Add core RED cases**

Use scripted clocks for exact and over wall/CPU boundaries, simultaneous
reasons, empty partial reports, finite coverage, and `persist: false`. Assert
unbudgeted calls retain existing errors/output and default combined discovery
remains parallel.

- [ ] **Step 3: Delegate RED verification**

```sh
npm run build:test
node --test .test-dist/test/analysis-budgets-integration.test.js .test-dist/test/combined-source.test.js .test-dist/test/analyze-integration.test.js
```

Expected: failures point only to missing cooperative query/core wiring.

- [ ] **Step 4: Commit RED tests**

```sh
git add test/analysis-budgets-integration.test.ts test/combined-source.test.ts test/analyze-integration.test.ts
git commit -m "test: define analysis-wide budget enforcement"
```

## Task 6: GREEN source and core enforcement

**Files:**
- Modify: `src/sources/session-source.ts`
- Modify: `src/sources/combined.ts`
- Modify: `src/sources/claude/discover.ts`
- Modify: `src/sources/codex/discover.ts`
- Modify: `src/core/analyze.ts`
- Test: files from Task 5

- [ ] **Step 1: Pass an optional shared meter**

Add only one optional query property. Preserve source compatibility. Run
combined sources sequentially in declared order only when a meter exists;
retain current `Promise.all` behavior otherwise.

- [ ] **Step 2: Make built-in walking cooperative**

Yield source files lazily in stable order. Claim item/byte budgets before
opening each file, pass the remaining byte cap through existing parser
controls, admit the normalized event prefix, and stop iteration immediately
after a partial decision.

- [ ] **Step 3: Add core checkpoints and partial fast path**

Normalize budgets before work, construct the injected/default clock explicitly,
and checkpoint around analysis/evidence I/O. For budget-caused empty evidence,
build a zero ledger/report instead of throwing. Keep the unbudgeted control
flow byte-for-byte compatible.

- [ ] **Step 4: Delegate focused GREEN and impacted legacy tests**

Run Task 5 plus Claude/Codex discover/parser focused suites. Expected: all
focused and legacy source tests pass.

- [ ] **Step 5: Re-run LanguageService diagnostics/references**

Confirm the `SessionQuery`, `AnalyzeOptions`, `AnalyzeResult`, and `ReportV2`
changes have zero semantic diagnostics across every consumer.

- [ ] **Step 6: Commit**

```sh
git add src/sources/session-source.ts src/sources/combined.ts src/sources/claude/discover.ts src/sources/codex/discover.ts src/core/analyze.ts test/analysis-budgets-integration.test.ts test/combined-source.test.ts test/analyze-integration.test.ts
git commit -m "feat: enforce shared analysis input budgets"
```

## Task 7: RED privacy-projected output budgeting

**Files:**
- Modify: `test/analysis-budgets-integration.test.ts`
- Modify: `test/reporters-and-cli.test.ts`

- [ ] **Step 1: Add projection-order RED tests**

Place secret/path canaries in raw report fields and assert the size callback
sees only strict/balanced projected values. Cover exact bytes, one over,
multi-byte UTF-8, advisory omission, a fixed content-free envelope, envelope
larger than cap, and zero output bytes.

- [ ] **Step 2: Add reporter/privacy RED tests**

Assert budget facts are cloned by privacy projection, ordered deterministically
in JSON, summarized in TTY/Markdown, and omitted entirely for legacy reports.
Fallback diagnostics must be identical for different secret/raw inputs.

- [ ] **Step 3: Delegate RED verification**

```sh
npm run build:test
node --test .test-dist/test/analysis-budgets-integration.test.js .test-dist/test/reporters-and-cli.test.js
```

Expected: only missing reporter/output-budget behavior fails.

- [ ] **Step 4: Commit RED tests**

```sh
git add test/analysis-budgets-integration.test.ts test/reporters-and-cli.test.ts
git commit -m "test: define privacy-safe output budgets"
```

## Task 8: GREEN output finalization

**Files:**
- Create: `src/reporters/budget.ts`
- Modify: `src/reporters/privacy.ts`
- Modify: `src/reporters/json.ts`
- Modify: `src/reporters/tty.ts`
- Modify: `src/reporters/markdown.ts`
- Modify: `src/commands/analyze.ts`
- Modify: `src/core/analyze.ts`
- Test: files from Task 7

- [ ] **Step 1: Implement projection-first limiting**

Render the privacy-projected report, measure UTF-8 bytes, and return full
output only within the inclusive cap. Otherwise return the fixed per-format
budget envelope; return an empty string when even that envelope exceeds the
cap. Never slice serialized bytes.

- [ ] **Step 2: Finalize before persistence**

For active budgets, pass one async projector into core, finalize the exact
output/advisory decision, persist the budget result, and return prepared bytes
for direct emission. Keep the unbudgeted save-before-advisory path unchanged.

- [ ] **Step 3: Render additive budget facts**

Clone configured/consumed/observed values in privacy projection, use stable JSON
field order, and add one compact content-free TTY/Markdown status line.

- [ ] **Step 4: Delegate focused GREEN and full reporter/advisory tests**

Run Task 7 plus `test/advisory.test.ts` after compilation. Expected: all pass,
including existing proof that advisory text never enters stored records.

- [ ] **Step 5: Commit**

```sh
git add src/reporters/budget.ts src/reporters/privacy.ts src/reporters/json.ts src/reporters/tty.ts src/reporters/markdown.ts src/commands/analyze.ts src/core/analyze.ts test/analysis-budgets-integration.test.ts test/reporters-and-cli.test.ts
git commit -m "feat: bound privacy-projected analysis output"
```

## Task 9: Independent review, local Actions, and delivery

**Files:**
- Modify only files implicated by introduced defects.
- Update: `docs/superpowers/plans/2026-08-03-analysis-budgets.md`

- [ ] **Step 1: Run independent specification review**

Compare the full branch with the design and user contract. Require explicit
coverage of every listed edge case and scope exclusion. Fix only introduced
gaps in new commits, then re-review until approved.

- [ ] **Step 2: Run separate quality/security review**

Focus on Proxy/accessor containment, secret reflection, monotonic accounting,
no-I/O-after-stop, SQLite rollback/idempotency, output byte bounds, and legacy
compatibility. Fix only direct P0-P2 findings and re-review until approved.

- [ ] **Step 3: Delegate final LanguageService and test verification**

Run semantic diagnostics, focused suites, `npm run check`, build, and
`git diff --check`. Tests/static analysis must run in a verifier subagent, not
the owner context.

- [ ] **Step 4: Delegate `/run-github-actions-locally`**

Execute every locally runnable step in applicable workflows, serializing jobs
that share installs/artifacts. Record pass/fail/skip evidence and do not push
logic changes until all code-related checks pass.

- [ ] **Step 5: Push and complete the PR**

Rebase on latest `origin/main` if it advanced, repeat delegated verification
after rebase, then push and create:

```text
[Budgets] feat: enforce analysis-wide budgets
```

Monitor every remote check and review, fix only direct findings in new commits,
merge with a merge commit under standing authorization, synchronize `main`,
and remove only `.worktrees/analysis-budgets` plus its local/remote feature
branch.
