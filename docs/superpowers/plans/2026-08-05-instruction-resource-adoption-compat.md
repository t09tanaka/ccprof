# Instruction Resource Adoption Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make adoption runtime identities neutral while preserving exact legacy Store, fingerprint, Stats JSON, and TTY compatibility.

**Architecture:** Normalize legacy or canonical finding scopes at the adoption entry boundary and keep all runtime adoption records canonical. Store readers authenticate private legacy records before normalization, Store writers project canonical records before serialization, and Stats renderers project only at output time. The fixed `CLAUDE.md` compatibility descriptor remains the sole concrete instruction-resource implementation.

**Tech Stack:** TypeScript 5.9, Node.js 22/24 built-in test runner, better-sqlite3, strict ESM.

---

### Task 1: Specify canonical adoption analysis behavior and prove RED

**Files:**
- Modify: `test/adoption.test.ts`

- [ ] **Step 1: Add fingerprint compatibility tests**

Add assertions that the same finding with `scope: "claude_md"` and
`scope: "instruction_resource"` produces the same 64-character digest and that the
digest equals the pre-change legacy value. Add rejection cases for unknown, case,
whitespace, and NUL-bearing scopes.

- [ ] **Step 2: Add neutral detector tests**

Change the instruction-resource detectability expectation from `claude_md` to
`instruction_resource`. Run the existing real-Git `CLAUDE.md` fixture with both a
legacy and canonical candidate and assert that produced records have
`scope: "instruction_resource"`, `method: "instruction_resource_edit"`, and the same
fixed `CLAUDE.md` evidence path and oldest qualifying commit.

- [ ] **Step 3: Delegate focused RED verification**

Run through a fresh `gpt-5.6-terra` worker:

```sh
npm run build:test && node --test .test-dist/test/adoption.test.js
```

Expected: FAIL only where current analysis still hashes/routes/returns legacy
identities or rejects the canonical candidate type.

- [ ] **Step 4: Commit the failing analysis tests**

```sh
git add test/adoption.test.ts
git commit -m "test(analysis): specify instruction resource adoptions"
```

### Task 2: Specify Store wire compatibility and prove RED

**Files:**
- Modify: `test/store.test.ts`

- [ ] **Step 1: Make the runtime fixture canonical**

Use `scope: "instruction_resource"` with
`method: "instruction_resource_edit"` for instruction-resource fixtures while
leaving target-file fixtures unchanged.

- [ ] **Step 2: Pin exact legacy bytes and canonical runtime results**

Create the private expected legacy object inline and use `canonicalJson` to assert:

```typescript
{
  finding_key: "finding-resource",
  rule_id: "R002",
  scope: "claude_md",
  fingerprint: "fp-finding-resource",
  method: "claude_md_edit",
  detected_at_ms: 1_000,
  evidence: { commit: "a".repeat(40), path: "CLAUDE.md" },
}
```

Saving the corresponding canonical record must create exactly those raw bytes, and
loading it must return only canonical identities. A legacy JSON migration must insert
the same bytes while leaving the source file untouched.

- [ ] **Step 3: Pin fail-closed ordering and writes**

Insert non-canonical bytes, mismatched row mirrors, canonical scope/method tokens at
the raw wire boundary, and unknown/case/whitespace/NUL tokens. Assert each row is
skipped with `corrupt_adoptions`. Pass invalid and already-legacy identities to
`saveAdoptions`; assert `adoption_write_failed` and zero matching rows. Retain the
first-record-wins assertions.

- [ ] **Step 4: Delegate focused RED verification**

Run through a fresh `gpt-5.6-terra` worker:

```sh
npm run build:test && node --test .test-dist/test/store.test.js
```

Expected: FAIL because current writers serialize canonical input directly, readers
return legacy records, and the current raw guard does not enforce the new boundary.

- [ ] **Step 5: Commit the failing Store tests**

```sh
git add test/store.test.ts
git commit -m "test(store): specify adoption identity compatibility"
```

### Task 3: Specify Stats runtime and output compatibility and prove RED

**Files:**
- Modify: `test/reporters-and-cli.test.ts`

- [ ] **Step 1: Make Stats input fixtures canonical**

Change instruction-resource `AdoptionRecord` fixtures to
`instruction_resource`/`instruction_resource_edit`. Assert `summarizeStats` keeps the
canonical method in memory.

- [ ] **Step 2: Pin legacy JSON and TTY output**

Assert `renderStatsJson` emits `claude_md_edit` and never
`instruction_resource_edit`. Preserve the existing TTY lines containing
`claude_md_edit`, proving output compatibility without mutating the canonical report.

- [ ] **Step 3: Delegate focused RED verification**

Run through a fresh `gpt-5.6-terra` worker:

```sh
npm run build:test && node --test .test-dist/test/reporters-and-cli.test.js
```

Expected: FAIL because current aggregation/output share one legacy method identity.

- [ ] **Step 4: Commit the failing Stats tests**

```sh
git add test/reporters-and-cli.test.ts
git commit -m "test(stats): specify adoption compatibility projection"
```

