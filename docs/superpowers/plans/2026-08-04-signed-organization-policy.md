# Signed Organization Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify a managed, signed organization policy and monotonically combine
its constraints with repository preferences and CLI requests before privacy or
advisory output decisions.

**Architecture:** A focused policy module validates and canonicalizes a closed
v1 organization contract, verifies a detached Ed25519 signature against managed
trust configuration, and reduces all layers into one effective policy. The
existing repository-config reader supplies optional tightening preferences;
analyze and stats consume the same resolver before projection or external
advisory execution.

**Tech Stack:** TypeScript 5.9, Node.js `crypto` and filesystem APIs, JSON Schema
draft 2020-12, existing ccprof privacy/advisory/config/CLI modules and Node test
runner.

---

## Scope boundary

- No export command, retention deletion, quota/store table, encryption provider,
  Report v3, remote policy fetch, key rotation service, RBAC, or audit subsystem.
- Report, Store, and package versions remain unchanged.
- Existing config v1 and ungoverned CLI behavior remain compatible.
- Logic changes are pushed only after an independent agent runs all applicable
  local GitHub Actions equivalents.

## Edge cases and invariants

- All four trust settings absent means ungoverned; any partial/blank set is a
  configured governance failure.
- Policy/key/signature reads, parsing, validation, organization binding, and
  verification fail closed with fixed content-free diagnostics.
- Trust files are no-follow regular files with stable identity and explicit
  64 KiB / 1 KiB / 16 KiB policy/signature/key caps.
- Only Ed25519 and strict 64-byte standard-base64 detached signatures are valid.
- Closed validation precedes fixed-order canonicalization; `$schema` is excluded.
- Strictest privacy, boolean AND, minimum retention, and maximum coverage are
  associative and deterministic; no lower layer can weaken an upper layer.
- Signed raw/advisory/export kill switches override allow flags and all lower
  layers. A denied advisory never invokes the external runner.
- Repository config keeps its existing test-map API and safe-file guarantees.
- CI strict remains strict; ungoverned output bytes do not change.

## Baseline and semantic impact evidence

An independent verifier established the clean `11a53b8` baseline before
implementation: production build exit 0, typecheck exit 0, full suite 670/670,
and TypeScript LanguageService analysis over 95 roots with zero diagnostics.

LanguageService semantic references are:

- `AnalyzeCommandDependencies`: 3 references;
- `AnalyzeCommandOptions`: 3 references;
- `StatsCommandDependencies`: 1 reference;
- `StatsCommandOptions`: 3 references;
- `runAnalyzeCommand`: 15 references;
- `runStatsCommand`: 6 references;
- `loadRepositoryConfig`: 11 references;
- `PrivacyProfile`: 18 references;
- `projectReportPrivacy`: 25 references;
- `projectStatsPrivacy`: 9 references;
- `requestAdvisory`: 6 references; and
- `runCli`: 49 references.

The result supports adding optional resolver seams only to the two dependency
interfaces. Options, command functions, privacy/advisory APIs, and the existing
`loadRepositoryConfig` wrapper remain unchanged; repository policy receives a
new separate loader.

### Task 1: Lock the signed policy and precedence contracts

**Files:**
- Create: `test/organization-policy.test.ts`
- Create: `schemas/organization-policy.schema.json`

- [ ] **Step 1: Write failing schema and canonicalization tests**

Add tests for the exact required fields, closed objects, optional complete kill
switches, organization grammar, privacy enum, retention safe-integer boundary,
coverage `[0,1]` boundary, fixed canonical key order, `$schema` exclusion, and
defensive-copy behavior.

- [ ] **Step 2: Delegate focused RED**

Run `npm run build:test` and, if compilation succeeds, run
`node --test .test-dist/test/organization-policy.test.js`. Expected: compilation
fails because the policy module and exports do not exist.

- [ ] **Step 3: Write failing verification and precedence tests**

Generate an Ed25519 pair in the test, sign canonical bytes, and assert genuine
verification. Add table-driven failures for partial configuration, missing and
oversized/symlinked/identity-changing files, malformed JSON, unknown/missing fields, future version, wrong
organization, non-Ed25519 key, invalid base64/length, modified policy, and wrong
key. Place unique canaries in every external value and assert no error contains
one. Add an exact precedence matrix for privacy, raw/advisory/export permissions,
kill switches, retention minimum, coverage maximum, and ungoverned defaults.

- [ ] **Step 4: Delegate RED confirmation**

Run the same focused command. Expected: failures are only missing policy APIs,
not fixture or test syntax errors. Commit the RED contract as
`test: define signed organization policy contract`.

### Task 2: Implement validation, verification, and monotonic resolution

**Files:**
- Create: `src/policy/organization-policy.ts`
- Create: `schemas/organization-policy.schema.json`
- Modify: `test/organization-policy.test.ts`

- [ ] **Step 1: Implement strict runtime validation and canonical bytes**

Define `OrganizationPolicy`, `OrganizationPolicyError`, closed-object validators,
fixed scalar/range checks, a defensive snapshot function, and
`canonicalOrganizationPolicy`. Keep all rejection messages fixed and free of
input values.

- [ ] **Step 2: Implement managed trust loading and Ed25519 verification**

