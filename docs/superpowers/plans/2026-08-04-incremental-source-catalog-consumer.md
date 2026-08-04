# Incremental Source Catalog Consumer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse complete normalized Claude/Codex evidence from Store v5 for unchanged sources across CLI processes, and safely parse verified append-only suffixes without changing cold-analysis results.

**Architecture:** Keep the existing exact-key `source_catalog` metadata contract unchanged and add a separately validated `source_evidence_cache` table. A catalog-first consumer probes known paths, reconciles bounded new files, validates revision-bound evidence, and falls back to a cold parse for every uncertain case. Parser range support and conservative adapter merges enable suffix-only work when canonical cold/full equivalence is provable.

**Tech Stack:** TypeScript ESM, Node.js streams/test runner, `better-sqlite3`, SQLite WAL, SHA-256, existing `AnalysisBudgetMeter`.

---

## File map and scope budget

Production files:

- Modify `src/store/sqlite.ts`: Store v5 table, migration, compatibility, and
  existing permission boundary.
- Create `src/store/source-evidence-cache.ts`: exact envelope/cache validation,
  canonical digests, detached reads, and atomic catalog+cache writes.
- Create `src/sources/incremental.ts`: source observation, cache decisions,
  parser invocation, append merge, failure isolation, and runtime dependencies.
- Modify `src/sources/jsonl-budget.ts`: bounded byte-start/global-line reader.
- Modify `src/sources/claude/parser.ts`: parser-version constants and safe suffix
  seed/result support.
- Modify `src/sources/codex/parser.ts`: parser-version constants and safe suffix
  seed/result support.
- Modify `src/sources/claude/discover.ts`: catalog-first known paths and bounded
  unknown-file reconciliation.
- Modify `src/sources/codex/discover.ts`: catalog-first known paths and bounded
  unknown-file reconciliation.
- Modify `src/core/analyze.ts`: Store-path/runtime wiring, lifecycle, and budget
  preserving default-source integration.
- Modify `README.md`: persistent normalized-evidence sensitivity and current
  Store protection boundary.

Test files:

- Modify `test/store.test.ts`: v5 schema/migration/rollback/permissions.
- Create `test/source-evidence-cache.test.ts`: strict cache API and hostile data.
- Create `test/incremental-source-catalog.test.ts`: change matrix, restart reuse,
  append equivalence, discovery, budgets, and failures.

Documentation files are the matching design and this plan. Expected production
change is 850–1,200 lines across ten files; expected test change is 700–1,000
lines across three files. The user explicitly approved this scope. No queue,
cron, outbox, lease, lock service, watcher, cache GC, or unrelated rule/report
change is included.

## Semantic impact inventory

Before this plan was written, the TypeScript LanguageService reported zero
semantic diagnostics and these reference counts:

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

Keep existing call forms source-compatible by adding only optional parameters
or new functions. Re-run LanguageService references and semantic diagnostics
after every shared-signature task.

### Task 1: Define Store v5 and cache API with failing tests

**Files:**

- Modify: `test/store.test.ts`
- Create: `test/source-evidence-cache.test.ts`

- [ ] **Step 1: Add populated v2/v3/v4 and fresh v0 migration assertions**

Assert exact `source_evidence_cache` columns, `user_version = 5`, the
`schema-v5-source-evidence-cache` marker, its foreign key, no unexpected index,
and preservation of every pre-v5 row. The v4 fixture must contain a real
`source_catalog` row so the migration proves no rewrite:

```ts
assert.equal(database.pragma("user_version", { simple: true }), 5);
assert.deepEqual(tableColumns(database, "source_evidence_cache"), [
  ["source_identity", "TEXT", 1],
  ["adapter_id", "TEXT", 1],
  ["content_revision", "TEXT", 1],
  ["parser_version", "TEXT", 1],
  ["schema_fingerprint", "TEXT", 1],
  ["last_parsed_offset", "INTEGER", 1],
  ["line_count", "INTEGER", 1],
  ["ends_with_newline", "INTEGER", 1],
  ["payload_json", "TEXT", 1],
  ["payload_digest", "TEXT", 1],
  ["descriptor_digest", "TEXT", 1],
  ["sensitivity", "TEXT", 1],
  ["retention_class", "TEXT", 1],
  ["updated_at_ms", "INTEGER", 1],
]);
assert.equal(migrationNames(database).includes(
  "schema-v5-source-evidence-cache",
), true);
```

