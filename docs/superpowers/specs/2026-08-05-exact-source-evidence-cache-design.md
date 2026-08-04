# Exact-Revision Source Evidence Cache Design

**Status:** Approved for implementation. This is a transparent internal
optimization over the existing Store v5 evidence tables.

## Goal and acceptance boundary

Persist query-independent parser state for stable built-in Claude and Codex
JSONL files so a later process can reproduce the same evidence for an exact
file revision without invoking the parser. A warm hit projects the saved state
for the current inclusive `endedAtMs`; all repository, branch, time-window,
warning, descriptor, report, snapshot, privacy, and ordering logic after parsing
remains unchanged.

The optimization is enabled only for the persisted built-in combined source
when no `AnalysisBudgets` object is active. Injected/custom `SessionSource`,
`persist: false`, and every budgeted run keep their current behavior. Recursive
source discovery remains a full scan on every run. This change does not consume
or modify `source_discovery_roots`.

Completion requires cold-to-fresh-process parser calls of one then zero for an
unchanged eligible source, byte-identical cold/warm normalized sessions,
warnings, descriptors, Report v2, stored snapshot digest, and rendered output,
plus successful reprojection for a changed `endedAtMs` without reparsing.

## Selected design

The selected design adds one small internal exact-revision consumer and reuses
Store v5's existing `source_catalog` plus `source_evidence_cache` pair API.
Alternative designs were rejected:

1. Filtering cached `Session[]` was rejected because parser normalization can
   depend on later physical rows. The existing query-independent state and
   projector are the only canonical warm path.
2. Metadata-only reuse was rejected because equal size/mtime does not prove
   equal content and cannot restore evidence in a fresh process.
3. Directory cursor or append continuation was rejected as outside this PR's
   exact-revision scope and hard size cap.

The Store module gains only the unavoidable producer factory for source
identity, catalog row, envelope, and cache digests. This keeps the private
domain-separated digest rules in one place. No schema, table, migration, queue,
lock, backfill, or recovery service is added.

## Components and data flow

`src/sources/exact-source-evidence-cache.ts` owns one-file preparation:

1. Canonical configured source root and candidate path must prove lexical root
   containment. The candidate is opened as one read-only no-follow handle.
2. Capture pre-stat identity, then hash the complete bytes and bounded catalog
   prefix/suffix diagnostics. Metadata is never a cache key substitute.
3. Resolve the file source identity and query the active Store using the exact
   `StorePaths.repo_hash` and the SHA-256 identity of the canonical eligibility
   root. A row is reusable only when the existing validator accepts its complete
   catalog/cache pair and its full content revision matches the observed digest.
4. A positive hit parses the canonical envelope JSON and invokes the existing
   adapter projector with the requested `endedAtMs`. A negative hit returns no
   session. Neither hit invokes a parser or writes the Store.
5. A miss invokes the existing query-independent parser-state reader on the
   same handle, then invokes the same projector twice: unwindowed for durable
   classification and with `endedAtMs` for this analysis.
6. Before any publish, re-stat and re-hash the same handle and compare a final
   no-follow pathname `lstat` binding with the captured identity. Changed
   content, identity, type, size, or time discards the candidate.
7. Classify every unwindowed session with the existing repository cwd matcher
   against the canonical eligibility root. Publish an all-eligible positive;
   publish a no-raw negative only for exactly empty/warning-free or
   all-other-repository/warning-free evidence. Mixed repository evidence and
   warning-bearing empty evidence remain uncached.
8. Build and atomically commit the catalog/cache pair through the Store factory
   and existing `commitEligibleSourceEvidence`. Commit failure never replaces
   the already projected cold evidence.

Claude and Codex discoverers keep their recursive file collection, sort,
mtime/date pruning, canonical cwd, repository, branch, alignment, dedupe, and
warning behavior. Only the per-file parser call receives the optional internal
consumer. `analyze()` creates that consumer only after PR context is known and
only for the eligible default path; it reuses the early-resolved `StorePaths`
for the later analysis save.

## Stable observation and cache keys

