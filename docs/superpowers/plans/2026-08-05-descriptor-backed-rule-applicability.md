# Descriptor-Backed Rule Applicability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove adapter allow-lists from rule manifests and make required rule and branch-row evidence depend on the intersection of a validated capability descriptor and the per-session legacy capability subset.

**Architecture:** Keep the closed R001-R008 manifest catalog but remove its source field, centralize fail-closed descriptor/subset checks in `src/rules/capabilities.ts`, and reuse that predicate in the existing branch-transition scan. Preserve all Report v2, Store, identity, and boundary contracts while allowing already normalized namespaced dummy sessions to supply valid neutral evidence.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, Node built-in test runner, Capability Descriptor v1 protocol helpers, Git, fresh `gpt-5.6-terra` verification workers.

---

## Execution roles and file map

This agent is the sole editor and commits every production, test, and document
change. It never executes a test, lint, typecheck, build, or local Actions
command. At every RED and GREEN step, the controller launches a fresh
`gpt-5.6-terra` worker to run the exact command and return the output. No
production step begins until that fresh worker reports a genuine RED caused by
the behavior under test.

- `src/rules/manifest.ts`: remove `supported_sources` from the type, closed
  validator, catalog, clone/freeze path, and public projections.
- `src/rules/capabilities.ts`: require validated descriptor support and the
  explicit session subset for load-bearing legacy capabilities.
- `src/core/analyze.ts`: replace Claude adapter matching with `branch_rows`
  capability gating while retaining all event/window boundaries.
- `test/rule-manifest.cases.ts`: exact manifest/catalog/API/CLI shape and old
  field rejection.
- `test/capability-coverage.test.ts`: coverage, lanes, missing legacy tokens,
  empty inputs, and supported/fail-closed matrices.
- `test/session-source-contract.test.ts`: canonical Claude integration fixture
  with explicit subset and matching descriptor evidence.
- `test/analysis-window.test.ts`: source-neutral branch-transition behavior and
  unchanged branch/epoch/time/anchor constraints.
- `test/model.test.ts`: descriptor/subset intersection matrix, including dummy
  namespaced sources and legacy partial plus unknown quality.
- `docs/superpowers/specs/2026-08-05-descriptor-backed-rule-applicability-design.md`:
  approved architecture and compatibility contract.
- `docs/superpowers/plans/2026-08-05-descriptor-backed-rule-applicability.md`:
  this executable three-cycle TDD plan.

### Task 1: Remove source allow-lists from rule manifests

**Files:**
- Modify: `test/rule-manifest.cases.ts`
- Modify: `src/rules/manifest.ts`

- [ ] **Step 1: Write the failing manifest shape tests**

Remove the `SOURCES` fixture and every `supported_sources` property from the
typed `EXPECTED` catalog. Remove it from `FIELDS` and immutability/accessor
cases. Replace source-list validation cases with one explicit closed-shape
regression:

```ts
test("manifest validation rejects the removed supported_sources field", () => {
  manifestError(invalid((value) => {
    value[0]!.supported_sources = ["claude", "codex"];
  }), "unknown_field", 0, "supported_sources");
});
```

Keep the exact list/lookup assertions and `ccprof rules list` / `ccprof rules
explain` scenarios pointed at `EXPECTED`. Those assertions prove the catalog,
public API, report policy, and CLI JSON all omit the field.

- [ ] **Step 2: Delegate focused RED to a fresh Terra worker**

Run:

```sh
npm run build:test
```

Expected: FAIL in TypeScript because the existing `RuleManifest` still
requires `supported_sources`, and/or the old catalog/API output disagrees with
the new exact expectations. The failure must be attributable only to the
unremoved production field, not a test syntax or fixture error.

- [ ] **Step 3: Implement the minimal manifest removal**

Delete the source type import, interface property, validation code, and catalog
projection. The resulting shape is:

```ts
export interface RuleManifest {
  id: RuleId;
  version: string;
  compatibility_epoch: number;
  required_capabilities: SessionCapability[];
  impact_kind: "critical_path_latency" | "resource_cost" |
    "policy_latency" | "evidence_only";
  default_mode: "enabled" | "observe_only" | "disabled";
  aggregation_policy: "sum" | "union" | "max" | "never_aggregate";
  evidence_schema: string;
  policy_risk: "low" | "medium" | "high";
}
```

