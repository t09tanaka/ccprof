# Legacy Capability Descriptor Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert an explicit, validated legacy six-token capability array into a deterministic, conservative Capability Descriptor v1 snapshot.

**Architecture:** A separate compatibility module imports the Capability Descriptor v1 constants, types, and validator introduced by PR #83. It validates an untrusted ordinary dense array without invoking accessors, constructs all six declarations in a fixed order, and delegates final detachment and deep freezing to the existing runtime validator.

**Tech Stack:** TypeScript 5.9, Node.js 22/24 (`node:util`, built-in test runner), `node:assert/strict`, existing Capability Descriptor v1 runtime and schema tests.

---

### Task 1: Specify exact conversion behavior and verify RED

**Files:**
- Create: `test/legacy-capability-descriptor.test.ts`

- [ ] **Step 1: Write exact mapping tests**

Import the wished-for API before the module exists and assert the canonical
vocabulary and a mixed conversion:

```ts
import {
  LEGACY_CAPABILITY_IDS,
  legacyCapabilitiesToDescriptor,
} from "../src/protocol/legacy-capability-descriptor.js";

assert.deepEqual(LEGACY_CAPABILITY_IDS, [
  "approvals", "branch_rows", "edit_fragments", "sidechains",
  "token_usage", "tool_timestamps",
]);
const result = legacyCapabilitiesToDescriptor([
  "tool_timestamps", "approvals",
]);
assert.deepEqual(result.capabilities.map(({ legacy_id }) => legacy_id),
  [...LEGACY_CAPABILITY_IDS]);
```

- [ ] **Step 2: Add conservative semantics and empty-input tests**

Assert present entries use `supported_partial`, unknown adapter-declared
evidence, and conservative precision; absent entries use `unsupported`, none
adapter-declared evidence, and `not_applicable`. Assert `[]` produces six
unsupported declarations and that input order does not affect output.

- [ ] **Step 3: Add hostile-input and immutability tests**

Cover `undefined`, primitives, unknown/non-string/duplicate entries, holes,
extra and symbol properties, accessor and non-enumerable indexes, proxy and
revoked proxy inputs, subclass/replaced prototypes, and length greater than
six. Verify getters are not invoked, errors have fixed content-free code and
message, a frozen ordinary input is accepted, and the returned graph is
detached and deeply frozen.

- [ ] **Step 4: Delegate the focused RED**

Delegate this exact command to a fresh `gpt-5.6-terra` worker:

```sh
npm ci && npm run build:test
```

Expected: exit 2 with TS2307 for only
`src/protocol/legacy-capability-descriptor.js`; fix test-only type/syntax errors
and repeat until the missing module is the sole failure.

### Task 2: Implement the bounded compatibility converter and verify GREEN

**Files:**
- Create: `src/protocol/legacy-capability-descriptor.ts`

- [ ] **Step 1: Define the additive compatibility API**

Define the frozen tuple, its derived union, and a content-free error:

```ts
export const LEGACY_CAPABILITY_IDS = Object.freeze([
  "approvals", "branch_rows", "edit_fragments", "sidechains",
  "token_usage", "tool_timestamps",
] as const);
export type LegacyCapabilityId = typeof LEGACY_CAPABILITY_IDS[number];
export class LegacyCapabilityValidationError extends TypeError {
  readonly code = "invalid_legacy_capabilities" as const;
}
```

- [ ] **Step 2: Validate an ordinary bounded dense array**

Reject proxies before `Array.isArray`, require `Array.prototype`, inspect the
own `length` descriptor and reject lengths over six before collecting all
descriptors, then require exactly one enumerable data property per index and
no other own keys. Validate exact string membership and uniqueness without
including rejected values in the error.

- [ ] **Step 3: Construct and revalidate all six declarations**

Map the fixed tuple to declarations shaped as follows, using
`CAPABILITY_DESCRIPTOR_VERSION` for the exact version:

```ts
const presentDeclaration = {
  id: `ccprof.dev/capabilities/${legacyId}`,
  legacy_id: legacyId,
  version: CAPABILITY_DESCRIPTOR_VERSION,
  requirement: "optional",
  state: "supported_partial",
  evidence: { quality: "unknown", provenance: "adapter_declared" },
  timestamp_precision:
    legacyId === "tool_timestamps" ? "unknown" : "not_applicable",
};
```

Use `unsupported`, `none`, `adapter_declared`, and `not_applicable` for absent
entries. Build the root with the four runtime constants and return
`validateCapabilityDescriptor(root)` so no caller-owned reference survives.

- [ ] **Step 4: Delegate focused GREEN**

Delegate this exact command to a fresh `gpt-5.6-terra` worker:

```sh
npm ci && npm run build:test && node --test \
  .test-dist/test/legacy-capability-descriptor.test.js \
  .test-dist/test/capability-descriptor-runtime.test.js \
  .test-dist/test/capability-descriptor-schema.test.js
```

Expected: every focused test passes with zero failures, skips, or warnings.

### Task 3: Verify scope, review, and publish the PR

**Files:**
- Review and stage exactly the two implementation/test files and both
  `docs/superpowers/` documents named by this plan.

- [ ] **Step 1: Delegate fresh full verification**

Delegate `npm ci && npm run check` to a fresh `gpt-5.6-terra` worker and record
the exact pass/fail/skipped counts and warnings.

- [ ] **Step 2: Inspect scope without running verification locally**

Inspect `git diff --check`, `git diff --stat`, the complete diff, and production
line count. Confirm at most four files change, production additions stay below
300 lines, and no shared signature, schema, package export, session, source,
rule, storage, or migration file changes.

- [ ] **Step 3: Commit and conduct ordered reviews**

Stage the four files explicitly and commit normally as
`feat(protocol): convert legacy capabilities to descriptors`, without amend or
`--no-verify`. Dispatch a fresh spec reviewer first; after approval, dispatch a
fresh code-quality reviewer. Reproduce each functional issue with a failing
test before fixing it in a new commit, and request re-review.

- [ ] **Step 4: Run local Actions and open the PR**

Use `run-github-actions-locally` through `gpt-5.6-terra` workers. After every
locally executable workflow is green, push the exact reviewed head, create a
Ready PR against the default branch, and monitor all expected remote checks,
unresolved review threads, and mergeability until the exact head is
`MERGE_READY`. Do not merge or clean up until the root orchestrator confirms
the GitHub merge.
