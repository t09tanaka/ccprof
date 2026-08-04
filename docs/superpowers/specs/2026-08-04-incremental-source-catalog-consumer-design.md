# Incremental Source Catalog Consumer Design

**Status:** Revised after independent specification review; approved program
scope, pending re-review before production implementation.

## Goal and completion boundary

Use the existing `source_catalog` as the durable change index for Claude and
Codex sources. A later CLI process must recover complete repository-eligible
normalized evidence for an unchanged source without invoking its parser. A
verified append may parse only its suffix. Fresh, restored, and suffix-extended
state must pass one common query-window projector and produce the same canonical
evidence as a cold full parse.

Audit 5.2 also identifies recursive directory discovery, not only parsing. This
PR therefore includes a safe directory cursor as a separate Store v5 API. On a
filesystem without a stable directory identity/change token, discovery falls
back to a full bounded scan. The audit item is complete only when both the parse
cache and directory cursor ship and pass their acceptance tests.

No watcher, queue, cron, outbox, lease, or application lock is added.

## Alternatives and selected design

1. **Persistent metadata, parser-stage continuation, and directory cursor
   (selected).** It is the only design that survives CLI restarts, projects any
   `endedAtMs`, resumes append parsing exactly, and safely discovers new files.
2. **Persistent normalized `Session[]` only.** Rejected: current parser output
   depends on `endedAtMs`, and sessions omit branch, assistant-group, ancestry,
   warning-budget, line, and retained-byte state needed for exact suffix work.
3. **Process-local state or metadata-only skipping.** Rejected: restarts force a
   full parse, or metadata can suppress evidence that cannot be restored.

The current exact-key `SourceCatalogEntry` contract remains unchanged. Neither
continuation state nor directory state is added to it. Store v5 owns two new
closed tables and APIs: `source_evidence_cache` and `source_discovery_roots`.

## Query-independent parser pipeline

The current `endedAtMs` filtering moves out of row ingestion. Each adapter is
split into three deterministic stages:

1. `read*ParserState(handle, range, seed)` reads and validates physical JSONL
   rows into a query-independent, closed parser state. It never receives
   `endedAtMs`.
2. `project*ParserState(state, { endedAtMs })` selects rows at or before the
   inclusive end, then applies the adapter's current normalization semantics.
3. Existing public parser functions call stage 1 followed by stage 2. The
   incremental consumer stores stage 1 state and invokes the same stage 2 for a
   cache hit. There is no separate cache-only projector.

This order matters. Filtering already-normalized sessions is not equivalent:
later Claude branch rows can backfill effective branch, later assistant rows can
revise a message group, and later result rows can replace a prior tool result.
The common projector first filters physical parser-stage rows, exactly as the
current parser filters before normalization.

Two fixtures lock this contract:

- T1 appends a post-window Claude branch/message revision and proves a cold
  parse, freshly read state projection, and restored state projection are
  canonical-byte identical for the earlier window.
- T2 caches with an early end, restarts with a later end, and proves the later
  events appear without reparsing an unchanged file.

Parser versions and the parser-state schema fingerprint are checked-in literals
defined before Store/cache code. Any semantic parser or state-schema change must
change the relevant value and force a cold read.

## Closed adapter continuation state

The cache contains both the full unwindowed `Session[]` and the state from which
it was projected. The full sessions must equal
`project*ParserState(state, { endedAtMs: undefined })`; otherwise validation
fails. This redundant invariant catches corrupt, partial, or incompatible state.

### Claude state v1

`ClaudeParserStateV1` contains only exact closed fields:

- `kind: "claude-state-v1"`, canonical source path, physical line count,
  parsed offset, whether the prefix ends in LF, retained valid-row bytes,
  warning count, and warning-overflow state;
- normalized physical rows with byte/line range, timestamp, session id, entry
  uuid, cwd, explicit branch, parent uuid, agent id, sidechain flag, and one
  closed payload variant: auxiliary, API error, compaction, genuine-user,
  assistant logical blocks/usage/message id, or ingested tool results;
- branch/epoch continuation by agent lane and file lane;
- sidechain ancestry entries needed to resolve a suffix parent;
- assistant message-group and text/tool dedupe indexes;
- latest tool-result positions and fixed parser warnings. Each retained warning
  has a closed `source | session` scope and nullable target session id so the
  repository gate can filter it without interpreting its message.

Assistant logical blocks retain only the normalized text or tool name/input
needed to construct current events. Tool results retain only normalized status,
output, byte/token counts, and optional exit code. Original JSON objects,
unknown raw properties, and raw JSONL text are not stored.

