# R008 Command Identity Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Form R008 flaky-test episodes and historical recurrence evidence only from exact CWD/argv/executor identities.

**Architecture:** Carry the already-propagated `CommandIdentity` into private run signals, group current failure-to-success episodes and stored R008 history by `commandIdentityKey`, and ignore identity-less or malformed inputs instead of inferring repository root. Keep normalized command text for JSON compatibility and verification, while deriving human-readable targets, evidence, historical lookup, and stable finding keys from the retained identity.

**Tech Stack:** TypeScript 5.9, Node.js 20 test runner, existing schema 1 JSON history

---

## Scope, semantic impact, and budget

Exactly three files may change:

- Modify: `src/rules/flaky-test.ts`
- Modify: `test/rules-secondary.test.ts`
- Add: `docs/superpowers/plans/2026-08-03-r008-command-identity.md`

Added implementation and test code must stay at or below 285 lines, with 300 as a hard stop. Do not modify core/shared types, `src/core/analyze.ts`, edit-relevance wiring, store/schema, R002/R006, result-status classification, reporters, dismissals/adoptions, package metadata, version, or changelog.

`ts-rename-helper` is unavailable. TypeScript LanguageService semantic references were checked instead: `detectFlakyTests` has 33 semantic entries across 3 files, `flakyEditRelevanceKey` 9 across 3 files, `CommandIdentity` 46 across 11 files, and `MatchedAction.command_identity` 27 across 6 files. Keep every exported type and function signature unchanged. `Finding.evidence` already accepts the structured identity, so no schema or public model change is required.

## Edge cases fixed before implementation

- API failure and Web success with identical `npm test` text never form an episode; a later API success may resolve only the API failure.
- Shell and native-tool execution with identical CWD/argv remain separate; native display ends in ` [native-tool]`.
- Current runs without a safe identity never seed failures or successes and cannot be joined to a known lane.
- Legacy identity-less and malformed historical findings remain readable but never strengthen a known identity's recurrence evidence.
- Historical findings from another CWD, argv, or executor cannot add PRs, duration, or session refs to the current finding.
- Exact identity history may match even when its display command text differs.
- Duplicate records for one PR retain the existing maximum-duration and session-ref-union semantics; different PR durations remain additive.
- argv order, duplicate elements, and empty non-leading elements participate in the identity and survive deep copying.
- Mutating an input identity after detection cannot mutate emitted evidence.
- Identity-key and PR ordering use explicit code-unit order, so reversing action/history input yields byte-equivalent findings.
- Inference actions remain excluded as run signals even when they carry a copied identity.
- Existing mutation-risk, edit-relevance, interval ownership, failed-test extraction, confidence, and current-PR recoverable-time semantics remain unchanged.
- `flakyEditRelevanceKey` intentionally stays command-scoped because it caches test-map relevance rather than episodes or history; CWD-aware workspace mapping is a later task.
- Old command-only dismissal/adoption/recurrence keys intentionally do not match new identity-derived R008 keys; no migration or alias is added.
- Text-only/unknown result handling belongs to the next ResultStatusEvidence task and is not changed here.

### Task 1: Specify identity-safe R008 behavior with RED tests

**Files:**
- Modify: `test/rules-secondary.test.ts`

- [x] Add a `CommandIdentity` fixture factory that copies argv and supports repository-relative CWD plus shell/native execution. Derive the default root fixture identity with the production command tokenizer/builder, while allowing an explicit `command_identity: undefined` legacy path.
- [x] Update the shared `matchedAction` fixture to attach a safe root identity only to eligible normalized command actions unless the test explicitly supplies or suppresses one. Opaque commands must remain identity-less, matching production.
- [x] Update `storedFlakyFinding` to emit copied identity evidence by default and permit explicit legacy/malformed/mismatched history fixtures.
- [x] Update the primary R008 assertion to require a nested-CWD target, copied identity evidence, CWD-aware recipe, unchanged normalized `command`/`verify`, and the exact key formula:

