# Incremental Source Catalog Consumer Design

**Status:** Approved for implementation under the enterprise-hardening program.

## Goal

Use the existing `source_catalog` as the durable change index for Claude and
Codex session sources. A later CLI process must reuse a complete, validated
normalized-evidence snapshot for an unchanged source without invoking its
parser. An append-only source may parse only its verified suffix and combine it
with the prior evidence. Every uncertain state falls back to a cold full parse,
so an optimization failure cannot remove evidence or change the report.

This change deliberately does not add a watcher, queue, cron, outbox, lease, or
lock service.

## Selected architecture

Three approaches were considered:

1. **Persistent metadata plus persistent normalized evidence (selected).** The
   exact-key `source_catalog` remains metadata-only. A separate Store v5 table
   holds canonical, validated parser evidence and the digests needed to bind it
   to one catalog revision. This is the only option that skips parsing across
   separate CLI processes without trusting metadata alone.
2. **Process-local evidence only.** This avoids durable sensitive data, but a
   normal CLI restart loses the evidence and must parse every unchanged file.
   It does not meet the persistent incremental-consumer requirement.
3. **Metadata-only skip.** This is fast but would return no sessions when a
   catalog row exists without recoverable evidence. It is rejected because it
   silently discards evidence.

The source catalog contract is not widened. `SourceCatalogEntry` keeps exactly
its current fields and validation rules. Cache payload, sensitivity labels, and
cache digests live behind a separate `source_evidence_cache` API and table.

## Store v5 schema and compatibility

Store v5 adds one table and one migration marker,
`schema-v5-source-evidence-cache`. Existing v2, v3, and v4 stores migrate in one
`IMMEDIATE` transaction through the already-defined additive schemas before the
v5 table is created. Fresh v0 stores create the complete v5 schema. Existing
analysis, execution, finding, dismissal, adoption, budget, catalog, and legacy
migration rows are neither copied nor rewritten. Reopening v5 is a no-op.

The new table has one row per catalog source:

```text
source_evidence_cache
  source_identity              primary key, references source_catalog
  adapter_id                   claude | codex
  content_revision             sha256: followed by 64 lowercase hex characters
  parser_version               non-empty, NUL-free
  schema_fingerprint           sha256: followed by 64 lowercase hex characters
  last_parsed_offset           non-negative safe integer
  line_count                   non-negative safe integer
  ends_with_newline            0 | 1
  payload_json                 canonical normalized-evidence JSON
  payload_digest               sha256: followed by 64 lowercase hex characters
  descriptor_digest            sha256: followed by 64 lowercase hex characters
  sensitivity                  sensitive
  retention_class              raw_evidence
  updated_at_ms                non-negative safe integer
```

SQLite constraints repeat all closed-enum, digest, integer, and fixed-label
rules. The foreign key uses `ON DELETE CASCADE`. A usable cache row must match
the corresponding catalog row on source identity, adapter, content revision,
parser version, schema fingerprint, and parsed offset. The catalog row must be
`complete` and parsed through its current size.

Catalog and evidence writes share one `IMMEDIATE` transaction. Validation and
canonical JSON generation occur before the transaction. If the catalog upsert
is stale or unchanged, the cache write must be compatible with the current row;
an equal-time conflict or mismatched revision aborts. A trigger, disk, busy, or
constraint failure rolls both changes back. The already-established Store
directory mode `0700`, database mode `0600`, symlink rejection, WAL mode,
foreign-key enforcement, and busy timeout protect the new table as they protect
the rest of the Store.

Opening any supported older Store is part of normal operation. An unsupported,
corrupt, or unavailable Store disables this optimization for that analysis; it
does not disable source parsing.

## Normalized-evidence envelope

The cache stores parser output, not raw JSONL bytes or raw source rows. Its
closed v1 envelope is:

```ts
interface SourceEvidenceEnvelopeV1 {
  schema_version: 1;
  adapter_id: "claude" | "codex";
  sessions: Session[];
  parse_warnings: SourceWarning[];
}
```

Claude stores all sessions and parse-level warnings returned for one transcript.
Codex stores zero or one session and an empty parse-level warning array. Empty
or warning-only parser results are cacheable; otherwise an unchanged malformed
file would still be reparsed forever.

One shared strict normalizer is applied to both fresh parser output before it is
cached and restored payload after it is read. It snapshots own enumerable data
properties without invoking accessors, rejects unknown or missing fields,
validates every `Session`, event variant, warning, JSON input value, capability,
timestamp, byte count, branch epoch, and optional field, enforces the same
source/event ordering emitted by the current parsers, and returns a detached
plain clone. It rejects payload JSON above 128 MiB and applies explicit node and
nesting bounds before recursively validating tool input. Cached output is cloned
again for every consumer call. Hostile or non-canonical payloads are a cache
miss and never reach discovery or analysis.