### Codex state v1

`CodexParserStateV1` contains:

- `kind: "codex-state-v1"`, canonical source path, line/offset/newline facts,
  retained-byte and warning-budget continuation;
- validated timestamped row evidence with one closed variant: session metadata,
  normalized message, function call, function-call output, ignored known row, or
  warned unknown subtype;
- selected session id/cwd/branch metadata, seen subtype set, call/result dedupe
  state, and the same scoped/targeted fixed-warning representation.

Both validators snapshot own data descriptors without invoking accessors, reject
unknown/missing/non-enumerable/symbol properties, bound payload JSON to 128 MiB,
bound recursive tool-input nodes/depth, validate every integer/enum/optional
field, require canonical row/index ordering, and return detached plain clones.
An unknown state kind/version or an adapter case not representable by its closed
variants is a cold fallback, never a lossy approximation.

## Store v5 schema and migration

One `schema-v5-incremental-sources` migration creates both new tables in the
existing `IMMEDIATE` schema transaction. Fresh v0 creates full v5. Populated v2,
v3, and v4 stores apply only missing additive schemas in order. Existing rows
are not copied, rebuilt, backfilled, or rewritten. Version 1, negative, and
future versions are rejected before mutation. Reopening v5 is a no-op.

### `source_evidence_cache`

```text
source_identity       primary key, foreign key to source_catalog on delete cascade
adapter_id            claude | codex
canonical_path        non-empty, NUL-free
content_revision      sha256: plus 64 lowercase hex characters
parser_version        non-empty, NUL-free
schema_fingerprint    sha256: plus 64 lowercase hex characters
last_parsed_offset    non-negative safe integer
line_count            non-negative safe integer
ends_with_newline     0 | 1
payload_json          canonical SourceEvidenceEnvelopeV1
payload_digest        sha256: plus 64 lowercase hex characters
descriptor_digest     sha256: plus 64 lowercase hex characters
sensitivity           sensitive
retention_class       raw_evidence
updated_at_ms         non-negative safe integer
```

`SourceEvidenceEnvelopeV1` is:

```ts
interface SourceEvidenceEnvelopeV1 {
  schema_version: 1;
  adapter_id: "claude" | "codex";
  canonical_path: string;
  full_sessions: Session[];
  parse_warnings: SourceWarning[];
  continuation: ClaudeParserStateV1 | CodexParserStateV1;
}
```

A row is valid only with a matching complete catalog row parsed through its
size. Cache/catalog adapter, canonical path, revision, parser version, schema,
offset, line count, newline boundary, and observation timestamp
(`updated_at_ms === observed_at_ms`) must agree. All sessions must use the row
adapter and exact canonical source path. Every session warning and parse warning
must use that path. Claude cardinality is one or more repository-eligible
sessions; Codex cardinality is exactly one. Empty or other-repository-only
results are not persisted.

The payload digest is domain-separated and binds this tuple, not merely JSON:

```text
source identity, canonical path, adapter id, content revision,
parser version, schema fingerprint, canonical payload JSON,
sensitivity, retention class
```

The descriptor digest binds the same foreign tuple plus the sorted descriptors
recomputed from `full_sessions`. Copying a valid payload or digest to another
source, path, adapter, or revision fails validation. Identities, errors, and
warnings never interpolate rejected content.

### `source_discovery_roots`

```text
root_identity         primary key, root- plus 64 lowercase hex characters,
                      domain-bound to adapter and canonical root
adapter_id            claude | codex
canonical_root        absolute, NUL-free
cursor                non-negative safe integer
capability            stable_directory_token | full_scan_required
tree_json             canonical closed directory tree state
tree_digest           source/root/adapter/cursor-bound sha256 digest
observed_at_ms         non-negative safe integer
completeness           complete | partial
sensitivity            sensitive
retention_class        source_metadata
```

Tree state contains relative directory/entry names and types, deterministic
child order, and directory tokens. It contains no file bodies or normalized
events. Only a complete snapshot may accelerate a later scan. A partial row is
inspectable but never reused and never replaces a newer complete cursor.
Because the configured roots are global, tree metadata may name paths unrelated
to the current repository; it remains sensitivity-labelled source metadata and
never contains their row bodies, parser state, sessions, warnings, or event
evidence. The repository eligibility gate below remains absolute for raw
normalized evidence.

