# Report v3 Namespaced Identities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the published Report v3 JSON Schema with the canonical instruction-resource scope and runtime namespaced source/capability identity contracts while retaining legacy compatibility.

**Architecture:** The schema alone changes: source adapter IDs become the union of the published lower-case token language and SourceAdapterId grammar; capability IDs become the union of six legacy tokens and Capability Descriptor v1 grammar. Both capability consumers reference one shared `$defs` node. Tests compile the actual Draft 2020-12 schema with AJV and validate complete report instances at each consumer location.

**Tech Stack:** JSON Schema Draft 2020-12, AJV 8, TypeScript, Node.js test runner, npm.

---

## File map

- `schemas/report-v3.schema.json`: add canonical identity definitions, preserve legacy branches, add the canonical scope, and preserve identity/version/closure.
- `test/report-schema-command.test.ts`: add strict AJV 2020 whole-schema behavioral assertions and shared-reference structure checks.
- `docs/superpowers/specs/2026-08-04-report-v3-schema-contract-design.md`: truthfully document the published contract and no-producer-impact boundary.
- `docs/superpowers/plans/2026-08-05-report-v3-namespaced-identities.md`: this plan.

### Task 1: Add failing consumer-level contract assertions

**Files:**

- Modify: `test/report-schema-command.test.ts`

- [ ] **Step 1: Import AJV 2020 and add a minimal valid complete Report-v3 fixture helper.** The helper supplies every required closed object with valid values, then tests mutate only `finding.scope`, `sources[0].adapter_id`, `sources[0].capabilities`, or `rule_coverage[0].missing_capabilities`.

```ts
import Ajv2020 from "ajv/dist/2020.js";

const validate = new Ajv2020({ strict: true }).compile(schema);
assert.equal(validate(reportV3Fixture()), true, JSON.stringify(validate.errors));
```

- [ ] **Step 2: Assert exact scope and schema identity facts.**

```ts
assert.equal(schema.$id, "https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/report-v3.schema.json");
assert.equal(property(schema, schema, "schema_version").const, 3);
assert.deepEqual(property(schema, finding, "scope").enum, [
  "this_pr", "separate_issue", "claude_md", "instruction_resource",
]);
```

- [ ] **Step 3: Assert actual AJV acceptance/rejection.** Accept source IDs `claude`, `codex`, `dummy-agent`, `ccprof.dev/adapters/claude`, and `dev.example.agent/adapters/dummy-agent`; reject uppercase, empty DNS/path segment, doubled slash, trailing slash, and a 256-character value. At both capability locations accept each legacy value plus `ccprof.dev/capabilities/tool_timestamps` and `dev.example.agent/capabilities/dummy-agent`; reject unknown bare tokens, uppercase/empty/wrong/missing/extra/trailing segments, and 256 characters.

- [ ] **Step 4: Assert structural sharing rather than duplicate behavior.**

```ts
assert.equal(sourceCapabilities.items.$ref, "#/$defs/capability");
assert.equal(missingCapabilities.items.$ref, "#/$defs/capability");
```

- [ ] **Step 5: Delegate RED to a fresh read-only Terra worker.**

Run: `npm test -- --test-name-pattern='published Report v3 schema'`

Expected: FAIL because the current schema lacks `instruction_resource`, canonical source IDs, and canonical capability IDs.

### Task 2: Apply minimal schema changes after RED

**Files:**

- Modify: `schemas/report-v3.schema.json`
- Test: `test/report-schema-command.test.ts`

- [ ] **Step 1: Add `sourceAdapterId` with the precise SourceAdapterId grammar and `maxLength: 255`, then add a union retaining `#/$defs/token`.**

```json
"sourceAdapterId": {
  "type": "string",
  "maxLength": 255,
  "pattern": "^(?:[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?:/[a-z][a-z0-9._-]{0,63})*$"
}
```

- [ ] **Step 2: Change the shared `capability` definition to an `anyOf` of the exact six legacy enum values and the precise Descriptor v1 grammar with `maxLength: 255`.**