- [ ] **Step 2: Add rollback and idempotence assertions**

Inject a failure after table creation but before marker/version update, then
verify the v4 catalog row, schema version, and marker set are byte-for-byte
unchanged. Open v5 twice and prove the second open adds no marker and mutates no
row. Confirm versions 1, negative, and above 5 fail before mutation.

- [ ] **Step 3: Define the exact evidence-cache contract**

Use one valid Claude envelope and one valid Codex envelope. Assert strict
rejection of null/arrays/exotic prototypes/accessors, unknown/symbol/non-
enumerable fields, invalid event unions, unsafe integers, unknown capabilities,
non-canonical ordering, raw-row fields, malformed digests, wrong sensitivity or
retention labels, and payload/catalog mismatches. Assert errors contain a stable
code but not `SECRET_CANARY`.

```ts
const envelope: SourceEvidenceEnvelopeV1 = {
  schema_version: 1,
  adapter_id: "codex",
  sessions: [codexSession()],
  parse_warnings: [],
};
const entry = makeSourceEvidenceCacheEntry({
  source_identity: SOURCE_ID,
  content_revision: HASH_A,
  parser_version: CODEX_PARSER_VERSION,
  schema_fingerprint: NORMALIZED_EVIDENCE_SCHEMA_FINGERPRINT,
  last_parsed_offset: 128,
  line_count: 3,
  ends_with_newline: true,
  envelope,
  updated_at_ms: 1_000,
});
assert.deepEqual(validateSourceEvidenceCacheEntry(entry), entry);
```

- [ ] **Step 4: Define detached CRUD and atomic pair semantics**

Cover insert/read/re-read cloning, exact replay, replacement, descriptor and
payload digest recomputation, stale/equal-time conflict, corrupt direct SQL,
foreign-key failure, and a trigger that aborts the cache insert after catalog
upsert. After the trigger fires, assert both old catalog and old cache rows
remain exactly unchanged.

- [ ] **Step 5: Delegate RED verification**

Delegate, do not run in the owner context:

```sh
npm run build:test
node --test .test-dist/test/store.test.js .test-dist/test/source-evidence-cache.test.js
```

Expected RED: missing Store v5 schema/module/API assertions fail for only the
new feature. Record exact test totals and failure reasons.

- [ ] **Step 6: Commit RED tests separately**

```sh
git add test/store.test.ts test/source-evidence-cache.test.ts
git commit -m "test(store): define normalized source evidence cache"
```

### Task 2: Implement Store v5 and strict normalized evidence persistence

**Files:**

- Modify: `src/store/sqlite.ts`
- Create: `src/store/source-evidence-cache.ts`

- [ ] **Step 1: Add the additive Store v5 migration**

Set `STORE_SCHEMA_VERSION = 5`, retain explicit constants for versions 2–4,
and apply missing migrations in order inside the current immediate transaction.
Create the evidence table only after `source_catalog` exists. Use the fixed
labels and cross-table foreign key described in the design.

```ts
export const SOURCE_EVIDENCE_CACHE_MIGRATION =
  "schema-v5-source-evidence-cache";

if (version < STORE_SCHEMA_V5) {
  database.exec(SOURCE_EVIDENCE_CACHE_SCHEMA);
  database.prepare(
    "INSERT INTO store_migrations(name, completed_at_ms) VALUES (?, ?)",
  ).run(SOURCE_EVIDENCE_CACHE_MIGRATION, Date.now());
}
database.pragma(`user_version = ${STORE_SCHEMA_VERSION}`);
```

The actual branch conditions must explicitly support 0, 2, 3, 4, and 5 rather
than numerically accepting version 1.

- [ ] **Step 2: Implement one hostile-input-safe evidence normalizer**

Export these contracts from `src/store/source-evidence-cache.ts`:

```ts
export interface SourceEvidenceEnvelopeV1 {
  schema_version: 1;
  adapter_id: SourceAdapterId;
  sessions: Session[];
  parse_warnings: SourceWarning[];
}

export interface SourceEvidenceCacheEntry {
  source_identity: string;
  adapter_id: SourceAdapterId;
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

export function normalizeSourceEvidenceEnvelope(
  value: unknown,
): SourceEvidenceEnvelopeV1;
```

