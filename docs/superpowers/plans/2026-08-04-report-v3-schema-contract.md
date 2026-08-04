# Report v3 Schema Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the approved Report v3 JSON Schema through a packaged,
cwd-independent CLI command without changing any Report v2 producer or output.

**Architecture:** Add one static schema document and one small command loader.
Extend the existing parsed-command union and early static-command dispatch so
the schema path is resolved from `import.meta.url`, fully parsed before stdout,
and never depends on repository, Store, policy, privacy, or analysis state.

**Tech Stack:** TypeScript 5.9, Node.js built-ins and test runner, JSON Schema
Draft 2020-12, existing npm package-smoke workflow.

---

### Task 1: Commit the approved contract and execution plan

**Files:**
- Add: `docs/superpowers/specs/2026-08-04-report-v3-schema-contract-design.md`
- Add: `docs/superpowers/plans/2026-08-04-report-v3-schema-contract.md`

- [x] **Step 1: Record edge cases and compatibility boundaries**

Document command parsing, arbitrary-cwd/package layouts, all-output-or-none
failure behavior, deterministic newline/key order, closed objects, numeric and
identifier bounds, runtime-only cross-field constraints, and the prohibition
on fabricated producer inputs.

- [x] **Step 2: Self-review and commit the documents**

Check the design against the approved audit and explicit acceptance criteria,
run `git diff --check`, and commit the two required documents as
`docs: design report v3 schema contract`.

### Task 2: Establish RED command and packaging contracts

**Files:**
- Add: `test/report-schema-command.test.ts`
- Modify: `test/release-workflow.test.ts`

- [x] **Step 1: Write failing schema-command tests**

Add table-driven parse/exit tests for the exact `report-v3` target, missing,
unknown, duplicate, extra, and flag-like arguments, plus global help precedence.
Assert the command never touches cwd, handlers, policy, Store, or privacy; emits
exactly one newline; is stable across calls; works from arbitrary cwd and a
symlinked `.test-dist` entry; and returns exit 5 with empty stdout for injected
missing/malformed schema reads.

Parse the real schema and assert Draft 2020-12, the stable `$id`, root version
constant, required top-level sections, recursive object closure, numeric and
identifier patterns, finding fields, and the exact runtime-constraint texts.
Keep a Report v2 JSON compatibility assertion on the existing path.

- [x] **Step 2: Lock installed-package coverage**

Extend the release-workflow contract test to require package smoke to invoke
`ccprof schema report-v3`, parse its redirected stdout, and assert the v3
version constant.

- [x] **Step 3: Verify RED and commit tests only**

Run:

```bash
npm run build:test
node --test .test-dist/test/report-schema-command.test.js .test-dist/test/release-workflow.test.js
```

Expected: compilation or assertions fail because the schema command, schema
artifact, and workflow smoke lines do not exist. Commit only the failing tests
as `test: define report v3 schema publication contract`.

### Task 3: Publish the schema and implement the static command

**Files:**
- Add: `schemas/report-v3.schema.json`
- Add: `src/commands/schema.ts`
- Modify: `src/cli.ts`
- Test: `test/report-schema-command.test.ts`

- [x] **Step 1: Add the closed Draft 2020-12 schema**

Define reusable `$defs` for safe integers, semantic versions, Git OIDs,
SHA-256 digests, identifiers, JSON evidence, finding, source coverage, and rule
coverage. Require the approved envelope and finding fields. Put every
non-schema sibling/identity invariant in the root
`x-ccprof-runtime-constraints` array; do not add placeholder-producing code.

- [x] **Step 2: Add a cwd-independent all-or-nothing loader**

In `src/commands/schema.ts`, walk upward from the module directory until
`schemas/report-v3.schema.json` can be read. Accept an optional reader function
only as the narrow failure-test seam. Parse first, then return
`JSON.stringify(schema, null, 2) + "\n"`. Convert missing/malformed input to a
fixed content-free error before returning any output.

- [x] **Step 3: Extend CLI parsing and early dispatch**

After the completed Language Service reference audit, add a closed
`ParsedSchemaCommand` member to `ParsedCliCommand`. Parse exactly one
`report-v3` target, preserve global help precedence, and dispatch this static
command before cwd, CI, policy, handlers, Store, or privacy. Map usage errors to
2 and loader failures to 5 using existing exit conventions.

- [x] **Step 4: Verify focused GREEN and commit**

Run the compiled report-schema command test alone, then the existing CLI and
Report v2 reporter tests most directly affected. Expect all focused tests to
pass while the release-workflow contract remains RED pending Task 4. Commit as
`feat: publish report v3 schema contract`.

### Task 4: Expose and package-smoke the public command

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Test: `test/release-workflow.test.ts`

- [x] **Step 1: Extend installed-tarball smoke**

After globally installing the packed tarball and before creating any fixture
repository, redirect `ccprof schema report-v3` to a temporary file. Parse it
with Node and fail unless `schema.properties.schema_version.const === 3`.

- [x] **Step 2: Document the compatibility boundary**

Add the command to the public command list and a concise schema-publication
section. State explicitly that current `--json` is Report v2 and publishing the
v3 schema does not switch a producer.

- [x] **Step 3: Verify and commit**

Run the focused release-workflow and documentation tests. Commit workflow and
README changes as `docs: expose report v3 schema command`.

### Task 5: Verify, review, and complete the PR lifecycle

- [ ] **Step 1: Verify scope and full behavior**

Run `npm run check`, the built CLI from arbitrary cwd, `npm pack` plus isolated
global-prefix install/package smoke, `git diff --check`, changed-file count,
and production TypeScript line count. Expected: at most nine files, less than
300 production TypeScript lines, all tests/typecheck/build green, and no
ReportV2/rendered-output diffs.

- [ ] **Step 2: Independent reviews**

Use a fresh specification reviewer, then a fresh quality/security reviewer.
Fix only P0-P2 defects introduced by this change in new commits; do not amend or
adopt unrelated improvements.

- [ ] **Step 3: Local CI gate and PR**

Run the repository's local GitHub Actions workflow before push because this PR
changes logic. After it is green, push `feature/report-v3-schema-contract`, open
a PR against the default branch, monitor CI/reviews, and clean up the worktree
only after the PR lifecycle is complete.