```json
"pattern": "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?/capabilities/[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$"
```

- [ ] **Step 3: Add only `instruction_resource` to `finding.scope.enum`.** Do not change `$id`, `schema_version.const`, closure, production TypeScript, producers, CLI, Store, source runtime, adapter SDK, capability runtime, or rules.

- [ ] **Step 4: Delegate GREEN to a fresh read-only Terra worker.**

Run: `npm test -- --test-name-pattern='published Report v3 schema'`

Expected: PASS, including strict AJV validation at both public capability consumer locations.

### Task 3: Record the published contract and self-review

**Files:**

- Modify: `docs/superpowers/specs/2026-08-04-report-v3-schema-contract-design.md`

- [ ] **Step 1: Update the existing design spec.** State that scope is exactly the four listed values; source adapter IDs accept established legacy tokens or namespaced SourceAdapterId values; capabilities accept six legacy values or `<dns>/capabilities/<capability-name>` Descriptor v1 values; both arrays share one schema definition; canonical branches are limited to 255 characters; and this changes no runtime producer.

- [ ] **Step 2: Inspect the narrow diff.**

Run: `git diff --check origin/main...HEAD` and `git diff --name-only origin/main...HEAD`

Expected: no whitespace error and exactly the file-map paths; no `src/**/*.ts` rows; no more than ten files.

- [ ] **Step 3: Commit intentional increments without amend or verification bypass.**

```bash
git add docs/superpowers/plans/2026-08-05-report-v3-namespaced-identities.md test/report-schema-command.test.ts
git commit -m "test: define report v3 namespaced identity contract"
git add schemas/report-v3.schema.json test/report-schema-command.test.ts
git commit -m "feat: namespace report v3 identity schema"
git add docs/superpowers/specs/2026-08-04-report-v3-schema-contract-design.md
git commit -m "docs: describe report v3 namespaced identities"
```

### Task 4: Run local Actions before publication

**Files:**

- Verify only: workflow configuration and committed four-file diff.

- [ ] **Step 1: Read `/Users/tanakatakuto/.claude/commands/run-github-actions-locally/SKILL.md` fully.**
- [ ] **Step 2: Delegate workflow enumeration to one fresh read-only Terra worker.** Record every applicable execution unit and skip.
- [ ] **Step 3: Delegate every applicable local execution unit in the skill-required grouping/order to fresh read-only Terra worker(s).** Every executable unit passes; a skip is recorded only if inapplicable.
- [ ] **Step 4: If an in-scope failure occurs, make a new fix commit and repeat enumeration/execution with fresh workers.**
- [ ] **Step 5: Reconfirm allowed files, zero production-TypeScript diff, and clean status before push.**

### Task 5: Publish and observe the Ready PR

**Files:**

- Verify only: branch, PR, and GitHub checks.

- [ ] **Step 1: Push without force and create a Ready PR against `main`.**

```bash
git push -u origin codex/wave1-report-v3-namespaced-contract
gh pr create --base main --head codex/wave1-report-v3-namespaced-contract --title "feat: namespace Report v3 identities"
```

- [ ] **Step 2: Wait until every remote check is complete and green, then confirm `isDraft` is false.**

Run: `gh pr checks --watch` and `gh pr view --json number,url,isDraft,headRefName,baseRefName,statusCheckRollup`

Expected: all checks pass and the PR is Ready, not draft. Keep the worktree and branch for review follow-ups.

## Plan self-review

- [x] Required scope, legacy compatibility, both runtime grammars, 255-character limits, malformed values, shared capability definition, schema identity/version, closure, and no producer impact are mapped to concrete steps.
- [x] The file map is exactly the four allowed paths and contains no production TypeScript edits.
- [x] The RED/GREEN checks use actual strict AJV schema validation; local Actions and remote green checks gate publication.
- [x] The plan has no unresolved placeholders and uses consistent schema definition names.
