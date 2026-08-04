# Signed Organization Policy Design

## Purpose and scope

This change adds the smallest enforceable organization-policy trust boundary to
ccprof. A managed installation can point ccprof at an organization policy, a
detached signature, a trusted public key, and the expected organization. ccprof
validates the closed policy schema, verifies the signature, and combines the
trusted constraints with repository preferences and the current CLI request.

This PR covers only:

- the signed organization policy schema and Ed25519 verification;
- the required privacy, raw, advisory, export, retention-limit, and source-
  coverage fields;
- deterministic organization > repository > CLI only-tightening precedence;
- fail-closed behavior for a configured but absent, invalid, or untrusted policy;
- signed administrative raw/advisory/export kill switches; and
- fixed, content-free policy diagnostics.

It does not add export commands, retention deletion, quota tables, encryption
providers, Report v3, a control plane, remote policy distribution, RBAC, or a new
audit/decision ledger. The resolved export, retention, and coverage constraints
are contracts for their later bounded consumers; this PR does not invent those
consumers.

## Considered approaches

1. **Detached Ed25519 signature with managed trust paths (selected).** The
   semantic policy is canonicalized after strict validation and verified against
   a detached base64 signature and a trusted Ed25519 public key. Four environment
   settings identify the policy, signature, key, and expected organization. This
   has a small local trust boundary, supports offline deterministic verification,
   and does not require a distribution service.
2. **Signature embedded in the JSON policy.** This is convenient to transport,
   but requires excluding the signature from its own signed payload and creates
   more ambiguity around serialization and tooling. It offers no benefit for the
   local path-based pilot.
3. **Remote policy service with key discovery and rotation.** This could support
   fleet administration, but requires networking, identity, cache/expiry,
   rollback, and control-plane availability decisions explicitly excluded from
   this PR.

## Trust configuration and fail-closed behavior

The managed runtime uses these environment variables:

```text
CCPROF_ORGANIZATION
CCPROF_ORGANIZATION_POLICY_PATH
CCPROF_ORGANIZATION_POLICY_SIGNATURE_PATH
CCPROF_ORGANIZATION_POLICY_PUBLIC_KEY_PATH
```

If all four are absent, no organization policy is configured and existing local
behavior remains unchanged. If any one is present, governance is configured:
all four must be non-empty, every referenced file must be readable and within
its input bound, the key must be Ed25519, the policy must validate, its
`organization` must exactly match `CCPROF_ORGANIZATION`, and the detached
signature must verify. Any failure is a hard policy error. A repository or CLI
setting can never bypass that error.

Each trust file is opened read-only with no symlink following, verified as a
regular file, and checked for stable device/inode identity across open/read.
Policy, signature, and public-key inputs are bounded at 64 KiB, 1 KiB, and
16 KiB respectively before parsing or cryptographic work.

Error messages use only fixed classes such as `organization policy is invalid`,
`organization policy is untrusted`, or `organization policy configuration is
incomplete`. They never include a filesystem path, organization value, public
key, signature, JSON field value, or rejected input. Policy file contents and
trust material never enter advisory argv, stdin, or its minimal environment.

## Exact organization policy contract

`schemas/organization-policy.schema.json` publishes a closed draft-2020-12
schema. The semantic shape is:

```ts
interface OrganizationPolicy {
  policy_schema_version: 1;
  organization: string;
  minimum_privacy: "strict" | "balanced" | "raw";
  allow_raw: boolean;
  allow_advisory: boolean;
  allow_export: boolean;
  raw_retention_days_max: number;
  required_source_coverage: number;
  kill_switches?: {
    raw: boolean;
    advisory: boolean;
    export: boolean;
  };
}
```

`$schema` is an optional informational URI. Every other top-level and nested
key is rejected. `organization` is a canonical 1-128 character identifier using
ASCII letters, digits, `.`, `_`, and `-`; it starts with a letter or digit.
`raw_retention_days_max` is a nonnegative safe integer.
`required_source_coverage` is finite and in `[0, 1]`. Kill-switch members are
all required when the optional object exists.

The signature algorithm is fixed to Ed25519. The detached signature file is
strict standard base64 representing exactly 64 bytes. The trusted public key
must parse as an Ed25519 key. There is no algorithm negotiation or fallback.

## Canonical signed payload

Verification does not depend on input whitespace or object key order. After
closed-schema validation, ccprof constructs the semantic object in the exact
field order shown above, conditionally appends `kill_switches` in raw/advisory/
export order, and signs/verifies the UTF-8 bytes of `JSON.stringify` for that
object. Informational `$schema` is excluded. Unknown fields cannot disappear
during canonicalization because validation rejects them first.

