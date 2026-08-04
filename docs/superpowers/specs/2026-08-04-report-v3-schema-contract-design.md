# Report v3 Schema Contract Design

**Date:** 2026-08-04
**Status:** Approved for implementation

## Goal

Publish the future Report v3 wire contract as a packaged Draft 2020-12 JSON
Schema and expose it through `ccprof schema report-v3`. This change publishes a
contract only: current `analyze --json`, Report/Store v2, and every existing
renderer remain byte compatible and no Report v3 producer is introduced.

## Edge cases and cautions

Implementation and tests cover these cases before production code is added:

1. `schema report-v3` works from an arbitrary current directory and from
   `.test-dist`, `dist`, an installed npm tarball, and a symlinked bin entry.
2. Missing, unknown, duplicate, extra, or flag-like schema targets are usage
   errors with exit code 2. Global `--help` and `-h` retain their existing
   precedence.
3. The complete schema is read and parsed before stdout is touched. A missing
   or malformed packaged schema is an operational error with exit code 5 and
   zero stdout bytes.
4. Successful output is deterministic JSON with exactly one trailing newline,
   regardless of whitespace in the packaged file.
5. Every object-shaped schema node rejects fields outside its declared
   properties or declared dictionary-key pattern. Dynamic `evidence` and
   `warning_counts` values remain schema-checked rather than using an
   unrestricted object escape hatch.
6. Millisecond and counter fields reject negative, fractional, and unsafe
   integers. Confidence values include both boundaries of `[0, 1]`. Git object
   IDs accept exactly 40 or 64 lowercase hexadecimal characters; SHA-256
   digests and semantic versions have fixed patterns.
7. Standard JSON Schema cannot compare sibling values or project identity
   fields from arrays. Every such invariant is named precisely in the top-level
   `x-ccprof-runtime-constraints` supplement.
8. A future producer must not replace unavailable logical repository identity,
   build provenance, Git OIDs, or measured source coverage with a path hash,
   zero value, empty sentinel, or other fabricated placeholder. This PR does
   not produce any of those fields.

## Public report envelope

`schemas/report-v3.schema.json` uses Draft 2020-12 and the stable identifier:

```text
https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/report-v3.schema.json
```

The root is closed and requires exactly these public sections plus the version:

```text
schema_version = 3
producer
analysis
work_unit
window
sources
policy
summary
findings
rule_coverage
diagnostics
```

The sections follow the approved audit contract:

- `producer`: `name` (constant `ccprof`), SemVer `version`, real Git
  `build_sha`, and date-versioned `ruleset_version`.
- `analysis`: `analysis_id`, `snapshot_id`, `created_at_ms`, and a
  `sha256:`-prefixed `deterministic_digest`.
- `work_unit`: logical `repository_id`, `pr_ref`, real `base_oid`, `head_oid`,
  `merge_base_oid`, and unique `workspace_ids`.
- `window`: integer start/end timestamps, their source identifiers, and
  `full`/`partial` completeness.
- each source: adapter identifier and SemVer, schema fingerprint, unique
  declared capabilities, and measured file/row/event coverage counters.
- `policy`: positive schema version, SHA-256 digest, and
  `strict`/`balanced`/`raw` privacy profile.
- `summary`: the audit's critical-path and resource-cost counters, all as
  nonnegative safe integers.
- `diagnostics.warning_counts`: stable warning-code keys mapped to
  nonnegative safe integer counts.

The schema deliberately describes future producer requirements even when
current Report v2 lacks the data. Weakening these required fields to values
that current code can fabricate would invalidate the audit contract.

## Findings and rule coverage

`findings` is a closed pagination envelope with required `total`, `returned`,
`truncated`, and `items`. Every item requires:

```text
finding_id
finding_key
rule { id, version, compatibility_epoch }
classification
scope
impact { kind, lower_ms, expected_ms?, upper_ms }
confidence { evidence, causal, source_completeness }
evidence
recipe { kind, trust, suggestion, verification }
```

Rule versions are SemVer, compatibility epochs are positive safe integers,
impact kinds are `critical_path_latency` or `resource_cost`, confidence levels
are `low`/`medium`/`high`, and source completeness is in `[0, 1]`. `scope`
retains the existing `this_pr`, `separate_issue`, and `claude_md` values.
Classification is a bounded identifier rather than the Report v2 enum because
the approved v3 example introduces `policy_latency`. Evidence is JSON data in
a closed dictionary whose property names and recursively nested values are
schema checked. Recipe trust is fixed to `untrusted`; this contract does not
authorize execution of its suggestion.

