# Per-Rule Capability Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate every rule on only the session lanes that provide its required capabilities and publish deterministic per-rule coverage.

**Architecture:** Compute canonical `RuleCoverage` entries in the capabilities module, cache analysis lanes by eligible source/session identities, and route every detector to its isolated lane. Keep `skipped_rules` as a zero-eligible legacy projection and add explicit reporter/privacy/snapshot handling.

**Tech Stack:** TypeScript 5.9, Node.js 20 test runner, existing deterministic analysis and reporter modules.

---

### Task 1: Coverage contract and lane semantics

**Files:**
- Modify: `src/core/model.ts`
- Modify: `src/rules/capabilities.ts`
- Test: `test/capability-coverage.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add table-driven tests for all R001-R008 entries, undefined capabilities,
`0/N`, `N/N`, `0/0`, canonical missing unions, session permutation, and
warning-code/window truncation. Assert the exact seven-field object shape.

- [ ] **Step 2: Verify RED**

Run `npm run build:test && node --test .test-dist/test/capability-coverage.test.js`.
Expected: compilation fails because `RuleCoverage` and `ruleCoverage` do not
exist.

- [ ] **Step 3: Implement the minimal contract**

Add the optional `ReportV2.rule_coverage`, capability eligibility helpers, and
coverage computation. Use `total === 0 ? 1 : eligible / total`, sorted unique
missing capabilities, rule order, and warning-code-only truncation.

- [ ] **Step 4: Verify GREEN and commit**

Delegate the focused command above; expect all focused tests to pass. Commit
only the contract, helper, and focused tests as
`feat: add deterministic rule coverage`.

### Task 2: Isolated rule execution

**Files:**
- Modify: `src/core/analyze.ts`
- Test: `test/capability-coverage.test.ts`

- [ ] **Step 1: Write failing integration tests**

Add real-pipeline fixtures proving mixed Claude+Codex R007 keeps Claude
evidence at `1/2 partial`, R001/R005 cannot consume ineligible actions, zero
eligible rules become legacy skips, and required-empty rules remain full.

- [ ] **Step 2: Verify RED**

Run the focused compiled test. Expected: mixed lanes are globally skipped or
ineligible evidence changes detector output.

- [ ] **Step 3: Implement cached isolated lanes**

Build events/timeline/matches from eligible sessions before rule execution,
cache equal session sets, route each R001-R008 detector to its lane, derive
zero-eligible `skipped_rules`, and include coverage in the policy digest.
Preserve the global lane for ledger/metrics and R003 reads.

- [ ] **Step 4: Verify GREEN and commit**

Delegate the focused test and relevant existing analyze/model tests; expect all
to pass. Commit analysis integration as
`feat: evaluate rules on eligible session lanes`.

### Task 3: Report, privacy, and compatibility

**Files:**
- Modify: `src/reporters/json.ts`
- Modify: `src/reporters/tty.ts`
- Modify: `src/reporters/privacy.ts`
- Test: `test/capability-coverage.test.ts`

- [ ] **Step 1: Write failing output tests**

Assert explicit deterministic JSON copying, compact TTY and Markdown coverage
through the shared TTY helper, strict/balanced cloning, raw identity,
non-mutation, legacy missing-field byte compatibility, and snapshot identity
changes when coverage changes.

- [ ] **Step 2: Verify RED**

Run the focused compiled test. Expected: coverage is absent from reporters,
privacy projections, or policy snapshot attribution.

- [ ] **Step 3: Implement minimal output plumbing**

Copy coverage explicitly in JSON/privacy. Make the existing shared human-report
line render ordered coverage for new reports and retain its old skipped text
when coverage is absent. Do not modify README, `.github`, Store schema, or rule
semantics.

- [ ] **Step 4: Verify GREEN, review, and commit**

Delegate focused tests, `npm run check`, and applicable local Actions commands.
Obtain independent spec review then quality/security review, fixing only
P0-P2 issues caused by this change in new commits. Commit reporter/tests as
`feat: publish rule coverage in reports`.

### Task 4: PR lifecycle

- [ ] Rebase on current `origin/main` if needed and delegate a fresh full check.
- [ ] Push `feature/capability-coverage` and open
  `[Capabilities] feat: evaluate rule coverage per session lane` against `main`.
- [ ] Monitor all remote checks, merge with a merge commit after green, sync
  `main`, then run `worktree-pr-flow:cleanup` after its safety checks.
