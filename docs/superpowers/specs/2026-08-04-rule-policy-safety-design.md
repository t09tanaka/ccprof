# R004/R005 Policy-Safe Recommendations Design

## Purpose and scope

This change closes enterprise audit items P0-6 and P0-7 without introducing
Report v3 or changing the Store schema. R004 approval waits remain visible as
policy-latency evidence, but they are no longer presented as confirmed
recoverable time. An allowlist recommendation is emitted only when a signed
organization policy authorizes the exact canonical command pattern. R005 keeps
its measured serial-slack upper estimate, but recommends a concrete parallel
invocation only when a signed resource-domain contract proves that every call
belongs to one explicitly parallel-safe domain.

The user has pre-approved the design, implementation scope, PR, and merge. This
PR intentionally does not add Report v3, terminal snapshot statistics,
workspace-graph inference, new CLI flags, a new Store table, policy fetching,
or command execution.

## Edge cases identified before implementation

- An approval may be explicit, phrase-inferred, lack a command, contain an
  opaque/composite command, or repeat only after canonicalization. Two or more
  approval-bearing tool uses may share one assistant timestamp; their command
  binding is ambiguous and must not depend on source permutation.
- A signed safe pattern is not sufficient by itself: destructive, unknown,
  wrapper-prefixed, redirected, or composite commands must never receive an
  allowlist recommendation.
- Organization policy may be absent, partially configured, invalid, untrusted,
  or valid but omit/deny the recommendation contract. Every such case is a
  deny for concrete rule recommendations; configured trust failures remain hard
  errors.
- Repository preferences may narrow organization approval patterns, mark a
  resource domain unsafe, or require an additional matching domain contract.
  They must never authorize a command or domain that the signed organization
  layer did not authorize.
- A command may match no resource-domain entry, more than one entry (including
  two entries with the same domain), a different domain at each layer, or a
  domain shared with only some actions in a group.
  Native read tools may have no command at all. Each case remains an
  investigation candidate, not a parallelization recommendation.
- Different paths do not prove different resource domains. Conversely, equal
  canonical commands do not prove parallel safety without the signed domain
  contract.
- Wildcards, excessive actions/unique commands, and hostile policy objects must
  not create regular-expression or algorithmic denial of service, invoke
  getters, leak rejected content, or execute a shell.
- Pattern aliases, duplicate normalized values, excessive arrays/strings,
  control characters, and non-canonical domain names must fail closed.
- R004/R005 semantic changes must not join epoch-1 recurrence, dismissal, or
  adoption series. Existing epoch-1 Store records must remain readable.
- Strict output must not expose policy patterns or canonical commands;
  balanced output must keep using the existing command sanitizer.
- Windows launcher suffixes must not turn an arbitrary `.cmd`, `.exe`, or
  `.bat` program into a recognized safe command.

## Semantic impact inventory

`ts-rename-helper` LanguageService rename plans were used against
`tsconfig.test.json` before changing shared interfaces. They found the
following semantic references (including declarations):

- `OrganizationPolicy`: 15 references across 3 files.
- `RepositoryPolicyPreferences`: 7 references across 2 files.
- `EffectivePolicy`: 10 references across 3 files.
- `RuleManifest`: 9 references across 2 files.
- `HumanWaitOptions`: 2 references in one file.
- `detectHumanWait`: 5 references across 3 files.
- `SerialSlackOptions`: 2 references in one file.
- `detectSerialSlack`: 14 references across 3 files.
- `AttributedTimelineAction`: 13 references across 3 files.

The inventory supports additive policy fields, an optional analysis callback,
evidence-only Finding additions, and per-rule epoch changes. It does not support
changing the existing Report v2 `Classification` union or requiring new fields
on legacy Finding readers.

## Considered approaches

1. **Signed layered contracts with a bounded literal-wildcard matcher
   (selected).** Extend the existing signed policy and repository preference
   schemas, resolve them monotonically, and pass a defensive rule-safety
   snapshot to R004/R005. This reuses the existing trust boundary and keeps
   analysis deterministic and offline.