`payload_digest` is a domain-separated SHA-256 of the canonical envelope JSON.
`descriptor_digest` is a domain-separated SHA-256 of the source descriptors
recomputed from the normalized sessions in deterministic order. A cache hit
requires both digests to match. Neither identity, digest, error, nor warning
contains prompt text, tool input, tool output, command text, paths from payload
content, or rejected database values.

Normalized sessions can themselves contain sensitive prompt, command, path,
edit, and output evidence. The row therefore carries fixed `sensitive` and
`raw_evidence` labels and is covered by the current local Store boundary. Raw
JSONL bodies are not copied. Configurable retention/quota enforcement and
encryption at rest remain separate approved enterprise-hardening PRs; this PR
does not claim those controls already exist.

## Canonical source observation

For every regular JSONL candidate the consumer creates a stable observation:

- `source_identity` is a domain-separated digest of adapter id and canonical
  path. Rotation at the same path updates one catalog identity and is detected
  independently through device/inode and content signals.
- device/inode are stored only when both values are non-negative safe integers;
  otherwise both are `null`, including portable Windows operation.
- mtime is truncated to a non-negative safe integer, size is exact, and the
  content revision is SHA-256 over every source byte.
- prefix and suffix hashes cover fixed bounded windows and are diagnostics for
  rotation/change classification. Append safety never relies only on those
  bounded hashes.
- the discovery cursor is monotonic for a source. Direct catalog probes retain
  the current cursor; a newly observed revision advances it. It never controls
  whether cached evidence exists.
- parser version and schema fingerprint are adapter constants. Changing either
  makes every older cache row a cold-parse miss.

Hashing reads bytes but performs no JSON parsing or normalization. The file is
observed again after parsing. If identity, size, mtime, or revision moved during
the operation, no cache is committed. One cold retry is allowed; a second
change returns the parser evidence with a content-free warning and abandons the
optimization for that file.

## Catalog-first discovery

Each adapter separates known-source probing from new-file discovery:

1. List catalog entries for that adapter in `source_identity` order.
2. Directly stat each known canonical path, deduplicate canonical targets, and
   process eligible known files through the catalog path rather than through a
   recursive-scan parse path.
3. Run a distinct deterministic recursive scan only for paths not already in
   the known set. The scan still enumerates known directory entries solely to
   reconcile new paths, but never re-stats, re-hashes, or re-parses a known path.
   Directory entries are ordered by JavaScript code units. A hard adapter safety
   ceiling plus `AnalysisBudgetMeter` wall/CPU checkpoints bounds the scan.
   Hitting either bound produces partial coverage and a content-free warning
   rather than claiming discovery was complete.
4. Union known and new candidates and preserve the existing source/session/event
   ordering and deduplication rules.

This removes repeated recursive discovery work for known canonical source
files, while retaining a bounded reconciliation scan for newly-created files.
Persisting a directory-tree index or adding a file watcher is outside this PR;
the bounded new-file scan makes that remaining cost explicit rather than
silently omitting new evidence.

Missing known files are not evidence for deletion: their rows remain until a
later retention/GC policy removes them. A replacement discovered at the same
canonical path is classified by the normal rotation rules.

## Cache decision matrix

A cache hit is allowed only when all of these facts hold:

- the catalog and evidence rows both validate;
- source identity, adapter, full content revision, parser version, schema
  fingerprint, parsed offset, and completeness agree;
- payload and descriptor digests recompute exactly;
- the current observation still matches after load;
- the normalized envelope passes the fresh-output validator.

The consumer decisions are:

| State | Action |
|---|---|
| exact complete match | return a detached persistent-cache clone; parser count is zero |
| cache missing/corrupt/unknown | cold full parse, then atomically replace catalog+cache |
| partial catalog/cache or partial budget admission | cold bounded parse; do not publish a reusable complete cache |
| parser/schema mismatch | cold full parse |
| device/inode change | cold full parse |
| size shrank | cold full parse |
| same-size revision change | cold full parse |
| prior full digest differs from current prefix | cold full parse |
| verified append-only suffix | suffix parse and conservative merge; otherwise cold full parse |

Catalog metadata alone never returns an empty result and never suppresses a
parser. A cache read/write failure attaches one deterministic warning when
possible, returns the fresh/cached evidence already available, rolls back any
partial Store write, and disables the optimization for that source operation.

## Append-only parsing and merge

Append mode requires all of the following:

- matching source identity, adapter, device/inode pair, parser version, schema
  fingerprint, and complete validated evidence;
- current size strictly greater than the stored parsed offset;
- the SHA-256 of current bytes `[0, previous.size_bytes)` equals the prior full
  `content_revision`;
- the prior source was empty or ended at a JSONL record boundary;
- the suffix reader starts at the prior byte offset with global line numbering
  `previous.line_count + 1`.

