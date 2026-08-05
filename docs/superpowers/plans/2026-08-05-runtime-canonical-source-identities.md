# Runtime Canonical Source Identities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canonicalize built-in adapter identities behind `validateSessionSource()` while preserving all legacy v1/v2 serialization and direct adapter behavior.

**Architecture:** Normalize only the validated boundary to namespaced built-in IDs. Project canonical IDs back to legacy spellings at Event Identity v1, Source Descriptor v1, and analysis-identity boundaries, and make the remaining built-in runtime branches representation-independent.

**Tech Stack:** TypeScript 5.9, Node.js test runner, existing source-identity compatibility helpers.

---

### Task 1: Lock the boundary and compatibility behavior with tests

**Files:**
- Modify: `test/session-source-contract.test.ts`

- [ ] **Step 1: Add canonical identity fixtures and focused assertions**

Import `applyHookEvents`, `buildTimeline`, `eventIdentity`,
`encodeEventIdentity`, `deriveSessionBranchTransitionAtMs`, and
`admitSessionEventPrefix`. Define canonical Claude/Codex constants. Assert that
raw built-in contracts remain legacy while `validateSessionSource()` returns
canonical contracts and sessions for legacy/canonical input combinations.

- [ ] **Step 2: Cover fail-closed errors and supplied Event Identity**

Add cases that require `unknown_adapter` for unsupported contract IDs,
`adapter_mismatch` for Claude/Codex or unsupported result IDs, and a legacy
Event Identity snapshot for both legacy and canonical supplied spellings.

- [ ] **Step 3: Pin compatibility output and transition semantics**

Compare `encodeEventIdentity(eventIdentity(...))`,
`deriveSourceDescriptor(...)`, and persisted audit identity for otherwise
identical legacy/canonical sessions. Keep Source Descriptor v1 validation
strictly legacy even though derivation accepts canonical runtime sessions.
Assert canonical Claude sessions still drive branch-transition selection, hook
extension, verified-tail creation, and Claude warning-line filtering under
budget truncation.

- [ ] **Step 4: Run focused RED through the terra verifier**

Run:

```sh
npm run build:test
node --test .test-dist/test/session-source-contract.test.js
```

Expected: failure only because validated identities are still legacy and
canonical sessions are not yet accepted by the compatibility paths.

### Task 2: Canonicalize the validated boundary

**Files:**
- Modify: `src/sources/session-source.ts`
- Modify: `src/core/source-identity.ts`

- [ ] **Step 1: Add narrow compatibility helpers**

Add a helper that recognizes either spelling of one built-in adapter and a v1
projection helper that maps canonical built-ins to `claude`/`codex` while
leaving already-legacy or unrelated strings unchanged.

- [ ] **Step 2: Normalize contract and result identities**

In `validateContract`, normalize adapter identity and require a known built-in,
translating all parse/unsupported cases to `unknown_adapter`. In
`validateDiscoveredSessions`, normalize result identity with
`adapter_mismatch`, compare canonical meanings, and return canonical
`Session.source` values. Do not alter the exported raw built-in contracts.

- [ ] **Step 3: Validate supplied identities by meaning**

Normalize supplied `event_identity.source_adapter_id`, compare it to the
canonical session source, and snapshot the legacy v1 projection. Keep every
other exact-field and content-free validation rule unchanged.

### Task 3: Preserve v1/v2 identity bytes and transition behavior

**Files:**
- Modify: `src/core/event-identity.ts`
- Modify: `src/core/source-descriptor.ts`
- Modify: `src/core/analyze.ts`
- Modify: `src/analysis/hook-events.ts`
- Modify: `src/analysis/timeline.ts`

- [ ] **Step 1: Project Event Identity and Source Descriptor v1**

Use the v1 adapter projection in `eventIdentity()`. Resolve canonical or legacy
built-in session IDs through the existing legacy Source Descriptor registry
before computing source instance and fingerprint values, without widening the
strict v1 descriptor validator. Project `Session.source` in the persisted
`analysis-source-v1` snapshot before calculating its digest.

- [ ] **Step 2: Make transition-only branches representation-independent**

Replace the remaining direct Claude checks in branch-transition selection,
hook attribution, verified tails, and budget warning-line handling with the
built-in compatibility helper. Project the verified-tail lane identity and the
analysis rule-session lane digest to legacy v1 spelling.

- [ ] **Step 3: Run focused GREEN through the same terra verifier**

Run:

```sh
npm run build:test
node --test .test-dist/test/session-source-contract.test.js
```

Expected: all focused tests pass with zero warnings.

### Task 4: Verify, review, and commit

**Files:**
- Review every file listed above and both `docs/superpowers` documents.

- [ ] **Step 1: Run the full check through a fresh terra verifier**

Run:

```sh
npm run check
```

Expected: typecheck and the complete test suite pass with zero failures and no
new warnings.

- [ ] **Step 2: Review scope and compatibility**

Confirm no Store, cache, parser, fixture, SQLite, schema, capability-gating,
third-party adapter, migration, or backfill files changed. Confirm at most ten
files and no more than 300 changed production lines.

- [ ] **Step 3: Commit the logical change**

Explicitly stage the production files, focused test, design, and plan. Commit
without amend or hook bypass:

```text
feat(core): canonicalize validated source identities

Co-Authored-By: Codex <noreply@openai.com>
```

- [ ] **Step 4: Report evidence without pushing**

Report base/head SHA, changed files, production LOC, semantic probe summary,
RED/GREEN/full outputs, commit SHA, and clean status. Do not push, create a PR,
merge, or clean up the worktree in this turn.