`rule_coverage` reuses the current additive coverage vocabulary. Each closed
entry requires `rule_id`, eligible and total session counters, `full`/`partial`
status, unique missing capabilities, completeness in `[0, 1]`, and `truncated`.
This publication does not change current Report v2 coverage output.

## Runtime-only semantic constraints

The root `x-ccprof-runtime-constraints` array is the authoritative supplement
for invariants Draft 2020-12 cannot express. It states that a conforming future
producer/runtime must enforce all of the following:

- `window.started_at_ms <= window.ended_at_ms <= analysis.created_at_ms`.
- For each finding, `impact.lower_ms <= impact.upper_ms`, and optional
  `impact.expected_ms` lies inclusively between them.
- `findings.returned === findings.items.length`,
  `findings.total >= findings.returned`, and `findings.truncated` is true if
  and only if fewer than `total` findings are returned.
- `finding_id` values are unique within a report. Their instance-identity
  derivation is distinct from the stable recurrence semantics of
  `finding_key`.
- A rule's `compatibility_epoch` equals the major component of its SemVer
  `version`.
- Coverage entries are unique and canonical by `rule_id`, contain exactly the
  rules selected by the effective manifest, and obey
  `eligible_sessions <= total_sessions`.
- Coverage is `full` exactly when eligible equals total; completeness is `1`
  for `0/0`, otherwise eligible divided by total; missing capabilities are the
  canonical sorted unique runtime projection; truncation reflects the actual
  analysis window and admitted evidence.
- Per-source `files_parsed <= files_discovered` and
  `rows_accepted <= rows_seen`; all source coverage is measured rather than
  synthesized.
- `confirmed_recoverable_ms <= possible_recoverable_upper_ms <= measured_ms`.
- Analysis/snapshot/digest identities use their documented canonical runtime
  derivations, and logical repository identity, build SHA, Git OIDs, and source
  coverage come from authoritative inputs. Missing values make Report v3
  emission unavailable; path hashes, all-zero values, empty sentinels, and
  other fabricated substitutes are forbidden.

Constraints already expressible in the schema, such as key closure, safe
integer bounds, string patterns, enums, and array `uniqueItems`, are not
duplicated in this supplement.

## CLI behavior

`ccprof schema report-v3` is a static-package command. Argument validation
happens before repository discovery, CI detection, organization-policy
loading, Store access, privacy resolution, or analysis-handler construction.
The implementation resolves the schema relative to its own installed module,
walks package parents rather than consulting `cwd`, parses the whole document,
then emits canonical pretty JSON plus one newline.

Only `report-v3` is accepted. Missing/unknown/extra targets and flags return
usage exit 2. I/O and JSON parse failures are content-free operational errors
with exit 5 and no partial output. Existing global help behavior remains
authoritative when `--help` or `-h` is present.

## Packaging, documentation, and compatibility

The existing npm `files` list already includes `schemas`, so no packaging
configuration or runtime dependency is added. CI's installed-tarball smoke test
runs the public command from outside the repository, parses stdout, and checks
`properties.schema_version.const === 3`. The release-workflow contract test
keeps that smoke step from being removed accidentally.

README command documentation explicitly distinguishes the published Report v3
schema from current `--json`, which continues to emit Report v2. Existing
ReportV2 types, Store readers/writers, JSON/TTY/Markdown renderers, rules,
analysis, and data migration paths are untouched.

## Explicitly out of scope

- A Report v3 TypeScript model, producer, reader, or migration.
- Switching `analyze --json`, `stats --json`, or any renderer to v3.
- Deriving or backfilling logical repository IDs, build SHAs, workspace IDs,
  source coverage, or finding instance IDs.
- N-2 reader implementation, export schemas, Store schema changes, or existing
  data repair.
- New dependencies, schema registries, network lookup, queues, cron, locks,
  leases, exact-once guarantees, or automatic recovery.

## Implementation constraints

- At most nine changed files and less than 300 lines of production TypeScript.
- Reuse the existing static `rules` command and package-version resolution
  patterns; add no general command framework.
- The shared parsed-command union changes only after Language Service
  definition/reference/diagnostic inspection.
- Follow RED, minimal GREEN, full verification, independent specification
  review, then quality/security review. Do not broaden scope for unrelated
  findings.
