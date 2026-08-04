# Incremental Source Catalog Consumer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist query-independent Claude/Codex parser state and a safe directory cursor so unchanged sources survive CLI restarts without reparse or full recursive discovery, while every warm result remains canonically equivalent to a cold run.

**Architecture:** Store v5 adds separate evidence and discovery-root tables without changing the exact `source_catalog` contract. Parsers first create closed, versioned, query-independent state from one no-follow file handle, then a shared projector applies `endedAtMs`. Discovery unions known and new candidates under one cold comparator before budgets; source evidence is committed atomically only after repository eligibility.

**Tech Stack:** TypeScript ESM, Node.js `FileHandle`/streams/test runner, `better-sqlite3`, SQLite WAL, SHA-256, existing `AnalysisBudgetMeter`.

---

## File map and approved scope

Production:

- Modify `src/sources/jsonl-budget.ts`: same-handle range reads and byte digest
  receipts.
- Modify `src/sources/claude/parser.ts`: versioned query-independent state and
  shared end-window projector.
- Modify `src/sources/codex/parser.ts`: versioned query-independent state and
  shared end-window projector.
- Modify `src/store/sqlite.ts`: additive Store v5 migration for two tables.
- Create `src/store/source-evidence-cache.ts`: strict foreign-bound evidence
  envelope and atomic catalog/cache API.
- Create `src/store/source-discovery.ts`: strict directory-root cursor API.
- Create `src/sources/source-observation.ts`: no-follow handle, observation,
  classification, receipts, and ABA checks.
- Create `src/sources/incremental.ts`: prepare/project/eligibility-commit consumer
  and append merge.
- Modify `src/sources/claude/discover.ts`: cursor reconciliation and the unified
  cold-ordered candidate set.
- Modify `src/sources/codex/discover.ts`: cursor reconciliation and the unified
  cold-ordered candidate set.
- Modify `src/core/analyze.ts`: default-source lifecycle and dependency wiring.
- Modify `README.md`: sensitive normalized-evidence boundary and missing future
  controls.

Tests:

- Create `test/parser-state.test.ts`.
- Modify `test/store.test.ts`.
- Create `test/source-evidence-cache.test.ts`.
- Create `test/source-discovery-cache.test.ts`.
- Create `test/incremental-source-catalog.test.ts`.
- Modify `test/docs.test.ts` only for the new disclosure contract.

Together with this plan/design, expect 20 changed files, 1,600–2,200 production
lines, and 1,400–2,000 test lines. The user explicitly approved the larger
schema/design scope. Do not add a watcher, queue, cron, outbox, lease, lock
service, GC/repair command, Report v3 field, rule, or CLI option.

## Pre-change semantic inventory

The TypeScript LanguageService reported zero semantic diagnostics and:

```text
STORE_SCHEMA_VERSION             9 refs / 2 files
openStoreDatabase               92 refs / 11 files
JsonlParserControls              6 refs / 3 files
boundedJsonlLines                5 refs / 3 files
ClaudeTranscriptParseOptions     4 refs / 1 file
parseClaudeTranscriptDetailed   17 refs / 3 files
ParseCodexSessionOptions         3 refs / 1 file
parseCodexSession               38 refs / 3 files
discoverClaudeSessions          19 refs / 2 files
ClaudeSessionSource             24 refs / 4 files
discoverCodexSessions            2 refs / 1 file
CodexSessionSource              14 refs / 4 files
AnalyzeOptions                  13 refs / 3 files
```

Keep every current call form source-compatible. Before each shared signature
change, delegate a fresh LanguageService reference/definition inventory; after
it, delegate semantic diagnostics and require zero.

## Complete API vocabulary

Tasks use only the following names and signatures. Tests may define local
literal parser/schema strings before the production constants exist, so RED
must fail for behavior rather than an unrelated missing test import.

### Parser/read contracts