The existing Store path protections apply: repository directory `0700`, SQLite
file `0600`, symlink rejection, WAL, foreign keys, busy timeout, and close on
every failure. Normalized sessions can contain prompts, commands, paths, edits,
and output, so they are sensitive raw evidence even though raw JSONL rows are
not copied. Encryption, configurable retention/quota, and cache GC/repair remain
separate PRs and are disclosed in README.

## Atomic pair API and race semantics

Parser/restore and persistence are intentionally two phases:

1. `prepare*Source` returns a detached observation, parser state, projected
   result, warning list, and an opaque commit candidate. It performs no Store
   write.
2. The discoverer applies canonical cwd repository eligibility to the
   **unwindowed** full sessions. It filters state, sessions, and warnings to the
   eligible session ids. Only a non-empty repository-eligible candidate may call
   `commitEligibleSource` against that repository's Store.

Thus a global Claude/Codex root cannot place another repository's raw normalized
evidence in the current repository Store. Eligibility is independent of query
time and head branch; time/branch projection remains per analysis. A mixed file
stores only rows and session-scoped warnings belonging to eligible session ids;
source-scoped warnings must be content-free with no `session_ref` and may be
retained only because the file has eligible evidence. Other-repo-only files are
parsed but not cached in this repository.

Catalog and cache writes share one `IMMEDIATE` transaction. Exact replay at the
same observation time is unchanged. A different pair at the same time is a
content-free `conflict` result. A newer observation replaces catalog and cache together;
a stale observation changes neither. Readers on a second WAL connection see
the old pair or new pair, never a mixed pair. Store/cache write failure rolls
back both, returns already-produced analysis evidence, adds one sanitized
optimization warning, and does not mark a valid source as failed.

Two simultaneous v4 opens serialize inside the migration transaction: the
winner creates v5; the waiter re-reads `user_version` after acquiring the write
lock and takes the v5 no-op path. Tests cover simultaneous migration plus
same-time, newer, stale, and mixed-pair visibility races.

## Source root and no-follow handle boundary

Known catalog paths are candidates only when their adapter matches, their
canonical path is within the currently configured canonical source root, and
their filename matches the adapter pattern. A root change cannot make old paths
eligible. Root-escape, wrong-adapter, non-regular, and broken paths are ignored
without opening and yield content-free warnings where current discovery does.

Each admitted file is opened once through a no-follow regular-file helper. On
POSIX it uses `O_RDONLY | O_NOFOLLOW`; on platforms without `O_NOFOLLOW`, an
`lstat`/open/`fstat` identity check supplies the portable fail-closed path. The
same `FileHandle` is passed to hashing, JSONL parsing, and before/after `fstat`.
Parsers never reopen the pathname.

The JSONL reader produces a receipt containing exact start/end offsets, bytes
read, and SHA-256 of the bytes the parser consumed. A full parse receipt must
equal the admitted full-file digest; a suffix receipt must equal the separately
observed suffix digest. The receipt is returned beside parser state rather than
stored inside it, so a suffix receipt can never masquerade as a receipt for the
merged full state. After parsing, the same handle is re-hashed and fstat'ed;
the path is rebound with a final no-follow identity check. Metadata change,
digest change, a mixed parser receipt, or pathname replacement abandons commit
and cold-retries once. A second instability returns available evidence with a
warning and no cache update.

This catches truncate/rotation and ABA change-restore cases. If bytes change
during parsing and are restored, the parser receipt differs from the stable
post-parse digest unless it read exactly the restored content; in the latter
case its evidence is correctly bound to that content.

Windows and filesystems without a stable safe-integer device/inode pair record
both as `null`. Exact unchanged reuse still requires the full content digest.
Append optimization and stable directory cursor reuse are disabled; changed
content takes the cold path.

## Observation, limits, and append classification

The operation order is fixed:

1. Open no-follow and `fstat` the handle.
2. Admit the source item in final candidate order.
3. Immediately apply the existing parser `maxFileBytes` and analysis
   `max_input_bytes` admission to the stat size.
4. If the whole file is not admitted, do **not** full-hash it. Invoke the
   existing bounded cold parser on only the admitted prefix, keep checkpoints,
   mark the outcome partial, and publish no complete catalog/cache pair.
5. Only a whole-file admission may hash for cache classification.

Exact limits are inclusive: size equal to either limit is fully admitted; one
byte over uses the bounded cold path. Zero-byte files perform no content read.

For a fully admitted stable file, `content_revision` hashes every byte. Bounded
prefix/suffix hashes remain catalog diagnostics only. `source_identity` binds
adapter and canonical path. File mtime is a non-negative safe-integer truncation.
Discovery cursor is the complete root cursor that produced the candidate and
never regresses within a revision.

