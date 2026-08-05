# Instruction Resource Identity Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an unused, neutral instruction-resource identity foundation with exact legacy `CLAUDE.md` compatibility and no current runtime or wire changes.

**Architecture:** Canonical finding scope and adoption method live in separate focused modules. A compatibility-only module owns the legacy wire tokens, exact bidirectional mappings, and the current fixed `CLAUDE.md` detector descriptor. All functions accept unknown primitive values and fail closed before object inspection.

**Tech Stack:** TypeScript 5.9, Node.js 22/24 built-in test runner, strict ESM.

---

### Task 1: Write the focused contract test and prove RED

**Files:**
- Create: `test/instruction-resource-identity.test.ts`

- [ ] **Step 1: Add the complete identity contract test**

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_ADOPTION_METHODS,
  AdoptionMethodValidationError,
  parseAdoptionMethod,
} from "../src/analysis/adoption-identity.js";
import {
  CANONICAL_FINDING_SCOPES,
  FindingScopeValidationError,
  parseFindingScope,
} from "../src/core/finding-scope.js";
import {
  CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY,
  LEGACY_ADOPTION_METHODS,
  LEGACY_FINDING_SCOPES,
  normalizeAdoptionMethodIdentity,
  normalizeFindingScopeIdentity,
  projectLegacyAdoptionMethod,
  projectLegacyFindingScope,
} from "../src/compat/instruction-resource.js";

function expectScopeError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof FindingScopeValidationError);
    assert.equal(error.name, "FindingScopeValidationError");
    assert.equal(error.code, "invalid_finding_scope");
    assert.equal(error.message, "invalid finding scope: invalid_finding_scope");
    assert.doesNotMatch(error.message, /must-not-leak/u);
    return true;
  });
}

function expectMethodError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof AdoptionMethodValidationError);
    assert.equal(error.name, "AdoptionMethodValidationError");
    assert.equal(error.code, "invalid_adoption_method");
    assert.equal(error.message, "invalid adoption method: invalid_adoption_method");
    assert.doesNotMatch(error.message, /must-not-leak/u);
    return true;
  });
}

test("defines exact frozen canonical and legacy identity vocabularies", () => {
  assert.deepEqual(CANONICAL_FINDING_SCOPES, {
    this_pr: "this_pr",
    separate_issue: "separate_issue",
    instruction_resource: "instruction_resource",
  });
  assert.deepEqual(CANONICAL_ADOPTION_METHODS, {
    target_file_edit: "target_file_edit",
    instruction_resource_edit: "instruction_resource_edit",
  });
  assert.deepEqual(LEGACY_FINDING_SCOPES, {
    this_pr: "this_pr",
    separate_issue: "separate_issue",
    claude_md: "claude_md",
  });
  assert.deepEqual(LEGACY_ADOPTION_METHODS, {
    target_file_edit: "target_file_edit",
    claude_md_edit: "claude_md_edit",
  });
  for (const value of [
    CANONICAL_FINDING_SCOPES,
    CANONICAL_ADOPTION_METHODS,
    LEGACY_FINDING_SCOPES,
    LEGACY_ADOPTION_METHODS,
  ]) assert.equal(Object.isFrozen(value), true);
});

test("normalizes and projects exact scope identities", () => {
  assert.equal(normalizeFindingScopeIdentity("claude_md"), "instruction_resource");
  assert.equal(projectLegacyFindingScope("instruction_resource"), "claude_md");
  for (const value of ["this_pr", "separate_issue"] as const) {
    assert.equal(parseFindingScope(value), value);
    assert.equal(normalizeFindingScopeIdentity(value), value);
    assert.equal(projectLegacyFindingScope(value), value);
    assert.equal(
      normalizeFindingScopeIdentity(projectLegacyFindingScope(value)),
      value,
    );
  }
  assert.equal(
    normalizeFindingScopeIdentity(projectLegacyFindingScope("instruction_resource")),
    "instruction_resource",
  );
});

