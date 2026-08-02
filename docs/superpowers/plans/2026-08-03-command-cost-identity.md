# Command Cost Identity Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and aggregate current command costs by `CommandIdentity` while keeping schema 1 legacy history readable without merging identity-unknown data into known identities.

**Architecture:** Add an optional identity to the existing schema 1 command-cost entry rather than introducing a new store or migration. Current analysis emits costs only for actions with a safe identity and groups them by the canonical identity tuple; store normalization uses separate known and legacy key namespaces, while command text remains a deterministic display field. Legacy records and finding-derived fallback costs may remain identity-less for compatibility, but can never join a known identity during normalization.

**Tech Stack:** TypeScript 5.9, Node.js 20 test runner, immutable JSON schema 1 history

---

## Scope, semantic impact, and hard budget

Exactly five files may change:

- Modify: `src/store/analyses.ts`
- Modify: `src/core/analyze.ts`
- Modify: `test/store.test.ts`
- Modify: `test/analyze-integration.test.ts`
- Add: `docs/superpowers/plans/2026-08-03-command-cost-identity.md`

Added implementation and test code must stay at or below 280 lines, with 300 as an absolute stop threshold. Target allocation: store contract/normalization 90, analyzer aggregation 35, store tests 100, integration tests 55. No package, version, changelog, Report schema, Store v2, SQLite, table, migration, backfill, lock, R006, stats, or R008 change is allowed.

`ts-rename-helper` is unavailable in this environment. TypeScript LanguageService was used as the semantic alternative and found `StoredCommandCost` at 9 references, `AnalysisRecord` at 57, `AnalysisRecord.command_costs` at 12, and private `commandCosts` at 2. The only shared contract change is an optional `StoredCommandCost.command_identity`; `AnalysisRecord.schema_version` remains exactly `1`, and all function signatures remain unchanged.

## Edge cases fixed before implementation

- `packages/api` and `packages/web` running identical normalized text produce two costs.
- Equal CWD and argv under `shell` versus `native-tool` produce two costs.
- argv order, duplicates, quoted empty arguments, and empty non-leading elements survive store cloning exactly.
- An action without a safe identity emits no new command cost; it is never assumed to run at repository root.
- Tool inference actions remain excluded, so copied identity cannot double-count a tool interval.
- Same identity with differing display spellings uses the code-unit-smallest normalized command only for display; grouping never consults display text.
- Overlapping intervals are unioned only within an exact identity; separate identities retain their own duration.
- A legacy schema 1 cost without identity remains readable and byte-shape compatible.
- Known and legacy costs with the same command text use disjoint keys and remain separate even in one `makeAnalysisRecord` call.
- Finding-derived fallback costs retain identity when valid and remain legacy when absent; no identity is inferred from command text.
- Present-but-malformed identity data (absolute/traversing CWD, empty argv, empty executable, non-string argv, or invalid executor) is rejected rather than downgraded to legacy.
- Input permutation produces the same cost order, display command, duration, refs, and generated analysis ID.

### Task 1: Specify schema 1 identity compatibility with RED store tests

**Files:**
- Modify: `test/store.test.ts`

- [x] Import `CommandIdentity` and add explicit fixtures for root/API/Web and shell/native identities, including `normalized_argv: ["npm", "test", "", "", "--flag"]`.
- [x] Add a test named `schema-v1 command costs aggregate by identity while legacy costs stay isolated` that passes these entries to `makeAnalysisRecord`:

```ts
[
  { command: "npm test", command_identity: api, duration_min: 1, session_refs: ["s#1"] },
  { command: "npm test --later-display", command_identity: api, duration_min: 2, session_refs: ["s#2"] },
  { command: "npm test", command_identity: web, duration_min: 3, session_refs: ["s#3"] },
  { command: "npm test", command_identity: nativeApi, duration_min: 4, session_refs: ["s#4"] },
  { command: "npm test", duration_min: 5, session_refs: ["legacy#1"] },
]
```

Assert four entries remain: the two API shell observations merge to three minutes and select `npm test` as display, Web/native/legacy remain isolated, session refs are stable, identities are cloned, and the argv array is unchanged.
- [x] Repeat that input in reverse order and assert identical `command_costs` and `analysis_id`, proving display selection and output order are deterministic.
- [x] Extend the existing legacy schema 1 load test with a non-empty identity-less cost and assert it loads without warnings or an injected identity.
- [x] Add malformed persisted/input identity cases for absolute/traversing CWD, empty argv/argv[0], non-string argv, and invalid executor; expect `makeAnalysisRecord` to throw and `loadAnalyses` to report `corrupt_analysis_record`.
- [x] Add a finding-fallback case proving a valid `evidence.command_identity` is copied, while an absent identity stays legacy rather than being inferred from `evidence.command`.
- [x] Have a validation subagent run the focused store test and capture RED failures caused by missing identity fields and command-text aggregation:

