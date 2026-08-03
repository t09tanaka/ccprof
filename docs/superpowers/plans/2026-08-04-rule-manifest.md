# Versioned Rule Manifest Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one validated R001-R008 Rule Manifest and attach its versioned compatibility contract to new findings without breaking legacy Report v2 or Store v2 data.

**Architecture:** A new immutable manifest module validates and owns all rule metadata. Existing capability and finding-key consumers derive from it; analysis decorates final findings and includes the catalog in the policy digest; the existing CLI exposes static JSON catalog views.

**Tech Stack:** TypeScript 5.9 LanguageService/compiler, Node.js test runner, existing deterministic analysis, privacy, Store v2, and CLI modules.

---

### Task 1: Lock the catalog and compatibility contract

**Files:**
- Create: `src/rules/manifest.ts`
- Modify: `src/rules/capabilities.ts`
- Modify: `src/rules/shared.ts`
- Test: `test/rule-manifest.cases.ts` (registered by `test/capability-coverage.test.ts`)

- [ ] **Step 1: Write failing catalog tests**

Test the exact ten-field values for R001-R008, deterministic ordering, clone
isolation, and a table of invalid catalogs covering shape, missing/unknown
fields, normalized duplicates, unknown/missing IDs, SemVer/epoch boundaries,
capabilities, sources, modes, policies, schemas, and enum values. Assert error
codes plus index/field context.

- [ ] **Step 2: Delegate focused RED**

Run `npm run build:test && node --test .test-dist/test/capability-coverage.test.js`.
Expected: TypeScript compilation fails because the manifest APIs do not exist.

- [ ] **Step 3: Implement the validated immutable catalog**

Define the exact `RuleManifest`, `RuleManifestValidationError`,
`validateRuleManifestCatalog`, `listRuleManifests`, and `ruleManifest` APIs.
Validate the built-in catalog at initialization, freeze internal entries and
arrays, and return deep copies from public APIs.

- [ ] **Step 4: Derive capabilities and epoch-aware keys**

Build the existing `RULE_REQUIRED_CAPABILITIES` export from the catalog. Add an
explicit compatibility-key helper whose epoch-1 hash retains the current
`rule_id + NUL + target` preimage and whose later epochs include `@<epoch>`;
make `findingKey` obtain the epoch from the manifest.

- [ ] **Step 5: Delegate GREEN and commit**

Run the focused test plus existing capability and primary/secondary rule tests.
Commit the production and test changes as
`feat: add a validated versioned rule manifest`.

### Task 2: Publish compatibility metadata on new findings

**Files:**
- Modify: `src/core/model.ts`
- Modify: `src/core/analyze.ts`
- Modify: `src/reporters/privacy.ts`
- Modify: `test/rule-manifest.cases.ts`

- [ ] **Step 1: Write failing metadata and compatibility tests**

Assert that catalog decoration adds `rule_version` and
`compatibility_epoch` for every rule, strict/balanced privacy preserves them,
legacy findings missing them retain their old shape, epoch 1 keeps known keys,
epoch 2 isolates recurrence/dismissal/adoption keys, and catalog changes alter
the deterministic policy input.

- [ ] **Step 2: Delegate focused RED**

Run the focused compiled test. Expected: metadata fields and the decorator are
missing, or projections drop the fields.

- [ ] **Step 3: Implement additive finding metadata**

Make both fields optional on `Finding` solely for legacy reads. Decorate all
final ledger findings before Store persistence, dismissal filtering, and Report
v2 construction. Conditionally copy metadata in strict/balanced privacy and
include the ordered manifest array in the analysis policy digest.

- [ ] **Step 4: Delegate GREEN and commit**

Run the focused test plus Store, reporter, model, and analyze integration tests.
Commit as `feat: version rule finding compatibility`.

### Task 3: Expose the catalog through the CLI

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/rule-manifest.cases.ts`

- [ ] **Step 1: Write failing CLI tests**

Assert `parseCliArgs` recognizes only `rules list` and
`rules explain <canonical-id>`, `runCli` emits stable pretty JSON without
invoking handlers, and unknown actions, extra arguments, and unknown IDs exit 2
with actionable sanitized usage output.

- [ ] **Step 2: Delegate focused RED**

Run the focused compiled test. Expected: `rules` is parsed as an analyze
argument and exits with a usage error.

- [ ] **Step 3: Implement the static rules CLI**

Add a `ParsedRulesCommand`, exact parser, usage lines, and a direct static
dispatch before command handlers. Render list/lookup API values with two-space
JSON and one trailing newline; never inspect cwd, Store, sessions, or network.

- [ ] **Step 4: Delegate GREEN and commit**

Run the focused test and existing reporter/CLI tests. Commit as
`feat: expose the rule manifest CLI`.

### Task 4: Verify and complete the PR lifecycle

- [ ] Confirm exactly twelve changed files and fewer than 300 added production
  lines; split or stop before expanding beyond that boundary.
- [ ] Obtain an independent specification review, then a separate independent
  quality/security review; fix only P0-P2 regressions caused by this change in
  new commits.
- [ ] Delegate `/run-github-actions-locally` workflow enumeration and every
  applicable runnable unit. Rebase current `origin/main` and repeat if needed.
- [ ] Push `feature/rule-manifest`, create
  `[Rules] feat: publish a versioned rule manifest` against `main`, monitor all
  remote checks, merge with a merge commit after green, synchronize `main`, and
  run `worktree-pr-flow:cleanup`.