```ts
export interface ParserReadRange {
  start_offset: number;
  starting_line: number;
}

export interface SourceReadReceipt {
  start_offset: number;
  end_offset: number;
  bytes_read: number;
  digest: string;
}

export interface ParserStateReadResult<State> {
  state: State;
  receipt: SourceReadReceipt;
}

export interface ParserStateWarningV1 {
  scope: "source" | "session";
  target_session_id: string | null;
  warning: SourceWarning;
}

export interface JsonlReadWindow extends ParserReadRange {
  file_handle: FileHandle;
}

export function boundedJsonlLines(
  sourcePath: string,
  tracker: JsonlBudgetTracker,
  window?: JsonlReadWindow,
): AsyncGenerator<JsonlLine, SourceReadReceipt>;

export const CLAUDE_PARSER_VERSION = "2.0.0";
export const CODEX_PARSER_VERSION = "2.0.0";
export const PARSER_STATE_SCHEMA_FINGERPRINT =
  "sha256:fb8892dbe61732ba057b6c36f6212f8cc560f3d098560260937117d74c6df06f";

export interface ClaudeParserStateV1 {
  kind: "claude-state-v1";
  canonical_path: string;
  parsed_offset: number;
  line_count: number;
  ends_with_newline: boolean;
  retained_bytes: number;
  warning_count: number;
  warning_overflowed: boolean;
  rows: ClaudeStateRowV1[];
  branch_lanes: ClaudeBranchLaneV1[];
  ancestry: ClaudeAncestryV1[];
  assistant_groups: ClaudeAssistantGroupV1[];
  result_positions: ClaudeResultPositionV1[];
  warnings: ParserStateWarningV1[];
}

export interface CodexParserStateV1 {
  kind: "codex-state-v1";
  canonical_path: string;
  parsed_offset: number;
  line_count: number;
  ends_with_newline: boolean;
  retained_bytes: number;
  warning_count: number;
  warning_overflowed: boolean;
  rows: CodexStateRowV1[];
  session_metadata: CodexSessionMetadataV1 | null;
  seen_subtypes: string[];
  warnings: ParserStateWarningV1[];
}

export async function readClaudeParserState(options: {
  sourcePath: string;
  fileHandle: FileHandle;
  range?: ParserReadRange;
  seed?: ClaudeParserStateV1;
  budgets?: Partial<JsonlParserBudgets>;
  signal?: AbortSignal;
}): Promise<ParserStateReadResult<ClaudeParserStateV1>>;

export function projectClaudeParserState(
  state: ClaudeParserStateV1,
  options?: { endedAtMs?: number },
): ClaudeTranscriptParseResult;

export function normalizeClaudeParserState(
  value: unknown,
): ClaudeParserStateV1;

export async function readCodexParserState(options: {
  sourcePath: string;
  fileHandle: FileHandle;
  range?: ParserReadRange;
  seed?: CodexParserStateV1;
  budgets?: Partial<JsonlParserBudgets>;
  signal?: AbortSignal;
}): Promise<ParserStateReadResult<CodexParserStateV1>>;

export function projectCodexParserState(
  state: CodexParserStateV1,
  options?: { endedAtMs?: number },
): Session | null;

export function normalizeCodexParserState(
  value: unknown,
): CodexParserStateV1;
```

Receipt ranges are half-open `[start_offset, end_offset)`, and `bytes_read` must
equal their difference. `ParserStateReadResult.receipt` describes only that call;
it is never serialized into a seeded/merged parser state.

`ClaudeStateRowV1`, `CodexStateRowV1`, and their index types are closed exported
unions/interfaces in their adapter modules. They contain the exact variants in
the design and no `Record<string, unknown>` escape hatch.

### Store contracts

```ts
export interface SourceEvidenceEnvelopeV1 {
  schema_version: 1;
  adapter_id: SourceAdapterId;
  canonical_path: string;
  full_sessions: Session[];
  parse_warnings: SourceWarning[];
  continuation: ClaudeParserStateV1 | CodexParserStateV1;
}

export interface SourceEvidenceCacheEntry {
  source_identity: string;
  adapter_id: SourceAdapterId;
  canonical_path: string;
  content_revision: string;
  parser_version: string;
  schema_fingerprint: string;
  last_parsed_offset: number;
  line_count: number;
  ends_with_newline: boolean;
  payload_json: string;
  payload_digest: string;
  descriptor_digest: string;
  sensitivity: "sensitive";
  retention_class: "raw_evidence";
  updated_at_ms: number;
}

export interface SourceDiscoveryRoot {
  root_identity: string;
  adapter_id: SourceAdapterId;
  canonical_root: string;
  cursor: number;
  capability: "stable_directory_token" | "full_scan_required";
  tree_json: string;
  tree_digest: string;
  observed_at_ms: number;
  completeness: "complete" | "partial";
  sensitivity: "sensitive";
  retention_class: "source_metadata";
}

export type SourceEvidenceCacheErrorCode =
  | "invalid_shape" | "unknown_field" | "invalid_text" | "invalid_hash"
  | "invalid_integer" | "invalid_state" | "foreign_binding"
  | "digest_mismatch" | "observation_conflict" | "progress_regression";

export class SourceEvidenceCacheError extends Error {
  constructor(readonly code: SourceEvidenceCacheErrorCode);
}

export function normalizeSourceEvidenceEnvelope(
  value: unknown,
): SourceEvidenceEnvelopeV1;
export function validateSourceEvidenceCacheEntry(
  value: unknown,
): SourceEvidenceCacheEntry;
export function validateSourceDiscoveryRoot(
  value: unknown,
): SourceDiscoveryRoot;
export function getSourceEvidencePair(
  database: Database.Database,
  sourceIdentity: unknown,
): { catalog: SourceCatalogEntry; cache: SourceEvidenceCacheEntry } | undefined;
export function commitEligibleSourceEvidence(
  database: Database.Database,
  pair: { catalog: SourceCatalogEntry; cache: SourceEvidenceCacheEntry },
): "inserted" | "updated" | "unchanged" | "stale" | "conflict";
export function getSourceDiscoveryRoot(
  database: Database.Database,
  rootIdentity: unknown,
): SourceDiscoveryRoot | undefined;
export function commitSourceDiscoveryRoot(
  database: Database.Database,
  root: SourceDiscoveryRoot,
): "inserted" | "updated" | "unchanged" | "stale" | "conflict";
```