2. **Repository-only allowlists and resource domains.** This is simpler for a
   local user, but a repository could weaken an enterprise control and cause a
   security-sensitive recommendation without organization authorization.
3. **General regular expressions or shell globs.** These are more expressive,
   but introduce ReDoS, escaping, platform, and shell-semantics ambiguity. The
   audit needs a small safe contract, not a policy language.

## Exact policy contracts

The signed `OrganizationPolicy` gains two optional closed fields:

```ts
interface ApprovalRulePolicy {
  safe_patterns: string[];
  allow_rule_recommendation: boolean;
}

interface ResourceDomainPolicy {
  match: string[];
  domain: string;
  parallel_safe: boolean;
}

interface OrganizationPolicy {
  // Existing required fields are unchanged.
  approval_policy?: ApprovalRulePolicy;
  resource_domains?: ResourceDomainPolicy[];
}
```

The repository `.ccprof/config.json` policy object accepts the tightening-only
counterparts:

```ts
interface RepositoryApprovalRulePolicy {
  safe_patterns?: string[];
  allow_rule_recommendation?: boolean;
}

interface RepositoryPolicyPreferences {
  // Existing optional fields are unchanged.
  approval_policy?: RepositoryApprovalRulePolicy;
  resource_domains?: ResourceDomainPolicy[];
}
```

`approval_policy` and `resource_domains` are optional so existing signed files,
repository configs, and their canonical bytes are unchanged when the new
contracts are absent. The canonical signed payload appends
`approval_policy`, then `resource_domains`, before the existing optional
`kill_switches`. Nested object field order is exactly the order shown above.
Patterns in each array and domain entries are stored in deterministic order
after validation. Sorting is locale-independent UTF-8 byte order, implemented
with `Buffer.compare`; `localeCompare` is not used. A resource entry is ordered
and identified by the full tuple `(domain, normalized match array,
parallel_safe)`, with `false` before `true`. An exact duplicate tuple and a
duplicate normalized pattern in one array are semantic errors. Entries sharing
one domain but having different tuples are permitted; if one command matches
more than one entry, resolution is ambiguous even when those entries name the
same domain.

Limits are fixed constants: at most 64 safe patterns, at most 64 resource
domains, at most 32 match patterns per domain, at most 256 UTF-8 bytes per
raw pattern and per normalized pattern, at most 16 `*` wildcards per pattern,
and at most 64 ASCII characters per domain identifier. A domain must match
`[a-z0-9][a-z0-9._-]{0,63}`. Empty patterns/domains, normalized duplicates,
accessors, proxies, sparse arrays, symbols, unknown fields, and over-limit
values are rejected with the existing fixed content-free policy/config error
classes.

The signed organization policy keeps its existing 65,536-byte raw-file ceiling.
The byte count is checked before JSON parsing; exactly 65,536 bytes may reach
parsing and 65,537 bytes is unreadable. The canonical signed payload is checked
independently after semantic normalization and must also be at most 65,536
UTF-8 bytes. This second check also applies to programmatic calls to
`canonicalOrganizationPolicy`, which do not pass through the file loader. A
raw or canonical overflow fails with the existing content-free policy error.

The two published JSON Schemas define only the structural contract: closed
keys, JSON types, item counts, character-count ceilings, required members, and
the ASCII domain pattern. Runtime validation additionally enforces UTF-8 byte
ceilings, NFC/whitespace/wildcard normalization, normalized duplicates, full
tuple duplicates, descriptor/proxy safety, the total canonical payload limit,
and monotonic merge semantics. JSON Schema cannot express those semantic or
JavaScript-object constraints. Each nested schema therefore carries an
`x-ccprof-runtime-constraints` annotation naming them, and README documents the
same split. Tests compare schema and runtime only for their shared structural
surface, then test runtime-only invariants separately; they do not claim exact
schema/runtime parity.