Snapshot property descriptors before reading values. Validate every current
`Session` and `NormalizedEvent` field, the recursive JSON object with explicit
node/depth bounds, warnings, capabilities, optional fields, finite safe integer
rules, and parser ordering. Return newly allocated arrays and objects.

- [ ] **Step 3: Implement canonical digests and detached cache reads**

Use `canonicalJson`, a domain-separated SHA-256 helper, and
`deriveSourceDescriptor` for sorted descriptor snapshots:

```ts
export const NORMALIZED_EVIDENCE_SCHEMA_FINGERPRINT =
  "sha256:1ca662ce526fd999b1d38947375045d8c80977a6d33d07be7d445fda327b74e1";

export function evidencePayloadDigest(
  envelope: SourceEvidenceEnvelopeV1,
): string;

export function evidenceDescriptorDigest(
  sessions: readonly Session[],
): string;

export function getSourceEvidenceCacheEntry(
  database: Database.Database,
  sourceIdentity: unknown,
): SourceEvidenceCacheEntry | undefined;
```

The checked-in fingerprint is the SHA-256 of
`ccprof:normalized-source-evidence:v1\\0schema_version,adapter_id,sessions,parse_warnings`;
it is a literal runtime compatibility marker, not a hash of TypeScript source at
startup.

- [ ] **Step 4: Implement atomic catalog plus cache update**

Expose one transaction boundary:

```ts
export function commitSourceEvidence(
  database: Database.Database,
  catalog: SourceCatalogEntry,
  evidence: SourceEvidenceCacheEntry,
): "inserted" | "updated" | "unchanged" | "stale";
```

Validate and cross-check both inputs before SQL. Inside one immediate
transaction, call the catalog upsert, re-read the authoritative catalog row,
reject a mismatch, then insert/update only the matching cache. A stale catalog
result must not attach new evidence to an older row.

- [ ] **Step 5: Delegate GREEN and semantic verification**

Delegate:

```sh
npm run build:test
node --test .test-dist/test/store.test.js .test-dist/test/source-catalog.test.js .test-dist/test/source-evidence-cache.test.js
```

Also delegate TypeScript LanguageService references for
`STORE_SCHEMA_VERSION`, `openStoreDatabase`, and every new exported cache API;
expected semantic diagnostics are zero.

- [ ] **Step 6: Commit production separately**

```sh
git add src/store/sqlite.ts src/store/source-evidence-cache.ts
git commit -m "feat(store): persist normalized source evidence"
```

### Task 3: Define incremental observation and suffix behavior with RED tests

**Files:**

- Create: `test/incremental-source-catalog.test.ts`

- [ ] **Step 1: Add canonical observation/change-matrix tests**

Create real temporary files and assert stable source identity, full revision,
prefix/suffix hashes, line count, newline flag, null portable identity override,
and deterministic cursor behavior. Mutate each source by exact replay, simple
append, multibyte append, CRLF append, same-size rewrite with restored mtime,
middle rewrite, larger non-append rewrite, truncation, and inode replacement.

```ts
assert.equal(classifySourceChange(previous, exact), "unchanged");
assert.equal(classifySourceChange(previous, append), "append");
assert.equal(classifySourceChange(previous, middleRewrite), "replace");
assert.equal(classifySourceChange(previous, truncated), "replace");
assert.equal(classifySourceChange(previous, rotated), "replace");
```

- [ ] **Step 2: Add cold/cache/restart parser-spy tests**

Run a consumer, close the database, construct a new consumer with a new parser
spy, and process the unchanged file. Assert the second parser count is zero and
the returned sessions are deeply equal but non-aliased. Repeat for empty and
warning-only evidence. Directly corrupt each digest/JSON/label/version and assert
one cold parser call restores evidence.

- [ ] **Step 3: Add append-only equivalence property cases**

For Claude and Codex fixture arrays, first cache the prefix, append suffix bytes,
then compare the warm result with a separate cold full parse:

```ts
assert.equal(
  canonicalJson(normalizeSourceEvidenceEnvelope(warm.envelope)),
  canonicalJson(normalizeSourceEvidenceEnvelope(cold.envelope)),
);
assert.deepEqual(parserRanges, [{ start: prefixBytes, line: prefixLines + 1 }]);
```

