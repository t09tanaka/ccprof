# Neutral Trace Envelope v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish and package a closed, lossless, vendor-neutral Trace Envelope
v1 contract with a validating neutral fixture and negative conformance cases.

**Architecture:** Add a standalone Draft 2020-12 schema under the already
published `schemas` directory. Validate the real schema and fixture with a
test-only Draft 2020-12 validator; leave every existing runtime model and
command unchanged.

**Tech Stack:** JSON Schema Draft 2020-12, TypeScript 5.9, Node.js test runner,
Ajv 8 (development-only conformance validator), existing npm packaging.

---

### Task 1: Record the approved contract

**Files:**
- Add: `docs/superpowers/specs/2026-08-05-neutral-trace-envelope-v1-design.md`
- Add: `docs/superpowers/plans/2026-08-05-neutral-trace-envelope-v1.md`

- [x] Document W3C identifier bounds, lossless nanoseconds, sequence scope,
  closure and payload exception, neutral work units, privacy, provenance,
  packaging, tests, and explicit non-runtime scope.
- [x] Check the documents for placeholders, contradictions, ambiguous
  validation ownership, and scope beyond this protocol publication.

### Task 2: Establish the RED conformance contract

**Files:**
- Add: `test/fixtures/protocol/dummy-agent-trace-envelope-v1.json`
- Add: `test/trace-envelope-schema.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] Add Ajv 8 as a development-only dependency so tests execute the actual
  Draft 2020-12 contract instead of a hand-written partial validator.
- [ ] Add the neutral fixture with `$schema`, protocol/producer identity,
  W3C IDs, sequence, decimal-string clocks, generic work unit, namespaced
  event and external payload schema, privacy state, and JSON-pointer
  provenance.
- [ ] Add tests that compile the real schema path, validate the fixture, allow
  a valid optional parent, reject forbidden vendor/forge literals, and assert
  schema/package metadata.
- [ ] Add table-driven invalid clones for unknown fields, required fields,
  invalid/all-zero IDs, negative/unsafe sequence, malformed/lossy nanoseconds,
  bad namespaces/URIs/pointers, and wrapper closure versus open payload.
- [ ] Delegate `npm run build:test && node --test
  .test-dist/test/trace-envelope-schema.test.js` to a fresh read-only Codex
  worker. Expected RED: the schema file is missing or the asserted contract is
  absent, not a syntax error in the test.

### Task 3: Add the minimal schema and documentation

**Files:**
- Add: `schemas/trace-envelope-v1.schema.json`
- Modify: `README.md`
- Test: `test/trace-envelope-schema.test.ts`

- [ ] Define reusable closed `$defs` for namespaced names, absolute URI-shaped
  strings, W3C trace/span IDs, canonical decimal nanoseconds, producer,
  timestamp, work unit, event wrapper, privacy, and provenance.
- [ ] Require all envelope sections, cap `sequence` at
  `9007199254740991`, make `parent_span_id` optional, and set
  `additionalProperties: false` on every contract object.
- [ ] Make `event.payload` the only explicit `additionalProperties: true`
  object and require `payload_schema` so external validation ownership is
  unambiguous.
- [ ] Document the stable URI and packaged path, sequence ordering scope,
  canonical decimal nanoseconds, the payload-validation second step, and the
  neutral fixture. State explicitly that no runtime behavior changes.
- [ ] Delegate the focused command from Task 2 to a fresh read-only Codex
  worker. Expected GREEN: all focused tests pass with zero failures.

### Task 4: Verify the complete local contract

- [ ] Delegate `npm run check` to a fresh read-only Codex worker and retain
  exact typecheck/test totals.
- [ ] Delegate an installed-artifact smoke using `npm pack`, an isolated npm
  prefix, and parsing
  `lib/node_modules/ccprof/schemas/trace-envelope-v1.schema.json`; retain the
  tarball path and result without editing tracked files.
- [ ] Delegate the `run-github-actions-locally` workflow-enumeration phase to a
  fresh Codex worker, then dispatch the selected workflow execution units to
  fresh read-only Codex workers according to dependency/resource ordering.
- [ ] Inspect `git diff --check`, changed-file count, production TypeScript
  line count, package contents, and working-tree scope before committing.

### Task 5: Commit, review, and complete the PR

- [ ] Use the commit skill to create intentional non-amended commits with
  Codex co-author attribution; exclude only ignored dependency/build outputs.
- [ ] Push only after the local CI gate is green and open a PR against the
  remote default branch with Tests/Rollback labels.
- [ ] Run a fresh spec-compliance reviewer against every acceptance criterion.
  Fix all direct gaps and re-review until approved.
- [ ] Only after spec approval, run a fresh quality reviewer using the exact
  `origin/main..HEAD` range. Fix Critical/Important issues introduced here and
  re-review until approved; keep minor or adjacent findings report-only.
- [ ] Rerun delegated local CI before each logic-changing push, monitor every
  remote check to terminal green, and resolve in-scope failures with new
  commits (never amend).
- [ ] Merge on GitHub with the merge-commit method, record the PR and merge
  SHA, then run the cleanup skill safety checks and remove only this worktree
  and local branch without force or remote-branch deletion.
