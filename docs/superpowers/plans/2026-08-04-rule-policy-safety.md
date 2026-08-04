# R004/R005 Policy-Safe Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep R004/R005 measurements while emitting concrete allowlist or parallel-invocation recommendations only under bounded, signed, monotonically tightened safety contracts.

**Architecture:** A focused `rule-safety` policy module validates and snapshots command patterns, safely canonicalizes raw action commands, performs bounded non-regex wildcard decisions, and resolves signed organization plus repository-tightening layers. R004 and R005 receive only one closed effective snapshot through an optional core-analysis callback; its canonical digest participates in snapshot identity while only the outer digest is stored. New semantics stay inside Finding evidence and epoch-2 manifests, preserving Report v2 and Store compatibility.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, Ed25519 `node:crypto`, Node test runner, JSON Schema draft 2020-12, existing Rule Manifest/Store/privacy pipeline.

---

## Execution rules

- Work only in `/Users/tanakatakuto/Documents/GitHub/ccprof/.worktrees/rule-policy-safety` on `feature/rule-policy-safety`.
- Read and follow `superpowers:test-driven-development` before each production change.
- The task implementer writes tests and code but does not run build, typecheck,
  lint, tests, or local Actions. A separate verifier subagent runs every command
  and returns the full exit status/counts.
- For every task: verify RED with a separate verifier, commit the RED tests,
  implement the minimum GREEN change, verify GREEN with a separate verifier,
  commit production, run a fresh specification review, then a separate quality
  review. Fix and re-review every finding before starting the next task.
- Do not amend commits or merge locally. Before push, delegate
  `/run-github-actions-locally`; only a clean result may be pushed.
- No Report v3, Store migration, workspace graph, new CLI flag, backfill, regex
  policy engine, shell execution, or policy-content diagnostic belongs here.

## File map

- Create `src/policy/rule-safety.ts`: closed snapshots, limits, normalization,
  bounded wildcard matching, independent command safety, layered decisions.
- Modify `src/policy/organization-policy.ts`: signed nested contracts,
  canonical bytes, effective rule-safety snapshot.
- Modify `src/analysis/repository-config.ts`: repository tightening contracts.
- Modify `schemas/organization-policy.schema.json` and
  `schemas/config.schema.json`: published structural shapes/bounds plus explicit
  vendor annotations for runtime-only semantic constraints.
- Modify `src/analysis/timeline.ts`: carry an approved tool command into the
  causally corresponding human-wait action.
- Modify `src/rules/human-wait.ts`: R004 split evidence and observe-only impact.
- Modify `src/rules/serial-slack.ts`: R005 domain decision and gated recipes.
- Modify `src/core/analyze.ts` and `src/commands/analyze.ts`: optional effective
  rule-policy plumbing with existing policy resolver caching.
- Modify `src/rules/manifest.ts`: R004/R005 epoch-2 semantic contracts.
- Modify focused tests in `test/organization-policy.test.ts`,
  `test/rules-primary.test.ts`, `test/rules-secondary.test.ts`,
  `test/analyze-integration.test.ts`, `test/rule-manifest.cases.ts`,
  `test/capability-coverage.test.ts`, `test/store.test.ts`, and
  `test/reporters-and-cli.test.ts`.
- Create `test/rule-policy-safety.test.ts`: matcher, snapshot, and decision
  boundary tests.
- Modify `README.md`: operator policy format and recommendation semantics.

### Task 1: Add the bounded rule-safety policy kernel

**Files:**
- Create: `src/policy/rule-safety.ts`
- Create: `test/rule-policy-safety.test.ts`

- [ ] **Step 1: Write failing contract, hostile-input, and matcher tests**

Import the wished-for API and cover normalized literals/wildcards, bounds,
whole-string anchoring, regex punctuation as literals, command safety, defensive
copies, repository intersection, absent organization denial, ambiguity, false,
cross-domain groups, and one whole-decision work budget:

```ts
import {
  approvalRecommendationDecision,
  canonicalRuleSafetySnapshot,
  commandPatternMatches,
  compareUtf8,
  createDecisionBudget,
  normalizeCommandPattern,
  resolveRuleSafetyPolicy,
  resourceDomainDecision,
  safeCanonicalCommand,
  snapshotApprovalRulePolicy,
  snapshotEffectiveRuleSafetyPolicy,
  snapshotRepositoryApprovalRulePolicy,
  snapshotResourceDomains,
} from "../src/policy/rule-safety.js";

assert.equal(normalizeCommandPattern("  npm\t test  "), "npm test");
assert.equal(normalizeCommandPattern("rg *** src"), "rg * src");
assert.equal(commandPatternMatches(
  "npm test", "npm *", createDecisionBudget()), true);
assert.equal(commandPatternMatches(
  "npm test extra", "npm test", createDecisionBudget()), false);
assert.equal(commandPatternMatches(
  "rg [a]", "rg [a]", createDecisionBudget()), true);
assert.equal(safeCanonicalCommand("npm test"), "npm test");
assert.equal(safeCanonicalCommand("CI=1 npm test"), undefined);
assert.ok(compareUtf8("z", "ä") < 0);

const effective = resolveRuleSafetyPolicy(
  {
    safe_patterns: ["npm *"],
    allow_rule_recommendation: true,
  },
  [{ match: ["npm test"], domain: "node-workspace", parallel_safe: true }],
  { safe_patterns: ["npm test"] },
  [{ match: ["npm test"], domain: "node-workspace", parallel_safe: false }],
);
assert.deepEqual(
  approvalRecommendationDecision(["npm test"], effective),
  {
    kind: "evaluated",
    commands: [{ allowed: true, canonical_command: "npm test" }],
  },
);
assert.deepEqual(
  resourceDomainDecision(["npm test", "npm test"], effective),
  { kind: "parallel_unsafe", domain: "node-workspace" },
);
assert.deepEqual(resourceDomainDecision([undefined], effective), {
  kind: "investigation_candidate",
});
```