Remove `invalid_source` from `ValidationCode`, remove `supported_sources` from
`FIELDS`, delete source constants, omit the field from `RAW_CATALOG`, and stop
validating/freezing/cloning it. Leave `FIELD_SET` closed so old-shaped input
returns `unknown_field`.

- [ ] **Step 4: Delegate focused GREEN to a fresh Terra worker**

Run:

```sh
npm run build:test && node --test .test-dist/test/capability-coverage.test.js
```

Expected: PASS for compilation and all tests in the focused file, including
the imported manifest cases; CLI stdout contains the nine-field manifest and
the validator rejects `supported_sources` as `unknown_field`.

- [ ] **Step 5: Commit the manifest cycle**

```sh
git add src/rules/manifest.ts test/rule-manifest.cases.ts
git commit -m "refactor: remove rule source allow lists"
```

### Task 2: Gate rule applicability on descriptor and session evidence

**Files:**
- Modify: `test/capability-coverage.test.ts`
- Modify: `test/model.test.ts`
- Modify: `src/rules/capabilities.ts`

- [ ] **Step 1: Add descriptor-backed session fixtures**

In applicability tests, construct descriptor evidence with the existing
protocol constants and validator. Each required legacy token maps to a
namespaced declaration at Capability Descriptor v1 version `1.0.0`:

```ts
function descriptorFor(
  capability: SessionCapability,
  state: "supported_exact" | "supported_estimated" | "supported_partial",
): CapabilityDescriptorV1 {
  const quality = state === "supported_exact" ? "exact" :
    state === "supported_estimated" ? "estimated" : "partial";
  return validateCapabilityDescriptor({
    $schema: CAPABILITY_DESCRIPTOR_SCHEMA_ID,
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    descriptor_version: CAPABILITY_DESCRIPTOR_VERSION,
    undeclared_capability_state: CAPABILITY_UNDECLARED_STATE,
    capabilities: [{
      id: `ccprof.dev/capabilities/${capability}`,
      version: CAPABILITY_DESCRIPTOR_VERSION,
      requirement: "optional",
      state,
      evidence: { quality, provenance: "adapter_declared" },
      timestamp_precision: "not_applicable",
    }],
  });
}
```

Use `legacyCapabilitiesToDescriptor` for the built-in-compatible
`supported_partial` plus quality `unknown` case so the exact current
projection remains covered.

- [ ] **Step 2: Write the failing intersection and fail-closed tests**

For R001/R005/R007, assert a required capability passes only when the session
has both the token and valid matching descriptor support. Table-drive cases
for missing descriptor, missing subset, missing token, undeclared capability,
`unknown`, `unsupported`, wrong version/range, and invalid descriptor/evidence
tuples. Include all valid exact, estimated, partial, and legacy
partial/unknown declarations. A representative assertion is:

```ts
assert.equal(sessionSupportsRule({
  ...baseSession,
  capabilities: ["token_usage"],
  capability_descriptor: descriptorFor("token_usage", "supported_exact"),
}, "R007"), true);

assert.equal(sessionSupportsRule({
  ...baseSession,
  capabilities: ["token_usage"],
}, "R007"), false);
```

Assert rules with no requirements remain applicable without either field.
Assert `ruleCoverage([])` remains full and finite. Assert coverage
`missing_capabilities` contains only sorted legacy tokens such as
`edit_fragments`, `token_usage`, and `tool_timestamps`, never namespaced IDs.
Update capability-coverage fixtures that represent full or limited normalized
sessions so they carry both an explicit subset and the source-wide descriptor.

- [ ] **Step 3: Prove supported states and source-neutral applicability**

Assert in `test/model.test.ts` that valid exact, estimated, partial, and legacy
partial/unknown descriptor states support the matching rule only with the
session subset. Use a valid namespaced dummy source-shaped `Session` directly;
this does not call or weaken `validateSessionSource` admission. Also cover an
absent subset, absent descriptor, undeclared capability, unknown state,
unsupported state, and an invalid state/evidence tuple. Every fail-closed
fixture must still support requirement-empty R002.

```ts
assert.equal(sessionSupportsRule(dummySession, "R007"), true);
assert.equal(sessionSupportsRule(withoutDescriptor, "R007"), false);
assert.equal(sessionSupportsRule(withoutDescriptor, "R002"), true);
```