### Observation/consumer/discovery contracts

```ts
export interface SourceFileObservation {
  adapter_id: SourceAdapterId;
  source_identity: string;
  canonical_path: string;
  device: number | null;
  inode: number | null;
  mtime_ms: number;
  size_bytes: number;
  prefix_hash: string;
  suffix_hash: string;
  content_revision: string;
  previous_prefix_revision: string | null;
  line_count: number;
  ends_with_newline: boolean;
}

export type SourceChangeKind = "unchanged" | "append" | "replace";

export interface SourceHandleStat {
  device: number | null;
  inode: number | null;
  mtime_ms: number;
  size_bytes: number;
}

export async function observeAdmittedSource(options: {
  adapter_id: SourceAdapterId;
  source_identity: string;
  canonical_path: string;
  file_handle: FileHandle;
  stat: SourceHandleStat;
  previous_size_bytes?: number;
  meter?: AnalysisBudgetMeter;
}): Promise<SourceFileObservation>;

export function classifySourceChange(options: {
  previous?: SourceCatalogEntry;
  cache?: SourceEvidenceCacheEntry;
  observation: SourceFileObservation;
  parser_version: string;
  schema_fingerprint: string;
}): SourceChangeKind;

export interface IncrementalWarning {
  code: "source_cache_unavailable" | "source_cache_invalid" |
    "source_cache_write_failed" | "source_changed_during_read" |
    "source_discovery_partial";
  message: string;
}

export interface SourcePrepareContext {
  adapterRoot: string;
  endedAtMs: number;
  observedAtMs: number;
  discoveryCursor: number;
  admittedFileBytes: number;
  meter?: AnalysisBudgetMeter;
}

export interface PreparedSourceEvidence {
  observation: SourceFileObservation | null;
  envelope: SourceEvidenceEnvelopeV1 | null;
  projected_sessions: Session[];
  projected_warnings: SourceWarning[];
  warnings: IncrementalWarning[];
  completeness: "complete" | "partial";
  parser_mode: "cache" | "suffix" | "cold" | "bounded_cold";
}

export interface EligibleSourceEvidence {
  prepared: PreparedSourceEvidence;
  eligible_session_ids: string[];
}

export interface IncrementalSourceCatalogConsumerOptions {
  paths: StorePaths;
  roots: { claude: string; codex: string };
  dependencies?: IncrementalSourceDependencies;
}

export class IncrementalSourceCatalogConsumer {
  constructor(options: IncrementalSourceCatalogConsumerOptions);
  knownPaths(adapter: SourceAdapterId): string[];
  prepareClaude(path: string, context: SourcePrepareContext): Promise<PreparedSourceEvidence>;
  prepareCodex(path: string, context: SourcePrepareContext): Promise<PreparedSourceEvidence>;
  commitEligible(value: EligibleSourceEvidence): IncrementalWarning[];
  close(): void;
}

export interface SourceCandidate {
  adapter_id: SourceAdapterId;
  canonical_path: string;
  origin: "catalog" | "scan";
}

export interface SourceDiscoveryResult {
  candidates: SourceCandidate[];
  cursor: number;
  completeness: "complete" | "partial";
  warnings: SourceWarning[];
}

export function compareSourceCandidates(
  left: SourceCandidate,
  right: SourceCandidate,
): number;
```

`IncrementalSourceDependencies` provides injectable no-follow open/hash/stat,
Claude/Codex state readers/projectors, database open, directory stat/readdir,
and platform capability functions. It is an embedder seam, not a test-only
method. Every default dependency uses production code.

### Task 1: RED query-independent parser state and read receipts

**Files:**

- Create: `test/parser-state.test.ts`

- [ ] **Step 1: Define no-reopen same-handle JSONL receipt behavior**

Open a fixture once, rename/replace its pathname after open, and pass the handle
to the reader. Assert exact half-open offsets, global starting line, digest of
only bytes yielded to the parser, LF/CRLF handling, UTF-8 boundaries, and that
the parser never invokes a path-based open spy.

