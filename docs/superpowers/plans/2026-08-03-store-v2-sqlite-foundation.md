# Store v2 SQLite Foundation Implementation Plan

**Goal:** Add the repository-scoped SQLite bootstrap that later Store v2 PRs can use, without changing any existing Store reader/writer yet.

**Architecture:** Keep the current JSON Store behavior intact in this PR. Add one small SQLite module that derives `store.sqlite3` from the existing canonical repository directory, opens it with bounded locking and WAL settings, bootstraps the complete Store v2 table/constraint shape in one transaction, and refuses unknown future schemas without modifying them. Follow-up PRs will move analyses, dismissals/adoptions, and lifecycle commands independently.

**Tech stack:** TypeScript ESM, Node.js 20 or 22–25, `better-sqlite3` 12.9.0 (exactly pinned for Node 20 prebuild support), Node test runner.

## Scope and non-goals

- Keep package version `0.2.0` and ReportV2 unchanged.
- Do not switch `loadAnalyses`, `saveAnalysis`, dismissals, adoptions, or hook events in this PR.
- Do not scan, mutate, migrate, or delete legacy JSON yet.
- Do not add leases, queues, outboxes, exact-once delivery, or corrupt-DB recovery.
- Keep `hook-events.jsonl` outside SQLite.
- Stay below ten changed files and 300 added production lines.

## Edge cases and safety constraints

- A linked worktree and its main checkout must derive the same database path.
- First open and repeated open must be idempotent; schema creation is transactional.
- Every connection must use `foreign_keys=ON`, `journal_mode=WAL`, and a finite `busy_timeout`.
- The per-repository directory and database must be private on POSIX (0700/0600).
- An existing DB with a newer/unknown `user_version` must be closed and rejected before any pragma or schema rewrite.
- Failed bootstrap must not advertise the schema as complete.
- Database connections must always be closeable by callers and tests.

### Task 1: Pin and install the Node 20-compatible SQLite dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

- [x] Add exact runtime dependency `better-sqlite3@12.9.0` and matching TypeScript declarations without changing the package version.
- [x] Correct the Development section's now-obsolete no-runtime-dependencies statement and note the embedded SQLite runtime.

### Task 2: Write RED bootstrap and safety tests

**Files:**
- Modify: `test/store.test.ts`

- [x] Assert canonical and linked-worktree paths select the same `store.sqlite3`.
- [x] Assert first/repeated open produces WAL, foreign keys, finite busy timeout, private POSIX modes, schema version 2, all tables, indexes, and unique/foreign-key constraints.
- [x] Assert two independent connections see the same committed data and a rollback leaves no partial migration marker.
- [x] Assert an unknown future schema fails closed and preserves sentinel data/user_version.
- [x] Have a validation subagent compile and run the focused Store test to prove the new contract is RED only for missing implementation (`TS2307` for the not-yet-created module).

### Task 3: Implement the minimal SQLite foundation

**Files:**
- Create: `src/store/sqlite.ts`

- [x] Export the deterministic DB path, schema constants/errors, and a caller-owned open/close API.
- [x] Harden directory/database permissions, inspect schema before mutating existing DBs, and bootstrap Store v2 in an immediate transaction.
- [x] Create migration metadata, analysis snapshot/execution, dismissal, and adoption tables with the required primary/unique/foreign-key constraints and query indexes.
- [x] Configure bounded lock waiting, WAL, foreign keys, and deterministic close-on-error behavior.
- [x] Have a validation subagent run the focused test GREEN (4/4; TypeScript test build passed).

### Task 4: Review, verify, and deliver

- [x] Run independent specification, code-quality, security, and scope reviews; fix only defects introduced by this PR (PASS / APPROVED / APPROVED after regression-tested fixes).
- [x] Have a validation subagent run Node 20 install, typecheck, full tests (515/515), determinism (1/1), build, package smoke, audit, and `git diff --check`.
- [x] Confirm the native addon is loaded both from source and an isolated packed install, package contents include the runtime dependency contract, and generated artifacts are removed.
- [x] Confirm six changed files, 211 added production lines, and no package/report version change.
- [x] Commit without amend, open PR #41 against `main`, and wait for every check/review (all seven checks passed; no comments or reviews).
- [ ] Merge under standing authorization and clean up only this worktree and branch.

## Follow-up Store v2 PRs

1. Analysis snapshots/executions, exact-content snapshot dedupe, legacy analysis migration, and SQLite-backed history/stats.
2. Transactional dismissal/adoption persistence and their one-way legacy migration.
3. Retention plus `ccprof data gc` / `ccprof data delete`, including explicit legacy cleanup.
