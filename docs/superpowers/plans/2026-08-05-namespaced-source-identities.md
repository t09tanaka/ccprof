# Namespaced Source Identities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated open namespaced source identity primitives while preserving every existing built-in runtime and wire value through explicit legacy compatibility types and projections.

**Architecture:** A new focused core module owns the neutral Trace Envelope v1 namespaced-name validator, open identity aliases, explicit built-in compatibility maps, projections, and code-unit ordering. `Session` and the exported descriptor contract consume the open types, while the descriptor registry remains explicitly legacy-typed so derivation, validation, storage, reporting, fingerprints, cache keys, and serialized bytes do not change.

**Tech Stack:** TypeScript 5.9, Node.js 22/24 built-in test runner, `node:assert/strict`, existing SHA-256 source descriptor contract.

---

### Task 1: Record the semantic impact and add failing identity contract tests

**Files:**
- Create: `test/source-identity.test.ts`
- Read: `schemas/trace-envelope-v1.schema.json`
- Read: `src/core/source-descriptor.ts`

- [ ] **Step 1: Probe the shared type semantically without applying edits**

Run `mcp__ts_rename_helper__planRenameSymbol` at zero-based line 8, character
12 of `src/core/source-descriptor.ts`, with temporary name
`SourceAdapterIdImpactProbe`, project root set to this worktree, and
`tsconfig.test.json`. Confirm `canRename: true` and record every returned file;
do not apply the edit plan. LSP diagnostics are unavailable, so use this rename
plan as the semantic impact source and `rg` only as a supplemental check.

- [ ] **Step 2: Write the failing public identity test**

Create `test/source-identity.test.ts` with the following imports and cases. Pin
the exact pre-change descriptor fingerprints obtained from current `main` so
the compatibility assertion cannot pass after an accidental byte change.

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { ALL_SESSION_CAPABILITIES, type Session } from "../src/core/model.js";
import {
  CANONICAL_SOURCE_ADAPTER_IDS,
  CANONICAL_SOURCE_KIND_IDS,
  SourceIdentityValidationError,
  compareSourceIdentities,
  normalizeSourceAdapterId,
  normalizeSourceKind,
  parseProducerId,
  parseSourceAdapterId,
  parseSourceKind,
  projectLegacySourceAdapterId,
  projectLegacySourceKind,
  type ProducerId,
  type SourceAdapterId,
  type SourceKind,
} from "../src/core/source-identity.js";
import {
  deriveSourceDescriptor,
  type SourceDescriptor,
} from "../src/core/source-descriptor.js";

test("public source identity types accept namespaced third-party IDs", () => {
  const producer: ProducerId = "dev.example.agent/adapters/dummy-agent";
  const adapter: SourceAdapterId = producer;
  const kind: SourceKind = "dev.example.agent/source-kinds/dummy-jsonl";
  const sessionSource: Session["source"] = producer;
  const descriptorAdapter: SourceDescriptor["adapter_id"] = adapter;
  const descriptorKind: SourceDescriptor["source_kind"] = kind;

  assert.equal(parseProducerId(sessionSource), producer);
  assert.equal(parseSourceAdapterId(descriptorAdapter), adapter);
  assert.equal(parseSourceKind(descriptorKind), kind);
});

test("canonical IDs validate and only known legacy tokens normalize", () => {
  assert.equal(
    normalizeSourceAdapterId("claude"),
    CANONICAL_SOURCE_ADAPTER_IDS.claude,
  );
  assert.equal(
    normalizeSourceAdapterId("codex"),
    CANONICAL_SOURCE_ADAPTER_IDS.codex,
  );
  assert.equal(
    normalizeSourceKind("claude_transcript_jsonl"),
    CANONICAL_SOURCE_KIND_IDS.claude_transcript_jsonl,
  );
  assert.equal(
    parseSourceAdapterId(CANONICAL_SOURCE_ADAPTER_IDS.claude),
    CANONICAL_SOURCE_ADAPTER_IDS.claude,
  );
  assert.equal(
    parseSourceKind(CANONICAL_SOURCE_KIND_IDS.codex_rollout_jsonl),
    CANONICAL_SOURCE_KIND_IDS.codex_rollout_jsonl,
  );
});