```ts
assert.deepEqual(readResult.receipt, {
  start_offset: 0,
  end_offset: Buffer.byteLength(raw),
  bytes_read: Buffer.byteLength(raw),
  digest: sha256(raw),
});
```

- [ ] **Step 2: Define T1/T2 projector fixtures**

T1 parses a Claude prefix plus a later post-window branch/message revision.
Compare current public cold output, fresh `readResult.state` projection,
serialized/restored state projection, and a state read before append then
suffix-seeded state. The earlier window must be canonical-byte identical across
all four.

T2 reads a complete unchanged source once, projects an early end, serializes and
restores the full state, then projects a later end. Assert later events appear
and the state reader spy remains zero after restore.

- [ ] **Step 3: Define closed continuation invariants**

Cover Claude branch/epoch transitions, sidechain parent across the suffix,
assistant message grouping/prefix dedupe, tool-result replacement, warning
saturation, retained-byte continuation, and multi-session rows. Cover Codex
session metadata, subtype warning dedupe, call/result pairing, and a suffix with
no metadata. Unknown variants and inconsistent indexes must be rejected rather
than projected.

- [ ] **Step 4: Define parser-resource boundary behavior**

At exact `maxFileBytes`, state is complete. At one byte over, only the admitted
prefix is read, no full-file receipt is claimed, and no reusable complete state
is returned. Retained-byte/warning limits seeded from a prefix must match one
cold full read.

- [ ] **Step 5: Delegate RED verification and commit tests**

Delegate only:

```sh
npm run build:test
node --test .test-dist/test/parser-state.test.js .test-dist/test/claude-parser.test.js .test-dist/test/codex-parser.test.js
```

Expected RED is missing state/read/projector APIs. Commit tests separately:

```sh
git add test/parser-state.test.ts
git commit -m "test(parsers): define query-independent source state"
```

### Task 2: Implement parser state, common projectors, and same-handle reads

**Files:**

- Modify: `src/sources/jsonl-budget.ts`
- Modify: `src/sources/claude/parser.ts`
- Modify: `src/sources/codex/parser.ts`

- [ ] **Step 1: Add constants and closed state types first**

Add the exact parser constants/state unions from the API vocabulary before any
Store module imports them. Compute the checked-in schema fingerprint from the
literal contract label
`ccprof:parser-state:v1\\0claude-state-v1,codex-state-v1,source-read-receipt-v1`
documented beside the constant; the displayed separator is the two literal
ASCII bytes backslash plus `0`, not U+0000. Never hash TypeScript source at
runtime.

- [ ] **Step 2: Add `FileHandle` range reader and receipt**

Extend `boundedJsonlLines` with an optional `JsonlReadWindow` while preserving
the current path call form through a wrapper. Use `createReadStream` with the
provided fd, `autoClose: false`, explicit start, and no pathname reopen. Feed
every admitted buffer into the receipt digest before JSON decoding.

- [ ] **Step 3: Refactor Claude into state-read then projection**

Move physical validation/compaction into `readClaudeParserState`; move
`endedAtMs` filtering to the first step of `projectClaudeParserState`. Rebuild
the existing branch stamping, agent resolution, assistant grouping, result
replacement, warnings, and sessions only from filtered state rows. The existing
public parser calls these two functions and retains its signature/results.

- [ ] **Step 4: Refactor Codex into state-read then projection**

Apply the same split, keeping the current metadata selection, ignored subtype,
status, warning, and session behavior. A seeded suffix accumulates retained and
warning budgets and metadata deterministically.

- [ ] **Step 5: Delegate GREEN, regressions, and LanguageService checks**

Delegate:

```sh
npm run build:test
node --test .test-dist/test/parser-state.test.js .test-dist/test/claude-parser.test.js .test-dist/test/codex-parser.test.js
```

Delegate references for every modified parser/read symbol and require zero
semantic diagnostics.

- [ ] **Step 6: Commit production separately**

```sh
git add src/sources/jsonl-budget.ts src/sources/claude/parser.ts src/sources/codex/parser.ts
git commit -m "feat(parsers): expose query-independent source state"
```

- [ ] **Step 7: Run independent task spec then quality review**

With the worktree clean, the spec reviewer compares Task 1/2 with the design.
After approval, a separate quality reviewer checks descriptor-safe state
validation, resource bounds, same-handle lifecycle, and unchanged public APIs.
Fix in new commits and repeat the relevant review; never amend.

### Task 3: RED Store v5 evidence and directory-root contracts

**Files:**

- Modify: `test/store.test.ts`
- Create: `test/source-evidence-cache.test.ts`
- Create: `test/source-discovery-cache.test.ts`

- [ ] **Step 1: Define exact v5 bootstrap/migrations**

