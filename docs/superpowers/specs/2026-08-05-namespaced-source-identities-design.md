# Namespaced Source Identities Design

## Context

ccprof currently exposes source identities as the closed TypeScript unions
`"claude" | "codex"` and source kinds as two legacy underscore-delimited
tokens. That type surface makes a third-party producer appear impossible even
though source identities are protocol boundary data. At the same time, those
legacy values already participate in parser output, source descriptors, Store
rows, report v2/v3 output, fingerprints, cache keys, and serialized bytes.

This change opens the identity primitives without migrating those runtime and
wire values. It is deliberately a compatibility-first type and boundary step.

## Goals

- Define `ProducerId`, `SourceAdapterId`, and `SourceKind` as open string
  identity types.
- Validate canonical identities with the exact lowercase DNS-namespaced
  `namespaced_name` grammar already published by Trace Envelope v1, including
  its 255-character maximum. The grammar is ASCII, so the character and byte
  limits are equivalent for accepted values.
- Accept third-party identities such as
  `dev.example.agent/adapters/dummy-agent` without registry edits.
- Publish ccprof-owned canonical adapter identities
  `ccprof.dev/adapters/claude` and `ccprof.dev/adapters/codex`, and canonical
  source-kind identities
  `ccprof.dev/source-kinds/claude-transcript-jsonl` and
  `ccprof.dev/source-kinds/codex-rollout-jsonl`.
- Normalize only the two known legacy adapter aliases to their canonical
  adapter identities, and fail closed for every other unnamespaced alias.
- Provide an explicit built-in-only inverse projection that returns
  `undefined` when a canonical identity has no legacy representation.
- Preserve current Claude and Codex runtime, parser, descriptor, Store,
  report, fingerprint, cache-key, and serialization behavior.

## Non-goals

- Do not make parsers or discovery emit canonical IDs yet.
- Do not change `SourceDescriptor` runtime values or its validation registry.
- Do not change Store schemas or rows, Report v2/v3 fields, fingerprints,
  cache keys, fixtures, or serialized bytes.
- Do not add protocol package exports or a public adapter registration API.
- Do not add migration, backfill, recovery, or concurrency infrastructure.

## Identity module

`src/core/source-identity.ts` owns the complete primitive boundary:

```ts
export type NamespacedSourceIdentity = string;
export type ProducerId = NamespacedSourceIdentity;
export type SourceAdapterId = NamespacedSourceIdentity;
export type SourceKind = NamespacedSourceIdentity;

export type LegacySourceAdapterId = "claude" | "codex";
export type LegacySourceKind =
  | "claude_transcript_jsonl"
  | "codex_rollout_jsonl";
```

The module contains one neutral namespaced-name parser, thin typed parsers for
the three public identities, explicit adapter and source-kind compatibility
maps, normalization helpers, inverse projection helpers, and a deterministic
code-unit comparator. The neutral parser contains no producer- or forge-owned
literals. All vendor-specific legacy tokens live in the explicit compatibility
maps and legacy type declarations.

The exact grammar is:

```text
^(?:[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+
  [a-z](?:[a-z0-9-]{0,61}[a-z0-9])?
  (?:/[a-z][a-z0-9._-]{0,63})*
  (?![\s\S])
```

It rejects empty strings, whitespace, NUL, uppercase characters, domains
without a dot, empty path segments, invalid DNS-label separators, trailing
line terminators, and accepted-grammar strings over 255 characters. Errors are
content-free and never echo the rejected input.

`normalizeSourceAdapterId(value)` first checks the explicit legacy adapter map.
Known aliases return their ccprof-owned canonical adapter ID. Every other value
must pass the neutral namespaced parser, which accepts canonical built-ins and
third-party IDs while rejecting unknown unnamespaced aliases. Source kinds use
the same model through `normalizeSourceKind`.

`projectLegacySourceAdapterId(value)` and `projectLegacySourceKind(value)` are
the inverse compatibility boundary. They return one of the two explicit
legacy tokens only for a known canonical built-in identity. They return
`undefined` for third-party identities and do not invent aliases.

## Compatibility projection in existing models

`Session.source` becomes `ProducerId`, making the structure open. Existing
producers continue assigning the legacy values `"claude"` and `"codex"` until
the runtime migration PR. Those values are boundary compatibility values, not
canonical core identities.

`SourceDescriptor.adapter_id` and `SourceDescriptor.source_kind` use the open
public types. The built-in registry is separately typed with
`LegacySourceAdapterId` and `LegacySourceKind`, so `deriveSourceDescriptor` and
strict descriptor validation continue accepting and emitting only the exact
legacy built-in shapes. Re-exporting the open types from
`source-descriptor.ts` preserves existing import paths without adding package
exports.

Capability and descriptor ordering use direct UTF-16 code-unit comparison
(`left < right`, `left > right`) rather than locale-sensitive comparison. All
currently ordered built-in values are ASCII, so this is behavior preserving.

## Verification

Tests cover the open public type assignments, third-party and canonical IDs,
known alias normalization, all invalid syntax classes, the 255 boundary,
unknown unnamespaced aliases, built-in-only inverse projection, code-unit
ordering, and exact pre-change Claude/Codex descriptor shapes and fingerprints.
The existing descriptor test and full repository check remain unchanged and
must pass.