## Pattern and command matching

Raw policy patterns first use an O(1) `string.length > 256` rejection, then
receive their 256-byte UTF-8 preflight before NFC or any other allocating
normalization. Accepted patterns are then normalized with NFC,
leading/trailing whitespace removal, internal whitespace runs collapsed to one
ASCII space, and adjacent `*` characters collapsed to one wildcard. The
normalized bytes are checked again. Control characters other than normalizable
whitespace are rejected. Matching is case-sensitive, covers the whole command,
and gives `*` the sole special meaning “zero or more characters.” Every other
character, including regular-expression punctuation, is literal.

`safeCanonicalCommand(raw)` is the only command entrance for both R004 and
R005 policy decisions. It first uses an O(1) `string.length > 4_096` rejection,
then performs a 4,096-byte UTF-8 raw preflight before NFC, tokenization, or
classification. It returns no value for assignments, `env` or
`command` wrappers, redirection, composition, opacity, unknown families,
VCS-mutating forms, or destructive commands. Accepted commands are recognized
test/build/check/inspect forms or the fixed conservative read-only Git
subcommands, and return a canonical command string at most 4,096 UTF-8 bytes.
R005 passes raw action commands to the decision API; a caller cannot bypass the
safety gate by supplying a pre-normalized string.

Windows launchers use one explicit basename map before classification:
`npm.cmd -> npm`, `pnpm.cmd -> pnpm`, `yarn.cmd -> yarn`, `bun.exe -> bun`,
`cargo.exe -> cargo`, `git.exe -> git`, `node.exe -> node`, and
`rg.exe -> rg`. Lookup is ASCII-case-insensitive and accepts only a bare
basename, never a path. No `.bat` launcher and no other `.cmd`/`.exe` name is
recognized. Their absence from this fixed map means unsupported/unsafe, not a
generic suffix-stripping fallback.

The matcher uses a greedy string scan and never constructs a `RegExp` from
policy input, invokes a shell, expands a filesystem glob, reads the filesystem,
or performs network access. Each whole R004/R005 candidate decision has one
fixed 65,536-step budget shared by canonicalization-cache lookups, pattern
comparisons, wildcard backtracking, and layer/domain comparisons. It accepts at
most 64 actions and
32 distinct raw command strings, memoizes `safeCanonicalCommand` once per
distinct raw command, charges each command's raw code-unit length and fixed
classifier stages before canonicalization, and increments the shared budget for
every input element and character-comparison step. Exceeding the raw/canonical byte preflight,
action cap, unique-command cap, or step budget fails closed: R004 emits only
generic `approval_policy_latency`; R005 emits
`investigation_candidate`. Inputs are never truncated to an actionable prefix.

## Monotonic policy resolution

No signed organization policy means no effective rule-safety authorization;
repository settings alone are never actionable. A configured invalid or
untrusted organization policy remains a hard error and never falls back to
repository-only behavior.

Approval recommendation authorization requires all of the following:

1. the signed organization policy contains `approval_policy`;
2. its `allow_rule_recommendation` is `true`;
3. `safeCanonicalCommand` accepts the raw command and its canonical result
   matches at least one signed `safe_patterns` entry;
4. repository `allow_rule_recommendation`, when present, is not `false`;
5. repository `safe_patterns`, when present, also matches the command; and
6. the shared decision budget remains available.

Thus a repository pattern is an additional intersection, never a union with
the organization patterns.

R004 sends the complete ordered list of approval-action raw commands to one
batch decision. The result either contains one allow/deny item per input action
or denies the whole batch. The latter is used for action, unique-command, or
step-budget overflow, so an authorized prefix can never survive. One memo cache
and the one shared budget cover the complete list; individual actions do not
start fresh budgets.