Assert both exact table schemas, constraints, foreign key, one migration marker,
and `user_version = 5` for v0. Build populated v2/v3/v4 fixtures and prove every
preexisting row is unchanged. Inject failures after each table, marker, and
version statement and prove total rollback.

- [ ] **Step 2: Define simultaneous migration behavior**

Open the same v4 database from two workers at one barrier. Assert both opens
succeed, one marker exists, schema is exact v5, and the populated catalog row is
unchanged. Repeat v5 opens and prove idempotence. Version 1, negative, and above
5 must fail before mutation.

- [ ] **Step 3: Define strict evidence foreign binding**

Assert fresh state/envelope normalization and detached clones. Reject hostile
descriptors, extra/raw fields, unknown states, non-canonical ordering, wrong
path/adapter/cardinality, warning path, continuation path, payload copied across
source/path/adapter/revision, payload/descriptor digest mismatch, wrong labels,
offset/line/newline/timestamp disagreement with catalog, unsafe integers,
>128 MiB payloads, and invalid recursive tool input. Errors must not include
`SECRET_CANARY`.

```ts
assert.throws(
  () => normalizeSourceEvidenceEnvelope(foreignPathEnvelope),
  (error: SourceEvidenceCacheError) =>
    error.code === "foreign_binding" && !error.message.includes("SECRET_CANARY"),
);
```

- [ ] **Step 4: Define atomic pair race matrix**

Cover insert, exact same-time replay, different same-time conflict, newer pair,
stale pair, and a trigger between catalog/cache writes. Observe from a second
WAL connection during a blocked transaction and prove it sees old or new pair,
never a mixed revision.

- [ ] **Step 5: Define directory-root cache validation**

Cover exact tree shape/order/digest/root binding, complete/partial rows,
capability enum, stable decimal directory tokens, stale/equal/newer cursors,
detached reads, hostile/corrupt JSON, wrong root/adapter, and fixed labels.

- [ ] **Step 6: Delegate RED and commit tests**

Delegate:

```sh
npm run build:test
node --test .test-dist/test/store.test.js .test-dist/test/source-catalog.test.js .test-dist/test/source-evidence-cache.test.js .test-dist/test/source-discovery-cache.test.js
```

Commit only tests:

```sh
git add test/store.test.ts test/source-evidence-cache.test.ts test/source-discovery-cache.test.ts
git commit -m "test(store): define Store v5 incremental source state"
```

### Task 4: Implement Store v5 strict APIs and atomic persistence

**Files:**

- Modify: `src/store/sqlite.ts`
- Create: `src/store/source-evidence-cache.ts`
- Create: `src/store/source-discovery.ts`

- [ ] **Step 1: Add ordered v5 migration**

Recognize exactly versions 0, 2, 3, 4, and 5. Re-read the version inside the
immediate migration transaction, apply missing v3/v4 schemas, create both v5
tables, insert one marker, and set version 5 in that transaction. Retain current
permission/configuration behavior.

- [ ] **Step 2: Implement strict parser-state/envelope validation**

Use property descriptors, closed field sets, bounded iterative JSON validation,
canonical JSON, adapter state validators, and the full-session projector
cross-check. Enforce adapter/path/warning/cardinality constraints and return
detached plain values.

- [ ] **Step 3: Implement foreign-bound digests and reads**

Domain-separate payload and descriptor digests with source identity, canonical
path, adapter, revision, parser version, schema fingerprint, and labels. Read
catalog/cache through one join and validate the pair together; a lone/mixed row
is a miss, never a partial value.

- [ ] **Step 4: Implement atomic pair and directory-root updates**

Prevalidate outside transactions. For evidence, perform catalog upsert, re-read
the authoritative row, cross-check, then cache upsert inside one immediate
transaction. Implement exact same-time/newer/stale semantics: evidence pairs
return content-free `conflict` for the same observation time with different
content. Directory roots return it for the same cursor with different content,
use equivalent cursor ordering, and never let partial replace newer complete.

- [ ] **Step 5: Delegate GREEN and semantic verification**

Delegate the Task 3 suite plus LanguageService references for Store schema/open
and all new exports. Require zero diagnostics.

- [ ] **Step 6: Commit production only**

```sh
git add src/store/sqlite.ts src/store/source-evidence-cache.ts src/store/source-discovery.ts
git commit -m "feat(store): persist incremental source state"
```

- [ ] **Step 7: Run task spec then quality review**

With the worktree clean, run independent specification review followed by a
separate quality/security review. Fix findings in new commits, never amend, and
repeat the affected review.

### Task 5: RED no-follow observation, append, budgets, and repo gate

**Files:**

- Create: `test/incremental-source-catalog.test.ts`

- [ ] **Step 1: Define observation/classifier matrix**

