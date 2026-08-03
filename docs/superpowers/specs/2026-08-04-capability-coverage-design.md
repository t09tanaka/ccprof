# Per-Rule Capability Coverage Design

## Scope

Replace whole-analysis capability skipping with deterministic, per-rule session
lanes for R001-R008. This change is additive to Report v2 and reuses the
existing `Session.capabilities` and `SourceDescriptor` contracts. Manifest,
rule semantics, impact/confidence, Report v3, Store migrations, and stats
cohorts are out of scope.

## Considered approaches

1. **Isolated evidence lanes cached by eligible session set (selected).** Build
   timeline/events/matches after filtering sessions, then reuse the lane for
   rules with the same requirements. This prevents an ineligible lane from
   changing concurrency or inference evidence while avoiding eight full builds.
2. Filter the existing global events/actions after matching. This is smaller,
   but an ineligible lane may already have affected concurrency and action
   classification, so it does not satisfy evidence isolation.
3. Rebuild the complete pipeline independently for every rule. This is correct
   but duplicates work for the five rules with no requirements.

## Contract

`ReportV2.rule_coverage` is optional for legacy readers and contains one entry
per rule, sorted by `rule_id`:

```ts
interface RuleCoverage {
  rule_id: RuleId;
  eligible_sessions: number;
  total_sessions: number;
  status: "full" | "partial";
  missing_capabilities: SessionCapability[];
  completeness: number;
  truncated: boolean;
}
```

A session is eligible only when it has every capability in
`RULE_REQUIRED_CAPABILITIES[rule_id]`; `capabilities === undefined` retains the
legacy meaning "all capabilities". Missing capabilities are a sorted unique
union across ineligible sessions. For `E` eligible of `N` total sessions,
status is `full` iff `E === N`, and completeness is `E / N`; `0 / 0` is
explicitly `full` with completeness `1`, while `0 / N` is `partial` with `0`.
All completeness values are finite and in `[0, 1]`.

`truncated` is true when the analysis window is partial, or an eligible session
has a parser warning code denoting a parser truncation or parser budget limit.
Only stable warning codes are inspected; warning messages, source paths, and
session content never enter coverage. A zero-eligible rule is truncated only
by a partial analysis window because it has no admitted evidence lane.

## Data flow and isolation

Coverage is computed before rule execution. Evidence lanes are keyed by the
canonical source/session identity (`source`, `source_path`, `session_id`) of
eligible sessions, not `session_id` alone. Each lane builds its own ordered
events, timeline, event index, and matched actions. Rules receive only their
lane:

- R001: edit-fragment sessions, their matched actions and user events.
- R005: tool-timestamp sessions and their matched actions.
- R007: token-usage sessions, their matched actions and events.
- R002/R003/R004/R008: the shared all-session lane.
- R006: history only; its empty requirements make coverage full.

The global lane remains the source for ledger accounting, metrics, command
costs, and R003 read observations. R003 has no required capability, so that
lane is identical to its eligible lane. Mixed Claude/Codex analysis therefore
keeps Claude R007 findings while reporting `1/2`, `partial` coverage.

## Compatibility, rendering, and snapshots

New reports always emit eight coverage entries. `skipped_rules` remains an
optional legacy field, but new writers derive it only from rules with zero
eligible sessions; partial rules with at least one eligible session are not
skipped and do not produce a skip warning. Reports lacking `rule_coverage`
retain their existing JSON, TTY, Markdown, and privacy output bytes.

JSON copies every coverage field explicitly. TTY and Markdown reuse one compact,
deterministically ordered coverage summary and fall back to the existing
`skipped_rules` text for legacy reports. Strict and balanced privacy clone the
numeric, enum, capability, and boolean fields unchanged; raw returns the input
as before. The snapshot policy digest includes canonical coverage and derived
skips, so evidence eligibility or truncation changes snapshot identity without
a Store schema change. Parser/session warning text is never added to output.

## Edge cases and acceptance tests

- Mixed Claude+Codex R007 retains Claude evidence and reports `1/2 partial`.
- R001 and R005 exclude ineligible lanes before timeline/matching.
- Zero eligible, no-required, zero-session, undefined legacy capabilities,
  reordered sessions, missing-capability union/order, and finite ratios.
- Parser budget/truncation warning codes and partial windows set `truncated`
  deterministically without exposing warning content.
- JSON/TTY/Markdown/privacy expose coverage without mutating input.
- Legacy reports without coverage and old stored records remain readable;
  policy snapshots change when coverage changes.