Include LF/CRLF, UTF-8, multiple Claude sessions, new Codex response items,
warnings, branch continuity, sidechain parent context, and tool use/result.
Assistant-message revision, duplicate tool id, metadata conflict, first suffix
branch, and non-newline prefix must assert a cold start offset of zero.

- [ ] **Step 4: Add budgets and failure tests**

Prove a cache hit still admits one source item, full current bytes, and every
returned event; max-input byte/event/source limits return the same prefix and
partial reason as a cold run. Parser/budget partial outcomes cannot replace a
complete cache. Store read/write/trigger failure and two consecutive TOCTOU
changes return parser evidence, a content-free warning, and no partial pair.

- [ ] **Step 5: Delegate RED verification and commit**

Delegate:

```sh
npm run build:test
node --test .test-dist/test/incremental-source-catalog.test.js
```

Expected RED is the missing observation/consumer/range API. Commit only tests:

```sh
git add test/incremental-source-catalog.test.ts
git commit -m "test(sources): define persistent incremental consumption"
```

### Task 4: Implement bounded JSONL ranges and conservative adapter merges

**Files:**

- Modify: `src/sources/jsonl-budget.ts`
- Modify: `src/sources/claude/parser.ts`
- Modify: `src/sources/codex/parser.ts`
- Create: `src/sources/incremental.ts`

- [ ] **Step 1: Add byte-start and global-line support without breaking callers**

Add a separate optional read window so current calls remain unchanged:

```ts
export interface JsonlReadWindow {
  start_offset: number;
  starting_line: number;
}

export async function* boundedJsonlLines(
  sourcePath: string,
  tracker: JsonlBudgetTracker,
  window: JsonlReadWindow = { start_offset: 0, starting_line: 1 },
): AsyncGenerator<JsonlLine>;
```

Validate safe integers, create the stream with `start`, and initialize line
number from the window. The caller proves record-boundary alignment; the reader
must not silently discard a partial first line.

- [ ] **Step 2: Add explicit parser compatibility constants and seeds**

Export adapter constants and optional incremental state:

```ts
export const CLAUDE_PARSER_VERSION = "1.0.0";
export const CODEX_PARSER_VERSION = "1.0.0";

export interface ParserReadRange {
  start_offset: number;
  starting_line: number;
}
```

Claude accepts prior normalized sessions only to seed branch/agent context;
Codex accepts the validated prior session to seed session id/cwd/branch when the
suffix has no `session_meta`. Existing zero-offset functions retain identical
results and errors.

- [ ] **Step 3: Implement observation and strict cache decisions**

In `src/sources/incremental.ts`, export:

```ts
export type SourceChangeKind = "unchanged" | "append" | "replace";

export interface IncrementalSourceDependencies {
  openDatabase?: (paths: StorePaths) => Database.Database;
  parseClaude?: typeof parseClaudeTranscriptDetailed;
  parseCodex?: typeof parseCodexSession;
}

export class IncrementalSourceCatalogConsumer {
  constructor(paths: StorePaths, dependencies?: IncrementalSourceDependencies);
  knownPaths(adapter: SourceAdapterId): string[];
  consumeClaude(path: string, context: SourceConsumeContext): Promise<ClaudeTranscriptParseResult>;
  consumeCodex(path: string, context: SourceConsumeContext): Promise<Session | null>;
  close(): void;
}
```

Observation hashes the full bytes, records bounded hashes/line facts, and checks
post-parse stability. Cache matching requires every design invariant and returns
only validator-created detached output.

- [ ] **Step 4: Implement conservative append merge**

Parse only the suffix after full-prefix digest verification. Merge by session
id and deterministic source order, recompute session summary fields, and reject
cross-boundary conflicts. Validate the merged envelope through the same strict
normalizer before commit or return. The runtime must never claim equivalence by
silently sorting away duplicate/conflicting identities.

- [ ] **Step 5: Preserve analysis-budget accounting**

`SourceConsumeContext` carries the existing meter and admitted file-byte count.
Always admit the full current size before cache selection, checkpoint hashing
and merge work, and run the returned sessions through the existing event-prefix
admission. A partial admission invokes the existing bounded cold parser and
does not commit a reusable cache.

- [ ] **Step 6: Delegate GREEN, parser regressions, and LanguageService checks**

Delegate:

