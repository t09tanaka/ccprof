# Versioned Capability Descriptor v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a packaged, independently validated Capability Descriptor v1
schema and a lossless canonical projection of ccprof's six current capability
literals without changing runtime capability semantics.

**Architecture:** Reuse the npm `schemas` publication allowlist and add one
closed Draft 2020-12 document. Validate the real schema with test-only Ajv and
keep the canonical legacy projection in a JSON fixture; do not add a CLI path,
runtime model, registry, or hand-written validator.

**Tech Stack:** JSON Schema Draft 2020-12, Ajv 8.17.1, TypeScript 5.9, Node.js
built-in test runner, npm package allowlist.

---

### Task 1: Commit the approved design and execution plan

**Files:**
- Add: `docs/superpowers/specs/2026-08-05-versioned-capability-descriptor-v1-design.md`
- Add: `docs/superpowers/plans/2026-08-05-versioned-capability-descriptor-v1.md`

- [x] **Step 1: Record the contract and edge cases**

Document the npm publication path, exact root and entry fields, fail-closed
undeclared behavior, SemVer exclusivity, evidence/state contradictions,
lossless legacy mapping, TDD negative matrix, concurrency boundary, and
explicit runtime exclusions.

- [ ] **Step 2: Self-review and commit the documents**

Inspect both files for placeholders, contradictions, ambiguous field names,
and scope drift. Commit them as:

```text
docs: design capability descriptor v1
```

### Task 2: Establish RED validation contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Add: `test/capability-descriptor-schema.test.ts`

- [ ] **Step 1: Add the test-only Draft 2020-12 validator**

Add exactly `ajv@8.17.1` to `devDependencies` and update the lockfile. Import
`Ajv2020` from `ajv/dist/2020.js` only in the new test. Do not add a production
dependency, format plugin, schema registry, or reusable validator module.

- [ ] **Step 2: Write the failing schema and fixture tests**

Read these exact future paths:

```text
schemas/capability-descriptor-v1.schema.json
test/fixtures/protocol/capability-descriptor-v1.json
```

Compile the schema in strict mode and assert the canonical fixture validates.
Assert Draft 2020-12, the stable `$id`, recursive object closure, schema and
descriptor version constants, namespaced-ID and SemVer patterns, exact
version/range exclusivity, state/evidence conditionals, and the existing npm
`files` entry for `schemas`.

Use cloned fixture cases to prove rejection of root/nested unknown fields,
wrong versions, malformed IDs/versions/ranges, unknown enum values, version
and range together/neither, unsupported or unknown state with supported
evidence, and supported state without evidence. Assert the fixture's six IDs
and `legacy_id` values are unique, code-unit sorted, and bijective.

- [ ] **Step 3: Run focused RED**

Run from the isolated worktree:

```bash
npm run build:test
node --test .test-dist/test/capability-descriptor-schema.test.js
```

Expected: compilation succeeds, then the test fails because the schema and
fixture files do not yet exist. Confirm the failure is an expected missing
artifact, not an import or Ajv setup error.

### Task 3: Publish the minimal schema, fixture, and documentation

**Files:**
- Add: `schemas/capability-descriptor-v1.schema.json`
- Add: `test/fixtures/protocol/capability-descriptor-v1.json`
- Modify: `README.md`
- Test: `test/capability-descriptor-schema.test.ts`

- [ ] **Step 1: Add the closed descriptor schema**

Implement the fields and constraints from the approved design. Use schema
`oneOf` for exact version versus range and `if`/`then` branches for support
state/evidence/timestamp contradictions. Keep the capability identifier open
to any valid DNS namespace and close every object with
`additionalProperties: false`.

- [ ] **Step 2: Add the canonical six-capability projection**

Create the code-unit-sorted fixture with these exact legacy values:

```text
approvals
branch_rows
edit_fragments
sidechains
token_usage
tool_timestamps
```

Map each to `ccprof.dev/capabilities/<legacy_id>`, mark every requirement
optional, and use the conservative legacy projection specified by the design.
Do not import the fixture into runtime code.

- [ ] **Step 3: Document the public contract and compatibility boundary**

Add a concise README section near the existing source capability documentation
that names the packaged file and stable schema URL, links the canonical
fixture, lists all five support states, states undeclared means unknown, and
explicitly preserves the legacy `Session.capabilities === undefined` runtime
behavior.

- [ ] **Step 4: Run focused GREEN**

Run:

```bash
npm run build:test
node --test .test-dist/test/capability-descriptor-schema.test.js
```

Expected: the canonical fixture and all positive cases pass, and every negative
case is rejected by Ajv.

- [ ] **Step 5: Self-review and commit implementation**

Inspect the exact diff for runtime changes, unknown fields, accidental closed
capability enums, unsupported quality claims, duplicate fixture IDs, and more
than eight changed files. Commit as:

```text
feat(protocol): publish versioned capability descriptor v1
```

### Task 4: Review, verify, and complete the PR lifecycle

- [ ] **Step 1: Specification compliance review**

Dispatch a fresh reviewer with the full acceptance criteria, design, and git
range. Fix only missing or extra behavior introduced by this change, then
repeat until approved.

- [ ] **Step 2: Code quality review**

After specification approval, dispatch a fresh reviewer for schema clarity,
test validity, dependency placement, documentation accuracy, and scope. Fix
Critical/Important issues in new commits and repeat review until approved.

- [ ] **Step 3: Full Codex-delegated verification**

Delegate all static analysis and test execution to a Codex subagent. Run the
repository local GitHub Actions equivalent, including `npm run check`, focused
Ajv validation, and package artifact inspection. The coordinator must not run
lint, typecheck, tests, or CI commands directly.

- [ ] **Step 4: Rebase, push, PR, remote CI, and merge**

Fetch current `origin/main`; rebase and reuse any compatible identifier
grammar landed by Trace Envelope work. After local verification is green,
push `feature/versioned-capability-descriptor-v1`, open the PR against `main`,
monitor all required checks, repeat the two review stages for any subsequent
fix, and merge on GitHub with **Create a merge commit**.

- [ ] **Step 5: Cleanup**

After the PR is merged and the worktree is clean with no unpushed commits, run
`worktree-pr-flow:cleanup`. Remove only the local worktree and local feature
branch; do not manually delete the remote branch.