test("normalizes and projects exact adoption method identities", () => {
  assert.equal(
    normalizeAdoptionMethodIdentity("claude_md_edit"),
    "instruction_resource_edit",
  );
  assert.equal(
    projectLegacyAdoptionMethod("instruction_resource_edit"),
    "claude_md_edit",
  );
  assert.equal(parseAdoptionMethod("target_file_edit"), "target_file_edit");
  assert.equal(normalizeAdoptionMethodIdentity("target_file_edit"), "target_file_edit");
  assert.equal(projectLegacyAdoptionMethod("target_file_edit"), "target_file_edit");
  assert.equal(
    normalizeAdoptionMethodIdentity(
      projectLegacyAdoptionMethod("instruction_resource_edit"),
    ),
    "instruction_resource_edit",
  );
});

test("rejects malformed primitive identity values with content-free errors", () => {
  const invalid = [
    undefined,
    null,
    true,
    1,
    0n,
    Symbol("must-not-leak"),
    "must-not-leak",
    "CLAUDE_MD",
    " claude_md",
    "claude_md ",
    "claude_md\0must-not-leak",
    "Instruction_Resource",
  ];
  for (const value of invalid) {
    expectScopeError(() => normalizeFindingScopeIdentity(value));
    expectScopeError(() => projectLegacyFindingScope(value));
    expectMethodError(() => normalizeAdoptionMethodIdentity(value));
    expectMethodError(() => projectLegacyAdoptionMethod(value));
  }
  expectScopeError(() => projectLegacyFindingScope("claude_md"));
  expectMethodError(() => projectLegacyAdoptionMethod("claude_md_edit"));
});

test("rejects accessors and proxies without evaluating hostile code", () => {
  let getterCalls = 0;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "value", {
    get() {
      getterCalls += 1;
      return "must-not-leak";
    },
  });
  let trapCalls = 0;
  const proxy = new Proxy({}, {
    get() { trapCalls += 1; return "must-not-leak"; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return []; },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [accessor, proxy, revoked.proxy]) {
    expectScopeError(() => normalizeFindingScopeIdentity(value));
    expectScopeError(() => projectLegacyFindingScope(value));
    expectMethodError(() => normalizeAdoptionMethodIdentity(value));
    expectMethodError(() => projectLegacyAdoptionMethod(value));
  }
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

test("exposes only the deeply frozen current CLAUDE.md compatibility facts", () => {
  const descriptor = CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY;
  assert.deepEqual(descriptor, {
    resource: {
      path: "CLAUDE.md",
      legacy_finding_scope: "claude_md",
      canonical_finding_scope: "instruction_resource",
    },
    detector: {
      evidence_path: "CLAUDE.md",
      legacy_adoption_method: "claude_md_edit",
      canonical_adoption_method: "instruction_resource_edit",
      qualifier: "suggestion_keyword_in_added_text_after_recorded_at",
      selection: "oldest_qualifying_commit",
    },
  });
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.resource), true);
  assert.equal(Object.isFrozen(descriptor.detector), true);
  assert.equal(Reflect.set(descriptor.resource, "path", "AGENTS.md"), false);
  assert.equal(descriptor.resource.path, "CLAUDE.md");
});
```

- [ ] **Step 2: Delegate the focused RED run to a fresh `gpt-5.6-terra` agent**

Run: `npm run build:test && node --test .test-dist/test/instruction-resource-identity.test.js`

Expected: FAIL because the three new production modules do not exist. The failure must
be attributable to the missing feature, not a typo in the test.

- [ ] **Step 3: Commit the RED test**

```bash
git add test/instruction-resource-identity.test.ts
git commit -m "test(core): specify instruction resource identities"
```

### Task 2: Implement the minimal canonical and compatibility modules

**Files:**
- Create: `src/core/finding-scope.ts`
- Create: `src/analysis/adoption-identity.ts`
- Create: `src/compat/instruction-resource.ts`
- Test: `test/instruction-resource-identity.test.ts`

- [ ] **Step 1: Add canonical finding scope parsing**

```typescript
export const CANONICAL_FINDING_SCOPES = Object.freeze({
  this_pr: "this_pr",
  separate_issue: "separate_issue",
  instruction_resource: "instruction_resource",
} as const);
export type FindingScope =
  (typeof CANONICAL_FINDING_SCOPES)[keyof typeof CANONICAL_FINDING_SCOPES];
