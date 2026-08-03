# Node Runtime and Platform Edge Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development task-by-task. Tests, static analysis,
> and Actions execution are delegated to the verifier, not run by the owner.

**Goal:** Advertise and enforce exactly Node.js 22/24 support, retain Node.js
26 only as a canary, and fill the remaining deterministic platform-edge and
ARM64 native-addon coverage gaps.

**Architecture:** Keep the existing six-leg blocking OS/runtime matrix and
portable SQLite smoke. Remove the EOL Node.js 20 lane, add one native Linux
ARM64 Node.js 24 smoke lane to the stable aggregate gate, and add only the
three missing platform tests while documenting the existing edge evidence.

**Tech stack:** npm package metadata, GitHub Actions YAML, TypeScript, Node.js
test runner, Git fixtures, `better-sqlite3`.

---

## Constraints and edge cases

- The formal engine expression is byte-exact: `22.x || 24.x` in both package
  metadata records.
- Node.js 20, 23, and 25 are not documented or executed as support lanes.
- Ubuntu/macOS/Windows × Node.js 22/24 remains the exact blocking full-suite
  matrix; Node.js 26 remains nonblocking and outside its aggregate.
- Native ARM64 verification uses `ubuntu-24.04-arm`, asserts the actual
  architecture, performs `npm ci`, and loads/queries `better-sqlite3`.
- The stable aggregate fails for a cancelled or failed matrix or ARM64 job and
  performs no duplicate install/test work.
- Case-insensitive coverage probes the filesystem and explicitly skips on a
  sensitive filesystem; the workflow contract owns Windows/macOS execution.
- Unicode testing does not assume whether the host preserves or decomposes
  filenames, and asserts NFC identity at the canonicalization boundary.
- Existing Windows drive/UNC, symlink/junction, worktree, separate-git-dir,
  native smoke, and abrupt-kill tests are cited rather than duplicated.
- A real bare repo fails through the existing `GitContextError` boundary
  before analysis or Store writes.
- No production API/signature or shared type changes are planned, so semantic
  LSP reference migration is not required. `ts-rename-helper` is unavailable.
- No release/tag/publish action and no unrelated hardening.

The expected change is eight files, no production file, and below 300 lines of
implementation code.

## Task 1: RED support and workflow contracts

**Files:** `test/ci-workflow.test.ts`, `test/platform-edge-contracts.test.ts`

- [ ] Assert package and root lockfile engines are exactly `22.x || 24.x`.
- [ ] Replace the Node.js 20 workflow expectations with its absence and an
  isolated, nonblocking Node.js 26 canary.
- [ ] Assert a blocking `ubuntu-24.04-arm`/Node.js 24 job checks `process.arch`,
  performs `npm ci`, and invokes the native addon smoke.
- [ ] Assert the aggregate depends only on the full-suite matrix and ARM64
  smoke, checks both results, and excludes the canary.
- [ ] Assert README support/EOL/canary and capability-skip ownership wording.
- [ ] Add focused real-filesystem NFC/NFD, case-insensitive capability, and
  real bare-repository failure contracts.
- [ ] Delegate the exact focused test run and record expected RED failures
  against unchanged metadata/workflow/docs; existing edge behavior may already
  be GREEN.

## Task 2: Implement the runtime and ARM64 contract

**Files:** `package.json`, `package-lock.json`, `.github/workflows/ci.yml`,
`README.md`

- [ ] Change only the root package engine metadata to `22.x || 24.x`; do not
  rewrite dependency-owned engine declarations.
- [ ] Remove the Node.js 20 compatibility job and all aggregate references.
- [ ] Add the native Linux ARM64 Node.js 24 install/architecture/SQLite smoke
  job and make the stable aggregate require it.
- [ ] Keep the exact six supported matrix pairs and the isolated Node.js 26
  canary unchanged in strength.
- [ ] Document supported/EOL/canary runtimes, ARM64 native smoke, and the
  case-insensitive capability contract.
- [ ] Delegate the focused tests and confirm GREEN.

## Task 3: Commit and independent review

- [ ] Commit the design and plan, then RED contracts and implementation in
  logical commits without amend. Include all `docs/superpowers/` artifacts.
- [ ] Request an independent specification review against the audit acceptance
  criteria and this design.
- [ ] Request an independent quality/security review of the branch diff.
- [ ] Fix only defects introduced by this change in new commits, then re-run
  the relevant review.

## Task 4: Delegated verification before push

- [ ] Delegate focused contracts, typecheck, complete tests, package smoke,
  determinism, and workflow syntax/action lint.
- [ ] Delegate `/run-github-actions-locally` because workflow logic changes.
- [ ] Confirm `git diff --check`, branch identity, intended file set, and clean
  status through verifier evidence.

## Task 5: PR, remote CI, merge, and cleanup

- [ ] Push `feature/node-platform-contracts` and open a PR against `main` titled
  `[Platform] test: enforce supported runtimes and edge contracts` with
  Summary, Impact, Test plan, Tests, and Rollback sections.
- [ ] Wait for all remote checks, including the six supported matrix legs and
  native ARM64 smoke, to complete; investigate any failure without weakening
  the contract.
- [ ] Merge through GitHub only after blocking CI/reviews are green.
- [ ] Sync the main checkout, remove the merged worktree and local/remote
  feature branches according to `$worktree-pr-flow:cleanup`.
- [ ] Report the PR URL, merge SHA, verification evidence, coverage inventory,
  and cleanup state. Do not tag, publish, or release.
