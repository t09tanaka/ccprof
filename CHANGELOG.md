# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/) and this project adheres
to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-08-03

### Added

- Adoption tracking: fix-recipe suggestions from past analyses are now
  deterministically detected as adopted (CLAUDE.md keyword additions for
  `claude_md`-scope findings, target-file commits for R008 /
  `separate_issue` findings), persisted per repository, and reported in
  `ccprof stats` with post-adoption recurrence, minutes before/after, and an
  adoption-coverage line. Recurrence counting excludes re-analyses of the PR
  that originally surfaced the finding. Observational only — absence of
  recurrence does not prove causation, and the report says so.
- Codex session source: rollout logs under `~/.codex/sessions` (override:
  `CCPROF_CODEX_SESSIONS_DIR`) are discovered alongside Claude Code sessions,
  filtered by repository working directory and branch. Sessions declare
  capabilities, and rules whose required data a source lacks are skipped
  explicitly — reported in `skipped_rules` (JSON v2, additive), as warnings,
  and as a report line — instead of silently misfiring. Codex `apply_patch`
  file paths are extracted so edits classify normally.
- Claude Code hooks integration: `ccprof hooks install` idempotently registers
  a Stop hook (`ccprof hook-event --notify`) that records real end-of-turn
  wall-clock times and prints a dismissal-aware findings summary at most once
  per 10 minutes without persisting analysis records. `ccprof hook-event`
  always exits 0 so a hook failure can never break a session. Hook-recorded
  Stop times extend session ends within a 30-minute window; the verified tail
  counts as measured time and respects the idle threshold.
- `Finding.target` is now carried into reports and stored records (additive).
- Unknown `mcp__*` tools that would otherwise be unexplained are classified as
  coordination with low confidence and an explicit caveat.

### Changed

- README states the positioning boundary explicitly: ccprof measures wasted
  time in the working process and does not judge whether the work itself was
  right. An opt-in LLM advisory layer is noted as a 0.3 candidate;
  deterministic analysis stays the default.
- Source discovery failures are no longer silent: if no sessions remain the
  original error is rethrown, and partial failures surface as
  `session_source_error` warnings with the failing paths.

## [0.1.1] - 2026-08-02

### Changed

- Exclude source maps and declaration maps from the published tarball. The
  build still emits them for local development; they are only dropped from the
  package. 152 files / 160 kB packed becomes 78 files / 94 kB packed (756 kB to
  399 kB unpacked). Compiled JavaScript and `.d.ts` declarations are unchanged.

## [0.1.0] - 2026-08-02

Initial release.

### Added

- Deterministic per-PR analysis pipeline that reconciles Claude Code session
  logs with the final Git diff. No LLM is used, so the same input always yields
  the same result.
- Globally installable `ccprof` CLI (`npm install --global ccprof`) with three
  output formats: a one-screen TTY report, JSON v2 for agents (`--json`), and
  Markdown for PR comments (`--md`).
- PR resolution from an explicit `base...head` / `base..head`, an explicit PR
  number or URL, the current PR, or the remote default branch against `HEAD`.
  Local ranges require no network access.
- Detection rules R001–R008: rework edits absent from the final diff, redundant
  test/build runs, re-reads without an intervening edit, proven approval wait,
  serial independent reads, chronic command cost across analyses, oversized
  results and compaction, and flaky fail→pass runs with no related edit.
- Interval-ledger accounting with `measured_min`, `idle_excluded_min`,
  `estimated_floor_min`, `recoverable_min`, `human_wait_min`, and
  `unexplained_min`. Overlapping sessions and sidechains are unioned rather than
  summed, and sub-threshold human wait is reported separately from unexplained
  time.
- Branch-scoped attribution so that work recorded on other branches within the
  same session never leaks into the current PR.
- Repository-local store under `$XDG_DATA_HOME/ccprof/`, with `ccprof stats`
  (history, baseline, per-rule time, chronic cost, and recurring-finding trends)
  and `ccprof dismiss <finding-key>` (14-day suppression that reopens when the
  estimate exceeds 2× the value at dismissal).
- Configurable idle threshold (`--idle-threshold`) and explicit test relevance
  mapping (`--test-map`), on top of automatic detection from `package.json`,
  `Cargo.toml`, and common test paths.
- Tolerant Claude Code JSONL parser that absorbs schema drift: `message.id`
  dedupe, fragment joining, sidechain and compaction normalization, and
  degradation to warnings and lower confidence instead of aborting.
- Integration templates: a `/retro` slash command and a PR-creation skill
  snippet that auto-fix only `scope: this_pr` findings and never create Issues
  or extra PRs automatically.
- Stable exit codes (0 success, 2 usage, 3 unresolved context, 4 no analyzable
  session, 5 unrecoverable error), plus `--help` / `-h` and `--version` / `-v`.

[0.1.1]: https://github.com/t09tanaka/ccprof/releases/tag/v0.1.1
[0.1.0]: https://github.com/t09tanaka/ccprof/releases/tag/v0.1.0
