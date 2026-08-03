# Store v2 Retention and Data Lifecycle Implementation Plan

## Objective

Complete the Store v2 lifecycle work with explicit, repository-scoped
`ccprof data gc` and `ccprof data delete` commands. Reuse the existing SQLite
schema and Store path resolution, keep all public Store signatures stable, and
leave package version 0.2.0, Store schema 2, and Report v2 unchanged.

## Fixed policy

Retention is never automatic. It runs only when the user explicitly invokes
`ccprof data gc` for the current Git repository.

| Data | Policy |
| --- | --- |
| Analysis executions | retain 90 days |
| Analysis snapshots | retain only while referenced by a retained execution; remove every orphan regardless of age |
| Adoption records | retain 90 days |
| Dismissal records | retain until their existing 14-day expiry |
| Hook events | retain 30 days and at most 1 MiB |
| Store migration markers | retain indefinitely |
| Legacy JSON | remove only after all three migrations are committed |

For analyses, adoptions, and hook events, a timestamp exactly at the cutoff is
retained and an older timestamp is removed. A dismissal exactly 14 days old is
removed because it is already ineffective under the existing dismissal
contract. Future timestamps are retained.

## `ccprof data gc` contract

1. Resolve the current repository with the existing repository and Store path
   helpers; linked worktrees therefore operate on the same Store.
2. Complete the existing one-way analysis, dismissal, and adoption migrations
   before deleting anything. Corrupt legacy input follows the existing
   warn-and-mark behavior. An operational migration failure leaves a marker
   absent, aborts GC, and is retryable.
3. In one `BEGIN IMMEDIATE` transaction:
   - delete analysis executions older than 90 days;
   - delete snapshots with no remaining execution;
   - delete adoptions older than 90 days;
   - delete dismissals that reached their 14-day expiry;
   - preserve every migration marker.
4. Any SQL failure rolls back all four logical deletion groups. After commit,
   run `VACUUM` and then `wal_checkpoint(TRUNCATE)` so WAL pages produced by
   compaction are also reclaimed. A non-zero checkpoint `busy` result is a
   failure, not success. A post-commit compaction/checkpoint failure is reported
   and a rerun remains safe.
5. Force hook-log compaction even below 1 MiB. Before reading, use `lstat` and
   require a regular file; a missing file is a no-op, while a symlink or other
   non-regular entry is rejected without following it. Retain valid rows at or
   after the 30-day cutoff, drop malformed/expired rows, and then enforce the
   existing newest-first 1 MiB cap. Unlike the hook hot path, explicit GC
   propagates an operational compaction failure.
6. Only after all three migration markers exist, remove the known retained
   legacy paths: `analyses/`, `index.json`, `dismissals.json`, and
   `adoptions.json`. A symlink is unlinked without following its target.
7. Return deterministic deletion counts without emitting raw Store paths or
   record contents. Missing optional legacy/hook inputs are successful no-ops.

SQLite deletion is atomic. Filesystem cleanup and post-commit compaction cannot
share that transaction, so they are ordered, bounded to known paths, and
idempotent rather than advertised as exact-once or automatically recoverable.

## `ccprof data delete` contract

1. Resolve only the current repository's hashed Store directory.
2. Before recursive deletion, verify that `repo_hash` is exactly 64 lowercase
   hexadecimal characters and `repo_dir` is exactly `join(root_dir, repo_hash)`.
3. A missing directory is an idempotent success. Refuse a symlink or any
   non-directory entry and never follow it.
4. Remove the complete repository Store directory, including SQLite/WAL/SHM,
   hook events, retained legacy JSON, and unknown remnants within that one
   verified directory.
5. Do not open SQLite first, so an unsupported future Store schema can still be
   deleted explicitly.
6. The command itself is the explicit confirmation; no prompt or `--yes` flag
   is introduced. A concurrent writer may recreate the directory after
   deletion, which is documented as a non-goal rather than hidden by a new lock.

## Error and CLI behavior

- `ccprof data` without `gc` or `delete`, unknown data actions, or extra
  positional arguments are usage errors.
