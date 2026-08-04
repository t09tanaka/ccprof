# Built-in Source Coverage Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an internal, truthful run-local coverage contract and exact cold-path collection for the built-in Claude and Codex adapters without changing Report v2, `SourceDescriptor`, `AnalyzeResult`, or CLI output.

**Architecture:** A small source-coverage module owns the immutable available/unavailable union, counter validation, aggregation, and the adapter/parser schema fingerprint. Each parser gains a new observed entry point that returns its existing parse result together with physical rows seen, accepted parser-state rows, emitted normalized events, and completeness; existing parse functions delegate and preserve their return values. Each discovery adapter gains a cold-only observed entry point that aggregates unique eligible source candidates and successful parses while the existing discovery API remains unchanged. Warm exact-cache parity and the `AnalyzeResult` sidecar are deliberately deferred to a follow-up PR so no incomplete public behavior is exposed.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, `node:test`, SHA-256 from `node:crypto`.

---

## Scope and edge cases

- `files_discovered` counts unique canonical parser candidates, not directory entries, symlink aliases, unrelated files, or candidates excluded by the adapter's safe time-window prefilter.
- `files_parsed` increments only when a parser returns normally; a valid file with zero emitted events still counts as parsed.
- `rows_seen` is the number of physical JSONL rows scanned by the cold parser. `rows_accepted` is the number retained in the validated parser state. Malformed, oversized, or otherwise rejected rows are never reported as accepted.
- `events_emitted` counts normalized parser events before repository, branch, and analysis-window filtering; downstream filtering cannot be mistaken for parser loss.
- Any unreadable directory/file, rejected symlink, parser warning with no usable session, or parser/read budget truncation makes completeness `partial`. Complete is allowed only when discovery and all successful reads were exhaustive.
- Missing source roots retain current adapter semantics: Claude throws its typed discovery error; Codex returns no sessions. The observation API must not invent zero-valued available coverage for an operation that could not observe its root.
- Counter addition is safe-integer checked. Invalid, negative, fractional, or overflowing values fail closed.
- The schema fingerprint is deterministic and domain-separated over adapter id/version, parser version, and parser-state schema fingerprint; it never incorporates paths, timestamps, session ids, or content.
- Custom `SessionSource` implementations map to `{ status: "unavailable" }`; the collector accepts only the two built-in adapter ids and never manufactures zeros for custom sources.
- Existing functions, wire schemas, renderer output, storage rows, and custom-source validation remain byte/behavior compatible.
- Exact-cache warm hits are not observed by this phase. The follow-up must derive identical facts from cached parser state or treat old cache entries as a cold miss; it must not reuse the cold API and claim false parity.

## File map and hard budget

- Create `src/sources/source-coverage.ts`: internal immutable contract, unavailable value, safe aggregation, fingerprint helper.
- Modify `src/sources/claude/parser.ts`: observed cold parse entry point; existing API delegates.
- Modify `src/sources/codex/parser.ts`: observed cold parse entry point; existing API delegates.
- Modify `src/sources/claude/discover.ts`: observed cold discovery entry point and aggregation.
- Modify `src/sources/codex/discover.ts`: observed cold discovery entry point and aggregation.
- Create `test/source-coverage-observation.test.ts`: contract, parser, and discovery behavior.
- Create this plan file.

Maximum: 7 changed files and 300 changed production TypeScript lines. No existing shared function signature or interface is changed, so semantic rename/reference migration is not required; the new entry points are additive.

### Task 1: Define the fail-closed coverage contract

**Files:**
- Create: `src/sources/source-coverage.ts`
- Test: `test/source-coverage-observation.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests that import `createBuiltInSourceCoverageAccumulator`, assert a Claude accumulator starts with safe zero counters and a deterministic `sha256:<64 lowercase hex>` fingerprint, merges exact observations, changes to `partial` monotonically, rejects invalid/overflowing counters, and assert `unavailableSourceCoverage()` returns the frozen exact value `{ status: "unavailable" }`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --test-name-pattern='source coverage contract'`

Expected: FAIL because `src/sources/source-coverage.ts` does not exist.

- [ ] **Step 3: Implement the minimal contract**

Define the union and accumulator around this shape:

```ts
export interface AvailableBuiltInSourceCoverage {
  status: "available";
  adapter_id: "claude" | "codex";
  adapter_version: "1.0.0";
  parser_version: string;
  schema_fingerprint: `sha256:${string}`;
  files_discovered: number;
  files_parsed: number;
  rows_seen: number;
  rows_accepted: number;
  events_emitted: number;
  completeness: "complete" | "partial";
}

export type BuiltInSourceCoverage =
  | AvailableBuiltInSourceCoverage
  | { status: "unavailable" };
```