```sh
npm run build:test
node --test .test-dist/test/incremental-source-catalog.test.js .test-dist/test/claude-parser.test.js .test-dist/test/codex-parser.test.js .test-dist/test/analysis-budgets.test.js
```

Delegate semantic references/diagnostics for every modified parser/read symbol;
expected diagnostics are zero.

- [ ] **Step 7: Commit production separately**

```sh
git add src/sources/jsonl-budget.ts src/sources/claude/parser.ts src/sources/codex/parser.ts src/sources/incremental.ts
git commit -m "feat(sources): reuse revision-bound normalized evidence"
```

### Task 5: Define catalog-first discovery and analyze integration with RED tests

**Files:**

- Modify: `test/incremental-source-catalog.test.ts`

- [ ] **Step 1: Add known-path versus new-scan assertions**

Populate catalog rows, restart the consumer, and instrument directory reads.
Assert known canonical paths are directly probed in source-identity order and
are not parsed or admitted again by the reconciliation scan. Add one new path
that sorts before known paths and prove the final result remains deterministic.
Hit the hard scan ceiling and an AnalysisBudget checkpoint; assert partial
warning/coverage rather than a complete claim.

- [ ] **Step 2: Add end-to-end default analyze restart equivalence**

Run `analyze()` twice with the same temporary Store and source directories but
fresh runtime dependencies. Assert the second Claude/Codex parser counts are
zero and canonical report, all findings, Store record source digest, source
descriptors, and warnings equal the cold first run. Mutate one source and assert
only its parser runs.

- [ ] **Step 3: Add persist/store failure boundaries**

Assert `persist: false` neither opens nor writes the persistent cache. Make the
cache Store unavailable while source files remain readable; assert analysis
succeeds with fresh evidence and one sanitized optimization warning. Assert
custom injected `SessionSource` behavior and call signatures are unchanged.

- [ ] **Step 4: Delegate RED verification and commit**

Delegate:

```sh
npm run build:test
node --test .test-dist/test/incremental-source-catalog.test.js .test-dist/test/analyze-integration.test.js
```

Commit only the new integration RED:

```sh
git add test/incremental-source-catalog.test.ts
git commit -m "test(core): define catalog-first source integration"
```

### Task 6: Wire catalog-first discovery into the default analyzer

**Files:**

- Modify: `src/sources/claude/discover.ts`
- Modify: `src/sources/codex/discover.ts`
- Modify: `src/core/analyze.ts`

- [ ] **Step 1: Split known-source probing from bounded reconciliation**

Each discoverer accepts an optional consumer while preserving all existing call
forms. Process `consumer.knownPaths(adapter)` first, then run a separately
instrumented recursive scan whose known canonical targets are skipped. Sort all
directory entries with direct code-unit comparison, enforce the checked-in hard
entry ceiling, and retain current symlink escape, mtime/window, repository cwd,
branch, warning, and deduplication behavior.

- [ ] **Step 2: Replace direct parser calls with consumer calls**

Only use the consumer when supplied. Cold/custom paths still call the current
parser directly. A cache warning joins existing global source warnings without
including cache payload or rejected values. Cached parser evidence then follows
the exact existing canonicalization/filter/branch/alignment path.

- [ ] **Step 3: Wire one lifecycle into `analyze()`**

Resolve Store paths before constructing the built-in source, create the
consumer only for the persisted built-in path, and close it in `finally` around
discovery. Pass optional `incrementalSourceDependencies` from `AnalyzeOptions`
as the embedder/testing dependency seam. Injected `SessionSource` and
`persist:false` remain unchanged.

- [ ] **Step 4: Delegate GREEN and impacted regression verification**

Delegate:

```sh
npm run build:test
node --test .test-dist/test/incremental-source-catalog.test.js .test-dist/test/claude-discover.test.js .test-dist/test/codex-discover.test.js .test-dist/test/analyze-integration.test.js .test-dist/test/analysis-budgets-integration.test.js .test-dist/test/determinism-golden.test.js
```

Delegate LanguageService references for discover functions/classes and
`AnalyzeOptions`; expected semantic diagnostics are zero.

- [ ] **Step 5: Commit production separately**

```sh
git add src/sources/claude/discover.ts src/sources/codex/discover.ts src/core/analyze.ts
git commit -m "feat(core): consume the persistent source catalog"
```

