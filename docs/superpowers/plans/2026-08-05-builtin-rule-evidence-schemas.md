# Built-in Rule Evidence Schemas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every built-in Rule Manifest `evidence_schema` URI resolve to a
strict packaged Draft 2020-12 resource that conforms to current runtime
evidence.

**Architecture:** Package one JSON Schema bundle with shared definitions and
eight embedded resources whose `$id` values are the manifest URIs. A focused
Ajv conformance test generates representative evidence with the current rule
detectors, validates optional variants and fail-closed behavior, and checks the
npm dry-run file list.

**Tech Stack:** JSON Schema Draft 2020-12, Ajv 8 (development only), TypeScript
5.9, Node.js test runner, npm packaging, and the existing R001-R008 detectors.

---

### Task 1: Record the approved contract

**Files:**
- Add: `docs/superpowers/specs/2026-08-05-builtin-rule-evidence-schemas-design.md`
- Add: `docs/superpowers/plans/2026-08-05-builtin-rule-evidence-schemas.md`

- [x] **Step 1: Document the selected bundle design**

Record the eight exact manifest URIs, closed evidence shapes, R003/R004/R005/
R006/R008 variants, npm publication route, conformance strategy, and explicit
scope exclusions.

- [x] **Step 2: Self-review the design**

Verify there are no placeholders, the epochs match current `origin/main`, the
two R006 epoch-2 shapes are retained, and no Report v3 or rule behavior change
is implied.

### Task 2: Establish the failing conformance contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Add: `test/rule-evidence-schema.test.ts`

- [ ] **Step 1: Add the Draft 2020-12 test validator**

Install Ajv as an exact development dependency. Import `ajv/dist/2020.js` in
the test so `$defs`, embedded `$id` resources, dependent requirements,
conditionals, and unevaluated-property rules use the correct dialect.

- [ ] **Step 2: Build representative evidence from runtime detectors**

Create minimal typed action/event/history fixtures and call:

```ts
detectRework(...)
detectRedundantRuns(...)
detectRediscovery(...)
detectHumanWait(...)
detectSerialSlack(...)
detectChronicCost(...)
materializeChronicCostFindings(...)
detectContextBloat(...)
detectFlakyTests(...)
```

Require at least one current evidence object for R001-R008 and both R006
epoch-2 forms. Include an optional historical form and the R004/R005
conditional forms so optional-property drift is observable.

- [ ] **Step 3: Assert resolution, validation, rejection, and packaging**

Load `schemas/builtin-rule-evidence.schema.json`, add it to Ajv, and assert
`getSchema(manifest.evidence_schema)` resolves each embedded resource with the
same `$id`. Validate runtime samples. For every rule, clone a sample and assert
failure after deleting a required field, replacing a field with a mismatched
type, adding an undeclared field, or using another rule's schema. Parse
`npm pack --dry-run --json --ignore-scripts` and require the schema path.

- [ ] **Step 4: Delegate focused RED to Sonnet**

Ask the read-only Sonnet worker to run:

```bash
npm run build:test
node --test .test-dist/test/rule-evidence-schema.test.js
```

Expected: failure because the bundle does not exist. The worker must not edit
files. If Sonnet authentication is unavailable, record the exact error and do
not substitute another model or run the check in the implementation context.

### Task 3: Publish the minimal schema bundle

**Files:**
- Add: `schemas/builtin-rule-evidence.schema.json`
- Test: `test/rule-evidence-schema.test.ts`

- [ ] **Step 1: Add shared closed definitions**

Define nonnegative/positive safe integers, nonnegative finite JSON numbers,
unique string arrays, session-reference arrays, command identity, and grouped
historical evidence. Keep the bundle root stable and Draft 2020-12.

- [ ] **Step 2: Add all eight embedded resources**

For every manifest row, set `$schema` to Draft 2020-12 and `$id` to the exact
`ccprof://rules/R00x/evidence/vN` URI. List every always-present detector field
in `required`, close every root and nested object, model R004/R005 with
conditionals, and model R006 with two closed `oneOf` branches.

- [ ] **Step 3: Delegate focused GREEN to Sonnet**

Ask the read-only Sonnet worker to run the focused build/test commands from
Task 2. Confirm all runtime samples pass and every fail-closed mutation fails.
Do not weaken a schema merely to accept a fixture that is not emitted by the
current detector.

- [ ] **Step 4: Commit the contract as one feature unit**

Stage only the bundle, conformance test, exact Ajv dependency files, and this
plan. Commit without amend or hook bypass as:

```text
feat(schema): publish built-in rule evidence schemas
```

### Task 4: Verify, review, publish, merge, and clean up

- [ ] **Step 1: Delegate full local checks to Sonnet**

Have read-only Sonnet run `npm run check`, focused package dry-run validation,
and `/run-github-actions-locally` Phase 1/2 with `--model sonnet` for every
applicable workflow unit. Record complete pass/fail/skip counts. Do not push a
logic/schema contract change unless this gate is green.

- [ ] **Step 2: Verify scope and repository state**

Confirm no production TypeScript changed, at most six files differ from
`origin/main`, worktree-only configuration is absent, the worktree is clean
after commit, and all commits are on
`feature/builtin-rule-evidence-schemas`.

- [ ] **Step 3: Push and create the default-branch PR**

Push the branch and create
`[Schema] feat: publish built-in rule evidence schemas` (or the repository's
closest title-compliant equivalent) against `main`. Include exact local check
results, package evidence, tests added, and revert-safe rollback in the body.

- [ ] **Step 4: Complete CI and two-stage review**

Monitor every remote check. Obtain an independent specification-compliance
review first, then a separate code-quality/security review. Reviewers may read
and report only. Fix only defects introduced by this PR in new commits, rerun
Sonnet local CI, push, and repeat CI/review until green and resolved.

- [ ] **Step 5: Merge and clean up**

Use GitHub's merge-commit method after all gates pass, retrieve the merge SHA,
then follow `worktree-pr-flow:cleanup` safety checks. Remove the independent
worktree and local feature branch, do not manually delete the remote branch,
and report all remaining worktrees/branches.

