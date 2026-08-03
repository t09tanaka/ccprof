# Store v3 Source Catalog Implementation Plan

> **Execution:** Use an isolated worktree, TDD, delegated test/static-analysis
> runs, independent specification and quality/security review, and the normal PR
> flow to `main`.

**Goal:** Add an idempotent transactional Store v2-to-v3 migration and a strict,
deterministic persistence API for source catalog metadata.

**Architecture:** Extend the existing SQLite module with two explicit schema
paths: v0 bootstraps full v3 and v2 adds only the catalog in an immediate
transaction. Put catalog types, validation, change decisions, and CRUD in one new
Store module. Do not connect discovery or parsing in this PR.

**Tech stack:** TypeScript ESM, `better-sqlite3`, Node test runner, SQLite WAL.

## Scope budget

- Production: `src/store/sqlite.ts` and new `src/store/source-catalog.ts`, at most
  300 added/changed production lines.
- Tests: migration coverage in `test/store.test.ts`, catalog coverage in new
  `test/source-catalog.test.ts`, and the directly affected migration-marker
  assertion in `test/data-command.test.ts`.
- Documentation: this plan and the matching design document.
- Target: seven changed files, never more than eight.

## Task 1 — RED schema and migration tests

- [x] Update bootstrap assertions for exact Store v3 columns, constraints,
  indexes, marker, and `user_version`.
- [x] Build a populated v2 fixture and prove opening preserves every legacy table
  row while adding only the catalog and marker.
- [x] Cover v0, v2, double open, explicit rerun/no-op, version 1/future rejection,
  and failure injection that rolls back table/marker/version without touching
  existing rows.
- [x] Re-run legacy JSON migration/read/write tests unchanged.
- [x] Delegate the focused test and record the expected implementation-only RED.

## Task 2 — Transactional Store v3 migration

- [x] Set `STORE_SCHEMA_VERSION` to 3 while recognizing v2 as the only migratable
  predecessor.
- [x] Create the catalog DDL once and use it from fresh bootstrap and v2 migration.
- [x] Insert `schema-v3-source-catalog` and update `user_version` in the same
  immediate transaction.
- [x] Reject version 1 and future schemas before mutation; close on every failure.
- [x] Delegate focused tests GREEN and commit schema/tests without amend.

## Task 3 — RED catalog contract/API tests

- [x] Cover exact validation, detached clones, unknown/raw-content fields,
  empty/NUL text, hashes, integer safety, file-identity pairing, offset bounds,
  and direct SQLite constraint bypass.
- [x] Cover insert/get/list ordering, stale/equal/newer observations, exact replay,
  same-revision progress monotonicity, revision reset, partial completeness, and
  changed-content decisions.
- [x] Delegate the focused test and record the expected missing-module RED.

## Task 4 — Catalog implementation

- [x] Add the exact `SourceCatalogEntry` and result/error contracts.
- [x] Add strict content-free validation that returns detached rows.
- [x] Add atomic upsert, deterministic get/list, and fail-closed content-change
  comparison without storing source bodies.
- [x] Use the TypeScript LanguageService for semantic reference/diagnostic checks;
  record that `ts-rename-helper` is unavailable in this environment.
- [x] Delegate focused tests GREEN and commit without amend.

## Task 5 — Review, verification, and delivery

- [x] Run independent specification review against the audit/design/plan.
- [x] Run a separate quality/security/scope review and fix only introduced defects
  in new commits.
- [x] Delegate focused tests, full check, build, `git diff --check`, and the
  applicable `/run-github-actions-locally` workflow.
- [ ] Push and open `[Store] feat: add a transactional source catalog` against
  `main`; wait for remote CI/review, merge under standing authorization, sync
  `main`, then remove only this worktree and local/remote feature branch.
