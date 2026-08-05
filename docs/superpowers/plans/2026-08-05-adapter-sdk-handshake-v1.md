# Adapter SDK Handshake v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a compatibility-preserving `ccprof/adapter-sdk` subpath with
the JSON-RPC 2.0 initialize, capability-negotiation, and acknowledged-shutdown
type contract v1.

**Architecture:** Add one type-only protocol module plus a curated facade over
the existing source-identity and capability-descriptor contracts. Add a narrow
package export and extend the installed-tarball smoke without connecting the
SDK to any runtime adapter or process host.

**Tech Stack:** TypeScript 5.9 with NodeNext declarations, Node.js 22/24,
Node's built-in test runner, npm pack/install, GitHub Actions.

---

All lint, typecheck, test, build, and local-Actions commands in this plan are
run by a fresh `gpt-5.6-terra` verification agent. The single implementation
agent edits files but never runs those commands. The orchestration agent makes
no production/test/doc edits.

### Task 1: Establish the approved contract and RED tests

**Files:**
- Create: `docs/superpowers/specs/2026-08-05-adapter-sdk-handshake-v1-design.md`
- Create: `docs/superpowers/plans/2026-08-05-adapter-sdk-handshake-v1.md`
- Create: `docs/adapter-sdk.md`
- Create: `test/adapter-sdk-protocol.test.ts`
- Modify: `test/ci-workflow.test.ts`

- [x] **Step 1: Record the design and public integration contract**

Document JSON-RPC ID/shape invariants, the exact protocol tuple and methods,
ordered initialization, negotiation reasons, acknowledged shutdown, curated
exports, package compatibility, edge cases, and every deferred Wave 2 area.

- [x] **Step 2: Write compile-time and runtime protocol tests first**

Import the future `../src/adapter-sdk/index.js`. Use `satisfies` and type
equality checks for method-indexed params/results, construct both negotiation
outcomes, and assert the exact frozen version tuple and curated runtime keys.
Use `@ts-expect-error` imports to keep `SessionSource` and `SourceDescriptor`
outside the facade. Assert the future package export map keeps all three
legacy patterns and has no root export.

- [x] **Step 3: Specify installed-package CI behavior before changing CI**

Extend `test/ci-workflow.test.ts` to require pack/prepack, the existing global
CLI install and `--version`/`--help`, a clean local consumer, runtime subpath
import, `.d.ts` compilation, and a legacy `ccprof/dist/...` import.

- [ ] **Step 4: Delegate RED verification**

A fresh `gpt-5.6-terra` runs:

```bash
npm run build:test
```

Expected: exit 2 with TS2307 for
`../src/adapter-sdk/index.js`. Correct any test-only errors and repeat with a
new verification agent until the missing future module is the only cause.

### Task 2: Implement the minimal protocol and curated facade

**Files:**
- Create: `src/adapter-sdk/protocol.ts`
- Create: `src/adapter-sdk/index.ts`
- Test: `test/adapter-sdk-protocol.test.ts`

- [x] **Step 1: Add JSON-RPC and lifecycle types**

Define string/number ID aliases with documented safe-integer rules; readonly
request, notification, success, failure, error, and response shapes; and the
frozen tuple:

```ts
export const ADAPTER_PROTOCOL_VERSIONS = Object.freeze(["1.0.0"] as const);
export type AdapterProtocolVersion =
  typeof ADAPTER_PROTOCOL_VERSIONS[number];
```

Define initialize params/result, required/optional negotiation params,
accepted/rejected results with non-empty unavailable-required details, and
empty shutdown params plus `{ readonly acknowledged: true }`.

- [x] **Step 2: Add the exact method map and correlated generics**

```ts
export interface AdapterRpcMethodMap {
  readonly initialize: {
    readonly params: AdapterInitializeParams;
    readonly result: AdapterInitializeResult;
  };
  readonly negotiateCapabilities: {
    readonly params: AdapterNegotiateCapabilitiesParams;
    readonly result: AdapterNegotiateCapabilitiesResult;
  };
  readonly shutdown: {
    readonly params: AdapterShutdownParams;
    readonly result: AdapterShutdownResult;
  };
}
```

