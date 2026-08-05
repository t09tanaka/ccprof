import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_FINDING_SCOPES,
  FindingScopeValidationError,
  parseFindingScope,
} from "../src/core/finding-scope.js";
import {
  AdoptionMethodValidationError,
  CANONICAL_ADOPTION_METHODS,
  parseAdoptionMethod,
} from "../src/analysis/adoption-identity.js";
import {
  CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY,
  LEGACY_ADOPTION_METHODS,
  LEGACY_FINDING_SCOPES,
  normalizeAdoptionMethodIdentity,
  normalizeFindingScopeIdentity,
  projectLegacyAdoptionMethod,
  projectLegacyFindingScope,
} from "../src/compat/instruction-resource.js";

function assertFindingScopeError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof FindingScopeValidationError);
    const findingScopeError = error as Error & { code: unknown };
    assert.equal(findingScopeError.name, "FindingScopeValidationError");
    assert.equal(findingScopeError.code, "invalid_finding_scope");
    assert.equal(
      findingScopeError.message,
      "invalid finding scope: invalid_finding_scope",
    );
    return true;
  });
}

function assertAdoptionMethodError(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof AdoptionMethodValidationError);
    const adoptionMethodError = error as Error & { code: unknown };
    assert.equal(adoptionMethodError.name, "AdoptionMethodValidationError");
    assert.equal(adoptionMethodError.code, "invalid_adoption_method");
    assert.equal(
      adoptionMethodError.message,
      "invalid adoption method: invalid_adoption_method",
    );
    return true;
  });
}

test("instruction-resource identities expose the exact frozen vocabularies", () => {
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

  for (const vocabulary of [
    CANONICAL_FINDING_SCOPES,
    CANONICAL_ADOPTION_METHODS,
    LEGACY_FINDING_SCOPES,
    LEGACY_ADOPTION_METHODS,
  ]) {
    assert.equal(Object.isFrozen(vocabulary), true);
  }
});

test("finding scope identities normalize and project through the instruction resource", () => {
  assert.equal(
    normalizeFindingScopeIdentity(LEGACY_FINDING_SCOPES.claude_md),
    CANONICAL_FINDING_SCOPES.instruction_resource,
  );
  assert.equal(
    projectLegacyFindingScope(CANONICAL_FINDING_SCOPES.instruction_resource),
    LEGACY_FINDING_SCOPES.claude_md,
  );
  assert.equal(
    normalizeFindingScopeIdentity(LEGACY_FINDING_SCOPES.this_pr),
    CANONICAL_FINDING_SCOPES.this_pr,
  );
  assert.equal(
    normalizeFindingScopeIdentity(LEGACY_FINDING_SCOPES.separate_issue),
    CANONICAL_FINDING_SCOPES.separate_issue,
  );
  assert.equal(
    projectLegacyFindingScope(CANONICAL_FINDING_SCOPES.this_pr),
    LEGACY_FINDING_SCOPES.this_pr,
  );
  assert.equal(
    projectLegacyFindingScope(CANONICAL_FINDING_SCOPES.separate_issue),
    LEGACY_FINDING_SCOPES.separate_issue,
  );

  assert.equal(
    projectLegacyFindingScope(
      normalizeFindingScopeIdentity(LEGACY_FINDING_SCOPES.claude_md),
    ),
    LEGACY_FINDING_SCOPES.claude_md,
  );
  assert.equal(
    normalizeFindingScopeIdentity(
      projectLegacyFindingScope(
        CANONICAL_FINDING_SCOPES.instruction_resource,
      ),
    ),
    CANONICAL_FINDING_SCOPES.instruction_resource,
  );
  for (const unchanged of [
    CANONICAL_FINDING_SCOPES.this_pr,
    CANONICAL_FINDING_SCOPES.separate_issue,
  ]) {
    assert.equal(
      projectLegacyFindingScope(normalizeFindingScopeIdentity(unchanged)),
      unchanged,
    );
    assert.equal(
      normalizeFindingScopeIdentity(projectLegacyFindingScope(unchanged)),
      unchanged,
    );
  }
});