Cover stable identity/revision, Windows/null identity capability, exact replay,
verified append, same-size rewrite with restored mtime, middle rewrite, larger
non-append rewrite, truncate, inode rotation, parser/schema mismatch, partial
state, and non-newline prefix. Null identity permits exact digest reuse but never
append.

- [ ] **Step 2: Define same-handle and ABA failures**

Inject path swap, rotate/restore, truncate/restore, byte mutation during hash,
byte mutation during parse, restored metadata, and parser-receipt mismatch.
Assert hash/parser/fstat use one handle, the first instability cold-retries once,
the second returns evidence plus `source_changed_during_read`, and no pair is
committed.

- [ ] **Step 3: Define admission-before-hash boundaries**

Instrument hasher calls. At exact parser/analysis file-byte limits, the file is
fully hashed and cacheable. At one byte over, assert full-hash count zero, only
the admitted prefix reaches bounded cold parsing, checkpoints occur, and no
complete cache replaces a prior pair.

- [ ] **Step 4: Define restart/cache/append canonical equivalence**

Cold prepare+eligible commit, close all handles/database, construct a fresh
consumer, and assert unchanged parser count zero with detached canonical-equal
sessions. Append UTF-8/LF/CRLF and every continuation fixture; compare full
envelope and early/late projected windows byte-for-byte with a separate cold
full parse. Unsupported state must cold fallback.

- [ ] **Step 5: Define two-phase repository eligibility**

Parse a source with Repo A, Repo B, and unrelated sessions. Assert prepare writes
nothing. Commit A using unwindowed canonical cwd eligibility and inspect A Store:
only A rows/warnings/state/descriptors exist. Repeat B. An unrelated-only source
commits neither catalog nor cache. A known path outside the currently configured
adapter root is never opened.

- [ ] **Step 6: Define cold/warm budget accounting**

Union fixture candidates in cold order. Assert exact equality for observed and
consumed input bytes, input events, output bytes, source items, and associated
truncation. Assert wall/CPU are allowed to decrease and a tight wall/CPU clock
may admit more warm work; no test fabricates equality for those counters. Cache-
only failures add warning but do not record a source failure.

- [ ] **Step 7: Delegate RED and commit tests**

Delegate:

```sh
npm run build:test
node --test .test-dist/test/incremental-source-catalog.test.js
```

Commit only tests:

```sh
git add test/incremental-source-catalog.test.ts
git commit -m "test(sources): define safe incremental consumption"
```

### Task 6: Implement observation and two-phase incremental consumer

**Files:**

- Create: `src/sources/source-observation.ts`
- Create: `src/sources/incremental.ts`

- [ ] **Step 1: Implement no-follow admitted handle**

Canonicalize/contain the candidate before opening. Use POSIX `O_NOFOLLOW`; use
portable lstat/open/fstat identity checks elsewhere. Stat, source-item admit, and
file-byte admission occur before any full hash. Pass the same handle into hash
and parser dependencies; close in `finally`.

- [ ] **Step 2: Implement observation and receipt binding**

Hash chunk-by-chunk with meter checkpoints. Bind full/suffix parser receipts to
observed ranges. During the admitted full pass, compute the exact prior-size
prefix revision when a prior complete row exists. Rehash and fstat after parse,
then no-follow bind the current path to the same identity. Implement one cold
retry and content-free instability warning.

- [ ] **Step 3: Implement strict cache selection and append**

Require the complete foreign-bound pair. Exact match projects stored state.
Append verifies the entire old prefix digest, stable identity, newline boundary,
and versions using `previous_prefix_revision`, then calls the state reader with
exact offset/global line and seed. Normalize/project the merged state and apply
cold equivalence invariants; every other state cold parses.

- [ ] **Step 4: Implement prepare then eligible commit**

`prepareClaude`/`prepareCodex` never write. `commitEligible` filters unwindowed
sessions, state rows/indexes, and targeted warnings to canonical cwd-eligible
session ids. It retains only content-free source-scoped warnings, reprojects full
sessions, rebuilds bound digests, and atomically commits only a non-empty complete
value. Cache write errors return one warning and preserve the prepared result.

- [ ] **Step 5: Preserve exact four non-time budgets**

Use the already-sorted caller order, existing meter admissions, and
`admitSessionEventPrefix`. Do not debit cached bytes/events differently. Keep
output finalization untouched. Place checkpoints in every hash/parser/validation
batch so wall/CPU savings remain real and observable.

- [ ] **Step 6: Delegate GREEN and commit production**

Delegate Task 5 plus parser-state/source-catalog/cache tests and LanguageService
diagnostics. After GREEN, commit production separately:

```sh
git add src/sources/source-observation.ts src/sources/incremental.ts
git commit -m "feat(sources): reuse repository-bound source evidence"
```