Use proxies, revoked proxies, accessors, sparse arrays, symbols, normalization
duplicates, 65-entry arrays, 257-byte raw and normalized patterns, 17
wildcards, invalid domains, and canary strings. Assert validation throws only
`invalid rule safety policy` and never invokes a getter or includes a canary.
Check 256 UTF-8-byte patterns pass and 257-byte patterns fail on both sides of
normalization; an O(1) code-unit length guard must precede the raw byte preflight,
which itself must reject before normalization work.

Treat `safeCanonicalCommand(raw)` as the sole safety entrance for both rule
decisions. Assert `rm -rf .`, unknown commands, assignments, `env`/`command`
wrappers, redirects, composites, opaque commands, and mutating Git commands
remain denied even under `*`; known test/build/check/inspect and conservative
read-only Git commands may pass. On Windows, admit only the fixed bare-basename
map (`npm.cmd`, `pnpm.cmd`, `yarn.cmd`, `bun.exe`, `cargo.exe`, `git.exe`,
`node.exe`, `rg.exe`) with ASCII case-insensitive suffixes. Reject `.bat`, paths,
and every unlisted `.cmd`/`.exe` name.

Prove normalization and policy ordering use an explicit UTF-8 byte comparator,
never `localeCompare`, over the full resource-domain tuple `(domain, normalized
match array, parallel_safe)` with `false` before `true`. Exact duplicate tuples
and duplicate normalized patterns are invalid. Different tuples with the same
domain may load, but if more than one entry matches an action the decision is
ambiguous and returns `investigation_candidate`.

Exercise the closed effective-policy snapshot and mutate every source and
returned nested array; the snapshot and fresh resolution must remain unchanged.
Exercise the fixed whole-decision limits: 64 actions accepted/65 denied, 32
distinct raw commands accepted/33 denied, repeated commands canonicalized once,
and 65,536 matcher/decision steps accepted while the next required step makes
the result deny/investigate. A decision must never authorize an actionable
prefix after exhausting its budget.

- [ ] **Step 2: Delegate RED verification**

Have a separate verifier run:

```bash
npm run build:test
```

Expected: nonzero with `TS2307` for `src/policy/rule-safety.js`; no unrelated
compiler failure. After the module exists only as needed for test compilation,
delegate:

```bash
node --test .test-dist/test/rule-policy-safety.test.js
```

Expected: assertions fail because normalization, matching, and decisions are
not implemented. Commit the verified RED tests as:

```bash
git add test/rule-policy-safety.test.ts
git commit -m "test: define rule safety policy kernel"
```

- [ ] **Step 3: Implement exact types, snapshots, and bounded decisions**

Create these public contracts and limits in `src/policy/rule-safety.ts`:

```ts
export interface ApprovalRulePolicy {
  safe_patterns: string[];
  allow_rule_recommendation: boolean;
}
export interface RepositoryApprovalRulePolicy {
  safe_patterns?: string[];
  allow_rule_recommendation?: boolean;
}
export interface ResourceDomainPolicy {
  match: string[];
  domain: string;
  parallel_safe: boolean;
}
export interface EffectiveRuleSafetyPolicy {
  approval?: {
    allow_rule_recommendation: boolean;
    organization_safe_patterns: string[];
    repository_safe_patterns?: string[];
  };
  organization_resource_domains: ResourceDomainPolicy[];
  repository_resource_domains?: ResourceDomainPolicy[];
}
export type ResourceDomainDecision =
  | { kind: "parallel_safe" | "parallel_unsafe"; domain: string }
  | { kind: "investigation_candidate" };
export type ApprovalRecommendationDecision =
  | {
      kind: "evaluated";
      commands: Array<
        | { allowed: true; canonical_command: string }
        | { allowed: false }
      >;
    }
  | { kind: "denied" };

const MAX_PATTERNS = 64;
const MAX_DOMAINS = 64;
const MAX_DOMAIN_PATTERNS = 32;
const MAX_PATTERN_BYTES = 256;
const MAX_WILDCARDS = 16;
const MAX_COMMAND_BYTES = 4_096;
const MAX_DECISION_ACTIONS = 64;
const MAX_UNIQUE_COMMANDS = 32;
const MAX_DECISION_STEPS = 65_536;
const DOMAIN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
```

Use `utilTypes.isProxy`, `Reflect.ownKeys`, and data-property descriptors for
every object/array snapshot. Reject non-plain prototypes, accessors, holes,
symbols, unknown keys, normalized duplicates, and all bounds with one fixed
`RuleSafetyPolicyValidationError("invalid rule safety policy")`.

