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
- Create `src/sources/directory-cursor.ts`: shared capability detector, bounded
  tree reconciliation, and candidate union.
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

Together with this plan/design, expect 21 changed files, 1,800–2,500 production
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
  completeness: "complete" | "partial";
}

export interface ParserStateWarningV1 {
  order: number;
  applicability:
    | { kind: "unconditional" }
    | { kind: "timestamp"; timestamp_ms: number };
  scope: "source" | "session";
  target_session_id: string | null;
  warning: SourceWarning;
}

export interface ParserStateRowBaseV1 {
  original_bytes: number;
  byte_start: number;
  byte_end: number;
  line: number;
  timestamp_ms: number;
}

export type ParserReadBudgets = Pick<JsonlParserBudgets,
  "maxFileBytes" | "maxLineBytes" | "maxNodesPerLine" |
  "maxNestingDepth">;
export type ParserProjectionBudgets = Pick<JsonlParserBudgets,
  "maxRetainedBytes" | "maxWarnings">;

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
export const MAX_INCREMENTAL_PARSER_STATE_BYTES = 128 * 1024 * 1024;
export const PARSER_STATE_SCHEMA_FINGERPRINT =
  "sha256:bd3f8bd7da3819214a46fe96969bdc35b439803e30171218c0564e1f1d75f996";

export class IncrementalParserStateCapacityError extends Error {
  readonly code: "incremental_state_capacity";
}

export interface ClaudeParserStateV1 {
  kind: "claude-state-v1";
  canonical_path: string;
  parsed_offset: number;
  line_count: number;
  ends_with_newline: boolean;
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
  budgets?: Partial<ParserReadBudgets>;
  signal?: AbortSignal;
}): Promise<ParserStateReadResult<ClaudeParserStateV1>>;

export function projectClaudeParserState(
  state: ClaudeParserStateV1,
  options?: {
    endedAtMs?: number;
    budgets?: Partial<ParserProjectionBudgets>;
  },
): ClaudeTranscriptParseResult;

export function normalizeClaudeParserState(
  value: unknown,
): ClaudeParserStateV1;

export async function readCodexParserState(options: {
  sourcePath: string;
  fileHandle: FileHandle;
  range?: ParserReadRange;
  seed?: CodexParserStateV1;
  budgets?: Partial<ParserReadBudgets>;
  signal?: AbortSignal;
}): Promise<ParserStateReadResult<CodexParserStateV1>>;

export function projectCodexParserState(
  state: CodexParserStateV1,
  options?: {
    endedAtMs?: number;
    budgets?: Partial<ParserProjectionBudgets>;
  },
): Session | null;

export function normalizeCodexParserState(
  value: unknown,
): CodexParserStateV1;
```

Receipt ranges are half-open `[start_offset, end_offset)`, and `bytes_read` must
equal their difference. `ParserStateReadResult.receipt` describes only that call;
it is never serialized into a seeded/merged parser state.

Every `ClaudeStateRowV1` and `CodexStateRowV1` variant extends
`ParserStateRowBaseV1`. Their payload/index types are closed exported unions and
interfaces in their adapter modules, with no `Record<string, unknown>` escape
hatch. `original_bytes` is exactly the existing `JsonlLine.bytes` retained cost
(UTF-8 content excluding CR/LF), while the half-open byte range covers physical
source bytes. Readers enforce only `ParserReadBudgets`; projectors apply
`ParserProjectionBudgets` after window selection. The checked-in state-capacity
error triggers the legacy bounded cold pipeline and never a partial cache row.

### Store contracts

```ts
export interface EligibleSourceEvidenceEnvelopeV1 {
  schema_version: 1;
  kind: "eligible-evidence-v1";
  adapter_id: SourceAdapterId;
  canonical_path: string;
  full_sessions: Session[];
  parse_warnings: SourceWarning[];
  continuation: ClaudeParserStateV1 | CodexParserStateV1;
}

export interface NoEvidenceMarkerV1 {
  schema_version: 1;
  kind: "no-evidence-v1";
  adapter_id: SourceAdapterId;
  canonical_path: string;
  reason: "empty" | "other-repository-only";
}