### Task 7: Document the persistent sensitive-evidence boundary

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add exact privacy and lifecycle documentation**

Document that ccprof stores normalized evidence needed for cross-process
incremental analysis; this can contain prompt, command, path, edit, and tool
output content. State the existing per-repository local Store location model,
directory/database modes, symlink rejection, and local-only intent. State that
raw JSONL rows are not copied and metadata digests/errors never contain content.

- [ ] **Step 2: State controls not yet provided**

Explicitly say encryption at rest and configurable cache retention/quota are
planned separate controls, so users should treat the local Store as sensitive
raw evidence today. Do not claim operating-system ACL guarantees beyond the
implemented `0700`/`0600` boundary.

- [ ] **Step 3: Add a docs contract assertion and delegate it**

Add the directly relevant assertion to `test/incremental-source-catalog.test.ts`
or `test/docs.test.ts`, then delegate:

```sh
npm run build:test
node --test .test-dist/test/docs.test.js .test-dist/test/incremental-source-catalog.test.js
```

- [ ] **Step 4: Commit documentation**

```sh
git add README.md test/docs.test.ts test/incremental-source-catalog.test.ts
git commit -m "docs: disclose normalized evidence caching"
```

Stage only files actually changed by this task.

### Task 8: Independent review, full verification, and PR lifecycle

**Files:**

- Review every file changed from the exact merge-base with `origin/main`.

- [ ] **Step 1: Run independent specification review**

Provide the audit section, approved design, complete plan, commit list, and diff
to a fresh reviewer. Require a line-by-line verdict for persistent CLI restart,
unchanged parser-zero reuse, strict cache validation, append equivalence,
fallback matrix, discovery split, budget accounting, Store compatibility,
privacy labels, transactional failure, deterministic ordering, and no unrelated
scope. Fix findings in new commits and re-review until approved.

- [ ] **Step 2: Run separate quality/security review**

After specification approval, use a fresh reviewer for hostile data, secret
leakage, digest domain separation, TOCTOU, SQLite transaction/permissions,
resource bounds, clone aliasing, file descriptor lifecycle, cross-platform file
identity, and maintainability. Fix introduced P0–P2 issues in new commits and
re-review until approved.

- [ ] **Step 3: Delegate fresh focused and full verification**

The owner must not execute these commands. Delegate them and retain complete
exit codes/counts:

```sh
npm run build
npm run check
git diff --check origin/main...HEAD
```

Then delegate `/run-github-actions-locally` because logic changed. Any failure
must be reproduced and fixed by a subagent, followed by the full fresh commands.

- [ ] **Step 4: Rebase latest main and repeat required verification**

```sh
git fetch origin main
git rebase origin/main
```

Do not resolve a semantic conflict by choosing a side without review. After a
successful rebase, delegate the focused suite, `npm run check`, and local Actions
again.

- [ ] **Step 5: Push and open a ready PR**

```sh
git push -u origin feature/incremental-source-catalog
gh pr create --base main --head feature/incremental-source-catalog \
  --title "[Sources] feat: consume the incremental source catalog" \
  --body-file /tmp/ccprof-incremental-source-catalog-pr.md
```

The PR body must summarize behavior, privacy boundary, schema migration,
append/cold equivalence evidence, delegated local verification, and known
out-of-scope controls.

- [ ] **Step 6: Complete remote CI/review, merge, and cleanup**

Wait for every remote check and review. Treat all-jobs-under-five-seconds billing
failures according to repository instructions and use delegated local Actions as
the green basis. Fix actionable introduced findings in new commits. Under the
standing user authorization, merge through the PR, never locally. Read and run
`worktree-pr-flow:cleanup` after merge to remove only this worktree and local
feature branch.

## Plan self-review

- Spec coverage maps every approved requirement to Tasks 1–8, including the
  persistent cache correction, restart test, discovery split, budget accounting,
  privacy disclosure, append equivalence property, and crash rollback.
- No task adds background infrastructure, new CLI flags, encryption, retention,
  quota, Report v3, or rule behavior.
- Public/shared signature changes are optional and retain current call forms.
  Type and function names are consistent across Store, consumer, parser,
  discoverer, analyzer, and tests.
- Every unsafe merge state has an explicit cold-parse result and no step defers
  required implementation work.