Before normalization, apply UTF-8 byte preflights to raw patterns and raw
commands. Re-check normalized pattern bytes after NFC/whitespace normalization.
Implement normalization without input-derived regex matching. A static
whitespace expression may normalize whitespace; the wildcard matcher itself is
a greedy index algorithm that spends from the caller's shared budget for every
loop/character comparison:

```ts
export interface DecisionBudget {
  remaining: number;
  exhausted: boolean;
}

export function createDecisionBudget(): DecisionBudget;

export function commandPatternMatches(
  canonicalCommand: string,
  normalizedPattern: string,
  budget: DecisionBudget,
): boolean {
  if (Buffer.byteLength(canonicalCommand, "utf8") > MAX_COMMAND_BYTES) {
    return false;
  }
  let commandIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let retryCommandIndex = 0;
  while (commandIndex < canonicalCommand.length) {
    if (!spend(budget)) return false;
    if (
      patternIndex < normalizedPattern.length &&
      normalizedPattern[patternIndex] === canonicalCommand[commandIndex]
    ) {
      patternIndex += 1;
      commandIndex += 1;
    } else if (normalizedPattern[patternIndex] === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      retryCommandIndex = commandIndex;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      retryCommandIndex += 1;
      commandIndex = retryCommandIndex;
    } else {
      return false;
    }
  }
  while (normalizedPattern[patternIndex] === "*") {
    if (!spend(budget)) return false;
    patternIndex += 1;
  }
  return patternIndex === normalizedPattern.length;
}
```

`safeCanonicalCommand(raw)` performs an O(1) code-unit length guard and then the
byte preflight before `classifyCommand`/`tokenizeCommand`; when called by a
decision it charges raw code-unit length plus fixed classifier stages to the
shared budget before invoking those bounded helpers. It rejects stripped wrappers/assignments,
opaque/composite/redirected values, unsafe or unknown executables, and admits
only test/build/check/inspect plus conservative read-only Git subcommands and
the fixed Windows mapping above. Neither R004 nor R005 may pass an already
canonicalized string around this function.

Create one budget and one raw-command memo cache per whole decision. Reject an
over-limit action set before scanning; count all policy elements, entry visits,
raw-command canonicalization charges, and matcher character comparisons against
the same 65,536-step budget.
`approvalRecommendationDecision` accepts the complete ordered raw-command list
and returns either one allow/deny item per input or `{ kind: "denied" }`. The
latter applies to action, distinct-command, or step overflow, so no actionable
prefix survives. `resourceDomainDecision` likewise returns
`investigation_candidate` on overflow. Resolve approval against organization
patterns and, when present, repository patterns. Resolve domains independently
per layer; require exactly one matching entry per command (including
same-domain entries), exactly one same domain in the repository layer when
present, one domain across the whole action group, and logical-AND safety.
`snapshotEffectiveRuleSafetyPolicy` copies the fully resolved object once and
is the only detector-facing policy. `canonicalRuleSafetySnapshot` produces the
same sorted, closed value for identity hashing without exposing raw inputs.

- [ ] **Step 4: Delegate GREEN verification and commit**

Have a separate verifier run:

```bash
npm run build:test
node --test .test-dist/test/rule-policy-safety.test.js
```

Expected: exit 0 and every focused test passes with no warning. Inspect the
diff for policy-content literals, `new RegExp`, process spawning, globbing, or
filesystem calls; none may exist. Commit:

```bash
git add src/policy/rule-safety.ts test/rule-policy-safety.test.ts
git commit -m "feat: add bounded rule safety policy kernel"
```

- [ ] **Step 5: Run specification then quality review**

The specification reviewer checks every bound, hostile input, monotonic rule,
and deny path from the design. After approval, a different quality/security
reviewer checks linear matching, descriptor safety, copy isolation, fixed
errors, and absence of execution/I/O. Fix through the same RED/GREEN delegation
and obtain both re-approvals.

### Task 2: Extend signed and repository policy schemas monotonically

**Files:**
- Modify: `src/policy/organization-policy.ts`
- Modify: `src/analysis/repository-config.ts`
- Modify: `schemas/organization-policy.schema.json`
- Modify: `schemas/config.schema.json`
- Modify: `test/organization-policy.test.ts`

- [ ] **Step 1: Write failing schema, canonical-byte, and merge tests**

Extend the existing exact-key tests with `approval_policy` and
`resource_domains`. Assert old policies retain byte-identical canonical JSON.
Assert a new signed policy canonicalizes exactly in this order:

```text
policy_schema_version, organization, minimum_privacy, allow_raw,
allow_advisory, allow_export, raw_retention_days_max,
required_source_coverage, approval_policy, resource_domains, kill_switches
```

Add genuine Ed25519 verification for the new payload. Add repository tests for
optional nested approval fields and domain arrays. Add organization/repository
unknown fields, hostile getters/proxies, every bound, and secret canaries. Lock
the existing signed-file raw byte limit: exactly 65,536 bytes reaches parsing
and 65,537 bytes returns the content-free unreadable result. Independently
construct programmatic policy values whose canonical signed payload is exactly
65,536 bytes (accepted) and 65,537 bytes (rejected content-free). Cover 256/257
UTF-8-byte raw and normalized patterns and prove multibyte boundaries are
measured as bytes, not JavaScript string length.
Extend precedence assertions so the effective result contains a
`rule_safety` snapshot only when a signed organization policy exists; repository
false/pattern/domain constraints narrow it, while repository-only true values
cannot authorize anything.