Use a distributive conditional for `AdapterRpcRequest<M>` so a union of
methods remains a correlated union rather than mixing another method's params.
Map `AdapterRpcResponse<M, ErrorData>` to the selected method result.

- [x] **Step 3: Create the curated entry point**

Export all local protocol symbols, then explicitly re-export only
`SourceAdapterId`, `parseSourceAdapterId`, `CapabilityDescriptorV1`,
`CapabilitySupportQuery`, `validateCapabilityDescriptor`, and
`supportsCapability` from existing modules. Use `.js` NodeNext specifiers.

- [ ] **Step 4: Delegate compiled focused verification**

A fresh `gpt-5.6-terra` runs:

```bash
npm run build:test
node --test .test-dist/test/adapter-sdk-protocol.test.js
```

Expected after only this task: compilation succeeds; the focused test reports
the still-missing package export map. Do not weaken that package assertion.

### Task 3: Publish and smoke the npm subpath

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Test: `test/adapter-sdk-protocol.test.ts`
- Test: `test/ci-workflow.test.ts`

- [x] **Step 1: Add a compatibility-preserving export map**

Add exactly:

```json
"exports": {
  "./adapter-sdk": {
    "types": "./dist/adapter-sdk/index.d.ts",
    "import": "./dist/adapter-sdk/index.js"
  },
  "./dist/*": "./dist/*",
  "./schemas/*": "./schemas/*",
  "./package.json": "./package.json"
}
```

Do not add `"."`, change `bin`, `files`, `prepack`, dependencies, or
`package-lock.json`.

- [x] **Step 2: Extend the existing package-smoke script**

Keep every current CLI/schema/stats assertion. After `npm pack`, install the
same tarball into `$RUNNER_TEMP/ccprof-consumer`, dynamic-import
`ccprof/adapter-sdk`, compile `adapter-sdk-smoke.mts` with the checkout's
TypeScript binary and NodeNext resolution, and dynamic-import
`ccprof/dist/protocol/capability-descriptor.js`.

- [ ] **Step 3: Delegate focused GREEN verification**

A fresh `gpt-5.6-terra` runs:

```bash
npm run build:test
node --test .test-dist/test/adapter-sdk-protocol.test.js \
  .test-dist/test/ci-workflow.test.js
```

Expected: both compiled test files pass with zero warnings or failures.

### Task 4: Review and verify the exact scope

**Files:** Review exactly the nine files listed in Tasks 1-3.

- [ ] **Step 1: Self-review edge cases and scope**

Inspect the diff without running test commands. Confirm at most nine files,
at most 300 production lines in the two SDK files, no package-lock change, no
root export, and no model/session/source-descriptor/analyze/Store/built-in or
dummy-agent change.

- [ ] **Step 2: Specification review first**

Dispatch a fresh spec reviewer with the approved contract and exact diff. The
same implementation agent fixes every omission or extra behavior; repeat spec
review until approved.

- [ ] **Step 3: Code-quality review second**

Only after spec approval, dispatch a fresh code-quality reviewer. The same
implementation agent fixes Critical/Important issues introduced by this PR;
repeat review until approved.

- [ ] **Step 4: Delegate full local verification**

Use fresh `gpt-5.6-terra` agents for each command, including the repository's
`/run-github-actions-locally` workflow. Required evidence includes:

```bash
npm run typecheck
npm test
npm run check
git diff --check
```

The verification agent also reproduces package pack/install/import/declaration
smoke in a temporary consumer. No verification agent edits files.

### Task 5: Ready PR and merge-ready hold

- [ ] Commit all nine scoped files normally, including both
  `docs/superpowers` documents; never amend and never use `--no-verify`.
- [ ] Fetch/rebase latest `origin/main`, then delegate affected verification
  again if HEAD changes.
- [ ] Push `feature/adapter-sdk-handshake-v1` and open a ready PR to `main`.
- [ ] Monitor every remote check to green and resolve all review threads;
  repeat spec review before code-quality review after any substantive fix.
- [ ] Report `MERGE_READY` with the exact PR head SHA and wait for an exact-head
  merge instruction. Do not merge and do not clean up the worktree or branch.
