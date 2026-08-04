# Exact-Revision Source Evidence Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse Store v5 query-independent evidence for an unchanged built-in Claude or Codex source in a fresh process without changing observable analysis behavior.

**Architecture:** A new internal consumer safely observes one discovered file, selects an exact foreign-bound Store pair, projects saved parser state on a hit, and creates an atomic positive or warning-free negative pair after a stable cold parse. Existing discoverers retain full recursive discovery and all post-parse filtering; core wiring enables the consumer only for persisted, unbudgeted, built-in analysis.

**Tech Stack:** TypeScript ESM, Node 22/24 filesystem and crypto APIs, better-sqlite3 Store v5, Node test runner.

---

## Fixed file map and cap

- Create `src/sources/exact-source-evidence-cache.ts`: no-follow exact-revision
  observation, hit projection, cold parser-state read, stability gate, and
  repository-eligible commit.
- Modify `src/store/source-evidence-cache.ts`: central source identity and
  catalog/cache pair producer using existing private digest rules.
- Modify `src/sources/claude/discover.ts`: optional internal per-file consumer.
- Modify `src/sources/codex/discover.ts`: optional internal per-file consumer.
- Modify `src/core/analyze.ts`: eligible default-source construction, early
  Store path reuse, and fixed optimization warnings.
- Modify `README.md`: concise exact-revision cache/privacy/fallback disclosure.
- Create `test/exact-source-evidence-cache.test.ts`: focused safety and cache
  contract matrix.
- Modify `test/analyze-integration.test.ts`: fresh-process observable equality
  and compatibility gates.
- Create the design and this plan under `docs/superpowers/`.

No eleventh file may change. Production TypeScript changed/added lines must be
`<= 300`; measure before each production commit with `git diff --numstat` and
stop if the cap cannot be met.

### Task 1: Commit the approved design and executable plan

**Files:**
- Create: `docs/superpowers/specs/2026-08-05-exact-source-evidence-cache-design.md`
- Create: `docs/superpowers/plans/2026-08-05-exact-source-evidence-cache.md`

- [ ] **Step 1: Self-review the spec**

Search both documents for `TBD|TODO|implement later`, contradictory budget or
eligibility language, files outside the ten-file map, and any append/discovery-
root work. Expected: no placeholders; exact-only scope.

- [ ] **Step 2: Commit the documents**

```sh
git add docs/superpowers/specs/2026-08-05-exact-source-evidence-cache-design.md \
  docs/superpowers/plans/2026-08-05-exact-source-evidence-cache.md
git commit -m "docs: design exact source evidence cache"
```

Expected: one documentation commit and a clean worktree.

### Task 2: Establish RED consumer and integration contracts

**Files:**
- Create: `test/exact-source-evidence-cache.test.ts`
- Modify: `test/analyze-integration.test.ts`

- [ ] **Step 1: Write focused failing tests**

Use temp source roots and Store paths to exercise the wished-for
`ExactSourceEvidenceCache` API. Cover exact cold/warm reuse and parser call
counts, changed `endedAtMs`, content replacement with identical metadata,
parser/schema/root/corrupt misses, warning-free negatives, mixed/warning-bearing
non-commit, LF/no-LF/empty/Claude multi-session/Codex cardinality, Store
failure, and pre/post/path-binding mutation. Assert unstable observations leave
both Store tables unchanged.

- [ ] **Step 2: Write failing analyzer integration tests**

Create real built-in Claude/Codex directories and injected Store paths. Run
`analyze()` cold, close all state, run it again, and compare canonical sessions
through Report v2 sources/warnings/output/snapshot digest while observing parser
calls through the focused consumer seam. Add explicit cases proving budgets,
`persist: false`, and a custom source never enable cache consumption, and linked
worktree eligibility identities do not cross-hit.

- [ ] **Step 3: Delegate RED verification**

```sh
npm run build:test
node --test .test-dist/test/exact-source-evidence-cache.test.js \
  .test-dist/test/analyze-integration.test.js
```

Expected: compilation or assertions fail only because the consumer/factory and
wiring do not exist. Fix test mistakes until the failure reason is the missing
feature; do not add production code.

- [ ] **Step 4: Commit RED tests**

```sh
git add test/exact-source-evidence-cache.test.ts test/analyze-integration.test.ts
git commit -m "test: define exact source evidence reuse"
```

### Task 3: Add the Store producer factory

**Files:**
- Modify: `src/store/source-evidence-cache.ts`
- Test: `test/exact-source-evidence-cache.test.ts`

- [ ] **Step 1: Implement source identity and pair production**

Add one exported factory that accepts validated adapter/path, active Store and
eligibility identities, stable file facts/digests, normalized continuation,
unwindowed sessions/warnings or a negative reason, and observation time. It must
derive `source-<sha256>` from adapter plus canonical path, canonicalize the
envelope, populate the complete catalog row, and compute payload/descriptor
digests exclusively through the Store module's existing private helpers.

- [ ] **Step 2: Keep validation authoritative**