Treat the JSON Schemas as a structural interoperability contract, not an exact
copy of runtime semantics. Schema tests cover common object/array/type/declared
bounds and require an `x-ccprof-runtime-constraints` annotation plus README
cross-reference for UTF-8 byte limits, NFC/whitespace duplicate detection,
descriptor/proxy rejection, canonical-payload bytes, tuple ordering, and
monotonic merge rules. Test schema/runtime agreement only on that shared
structural surface; test runtime-only semantics separately.

- [ ] **Step 2: Delegate RED verification and commit**

Delegate:

```bash
npm run build:test
node --test .test-dist/test/organization-policy.test.js \
  .test-dist/test/rule-policy-safety.test.js
```

Expected: build or focused assertions fail because both closed schemas and
runtime snapshots reject the new fields and the new boundary/annotation
contracts are missing. Commit verified RED tests/schema expectations:

```bash
git add test/organization-policy.test.ts
git commit -m "test: define signed rule safety contracts"
```

- [ ] **Step 3: Implement schema/runtime/canonical integration**

Add to `OrganizationPolicy`:

```ts
approval_policy?: ApprovalRulePolicy;
resource_domains?: ResourceDomainPolicy[];
```

Add to `RepositoryPolicyPreferences`:

```ts
approval_policy?: RepositoryApprovalRulePolicy;
resource_domains?: ResourceDomainPolicy[];
```

Use the Task 1 snapshot helpers inside both parsers and translate their fixed
validation error into the existing content-free `invalid_policy` or
`RepositoryConfigError("policy contains invalid values")`. Snapshot repository
preferences before merge instead of reading nested getters. Append optional
canonical fields without changing bytes when absent. Before signature parsing,
retain the existing 65,536-byte raw signed-file cap. After deterministic
canonicalization, enforce a separate 65,536-byte canonical signed-payload cap,
including for programmatic inputs. Neither failure may echo policy content.
Extend `EffectivePolicy` with:

```ts
rule_safety?: EffectiveRuleSafetyPolicy;
```

and populate it only via `resolveRuleSafetyPolicy` when the signed organization
argument exists. Update both JSON Schemas with closed nested objects and the
structural item/string bounds representable in JSON Schema. Add
`x-ccprof-runtime-constraints` annotations naming the runtime-only UTF-8/NFC,
duplicate, hostile-descriptor, canonical-payload, ordering, and merge checks;
do not claim exact schema/runtime parity.

- [ ] **Step 4: Delegate GREEN verification and commit**

Delegate the Task 2 focused commands again. Expected: exit 0, existing old-byte
tests and all new signature/schema/merge tests pass. Commit:

```bash
git add src/policy/organization-policy.ts src/analysis/repository-config.ts \
  schemas/organization-policy.schema.json schemas/config.schema.json \
  test/organization-policy.test.ts
git commit -m "feat: extend signed rule safety policy"
```

- [ ] **Step 5: Run specification then quality/security review**

Require shared structural schema/runtime agreement, explicit annotation of all
runtime-only constraints, old canonical-byte stability, signed raw/canonical
64KiB boundary coverage, genuine signature coverage, absent/invalid denial,
repository-only denial, and logical-AND tightening. Then separately review
descriptor safety, content-free errors, UTF-8 byte accounting, mutation
isolation, and full-tuple canonical ordering via the locale-independent
comparator.

### Task 3: Split R004 into observe-only policy-latency evidence

**Files:**
- Modify: `src/analysis/timeline.ts`
- Modify: `src/rules/human-wait.ts`
- Modify: `test/rules-primary.test.ts`
- Modify: `test/ledger.test.ts`

- [ ] **Step 1: Write failing timeline, classification, recipe, and ledger tests**

Add a real timeline fixture proving an approval tool command is copied to the
causal `human_wait` action, but unrelated prompts do not borrow it. Replace the
single R004 expectation with cases for:

```ts
assert.equal(generic.evidence.latency_classification,
  "approval_policy_latency");
assert.deepEqual(generic.impact, {
  lower_ms: 0,
  upper_ms: observedApprovalMs,
  kind: "critical_path_latency",
});
assert.doesNotMatch(generic.fix_recipe.suggestion, /allowlist/iu);

assert.equal(repeated.evidence.latency_classification,
  "repeated_safe_approval_latency");
assert.deepEqual(repeated.evidence.canonical_commands, ["npm test"]);
assert.match(repeated.fix_recipe.suggestion, /allowlist/iu);
```

Cover one occurrence, phrase-only/missing command, organization absent,
organization deny, repository deny/intersection, unsafe wildcard `*` with
`rm -rf .`, unknown, assignment, redirect, and composite commands. Assert two
authorized occurrences classify repeated-safe; three occurrences remain one
deterministically aggregated candidate. Add timeline fixtures with one
approval-bearing tool use at the pending assistant timestamp (bound normally)
and two or more such uses at the same timestamp. The latter must set a fixed
ambiguous sentinel, omit the command, and remain generic under every tool-event
permutation; a later event may never overwrite that ambiguity.

