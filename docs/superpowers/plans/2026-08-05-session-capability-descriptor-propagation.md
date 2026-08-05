# Session Capability Descriptor Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry each validated source contract's canonical Capability Descriptor v1 onto normalized sessions while preserving every legacy rule, report, store, and audit identity behavior.

**Architecture:** Keep raw `Session` and `SessionSource` inputs backward compatible, introduce a required `NormalizedSession` output contract at the validator boundary, and attach or compare the already canonical source descriptor during discovery. Explicitly project descriptor metadata out of the legacy source snapshot so current deterministic identities remain unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, Node built-in test runner, Capability Descriptor v1 runtime, `ts-rename-helper`, GitHub Actions.

---

### Task 1: Specify normalized-session behavior and prove RED

**Files:**
- Create: `test/session-source-capability-descriptor.test.ts`
- Modify: `test/session-source-contract.test.ts`

- [ ] **Step 1: Add descriptor and source fixtures**

Create ordinary mutable descriptor builders from
`legacyCapabilitiesToDescriptor` and a valid neutral declaration. Build a
minimal raw `SessionSource` whose contract can be legacy-only,
descriptor-only, or consistent dual, and whose discovery returns caller-owned
sessions.

```ts
function withNeutralDescriptor(
  capabilities: readonly SessionCapability[],
): CapabilityDescriptorV1 {
  const legacy = legacyCapabilitiesToDescriptor(capabilities);
  return {
    ...legacy,
    capabilities: [...legacy.capabilities, {
      id: "dummy.example/capabilities/neutral_signal",
      version: CAPABILITY_DESCRIPTOR_VERSION,
      requirement: "optional",
      state: "supported_exact",
      evidence: { quality: "exact", provenance: "producer_declared" },
      timestamp_precision: "not_applicable",
    }],
  };
}
```

- [ ] **Step 2: Test accepted propagation paths**

Assert legacy-only, descriptor-only, and consistent-dual contracts produce
normalized sessions with explicit legacy capabilities and the contract's
descriptor. Cover omitted capabilities, an explicit narrower subset, an
explicit empty subset, unknown neutral declarations, canonical-order
differences, shared descriptor object identity, deep freezing, detachment, and
revalidation.

```ts
const validated = validateSessionSource(source({
  contract: descriptorOnlyContract,
  sessions: [rawSession],
}));
const [normalized] = await validated.discover(QUERY);
assert.equal(normalized?.capability_descriptor,
  validated.contract.capability_descriptor);
assert.deepEqual(normalized?.capabilities, expectedLegacySubset);
```

- [ ] **Step 3: Test fail-closed descriptor comparison**

Supply a per-session descriptor that differs only in each of: neutral
declaration, state/evidence, declaration version, evidence provenance, and root
version. Assert `invalid_capability` with a fixed message and no secret canary.
Cover descriptor root/nested Proxy, revoked Proxy, accessor, and nested hostile
values with zero getter/trap calls. Keep an outer session accessor on the
existing `invalid_result` path.

- [ ] **Step 4: Test transformation and identity compatibility**

Exercise `sliceSessionsToAnalysisWindow` and `admitSessionEventPrefix` with a
normalized session and assert both retain the same frozen descriptor object.
Analyze semantically equal legacy-only and neutral-descriptor sources and
assert equality of `rule_coverage`, rule lanes, report sources, full report,
record, `source_digest`, `snapshot_id`, and deterministic digest.

- [ ] **Step 5: Extend the existing contract regression**

In `test/session-source-contract.test.ts`, add descriptor assertions to the
existing validated-session canonicalization test without removing its legacy
array, adapter identity, immutability, or Source Descriptor v1 assertions.

- [ ] **Step 6: Commit tests and delegate focused RED**

Commit only the two test files after the documentation commit. Delegate to a
fresh `gpt-5.6-terra` worker:

```sh
npm run build:test
node --test \
  .test-dist/test/session-source-capability-descriptor.test.js \
  .test-dist/test/session-source-contract.test.js
```

Expected: compilation or focused runtime tests fail solely because `Session`
and validated discovery do not yet expose `capability_descriptor`. Repair only
test mistakes while production remains unchanged, commit test fixes normally,
and repeat until the RED reason is exact.

### Task 2: Add normalized Session typing and boundary propagation

**Files:**
- Modify: `src/core/model.ts`
- Modify: `src/sources/session-source.ts`

- [ ] **Step 1: Add the additive raw field and normalized subtype**

Import `CapabilityDescriptorV1` as a type. Keep the raw field optional and
make both normalized capability forms required:

```ts
export interface Session {
  // existing fields
  capabilities?: readonly SessionCapability[];
  capability_descriptor?: CapabilityDescriptorV1;
}

export interface NormalizedSession extends Session {
  capabilities: readonly SessionCapability[];
  capability_descriptor: CapabilityDescriptorV1;
}
```

- [ ] **Step 2: Narrow only validated discovery**