test("adoption method identities normalize and project through the instruction resource", () => {
  assert.equal(
    normalizeAdoptionMethodIdentity(LEGACY_ADOPTION_METHODS.claude_md_edit),
    CANONICAL_ADOPTION_METHODS.instruction_resource_edit,
  );
  assert.equal(
    projectLegacyAdoptionMethod(
      CANONICAL_ADOPTION_METHODS.instruction_resource_edit,
    ),
    LEGACY_ADOPTION_METHODS.claude_md_edit,
  );
  assert.equal(
    normalizeAdoptionMethodIdentity(LEGACY_ADOPTION_METHODS.target_file_edit),
    CANONICAL_ADOPTION_METHODS.target_file_edit,
  );
  assert.equal(
    projectLegacyAdoptionMethod(CANONICAL_ADOPTION_METHODS.target_file_edit),
    LEGACY_ADOPTION_METHODS.target_file_edit,
  );

  assert.equal(
    projectLegacyAdoptionMethod(
      normalizeAdoptionMethodIdentity(
        LEGACY_ADOPTION_METHODS.claude_md_edit,
      ),
    ),
    LEGACY_ADOPTION_METHODS.claude_md_edit,
  );
  assert.equal(
    normalizeAdoptionMethodIdentity(
      projectLegacyAdoptionMethod(
        CANONICAL_ADOPTION_METHODS.instruction_resource_edit,
      ),
    ),
    CANONICAL_ADOPTION_METHODS.instruction_resource_edit,
  );
  assert.equal(
    projectLegacyAdoptionMethod(
      normalizeAdoptionMethodIdentity(
        CANONICAL_ADOPTION_METHODS.target_file_edit,
      ),
    ),
    CANONICAL_ADOPTION_METHODS.target_file_edit,
  );
  assert.equal(
    normalizeAdoptionMethodIdentity(
      projectLegacyAdoptionMethod(
        CANONICAL_ADOPTION_METHODS.target_file_edit,
      ),
    ),
    CANONICAL_ADOPTION_METHODS.target_file_edit,
  );
});

test("finding scope functions fail closed with content-free stable errors", () => {
  for (const value of [
    "invalid_finding_scope",
    "THIS_PR",
    " this_pr",
    "this_pr ",
    "this_pr\0",
    "!",
    Symbol("finding-scope"),
    1n,
    1,
    true,
    null,
    undefined,
  ]) {
    assertFindingScopeError(() => parseFindingScope(value));
    assertFindingScopeError(() => normalizeFindingScopeIdentity(value));
    assertFindingScopeError(() => projectLegacyFindingScope(value));
  }
});

test("adoption method functions fail closed with content-free stable errors", () => {
  for (const value of [
    "invalid_adoption_method",
    "TARGET_FILE_EDIT",
    " target_file_edit",
    "target_file_edit ",
    "target_file_edit\0",
    "!",
    Symbol("adoption-method"),
    1n,
    1,
    true,
    null,
    undefined,
  ]) {
    assertAdoptionMethodError(() => parseAdoptionMethod(value));
    assertAdoptionMethodError(() => normalizeAdoptionMethodIdentity(value));
    assertAdoptionMethodError(() => projectLegacyAdoptionMethod(value));
  }
});

test("legacy values are invalid inputs to canonical parsers and projectors", () => {
  assertFindingScopeError(() => parseFindingScope("claude_md"));
  assertFindingScopeError(() => projectLegacyFindingScope("claude_md"));
  assertAdoptionMethodError(() => parseAdoptionMethod("claude_md_edit"));
  assertAdoptionMethodError(() => projectLegacyAdoptionMethod("claude_md_edit"));
});

test("identity functions reject accessor objects and proxies without observation", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("GETTER_MUST_NOT_RUN");
    },
  });
  let trapCalls = 0;
  const hostile = new Proxy({}, {
    get() {
      trapCalls += 1;
      throw new Error("GET_MUST_NOT_RUN");
    },
    ownKeys() {
      trapCalls += 1;
      throw new Error("OWN_KEYS_MUST_NOT_RUN");
    },
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      throw new Error("DESCRIPTOR_MUST_NOT_RUN");
    },
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error("PROTOTYPE_MUST_NOT_RUN");
    },
  });
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();

  for (const value of [accessor, hostile, revocable.proxy]) {
    assertFindingScopeError(() => parseFindingScope(value));
    assertFindingScopeError(() => normalizeFindingScopeIdentity(value));
    assertFindingScopeError(() => projectLegacyFindingScope(value));
    assertAdoptionMethodError(() => parseAdoptionMethod(value));
    assertAdoptionMethodError(() => normalizeAdoptionMethodIdentity(value));
    assertAdoptionMethodError(() => projectLegacyAdoptionMethod(value));
  }

  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

test("CLAUDE.md instruction-resource compatibility descriptor is exact and frozen", () => {
  assert.deepEqual(CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY, {
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
  assert.equal(Object.isFrozen(CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY), true);
  assert.equal(
    Object.isFrozen(CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY.resource),
    true,
  );
  assert.equal(
    Object.isFrozen(CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY.detector),
    true,
  );
  assert.equal(
    Reflect.set(
      CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY.resource,
      "path",
      "MUTATED.md",
    ),
    false,
  );
  assert.equal(
    CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY.resource.path,
    "CLAUDE.md",
  );
});