Assert no-approval human wait produces one zero-impact generic observation.
For a positive observed duration, R004 uses the upper bound shown above. For a
zero observation it must project to `{ lower_ms: 0, upper_ms: 0 }`, a point-zero
harmless candidate rather than an `upper_only` candidate. In ledger tests,
prove positive R004 candidates are upper-only, every R004 candidate attributes
zero recoverable milliseconds, and none can reduce `estimated_floor_min`.
Exercise the whole-decision action/distinct-command/step limits and require a
generic result on every overflow. The exact generic sentence must not contain
the token `allowlist`, including in a negated sentence.

- [ ] **Step 2: Delegate RED verification and commit**

Delegate:

```bash
npm run build:test
node --test .test-dist/test/rules-primary.test.js \
  .test-dist/test/ledger.test.js
```

Expected: focused failures show the command is missing/ambiguously overwritten
in human wait, R004 is not split, uses a point lower bound for positive waits,
and still emits an unconditional allowlist recipe. Commit:

```bash
git add test/rules-primary.test.ts test/ledger.test.ts
git commit -m "test: define policy-safe R004 behavior"
```

- [ ] **Step 3: Carry causal commands and implement the R004 split**

Extend internal `PendingAssistant` with a tri-state approval binding:
`none | one defensive ToolUseEvent | ambiguous`. When the first approval-bearing
tool use shares the pending assistant timestamp, bind it. A second
approval-bearing use at that timestamp irreversibly switches to `ambiguous`,
regardless of arrival order; later uses cannot replace it. On the following
genuine-user event, pass the command only for `one`. For `ambiguous`, omit the
command and set a fixed `approval_command_ambiguous: true` sentinel on the
internal `AttributedTimelineAction`. Keep tool-event permutations byte-stable.

Extend `HumanWaitOptions` with optional `ruleSafety`. Pass the complete ordered
list of approval-action raw commands to `approvalRecommendationDecision` once.
If it returns `{ kind: "denied" }`, classify the complete group as generic. If
it returns per-action decisions, group allowed canonical commands and mark a
canonical command repeated only when its allowed group has at least two
actions; all denied items stay generic. Partition approvals into repeated-safe
and generic arrays. A small
candidate builder must use the positive-duration interval below and point zero
when `recoverable.estimated_ms === 0`:

```ts
impact: {
  lower_ms: 0,
  upper_ms: recoverable.estimated_ms,
  kind: "critical_path_latency",
}
```

Use fixed targets `approval-policy-latency` and
`repeated-safe-approval-latency`, fixed evidence classification strings, sorted
canonical commands only on the authorized candidate, `policy_dependent: true`,
and `ccprof --json` verification. Use a generic sentence such as `Review whether
the measured approval latency is required by policy before changing
permissions.` It must not contain the word `allowlist` at all. Repeated-safe
text may name sorted canonical commands and propose an allowlist change for
administrator review. Any ambiguous binding or decision-budget overflow must
remain generic and omit canonical commands.

- [ ] **Step 4: Delegate GREEN verification and commit**

Delegate the Task 3 focused commands. Expected: exit 0, timeline/R004/ledger
tests pass, and no R001-R003/R006-R008 expectation changes. Commit:

```bash
git add src/analysis/timeline.ts src/rules/human-wait.ts \
  test/rules-primary.test.ts test/ledger.test.ts
git commit -m "feat: classify approval policy latency safely"
```

- [ ] **Step 5: Run specification then quality/security review**

First verify the exact two classifications, repeat threshold, signed gating,
no generic `allowlist` token, positive upper-only versus zero point-zero impact,
and zero ledger attribution. Then separately review causal association,
irreversible same-timestamp ambiguity, permutation invariance, command
lifetime/aliasing, deterministic partitions, shared-budget overflow denial,
unsafe-command denial, and evidence privacy.

### Task 4: Gate R005 parallel recipes on one explicit resource domain

**Files:**
- Modify: `src/rules/serial-slack.ts`
- Modify: `test/rules-secondary.test.ts`

- [ ] **Step 1: Write failing domain classification and recipe tests**

Keep existing upper-estimate assertions and add these policy matrices:

- signed same domain + every `true` -> `parallel_safe`, exact domain evidence,
  concrete `parallel tool invocation` recipe;
- signed `false` -> `parallel_unsafe`, same upper estimate, recipe explicitly
  says no parallel invocation is recommended;
- no signed policy, no match, one command matching two domains, commands in two
  domains, two matching entries with the same domain, repository
  missing/different/ambiguous domain, native tool with no command,
  unsafe/unknown raw command -> `investigation_candidate` and no concrete
  parallel recipe;
- signed `true` plus repository same-domain `false` -> `parallel_unsafe`;
- signed `false` plus repository `true` stays `parallel_unsafe`;
- assignments, `env`/`command` wrappers, redirects, composites, opaque
  commands, unknown executables, `.bat`, and arbitrary `.cmd`/`.exe` names stay
  investigation candidates even when a signed `*` pattern matches; the fixed
  Windows bare-basename map has explicit positive cases;
- 64 actions and 32 distinct raw commands stay within their independent test
  fixtures, while 65 actions, 33 distinct commands, or the first step beyond
  the 65,536 shared budget always yields `investigation_candidate`;
- input action order does not change classification, domain, evidence arrays,
  finding key, or upper estimate.

