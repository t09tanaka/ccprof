# Custom Session Source Adapter Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require and validate a closed SessionSource adapter contract before discovery so missing or hostile declarations cannot reach analysis.

**Architecture:** Add a data-only adapter contract and one validator/wrapper in the existing session-source module, give Claude and Codex immutable declarations, and make Combined/analyze use validated wrappers. Normalize every newly discovered session to explicit canonical capabilities while retaining undefined compatibility only in legacy pure readers.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, Node built-in test runner, existing source descriptor registry and capability model.

---

### Task 1: Commit the approved design and executable plan

**Files:**
- Create: `docs/superpowers/specs/2026-08-04-custom-source-adapter-contract-design.md`
- Create: `docs/superpowers/plans/2026-08-04-custom-source-adapter-contract.md`

- [x] **Step 1: Self-review the design**

Run a placeholder/contradiction scan and verify that the design chooses one
boundary, lists exact stable errors, keeps production additions under 300
lines, and excludes Store/Report/policy/CLI work.

- [x] **Step 2: Commit the documents**

```bash
git add docs/superpowers/specs/2026-08-04-custom-source-adapter-contract-design.md \
  docs/superpowers/plans/2026-08-04-custom-source-adapter-contract.md
git commit -m "docs: design fail-closed session source contracts"
```

### Task 2: Establish the RED adapter-boundary contract

**Files:**
- Create: `test/session-source-contract.test.ts`

- [x] **Step 1: Write failing public-contract tests**

Import the wished-for API and assert exact contracts and stable errors:

```ts
import {
  CLAUDE_SESSION_SOURCE_CONTRACT,
  CODEX_SESSION_SOURCE_CONTRACT,
  SessionSourceValidationError,
  validateSessionSource,
} from "../src/sources/session-source.js";

assert.deepEqual(CODEX_SESSION_SOURCE_CONTRACT, {
  adapter_id: "codex",
  adapter_version: "1.0.0",
  capabilities: ["edit_fragments", "tool_timestamps"],
});
assert.throws(
  () => validateSessionSource({ discover: async () => [] }),
  (error) => error instanceof SessionSourceValidationError &&
    error.code === "invalid_shape" &&
    error.message === "invalid session source: invalid_shape",
);
```

Cover missing/extra/symbol/hidden/accessor/Proxy declarations, unknown
adapter/version/capability, duplicate/non-canonical capabilities, invalid
discover method, non-array result, adapter mismatch, subset enforcement,
explicit normalization, non-mutation, and canary-free error messages.

- [x] **Step 2: Delegate RED verification**

Run:

```bash
npm run build:test
```

Expected: TypeScript fails only because the new contract exports do not yet
exist. Record the diagnostics and ensure no production code was changed.

- [x] **Step 3: Commit test-only RED**

```bash
git add test/session-source-contract.test.ts
git commit -m "test: require fail-closed session source contracts"
```

### Task 3: Implement the minimal contract validator and wrapper

**Files:**
- Modify: `src/sources/session-source.ts`
- Modify: `src/sources/claude/discover.ts`
- Modify: `src/sources/codex/discover.ts`
- Test: `test/session-source-contract.test.ts`

- [x] **Step 1: Define immutable v2 declarations**

Add the exact public types and constants:

```ts
export interface SessionSourceContract {
  adapter_id: SourceAdapterId;
  adapter_version: SourceAdapterVersion;
  capabilities: readonly SessionCapability[];
}

export interface SessionSource {
  readonly contract: SessionSourceContract;
  discover(query: SessionQuery): Promise<Session[]>;
}
```

Claude receives a frozen canonical copy of all capabilities and Codex receives
the frozen two-capability list.

- [x] **Step 2: Implement data-descriptor validation**

Use `util.types.isProxy`, own property descriptors, an exact three-field set,
plain dense capability arrays, and the existing adapter ID/version vocabulary.
Capture `discover` only from a data descriptor. Convert reflection failures to
`SessionSourceValidationError` without input-derived text.

The validator must follow this shape; helpers may be renamed but may not read
properties through ordinary `value.field` access before validation:

```ts
const CONTRACT_FIELDS = new Set([
  "adapter_id", "adapter_version", "capabilities",
]);

function fail(code: SessionSourceValidationCode): never {
  throw new SessionSourceValidationError(code);
}

function contractDescriptors(value: unknown): PropertyDescriptorMap {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
  ) return fail("invalid_shape");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !CONTRACT_FIELDS.has(key))) {
    return fail("unknown_field");
  }
  if ([...CONTRACT_FIELDS].some((field) => !Object.hasOwn(descriptors, field))) {
    return fail("invalid_shape");
  }
  for (const field of CONTRACT_FIELDS) {
    const descriptor = descriptors[field]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      return fail("invalid_shape");
    }
  }
  return descriptors;
}
```

The capability helper must reject Proxy/sparse/accessor arrays before reading
items, then require known, unique, code-unit-sorted string values. The discover
helper must walk only non-Proxy prototypes and accept only a data-valued
function.

- [x] **Step 3: Wrap and normalize discovery**

Return a frozen source wrapper whose `discover` calls the captured method with
the original receiver, validates a plain result array, rejects adapter
mismatch/contract-exceeding capabilities, and returns fresh sessions with an
explicit sorted capability list.