TDD history: this matrix first ran in
`test/session-source-capability-descriptor.test.ts` and produced the genuine
three-assertion applicability RED. Before final GREEN it is relocated to
`test/model.test.ts` with the same real `Session` behavior so the descriptor
integration file can return exactly to `origin/main` and the final scope stays
at ten files.

- [ ] **Step 4: Delegate focused RED to a fresh Terra worker**

Run:

```sh
npm run build:test && node --test \
  .test-dist/test/model.test.js \
  .test-dist/test/capability-coverage.test.js \
  .test-dist/test/session-source-capability-descriptor.test.js
```

Expected: FAIL because the current `sessionHasCapability` treats missing
legacy arrays as full support and never validates or queries
`capability_descriptor`. Valid descriptor-only, subset-only denial, and
invalid-tuple denial expectations expose that behavior. Required-empty and
empty-session regressions should already pass.

- [ ] **Step 5: Implement the minimal descriptor/subset intersection**

Import `CAPABILITY_DESCRIPTOR_VERSION` and `supportsCapability`. Replace the
permissive helper with a fail-closed predicate:

```ts
function sessionHasCapability(
  session: Session,
  capability: SessionCapability,
): boolean {
  return session.capabilities?.includes(capability) === true &&
    session.capability_descriptor !== undefined &&
    supportsCapability(session.capability_descriptor, {
      id: `ccprof.dev/capabilities/${capability}`,
      version: CAPABILITY_DESCRIPTOR_VERSION,
    });
}
```

Do not special-case adapter IDs or supported states. The protocol helper
revalidates the complete descriptor and returns false on undeclared,
unsupported, unknown, version-mismatched, or malformed inputs. Keep
`sessionSupportsRule` as `every`, preserving the empty-requirement result.
Keep `ruleCoverage`'s public missing list derived from legacy requirements.

- [ ] **Step 6: Delegate focused GREEN to a fresh Terra worker**

Run:

```sh
npm run build:test && node --test \
  .test-dist/test/model.test.js \
  .test-dist/test/capability-coverage.test.js \
  .test-dist/test/session-source-capability-descriptor.test.js
```

Expected: PASS. All intersection, fail-closed, supported-state,
legacy-partial/unknown, required-empty, empty-input, lane, and legacy missing
token assertions are green with no warnings or errors.

- [ ] **Step 7: Commit the applicability cycle**

```sh
git add src/rules/capabilities.ts test/capability-coverage.test.ts \
  test/model.test.ts
git commit -m "feat: gate rules on descriptor evidence"
```

### Task 3: Make branch transition capability-based and source-neutral

**Files:**
- Modify: `test/analysis-window.test.ts`
- Modify: `src/core/analyze.ts`

- [ ] **Step 1: Write the failing source-neutral branch tests**

Update the transition fixture so sessions that should contribute branch rows
carry both `branch_rows` and a valid descriptor declaration. Add a namespaced
dummy producer session with valid evidence and assert its positive-epoch head
branch event is selected. Add a Claude session with the same event but missing
the subset, descriptor, or declaration and assert it is ignored.

```ts
assert.equal(deriveSessionBranchTransitionAtMs([
  make("dummy", "dummy.example/source", [event("first", 200)], {
    capabilities: ["branch_rows"],
    capability_descriptor: legacyCapabilitiesToDescriptor(["branch_rows"]),
  }),
], "feature", 1_000, 400), 200);

assert.equal(deriveSessionBranchTransitionAtMs([
  make("claude-no-rows", "claude", [event("first", 200)]),
], "feature", 1_000, 400), undefined);
```

Keep explicit assertions for branch mismatch, epoch zero, re-entry, event
before/after candidate ordering, analysis end, and commit anchor. In the
descriptor integration file, add the equivalent normalized dummy fixture to
show namespaced source-shaped data works without external source admission.

- [ ] **Step 2: Delegate focused RED to a fresh Terra worker**

Run:

```sh
npm run build:test && node --test \
  .test-dist/test/analysis-window.test.js
```

Expected: FAIL because the current branch candidate condition explicitly
matches the `claude` adapter ID. It rejects the valid dummy session and accepts
Claude rows without descriptor-backed `branch_rows` evidence.