When a prior complete row is available, that same full-hash pass also computes
`previous_prefix_revision` over exact bytes `[0, prior.size_bytes)`; it is `null`
when the range is inapplicable. This value is observation-local and is not added
to `SourceCatalogEntry`.

Append requires matching identity/path/adapter, stable non-null device/inode,
parser/schema, complete validated cache, larger size, an empty prior file or LF
record boundary, and SHA-256 of current `[0, old_size)` equal to the old full
revision through `previous_prefix_revision`. The parser starts at `old_size` and
global line `old_line_count + 1`,
seeded by the closed continuation and cumulative retained/warning budgets. It
then rebuilds full state and sessions through the common projector. An unknown
variant, incompatible seed, partial final row, digest mismatch, budget overflow,
or state invariant falls back cold.

For every supported append fixture, canonical state envelope and each projected
window must be byte-for-byte equal to a cold full parse. Runtime uses append only
for cases represented by the closed state; tests provide the equivalence proof.

## Safe directory cursor and deterministic discovery

The cursor records a closed tree rooted at the configured canonical adapter
directory. A stable directory token consists of device, inode, nanosecond mtime,
and nanosecond ctime captured as canonical decimal strings. Cursor reuse is
enabled only when the runtime/platform supplies stable nonzero identity and
nanosecond timestamps for every cached directory **and** the capability layer
positively identifies a filesystem contract in which every child-set mutation
changes at least one token component before the operation completes. Timestamp
shape alone is not proof. Windows/null identity, unrecognized or remote/network
filesystems, invalid/coarse tokens, or any uncertainty selects a full scan.

For a complete stable snapshot, discovery stats every known directory in
code-unit relative-path order. An unchanged token reuses its canonical child
listing without `readdir`. A changed/new directory is re-read; new descendants
are recursively indexed. File content changes do not require parent change
because every known source file is separately admitted and stat'ed. Entry
creation/removal/rename is guaranteed by the declared capability to change its
immediate directory token; a new file therefore cannot be missed on a reused
listing. If that guarantee is not positively known, every run full-scans and
does not claim cursor reuse.

Each changed-directory `readdir` is bracketed by two stats of the same opened
directory. A changed token, backward time, equal-token/listing conflict, or path
rebinding discards incremental reconciliation and starts one full scan. If the
full scan is unstable, the result is partial and no reusable cursor is written.
Independently, cursor generations divisible by 32 force a deterministic full
reconciliation as defense in depth, not as the basis of no-miss correctness.
This cycle is cursor-based, not wall-clock based, and catches a filesystem
capability that became unreliable without making an implicit current-time
dependency. Until such a full reconciliation succeeds, its cursor cannot advance
as complete.

Known catalog paths and newly reconciled paths are unioned and deduplicated by
adapter plus canonical path. The entire union is sorted by the same cold-source
comparator—adapter order Claude then Codex, then direct JavaScript code-unit
canonical path—**before** source-item, input-byte, or event admission. Catalog
status never lets a known path jump ahead of an earlier-sorting new path.

The hard discovery bounds are exact:

- `MAX_DISCOVERY_ENTRIES = 100_000`, inclusive. Root is not an entry. Every
  returned `Dirent`—file, directory, symlink, or unsupported type—is counted
  before classification. Entry 100,000 is processed; discovery stops before
  100,001.
- `MAX_DISCOVERY_DEPTH = 64`, inclusive with root depth 0. A directory at depth
  64 may be read and its file entries processed; a directory child at depth 65
  is counted but not descended into.
- Claude `.jsonl` symlinks count once, resolve to a regular target within root,
  never cause directory recursion, and deduplicate by canonical target. Broken,
  non-file, and escaping links keep current warnings. Codex keeps its current
  no-symlink behavior and still counts the entry.
- Wall/CPU checkpoints run before each directory read, entry classification,
  no-follow open, hash chunk, parser chunk, cache validation, and merge batch.

A hard entry/depth stop returns the deterministic admitted prefix, sets the
directory snapshot `partial`, does not advance/reuse its cursor, and adds
`source_discovery_partial` to returned session warnings and the analyzer's Report
v2 caveats. If no session is returned, it travels through the existing typed
source-discovery error. When an AnalysisBudget stops first, its existing
`analysis_budget` completeness/truncation is also authoritative. Report v2 has
no separate source-coverage field; this PR does not overload analysis-window
completeness.

## AnalysisBudget equivalence

Incremental state is an optimization, never a budget bypass:

