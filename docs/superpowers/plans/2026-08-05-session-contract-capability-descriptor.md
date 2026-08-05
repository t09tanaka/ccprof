# Session Contract Capability Descriptor Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept Capability Descriptor v1 at the `SessionSource` contract boundary while preserving the exact legacy six-token projection consumed by current sessions and rules.

**Architecture:** Extend only the unvalidated source-contract input type, then normalize all three accepted input forms inside `src/sources/session-source.ts`. Existing hostile-object inspection remains the single outer boundary; the existing descriptor runtime and legacy converter own nested validation, while a local canonicalizer sorts validated declarations and a capability/evidence support projection supplies the old array.

**Tech Stack:** TypeScript 5.9, Node.js 24, `node:util`, Node built-in test runner, Capability Descriptor v1 runtime, legacy capability converter, `ts-rename-helper` semantic planning.

---

### Task 1: Specify the normalized source-contract behavior and verify RED

**Files:**
- Create: `test/session-source-capability-descriptor.test.ts`
- Modify: `test/session-source-contract.test.ts`

- [ ] **Step 1: Add focused descriptor builders and source assertions**

Create an ordinary descriptor builder from
`legacyCapabilitiesToDescriptor(["approvals"])`, copying validated data into
fresh ordinary objects so declaration order, state, and hostile descriptors can
be varied without mutating frozen fixtures. Create a minimal source whose
`discover` method returns an empty array, plus an assertion that checks the
stable `SessionSourceValidationError` name, `invalid_capability` code, fixed
message, and absence of a secret canary.

The wished-for normalized shape must be accessed through a local structural
cast during RED so the test compiles before the shared type is changed:

```ts
type NormalizedContractProbe = {
  readonly capabilities: readonly SessionCapability[];
  readonly capability_descriptor: CapabilityDescriptorV1;
};

const normalized = validateSessionSource(source({
  adapter_id: "claude",
  adapter_version: "1.0.0",
  capabilities: ["approvals"],
})).contract as unknown as NormalizedContractProbe;

assert.deepEqual(normalized.capabilities, ["approvals"]);
assert.deepEqual(
  normalized.capability_descriptor,
  legacyCapabilitiesToDescriptor(["approvals"]),
);
```

- [ ] **Step 2: Cover the three input paths and compatibility agreement**

Add independent tests for:

- legacy-only conversion;
- descriptor-only projection from supported exact / estimated / partial
  namespaced declarations;
- a consistent dual input;
- inconsistent dual inputs, including a legacy token whose descriptor state is
  `unsupported` or `unknown`; and
- a descriptor with only a valid non-legacy declaration, which preserves that
  declaration and produces an empty legacy projection.

Use exact version `1.0.0` for declarations that must project. Assert a
range-only or differently versioned legacy identity does not project, matching
the existing `supportsCapability` contract rather than adding range parsing.

- [ ] **Step 3: Cover canonicalization, immutability, and hostile values**

Construct equivalent descriptors with reversed declaration order and assert
their normalized descriptors serialize identically in ID order. Mutate every
caller-owned mutable array/object after validation and assert the normalized
graph is unchanged. Check `Object.isFrozen` on the contract, both arrays, root
descriptor, every declaration, and every evidence object. Validate the already
normalized source again and assert semantic equality with a distinct detached
contract graph.

Cover descriptor root/nested Proxy, revoked Proxy, accessor, unknown field,
duplicate ID, and malformed state/evidence inputs. Count proxy traps/getter
reads and assert zero. Cover neither representation, present-but-undefined
representations, invalid/duplicate/noncanonical legacy arrays, and dual
mismatch. Every case must produce only the fixed source validation error.

- [ ] **Step 4: Update built-in parity expectations**

In the existing built-in contract test, retain all legacy assertions and add
`capability_descriptor` to the exact enumerable key list. Assert Claude and
Codex descriptors equal `legacyCapabilitiesToDescriptor` of their existing
arrays, are deeply frozen, and validated built-ins preserve their canonical
adapter IDs plus both capability forms.

- [ ] **Step 5: Delegate focused RED**

Delegate to a fresh `gpt-5.6-terra` worker under Node 24:

```sh
npm ci
node ./node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test \
  .test-dist/test/session-source-capability-descriptor.test.js \
  .test-dist/test/session-source-contract.test.js
```

Expected: TypeScript compilation succeeds and the focused runtime tests fail
only because validated and built-in contracts do not yet expose
`capability_descriptor` or accept descriptor-only input. Test syntax/type
failures must be fixed while production remains unchanged, then RED repeated.

### Task 2: Normalize Capability Descriptor v1 at the source boundary

**Files:**
- Modify: `src/sources/session-source.ts`

- [ ] **Step 1: Add the additive input and normalized output types**

Import `CapabilityDescriptorV1`, the descriptor version constant, validator,
and support query, plus `LEGACY_CAPABILITY_IDS` and the legacy converter. Keep
the source input structurally compatible and make the normalized guarantee
explicit:

```ts
export interface SessionSourceContract {
  adapter_id: SourceAdapterId;
  adapter_version: SourceAdapterVersion;
  capabilities?: readonly SessionCapability[];
  capability_descriptor?: CapabilityDescriptorV1;
}

export interface NormalizedSessionSourceContract {
  adapter_id: SourceAdapterId;
  adapter_version: SourceAdapterVersion;
  capabilities: readonly SessionCapability[];
  capability_descriptor: CapabilityDescriptorV1;
}

export interface ValidatedSessionSource extends SessionSource {
  readonly contract: NormalizedSessionSourceContract;
}
```

Change `validateSessionSource` to return `ValidatedSessionSource`, and change
only internal helpers that consume an already validated contract to accept the
normalized type.

- [ ] **Step 2: Canonicalize and project validated descriptors**

Add a content-free wrapper that catches descriptor/converter failures and calls
`fail("invalid_capability")`. Canonicalization must validate, sort the unique
declarations by `id`, reconstruct the five root fields explicitly, and validate
again:

```ts
function canonicalCapabilityDescriptor(value: unknown): CapabilityDescriptorV1 {
  try {
    const descriptor = validateCapabilityDescriptor(value);
    return validateCapabilityDescriptor({
      $schema: descriptor.$schema,
      schema_version: descriptor.schema_version,
      descriptor_version: descriptor.descriptor_version,
      undeclared_capability_state: descriptor.undeclared_capability_state,
      capabilities: [...descriptor.capabilities].sort((left, right) =>
        compareCodeUnits(left.id, right.id)),
    });
  } catch {
    return fail("invalid_capability");
  }
}
```

Build the compatibility projection by iterating `LEGACY_CAPABILITY_IDS` and
calling the existing support query with the stable namespaced identity:

```ts
supportsCapability(descriptor, {
  id: `ccprof.dev/capabilities/${legacyId}`,
  version: CAPABILITY_DESCRIPTOR_VERSION,
});
```

Freeze the resulting array. Never inspect `adapter_id` in this projection.

- [ ] **Step 3: Normalize legacy-only, descriptor-only, and dual contracts**

Allow exactly `adapter_id`, `adapter_version`, `capabilities`, and
`capability_descriptor`; keep the two identity fields required and require at
least one capability representation at runtime. Validate every present field
from its captured own data-property descriptor.

For legacy-only input, preserve the existing canonical-array validation and
convert it. For descriptor-only input, canonicalize then project. For dual
input, do both and compare the sorted arrays element by element; mismatch calls
`fail("invalid_capability")`. Return a fresh frozen object with keys in this
order: `adapter_id`, `adapter_version`, `capabilities`,
`capability_descriptor`.

- [ ] **Step 4: Make built-ins descriptor-backed without changing discovery**

Update `makeContract` to return `NormalizedSessionSourceContract`, retain the
same sorted legacy arrays, and populate the descriptor with
`legacyCapabilitiesToDescriptor`. Do not change Claude/Codex discovery,
`Session`, doctor rendering, rules, source descriptor/report code, exports,
schemas, or storage.

- [ ] **Step 5: Delegate focused GREEN and fresh full verification**

First delegate under Node 24:

```sh
npm ci
node ./node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test \
  .test-dist/test/session-source-capability-descriptor.test.js \
  .test-dist/test/session-source-contract.test.js \
  .test-dist/test/capability-descriptor-runtime.test.js \
  .test-dist/test/legacy-capability-descriptor.test.js
```

Then delegate a fresh full run:

```sh
npm ci
npm run check
```

Record runtime versions, exit codes, exact pass/fail/skipped counts, diagnostics,
and warnings. Verification workers must not edit tracked files.

### Task 3: Review, verify local Actions, and publish the Ready PR

**Files:**
- Review and stage exactly `src/sources/session-source.ts`, both affected test
  files, and the two committed `docs/superpowers/` documents.

- [ ] **Step 1: Audit scope and commit implementation**

Inspect the complete diff, `git diff --check`, changed-file count, and production
changed-line count without running verification locally. Confirm no more than
five files differ from `origin/main` and production changes stay below 300
lines. Commit tests and implementation normally without amend or
`--no-verify`.

- [ ] **Step 2: Conduct ordered independent reviews**

Dispatch a fresh spec-compliance reviewer with the complete requirements and
exact base/head. Only after a `✅ Spec compliant` result, dispatch a fresh code-
quality reviewer. Any functional issue must receive a regression RED before a
new fix commit, followed by focused/full delegated GREEN and re-review. Do not
fix pre-existing or adjacent issues.

- [ ] **Step 3: Delegate locally executable GitHub Actions**

Use `run-github-actions-locally`: first a `gpt-5.6-terra` worker enumerates
workflow units from the exact branch diff, then fresh terra workers run the
locally executable units in the required dependency order. Treat GitHub-only
actions as documented skips, not passes. Push only after all executable steps
are green and the worktree is clean.

- [ ] **Step 4: Create and monitor the Ready PR**

Push the exact reviewed branch, create a non-draft PR against `main` using a
temporary body file, and include impact, scope deferrals, delegated test
evidence, reviews, and local Actions results. Monitor the expected 15 checks,
unresolved review threads, exact head SHA, and mergeability. Report
`MERGE_READY` only when all checks are successful, threads are zero, and the
exact head is `CLEAN`; do not merge or clean up until the root orchestrator
confirms the GitHub merge.