- [ ] **Step 3: Replace the adapter branch with capability gating**

Export a narrowly named shared predicate from `src/rules/capabilities.ts` and
use it in `src/core/analyze.ts`. The candidate condition becomes:

```ts
if (
  sessionHasCapabilityEvidence(session, "branch_rows") &&
  event.branch === headBranch &&
  Number.isSafeInteger(event.branch_epoch) &&
  (event.branch_epoch ?? 0) > 0 &&
  (earliestUniqueCommitAtMs === undefined ||
    timestampMs <= earliestUniqueCommitAtMs)
) {
  earliestCandidateAtMs = Math.min(
    earliestCandidateAtMs ?? Number.POSITIVE_INFINITY,
    timestampMs,
  );
}
```

Remove only the Claude ID match. Do not change timestamp validation,
`earliestEventAtMs`, branch equality, positive epoch, analysis end, commit
anchor, re-entry conservatism, or the final earliest-event comparison.

- [ ] **Step 4: Delegate focused GREEN to a fresh Terra worker**

Run:

```sh
npm run build:test && node --test \
  .test-dist/test/analysis-window.test.js
```

Expected: PASS. The dummy source supplies a transition, Claude without
descriptor-backed evidence does not, and every existing branch/epoch/time/
commit-anchor boundary remains green.

- [ ] **Step 5: Commit the branch cycle**

```sh
git add src/core/analyze.ts test/analysis-window.test.ts
git commit -m "refactor: gate branch rows by capability"
```

### Task 4: Reconcile the canonical integration fixture and verify

**Files:**
- Modify: `test/session-source-contract.test.ts`
- Verify: the exact ten files listed in the file map

- [ ] **Step 1: Record the first full-repository RED**

Run:

```sh
npm run check
```

Observed: typecheck passed and 1,198 of 1,199 tests passed. The sole failure was
`canonical Claude sessions retain transition, hook, and verified-tail
semantics`: its `richSession()` fixture declared the all-capabilities legacy
subset but omitted the descriptor now required by the shared `branch_rows`
predicate. This is a genuine canonical integration-fixture RED; production
must not add a Claude fallback.

- [ ] **Step 2: Add matching descriptor evidence to the canonical fixture**

Keep the existing explicit subset and add the already imported legacy
descriptor conversion directly after it:

```ts
capabilities: [...ALL_CAPABILITIES],
capability_descriptor: legacyCapabilitiesToDescriptor(ALL_CAPABILITIES),
```

Do not alter the transition assertion. Relocate the earlier applicability
matrix from `test/session-source-capability-descriptor.test.ts` to
`test/model.test.ts`, then restore the descriptor integration file exactly to
`origin/main`. This preserves the genuine RED behavior and keeps the final
change set at ten files.

- [ ] **Step 3: Delegate final full GREEN to a fresh Terra worker**

Run:

```sh
npm run check
```

Expected: PASS with clean TypeScript diagnostics and all 1,199 repository tests
passing. Output contains no failures, warnings, or unexpected skips.

- [ ] **Step 4: Delegate local GitHub Actions verification before push**

Run the repository's `/run-github-actions-locally` workflow through a fresh
`gpt-5.6-terra` worker. It must identify the workflows affected by the changed
TypeScript and test files and execute their local equivalents.

Expected: GREEN for every applicable local job. A remote job that terminates
within five seconds solely for account payment or spending-limit annotations
does not override these local GREEN results.

- [ ] **Step 5: Audit scope and compatibility without editing**

Run:

```sh
git diff --stat ca46dbe1e2df380059e2c1d0c47921d717732dda...HEAD
git diff --name-only ca46dbe1e2df380059e2c1d0c47921d717732dda...HEAD
git diff --numstat ca46dbe1e2df380059e2c1d0c47921d717732dda...HEAD -- \
  src/rules/manifest.ts src/rules/capabilities.ts src/core/analyze.ts
```

Expected: exactly the ten allowed paths or fewer, exactly three production
files, fewer than 300 changed production lines, and no changes to SessionSource,
Source Descriptor, report schemas, Store, or package SDK. Confirm Report v2
`missing_capabilities` remains legacy tokens and no report/store digest or
fingerprint implementation changed.