- [ ] **Step 7: Run task spec then quality/security review**

With the worktree clean, run the two independent reviews in that order. Fix in
new commits, never amend, and repeat the affected review.

### Task 7: RED safe directory cursor, cold ordering, and analyzer restart

**Files:**

- Modify: `test/incremental-source-catalog.test.ts`
- Modify: `test/docs.test.ts`

- [ ] **Step 1: Define stable cursor and full-scan fallback**

Build a directory tree with known/new/nested sources. Assert unchanged stable
tokens stat every known directory but readdir none, changed parent readdir only
that branch, and new files/dirs are found. The positive capability fixture must
guarantee that every child-set mutation changes its token; timestamp shape alone
does not enable reuse. Null identity, Windows, unrecognized/remote filesystem,
coarse or backward time, equal-token conflict, invalid token, and unsupported
capability must full scan and cannot claim cursor reuse.

- [ ] **Step 2: Define cursor ABA and deterministic full reconciliation**

Mutate a directory during readdir, restore its metadata, and assert second stat
causes a full scan. Repeat instability: result is partial and cursor does not
advance. Force a complete full reconciliation every 32 successful cursors;
assert it discovers an injected token-anomaly file and resets the deterministic
cycle without depending on wall time. This periodic check is defense in depth;
no test treats it as permission to claim complete on an unproven filesystem.

- [ ] **Step 3: Define exact ceilings/depth/symlink placement**

Assert root is not counted; entry 100,000 is processed and 100,001 is not. A
depth-64 directory is read, file children are processed, and a depth-65 child is
counted but not descended. Assert Claude symlink count/within-root regular target
dedupe/escape warnings and Codex no-symlink behavior. A stop creates partial tree
state, no reusable cursor, `source_discovery_partial` on sessions and Report v2
caveats; an empty result uses the typed source error. Budget stops also retain
their existing `analysis_budget` truncation.

- [ ] **Step 4: Define union-before-admission order**

Create a newly scanned path that sorts before a known catalog path. Assert the
complete known+new union is deduplicated and sorted Claude-before-Codex then by
code units before source/input/event admission. Warm and cold admitted prefixes
must match for source/input/event limits.

- [ ] **Step 5: Define CLI-process restart integration**

Run `analyze()` with persisted built-in sources, close all state, and run again
with fresh dependencies. Assert unchanged parser counts and unchanged-directory
readdir counts are zero, while canonical report/findings/descriptors/warnings/
snapshot source digest match cold. Change one source and one directory; only
those paths are re-read/reparsed. `persist:false` and injected `SessionSource`
retain current behavior.

- [ ] **Step 6: Define the README disclosure contract**

Add an exact docs assertion for the sensitive normalized-state boundary, the
fact that raw JSONL is not copied, current local file protections, content-free
identities/errors, and explicitly deferred encryption, retention/quota, and
GC/repair controls.

- [ ] **Step 7: Delegate RED and commit tests**

Delegate focused build/tests, then commit only the additional RED:

```sh
git add test/incremental-source-catalog.test.ts test/docs.test.ts
git commit -m "test(core): define cursor-backed source discovery"
```

### Task 8: Implement directory reconciliation and default-source integration

**Files:**

- Modify: `src/sources/claude/discover.ts`
- Modify: `src/sources/codex/discover.ts`
- Modify: `src/core/analyze.ts`
- Modify: `README.md`

- [ ] **Step 1: Implement stable directory tokens and cursor reconciliation**

Use dev/inode/mtimeNs/ctimeNs decimal tokens and an explicit capability check
that positively identifies the child-set mutation guarantee; do not infer it
from field shape. Stat every cached directory. Reuse listings only for unchanged
proven tokens; readdir changed/new branches. Surround reconciliation with same-
directory second stats, use full scan on uncertainty, and force full
reconciliation on cursor multiples of 32. Never publish partial as complete.

- [ ] **Step 2: Implement exact scan bounds and warnings**

Use checked-in inclusive entry/depth constants and current adapter symlink rules.
Count before classification, checkpoint every operation, keep deterministic
prefixes, and route partial warnings/errors exactly as Task 7 specifies.

- [ ] **Step 3: Union/sort before every admission**

Load root-contained known paths, reconcile new paths, canonical-deduplicate the
whole union, apply `compareSourceCandidates`, and only then visit/admit. Pass each
candidate through prepare, unwindowed repo eligibility, and optional commit
before existing time/branch/alignment logic.

- [ ] **Step 4: Wire analyzer lifecycle without custom-source drift**

Resolve Store paths and roots once, create the consumer only for persisted
built-in sources, and close it in `finally`. Add optional
`incrementalSourceDependencies` to `AnalyzeOptions` without changing existing
callers. Cache/store failures fall back fresh and surface one sanitized warning.