```ts
findingKey(
  "R008",
  `command-identity:${Buffer.from(commandIdentityKey(identity), "utf8").toString("hex")}`,
)
```

- [x] Add a focused current-run lane test covering API, Web, native API, and identity-less runs with the same display command. Prove only exact failure/success identities connect, each emitted lane has isolated refs/counts/key/target, and argv duplicates/empty elements are copied.
- [x] Reverse the current action and result arrays and assert byte-equivalent findings and identity-key ordering.
- [x] Add a focused history test containing exact API history, another CWD, native execution, legacy, malformed identity, duplicate records for one PR, and a distinct PR. Assert only exact identity contributes, one-PR duration uses max, cross-PR duration sums, refs are isolated, and reversing history is byte-equivalent.
- [x] Mutate source argv after detection and prove the emitted evidence is unchanged; separately prove legacy-only current runs and history cannot create or enrich a finding.
- [x] Have a validation subagent run focused R008 tests and record RED failures caused by command-only current/history grouping, command-only targets/keys, and missing identity evidence:

```sh
npm run build:test && node --test --test-name-pattern='R008' .test-dist/test/rules-secondary.test.js
```

### Task 2: Group current episodes and history by exact identity

**Files:**
- Modify: `src/rules/flaky-test.ts`
- Test: `test/rules-secondary.test.ts`

- [x] Import `commandIdentityKey`, `formatCommandIdentityTarget`, `CommandIdentity`, and `findingKey` without changing any exported signature.
- [x] Add a private defensive reader that returns a deep-copied identity only for a safe repository-relative CWD, non-empty argv with a non-empty executable, string arguments, and a valid executor. Missing/malformed identities return `undefined`; repository root is never inferred.
- [x] Extend private `RunSignal`/episode data with copied identity. Skip identity-less current actions, and group run signals and completed episodes by `commandIdentityKey` instead of normalized command text.
- [x] Keep result pairing by the exact action run key, then permit failure-to-success resolution only inside one identity group. Preserve all existing temporal and mutation guards.
- [x] Replace command-keyed historical aggregation with identity-keyed aggregation. Require valid `evidence.command_identity`, isolate CWD/argv/executor lanes, preserve same-PR max duration plus ref union, and sort tuple keys/PRs by explicit code-unit order.
- [x] Select the code-unit-smallest valid normalized command observed for an identity as display/verify text, independent of caller order.
- [x] Build the target with `formatCommandIdentityTarget(identity, command)`, append the native suffix only for native execution, and pass that target to `recoverableClaim`.
- [x] Add a deep-copied `command_identity` to evidence while retaining the existing normalized `command`. Lookup historical recurrence only by the exact identity key.
- [x] Make the suggestion name the repository-relative CWD, retain `verify: command`, and describe historical recurrence as the same command identity.
- [x] Override the generated finding key with the exact identity formula from Task 1. Do not migrate or alias the old command-only key.
- [x] Return findings in explicit identity-key order and deep-copy argv in every emitted object.
- [x] Have the validation subagent rerun focused R008 tests and confirm GREEN.

### Task 3: Review, verify, and deliver through worktree PR flow

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-r008-command-identity.md` (checkboxes only after evidence exists)

- [x] Run independent specification review, then independent code-quality review. Resolve and re-review only issues introduced by these three files.
- [x] Have a separate validation subagent run Node 20 `npm ci`, `npm run check`, focused R008 tests, determinism, build, and package smoke.
- [x] Run the repository's local GitHub Actions equivalent before push because rule logic changes.
- [x] Confirm exactly three changed files, at most 285 added implementation+test lines, no core/store/schema/R002/R006/result-status/reporter/dismissal/package/version/changelog diff, and no absolute CWD in output.
- [ ] Commit without amend, rebase onto current `origin/main`, push `feature/r008-command-identity`, open a PR against `main`, and wait for all required checks plus absence of actionable feedback. Merge only under the user's standing authorization.
- [ ] After merged-commit verification, use guarded cleanup only for `/Users/tanakatakuto/Documents/GitHub/ccprof/.claude/worktrees/r008-command-identity` and its local branch.
