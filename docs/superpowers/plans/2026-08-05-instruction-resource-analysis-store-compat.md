# Instruction Resource Analysis Store Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return canonical `instruction_resource` analysis findings without changing Store v1 IDs or snapshot bytes.

**Architecture:** The model accepts canonical and exact legacy scope inputs at the migration boundary. The Store normalizes runtime records, projects scopes only for legacy snapshot construction, and authenticates raw legacy snapshots before validation and normalization.

**Tech Stack:** TypeScript 5.9, Node.js built-in tests, better-sqlite3, strict ESM.

---

### Task 1: Add Store compatibility RED tests

**Files:**

- Modify: `test/store.test.ts`

- [ ] **Step 1: Specify identifier and byte equality**

Add equivalent `claude_md` and `instruction_resource` finding inputs. Assert
generated `analysis_id`, `analysisAuditIdentity().snapshot_id`, and
`deterministic_digest` are equal. Save the canonical record, then assert the raw
SQLite envelope is `canonicalJson()` of the equivalent `claude_md` payload, while
the saved and loaded records contain `instruction_resource`.

- [ ] **Step 2: Specify migration and raw-reader ordering**

Manually insert a correctly digested raw legacy envelope; a legacy raw envelope
with its digest computed from a canonicalized copy; a correctly digested raw
canonical-token envelope; and unknown/case/whitespace/NUL raw tokens. Assert only
the valid legacy row loads canonically and every other row is a
`corrupt_analysis_record`. Create a legacy JSON file, assert its bytes stay
unchanged after migration, and assert its SQLite snapshot remains legacy.

- [ ] **Step 3: Specify strict runtime input behavior**

Add accessor and proxy scope inputs. Assert fixed `TypeError("invalid finding")`,
no canary disclosure, and no getter invocation. Assert canonicalization does not
mutate legacy input objects and `this_pr`/`separate_issue` retain exact runtime
and raw tokens.

- [ ] **Step 4: Delegate focused RED verification**

Run through a fresh `gpt-5.6-terra` worker:

```sh
npm run build:test && node --test .test-dist/test/store.test.js
```

Expected: FAIL because the current Store rejects or returns the canonical scope
incorrectly.

- [ ] **Step 5: Commit the red tests and documents**

```sh
git add test/store.test.ts docs/superpowers/specs/2026-08-05-instruction-resource-analysis-store-compat-design.md docs/superpowers/plans/2026-08-05-instruction-resource-analysis-store-compat.md && git commit -m "test(store): specify instruction resource analysis compatibility"
```

### Task 2: Normalize runtime Store records

**Files:**

- Modify: `src/core/model.ts:55`
- Modify: `src/store/analyses.ts:20-45,226-472,731-870`
- Test: `test/store.test.ts`

- [ ] **Step 1: Widen only the migration boundary**

Import `FindingScope` and exact `LegacyFindingScope` in `src/core/model.ts` and
define `Scope` as their union. Do not edit Report v2, rules, reporters, or
fingerprints.

- [ ] **Step 2: Add strict private Store readers**

Import `normalizeFindingScopeIdentity` and `projectLegacyFindingScope` in
`src/store/analyses.ts`. Add private descriptor-based raw finding/record guards
that accept only exact legacy Store v1 scopes without evaluating getters. Change
runtime finding snapshots to immediately normalize accepted canonical or legacy
input, returning fresh canonical findings.

- [ ] **Step 3: Delegate focused GREEN verification**

Run through a fresh `gpt-5.6-terra` worker:

```sh
npm run build:test && node --test .test-dist/test/store.test.js
```

Expected: every Store test passes with no warning regressions.

- [ ] **Step 4: Commit runtime normalization**

```sh
git add src/core/model.ts src/store/analyses.ts test/store.test.ts && git commit -m "feat(store): normalize instruction resource findings"
```

### Task 3: Project and authenticate Store v1 snapshots

**Files:**

- Modify: `src/store/analyses.ts:1122-1450`
- Test: `test/store.test.ts`

- [ ] **Step 1: Project before computing persistent identities**

Build a private snapshot projection that maps canonical finding scopes with
`projectLegacyFindingScope()`. Use it for generated-ID content,
`prepareAnalysis()`, `analysisAuditIdentity()`, saves, and legacy JSON migration.

- [ ] **Step 2: Enforce raw ordering**

In `parseSnapshot()`, do JSON parse, canonical raw-byte check, raw digest check,
strict legacy shape validation, column-mirror validation, and only then canonical
record construction. Reject raw `instruction_resource` even with a valid digest;
do not write existing rows or add schema markers.

- [ ] **Step 3: Delegate focused GREEN verification**

Run through a fresh `gpt-5.6-terra` worker:

```sh
npm run build:test && node --test .test-dist/test/store.test.js
```

Expected: compatibility, hostile-input, migration, and existing Store tests pass.

- [ ] **Step 4: Commit wire compatibility**

```sh
git add src/store/analyses.ts test/store.test.ts && git commit -m "feat(store): preserve legacy analysis snapshot bytes"
```

### Task 4: Verify and publish readiness

**Files:**

- Verify: `src/core/model.ts`, `src/store/analyses.ts`, `test/store.test.ts`, and both documents only.

- [ ] **Step 1: Delegate complete validation**

```sh
npm run check
```

Expected: typecheck and full tests pass.

- [ ] **Step 2: Confirm exact scope**

```sh
git diff --check ca46dbe1e2df380059e2c1d0c47921d717732dda...HEAD && git diff --name-only ca46dbe1e2df380059e2c1d0c47921d717732dda...HEAD
```

Expected: no whitespace errors and only the five approved paths.

- [ ] **Step 3: Run local Actions before push**

Use `/run-github-actions-locally` with fresh `gpt-5.6-terra` workers; push only
after every executable unit passes.

- [ ] **Step 4: Create the default-branch PR**

```sh
git push -u origin feature/instruction-resource-analysis-store-compat && gh pr create --base main --head feature/instruction-resource-analysis-store-compat --title "feat(store): preserve instruction resource analysis compatibility" --body "Preserves Store v1 legacy snapshot bytes while exposing canonical instruction-resource findings at runtime."
```

Expected: a ready PR to the default branch and no local merge.