Return the pair through `validateSourceCatalogEntry` and
`validateSourceEvidenceCacheEntry`; do not relax cache validation or duplicate
digest code in the consumer/tests. Parser version is selected from the adapter
and schema fingerprint remains `PARSER_STATE_SCHEMA_FINGERPRINT`.

### Task 4: Implement exact one-handle consumption

**Files:**
- Create: `src/sources/exact-source-evidence-cache.ts`
- Modify: `src/store/source-evidence-cache.ts`
- Test: `test/exact-source-evidence-cache.test.ts`

- [ ] **Step 1: Implement the safe observation boundary**

Canonicalize and contain root/path, open once with read-only plus no-follow,
require a regular file, capture pre-stat, and calculate full/prefix/suffix
SHA-256 by positional reads. Keep the handle in `try/finally`. A final same-
handle stat/digest plus pathname `lstat` must match type, identity, size, and
mtime before a candidate can commit.

- [ ] **Step 2: Implement exact hit and miss**

Open the active Store only inside the consumer operation. On a valid pair whose
content revision matches, normalize its envelope and call only the existing
projector with the requested `endedAtMs`; return a negative as no evidence.
Otherwise call only the existing parser-state reader on the same handle and use
the same projector for unwindowed and requested-window results.

- [ ] **Step 3: Implement eligibility and commit**

Use `cwdMatchesRepository` on every unwindowed raw session. All eligible becomes
a positive; exactly empty/warning-free and all-other/warning-free become their
negative reasons; mixed or warning-bearing empty produces no pair. Commit only
after the stability gate. Catch cache-only failures, retain projected evidence,
and invoke the fixed content-free warning callback once.

### Task 5: Wire only the built-in unbudgeted persisted path

**Files:**
- Modify: `src/sources/claude/discover.ts`
- Modify: `src/sources/codex/discover.ts`
- Modify: `src/core/analyze.ts`
- Test: `test/analyze-integration.test.ts`

- [ ] **Step 1: Add optional internal discoverer dependencies**

Claude consumes the consumer's `{ sessions, warnings }` parse result; Codex
consumes its `Session | null` result. Preserve all recursive discovery,
candidate order, pruning, error, canonicalization, time/repository/branch
filtering, alignment, dedupe, capabilities, and global warning code unchanged.

- [ ] **Step 2: Add analyzer gating**

After PR context, create the consumer only when source is default, `persist` is
true, and `budgetMeter` is absent. Resolve Store paths once for that consumer
and reuse the value later for history/hooks/saves. Keep custom, non-persistent,
and budgeted construction byte-for-byte on the old path. Collect cache warnings
separately from source errors so they neither record source failure nor suppress
branch-transition inference.

- [ ] **Step 3: Document the behavior**

Add one focused README paragraph explaining exact-content matching,
fresh-process reprojection, built-in/persisted/unbudgeted gating, sensitive raw
evidence, full-scan discovery, and safe cold fallback. Do not refactor unrelated
README content.

### Task 6: GREEN verification, reviews, and PR lifecycle

**Files:** all ten fixed files only.

- [ ] **Step 1: Delegate focused GREEN**

```sh
npm run build:test
node --test .test-dist/test/exact-source-evidence-cache.test.js \
  .test-dist/test/analyze-integration.test.js
```

Expected: all focused tests pass with no warnings/errors.

- [ ] **Step 2: Measure scope before commit**

```sh
git diff --name-only origin/main
git diff --numstat origin/main -- 'src/**/*.ts'
```

Expected: exactly the approved files, no more than ten total, and no more than
300 added/changed production TypeScript lines. Stop rather than add a file or
cross the production cap.

- [ ] **Step 3: Commit GREEN in new commits**

```sh
git add src/sources/exact-source-evidence-cache.ts \
  src/store/source-evidence-cache.ts src/sources/claude/discover.ts \
  src/sources/codex/discover.ts src/core/analyze.ts README.md \
  test/exact-source-evidence-cache.test.ts test/analyze-integration.test.ts
git commit -m "feat: reuse exact source evidence"
```

Never amend the RED or documentation commits.

- [ ] **Step 4: Run two-stage review**

First dispatch an independent specification reviewer against the approved
design and acceptance matrix. Fix only gaps caused by this change and re-review
until approved. Then dispatch an independent quality/security reviewer for
filesystem races, cache binding, privacy, descriptor/report compatibility, and
the file/line cap; fix and re-review until approved.

- [ ] **Step 5: Delegate full/local CI verification**

Run `npm run check` in a test/static-analysis subagent, then execute the local
GitHub Actions workflow via `/run-github-actions-locally` as required before a
logic-changing push. If Report v3 has landed, fetch/rebase latest `origin/main`
first and repeat all checks.

- [ ] **Step 6: PR, remote CI, merge, and cleanup**

Push `feature/exact-source-evidence-cache`, create a non-draft PR to `main`,
monitor every remote check and review, fix with new commits, and merge with a
merge commit after green approval. Then remove
`.worktrees/exact-source-evidence-cache`, delete the merged local feature
branch, update local `main` from `origin/main`, and report PR URL, CI/review,
merge SHA, cleanup, file count, and production line count.