- Existing global `--help` and `--version` precedence remains unchanged.
- `data` is treated as a non-analysis command by privacy dispatch.
- Operational failures throw through the existing non-zero operational exit-5
  path; they are not returned as warning-only successful results.
- The data-command boundary wraps filesystem, SQLite, and migration failures in
  a fixed action-specific message before throwing. The original error, which
  may contain an absolute Store path, is never copied into stdout, stderr, or
  warnings.
- `CliHandlers.data` is optional and falls back to the real data command so
  existing injected handler fixtures remain source-compatible.
- No raw path, finding evidence, session identifier, or command is printed.

## Edge cases to test first

- Timestamp immediately before, exactly at, and immediately after each cutoff.
- `now_ms` smaller than a retention duration, epoch zero, and future records.
- Old and recent executions sharing one snapshot, plus an existing orphan.
- Triggered SQL failure proving execution/snapshot/dismissal/adoption rollback.
- Missing migration marker, corrupt legacy input, and operational migration
  failure that must abort before retention begins.
- Legacy files/directories that are missing, symlinks, or non-regular entries.
  In particular, an `analyses/` symlink that prevents the existing migration
  marker must abort GC and remain untouched; `data delete` is the explicit safe
  escape hatch for removing that repository Store.
- Hook logs below the byte threshold, malformed lines, boundary rows, and rows
  still over 1 MiB after time filtering.
- Filesystem and SQLite errors whose original messages contain absolute paths;
  CLI stderr must contain only the fixed path-free operational message.
- Missing Store, blocked Store path, unsupported schema, and repeat invocation.
- Main and linked worktree paths resolving to the same deletion target.
- A concurrent writer recreating data after `data delete` (documented only;
  no new concurrency guarantee).

## Semantic impact constraints

TypeScript LanguageService found broad use of `StorePaths`,
`resolveStorePaths`, and `openStoreDatabase`; their signatures must not change.
The hook compactor has only one internal caller and may expose a strict forced
variant while preserving the existing best-effort hook wrapper. CLI command
unions and dispatch may grow, but `parseCliArgs` and `runCli` signatures stay
stable.

## Implementation tasks

1. [x] Add RED command tests for parser/dispatch, retention boundaries,
   snapshot reachability, rollback, migration gating, legacy cleanup, strict
   hook compaction, safe full deletion, idempotency, and sanitized output.
2. [x] Extract a strict forced hook-log compactor while preserving the current
   thresholded, best-effort hook behavior.
3. [x] Implement Store lifecycle operations in `src/commands/data.ts` using the
   existing schema, Store paths, migrations, and one immediate transaction.
4. [x] Add the `data gc|delete` parser, usage, optional handler fallback, and
   dispatch in `src/cli.ts` without changing existing handler fixtures.
5. [x] Document the fixed, manual-only retention and deletion policy in README.
6. [x] Pass focused tests, local GitHub Actions equivalents, independent
   reviews, and the initial PR pre-merge gate.

## Validation

- Node 20 focused suites: data lifecycle 10/10 and hook events 22/22 passing.
- Full local GitHub Actions equivalent: 539/539 passing on the official
  Node 20.20.2 image as a non-root user; build, determinism golden, package and
  native SQLite smoke tests also pass.
- `npm audit`: zero vulnerabilities; tracked and untracked whitespace checks:
  clean.
- Independent security and data-lifecycle review: clean after adding the
  fd-based no-follow hook read and fail-closed unknown-action regressions.
- PR #44 initial head: all seven visible checks passing, with no review,
  inline, thread, or conversation comments.
- Package version remains 0.2.0, Store schema remains 2, and Report schema
  remains v2.

## Change budget

Target exactly these six files:

- this plan;
- `src/commands/data.ts`;
- `src/cli.ts`;
- `src/commands/hook-event.ts`;
- `test/data-command.test.ts`;
- `README.md`.

Added production code must remain at or below 300 lines. If either the six-file
target or production line budget cannot be met, stop and split `data delete`
into a separate worktree/PR rather than widening this change.