Resource-domain resolution receives raw commands and first applies
`safeCanonicalCommand` through the per-decision cache. It then evaluates the
signed organization layer. Each command must match exactly one full
organization resource entry. When repository `resource_domains` is present,
the command must also match exactly one full repository entry with the same
domain. `parallel_safe` combines by logical AND. A repository `true` cannot
override an organization `false`, and a repository domain cannot supply a
missing organization domain. Every action in a candidate group must resolve to
the same domain. Missing, rejected, over-budget, multi-entry, or cross-domain
evidence is an investigation candidate. Effective values are defensive copies
containing no paths, signatures, keys, or rejected policy content.

## R004 behavior

R004 remains one public rule ID but moves to manifest version `2.0.0`,
compatibility epoch `2`, and evidence schema
`ccprof://rules/R004/evidence/v2`. Its manifest contract remains
`impact_kind: policy_latency`, `default_mode: observe_only`,
`aggregation_policy: never_aggregate`, and `policy_risk: high`.

Approval-carrying human-wait actions are divided into these evidence
classifications:

- `repeated_safe_approval_latency`: the same eligible canonical command occurs
  at least twice and passes every signed/repository authorization and safety
  gate above;
- `approval_policy_latency`: every other explicit or phrase-based approval,
  including missing, opaque, unsafe, ungoverned, denied, or non-repeated
  commands.

The timeline retains the approved tool command on the corresponding
human-wait action so the detector does not infer it from prose. A pending
assistant stores an approval binding as `none`, `single`, or `ambiguous`. The
second approval-bearing tool use at the same assistant timestamp changes the
binding irreversibly to `ambiguous`; the resulting human-wait action keeps a
fixed ambiguity sentinel, omits every tool command, and is always generic. Tool
use input permutation therefore cannot select a different command. R004 calls
the batch policy decision once and emits up to one deterministic candidate per
classification. Evidence includes the fixed
`latency_classification`, approval counts, interval IDs, observed wait totals,
and only for the authorized repeated-safe candidate its sorted canonical
commands. Non-approval human wait remains visible through the existing summary
and generic R004 evidence, but is not mislabeled as recoverable approval time.

For a positive observed duration, both candidate types use `ImpactEstimate {
lower_ms: 0, upper_ms: observed_approval_wait_ms, kind:
critical_path_latency }` with no `expected_ms`; the existing compatibility
projection consequently reports an upper bound. If no approval duration is
proven, the retained observation is exactly `lower_ms: 0, upper_ms: 0` and the
compatibility projection is the harmless `point` zero, not an upper bound.
Neither form attributes recoverable milliseconds or reduces the confirmed
floor. The generic recipe is exactly a permission-policy investigation and does
not contain the word `allowlist`. Only the authorized
`repeated_safe_approval_latency` recipe names the canonical command and proposes
an administrator-reviewed permission allowlist change.

If human wait exists but no approval cause is proven, R004 retains one
zero-impact `approval_policy_latency` observation for compatibility with the
existing evidence-only behavior; its `recoverable.bound` is `point` with value
zero.

## R005 behavior

R005 moves to manifest version `2.0.0`, compatibility epoch `2`, and evidence
schema `ccprof://rules/R005/evidence/v2`. Its manifest contract remains
`impact_kind: resource_cost`, `default_mode: enabled`,
`aggregation_policy: max`, and `policy_risk: medium`.

Path-disjoint serial grouping and the existing upper estimate remain unchanged.
Each group receives exactly one evidence classification:

- `parallel_safe`: every action has a canonical command, each layer resolves
  exactly one identical resource domain, and every applicable contract is
  `parallel_safe: true`;
- `parallel_unsafe`: one unambiguous shared domain is resolved and at least one
  authoritative contract says `parallel_safe: false`;
- `investigation_candidate`: a command/domain is missing or ambiguous, layers
  disagree on the domain, actions span multiple domains, or native tools lack
  canonical command evidence.

Here “canonical command” always means the result of applying
`safeCanonicalCommand` to each raw action command inside the bounded decision;
the decision API does not accept already-canonical strings. The common title is
the neutral `Path-disjoint tool calls ran serially`. Unsafe and investigation
titles/recipes never call the actions independent, parallelizable, or safe.