The content revision is SHA-256 over every file byte. Source identity is a
domain-separated SHA-256 over adapter id and canonical file path. Store identity
is the existing `StorePaths.repo_hash`. Eligibility identity is a separate
SHA-256 over the exact canonical query repository root. Thus linked worktrees
may share one Store database but never reuse each other's eligibility row.

The existing Store validator remains authoritative for adapter, canonical path,
content revision, parser version, parser-state schema fingerprint, progress,
payload digest, descriptor digest, repository identity, and eligibility root.
Corrupt JSON, an invalid envelope, unknown versions, or a foreign binding is a
miss. Same mtime/size replacement is a miss because full content is compared.

Pre/post stat comparison includes regular-file type, device, inode, size, and
mtime. The pre/post full digest comparison catches in-place mutation even when
metadata is restored. Final pathname `lstat` rejects a symlink or path rebind.
An unstable observation may still return the existing cold parser's evidence,
but it cannot commit.

## Evidence eligibility and negatives

The positive envelope stores the existing unwindowed sessions, parse warnings,
and normalized continuation. Store validation already proves the sessions and
warnings equal a default unwindowed projection. Claude permits one or more
sessions per file; Codex permits exactly one.

An empty state with no warning produces an `empty` marker. A non-empty state in
which every session belongs to another eligibility root and which has no parse
warning produces an `other-repository-only` marker. Negative markers retain no
sessions, warning text, continuation, or descriptor. A mixture of eligible and
ineligible sessions is not cached because later queries cannot safely select a
durable subset. Empty evidence carrying any warning is not cached.

## Failure and warning behavior

Root-containment failure, no-follow open failure, read/parse failure, or normal
source discovery failure retains the discoverer's existing error behavior.
Cache-only failures are optimization failures: Store open/read/validation/write
failure falls back to cold parsing and emits at most one fixed
`source_cache_unavailable` analyzer warning with no rejected value, path,
payload, digest, SQL text, or secret. It is not counted as a source failure and
does not affect the analysis-window transition decision.

Connections and the single source handle close in `finally`. There is no retry,
repair, backfill, or automatic recovery. A crash before the pair transaction
leaves no new row; the existing immediate transaction keeps catalog and cache
atomic.

## Compatibility and explicit non-goals

Report v2, reporters, snapshot schema, source descriptor derivation, output
bytes, CLI flags, source ordering, and analysis rule behavior do not change.
Cache hits cannot bypass budgets because all budgeted analyses disable the
consumer before source construction. `persist: false` does not resolve/open an
evidence Store. Custom sources never see the consumer.

This PR does not implement append parsing, directory acceleration, discovery
cursors, watchers, encryption, cache GC/repair, quotas, migrations, Report v3,
or new user-facing configuration.

## Edge cases and tests fixed before implementation

- Fresh-process cold/warm parser count `1 -> 0`; identical sessions, warnings,
  descriptors, report, rendered output, and snapshot digest.
- Earlier/later `endedAtMs` reprojection, including post-window Claude rows.
- Exact linked-worktree eligibility-root separation despite a shared Store.
- Mixed-repository, warning-bearing empty, warning-free empty, and
  all-other-repository sources.
- Content, parser version, schema fingerprint, eligibility root, source path,
  Store repository, corrupt payload, and descriptor binding mismatch.
- Symlink, root escape, pathname swap, truncate, rotate, and mutation between
  digest/parser/final validation; none publishes.
- Same mtime/size replacement, LF/no-LF, empty file, Claude multi-session, and
  Codex zero/one cardinality.
- Store unavailable/read/write failure retains cold evidence and produces only
  the fixed content-free warning.
- Active budgets, `persist: false`, and custom `SessionSource` remain on their
  existing parser/discovery path.

## Size guard

Exactly the following ten files may change: this design, its implementation
plan, one new consumer, the Store cache producer, both built-in discoverers,
core analyze wiring, README disclosure, one focused consumer test, and the
existing analyze integration test. Production TypeScript additions/changes must
remain at or below 300 lines. Crossing either cap stops implementation for user
direction rather than expanding scope.
