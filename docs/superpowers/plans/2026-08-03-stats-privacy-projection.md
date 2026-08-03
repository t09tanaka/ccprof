# Stats Privacy Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Tests and static analysis must be run by the sonnet verifier, not the owner.

**Goal:** Route every existing `ccprof stats` display, warning, and failure
through an effective privacy profile while preserving byte-identical raw
output and all persisted data.

**Architecture:** Parse stats privacy in the existing CLI, force strict in CI,
and pass the effective profile into `runStatsCommand`. Summarize raw Store data
as today, then call one pure shared privacy projection before the existing JSON
or TTY renderer. Reuse the existing finding aliases, text/command sanitizers,
and warning projector.

**Tech stack:** TypeScript 5.9, Node.js 20, existing Node test runner and npm
package smoke workflows.

---

## Constraints and edge cases

- CI cannot be weakened by `--privacy raw` or `--privacy balanced`.
- Local explicit privacy wins; local default is balanced.
- `raw` JSON and TTY output remain byte-for-byte compatible with the current
  implementation, including raw warning formatting.
- Strict/balanced finding references are opaque, stable for repository/key,
  and consistent across recurring/adoption sections.
- Strict chronic output uses only the fixed safe-command allowlist or the
  existing redacted marker and never emits command identity.
- Balanced retains only a safe root-level identity whose argv is an exact
  allowlisted command; unsafe identity is omitted rather than partially shown.
- POSIX, Windows, UNC, repository, URL, token/credential, recognizable session,
  and argv-secret canaries do not survive strict or balanced projection.
- Numeric fields, timestamps, rule IDs, bounds, trends, methods, and statuses
  are unchanged.
- Projection and warning handling are deterministic and non-mutating.
- Strict parse and operational exceptions remain path-free.
- No Store/policy/Report schema, migrations, aggregation, or new command family.

The production change is limited to `src/cli.ts`, `src/commands/stats.ts`, and
`src/reporters/privacy.ts`. The full change must remain at or below ten files
and 300 added implementation lines.

## Task 1: RED CLI and dispatch policy

**Files:** `test/reporters-and-cli.test.ts`, `src/cli.ts`,
`src/commands/stats.ts`

- [x] Add parser tests for separated/inline profiles plus missing, empty,
  invalid, and duplicate privacy values.
- [x] Add dispatch tests for local balanced default, each local explicit
  profile, CI-forced strict despite raw/balanced requests, warning protection,
  and strict path-free exceptions.
- [x] Ask the sonnet verifier to run the focused tests and record failures
  caused by the absent implementation.
- [x] Add optional privacy to `ParsedStatsCommand`, required effective privacy
  to `StatsCommandOptions`, early active-profile selection, and stats dispatch.
- [x] Ask the verifier to confirm focused GREEN.

## Task 2: RED pure stats projection

**Files:** `test/reporters-and-cli.test.ts`, `src/reporters/privacy.ts`

- [x] Add a complete `StatsReport` canary fixture and assert raw render byte
  equivalence.
- [x] Assert strict/balanced stable references and removal of repository,
  POSIX/Windows/UNC paths, URLs, tokens, sessions, and argv secrets.
- [x] Assert strict identity omission, safe-command/marker behavior, balanced
  safe `npm test` retention, and unsafe identity omission.
- [x] Assert exact numeric/enumeration preservation, deterministic repeats,
  and no mutation of nested arrays/objects.
- [x] Ask the verifier to run focused tests and record RED.
- [x] Implement `projectStatsPrivacy` using existing privacy helpers; keep raw
  as the unchanged fast path and clone every strict/balanced branch.
- [x] Ask the verifier to confirm focused GREEN.

## Task 3: Integrate Store warnings and rendering

**Files:** `src/commands/stats.ts`, `test/reporters-and-cli.test.ts`

- [x] Add warning tests for strict code/count aggregation, balanced sanitized
  text/path markers, and raw existing text.
- [x] Adapt Store warnings to `privacyWarningTexts`, call stats projection after
  `summarizeStats`, and render only the projected report.
- [x] Add direct command tests for JSON/TTY profile behavior and raw bytes.
- [x] Ask the verifier to confirm focused GREEN.

## Task 4: Documentation and package smoke

**Files:** `README.md`, `.github/workflows/ci.yml`,
`.github/workflows/release-assets.yml`, `test/release-workflow.test.ts`

- [x] Document `stats --privacy`, local balanced default, CI-enforced strict,
  raw risk, and unchanged Store data.
- [x] Make CI and release installed-package smoke invoke
  `stats --privacy strict --json` and test that workflow contract.
- [x] Ask the verifier to run focused docs/workflow tests, typecheck, and the
  full test suite.

## Task 5: Review, CI, PR, merge, and cleanup

- [x] Commit implementation and required `docs/superpowers/` artifacts without
  amend; exclude worktree-only configuration.
- [x] Run independent specification review, then independent code-quality
  review; fix only in-scope defects and re-review until approved.
- [ ] Delegate the repository's local GitHub Actions equivalent, including
  typecheck, full tests, package smoke, determinism, and CodeQL build phase.
- [ ] Push `feature/stats-privacy-projection` and open a PR against the default
  branch titled `[Privacy] feat: project stats through privacy profiles` with
  Summary, Impact, Test plan, Tests, and Rollback sections.
- [ ] Wait for remote CI and actionable review; make new commits for any fixes.
- [ ] Merge with `gh pr merge --merge`, sync main, then remove only this
  worktree/local branch (and remote branch if GitHub did not remove it).