```ts
export function validateSessionSource(value: unknown): SessionSource {
  const contract = validateSessionSourceContract(readOwnData(value, "contract"));
  const discover = readDataMethod(value, "discover");
  return Object.freeze({
    contract,
    async discover(query: SessionQuery): Promise<Session[]> {
      const result: unknown = await discover.call(value, query);
      return validateDiscoveredSessions(result, contract);
    },
  });
}
```

`validateDiscoveredSessions` snapshots top-level session data descriptors,
requires `session.source === contract.adapter_id`, canonicalizes a validated
capability subset, and returns `{ ...snapshot, capabilities }` without mutating
the adapter-owned value.

- [x] **Step 4: Give both built-ins explicit contracts**

Add `readonly contract = CLAUDE_SESSION_SOURCE_CONTRACT` and
`readonly contract = CODEX_SESSION_SOURCE_CONTRACT` to their existing classes.
Do not add constructors, registries, or new services.

- [x] **Step 5: Delegate focused GREEN verification**

Run:

```bash
npm run build:test
node --test .test-dist/test/session-source-contract.test.js
```

Expected: the contract test compiles and every case passes. If failures expose
a missing behavior, change production code rather than weakening assertions.

### Task 4: Route Combined and analyze through the validated boundary

**Files:**
- Modify: `src/sources/combined.ts`
- Modify: `src/core/analyze.ts`
- Modify: `test/combined-source.test.ts`
- Modify: `test/analyze-integration.test.ts`
- Modify: `test/analysis-budgets-integration.test.ts`
- Modify: `test/analysis-window.test.ts`
- Modify: `test/capability-coverage.test.ts`
- Modify: `test/rules-primary.test.ts`

- [x] **Step 1: Migrate test adapter fixtures to v2**

Every injected leaf receives an immutable built-in declaration, for example:

```ts
const source: SessionSource = {
  contract: CLAUDE_SESSION_SOURCE_CONTRACT,
  discover: async () => [session],
};
```

Use Codex only where the returned session source is Codex. Do not create a
test-only bypass or optional runtime fallback.

- [x] **Step 2: Validate Combined leaves once**

In the constructor, map each leaf through `validateSessionSource`. Keep the
existing parallel unbudgeted loop, sequential budgeted loop, callback behavior,
and source ordering unchanged.

```ts
constructor(
  sources: readonly SessionSource[],
  onSourceError?: (error: unknown) => void,
) {
  this.#sources = sources.map(validateSessionSource);
  this.#onSourceError = onSourceError;
}
```

- [x] **Step 3: Validate injected analyze sources before discovery**

For `AnalyzeOptions.sessionSource`, call `validateSessionSource` before the
query is assembled or `discover()` is invoked. Default Combined sources are
already validated. Keep current budget error handling and default-source error
aggregation unchanged.

```ts
const usingDefaultSource = options.sessionSource === undefined;
const source = usingDefaultSource
  ? defaultSessionSource(options, (error) => sourceErrors.push(error))
  : validateSessionSource(options.sessionSource);
```

- [x] **Step 4: Add integration assertions to the RED test file**

Prove that invalid injected sources never call `discover`, never invoke the
command runner, and do not create Store files. Prove a valid custom Codex
source reaches analysis with explicit capability coverage.

- [x] **Step 5: Delegate regression verification**

Run the focused contract, Combined, analysis integration, budget, window,
coverage, and primary-rule compiled tests. Expected: all pass with unchanged
ordering and budget assertions.

### Task 5: Document the v2 integration and verify the PR

**Files:**
- Modify: `README.md`

- [x] **Step 1: Document the closed source boundary**

Replace the statement that omitted declarations mean all capabilities for new
sources. Show the exact `contract` object, state that only registered adapter
ID/version pairs are accepted, and explain stable pre-discovery rejection.

- [x] **Step 2: Review scope and production size**

Run `git diff --stat origin/main...HEAD`, `git diff --check`, and count added
production lines. No Store migration, Report version, policy, CLI, background
infrastructure, or unrelated refactor may be present; production additions
must remain below 300 lines.

- [ ] **Step 3: Obtain independent reviews**

Dispatch a specification reviewer first, fix any acceptance gap in a new
commit, then dispatch a code-quality/security reviewer and fix only issues
introduced by this PR.

- [ ] **Step 4: Delegate local GitHub Actions verification**

Use the repository's `/run-github-actions-locally` workflow. At minimum run
`npm run check`, packaging/determinism checks selected by the workflow, and
`git diff --check`. Expect all applicable jobs green before push.

### Task 6: Complete the PR lifecycle

- [ ] Fetch and rebase onto current `origin/main` if it advanced, then delegate
  a fresh affected/full verification.
- [ ] Push `feature/custom-source-adapter-contract` and create a ready PR against
  `main` with the contract, privacy, TDD, and compatibility evidence.
- [ ] Monitor all remote checks. Treat sub-five-second billing failures per the
  repository instruction and otherwise fix introduced failures in new commits.
- [ ] Obtain an independent final review, resolve every in-scope finding, and
  re-run required checks.
- [ ] Merge the approved PR using the repository's allowed GitHub merge method.
- [ ] Run `worktree-pr-flow:cleanup` and remove
  `.worktrees/custom-source-adapter-contract` plus the local feature branch
  after its safety checks pass.
