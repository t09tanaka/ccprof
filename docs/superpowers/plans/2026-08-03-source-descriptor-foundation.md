# Source Descriptor Foundation Implementation Plan

> **Execution:** Implement task-by-task with TDD and delegated verification.

**Goal:** Add deterministic, validated, privacy-safe descriptors for the built-in
Claude and Codex session sources without changing rule applicability or Store
contracts.

## Contract

`SourceDescriptor` has exactly these fields:

```ts
interface SourceDescriptor {
  adapter_id: "claude" | "codex";
  adapter_version: "1.0.0";
  source_instance_id: string;
  source_kind: "claude_transcript_jsonl" | "codex_rollout_jsonl";
  provided_capabilities: SessionCapability[];
  required_capabilities: SessionCapability[];
  provenance: "local_filesystem";
  sensitivity: "sensitive";
  retention_class: "raw_evidence";
  canonical_fingerprint: string;
}
```

- `source_instance_id` is `source-<sha256>` over a domain-separated adapter ID
  and NFC-normalized `Session.session_id`; raw session IDs and paths never enter
  the descriptor. Logical sessions stay stable across linked-worktree copies.
- `canonical_fingerprint` is `sha256:<hex>` over a domain-separated canonical
  tuple of the other nine fields.
- Built-in registry entries are `claude@1.0.0` and `codex@1.0.0`. Both require
  no prerequisite capabilities today. `provided_capabilities` comes from the
  session declaration, with the existing `undefined = all` compatibility rule.
- Capability arrays are unique, lexicographically sorted, and restricted to the
  existing `SessionCapability` enum.

## Edge cases and boundaries

- Reject unknown adapters, versions, fields, capability names, NULs, malformed
  opaque IDs/fingerprints, unsorted or duplicate capabilities, registry metadata
  mismatches, fingerprint mismatches, and duplicate source instances.
- Validation errors use stable codes/messages and never echo attacker-controlled
  descriptor values, paths, transcripts, tokens, or secrets.
- Identical sessions and reordered session input produce identical descriptor
  arrays; same path under different adapters produces different opaque identity.
- Report `sources` is additive and optional so stored/constructed v2 reports
  without it remain readable and render exactly as before.
- All privacy profiles preserve only the already-opaque descriptor fields.
- Out of scope: per-session rule coverage, rule logic, Store/catalog/schema,
  Report v3, manifest, organization policy, and analysis budgets.

## Task 1 — Descriptor contract and validation

- [x] Add focused RED tests for deterministic/order-independent derivation,
  Claude/Codex registry data, adapter separation, Unicode/NUL/path/token canaries,
  strict unknown-field/version/adapter/metadata/fingerprint validation, and
  duplicate descriptors.
- [x] Implement `src/core/source-descriptor.ts` with canonical hashing, registry,
  strict single/list validators, stable content-free errors, and session-derived
  deduplicated descriptors.
- [x] Delegate focused verification and commit implementation/tests.

## Task 2 — Report and privacy integration

- [x] Add RED tests for optional `ReportV2.sources`, deterministic JSON, compact
  TTY/Markdown source summaries, all privacy profiles, and legacy reports with no
  `sources` field.
- [x] Populate descriptors in `analyze()`, copy them deterministically in JSON,
  render opaque adapter/version/count summaries in TTY and Markdown, and clone
  them unchanged through strict/balanced privacy projection.
- [x] Delegate focused verification and commit report integration/tests.

## Task 3 — Documentation and completion gates

- [x] Document the exact descriptor shape, opaque identity/fingerprint domains,
  built-in registry versions, validation behavior, privacy handling, and scope in
  README; mark this plan complete.
- [x] Delegate full `npm run check` and applicable local GitHub Actions commands.
- [x] Obtain independent spec and quality approval; fix only issues caused by
  this atomic change in new commits.
- [ ] Push and open `[Sources] feat: add validated source descriptors` against
  `main`, monitor remote CI, merge with a merge commit, sync main, and clean the
  worktree/branch after verifying clean and fully pushed state.