Treat any partial environment tuple as configured failure. Bound the three
files, parse a strict base64 signature, require an Ed25519 public key, bind the
expected organization, and verify the canonical UTF-8 payload with
`node:crypto.verify`. Do not add network or cache behavior.

- [ ] **Step 3: Implement the effective-policy reducer**

Reduce organization, repository, and request layers using privacy rank/maximum,
boolean AND, retention minimum, coverage maximum, and signed kill switches.
Return a new effective value with no trust paths or material.

- [ ] **Step 4: Delegate GREEN and focused review**

Run the focused test and TypeScript LanguageService diagnostics. Expected: all
policy-contract tests pass with zero semantic diagnostics. Commit as
`feat: verify signed organization policy`.

### Task 3: Reuse repository config for tightening preferences

**Files:**
- Modify: `src/analysis/repository-config.ts`
- Modify: `schemas/config.schema.json`
- Modify: `test/organization-policy.test.ts`

- [ ] **Step 1: Write repository-preference RED tests**

Assert existing missing/v1/test-map results are unchanged. Assert a valid closed
`policy` object loads a defensive optional preference set, all scalar boundaries
match organization validation, and unknown/invalid values fail with the existing
path-relative `RepositoryConfigError` without canary leakage.

- [ ] **Step 2: Delegate RED**

Run the policy test plus `command-and-matcher.test.js`. Expected: the new config
key/loader is absent while all old repository-config tests remain green.

- [ ] **Step 3: Refactor one parsed document behind compatibility wrappers**

Extend the existing closed v1 config parser with optional `policy`, add
`loadRepositoryPolicyPreferences`, and preserve `loadRepositoryConfig`'s exact
`TestMap` return. Reuse the current single safe-reader implementation and update
the published config schema without changing its version.

- [ ] **Step 4: Delegate GREEN and commit**

Run the two focused tests and semantic diagnostics. Commit as
`feat: add repository policy preferences`.

### Task 4: Enforce policy before display and advisory execution

**Files:**
- Modify: `src/commands/analyze.ts`
- Modify: `src/commands/stats.ts`
- Modify: `test/organization-policy.test.ts`

- [x] **Step 1: Inspect shared signatures semantically**

Before edits, delegate TypeScript LanguageService reference discovery for
`AnalyzeCommandDependencies`, `AnalyzeCommandOptions`,
`StatsCommandDependencies`, `StatsCommandOptions`, `runAnalyzeCommand`, and
`runStatsCommand`; record counts/files and zero baseline diagnostics in this plan.

- [ ] **Step 2: Write analyze/stats RED tests**

Assert effective privacy strengthens raw output, stats uses the same floor,
denied advisory yields only `policy_advisory_disabled`, every allow/kill-switch
denial leaves the runner call count at zero, and an ungoverned resolver preserves
the current output exactly.

- [ ] **Step 3: Delegate RED**

Run the policy, advisory, and reporter/CLI focused tests. Expected: command
dependencies do not yet resolve policy and the advisory runner is called.

- [ ] **Step 4: Add one resolver seam to each command**

Resolve effective policy with the report/repository root before privacy
projection/advisory (analyze) and before history projection (stats). Use the
effective profile everywhere downstream. Skip denied advisory before calling
`requestAdvisory`, returning the fixed warning. Do not alter core analysis,
Store persistence, CLI syntax, or report shape.

- [ ] **Step 5: Delegate GREEN and commit**

Run the focused tests and semantic diagnostics. Commit as
`feat: enforce organization policy in output commands`.

### Task 5: Document and prove the bounded feature

**Files:**
- Modify: `README.md`
- Modify: `test/organization-policy.test.ts`

- [ ] **Step 1: Add operator documentation tests and README content**

Document the four managed settings, canonical detached-signature procedure,
required policy example, precedence/kill-switch behavior, fail-closed errors,
and the explicit deferred consumers. Assert both schemas remain packaged.

- [ ] **Step 2: Delegate focused/full validation**

Delegate build, typecheck, the focused policy/config/advisory/reporter tests,
the complete Node test suite, `git diff --check`, package smoke, and all
applicable commands identified by `/run-github-actions-locally`.

- [ ] **Step 3: Obtain two-stage review**

Request an independent specification review against this design and the bounded
acceptance scope, then a separate code-quality/security review. Fix only direct
P0-P2 issues in new commits and repeat review/validation until approved.

- [ ] **Step 4: Complete the PR lifecycle**

Fetch and rebase latest `origin/main`, repeat delegated local Actions if the
base changed, push `feature/signed-organization-policy`, create a PR against
`main`, monitor/fix remote CI and review, merge after green under the user's
pre-approval, then run `worktree-pr-flow:cleanup` to remove this worktree and
local feature branch.

## Plan self-review

- Every signed-policy field and bounded acceptance item maps to Tasks 1-4.
- Export/retention/coverage values are resolved but no excluded downstream
  subsystem is introduced.
- Production signatures named in Task 4 are subject to LanguageService impact
  discovery before edits.
- All production behavior follows RED -> delegated RED confirmation -> minimal
  GREEN -> delegated GREEN confirmation.
- No placeholders, local merge, amend, or owner-run test/static-analysis step is
  present.
