# Analysis Audit Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return the existing canonical Store snapshot identity as analysis audit metadata without changing persisted or rendered v2 contracts.

**Architecture:** Extract one pure snapshot preparation/identity function in the Store module and make SQLite insertion consume its output. Add the returned side-car to every core analysis completion path, computing it identically when persistence is disabled.

**Tech Stack:** TypeScript 5.9, Node.js crypto/test runner, better-sqlite3, existing canonical JSON and Store v4.

---

### Task 1: Commit the approved contract and plan

**Files:**
- Add: `docs/superpowers/specs/2026-08-05-analysis-audit-identity-design.md`
- Add: `docs/superpowers/plans/2026-08-05-analysis-audit-identity.md`

- [ ] **Step 1: Record the fixed identity contract**

Document the exact domain-separated envelope, inclusions and exclusions,
identifier formats, privacy boundary, persistence-disabled behavior, Store
failure semantics, content-fallback limitation, LSP references, and strict
scope cap.

- [ ] **Step 2: Self-review and commit documentation**

Run `rg -n 'T[B]D|T[O]DO|i[m]plement later|f[i]ll in'` on both documents and
`git diff --check`. Expect no placeholder or whitespace failures. Commit as:

```bash
git add docs/superpowers/specs/2026-08-05-analysis-audit-identity-design.md \
  docs/superpowers/plans/2026-08-05-analysis-audit-identity.md
git commit -m "docs: design analysis audit identity"
```

### Task 2: Establish RED Store identity contracts

**Files:**
- Modify: `test/store.test.ts`

- [ ] **Step 1: Add failing Store tests**

Import the wished-for `analysisAuditIdentity` API and assert:

```ts
const first = analysisAuditIdentity(record("first", 100), snapshotOptions());
const rerun = analysisAuditIdentity({
  ...record("first", 100), analysis_id: "second", created_at_ms: 200,
}, snapshotOptions());
assert.equal(first.snapshot_id, rerun.snapshot_id);
assert.equal(first.deterministic_digest, `sha256:${first.snapshot_id}`);
assert.deepEqual(first.snapshot_identity, snapshotOptions().snapshot);
```

Also assert a fallback identity uses `{ mode: "content-fallback" }`, returned
snapshot IDs match SQLite, exact idempotent replay returns the same identity,
and write/conflict failures retain the attempted identity alongside existing
warnings without adding rows.

- [ ] **Step 2: Delegate focused RED verification**

Run:

```bash
npm run build:test
node --test .test-dist/test/store.test.js
```

Expected: TypeScript compilation fails because `analysisAuditIdentity` and
`AnalysisSaveResult.audit_identity` do not exist.

- [ ] **Step 3: Commit RED tests only**

```bash
git add test/store.test.ts
git commit -m "test: define stored analysis audit identity"
```

### Task 3: Implement the canonical Store side-car

**Files:**
- Modify: `src/store/analyses.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Add the minimal public types and pure function**

Add `AnalysisSnapshotEnvelopeIdentity` and `AnalysisAuditIdentity`. Build one
prepared envelope from a normalized record and optional normalized snapshot.
Return the execution fields, raw snapshot digest, prefixed digest, and a cloned
canonical identity. Do not add fields to `AnalysisRecord`.

- [ ] **Step 2: Reuse preparation during insertion and save**

Make `insertAnalysis` consume the prepared envelope/snapshot ID instead of
recomputing them. Compute preparation before opening SQLite and include
`audit_identity` in `AnalysisSaveResult` even when the transaction warns.

- [ ] **Step 3: Delegate focused GREEN verification**

Run the Task 2 commands. Expect all Store tests to pass with no warnings.

- [ ] **Step 4: Commit Store implementation**

```bash
git add src/store/analyses.ts
git commit -m "feat: expose stored analysis audit identity"
```

### Task 4: Establish RED analyzer contracts

**Files:**
- Modify: `test/analyze-integration.test.ts`
- Modify: `test/analysis-budgets-integration.test.ts`

- [ ] **Step 1: Add failing complete-analysis tests**

Assert persisted and `persist:false` runs over identical inputs return equal
snapshot IDs/digests, the persisted value matches SQLite, `snapshot_identity`
is canonical, and JSON rendering of `result.report` remains version 2 with no
`audit_identity`, `analysis`, `snapshot_id`, or `deterministic_digest` fields.

- [ ] **Step 2: Add failing budget-partial tests**

Cover an early exhausted run with `persist:false` and a persisted equivalent.
Assert both return `{ mode: "content-fallback" }`, equal deterministic identity,
and the disabled run creates no Store database.

- [ ] **Step 3: Delegate focused RED verification**

Run:

```bash
npm run build:test
node --test .test-dist/test/analyze-integration.test.js \
  .test-dist/test/analysis-budgets-integration.test.js
```

Expected: TypeScript compilation fails because `AnalyzeResult.audit_identity`
does not exist.

- [ ] **Step 4: Commit RED tests only**

```bash
git add test/analyze-integration.test.ts test/analysis-budgets-integration.test.ts
git commit -m "test: define analyzer audit identity"
```

### Task 5: Propagate identity through all analyzer exits

**Files:**
- Modify: `src/core/analyze.ts`
- Test: `test/analyze-integration.test.ts`
- Test: `test/analysis-budgets-integration.test.ts`

- [ ] **Step 1: Extend AnalyzeResult**

Add required `audit_identity: AnalysisAuditIdentity` and import the pure Store
helper and type.

- [ ] **Step 2: Cover full and partial return paths minimally**

For persisted paths, return `saveResult.audit_identity`. For `persist:false`,
construct the same shaped save result with `analysisAuditIdentity(record,
options)` and no warnings. Complete analyses pass `currentSnapshotIdentity`;
early budget partial analyses omit it and therefore retain content-fallback.

- [ ] **Step 3: Delegate focused GREEN verification**

Run the Task 4 commands. Expect both compiled test files to pass.

- [ ] **Step 4: Commit analyzer implementation**

```bash
git add src/core/analyze.ts
git commit -m "feat: return analysis audit identity"
```

### Task 6: Verify scope, review, and publish

**Files:**
- Verify all seven planned files only

- [ ] **Step 1: Delegate complete verification**

Run `npm run check`, `git diff --check origin/main...HEAD`, and inspect
`git diff --stat origin/main...HEAD`. Expect all typecheck/tests/build checks
green, no whitespace errors, at most seven files, and fewer than 300 added and
changed production TypeScript lines.

- [ ] **Step 2: Run two-stage independent review**

First review exact compliance with the approved spec. Only after approval, run
a separate quality/security review. Fix only defects introduced by this change,
using new commits and re-reviewing until both stages pass.

- [ ] **Step 3: Run local GitHub Actions before push**

Delegate `/run-github-actions-locally` because this PR changes logic. Resolve
only failures caused by this PR and rerun until green.

- [ ] **Step 4: Push and complete the PR lifecycle**

Push `feature/analysis-audit-identity`, create a PR against `main`, monitor all
remote checks and review, merge with the authorized merge commit after green,
then run `worktree-pr-flow:cleanup` and update the primary checkout's `main`.