The canonical payload helper is public so policy issuers can generate the same
bytes without duplicating ordering rules. It returns a new byte sequence and
never returns mutable internal policy state.

## Repository preferences

The existing versioned `.ccprof/config.json` v1 contract gains one optional,
closed `policy` object. Existing configs remain valid and existing test-map
loading keeps its return type and behavior.

```json
{
  "schema_version": 1,
  "policy": {
    "minimum_privacy": "strict",
    "allow_raw": false,
    "allow_advisory": false,
    "allow_export": false,
    "raw_retention_days_max": 7,
    "required_source_coverage": 1
  }
}
```

Every preference is optional. Types and ranges match the organization policy.
Repository validation uses the existing fixed path, `O_NOFOLLOW`, regular-file,
TOCTOU, closed-object, and content-free error machinery. A new loader returns
only a defensive copy of policy preferences; the existing test-map loader is a
compatibility wrapper over the same parsed document.

## Deterministic precedence

Policy combination is a monotonic reduction, never last-writer-wins:

| Control | Combination rule |
|---|---|
| `minimum_privacy` | strongest profile (`strict > balanced > raw`) |
| `allow_raw` | logical AND; a false or raw kill switch forces at least `balanced` |
| `allow_advisory` | logical AND; advisory runs only when also requested by CLI |
| `allow_export` | logical AND |
| `raw_retention_days_max` | minimum declared maximum |
| `required_source_coverage` | maximum declared minimum |
| kill switches | signed organization switch wins before all lower layers |

Missing repository preferences are neutral. In an ungoverned installation,
organization constraints are also neutral, preserving current CLI defaults.
Thus a repository can select stricter privacy, deny an operation, shorten raw
retention, or require more coverage; it cannot undo an organization constraint.
CLI input can choose stricter privacy or omit advisory, but cannot enable a
denied feature. There is no merge order that can weaken a higher layer.

The resolver returns an immutable-value `EffectivePolicy` containing whether
governance is active, the selected privacy profile, operation permissions, the
advisory execution decision, and the resolved retention/coverage bounds. It
contains no paths, signature, key material, or raw policy document.

## CLI integration

The analyze command resolves policy after deterministic analysis has identified
the canonical repository and before privacy projection or advisory execution.
The effective privacy profile replaces the requested display profile. If
advisory was requested but denied, the Claude process is never created and one
fixed warning, `policy_advisory_disabled`, is emitted. The deterministic report,
Store record, and baseline remain advisory-independent as before.

The stats command resolves the same policy after resolving the repository and
before loading/rendering history. An explicit local `--privacy raw` is raised to
the applicable floor; CI strict remains strict. The export permission is exposed
by the resolver but no export path is added here.

## Edge cases and security invariants

- A partial, blank, missing-file, unreadable, oversized, malformed, future-
  version, wrong-organization, invalid-key, invalid-signature, or failed-
  verification governed configuration is denied.
- Symlinked/special trust files and files whose identity changes during the
  read are rejected; a failure never falls back to an ungoverned decision.
- Unknown policy/repository fields and incomplete kill-switch objects fail
  closed before canonicalization.
- Standard-base64 aliases, URL-safe base64, trailing non-whitespace, and a
  decoded signature length other than 64 bytes are rejected.
- Privacy conflicts resolve toward `strict`; raw denial upgrades only a raw
  request to at least `balanced` rather than silently granting raw access.
- Retention accepts zero and `Number.MAX_SAFE_INTEGER`; negative, fractional,
  non-finite, and unsafe values fail. Coverage accepts exactly 0 and 1.
- Repository `true`, a CLI raw request, or a CLI advisory request cannot undo an
  organization false or kill switch.
- Advisory denial is checked before the runner and cannot leak the policy/key
  through argv, environment, stdin, stdout, stderr, or warnings.
- No-governance/no-repository-policy execution preserves existing privacy and
  advisory output bytes.
- The policy resolver performs no network access and has no time-dependent
  validation, so identical trusted inputs produce identical decisions.

## Testing and compatibility

Focused tests cover schema/runtime agreement, canonical bytes, genuine Ed25519
success, all trust failures, diagnostic canaries, exact precedence matrices,
boundary values, repository config compatibility, analyze advisory suppression,
stats privacy strengthening, and ungoverned byte compatibility. Tests verify the
advisory runner is not called when any higher layer denies it.

Report v2, Store schema v4-or-current, package version, existing CLI syntax, and
existing config `schema_version: 1` remain unchanged. The new schema is already
included by the package's `schemas` allowlist.