test("namespaced identity parsing rejects invalid syntax and excess length", () => {
  const maxLength = `${"a.".repeat(126)}a/x`;
  const overLength = `${"a.".repeat(126)}a/xx`;
  assert.equal(maxLength.length, 255);
  assert.equal(parseProducerId(maxLength), maxLength);
  assert.equal(overLength.length, 256);

  for (const value of [
    "", " ", "dev.example/has space", "dev.example/has\0nul",
    "Dev.example/agent", "localhost/agent", "dev.example//agent",
    "dev.example/", "-dev.example/agent", "dev-.example/agent",
    "dev.example/agent\n", overLength,
  ]) {
    assert.throws(
      () => parseProducerId(value),
      {
        name: "SourceIdentityValidationError",
        message: "invalid source identity: invalid_namespaced_name",
      },
    );
  }
});

test("unknown unnamespaced aliases fail closed", () => {
  assert.throws(
    () => normalizeSourceAdapterId("dummy-agent"),
    SourceIdentityValidationError,
  );
  assert.throws(
    () => normalizeSourceKind("dummy_jsonl"),
    SourceIdentityValidationError,
  );
});

test("legacy projection is built-in-only", () => {
  assert.equal(
    projectLegacySourceAdapterId(CANONICAL_SOURCE_ADAPTER_IDS.claude),
    "claude",
  );
  assert.equal(
    projectLegacySourceAdapterId(CANONICAL_SOURCE_ADAPTER_IDS.codex),
    "codex",
  );
  assert.equal(
    projectLegacySourceAdapterId("dev.example.agent/adapters/dummy-agent"),
    undefined,
  );
  assert.equal(
    projectLegacySourceKind(CANONICAL_SOURCE_KIND_IDS.claude_transcript_jsonl),
    "claude_transcript_jsonl",
  );
  assert.equal(
    projectLegacySourceKind("dev.example.agent/source-kinds/dummy-jsonl"),
    undefined,
  );
});

test("identity ordering uses deterministic code-unit comparison", () => {
  const values = ["dev.z.example/kind", "dev.a.example/kind"];
  assert.deepEqual(values.sort(compareSourceIdentities), [
    "dev.a.example/kind",
    "dev.z.example/kind",
  ]);
});

test("built-in descriptors retain their exact legacy shapes and fingerprints", () => {
  const claude = deriveSourceDescriptor({
    session_id: "session-1",
    source: "claude",
    source_path: "/private/logs/session.jsonl",
  });
  const codex = deriveSourceDescriptor({
    session_id: "session-1",
    source: "codex",
    source_path: "/private/logs/session.jsonl",
    capabilities: ["tool_timestamps", "edit_fragments"],
  });

  assert.deepEqual(claude, {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    source_instance_id:
      "source-0e596344ad7c80946741116ed2a54665d0a55027b6a78d6bfb4f1c9dd2872a6d",
    source_kind: "claude_transcript_jsonl",
    provided_capabilities: [...ALL_SESSION_CAPABILITIES].sort(),
    required_capabilities: [],
    provenance: "local_filesystem",
    sensitivity: "sensitive",
    retention_class: "raw_evidence",
    canonical_fingerprint:
      "sha256:d2a320e97e2dd44189283e8d839c346dbcadac97eb0100200e27e23bafe24278",
  });
  assert.deepEqual(codex, {
    adapter_id: "codex",
    adapter_version: "1.0.0",
    source_instance_id:
      "source-38b016536bb29661f22086bef5eae8ee39ecdd62b99b4e90b4cdf5ee77782d88",
    source_kind: "codex_rollout_jsonl",
    provided_capabilities: ["edit_fragments", "tool_timestamps"],
    required_capabilities: [],
    provenance: "local_filesystem",
    sensitivity: "sensitive",
    retention_class: "raw_evidence",
    canonical_fingerprint:
      "sha256:672989e2a9b2301cf7692521ecc4b17317bfdde087b3afcf6b867060e140d715",
  });
});
```

The pinned values above come from executing the current-main compiled
`deriveSourceDescriptor` before any production edit.

- [ ] **Step 3: Delegate the focused RED run**

Have a fresh `gpt-5.6-terra` worker run:

```bash
npm run build:test
```

Expected: nonzero exit with TypeScript module/export errors for the missing
`src/core/source-identity.ts` API. Confirm the failure is caused by the absent
feature rather than a test typo. Do not run this command in the controller
context.

### Task 2: Implement the minimal open identity boundary

**Files:**
- Create: `src/core/source-identity.ts`
- Modify: `src/core/model.ts`
- Modify: `src/core/source-descriptor.ts`
- Test: `test/source-identity.test.ts`

- [ ] **Step 1: Add the focused identity module**

Create `src/core/source-identity.ts` with open string aliases, explicit legacy
maps, the exact schema grammar, content-free validation, typed parsers,
normalizers, built-in-only projections, and code-unit comparison:

```ts
export type NamespacedSourceIdentity = string;
export type ProducerId = NamespacedSourceIdentity;
export type SourceAdapterId = NamespacedSourceIdentity;
export type SourceKind = NamespacedSourceIdentity;