### Task 4: Implement canonical analysis and fingerprint projection

**Files:**
- Modify: `src/analysis/adoption.ts`
- Test: `test/adoption.test.ts`

- [ ] **Step 1: Accept and normalize candidate identities**

Import `FindingScope`, `LegacyFindingScope`, and the compatibility functions. Type
candidate scope as `FindingScope | LegacyFindingScope`. Normalize it before routing
or record construction, and return the neutral detectability literal
`instruction_resource`.

- [ ] **Step 2: Preserve fingerprint bytes explicitly**

Replace the hash scope interpolation with:

```typescript
const legacyScope = projectLegacyFindingScope(
  normalizeFindingScopeIdentity(finding.scope),
);
```

Interpolate `legacyScope` into the unchanged domain input.

- [ ] **Step 3: Keep the detector concrete and fixed**

Read `path`, `evidence_path`, and the canonical adoption method from
`CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY`. Keep the existing Git arguments,
parsing, keyword qualification, timestamps, oldest selection, warnings, and
truncation logic unchanged.

- [ ] **Step 4: Delegate focused GREEN verification**

Run the Task 1 command through a fresh `gpt-5.6-terra` worker. Expected: all adoption
tests pass with no warnings.

- [ ] **Step 5: Commit analysis implementation**

```sh
git add src/analysis/adoption.ts
git commit -m "feat(analysis): normalize instruction resource adoptions"
```

### Task 5: Implement authenticated legacy Store projection

**Files:**
- Modify: `src/store/adoptions.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Separate runtime and raw record types**

Use canonical `FindingScope` and `AdoptionMethod` in exported `AdoptionRecord`. Define
a private legacy record with `LegacyFindingScope` and `LegacyAdoptionMethod`, plus a
raw validator that accepts only the exact legacy tokens and existing record shape.

- [ ] **Step 2: Normalize only after authentication**

Parse each SQLite JSON string, validate the raw legacy record, compare
`canonicalJson(raw)` to `record_json`, compare key/timestamp mirrors, and only then
return a newly constructed canonical record using the two normalizers.

- [ ] **Step 3: Preserve migration and writer bytes**

Keep legacy JSON records raw through dedupe and migration insertion. For saves,
project each canonical record before opening the database, then dedupe and insert the
projected legacy records. Let the existing catch boundary return
`adoption_write_failed` on invalid projection.

- [ ] **Step 4: Delegate focused GREEN verification**

Run the Task 2 command through a fresh `gpt-5.6-terra` worker. Expected: all Store
tests pass with no warnings.

- [ ] **Step 5: Commit Store implementation**

```sh
git add src/store/adoptions.ts
git commit -m "feat(store): preserve legacy adoption records"
```

### Task 6: Implement Stats compatibility projection

**Files:**
- Modify: `src/reporters/stats.ts`
- Test: `test/reporters-and-cli.test.ts`

- [ ] **Step 1: Keep aggregation canonical**

Allow `adoptionOutcome` and `StatsAdoption` to carry the canonical method unchanged.

- [ ] **Step 2: Project at render boundaries**

Map each JSON adoption method with `projectLegacyAdoptionMethod` in the copied stable
object. Format TTY adoption lines with the same projector. Do not mutate the supplied
Stats report.

- [ ] **Step 3: Delegate focused GREEN verification**

Run the Task 3 command through a fresh `gpt-5.6-terra` worker. Expected: all reporter
and CLI tests pass with no warnings.

- [ ] **Step 4: Commit Stats implementation**

```sh
git add src/reporters/stats.ts
git commit -m "feat(stats): project legacy adoption methods"
```

### Task 7: Verify, review, rebase, and publish

**Files:**
- Verify all eight scoped files only.

- [ ] **Step 1: Delegate full validation**

Run `npm run check` through a fresh `gpt-5.6-terra` worker. Expected: typecheck passes
and the complete test suite has zero failures or warnings.

- [ ] **Step 2: Request reviews in order**

Dispatch an independent spec reviewer against the exact base/head and all requirements.
Fix every actionable in-scope gap with a failing test and new commit, then obtain spec
approval. Only afterward dispatch the independent code-quality reviewer and repeat the
fix/re-review loop until approved.

- [ ] **Step 3: Rebase and repeat final reviews if the base advanced**

Fetch `origin/main`, rebase the feature branch, delegate `npm run check`, then obtain
fresh spec and quality approvals on the exact rebased head.

- [ ] **Step 4: Run local Actions through the required two-phase flow**

Use `/run-github-actions-locally`: a fresh `gpt-5.6-terra` enumerates execution units,
then fresh `gpt-5.6-terra` workers execute the units. Push only after every executable
unit is green.

- [ ] **Step 5: Create and monitor a Ready PR**

Push the feature branch, create a non-draft PR to the default branch, monitor every
required remote check, and verify the PR is MERGEABLE/CLEAN with zero unresolved
review threads. Report exact base/head/URL/check counts and review results to the root
orchestrator; do not merge.
