# Store v2 Analysis Snapshots and Legacy Migration

> **For Codex:** execute this plan with `superpowers:subagent-driven-development`
> and finish the isolated branch with `$worktree-pr-flow`.

**Goal:** Persist one deterministic snapshot for equivalent analysis inputs,
retain every invocation as an execution, and migrate legacy analysis JSON once.

**Architecture:** The existing repository-scoped SQLite Store owns immutable
snapshot envelopes and execution foreign keys. `core/analyze.ts` supplies an
internal, audited input descriptor; legacy/direct Store callers use a
content-fallback descriptor. Public report and record contracts stay unchanged.

**Tech stack:** TypeScript, Node.js 20, `better-sqlite3`, Node's test runner.

## Goal

Move analysis history from immutable JSON files into the existing Store v2
SQLite schema while preserving the public `AnalysisRecord` and Report v2
contracts. Separate deterministic analysis snapshots from invocation executions
so an unchanged later rerun reuses the snapshot without inflating history,
baseline, recurrence, or stats.

Package and report versions are owned by the maintainer and must not change.

## Scope

- Store analysis snapshots and executions transactionally in SQLite.
- Derive snapshot identity from repository/Git/window/source/config/policy/history
  inputs and the normalized analysis payload, excluding invocation identity and
  analysis-time-only timestamps.
- Keep `loadAnalyses` returning one representative `AnalysisRecord` per
  snapshot so existing consumers remain source compatible.
- Perform a one-way, marker-protected migration of legacy `analyses/*.json`.
- Keep legacy files untouched after migration.
- Use the canonical repository path for newly persisted analysis units so linked
  worktrees produce stable records.
- Make the packed-install smoke test execute a command that loads SQLite.

## Non-goals

- No package-version or Report v2 schema/version change.
- No dismissal/adoption SQLite migration; that is the next Store v2 task.
- No hook-event format change; hook events remain JSONL.
- No retention, `data gc`, or `data delete`; those are a later Store v2 task.
- No exact-once delivery, outbox, lease, automatic recovery, or legacy cleanup.
- No guarantee for concurrent writers from older ccprof versions after the
  one-way migration.

## Edge cases and invariants

- Same Git OIDs, selected source data, effective configuration, policy/history
  inputs, and normalized result must yield one snapshot even when invoked later.
- A meaningful source, OID, configuration, policy, history, or result change
  must yield a different snapshot.
- The default window end (`analysis_time`) is excluded from snapshot identity;
  an explicit end would be included. The selected-source digest is the evidence
  that additional events were or were not observed.
- `execution_id` remains the immutable `analysis_id`; reusing it with another
  snapshot or execution time is a conflict and inserts nothing.
- A snapshot ID whose stored envelope differs is a fail-closed conflict.
- Snapshot and execution inserts, and legacy records plus their migration marker,
  commit atomically under an immediate transaction.
- Valid legacy files migrate in lexical order. Malformed/invalid, symlink, and
  non-regular entries are warned and skipped; duplicate IDs keep the first valid
  file. A fatal directory/SQLite failure leaves no marker so the operation can be
  retried.
- Once the migration marker exists, legacy analysis files and the legacy index
  are never rescanned. They are not deleted.
- A directly saved record without a rich input descriptor and a legacy record
  use a content-derived fallback identity. This is deterministic but deliberately
  does not over-merge a later richly described snapshot.
- SQLite connections are closed on every path; tests close handles and child
  processes before removing temporary directories.

## Shared-interface impact analysis

`ts-rename-helper` is unavailable in this environment, so TypeScript's Language
Service was used for semantic references before implementation.

- `AnalysisRecordInput`: references are contained in `src/store/analyses.ts`.
- `loadAnalyses`: consumed by `src/core/analyze.ts`, `stats`, `dismiss`,
  `explain`, and Store/analyze/rule tests; its signature remains unchanged.
- `saveAnalysis`: consumed by `src/core/analyze.ts` and Store/analyze/rule tests.
  It receives one additive optional third argument; existing callers remain
  valid.

## Internal representation

`analysis_snapshots.record_json` stores a versioned internal envelope. The rich
identity has this exact shape:

```text
{
  repo_id,
  base_oid,
  head_oid,
  merge_base_oid,
  window: {
    started_at_ms,
    start_source,
    end_source,
    completeness,
    // ended_at_ms only when end_source is explicit
  },
  source_digest,
  config_digest,
  policy_digest,
  history_digest
}
```

The source digest is computed after window slicing, stable session ordering, and
hook application. Its projection omits absolute transcript paths, omits warning
source paths, and normalizes in-repository CWDs/observed paths relative to the
current repository before canonical hashing. The config digest contains the
effective idle threshold, a canonically sorted effective TestMap, and sorted
external tool names. The policy digest uses a fixed internal policy fingerprint
plus rule capability applicability. The history digest contains the exact
sorted prior-record array used by baseline/rules, excluding the current PR.

The final envelope is:

```text
{
  schema_version: 1,
  identity: <rich descriptor or content fallback>,
  payload: <AnalysisRecord without analysis_id and created_at_ms>
}
```

The snapshot ID is a domain-separated SHA-256 of canonical JSON for that
envelope. `analysis_executions` stores the original `analysis_id`,
`created_at_ms`, and snapshot foreign key. The snapshot's `created_at_ms` is the
earliest observed execution time.

For each snapshot, `loadAnalyses` reconstructs the oldest execution (time, then
ID) as the representative record and orders representatives by first observation
time and stable ID.

## Implementation tasks

1. [x] Add RED Store tests for snapshot/execution separation, meaningful changes,
   immutable conflicts, valid/corrupt legacy migration, marker no-rescan, and
   transaction/concurrency behavior.
2. [x] Add a RED analyze integration assertion showing the same inputs at a later
   invocation produce one snapshot and two executions.
3. [x] Replace analysis JSON persistence in `src/store/analyses.ts` with SQLite
   codecs, CRUD, conflicts, and marker-protected one-way migration. Retain
   `writeJsonAtomically` for dismissal/adoption callers.
4. [x] Build a rich internal snapshot descriptor in `src/core/analyze.ts`, use the
   canonical repository path in the stored unit, and pass the descriptor only
   when persistence is enabled.
5. [x] Document SQLite history/migration behavior and extend the installed-package
   smoke test to run `ccprof stats --json` inside a temporary Git repository with
   an isolated data directory.
6. [x] Run focused tests, the repository's local GitHub Actions workflow checks,
   full tests, build, determinism, package smoke, scope/security review, and the
   pre-merge PR CI/review gate.

## Validation

- Fresh non-root Node 20.20.2: `npm ci`, 523/523 tests, build, and audit with
  zero reported vulnerabilities.
- Determinism golden: 1/1.
- Packed install: version/help and `stats --json` succeeded while loading native
  SQLite and creating exactly one `store.sqlite3`.
- GitHub PR #42: all seven checks succeeded, no review comments remained, and
  the merge state was clean for the implementation commit.
- Independent specification, worktree-regression, and SQLite/concurrency reviews
  were clean. Package 0.2.0 and Report v2 remained unchanged.

Merge and worktree cleanup follow after this validation-only commit passes the
same required checks.

## Change budget

Target at most eight product/test/documentation files, plus this required plan,
and at most 300 added production lines. If either limit would be crossed, stop
and split the task rather than expanding this PR.
