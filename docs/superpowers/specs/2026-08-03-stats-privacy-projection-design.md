# Stats Privacy Projection Design

## Goal

Close the privacy bypass in `ccprof stats` without changing stored analyses,
the stats data model, or raw output. Every stats display is projected at the
command/render boundary through `strict`, `balanced`, or `raw` privacy.

## Scope

This change is limited to the existing `stats` command, the shared privacy
reporter it reuses, documentation, tests, and package smoke invocations. It
does not add terminal-snapshot/cohort aggregation, Report v3, policy/store
schema, migrations, new commands, or new CLI families.

## CLI contract

`ccprof stats` accepts `--privacy <strict|balanced|raw>` and the inline
`--privacy=<profile>` form exactly once. Missing, empty, invalid, and duplicate
values use the same usage errors as analysis privacy parsing.

The effective stats profile is:

- detected/injected CI: always `strict`; `balanced` and `raw` are parsed but
  cannot weaken the effective profile;
- local explicit profile: the selected profile;
- local default: `balanced`.

The effective profile is selected early enough to protect parser failures,
then passed explicitly through `StatsCommandOptions`. It remains active for
dispatch warnings and operational exceptions. Strict operational failures use
the existing path-free generic error.

## Projection boundary

`summarizeStats` continues to return the raw deterministic `StatsReport`.
`projectStatsPrivacy(stats, profile, repoRoot)` is a pure display projection
called once after summarization and before JSON or TTY rendering.

- `raw` returns the existing report unchanged so rendered output remains byte
  compatible.
- `strict` and `balanced` build fresh nested objects and arrays, preserving
  ordering, numeric fields, rule/enumeration fields, and timestamps exactly.
- Repeated calls with identical input/profile/repository root are
  deterministic and never mutate the raw report.

All recurring/adoption `finding_key` values use
`findingPrivacyReference(repoRoot, rawKey)`. The same raw key in either section
therefore gets the same stable opaque reference. Titles and baseline metric
labels pass through the existing text sanitizer.

## Chronic command policy

Strict output omits `command_identity`. Its required `command` field contains
only an exact command already accepted by the shared fixed safe-command
allowlist, or the existing `[redacted-command]` marker. Everything else becomes
that marker.

Balanced output sanitizes commands with the shared helpers. It retains a
`command_identity` only when all three components are safe: the CWD is the
repository root marker `.`, normalized argv reconstructs an exact allowlisted
command, and the executor is an existing enum. Unsafe identities are omitted
as a whole, avoiding partial argv or path disclosure. A safe root-level
`npm test` identity remains useful.

The text projection covers repository, POSIX, Windows-drive, and UNC absolute
paths, URLs, token/credential patterns, and recognizable session identifiers.
No raw repository path is used as display text.

## Warning policy

History and adoption Store warnings are adapted to the existing shared warning
projector:

- `strict`: sorted code/count summaries only;
- `balanced`: sanitized message plus a path marker;
- `raw`: the exact existing `[code] message (path)` text.

The CLI applies the active profile again at the final stderr boundary as a
defense in depth; the projection is deterministic and idempotent for already
sanitized text.

## Compatibility and verification

The test contract begins RED and covers parser parity, local/CI defaults and
overrides, raw byte equivalence, stable opaque references, canaries for paths,
URLs, tokens, sessions, and argv secrets, numeric/enum preservation, balanced
safe `npm test`, warning/error policy, non-mutation, determinism, README text,
and installed-package smoke commands using explicit strict privacy.

Shared-signature impact was checked with TypeScript LSP before implementation:
`ParsedStatsCommand` has three references within `src/cli.ts`;
`StatsCommandOptions` has four references across `src/cli.ts` and
`src/commands/stats.ts`; `StatsReport` has five references within
`src/reporters/stats.ts`. No Report, Store, or policy contract must change.
