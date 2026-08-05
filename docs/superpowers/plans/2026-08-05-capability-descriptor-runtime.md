# Capability Descriptor Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-free, fail-closed Capability Descriptor v1 runtime validator and support query without wiring it into sessions or rules.

**Architecture:** One protocol module mirrors the packaged JSON Schema, safely reconstructs hostile `unknown` input into an immutable snapshot, and exposes conservative version-contract identity lookup. Legacy mapping and conversion are a separate next PR so this kernel stays below the production-line limit.

**Tech Stack:** TypeScript 5.9, Node.js 22/24 (`node:util`, built-in test runner), `node:assert/strict`, existing JSON Schema/Ajv parity test.

---

### Task 1: Record runtime parity tests and verify RED

**Files:**
- Create: `test/capability-descriptor-runtime.test.ts`
- Modify: `test/capability-descriptor-schema.test.ts`

- [ ] Add imports for the runtime constants, types, validator, support query,
  and validation error.
- [ ] Define one canonical descriptor factory and assertions for all five
  state/evidence combinations, exact and range declarations, duplicate IDs,
  malformed identifiers and versions, trailing line terminators, closed-field
  checks, proxy/accessor/revoked inputs, detached freezing, and source
  immutability.
- [ ] Assert that support lookup uses only `id`, accepts the three supported
  states, rejects undeclared/unsupported/unknown declarations, and requires an
  identical exact or range version contract.
- [ ] Add schema-test parity assertions that the runtime schema constants and
  fixed root values agree with the packaged fixture.
- [ ] Delegate `npm run build:test` to a fresh `gpt-5.6-terra` worker and verify
  TS2307 for `src/protocol/capability-descriptor.js` is the sole failure. Fix
  test-only type or syntax errors and repeat RED before production code.

Expected RED: exit 2 with only the missing runtime module/API as the cause.

### Task 2: Implement the runtime kernel and verify focused GREEN

**Files:**
- Create: `src/protocol/capability-descriptor.ts`

- [ ] Declare the fixed constants, readonly schema-mirroring unions and object
  types, exclusive exact/range declaration union, support query union, and
  content-free validation error.
- [ ] Copy the schema's capability ID, legacy ID, SemVer, and range grammars
  with absolute end assertions and exact maximum lengths.
- [ ] Add safe ordinary-object and dense-array descriptor readers that call
  `node:util` proxy detection before property inspection and reject accessors,
  symbols, holes, unexpected/non-enumerable fields, and non-plain prototypes.
- [ ] Parse every root/declaration/evidence field and enforce version
  exclusivity, evidence/state/precision consistency, nonempty capabilities,
  and unique declaration IDs.
- [ ] Reconstruct and deeply freeze evidence, declarations, the capabilities
  array, and the descriptor root.
- [ ] Implement `supportsCapability` as exact namespaced-ID plus identical
  version-contract matching for supported states only; invalid or incompatible
  queries return false.
- [ ] Keep the production module at or below 300 added lines; do not edit any
  existing shared type, schema, session, source, rule, or export surface.
- [ ] Delegate `npm run build:test` followed by
  `node --test .test-dist/test/capability-descriptor-runtime.test.js .test-dist/test/capability-descriptor-schema.test.js`
  to a fresh `gpt-5.6-terra` worker.

Expected GREEN: focused runtime and schema tests have zero failures and no
warnings.

### Deferred next PR: explicit legacy conversion

The next PR will add the exact six-token mapping and explicit
`legacyCapabilitiesToDescriptor(array)` boundary with its hostile-input,
empty-array, deterministic-output, and immutable-snapshot tests. It is not an
acceptance condition of this runtime-kernel PR.

### Task 3: Full verification, scope review, and commit

**Files:**
- Review and stage exactly the five files named by this plan.

- [ ] Delegate a fresh full `npm run check` to a `gpt-5.6-terra` worker and
  record exact test/pass/fail/skipped counts and warnings.
- [ ] Inspect `git diff --check`, `git diff --stat`, the complete diff, and
  production line count without executing lint, typecheck, build, or tests in
  this agent context.
- [ ] Reconcile runtime regex constants and evidence rules line-by-line with
  `schemas/capability-descriptor-v1.schema.json`; confirm no package export,
  shared signature, session, source, rule, or schema change appears.
- [ ] Stage exactly the five allowed paths and commit normally as
  `feat(protocol): add capability descriptor runtime`, including
  `Co-Authored-By: Codex <noreply@openai.com>` and without amend or
  `--no-verify`.
- [ ] Confirm HEAD, clean worktree, file count, production LOC, and that no
  push, PR, merge, or cleanup occurred.