```sh
npm run build:test && node --test --test-name-pattern='command costs|legacy analysis record' .test-dist/test/store.test.js
```

### Task 2: Add optional identity and disjoint normalization lanes

**Files:**
- Modify: `src/store/analyses.ts`
- Test: `test/store.test.ts`

- [x] Import `CommandIdentity` and `commandIdentityKey`, then extend the existing type without changing schema version or signatures:

```ts
export interface StoredCommandCost {
  command: string;
  command_identity?: CommandIdentity;
  duration_min: number;
  session_refs: string[];
}
```

- [x] Add one private runtime normalizer that accepts `.` or an already-normalized repository-relative CWD, a non-empty argv with a non-empty first token, and executor `shell | native-tool`; return a deep copy without sorting/deduplicating argv. Invalid present identity throws.
- [x] In `findingCommandCosts`, copy a valid `evidence.command_identity` when present and preserve the existing identity-less fallback when absent. Never derive identity from `command`.
- [x] Replace command-only normalization keys with disjoint keys:

```ts
const aggregationKey = identity === undefined
  ? `legacy\0${normalizedCommand}`
  : `identity\0${commandIdentityKey(identity)}`;
```

Within a known key, sum durations and refs, retain a deep-copied identity, and select the code-unit-smallest normalized command as display. Within a legacy key, retain the old command normalization behavior. Sort output by aggregation key, not display text.
- [x] Update `isRecord` so absent identity remains valid and present identity must pass the same structural/path constraints. Do not rewrite loaded immutable records or backfill an identity.
- [x] Have the validation subagent rerun the focused store test and confirm GREEN before proceeding.

### Task 3: Generate current costs exclusively from exact identities

**Files:**
- Modify: `src/core/analyze.ts`
- Modify: `test/analyze-integration.test.ts`

- [x] Extend the existing command-cost integration fixture so its Bash tool-use row has explicit CWD, and assert the persisted cost contains `{ repo_relative_cwd: ".", normalized_argv: ["git", "status"], executor: "shell" }`.
- [x] Add an integration case returning API and Web sessions with the same command and separate CWDs; assert two costs and one minute per identity. Add an identity-less command session and assert it creates no cost.
- [x] Verify the existing E2E overlapping `npm test` runs still union to one minute within the single root identity, now also asserting that stored identity.
- [x] Have a validation subagent run the focused integration test and capture RED failures caused by command-only grouping and identity omission:

```sh
npm run build:test && node --test --test-name-pattern='command costs|coordination tools|orchestrates a deterministic PR analysis' .test-dist/test/analyze-integration.test.js
```

- [x] Import `commandIdentityKey` in `src/core/analyze.ts`. In private `commandCosts`, accept only real tool actions with both `normalized_command` and `command_identity`, group intervals and refs by the tuple key, deep-copy identity, choose a deterministic display command, and sort by tuple key before applying `durationMs`.
- [x] Keep inference exclusion and wall-clock union behavior unchanged; do not export `commandCosts` or alter the analyze API.
- [x] Have the validation subagent rerun focused store/integration tests and the full `npm run check`; confirm GREEN.

### Task 4: Review, verify, and deliver through worktree PR flow

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-command-cost-identity.md` (checkboxes only after evidence exists)

- [x] Run independent specification review, followed only after approval by independent code-quality review. Fix and re-review only issues introduced by these five files.
- [x] Have a separate validation subagent run Node 20 `npm ci`, `npm run check`, focused store/integration tests, determinism, build, and package smoke.
- [x] Run the repository's local GitHub Actions equivalent before push because aggregation and persistence logic change.
- [x] Confirm exactly five changed files, at most 280 added implementation+test lines, no schema-version/package/version/changelog change, and no R006/stats/R008/Store-v2 diff.
- [x] Complete the pre-merge gate without amend: commit, push `feature/command-cost-identity`, open a PR against `main`, and wait for all required remote checks plus the absence of actionable review feedback. Merge remains a post-gate action under the user's standing authorization.
- [ ] After merged-commit verification, use guarded worktree cleanup for only `/Users/tanakatakuto/Documents/GitHub/ccprof/.claude/worktrees/command-cost-identity` and its local branch.

## Explicit staged follow-ups

- R006 must aggregate known costs by identity and keep legacy costs from strengthening a known identity.
- Stats must display the human-readable command/CWD while using identity internally.
- R008 history and flaky episodes must migrate independently to the same identity tuple.
- Store v2/SQLite, migrations, backfill, locking, and retention remain separately approval-gated work.