The JSONL reader accepts an explicit byte start and line base. Parser budgets
apply to admitted source bytes exactly as before. Adapter merge rules preserve
all prior events and warnings, append new source indices, seed Codex session
metadata and Claude branch/agent context from validated prior sessions, and
recompute session bounds, capabilities, confidence, observed cwd/branch sets,
and ordering.

Ambiguous cross-boundary constructs cause a cold full parse. These include a
Claude assistant message id or tool id that would revise a cached group without
enough normalized state, a branch first appearing only in the suffix when it
would retroactively scope prefix rows, a duplicate event identity with different
content, a Codex session metadata conflict, a partial final prefix line, or an
adapter invariant the merge code does not recognize.

The acceptance property is stronger than selected fixture assertions: for each
supported append case, canonical JSON of the merged envelope must be byte-for-
byte equal to a cold full parse of the resulting file. Property fixtures cover
multibyte UTF-8, LF/CRLF, empty/auxiliary rows, warnings, multiple Claude
sessions, Codex metadata, branch continuity, sidechains, tool pairs, duplicate
ids, and unsafe fallbacks. If equivalence cannot be established, append mode is
not used.

## Analysis budget semantics

Incremental reuse is an optimization, not a budget bypass:

- every visited file still consumes one source item in existing deterministic
  adapter order;
- the current full file size is admitted against `max_input_bytes`, including a
  cache hit;
- restored events pass through the existing `admitSessionEventPrefix`, so
  `max_input_events` and event ordering are unchanged;
- wall and CPU checkpoints continue during known-path probes, hashing, bounded
  new-file scan, cache validation, suffix merge, and cold parsing;
- an input-byte or event limit that admits only a prefix cannot publish a
  complete cache or replace an earlier complete row;
- source-file discovery/read/parse failures call the existing source-failure
  accounting path. Cache-only failures add a warning and abandon the
  optimization without marking otherwise valid source evidence as failed.

The same budgets therefore produce the same admitted evidence and coverage as a
cold run. Cache use can reduce CPU time but cannot make reported consumption or
completeness more favorable by skipping accounting.

## Failure and crash behavior

- Parser success precedes Store mutation. A crash before commit leaves the old
  catalog/cache pair; the next process either reuses that still-matching pair or
  cold parses.
- Catalog and evidence become visible together. A forced failure between their
  SQL statements rolls both back.
- A crash after commit leaves a complete pair that validates independently of
  process memory.
- Store open, read, decode, validation, digest, or write failure is isolated to
  the optimization. The parser path still runs and the analysis result is kept.
- No error message includes rejected payload, hash input, transcript content, or
  secret-bearing source data.
- Symlinks retain the existing adapter escape rules and canonical-path
  deduplication. Non-regular files are not cached.

## Integration and compatibility

Only the built-in Claude+Codex default source uses the persistent consumer.
Injected `SessionSource` implementations keep their current API and behavior.
`persist: false` does not create or update the persistent cache. Store paths are
resolved once and the Store connection is closed in `finally`, including source
errors and budget exits.

The command output format, Report v2, analysis snapshot identity, findings,
privacy projection, CLI flags, and source descriptor contract do not change.
For identical source bytes, configuration, Git context, and history, a warm run
must produce the same canonical report, source descriptors, findings, warnings,
and snapshot source digest as a cold run.

## Edge cases

- v0 bootstrap and populated v2/v3/v4 migrations; repeated v5 opens; migration
  rollback after table creation and after catalog update.
- Missing, stale, equal-time-conflicting, foreign-source, corrupt JSON,
  non-canonical JSON, hostile accessor, extra-field, digest-mismatched, descriptor-
  mismatched, wrong-label, and unknown-schema cache rows.
- Empty files, warning-only files, no-session Codex files, multiple-session
  Claude transcripts, zero-byte append, LF, CRLF, and a non-newline EOF.
- Same device/inode with preserved mtime and middle-byte rewrite, same-size
  replacement, larger non-append rewrite, smaller truncation, inode rotation,
  null portable identity, symlink duplicates, and file mutation during parse.
- Parser/schema upgrade, complete-to-partial budget run, prior partial catalog,
  max source/input/event/wall/CPU exhaustion, and cache hit under each budget.
- Deterministic known/new discovery order, hard reconciliation ceiling, missing
  known paths, newly-created earlier-sorting paths, and duplicate canonical paths.
- Write failure after successful parsing, read-only/unavailable Store, crash
  before/inside/after the atomic commit, and detached clone mutation by callers.

## Scope

Included are Store v5 migration, the separate evidence-cache API, strict
normalized evidence validation, source observation, safe cache reuse, safe
append merge, catalog-first built-in discovery, budget accounting, CLI-restart
integration coverage, and documentation of the local sensitive-data boundary.

Excluded are encryption at rest, configurable retention/quota, cache GC/repair,
directory-tree persistence, filesystem watchers, background processing,
organization export, Report v3, new rules, and any new CLI option.