Keep `SessionSource.discover(query): Promise<Session[]>`. Import
`NormalizedSession` into `session-source.ts`, override discover on
`ValidatedSessionSource`, and narrow the two validated-discovery helpers:

```ts
export interface ValidatedSessionSource extends SessionSource {
  readonly contract: NormalizedSessionSourceContract;
  discover(query: SessionQuery): Promise<NormalizedSession[]>;
}
```

- [ ] **Step 3: Compare canonical descriptors exactly**

Add a structural comparator for two already validated canonical descriptors.
It must compare the four root identity/version fields, declaration count and
order, and every declaration/evidence field. Do not infer from adapter IDs or
compare only the legacy projection.

```ts
function sameCapabilityDescriptor(
  left: CapabilityDescriptorV1,
  right: CapabilityDescriptorV1,
): boolean {
  return left.$schema === right.$schema &&
    left.schema_version === right.schema_version &&
    left.descriptor_version === right.descriptor_version &&
    left.undeclared_capability_state === right.undeclared_capability_state &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every((entry, index) => {
      const other = right.capabilities[index];
      return other !== undefined && entry.id === other.id &&
        entry.version === other.version &&
        entry.version_range === other.version_range &&
        entry.state === other.state &&
        entry.evidence.quality === other.evidence.quality &&
        entry.evidence.provenance === other.evidence.provenance;
    });
}
```

The production comparator also includes `legacy_id`, `requirement`, and
`timestamp_precision`, which are omitted from this abbreviated illustration
only to keep the plan readable.

- [ ] **Step 4: Normalize each discovered session**

Allow `capability_descriptor` as an optional exact Session field. If present,
canonicalize it with `canonicalCapabilityDescriptor`, compare it with the
normalized contract, and fail `invalid_capability` on any difference. Return:

```ts
{
  // existing detached session fields
  capabilities: Object.freeze([...capabilities]),
  capability_descriptor: contract.capability_descriptor,
}
```

Do not derive a narrower descriptor from a per-session legacy subset. Do not
change event/warning validation, rule gating, or source-evidence cache shapes.

- [ ] **Step 5: Delegate focused and full GREEN**

Delegate a fresh terra worker to run:

```sh
npm run build:test
node --test \
  .test-dist/test/session-source-capability-descriptor.test.js \
  .test-dist/test/session-source-contract.test.js
```

Then delegate a fresh full worker to run `npm run check`. Require clean
TypeScript diagnostics, exact pass/fail counts, no warnings/errors, and a clean
tracked worktree after both runs.

### Task 3: Preserve legacy source snapshot identity

**Files:**
- Modify: `src/core/analyze.ts`

- [ ] **Step 1: Exclude descriptor metadata explicitly**

Change only the source-session destructure:

```ts
const {
  source_path: _sourcePath,
  capability_descriptor: _capabilityDescriptor,
  ...rest
} = session;
```

Keep every subsequent legacy projection unchanged. This ensures descriptor
metadata cannot affect `source_digest`, `snapshot_id`, or persisted analysis
identity.

- [ ] **Step 2: Delegate focused identity GREEN**

Delegate the new focused test plus the existing source contract test. Then
delegate the full repository check again. Do not edit downstream reporters,
stores, rules, or snapshot tests to accommodate changed bytes; changed bytes
would be an implementation defect.

### Task 4: Review, run local Actions, and publish a Ready PR

**Files:**
- Review and stage exactly the three production files, two test files, and two
  unique `docs/superpowers/` files listed by this plan.

- [ ] **Step 1: Audit and commit**

Inspect `git diff --check`, changed-file count, production changed-line count,
and status without running validation in the implementation context. Confirm
no more than seven files and fewer than 300 production LOC. Commit normally;
never amend and never bypass hooks.

- [ ] **Step 2: Rebase before final review**

Fetch `origin/main` and rebase onto its exact latest commit. If the head/base
changes, delegate full verification again. Record exact base and head SHAs.

- [ ] **Step 3: Conduct ordered reviews**

Dispatch an independent spec reviewer first with the exact requirements and
base/head. Only after approval, dispatch an independent quality reviewer. For
each valid functional issue, add a regression test, prove RED with a fresh
terra worker, fix, prove GREEN, commit a new commit, and re-run the affected
review. Reject scope-expanding or pre-existing suggestions with technical
evidence.

- [ ] **Step 4: Run local Actions in two delegated phases**

Use `run-github-actions-locally`: a fresh terra worker first enumerates the
workflow units for the exact branch diff; then fresh terra workers execute the
locally reproducible units in the required grouping/order. Push only when all
executable steps pass and tracked status is clean.

- [ ] **Step 5: Create and monitor the Ready PR**

Push the exact reviewed head, create a non-draft PR against `main`, and include
scope, explicit exclusions, TDD evidence, delegated checks, reviews, and local
Actions. Monitor all expected remote checks; diagnose failures before any
rerun. Report `MERGE_READY` only with exact head/base, all checks successful,
mergeable `CLEAN`, and zero unresolved review threads. Do not merge or clean up
until the root orchestrator confirms the GitHub merge.
