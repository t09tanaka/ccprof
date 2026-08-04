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
  opaque/composite command, or repeat only after canonicalization.
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
- A command may match no resource domain, more than one domain, a different
  domain at each layer, or a domain shared with only some actions in a group.
  Native read tools may have no command at all. Each case remains an
  investigation candidate, not a parallelization recommendation.
- Different paths do not prove different resource domains. Conversely, equal
  canonical commands do not prove parallel safety without the signed domain
  contract.
- Wildcards and hostile policy objects must not create regular-expression
  denial of service, invoke getters, leak rejected content, or execute a shell.
- Pattern aliases, duplicate normalized values, excessive arrays/strings,
  control characters, and non-canonical domain names must fail closed.
- R004/R005 semantic changes must not join epoch-1 recurrence, dismissal, or
  adoption series. Existing epoch-1 Store records must remain readable.
- Strict output must not expose policy patterns or canonical commands;
  balanced output must keep using the existing command sanitizer.

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
Patterns in each array and domain entries are stored in deterministic sorted
order after validation.

Limits are fixed constants: at most 64 safe patterns, at most 64 resource
domains, at most 32 match patterns per domain, at most 256 UTF-8 bytes per
normalized pattern, at most 16 `*` wildcards per pattern, and at most 64 ASCII
characters per domain identifier. A domain must match
`[a-z0-9][a-z0-9._-]{0,63}`. Empty patterns/domains, normalized duplicates,
accessors, proxies, sparse arrays, symbols, unknown fields, and over-limit
values are rejected with the existing fixed content-free policy/config error
classes.

## Pattern and command matching

Policy patterns are normalized with NFC, leading/trailing whitespace removal,
all internal whitespace runs collapsed to one ASCII space, and adjacent `*`
characters collapsed to one wildcard. Control characters other than
normalizable whitespace are rejected. Matching is case-sensitive against the
existing `normalizeCommand` canonical command, covers the whole command, and
gives `*` the sole special meaning “zero or more characters.” Every other
character, including regular-expression punctuation, is literal.

The matcher uses a bounded greedy string scan. It never constructs a `RegExp`
from policy input, invokes a shell, expands a filesystem glob, reads the
filesystem, or performs network access. Commands longer than 4,096 UTF-8 bytes
are ineligible for matching.

For an R004 recommendation, canonical matching is followed by an independent
safety gate. The raw command must canonicalize without wrappers, assignments,
redirection, composition, or opacity, and must be either a recognized
test/build/check command or one of the existing conservative read-only command
forms. Unknown, VCS-mutating, and destructive commands are rejected even when
a signed wildcard would otherwise match them.

## Monotonic policy resolution

No signed organization policy means no effective rule-safety authorization;
repository settings alone are never actionable. A configured invalid or
untrusted organization policy remains a hard error and never falls back to
repository-only behavior.

Approval recommendation authorization requires all of the following:

1. the signed organization policy contains `approval_policy`;
2. its `allow_rule_recommendation` is `true`;
3. the canonical command matches at least one signed `safe_patterns` entry;
4. repository `allow_rule_recommendation`, when present, is not `false`;
5. repository `safe_patterns`, when present, also matches the command; and
6. the independent command safety gate accepts the raw command.

Thus a repository pattern is an additional intersection, never a union with
the organization patterns.

Resource-domain resolution first evaluates the signed organization layer. A
command must match exactly one organization entry. When repository
`resource_domains` is present, the command must also match exactly one
repository entry with the same domain. `parallel_safe` combines by logical AND.
A repository `true` cannot override an organization `false`, and a repository
domain cannot supply a missing organization domain. Effective values are
defensive copies containing no paths, signatures, keys, or rejected policy
content.

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
human-wait action so the detector does not infer it from prose. R004 emits up to
one deterministic candidate per classification. Evidence includes the fixed
`latency_classification`, approval counts, interval IDs, observed wait totals,
and only for the authorized repeated-safe candidate its sorted canonical
commands. Non-approval human wait remains visible through the existing summary
and generic R004 evidence, but is not mislabeled as recoverable approval time.

Both candidate types use `ImpactEstimate { lower_ms: 0, upper_ms:
observed_approval_wait_ms, kind: critical_path_latency }` with no
`expected_ms`. This keeps measured latency visible while making it upper-only,
so the current ledger does not attribute it to recoverable time or the
confirmed floor. The generic recipe says to review the governing policy and
explicitly makes no allowlist recommendation. Only the authorized
`repeated_safe_approval_latency` recipe names the canonical command and proposes
an administrator-reviewed permission allowlist change.

If human wait exists but no approval cause is proven, R004 retains one
zero-impact `approval_policy_latency` observation for compatibility with the
existing evidence-only behavior.

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
policy-sensitive recommendation. No CLI syntax changes.

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

TDD coverage will include closed schema/runtime agreement, canonical signed
bytes, monotonic merge matrices, genuine signed-policy integration, matcher
bounds, wildcard literals, normalization collisions, hostile getters/proxies,
and content-free canaries. R004 tests cover both classifications, the repeat
threshold, absent/denied/unsafe policies, destructive and unknown commands,
upper-only ledger behavior, and privacy. R005 tests cover true/false/undefined,
ambiguous and cross-domain matches, repository tightening, native tools,
concrete-recipe gating, and unchanged upper estimates.

Manifest, Store legacy-read, CLI no-flag, JSON/TTY/Markdown, strict/balanced/raw
privacy, deterministic ordering, analysis-budget output, and analysis
integration tests guard compatibility. Static checks and all test commands are
delegated to independent subagents, followed by separate specification and
quality reviews before push.