Assert every case remains `impact.kind === "resource_cost"`, `lower_ms === 0`,
and `upper_ms === serial_duration_ms - longest_action_ms`. Give every R005
candidate the neutral title `Path-disjoint tool calls ran serially`. For
`parallel_unsafe` and `investigation_candidate`, assert title/summary/recipe do
not say the actions are independent, parallelizable, or safe.

- [ ] **Step 2: Delegate RED verification and commit**

Delegate:

```bash
npm run build:test
node --test .test-dist/test/rules-secondary.test.js
```

Expected: failures show unconditional concrete parallel recipes and missing
classification/domain evidence. Commit:

```bash
git add test/rules-secondary.test.ts
git commit -m "test: define resource-domain R005 behavior"
```

- [ ] **Step 3: Implement domain decisions without changing detection/estimate**

Extend `SerialSlackOptions` with optional `ruleSafety`. After the existing group
and upper-claim calculation, pass the action raw commands directly to
`resourceDomainDecision`. That shared decision function is the only place that
may call `safeCanonicalCommand`, and it owns one memo cache and one bounded work
budget for the whole group. Do not pre-canonicalize or bypass its reject paths.
Add:

```ts
parallelization_classification: decision.kind,
...(decision.kind === "investigation_candidate"
  ? {}
  : { resource_domain: decision.domain }),
```

to evidence. Use `Path-disjoint tool calls ran serially` as the common neutral
title and select one of three fixed summaries/recipes. Only `parallel_safe` may
say the actions are independent or parallelizable or contain the phrase
`parallel tool invocation`; unsafe and investigation text must not assert
independence, parallelizability, safety, or achievable speedup. Do not change
`eligibleAction`, `groupsForAgent`, `upperClaim`, target construction, or
sorting except for importing the shared safety helper.

- [ ] **Step 4: Delegate GREEN verification and commit**

Delegate the focused Task 4 command. Expected: exit 0 and all historical path,
read-only, mapped-validation, grouping, identity, and upper-estimate tests still
pass. Commit:

```bash
git add src/rules/serial-slack.ts test/rules-secondary.test.ts
git commit -m "feat: gate parallel recipes by resource domain"
```

- [ ] **Step 5: Run specification then quality/security review**

The first reviewer verifies exact true/false/unknown/ambiguous/multiple-domain
semantics, including multiple matches with the same domain, shared-budget
overflow denial, and unchanged upper math. The second checks raw-command-only
safety entry, fixed Windows normalization, neutral unsafe/investigation text,
that no path-disjointness shortcut or input order can produce a concrete
recipe, and that no policy pattern is serialized.

### Task 5: Plumb one cached effective policy into core analysis

**Files:**
- Modify: `src/core/analyze.ts`
- Modify: `src/commands/analyze.ts`
- Modify: `test/analyze-integration.test.ts`
- Modify: `test/organization-policy.test.ts`
- Modify: `test/capability-coverage.test.ts`
- Modify: `test/store.test.ts`

- [ ] **Step 1: Write failing command/core integration tests**

Capture the `AnalyzeOptions` passed by `runAnalyzeCommand`, invoke its wished-for
rule-policy callback with the canonical report repository, and assert it returns
the same defensive `EffectivePolicy.rule_safety` used by output/advisory policy
resolution. Assert one repository causes one underlying resolver call even when
both analysis and rendering ask for policy. Add actual core analysis fixtures
showing an injected signed rule-safety snapshot reaches R004 and R005; omitting
the callback yields generic/investigation output. Assert an invalid configured
resolver rejects before any policy-sensitive recipe can be persisted.

Add snapshot-identity coverage using the existing persisted-policy-digest
helpers. Immediately after PR-context resolution, the callback must resolve and
`snapshotEffectiveRuleSafetyPolicy` exactly once, before an active-budget early
return. Equivalent reordered policy inputs produce the same digest; changing a
normalized effective value changes it; an absent policy uses an explicit
canonical `{ mode: "absent" }` marker. Mutating the callback's source object
after resolution must change neither detector behavior nor identity.

Persist an analysis through the Store with secret canaries in raw policy
patterns and source objects. Assert the serialized envelope contains only the
outer 64-hex `SnapshotIdentity.policy_digest` and contains none of the canary,
raw patterns, domains, raw commands, canonical snapshot, or nested policy
object.

- [ ] **Step 2: Delegate RED verification and commit**

Delegate:

```bash
npm run build:test
node --test .test-dist/test/analyze-integration.test.js \
  .test-dist/test/organization-policy.test.js \
  .test-dist/test/capability-coverage.test.js \
  .test-dist/test/store.test.js
```

Expected: compilation/assertion failure because `AnalyzeOptions` has no
`resolveRuleSafetyPolicy` and detectors receive no rule-safety option. Commit:

```bash
git add test/analyze-integration.test.ts test/organization-policy.test.ts
git commit -m "test: define rule policy analysis plumbing"
```

- [ ] **Step 3: Implement optional cached plumbing**

Add to `AnalyzeOptions`:

```ts
resolveRuleSafetyPolicy?: (
  repoRoot: string,
) => Promise<EffectiveRuleSafetyPolicy | undefined>;
```

Immediately after canonical PR context resolution, invoke the callback once
when present, before the first budget-based early return. Pass the returned
value through `snapshotEffectiveRuleSafetyPolicy`; this one closed clone is the
sole object used by detectors and digest construction. Reject malformed,
over-limit, proxy, accessor, or otherwise non-snapshotable results with the
fixed content-free validation error. Pass the snapshot through `ruleCandidates`
to both detector options:

```ts
...(ruleSafety === undefined ? {} : { ruleSafety }),
```

In `runAnalyzeCommand`, reuse the existing memoized `policyFor` closure:

```ts
resolveRuleSafetyPolicy: async (repoRoot) =>
  (await policyFor(repoRoot)).rule_safety,
```

Only include this property when using core analysis; preserve injected analyze
dependency compatibility and exact optional-property behavior. The callback
must run before an active-budget early return so a configured trust failure
cannot fall back to an ungoverned partial report.

Derive a private rule-safety digest from canonical effective values, never raw
input order or raw strings:

```ts
const ruleSafetyDigest = analysisDigest(
  "effective-rule-safety-v1",
  ruleSafety === undefined
    ? { mode: "absent" }
    : canonicalRuleSafetySnapshot(ruleSafety),
);
```

Add only `{ rule_safety_digest: ruleSafetyDigest }` to the object already hashed
by `snapshotIdentity(...)` into its outer `policy_digest`. Do not add a public
`AnalysisSnapshotIdentity` field. Never place raw/canonical patterns, domains,
commands, the effective snapshot, or the inner digest elsewhere in the report
or Store.

- [ ] **Step 4: Delegate GREEN verification and commit**

Delegate the Task 5 focused commands. Expected: exit 0, resolver count exactly
one per repository, concrete output only with injected signed authorization,
and existing advisory/privacy behavior unchanged. Commit:

```bash
git add src/core/analyze.ts src/commands/analyze.ts \
  test/analyze-integration.test.ts test/organization-policy.test.ts \
  test/capability-coverage.test.ts test/store.test.ts
git commit -m "feat: apply effective policy to rule recommendations"
```

- [ ] **Step 5: Run specification then quality review**

Check trust failure ordering, one closed snapshot, cache identity, direct-core
deny defaults, absent marker, normalized/reordered digest equivalence, mutation
isolation, analysis-budget behavior, and Store canary absence. Then review
dependency direction, exact optional properties, callback lifetime, custom
dependency compatibility, and that only the outer digest is persisted.

### Task 6: Publish epoch-2 manifests and prove all compatibility boundaries

**Files:**
- Modify: `src/rules/manifest.ts`
- Modify: `test/rule-manifest.cases.ts`
- Modify: `test/store.test.ts`
- Modify: `test/reporters-and-cli.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing manifest, Store, reporter, privacy, and docs tests**

Update only the R004/R005 expected manifest rows:

```ts
{
  id: "R004",
  version: "2.0.0",
  compatibility_epoch: 2,
  impact_kind: "policy_latency",
  default_mode: "observe_only",
  aggregation_policy: "never_aggregate",
  evidence_schema: "ccprof://rules/R004/evidence/v2",
  policy_risk: "high",
}
{
  id: "R005",
  version: "2.0.0",
  compatibility_epoch: 2,
  impact_kind: "resource_cost",
  default_mode: "enabled",
  aggregation_policy: "max",
  evidence_schema: "ccprof://rules/R005/evidence/v2",
  policy_risk: "medium",
}
```

Assert new R004/R005 finding keys use epoch-2 preimages and differ from explicit
epoch-1 keys. Save/load explicit epoch-1 findings and legacy findings without
metadata unchanged. Render generic/repeated-safe R004 and all three R005
classifications through JSON, TTY, and Markdown. Strict output must contain no
canonical command, domain-policy pattern, or policy field; balanced output must
sanitize command canaries; raw output retains permitted evidence. README tests
must require the new signed/repository JSON examples, observe-only warning,
resource-domain ambiguity rules (including multiple matching entries with one
domain), structural-schema versus runtime-semantics contract and vendor
annotation, UTF-8/raw/canonical/budget limits, fixed Windows launcher mapping,
no-shell/non-regex statement, R004 point-zero behavior, neutral R005 unsafe
language, digest-only persistence, and legacy compatibility.

- [ ] **Step 2: Delegate RED verification and commit**

Delegate:

```bash
npm run build:test
node --test .test-dist/test/rule-manifest.cases.js \
  .test-dist/test/store.test.js \
  .test-dist/test/reporters-and-cli.test.js \
  .test-dist/test/docs.test.js
```

Expected: exact manifest/docs/privacy assertions fail while existing epoch-1
Store reads still pass. Commit:

```bash
git add test/rule-manifest.cases.ts test/store.test.ts \
  test/reporters-and-cli.test.ts test/docs.test.ts