- [ ] **Step 5: Document the sensitive boundary**

README must say normalized parser state can contain prompt, command, path, edit,
and output evidence; raw JSONL is not copied; Store currently uses local 0700/
0600/symlink protections; identities/errors omit content; encryption,
configurable retention/quota, and GC/repair are separate future controls. Make
the Task 7 docs assertion GREEN without weakening it.

- [ ] **Step 6: Delegate GREEN and impacted regressions**

Delegate:

```sh
npm run build:test
node --test .test-dist/test/incremental-source-catalog.test.js .test-dist/test/claude-discover.test.js .test-dist/test/codex-discover.test.js .test-dist/test/analyze-integration.test.js .test-dist/test/analysis-budgets-integration.test.js .test-dist/test/determinism-golden.test.js .test-dist/test/docs.test.js
```

Delegate LanguageService refs/diagnostics for discover classes/functions and
`AnalyzeOptions`; require zero diagnostics.

- [ ] **Step 7: Commit production/docs**

```sh
git add src/sources/claude/discover.ts src/sources/codex/discover.ts src/core/analyze.ts README.md
git commit -m "feat(core): reconcile incremental source discovery"
```

- [ ] **Step 8: Run task spec then quality/security review**

With the worktree clean, run independent specification review followed by the
separate quality/security review. Fix in new commits, never amend, and repeat the
affected review.

### Task 9: Whole-branch verification and PR lifecycle

- [ ] **Step 1: Run independent whole-spec review**

Give a fresh reviewer the audit, revised design/plan, merge base, commits, and
diff. Require explicit verdicts for T1/T2, closed continuation, foreign binding,
repo gate, no-follow receipts/ABA, admission-before-hash, append equivalence,
directory no-miss capability/fallback, exact bounds, deterministic budgets,
Store migrations/races, privacy disclosure, and no extra scope. Fix all P0–P2
introduced issues in new commits and re-review.

- [ ] **Step 2: Run separate whole quality/security review**

Check hostile data, secrets, resource bounds, digest domains, handle/database
lifecycle, transaction visibility, Windows/null identity, cursor token safety,
TOCTOU/ABA, deterministic ordering, and maintainability. Fix and re-review.

- [ ] **Step 3: Delegate fresh full verification**

The owner must not run tests/static analysis. Delegate and retain exact output:

```sh
npm run build
npm run check
git diff --check origin/main...HEAD
```

Then delegate `/run-github-actions-locally`. Any failure gets a reproducing RED,
new fix commit, and full fresh rerun.

- [ ] **Step 4: Rebase latest main and repeat verification**

```sh
git fetch origin main
git rebase origin/main
```

Do not choose a semantic conflict side without review. Delegate focused/full
checks and local Actions again after rebase.

- [ ] **Step 5: Push and create the ready PR**

```sh
git push -u origin feature/incremental-source-catalog
gh pr create --base main --head feature/incremental-source-catalog \
  --title "[Sources] feat: consume the incremental source catalog" \
  --body-file /tmp/ccprof-incremental-source-catalog-pr.md
```

The PR body includes schema/privacy boundary, cold/warm evidence, cursor fallback,
budget facts, local Actions evidence, and excluded future controls.

- [ ] **Step 6: Complete CI/review, merge, and cleanup**

Wait for remote checks/reviews. Apply the repository billing-block rule when all
jobs fail under five seconds. Fix actionable introduced findings in new commits.
Under standing authorization merge through the PR, never locally. Read and run
`worktree-pr-flow:cleanup` to remove only this worktree and local branch.

## Plan self-review and requirement map

- Review item 1: query-independent state/common projector/T1/T2 — Tasks 1–2.
- Item 2: closed adapter continuation and cold fallback — Tasks 1–2, 5–6.
- Item 3: union comparator and four non-time budget equivalence — Tasks 5–8.
- Item 4: repo eligibility before commit/root containment — Tasks 5–6, 8.
- Item 5: same no-follow handle/parser receipt/ABA — Tasks 1–2, 5–6.
- Item 6: admission immediately after stat/no over-limit hash — Tasks 5–6.
- Item 7: self-contained API and dependency order — API vocabulary, Tasks 1–8.
- Items 8–9: complete directory cursor, fallback, exact bounds/placement —
  Tasks 3–4, 7–8.
- Item 10: foreign-bound digest/path/adapter/cardinality — Tasks 3–4.
- Item 11: Windows capability and migration/pair races — Tasks 3–7.
- Every production task follows an observed RED and receives spec review before
  quality review. RED and production commits remain separate; no amend or local
  merge is used.
- Encryption, retention/quota, GC/repair, background infrastructure, Report v3,
  and new rules/CLI surface remain explicitly outside this PR.