export type LegacySourceAdapterId = "claude" | "codex";
export type LegacySourceKind =
  | "claude_transcript_jsonl"
  | "codex_rollout_jsonl";

export const CANONICAL_SOURCE_ADAPTER_IDS = Object.freeze({
  claude: "ccprof.dev/adapters/claude",
  codex: "ccprof.dev/adapters/codex",
} satisfies Readonly<Record<LegacySourceAdapterId, SourceAdapterId>>);

export const CANONICAL_SOURCE_KIND_IDS = Object.freeze({
  claude_transcript_jsonl:
    "ccprof.dev/source-kinds/claude-transcript-jsonl",
  codex_rollout_jsonl: "ccprof.dev/source-kinds/codex-rollout-jsonl",
} satisfies Readonly<Record<LegacySourceKind, SourceKind>>);

export type SourceIdentityValidationCode = "invalid_namespaced_name";

export class SourceIdentityValidationError extends TypeError {
  readonly code: SourceIdentityValidationCode;

  constructor(code: SourceIdentityValidationCode) {
    super(`invalid source identity: ${code}`);
    this.name = "SourceIdentityValidationError";
    this.code = code;
  }
}

const NAMESPACED_NAME_PATTERN =
  /^(?:[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z][a-z0-9._-]{0,63})*(?![\s\S])/u;
const MAX_NAMESPACED_NAME_LENGTH = 255;

function parseNamespacedSourceIdentity(
  value: unknown,
): NamespacedSourceIdentity {
  if (
    typeof value !== "string" ||
    value.length > MAX_NAMESPACED_NAME_LENGTH ||
    !NAMESPACED_NAME_PATTERN.test(value)
  ) {
    throw new SourceIdentityValidationError("invalid_namespaced_name");
  }
  return value;
}

export function parseProducerId(value: unknown): ProducerId {
  return parseNamespacedSourceIdentity(value);
}

export function parseSourceAdapterId(value: unknown): SourceAdapterId {
  return parseNamespacedSourceIdentity(value);
}

export function parseSourceKind(value: unknown): SourceKind {
  return parseNamespacedSourceIdentity(value);
}

function legacyValue<T extends string>(
  compatibility: Readonly<Record<T, string>>,
  value: unknown,
): string | undefined {
  return typeof value === "string" && Object.hasOwn(compatibility, value)
    ? compatibility[value as T]
    : undefined;
}

export function normalizeSourceAdapterId(value: unknown): SourceAdapterId {
  return legacyValue(CANONICAL_SOURCE_ADAPTER_IDS, value) ??
    parseSourceAdapterId(value);
}

export function normalizeSourceKind(value: unknown): SourceKind {
  return legacyValue(CANONICAL_SOURCE_KIND_IDS, value) ?? parseSourceKind(value);
}

function projectLegacyValue<T extends string>(
  compatibility: Readonly<Record<T, string>>,
  value: string,
): T | undefined {
  for (const legacy of Object.keys(compatibility) as T[]) {
    if (compatibility[legacy] === value) return legacy;
  }
  return undefined;
}

export function projectLegacySourceAdapterId(
  value: SourceAdapterId,
): LegacySourceAdapterId | undefined {
  return projectLegacyValue(CANONICAL_SOURCE_ADAPTER_IDS, value);
}

export function projectLegacySourceKind(
  value: SourceKind,
): LegacySourceKind | undefined {
  return projectLegacyValue(CANONICAL_SOURCE_KIND_IDS, value);
}

