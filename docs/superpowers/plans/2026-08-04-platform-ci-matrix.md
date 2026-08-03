# Platform CI Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Tests and static analysis must be run by the sonnet verifier, not the owner.

**Goal:** Add blocking Node 22/24 coverage across Ubuntu, macOS, and Windows,
retain blocking Node 20 coverage and the existing branch-protection check name,
and expose a non-blocking Ubuntu Node 26 native-addon canary.

**Architecture:** Put full tests behind a fail-fast-disabled six-leg matrix and
a separate Node 20 floor job, then preserve `unit-and-integration-tests` as an
`always()` aggregate gate over those results. Use one portable CommonJS SQLite
smoke helper in runtime lanes. Keep Node 26 separate and allowed to fail.

**Tech stack:** GitHub Actions YAML, Node.js 20/22/24/26,
`better-sqlite3`, TypeScript static workflow tests, Node test runner.

---

## Constraints and edge cases

- The six exact Node 22/24 × Ubuntu/macOS/Windows pairs are blocking and
  `fail-fast` is false so one failure does not hide other platform results.
- Windows uses a checked-in Node helper rather than shell-specific inline JS.
- Every supported-runtime lane catches missing or unusable native prebuilds by
  opening, querying, and closing an in-memory SQLite database after `npm ci`.
- The aggregate uses `always()` and rejects failed or cancelled dependencies;
  it keeps the exact `unit-and-integration-tests` check name.
- The Node 26 canary is job-level non-blocking and excluded from the aggregate.
- Ubuntu Node 20 remains blocking because it is advertised in `engines`.
- `typecheck`, `package-smoke`, and `determinism-golden` retain exact names;
  normal setup and CodeQL use Node 24.
- All actions stay pinned to full commit SHAs; every job has a timeout and the
  existing concurrency and least-privilege permissions remain explicit.
- The aggregate performs no duplicate checkout, install, smoke, or test work.
- No engines/version/release semantic, production runtime, Trusted Publishing,
  report/store/manifest/export, or tag-only release-assets change is allowed.

The complete change is limited to seven files and remains below 300 added
implementation lines.

## Task 1: RED static workflow contracts

**Files:** `test/ci-workflow.test.ts`

- [ ] Add helpers that isolate top-level workflow job blocks without a YAML
  runtime dependency.
- [ ] Assert the exact six matrix pairs, `fail-fast: false`, per-leg checkout,
  cached setup, install, native smoke, and full tests.
- [ ] Assert blocking Node 20, non-blocking Node 26 with smoke/typecheck/tests,
  aggregate `always()` dependencies and success-only result logic, exact check
  names, and no aggregate test duplication.
- [ ] Assert pinned actions, job timeouts, concurrency, permissions, CodeQL
  Node 24, portable smoke-helper behavior, and support/canary documentation.
- [ ] Ask the sonnet verifier to run the focused test and record RED against
  the unchanged workflows.

## Task 2: Implement runtime lanes and native smoke

**Files:** `.github/workflows/ci.yml`, `tools/smoke-better-sqlite3.cjs`

- [ ] Add the fail-fast-disabled Node 22/24 platform matrix.
- [ ] Add the blocking Ubuntu Node 20 floor job.
- [ ] Replace the old test job with the lightweight always-run aggregate gate.
- [ ] Add the non-blocking Ubuntu Node 26 canary outside that dependency graph.
- [ ] Move unchanged-name typecheck/package/determinism jobs to Node 24.
- [ ] Implement the portable in-memory SQLite open/query/close smoke helper and
  invoke it from every runtime compatibility lane.
- [ ] Ask the verifier to confirm focused GREEN.

## Task 3: CodeQL and documentation

**Files:** `.github/workflows/codeql.yml`, `README.md`

- [ ] Move CodeQL setup to Node 24 without changing triggers or analysis.
- [ ] Document supported blocking jobs, the Node 26 canary, native-addon smoke,
  and that `engines` remains authoritative.
- [ ] Confirm the static workflow contracts remain GREEN.

## Task 4: Review and local verification

- [ ] Commit the implementation and both required `docs/superpowers/`
  artifacts without amend or worktree-only settings.
- [ ] Run independent specification review and independent quality review;
  fix and re-review only defects introduced by this change.
- [ ] Delegate focused static contracts, typecheck, full tests, package smoke,
  determinism, and CodeQL build phase on the host OS.
- [ ] Delegate `/run-github-actions-locally` before pushing because workflow
  logic changes.

## Task 5: PR, remote matrix, merge, and cleanup

- [ ] Push `feature/platform-ci-matrix` and open a PR against `main` titled
  `[CI] ci: add platform compatibility matrix` with Summary, Impact, Test
  plan, Tests, and Rollback sections.
- [ ] Wait for every remote blocking matrix and compatibility job to pass;
  investigate OS-specific failures and accept Node 26 failure only when it is a
  genuine canary incompatibility.
- [ ] Merge with `gh pr merge --merge`, sync local `main`, and remove this
  worktree and its merged branches.