export type FindingScopeValidationCode = "invalid_finding_scope";
export class FindingScopeValidationError extends TypeError {
  readonly code: FindingScopeValidationCode;
  constructor(code: FindingScopeValidationCode) {
    super(`invalid finding scope: ${code}`);
    this.name = "FindingScopeValidationError";
    this.code = code;
  }
}
const FINDING_SCOPE_SET = new Set<string>(Object.values(CANONICAL_FINDING_SCOPES));
export function parseFindingScope(value: unknown): FindingScope {
  if (typeof value !== "string" || !FINDING_SCOPE_SET.has(value)) {
    throw new FindingScopeValidationError("invalid_finding_scope");
  }
  return value as FindingScope;
}
```

- [ ] **Step 2: Add canonical adoption method parsing**

```typescript
export const CANONICAL_ADOPTION_METHODS = Object.freeze({
  target_file_edit: "target_file_edit",
  instruction_resource_edit: "instruction_resource_edit",
} as const);
export type AdoptionMethod =
  (typeof CANONICAL_ADOPTION_METHODS)[keyof typeof CANONICAL_ADOPTION_METHODS];
export type AdoptionMethodValidationCode = "invalid_adoption_method";
export class AdoptionMethodValidationError extends TypeError {
  readonly code: AdoptionMethodValidationCode;
  constructor(code: AdoptionMethodValidationCode) {
    super(`invalid adoption method: ${code}`);
    this.name = "AdoptionMethodValidationError";
    this.code = code;
  }
}
const ADOPTION_METHOD_SET = new Set<string>(Object.values(CANONICAL_ADOPTION_METHODS));
export function parseAdoptionMethod(value: unknown): AdoptionMethod {
  if (typeof value !== "string" || !ADOPTION_METHOD_SET.has(value)) {
    throw new AdoptionMethodValidationError("invalid_adoption_method");
  }
  return value as AdoptionMethod;
}
```

- [ ] **Step 3: Add exact legacy normalization, projection, and descriptor**

```typescript
import {
  CANONICAL_ADOPTION_METHODS,
  parseAdoptionMethod,
  type AdoptionMethod,
} from "../analysis/adoption-identity.js";
import {
  CANONICAL_FINDING_SCOPES,
  parseFindingScope,
  type FindingScope,
} from "../core/finding-scope.js";

export const LEGACY_FINDING_SCOPES = Object.freeze({
  this_pr: "this_pr",
  separate_issue: "separate_issue",
  claude_md: "claude_md",
} as const);
export type LegacyFindingScope =
  (typeof LEGACY_FINDING_SCOPES)[keyof typeof LEGACY_FINDING_SCOPES];
export const LEGACY_ADOPTION_METHODS = Object.freeze({
  target_file_edit: "target_file_edit",
  claude_md_edit: "claude_md_edit",
} as const);
export type LegacyAdoptionMethod =
  (typeof LEGACY_ADOPTION_METHODS)[keyof typeof LEGACY_ADOPTION_METHODS];

export function normalizeFindingScopeIdentity(value: unknown): FindingScope {
  return value === LEGACY_FINDING_SCOPES.claude_md
    ? CANONICAL_FINDING_SCOPES.instruction_resource
    : parseFindingScope(value);
}
export function projectLegacyFindingScope(value: unknown): LegacyFindingScope {
  const scope = parseFindingScope(value);
  return scope === CANONICAL_FINDING_SCOPES.instruction_resource
    ? LEGACY_FINDING_SCOPES.claude_md
    : scope;
}
export function normalizeAdoptionMethodIdentity(value: unknown): AdoptionMethod {
  return value === LEGACY_ADOPTION_METHODS.claude_md_edit
    ? CANONICAL_ADOPTION_METHODS.instruction_resource_edit
    : parseAdoptionMethod(value);
}
export function projectLegacyAdoptionMethod(value: unknown): LegacyAdoptionMethod {
  const method = parseAdoptionMethod(value);
  return method === CANONICAL_ADOPTION_METHODS.instruction_resource_edit
    ? LEGACY_ADOPTION_METHODS.claude_md_edit
    : method;
}