Only `parallel_safe` uses the concrete “parallel tool invocation” recipe. A
`parallel_unsafe` finding explicitly says no parallel invocation is
recommended. An investigation candidate recommends checking shared resources
before changing execution. All three retain the existing resource-cost
`lower_ms: 0` / measured `upper_ms` estimate and caveat that it is not an
assertion of achievable speedup. An unambiguous domain identifier may be
included in evidence; policy patterns and policy documents never are.

## Integration and compatibility

`runAnalyzeCommand` passes its cached `EffectivePolicy` to core analysis through
one optional repository-root callback. Direct core callers that omit the
callback receive observe/investigate behavior and can never emit a concrete
policy-sensitive recommendation. Immediately after canonical PR-context
resolution—and before the first analysis-budget early return—core invokes the
callback at most once and passes its result through
`snapshotEffectiveRuleSafetyPolicy`. That closed snapshot rejects proxies,
accessors, unknown fields, malformed arrays, and over-limit values, clones every
nested value, and becomes the sole object used by both detectors. Mutation of a
resolver-owned object after return cannot change the run. No CLI syntax changes.

Snapshot identity includes the effective contract without storing it. Core
computes:

```ts
const ruleSafetyDigest = analysisDigest(
  "effective-rule-safety-v1",
  ruleSafety === undefined
    ? { mode: "absent" }
    : canonicalRuleSafetySnapshot(ruleSafety),
);
```

and includes only `rule_safety_digest: ruleSafetyDigest` in the object hashed
into `AnalysisSnapshotIdentity.policy_digest`, beside coverage, skipped rules,
and the Rule Manifest. The Store envelope therefore contains only the outer
64-hex `policy_digest`; it never contains patterns, domains, raw commands, or
the canonical snapshot. The explicit absent marker prevents an omitted policy
from colliding with an empty future representation. Different effective
contracts produce different snapshot identities, while reordered equivalent
input and post-snapshot mutation do not.

Report v2 and the Store keep their current schemas. New classification and
domain facts live in the existing open `Finding.evidence` JSON object. Strict
privacy continues dropping detailed evidence; balanced privacy sanitizes fields
whose keys contain `command`; raw output behaves as before. The effective policy
and its patterns are not serialized into the report, Store, warnings, or
advisory input.

The epoch-2 finding-key preimage already provided by the Rule Manifest
foundation separates new R004/R005 recurrence, dismissal, and adoption series.
Legacy findings without manifest metadata and explicit epoch-1 records remain
readable without migration or backfill. The manifest change also updates the
existing deterministic policy digest.

## Testing and verification

TDD coverage will include the shared structural schema/runtime surface plus
separate runtime-only semantics, canonical signed bytes, raw/canonical 64-KiB
boundaries, monotonic merge matrices, genuine signed-policy integration,
matcher/decision budgets, wildcard literals, normalization collisions, hostile
getters/proxies, and content-free canaries. R004 tests cover both
classifications, same-timestamp ambiguity/permutations, the repeat threshold,
absent/denied/unsafe policies, destructive and unknown commands, positive upper
and zero-point ledger behavior, and privacy. R005 tests cover raw command safety,
true/false/undefined, same-domain multi-entry ambiguity, cross-domain matches,
repository tightening, native tools, concrete-recipe gating, neutral titles,
and unchanged upper estimates.

Manifest, Store legacy-read, CLI no-flag, JSON/TTY/Markdown, strict/balanced/raw
privacy, deterministic UTF-8 ordering, analysis-budget output, and analysis
integration tests guard compatibility. Snapshot tests assert effective-policy
changes alter `policy_digest`, equivalent reorderings and caller mutation do
not, the absent marker is stable, and a canary policy pattern is absent from
persisted Store bytes. Static checks and all test commands are delegated to
independent subagents, followed by separate specification and quality reviews
before push.