export type SourceEvidenceEnvelopeV1 =
  | EligibleSourceEvidenceEnvelopeV1
  | NoEvidenceMarkerV1;

export interface SourceEvidenceCacheEntry {
  source_identity: string;
  repository_identity: string;
  eligibility_identity: string;
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
  repositoryIdentity: unknown,
  eligibilityIdentity: unknown,
  sourceIdentity: unknown,
): { catalog: SourceCatalogEntry; cache: SourceEvidenceCacheEntry } | undefined;
export function commitEligibleSourceEvidence(
  database: Database.Database,
  repositoryIdentity: unknown,
  eligibilityIdentity: unknown,
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

export interface OperationFileStat {
  device: bigint | null;
  inode: bigint | null;
  size_bytes: bigint;
  mtime_ns: bigint | null;
  ctime_ns: bigint | null;
  kind: "file" | "directory" | "symlink" | "other";
}

export async function observeAdmittedSource(options: {
  adapter_id: SourceAdapterId;
  source_identity: string;
  canonical_path: string;
  file_handle: FileHandle;
  stat: OperationFileStat;
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
  eligibilityRoot: string;
  endedAtMs: number;
  observedAtMs: number;
  discoveryCursor: number;
  parserBudgets?: Partial<JsonlParserBudgets>;
  meter?: AnalysisBudgetMeter;
}

export function sourceEligibilityIdentity(canonicalRoot: string): string;

declare const sourceCommitCandidateBrand: unique symbol;
declare const sourceAdmissionProofBrand: unique symbol;

export interface PreparedUnwindowedEvidenceV1 {
  adapter_id: SourceAdapterId;
  canonical_path: string;
  full_sessions: Session[];
  parse_warnings: SourceWarning[];
  continuation: ClaudeParserStateV1 | CodexParserStateV1;
}

export interface SourceCommitCandidate {
  readonly [sourceCommitCandidateBrand]: true;
  readonly adapter_id: SourceAdapterId;
  readonly source_identity: string;
  readonly canonical_path: string;
  readonly adapter_root: string;
  readonly canonical_repo: string;
  readonly repository_identity: string;
  readonly eligibility_root: string;
  readonly eligibility_identity: string;
  readonly ended_at_ms: number;
  readonly observed_at_ms: number;
  readonly discovery_cursor: number;
  readonly parser_read_budgets: ParserReadBudgets;
  readonly parser_projection_budgets: ParserProjectionBudgets;
  readonly parser_version: string;
  readonly schema_fingerprint: string;
  readonly observation: SourceFileObservation;
  readonly unwindowed_evidence: PreparedUnwindowedEvidenceV1;
}

export interface PreparedSourceEvidence {
  observation: SourceFileObservation | null;
  envelope: SourceEvidenceEnvelopeV1 | null;
  projected_sessions: Session[];
  projected_warnings: SourceWarning[];
  warnings: IncrementalWarning[];
  completeness: "complete" | "partial";
  parser_mode: "cache" | "suffix" | "cold" | "bounded_cold";
  commit_candidate: SourceCommitCandidate | null;
}

export interface SourceAdmissionProof {
  readonly [sourceAdmissionProofBrand]: true;
}

export interface AdmittedPreparedSource {
  admitted_sessions: Session[];
  commit_proof: SourceAdmissionProof | null;
}

export interface DirectoryTokenV1 {
  device: string;
  inode: string;
  mtime_ns: string;
  ctime_ns: string;
}

export interface DarwinApfsCapabilityEvidenceV1 {
  kind: "darwin-apfs-v1";
  platform: "darwin";
  node_major: 22 | 24;
  filesystem_type: "26";
  canonical_root: string;
  root_device: string;
  root_inode: string;
}

export type DirectoryCursorCapability =
  | { kind: "stable_directory_token";
      evidence: DarwinApfsCapabilityEvidenceV1 }
  | { kind: "full_scan_required"; reason:
      | "platform" | "node" | "filesystem" | "root_identity"
      | "directory_identity" | "timestamp" | "uncertain" };

export const DARWIN_APFS_STATFS_TYPE = 26n;

export function detectDirectoryCursorCapability(options: {
  platform: NodeJS.Platform;
  node_major: number;
  canonical_root: string;
  filesystem_type: bigint;
  root_lstat: OperationFileStat;
  root_fstat: OperationFileStat;
}): DirectoryCursorCapability;

export interface DirectoryEntryObservation {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface DirectoryReadHandle {
  readonly canonical_path: string;
  stat(): Promise<OperationFileStat>;
  readEntries(): Promise<readonly DirectoryEntryObservation[]>;
  close(): Promise<void>;
}

export interface IncrementalSourceDependencies {
  readonly platform: NodeJS.Platform;
  readonly node_major: number;
  openNoFollow(path: string): Promise<FileHandle>;
  fstat(handle: FileHandle): Promise<OperationFileStat>;
  lstatNoFollow(path: string): Promise<OperationFileStat>;
  hashRange(options: {
    handle: FileHandle;
    start_offset: number;
    end_offset: number;
    meter?: AnalysisBudgetMeter;
  }): Promise<SourceReadReceipt>;
  readClaudeState: typeof readClaudeParserState;
  projectClaudeState: typeof projectClaudeParserState;
  readCodexState: typeof readCodexParserState;
  projectCodexState: typeof projectCodexParserState;
  canonicalizeSessionCwds: typeof canonicalizeSessionCwds;
  cwdMatchesRepository: typeof cwdMatchesRepository;
  openStore(paths: StorePaths): Database.Database;
  statfsType(path: string): Promise<bigint>;
  openDirectoryNoFollow(path: string): Promise<DirectoryReadHandle>;
  detectDirectoryCapability: typeof detectDirectoryCursorCapability;
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
  admitPreparedEvents(candidate: SourceCommitCandidate): AdmittedPreparedSource;
  commitEligible(proof: SourceAdmissionProof): Promise<IncrementalWarning[]>;
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
  capability: DirectoryCursorCapability;
  warnings: SourceWarning[];
}

export function compareSourceCandidates(
  left: SourceCandidate,
  right: SourceCandidate,
): number;
```

The consumer owns every `FileHandle`, `DirectoryReadHandle`, and database
returned by dependencies: borrowed hash/stat/parser/projector calls never close
them; the consumer closes primary and final-binding file handles and every
directory handle exactly once in `finally`, and closes the database exactly once
from `close()`. Per-consumer private `WeakMap`s authenticate and advance each
branded candidate through `prepared -> admission proof -> consumed` exactly
once. The candidate record binds the exact prepare-time meter reference (or a
private no-meter sentinel), frozen projected sessions and expected event count;
the opaque proof record binds that candidate and meter and exposes no caller-
settable ids, booleans, counts, sessions, or meter. Every scalar/context/budget
value and detached nested value is deep-frozen, and structural casting cannot
mint either object. The dependency object is an embedder seam, not a test-only
method, and every default member uses production code with the ownership above.

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
all four. Put enough post-window row bytes and warning facts after the end to
overflow tight `maxRetainedBytes`/`maxWarnings` if read-stage accounting leaks;
the earlier projection must remain unchanged.

T2 reads a complete unchanged source once, projects an early end, serializes and
restores the full state, then projects a later end. Assert later events appear
and the state reader spy remains zero after restore.

- [ ] **Step 3: Define closed continuation invariants**

Cover Claude branch/epoch transitions, sidechain parent across the suffix,
assistant message grouping/prefix dedupe, tool-result replacement, warning
saturation after time selection, original-byte accounting, ordered conditional/
unconditional warning facts, and multi-session rows. Cover Codex session
metadata, subtype warning dedupe, call/result pairing, and a suffix with no
metadata. Unknown variants and inconsistent indexes must be rejected rather than
projected.

- [ ] **Step 4: Define parser-resource boundary behavior**

At exact `maxFileBytes`, state is complete. At one byte over, only the admitted
prefix is read, no full-file receipt is claimed, and no reusable complete state
is returned. File/line/node/depth limits remain read-stage; retained-byte/warning
limits are projector-stage and match one cold full read for fresh/restored/
suffix state. Assert exact and one-over
`MAX_INCREMENTAL_PARSER_STATE_BYTES`: one-over takes the legacy bounded cold
pipeline and exposes no reusable state.

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
`ccprof:parser-state:v1\\0claude-state-v1,codex-state-v1,source-read-receipt-v1,warning-fact-v1`
documented beside the constant; the displayed separator is the two literal
ASCII bytes backslash plus `0`, not U+0000. Never hash TypeScript source at
runtime.

- [ ] **Step 2: Add `FileHandle` range reader and receipt**

Extend `boundedJsonlLines` with an optional `JsonlReadWindow` while preserving
the current path call form through a wrapper. Use `createReadStream` with the
provided fd, `autoClose: false`, explicit start, and no pathname reopen. Feed
every admitted buffer into the receipt digest before JSON decoding.

- [ ] **Step 3: Refactor Claude into state-read then projection**

Move query-independent physical validation/compaction and original byte/warning
facts into `readClaudeParserState`; it applies only file/line/node/depth limits
and the fixed reusable-state capacity. Move `endedAtMs`, `maxRetainedBytes`, and
`maxWarnings` to the first projector phases. Rebuild branch stamping, agent
resolution, assistant grouping, result replacement, warnings, and sessions only
from admitted filtered facts. The existing public parser keeps its API and uses
the legacy bounded cold path if the reusable-state cap is exceeded.

- [ ] **Step 4: Refactor Codex into state-read then projection**

Apply the same split, keeping the current metadata selection, ignored subtype,
status, warning, and session behavior. A seeded suffix appends query-independent
facts; every projector invocation reapplies retained/warning budgets from zero.

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
Store repository/eligibility root/source/path/adapter/revision, payload/
descriptor digest mismatch, wrong labels,
offset/line/newline/timestamp disagreement with catalog, unsafe integers,
>128 MiB payloads, and invalid recursive tool input. Errors must not include
`SECRET_CANARY`. Cover the closed eligible-envelope and no-evidence-marker
variants; reject a negative marker containing any continuation, session,
warning, descriptor, or extra field, and require its descriptor digest to bind
the canonical empty descriptor list plus active Store and eligibility
identities. Use two linked-worktree eligibility roots sharing one Store and prove
positive/negative rows cannot cross roots.

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
capability enum, exact `darwin-apfs-v1` evidence, stable decimal directory
tokens, stale/equal/newer cursors, detached reads, hostile/corrupt JSON, wrong
root/adapter/evidence, and fixed labels. Unchanged complete generation N must
write N+1; partial must preserve N.

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
cross-check. Enforce adapter/path/warning/cardinality constraints for positive
entries, the no-raw shape for negative markers, exact capability evidence for
directory roots, and detached plain values.

- [ ] **Step 3: Implement foreign-bound digests and reads**

Domain-separate payload and descriptor digests with Store repository identity,
exact eligibility-root identity, source identity, path, adapter, revision,
parser version, schema fingerprint, and labels. Read
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
state, and non-newline prefix. Preserve operation-local BigInt identity even
when persisted identity is null. Null identity permits exact digest reuse but
never append.

- [ ] **Step 2: Define same-handle and ABA failures**

For cache, suffix, cold, and bounded-cold modes, inject path swap, null-identity
swap, rotate/restore, truncate/restore, mutation during cache validation/hash/
parse, restored metadata, and parser-receipt mismatch. Assert the primary hash/
parser/fstat/rehash use one handle; a separately owned no-follow final-binding
handle rehashes the exact admitted range. The first instability cold-retries
once, the second returns evidence plus `source_changed_during_read`, and no pair
is committed.

- [ ] **Step 3: Define admission-before-hash boundaries**

Instrument open and hasher calls. For `max_source_items`, assert zero opens none,
exact N opens N, and N+1 is never opened. At exact parser/analysis file-byte
limits, the file is fully hashed and cacheable. At one byte over, assert full-
hash count zero, only the admitted prefix reaches bounded cold parsing,
checkpoints occur, and no complete cache replaces a prior pair.

- [ ] **Step 4: Define restart/cache/append canonical equivalence**

Cold prepare+eligible commit, close all handles/database, construct a fresh
consumer, and assert unchanged parser count zero with detached canonical-equal
sessions. Append UTF-8/LF/CRLF and every continuation fixture; compare full
envelope and early/late projected windows byte-for-byte with a separate cold
full parse. A suffix row with a previously unseen session id and unsupported
state both force one full cold reclassification. Any effective parser-budget
override to file/line/node/depth also stays on the bounded cold path and yields
no persistent candidate; retained/warning overrides still reuse the projector.

- [ ] **Step 5: Define two-phase repository eligibility**

Parse a mixed Repo A/Repo B source and assert prepare writes nothing and neither
Store receives a pair; unchanged restarts cold parse again. For all-eligible
input, positive state commits. For exactly empty/warning-free and all-other-
repository/warning-free inputs, inspect a revision-bound no-raw negative marker
and prove an unchanged restart skips parsing. Any warning-bearing empty result
remains uncached. Two linked worktrees share the Store but use distinct
eligibility identities and never reuse each other's marker/state. A known path
outside the configured adapter root is never opened.

- [ ] **Step 6: Define cold/warm budget accounting**

Union fixture candidates in cold order. With a real clock, assert exact equality
only for observed/consumed input bytes, input events, and source items over the
common prefix. Prove output uses the identical limiter and never exceeds or leaks
past it, without asserting real-clock output equality. With one non-stopping
scripted clock, assert canonical/output equality. Wall/CPU may decrease and a
tight clock may admit more warm work; no test fabricates equality. Cache-only
failures add warning but do not record a source failure.

- [ ] **Step 7: Define branded candidate and final commit gate**

Assert `prepare*` itself checkpoints/claims source item before open, stats, and
admits file bytes from the supplied meter/parser budgets. It returns a runtime-
authenticated candidate only for stable complete cold/suffix work. Forged,
replayed, cross-consumer, cache-hit, bounded, and unstable candidates cannot
write. `admitPreparedEvents` must use the privately bound prepare-time meter and
the privately captured projected sessions, return the actual admitted prefix,
and issue an opaque one-shot proof only when its returned event count equals the
captured expected count. Prove that a swapped or omitted caller meter, a skipped
or one-over admission, a forged/replayed/cross-consumer proof, and legacy-shaped
objects with invented eligible ids or `all_projected_events_admitted: true`
cannot write. Even with a valid proof, commit independently canonicalizes every
unwindowed session and makes mixed Repo A/Repo B discard the candidate. Exact
event admission followed by final `checkpoint() === true` is the only write
path; a final wall/CPU stop preserves the old pair. Assert every dependency
handle/database owner closes it exactly once on all exits.

- [ ] **Step 8: Delegate RED and commit tests**

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

Canonicalize/contain the candidate, then use the context meter to checkpoint and
claim the source item before calling `openNoFollow`. On denial, return partial
without open/stat/cache access. Use POSIX `O_NOFOLLOW` and portable lstat/open/
fstat checks elsewhere. After primary-handle stat, apply parser and analysis file-
byte admission before any full hash. The consumer owns and closes every returned
handle exactly once in `finally`.

- [ ] **Step 2: Implement observation and receipt binding**

Hash chunk-by-chunk with meter checkpoints. Bind full/suffix parser receipts to
observed ranges. During the admitted full pass, compute the exact prior-size
prefix revision when a prior complete row exists. Retain raw BigInt stat identity
for this operation even if persistence normalizes it to null. Before every mode
returns, rehash/fstat the primary handle and open a final no-follow binding handle
to rehash the admitted range and compare path content/identity. Implement one
cold retry and content-free instability warning.

- [ ] **Step 3: Implement strict cache selection and append**

Require the complete foreign-bound pair. Exact match projects stored state.
Append verifies the entire old prefix digest, stable identity, newline boundary,
and versions using `previous_prefix_revision`, then calls the state reader with
exact offset/global line and query-independent seed. Reapply retained/warning
budgets in the projector from zero. A new suffix session id, mixed eligibility,
capacity overflow, or other unsupported state cold parses the whole file.

- [ ] **Step 4: Implement prepare then eligible commit**

`prepareClaude`/`prepareCodex` never write. Stable complete cold/suffix work gets
a one-shot branded candidate containing every frozen observation/context value;
cache hits and all partial/unstable paths get `null`. `commitEligible` classifies
the unwindowed result itself using the captured canonical eligibility root plus
the canonicalize/match dependencies: all eligible creates positive evidence;
all ineligible or empty creates a marker only when repository-visible warnings
are empty; mixed or warning-bearing empty consumes/discards without writing. It
never accepts caller-provided eligible ids. Private `WeakMap` membership rejects
forged/replayed/cross-consumer candidates and proofs. Cache write errors return
one warning and preserve the prepared result. Compare effective file/line/node/
depth budgets to the checked-in defaults before cache lookup; any read-budget
override is cold-only and produces no commit candidate, while retained/warning
overrides remain projector inputs.

- [ ] **Step 5: Gate commit after event admission and final checkpoint**

Use the already-sorted caller order and existing `admitSessionEventPrefix`; do
not debit cached bytes/events differently. For a candidate,
`admitPreparedEvents` invokes that helper itself with the exact prepare-bound
meter and frozen projected sessions. It counts actual returned events and mints
the second opaque proof only on an exact count; otherwise it consumes/discards
the candidate. `commitEligible` accepts only that proof, resolves the same meter
from its private record, calls the final `meter.checkpoint()`, checks
`meter.stopped === false`, and only then performs the pair transaction. With no
configured analysis meter, the candidate is bound to the private no-meter
sentinel and the consumer admits the full projection without pretending a clock
checkpoint occurred. An event prefix or time stop preserves any old pair. Keep
the existing output limiter/finalization unchanged, and checkpoint every hash/
parser/validation batch so wall/CPU savings remain observable.

- [ ] **Step 6: Implement the exact dependency seam and ownership**

Implement every `IncrementalSourceDependencies` signature above. Borrowed hash,
stat, parser, projector, cwd-canonicalization, and repository-match functions
never close; the consumer closes primary/binding file handles in `finally`, owns
the Store connection until `close()`, and rejects use after close. No production
function relies on a test-only hook.

- [ ] **Step 7: Delegate GREEN and commit production**

Delegate Task 5 plus parser-state/source-catalog/cache tests and LanguageService
diagnostics. After GREEN, commit production separately:

```sh
git add src/sources/source-observation.ts src/sources/incremental.ts
git commit -m "feat(sources): reuse repository-bound source evidence"
```

- [ ] **Step 8: Run task spec then quality/security review**

With the worktree clean, run the two independent reviews in that order. Fix in
new commits, never amend, and repeat the affected review.

### Task 7: RED safe directory cursor, cold ordering, and analyzer restart

**Files:**

- Modify: `test/incremental-source-catalog.test.ts`
- Modify: `test/docs.test.ts`

- [ ] **Step 1: Define stable cursor and full-scan fallback**

Build a directory tree with known/new/nested sources. Assert unchanged stable
tokens stat every known directory but readdir none, changed parent readdir only
that branch, and new files/dirs are found. Production detection returns stable
only for Node 22/24 + Darwin + APFS `statfs.type === 26n` + matching canonical-
root lstat/fstat BigInt identity, and persists exact root evidence. Every child
directory must remain on that device with valid nanosecond tokens. Linux,
Windows, other Node majors/types/devices, remote/unknown filesystem, null/coarse
identity/time, and detector uncertainty full-scan and cannot claim cursor reuse.

- [ ] **Step 2: Define cursor ABA and deterministic full reconciliation**

Mutate a directory during readdir, restore its metadata, and assert second stat
causes a full scan. Repeat instability: result is partial and cursor does not
advance. Initial generation 1 full-scans. Every unchanged complete run increments
the cursor. Assert generation 31→32 and 63→64 force a full reconciliation
before publishing N, discover an injected token-anomaly file, and do not depend
on wall time. This check is defense in depth; it cannot enable an unallowlisted
filesystem.

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
readdir counts are zero in the stable Darwin/APFS fixture, while a shared non-
stopping scripted clock yields canonical report/findings/descriptors/warnings/
output/snapshot digest equal to cold. Non-allowlisted fixtures full-scan. Change
one source and one directory; only those paths are re-read/reparsed.
`persist:false` and injected `SessionSource` retain current behavior.

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

- Create: `src/sources/directory-cursor.ts`
- Modify: `src/sources/claude/discover.ts`
- Modify: `src/sources/codex/discover.ts`
- Modify: `src/core/analyze.ts`
- Modify: `README.md`

- [ ] **Step 1: Implement stable directory tokens and cursor reconciliation**

Implement `detectDirectoryCursorCapability` and its exact Node 22/24 Darwin/APFS
type-26 allowlist/root evidence; field shape alone cannot enable it. Stat every
cached directory and require same root device. Reuse listings only for unchanged
proven tokens; readdir changed/new branches. Surround reconciliation with same-
directory second stats and full-scan on uncertainty. Compute N from prior N-1,
increment even unchanged complete runs, and force the full scan before publishing
N divisible by 32. Never publish partial as complete.

- [ ] **Step 2: Implement exact scan bounds and warnings**

Use checked-in inclusive entry/depth constants and current adapter symlink rules.
Count before classification, checkpoint every operation, keep deterministic
prefixes, and route partial warnings/errors exactly as Task 7 specifies.

- [ ] **Step 3: Union/sort before every admission**

Load root-contained known paths, reconcile new paths, canonical-deduplicate the
whole union, apply `compareSourceCandidates`, and only then visit/admit. Pass each
candidate through prepare, then consumer-owned event admission when prepare
returns a commit candidate. Apply existing time/branch/alignment to the returned
admitted prefix. For a non-null candidate, use only the returned opaque proof;
`commitEligible` performs unwindowed repo eligibility from captured evidence/root
and then the final wall/CPU checkpoint. A null-candidate cache hit remains read-
only and uses the same existing admission helper directly. Stopped/partial work
never refreshes a pair.

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

Delegate LanguageService refs/diagnostics for the detector/reconciler, discover
classes/functions, dependency seam, and `AnalyzeOptions`; require zero
diagnostics.

- [ ] **Step 7: Commit production/docs**

```sh
git add src/sources/directory-cursor.ts src/sources/claude/discover.ts src/sources/codex/discover.ts src/core/analyze.ts README.md
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
project-stage retained/warning budgets, mixed/negative eligibility behavior,
branded final commit gate, exact Darwin/APFS detector/generations, directory no-
miss fallback, exact bounds, real/scripted-clock budget claims, Store migrations/
races, privacy disclosure, and no extra scope. Fix all P0–P2 introduced issues in
new commits and re-review.

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
- Item 3: union comparator and three real-clock input-budget equivalences, plus
  output limiter safety/scripted-clock equality — Tasks 5–8.
- Item 4: repo eligibility before commit/root containment — Tasks 5–6, 8.
- Item 5: same no-follow handle/parser receipt/ABA — Tasks 1–2, 5–6.
- Item 6: admission immediately after stat/no over-limit hash — Tasks 5–6.
- Item 7: self-contained API and dependency order — API vocabulary, Tasks 1–8.
- Items 8–9: complete directory cursor, fallback, exact bounds/placement —
  Tasks 3–4, 7–8.
- Item 10: foreign-bound digest/path/adapter/cardinality — Tasks 3–4.
- Item 11: Windows capability and migration/pair races — Tasks 3–7.
- Second review item 1: original byte/warning facts, projector budgets, fixed
  reusable-state cap — Tasks 1–2.
- Item 2: real-clock claim narrowed and scripted output/canonical equality —
  Tasks 5–9.
- Item 3: mixed cold fallback, no-raw negative markers, unseen suffix id — Tasks
  3–6.
- Item 4: source-item claim/checkpoint before open — Tasks 5–6, 8.
- Item 5: every-mode final primary/binding verification and BigInt identity —
  Tasks 5–6.
- Item 6: branded complete commit candidate, exact context/dependencies/ownership
  — API vocabulary, Tasks 5–6.
- Item 7: exact Darwin/APFS detector/evidence and pre-N cursor cycle — Tasks 3–4,
  7–8.
- Item 8: all-events/final-checkpoint commit gate and old-pair preservation —
  Tasks 5–8.
- Third review item 1: prepare-bound meter, consumer-owned exact event admission,
  opaque one-shot proof, and independent commit-side eligibility — API
  vocabulary, Tasks 5–6, 8.
- Every production task follows an observed RED and receives spec review before
  quality review. RED and production commits remain separate; no amend or local
  merge is used.
- Encryption, retention/quota, GC/repair, background infrastructure, Report v3,
  and new rules/CLI surface remain explicitly outside this PR.
