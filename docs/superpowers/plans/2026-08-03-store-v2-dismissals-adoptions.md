# Store v2 Dismissals and Adoptions

> **For Codex:** execute this plan with `superpowers:subagent-driven-development`
> and finish the isolated branch with `$worktree-pr-flow`.

**Goal:** Move dismissal and adoption persistence into the existing SQLite Store
without changing public data types, CLI output, package version, or Report v2.

**Architecture:** The existing repository-scoped `store.sqlite3` owns one
dismissal and one immutable adoption per finding key. Each legacy single-file
JSON store is scanned outside the write transaction, then imported with its own
marker under `BEGIN IMMEDIATE`. The proven safe JSON reader used by analysis
migration becomes a small shared low-level helper; migration policy remains in
the domain stores.

**Tech stack:** TypeScript, Node.js 20, `better-sqlite3`, Node's test runner.

## Scope

- Persist dismissals in the existing `dismissals` table with key-scoped UPSERT.
- Persist adoptions in the existing `adoptions` table with additive,
  first-writer-wins inserts.
- Import `dismissals.json` and `adoptions.json` once with independent markers.
- Keep legacy files untouched after migration and never rescan after a marker.
- Validate stored JSON against its primary-key and timestamp columns.
- Preserve warning result shapes and existing CLI/report consumers.
- Document the SQLite and one-way migration behavior.

## Non-goals

- No SQLite schema or `STORE_SCHEMA_VERSION` change.
- No package-version or Report v2 change.
- No retention, `data gc`, or `data delete`; those are the next Store v2 task.
- No migration or deletion of hook JSONL.
- No exact-once delivery, outbox, lease, automatic recovery, or old-writer
  coordination.
- No repair of already-corrupt SQLite rows or legacy-file deletion.

## Edge cases and invariants

- Dismissal input normalization stays unchanged: trimmed key, NFC/whitespace
  normalized target, trimmed optional reason, and validated nonnegative time and
  strength.
- A dismissal save replaces only the same finding key, regardless of timestamp;
  unrelated keys survive concurrent saves. Transaction commit order is the
  tie-breaker for concurrent saves of the same key.
- Legacy dismissal duplicates keep the existing deterministic winner: greatest
  `dismissed_at_ms`, then the current record ordering/tie behavior.
- Adoption input duplicates keep the first record. Once a finding key exists in
  SQLite, later saves do not replace its method, evidence, fingerprint, or time.
- `saveAdoptions` intentionally becomes additive. Its production caller already
  supplies existing plus newly detected records; additive inserts prevent stale
  concurrent analyses from deleting each other's different finding keys.
  Empty input is a no-op rather than an undocumented clear operation. Explicit
  deletion belongs to the later `data delete` command.
- A marker fast path does not take a write lock or touch the legacy path.
- If no legacy file exists, an empty migration and marker commit normally.
- Malformed JSON, invalid shape, symlink, FIFO, or other non-regular legacy input
  produces the existing `corrupt_*` warning, imports no rows, and commits the
  marker so it is not rescanned.
- Permission/I/O failure, file identity race, SQLite failure, or trigger failure
  is operational: rows and marker roll back and a later operation may retry.
- On an operational migration failure, `loadDismissals` / `loadAdoptions` append
  their existing `corrupt_dismissals` / `corrupt_adoptions` warning and still
  read any previously committed SQLite rows. A save aborts before its new rows
  and returns the existing `dismissal_write_failed` / `adoption_write_failed`
  warning so callers never treat an incomplete migration as a successful save.
- Safe legacy reads use `lstat`, `O_NOFOLLOW | O_NONBLOCK`, `fstat`, and device /
  inode checks so a FIFO cannot block and a path swap fails closed.
- Legacy scans occur outside `BEGIN IMMEDIATE`; marker recheck, imported rows,
  and marker insert occur in the same immediate transaction.
- A corrupt SQLite row is skipped individually with the existing warning code;
  other valid rows remain readable.
- Every opened SQLite connection closes on success and failure.

## Shared-interface impact analysis

`ts-rename-helper` is unavailable, so TypeScript Language Service semantic
references were used before implementation.

- `loadDismissals`: production consumer is `src/core/analyze.ts`.
- `saveDismissal`: production consumer is `src/commands/dismiss.ts`.
- `loadAdoptions`: production consumers are `src/core/analyze.ts` and
  `src/commands/stats.ts`.
- `saveAdoptions`: production consumer is `src/core/analyze.ts`.
- All existing exported signatures and record/result types remain unchanged.
- The exported `writeJsonAtomically` helper remains available even after these
  stores stop using it.
- The existing schema already has primary keys, timestamp indexes, and
  `record_json` columns for both domains.

## Migration representation

Markers:

```text
legacy-dismissals-json-v1
legacy-adoptions-json-v1
```

SQLite `record_json` is canonical JSON for the existing public record. Loaders
accept a row only when the decoded record is valid, canonical, and agrees with
the row's `finding_key` and timestamp column.

Legacy adoption migration preserves array-order first-wins behavior. Legacy
dismissal migration preserves the existing latest-record selection. If a valid
SQLite row already exists while a marker is absent, migration does not overwrite
it.

## Implementation tasks

1. [x] Add RED Store tests for SQLite round trips that do not create new legacy
   JSON, dismissal overwrite, additive/immutable adoption semantics, disjoint
   concurrent saves, and transaction rollback.
2. [x] Add RED migration tests for valid/corrupt/non-regular inputs, retained
   legacy files, no-rescan markers, operational retry, and writer-lock fast
   paths, plus row-level canonical JSON / primary-key / timestamp integrity so
   a corrupt row is skipped without hiding a valid row.
3. [x] Extract only canonical JSON and safe legacy-file reading into a shared
   Store helper and keep analysis migration behavior unchanged.
4. [x] Replace dismissal JSON persistence with SQLite load/upsert and its
   marker-protected one-way migration.
5. [x] Replace adoption JSON persistence with SQLite load/additive insert and its
   marker-protected one-way migration.
6. [ ] Update README Store documentation and run focused tests, local GitHub
   Actions equivalents, independent reviews, PR checks, merge, and cleanup.

## Change budget

Target at most seven product/test/documentation files plus this required plan,
and at most 300 added production lines. If either limit would be crossed, stop
and split the task rather than expanding this PR.