export function compareSourceIdentities(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
```

- [ ] **Step 2: Open `Session.source` structurally**

In `src/core/model.ts`, import `ProducerId` and replace the closed union:

```ts
import type { ProducerId } from "./source-identity.js";

export interface Session {
  session_id: string;
  source: ProducerId;
```

Do not change any producer assignments or serialized values.

- [ ] **Step 3: Separate the open descriptor surface from its legacy registry**

In `src/core/source-descriptor.ts`, import the comparator and legacy registry
types, re-export the open public types, and make only the registry closed:

```ts
import {
  compareSourceIdentities,
  type LegacySourceAdapterId,
  type LegacySourceKind,
  type SourceAdapterId,
  type SourceKind,
} from "./source-identity.js";

export type { SourceAdapterId, SourceKind } from "./source-identity.js";

interface RegistryEntry {
  adapter_id: LegacySourceAdapterId;
  adapter_version: SourceAdapterVersion;
  source_kind: LegacySourceKind;
  required_capabilities: readonly SessionCapability[];
  provenance: SourceProvenance;
  sensitivity: SourceSensitivity;
  retention_class: SourceRetentionClass;
}

const BUILTIN_SOURCE_REGISTRY: Readonly<
  Record<LegacySourceAdapterId, RegistryEntry>
> = {
  claude: {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    source_kind: "claude_transcript_jsonl",
    required_capabilities: [],
    provenance: "local_filesystem",
    sensitivity: "sensitive",
    retention_class: "raw_evidence",
  },
  codex: {
    adapter_id: "codex",
    adapter_version: "1.0.0",
    source_kind: "codex_rollout_jsonl",
    required_capabilities: [],
    provenance: "local_filesystem",
    sensitivity: "sensitive",
    retention_class: "raw_evidence",
  },
};

function sortedCapabilities(
  capabilities: readonly SessionCapability[],
): SessionCapability[] {
  return [...new Set(capabilities)].sort(compareSourceIdentities);
}

return [...descriptors.values()].sort((left, right) =>
  compareSourceIdentities(left.adapter_id, right.adapter_id) ||
  compareSourceIdentities(left.source_instance_id, right.source_instance_id)
);
```

Replace both `localeCompare` ordering callbacks in this file with
`compareSourceIdentities`. Keep `registryEntry`, descriptor derivation,
validation, fingerprints, and all literal registry values otherwise unchanged.

- [ ] **Step 4: Delegate focused GREEN verification**

Have the same RED `gpt-5.6-terra` worker run:

```bash
npm run build:test && node --test \
  .test-dist/test/source-identity.test.js \
  .test-dist/test/source-descriptor.test.js
```

Expected: exit 0, all source identity and source descriptor tests pass with
zero failures. Do not run this command in the controller context.

### Task 3: Document, inspect, verify, and commit

**Files:**
- Create: `docs/superpowers/specs/2026-08-05-namespaced-source-identities-design.md`
- Create: `docs/superpowers/plans/2026-08-05-namespaced-source-identities.md`
- Inspect: all files changed from `origin/main`

- [ ] **Step 1: Inspect scope and neutral validation**

Run read-only checks:

```bash
git diff --check
git diff --stat origin/main
git diff origin/main -- src/core/source-identity.ts src/core/model.ts \
  src/core/source-descriptor.ts test/source-identity.test.ts
rg -n 'localeCompare' src/core/source-identity.ts src/core/source-descriptor.ts
rg -n 'claude|codex|github|gitlab|bitbucket' src/core/source-identity.ts
```

Expected: no whitespace errors; at most five production/test/doc files plus
the two required documents; no `localeCompare`; vendor literals occur only in
the legacy types and explicit compatibility maps, never in the neutral regex,
parser, comparator, or error path. Confirm implementation code remains under
300 added/changed lines and no Store, Report, parser, schema, fixture, package
export, or cache file changed.

- [ ] **Step 2: Delegate fresh full verification**

Have a fresh `gpt-5.6-terra` worker run:

```bash
npm run build:test && node --test \
  .test-dist/test/source-identity.test.js \
  .test-dist/test/source-descriptor.test.js
npm run check
```

Expected: both commands exit 0. Record test counts, pass/fail counts, and any
warnings exactly. Do not run verification commands in the controller context.

- [ ] **Step 3: Commit the design and implementation without amendment**

After verification and diff review, stage all six required implementation and
documentation paths explicitly and commit once as one atomic compatibility
feature:

```bash
git add \
  docs/superpowers/specs/2026-08-05-namespaced-source-identities-design.md \
  docs/superpowers/plans/2026-08-05-namespaced-source-identities.md \
  src/core/source-identity.ts src/core/model.ts \
  src/core/source-descriptor.ts test/source-identity.test.ts
git commit -m "$(cat <<'EOF'
feat(core): open namespaced source identities

Add validated canonical identity primitives and explicit legacy projections
without changing built-in descriptor, Store, report, or parser values.

Co-Authored-By: Codex <noreply@openai.com>
EOF
)"
```

Do not use `--amend` or `--no-verify`, and do not push, open a PR, merge, or
clean up the worktree in this implementation turn.

- [ ] **Step 4: Confirm the committed handoff state**

Run:

```bash
git status --short
git log --oneline --decorate -3
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Expected: clean status, one feature commit above the recorded `origin/main`
base, all required docs committed, and no unrelated changes.