export const CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY = Object.freeze({
  resource: Object.freeze({
    path: "CLAUDE.md",
    legacy_finding_scope: LEGACY_FINDING_SCOPES.claude_md,
    canonical_finding_scope: CANONICAL_FINDING_SCOPES.instruction_resource,
  }),
  detector: Object.freeze({
    evidence_path: "CLAUDE.md",
    legacy_adoption_method: LEGACY_ADOPTION_METHODS.claude_md_edit,
    canonical_adoption_method: CANONICAL_ADOPTION_METHODS.instruction_resource_edit,
    qualifier: "suggestion_keyword_in_added_text_after_recorded_at",
    selection: "oldest_qualifying_commit",
  }),
} as const);
```

- [ ] **Step 4: Delegate focused GREEN and full verification to `gpt-5.6-terra` agents**

Run focused: `npm run build:test && node --test .test-dist/test/instruction-resource-identity.test.js`

Expected: PASS, including the hostile input and immutability cases.

Run full: `npm run check`

Expected: PASS with no typecheck or test failures.

- [ ] **Step 5: Verify scope structurally**

Run: `git diff --name-only origin/main...HEAD`

Expected after the implementation commit: exactly the six files named by this plan.

Run: `rg -n "instruction-resource|finding-scope|adoption-identity" src --glob '!core/finding-scope.ts' --glob '!analysis/adoption-identity.ts' --glob '!compat/instruction-resource.ts'`

Expected: no existing production imports or references.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/core/finding-scope.ts src/analysis/adoption-identity.ts src/compat/instruction-resource.ts
git commit -m "feat(core): add instruction resource identities"
```

### Task 3: Review, rebase, reproduce CI, and publish the Ready PR

**Files:**
- Review only: all six files from Tasks 1 and 2

- [ ] **Step 1: Dispatch a fresh specification reviewer**

Compare the full diff with the design and task requirements line by line. Require
approval that nothing is missing and no runtime integration or broader resource claim
was added.

- [ ] **Step 2: Dispatch a separate fresh code-quality reviewer after spec approval**

Review the exact base-to-head diff for type safety, hostile-input safety, immutable
constants, test quality, determinism, and scope. Fix only PR-caused Critical or
Important findings in a new commit, add a RED regression for functional issues, and
repeat the applicable review.

- [ ] **Step 3: Refresh and, if necessary, rebase onto exact latest `origin/main`**

```bash
git fetch origin main
git rebase origin/main
```

If `origin/main` advanced, repeat delegated verification and proportionate reviews.
Confirm zero exact-file overlap with active independent work before continuing.

- [ ] **Step 4: Delegate `/run-github-actions-locally` to `gpt-5.6-terra`**

The CI enumerator and every selected execution unit must be delegated. Do not run
lint, typecheck, build, check, or tests in the controller context.

- [ ] **Step 5: Push and create a non-draft PR against the default branch**

Title: `[Core] feat: add instruction resource identity foundation`

The body must state the additive-only scope, exact six files, test evidence, and
`Rollback: revert-safe`. Do not claim current runtime support for neutral resources.

- [ ] **Step 6: Monitor remote completion evidence**

Wait for all 15 required checks, inspect unresolved review threads, and confirm the PR
reports `mergeStateStatus: CLEAN` and exact `mergeable: MERGEABLE`. Record the exact
remote head SHA and report `MERGE_READY` without merging. Retain the worktree until the
root agent reports that the PR was merged and explicitly recalls cleanup.
