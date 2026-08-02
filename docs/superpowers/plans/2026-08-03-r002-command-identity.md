# R002 Command Identity Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make R002 aggregate redundant runs only when their repository-relative CWD, normalized argv, and executor identity are exactly equal.

**Architecture:** Keep matcher-produced `CommandIdentity` as the sole grouping key. Use normalized command text only for deterministic display, evidence, and verification; encode the identity tuple into the finding key so legacy command-only dismissals do not migrate. Preserve argv arrays during evidence canonicalization without changing any exported signature or shared model type.

**Tech Stack:** TypeScript 5.9, Node.js 20 test runner, SHA-256 finding keys

---

## Scope, budget, and semantic impact

Exactly four files may change:

- Modify: `src/rules/redundant-runs.ts`
- Modify: `src/rules/shared.ts`
- Modify: `test/rules-primary.test.ts`
- Add: `docs/superpowers/plans/2026-08-03-r002-command-identity.md`

Added source and test code must stay at or below 260 lines. No package, version, changelog, report/store schema, or legacy dismissal migration changes are allowed.

TypeScript LanguageService 5.9 confirmed the relevant semantic surface: `detectRedundantRuns` has 5 references, `createFindingCandidate` 20, `findingKey` 18, `commandIdentityKey` 9, and `MatchedAction.command_identity` 13. Therefore all exported signatures and shared types remain unchanged; only private canonicalization behavior and R002 internals change.

Required edge behavior:

- Missing/unsafe identity produces no R002 finding and cannot join another run.
- Same argv in different CWDs, and shell versus native-tool execution, form different groups and finding keys.
- `allRuns`, counts, session refs, confidence, paths, and recoverable intervals contain only the exact identity; inference actions are excluded even if they carry copied identity.
- Input permutation cannot change normalized-command selection, finding order, keys, or evidence.
- Native display targets end in ` [native-tool]`; shell targets do not. Both include repository-relative CWD.
- Evidence preserves `normalized_argv` order, duplicates, and empty strings exactly.
- The finding key is `findingKey("R002", "command-identity:" + hex(commandIdentityKey(identity)))`; old command-only dismissal keys intentionally do not match.
- Suggestions explicitly name the repository-relative CWD; `verify` remains the stable normalized command.

### Task 1: Specify identity-safe R002 behavior with RED tests

**Files:**
- Modify: `test/rules-primary.test.ts`

- [x] Add a small `CommandIdentity` fixture helper and update the existing R002 fixture so contributing and redundant tool actions share an explicit shell identity.
- [x] Assert the finding target is `packages/api :: npm test`, evidence includes the full `command_identity`, the suggestion names `packages/api`, and `verify` remains `npm test`.
- [x] Assert the key formula exactly:

```ts
findingKey(
  "R002",
  `command-identity:${Buffer.from(commandIdentityKey(identity), "utf8").toString("hex")}`,
)
```

- [x] Add focused cases proving different CWDs and executors do not merge, identity-less tool actions yield no finding, native targets use ` [native-tool]`, inference is excluded, and permutations produce identical findings.
- [x] Include `normalized_argv: ["npm", "test", "", "", "--flag"]` in evidence and assert the order, duplicate empty elements, and values survive canonicalization.
- [x] Have a validation subagent run the focused test and record the expected RED failures caused by command-only grouping, legacy keying, and argv sorting/deduplication:

```sh
npm run build:test && node --test --test-name-pattern='R002' .test-dist/test/rules-primary.test.js
```

### Task 2: Implement the minimal identity migration

**Files:**
- Modify: `src/rules/redundant-runs.ts`
- Modify: `src/rules/shared.ts`
- Test: `test/rules-primary.test.ts`

- [x] Filter ordered actions to real tool actions with both a non-empty normalized command and `command_identity`; group and sort by `commandIdentityKey`, and derive `allRuns` from that same tuple key.
- [x] Choose the display command deterministically from the ordered exact-identity runs. Build the target with `formatCommandIdentityTarget`, appending ` [native-tool]` only for that executor, and pass this target to `recoverableClaim` and the finding.
- [x] Add a private R002 key helper implementing the hex formula from Task 1, then override only the returned candidate's `finding_key`. Do not add a migration or alter `findingKey`/`createFindingCandidate` signatures.
- [x] Add a copied `command_identity` object to evidence, including a copied `normalized_argv` array; keep normalized command text in `evidence.command` and `fix_recipe.verify` only.
- [x] Make `recipeFor` accept the identity and explicitly mention its repository-relative CWD while retaining the existing ecosystem-specific affected-test suggestion.
- [x] Change only the private JSON canonicalizer in `src/rules/shared.ts` to carry the current property name: string arrays named `normalized_argv` are mapped in place, while existing sorted/deduplicated behavior remains for every other evidence string array.
- [x] Have the validation subagent rerun the focused command and confirm GREEN, then run the complete check suite; fix production code rather than weakening tests.

### Task 3: Review, verify, and deliver through the worktree PR flow

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-r002-command-identity.md` (checkboxes only after evidence exists)

- [x] Run independent specification review, then independent code-quality review; resolve and re-review only findings introduced by this change.
- [x] Have a separate validation subagent run Node 20 `npm ci`, `npm run check`, focused R002 tests, determinism, build, and package smoke.
- [x] Run the repository's local GitHub Actions equivalent before push because rule logic changes.
- [ ] Confirm exactly four changed files, added source+test lines are at most 260, no exported signature/type or version/package/changelog change exists, and the worktree is clean after commit.
- [ ] Commit without amend, push `feature/r002-command-identity`, open a PR against `main`, wait for every required remote check/review, then merge only under the user's standing authorization.
- [ ] After merge verification, clean up only `/Users/tanakatakuto/Documents/GitHub/ccprof/.claude/worktrees/r002-command-identity` and its local branch using the guarded worktree cleanup flow.