- source candidates use the cold comparator before all admission;
- every candidate consumes the same source-item unit;
- current stat size receives the same input-byte admission before hashing;
- fresh/restored projected events pass through the same
  `admitSessionEventPrefix` in physical source order;
- output projection/finalization is unchanged, so output-byte accounting is
  identical.

For identical files/configuration and a clock that does not stop the run,
`max_input_bytes`, `max_input_events`, `max_output_bytes`, and
`max_source_items`, including observed/consumed values and their truncation
decisions, are cold/warm identical. Cache reuse intentionally reduces CPU and
wall work, so observed/consumed wall and CPU values may differ; a tight wall/CPU
limit may allow a warm run to progress farther. Those two counters are excluded
from byte-for-byte cold equivalence and tested as monotonic optimization rather
than fabricated equality.

Cache-only failure adds a warning and abandons optimization but does not call
`recordSourceFailure`. Actual source discovery/read/parse failure retains the
existing source-failure accounting.

## Compatibility and failure behavior

Only the built-in Claude+Codex default source uses this persistent consumer.
Injected `SessionSource` calls remain unchanged. `persist: false` opens no
incremental Store and commits neither evidence nor directory state. Connections
and file handles close in `finally` on cache hit, parser error, budget exit, and
Store error.

Catalog/cache corruption, unknown schema, invalid continuation, digest or path
mismatch, missing evidence, partial state, Store read error, and race conflict
all take the cold parser path. Parser success precedes mutation. A crash before
commit leaves the old pair; a crash inside the transaction rolls back; a crash
after commit leaves a complete independently validated pair. Optimization write
failure cannot discard the parser result.

The CLI flags, Report v2 shape, analysis snapshot schema, source descriptor
contract, findings, rules, privacy projection, and output formats do not change.
For identical source bytes/query/Git/config/history without wall/CPU exhaustion,
warm and cold canonical reports, descriptors, findings, warnings, and source
digest are identical.

## Required edge and race tests

- T1/T2 query-independent state and common projector, earlier/later `endedAtMs`,
  fresh/restored equality, and post-window branch/message rows.
- Fresh v0, populated v2/v3/v4, idempotent v5, two simultaneous v4 opens, and
  rollback after each new-table/marker/version boundary.
- Same-time exact/conflicting pair, newer/stale pair, concurrent WAL reader, and
  proof that a mixed catalog/cache pair is never visible.
- Hostile envelope/state/tree objects, corrupt/non-canonical JSON, unknown state,
  payload copy across path/source/adapter/revision, descriptor mismatch, wrong
  session/warning paths, wrong adapter, and Claude/Codex cardinality.
- Exact unchanged restart with parser count zero; changed one-of-many parses only
  that source; missing/corrupt/partial evidence cold parses.
- Exact append equivalence for UTF-8, LF/CRLF, branch/epoch, sidechain ancestry,
  assistant grouping/dedupe, warning saturation, retained bytes, tool pairs,
  and multiple Claude sessions; unsupported state cold fallback.
- Same-size/middle/larger rewrite, truncate, stable-identity rotation, null
  identity, non-newline prefix, parser/schema mismatch, and partial budget.
- Same-handle path swap, truncate, ABA rotate-restore, mutation during hash,
  mutation during parse, restored metadata, parser receipt mismatch, and retry.
- Exact maxFileBytes/analysis byte boundary and one-over proof that no full hash
  ran; source/event/output/source-item budget cold/warm equality.
- Repo A/B mixed source: only A rows in A Store and only B rows in B Store;
  ineligible state never commits; configured-root change and root-escape known
  rows are never opened.
- Stable directory cursor unchanged reuse, changed parent/new file, new nested
  directory, removal/rename, earlier-sorting new source, symlink cases, Windows
  null capability/full scan, entry 100,000/100,001, depth 64/65, partial cursor,
  and final cold comparator order before budget admission.
- Cache/tree write failure, unavailable/read-only Store, transaction trigger,
  caller mutation of detached results, and descriptor/payload secret canaries
  absent from identity/error/warning text.

## Scope

Included are query-independent parser state, common window projection, closed
continuation persistence, Store v5 migrations, foreign-bound validation,
no-follow same-handle observation, safe append, repository-gated two-phase
commit, deterministic budget admission, safe directory cursor/fallback, default
source integration, CLI-restart tests, and README disclosure.

Excluded are encryption at rest, configurable retention/quota, cache GC/repair,
filesystem watchers, background delivery, new CLI flags, Report v3, new rules,
and organization export.