The accumulator accepts per-file facts, validates all counters as nonnegative safe integers, adds without overflow, makes `partial` monotonic, and returns a newly frozen snapshot. The fingerprint hashes canonical JSON under domain `source-coverage-schema-v1` containing only adapter id/version, parser version, and parser-state fingerprint.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --test-name-pattern='source coverage contract'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/source-coverage.ts test/source-coverage-observation.test.ts docs/superpowers/plans/2026-08-05-source-coverage-observation.md
git commit -m "feat: define built-in source coverage contract"
```

### Task 2: Observe exact cold parser facts

**Files:**
- Modify: `src/sources/claude/parser.ts`
- Modify: `src/sources/codex/parser.ts`
- Modify: `test/source-coverage-observation.test.ts`

- [ ] **Step 1: Write failing parser observation tests**

Create Claude and Codex JSONL fixtures in temporary files containing one malformed/auxiliary row and rows that emit events. Assert the new observed functions preserve the exact legacy parse result and return `rows_seen` equal to physical rows, `rows_accepted` equal to retained parser rows, `events_emitted` equal to the sum of returned session event lengths, and `complete` on an exhaustive cold read. Add a bounded-file read assertion that reports `partial` and never inflates accepted rows.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --test-name-pattern='cold parser coverage'`

Expected: FAIL because the observed parser entry points are absent.

- [ ] **Step 3: Implement observed parser entry points**

Add `parseClaudeTranscriptObserved()` and `parseCodexSessionObserved()` as additive exports. Each opens the file once, uses the existing incremental state reader and projector, derives exact counters from `state.line_count`, `state.rows.length`, projected event lengths, and reader completeness, and returns `{ result, observation }`. Preserve the existing capacity-fallback parser and derive its counters from its existing rows/tracker without a second file read. Make the legacy `parseClaudeTranscriptDetailed()` and `parseCodexSession()` delegate and return only `.result`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern='cold parser coverage'`

Expected: PASS and the legacy-equivalence assertions remain equal.

- [ ] **Step 5: Commit**

```bash
git add src/sources/claude/parser.ts src/sources/codex/parser.ts test/source-coverage-observation.test.ts
git commit -m "feat: observe cold parser coverage"
```

### Task 3: Aggregate built-in cold discovery coverage

**Files:**
- Modify: `src/sources/claude/discover.ts`
- Modify: `src/sources/codex/discover.ts`
- Modify: `test/source-coverage-observation.test.ts`

- [ ] **Step 1: Write failing discovery observation tests**

Exercise `discoverClaudeSessionsObserved()` and `discoverCodexSessionsObserved()` against temporary built-in source roots. Assert unrelated files and prefiltered historical files do not count, a valid zero-event transcript increments discovered/parsed/rows but not events, malformed or unreadable candidates make completeness partial, unique canonical Claude candidates are not double counted, and the returned sessions exactly equal the existing cold discovery API.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --test-name-pattern='cold discovery coverage'`

Expected: FAIL because the observed discovery entry points are absent.

- [ ] **Step 3: Implement cold discovery aggregation**

Factor each adapter's cold path into an internal implementation accepting its accumulator. Add an observed export that always runs without `ExactSourceEvidenceCache`, records candidates only after adapter prefilters and Claude canonical deduplication, records successful parser observations, and marks partial on discovery/read/parse failures. Keep `discoverClaudeSessions()` and `discoverCodexSessions()` signatures and evidence-cache behavior unchanged.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern='cold discovery coverage'`

Expected: PASS.

- [ ] **Step 5: Run delegated verification and enforce scope**

Run through a test subagent: focused tests, `npm run check`, `npm run build`, `git diff --check`, and changed-file/production-line counts against `origin/main`.

Expected: all green; at most 7 files and at most 300 changed production TypeScript lines.

- [ ] **Step 6: Commit**

```bash
git add src/sources/claude/discover.ts src/sources/codex/discover.ts test/source-coverage-observation.test.ts
git commit -m "feat: collect cold source coverage"
```

### Task 4: Review, local Actions, and PR completion

**Files:**
- Review all seven files above; do not add scope.

- [ ] **Step 1: Run two-stage reviews**

Dispatch a spec-compliance reviewer, resolve any gap with a new test-first commit, then dispatch a code-quality/security reviewer and resolve only P0-P2 issues caused by this change.

- [ ] **Step 2: Run GitHub Actions locally**

Use `/run-github-actions-locally`: one Sonnet worker enumerates matching workflow units, then Sonnet workers execute those units according to dependency and collision grouping.

- [ ] **Step 3: Rebase, push, and create the PR**

Fetch `origin/main`, rebase if it advanced, rerun delegated verification if the tree changed, push `feature/source-coverage-observation`, and create a PR to `main` with the additive contract impact, exact tests, `Tests: added`, and `Rollback: revert-safe`.

- [ ] **Step 4: Complete remote CI and review**

Run `ccprof --pr --json` and apply only `scope: this_pr` findings. Monitor every remote check and run an independent whole-PR review in parallel. Fix code failures or P0-P2 findings test-first in new commits, repeating up to three cycles.

- [ ] **Step 5: Merge and clean up**

Because the repository owner pre-approved merges, merge with a merge commit after all checks and review are green. Confirm the merge commit, remove `.worktrees/source-coverage-observation`, delete only the local `feature/source-coverage-observation` branch, fast-forward local `main`, and report the PR number, URL, merge commit, verification, and deferred warm/sidecar boundary.