git commit -m "test: lock rule safety compatibility boundaries"
```

- [ ] **Step 3: Implement manifest epochs and operator documentation**

Refactor the internal manifest rows so version and epoch are explicit per row;
keep all six unaffected rules at `1.0.0`/epoch 1. Set only R004/R005 to the
exact Task 6 values. Do not add a new manifest field or change the public CLI
shape.

Extend the signed policy README example with:

```json
"approval_policy": {
  "safe_patterns": ["cargo test", "npm test"],
  "allow_rule_recommendation": true
},
"resource_domains": [
  {
    "match": ["npm run build", "npm test"],
    "domain": "node-workspace",
    "parallel_safe": false
  },
  {
    "match": ["cat *", "git show *", "rg *"],
    "domain": "read-only",
    "parallel_safe": true
  }
]
```

Document repository values as intersections, signed-policy absence as deny,
positive-duration R004 as upper-only policy latency and zero duration as a
point-zero harmless observation, and R005 unknown/ambiguous cases as
investigation candidates with a neutral title. State that policy lists use the
locale-independent UTF-8 byte comparator over the full tuple and that exact
duplicates are rejected. List the 65,536-byte raw signed-file and canonical
payload limits separately, 256-byte pattern/4,096-byte raw command preflights,
64-action/32-distinct-command/65,536-step decision limits, and the fixed Windows
bare-basename `.cmd`/`.exe` map; `.bat` and arbitrary suffix normalization are
unsupported. Explain that budget exhaustion denies/investigates without prefix
authorization and that patterns are matched without regex/shell/glob execution.

Document JSON Schema as the structural contract and the
`x-ccprof-runtime-constraints`/README material as the authoritative runtime
semantic supplement for UTF-8 byte counts, normalization duplicates, hostile
descriptors, canonical-payload limits, ordering, and monotonic resolution. Do
not claim exact schema/runtime parity. State that Store/report identity persists
only the outer policy digest, never patterns, domains, raw commands, or the
effective policy snapshot.

- [ ] **Step 4: Delegate focused GREEN and impacted-suite verification**

Delegate the Task 6 focused command, then delegate this impacted suite:

```bash
node --test \
  .test-dist/test/rule-policy-safety.test.js \
  .test-dist/test/organization-policy.test.js \
  .test-dist/test/rules-primary.test.js \
  .test-dist/test/rules-secondary.test.js \
  .test-dist/test/ledger.test.js \
  .test-dist/test/analyze-integration.test.js \
  .test-dist/test/capability-coverage.test.js \
  .test-dist/test/rule-manifest.cases.js \
  .test-dist/test/store.test.js \
  .test-dist/test/reporters-and-cli.test.js \
  .test-dist/test/determinism-golden.test.js \
  .test-dist/test/analysis-budgets-integration.test.js \
  .test-dist/test/docs.test.js
```

Expected: exit 0, zero failures/warnings, unchanged six-rule manifests, old
Store records readable, deterministic ordering, and budget output valid.
Commit:

```bash
git add src/rules/manifest.ts README.md test/rule-manifest.cases.ts \
  test/store.test.ts test/reporters-and-cli.test.ts test/docs.test.ts
git commit -m "docs: publish policy-safe rule contracts"
```

- [ ] **Step 5: Run final specification and quality/security reviews**

First review the entire branch against every design section and audit P0-6/P0-7.
Only after specification approval, use a different reviewer for matcher
complexity, hostile objects, signed merge monotonicity, R004 ledger isolation,
R005 same-domain ambiguity, raw-command safety, bounded-work exhaustion,
UTF-8/canonical size boundaries, identity digest/persistence privacy, legacy
reads, determinism, and scope. Resolve all P0-P2 findings with new commits and
repeat both reviews.

### Task 7: Rebase, run local CI, create and complete the PR

**Files:**
- Verify only; change files solely for failures caused by this branch.

- [ ] **Step 1: Rebase onto current main without local merge**

```bash
git fetch origin main
git rebase origin/main
```

Resolve only genuine branch conflicts, never amend, and delegate the impacted
suite again after any conflict resolution.

- [ ] **Step 2: Delegate full verification and local Actions**

Have an independent verifier run fresh:

```bash
npm run check
```

Expected: typecheck/build and every Node test pass with zero failures. Then have
a separate verifier execute `/run-github-actions-locally` exactly as required by
the repository. Expected: every locally applicable workflow job is green. Read
the complete outputs and record exit codes/test counts before any completion
claim.

- [ ] **Step 3: Push and create the PR against main**

```bash
git push -u origin feature/rule-policy-safety
gh pr create --base main --head feature/rule-policy-safety \
  --title "feat: gate rule recommendations by signed safety policy" \
  --body "Implements audit P0-6/P0-7: R004 remains observe-only policy-latency evidence; concrete allowlist recommendations require signed safe-pattern authorization; R005 concrete parallel recipes require one signed parallel-safe resource domain. Repository policy can only tighten. R004/R005 move to compatibility epoch 2 while Report v2, Store schema, CLI syntax, privacy projection, and epoch-1 readers remain compatible. Verification evidence is recorded in the PR checks."
```

The PR body summarizes R004 observe-only classification, R005 resource-domain
gating, signed/repository monotonic policy, manifest epochs, privacy/legacy
compatibility, and exact delegated verification evidence.

- [ ] **Step 4: Complete CI/review, merge, and clean up**

Follow `/pr-complete` until remote CI and code review are complete. If all
remote jobs fail within five seconds with the documented payment annotation,
use the fresh local Actions result as the green evidence and report the external
billing block. Apply only branch-caused review fixes, each as a new commit, and
re-run the relevant delegated checks.

With the user's pre-approved merge authorization, merge the PR through GitHub,
never locally. Then read and execute
`/Users/tanakatakuto/.claude/skills/worktree-pr-flow:cleanup/SKILL.md` to remove
the clean worktree and local merged branch. Report the PR URL, merge commit,
remote/local CI evidence, reviews/fixes, and cleanup result to the parent.
