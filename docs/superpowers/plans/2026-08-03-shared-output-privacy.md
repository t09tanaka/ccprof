# Shared Output Privacy Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repository paths, source/store locations, raw session identifiers, and untrusted commands from reaching shared `ccprof` output while preserving an explicit byte-compatible `raw` escape hatch.

**Architecture:** Keep `ReportV2`, analysis records, and Store data raw and unchanged. Immediately before rendering, clone the report into a deterministic display projection for `strict` or `balanced`; renderers and the optional advisory consume only that projection. CLI warning and error text passes through the same profile. `strict` is fail-closed for detailed evidence and commands, while `balanced` retains locally useful sanitized detail. Package and report schema versions remain unchanged.

**Tech Stack:** TypeScript 5.9, Node.js 20 crypto/path APIs, existing JSON/Markdown/TTY reporters and Node test runner

---

## Scope, semantic impact, and budget

Exactly seven files may change:

- Add: `src/reporters/privacy.ts`
- Modify: `src/commands/analyze.ts`
- Modify: `src/cli.ts`
- Modify: `test/reporters-and-cli.test.ts`
- Modify: `test/advisory.test.ts`
- Modify: `README.md`
- Add: `docs/superpowers/plans/2026-08-03-shared-output-privacy.md`

Added production code must stay below 300 lines. Do not modify `ReportV2`, core analysis, parsers, Store, reporter output structure, rules, package metadata, package/report version, changelog, `/retro`, or PR integration templates. Local `ccprof explain`, trusted agent execution, and integration-template changes are the next isolated P0-4 task; full ReportV3 audit metadata remains P1.

`ts-rename-helper` is unavailable. TypeScript LanguageService semantic references were checked through `tsconfig.test.json`: `renderJsonReport` is referenced by `commands/analyze.ts`, four reporter/advisory/determinism test areas, and its definition; `renderMarkdownReport` and `renderTtyReport` are referenced only by `commands/analyze.ts`, reporter tests, and their definitions. `AnalyzeCommandOptions` has references in `commands/analyze.ts` and `cli.ts`; `ParsedAnalyzeCommand` is closed inside `cli.ts`; `CliRuntime` is referenced only inside `cli.ts` and tests. The display projection therefore stays at the command/render boundary without changing shared report contracts.

## Edge cases fixed before implementation

- `raw` preserves the current JSON v2 values and ordering; terminal-control sanitization in human reporters remains active.
- `strict` and `balanced` never mutate the raw report or persisted analysis record.
- Repeated projection of the same report is byte-deterministic, while aliases are scoped by the complete raw report so a changed analysis cannot be linked by raw session identifiers.
- Session IDs containing `#`, Unicode, regex metacharacters, or overlapping prefixes are treated as opaque full values; session refs and interval IDs are independently hashed.
- Reversible finding keys that embed command identity or paths are replaced by opaque analysis-scoped keys.
- Repository-root paths are recognized only on a separator boundary (`/repo2` is not under `/repo`); POSIX, Windows-drive, UNC, and mixed separators are scrubbed.
- Repository-relative paths may remain useful; external absolute paths never retain even a basename.
- `strict` drops unknown detailed evidence fields and the optional finding target, retaining only opaque session/interval references and non-sensitive finding metadata.
- A strict command is visible only when it exactly matches the fixed trusted verification allowlist and contains no secret. Shell composition, env assignments, extra arguments, URLs, credentials, tickets, and unknown commands are replaced as a whole.
- Balanced evidence remains available but raw session IDs, absolute paths, URLs/credentials, token/password/API-key forms, authorization headers, JWT/PEM-like values, and secret-bearing commands are deterministically redacted.
- Commands copied into a title, target, suggestion, verify string, caveat, `command_identity.normalized_argv`, or unknown JSON evidence cannot bypass the projection.
- Strict parser/store warnings are grouped by code and count only; their message, line, session ref, source path, and store path do not reach stdout or stderr.
- Markdown is strict by default; JSON and local TTY are balanced by default; a detected CI invocation is strict regardless of format; an explicit profile always wins.
- `--privacy` accepts separated and inline values, rejects missing/unknown/duplicate values as usage errors, and does not affect non-analyze commands.
- Advisory input is rendered from the selected display projection, never from the raw report.
- Strict operational errors are scrubbed even when analysis throws before returning a report.

### Task 1: Specify the privacy boundary with RED tests

**Files:**
- Modify: `test/reporters-and-cli.test.ts`
- Modify: `test/advisory.test.ts`

- [x] Add CLI parsing/default/override cases for `strict`, `balanced`, and `raw`, including CI forcing and invalid/duplicate arguments.
- [x] Build one compact canary report/warning fixture spanning repo/source/store paths, usernames, sessions/refs/interval IDs, reversible finding keys, internal URLs/tickets/tokens, command arrays, suggestions, verify commands, caveats, and unknown evidence.
- [x] Assert strict JSON/Markdown/TTY, stderr warnings, operational errors, and advisory input contain no canary; warning codes are counted and aliases are consistent.
- [x] Assert balanced output retains safe relative evidence while removing paths, sessions, URLs, and secrets.
- [x] Assert explicit raw output preserves existing JSON v2 values and report projection never mutates its input.
- [x] Keep the pre-existing advisory contract tests explicitly on `raw`; the new strict test separately proves advisory input is projected.
- [x] Have a validation subagent run the focused reporter/CLI suite and record RED failures attributable to the missing implementation, then confirm the final 52/52 focused suite under Node 20.

### Task 2: Implement deterministic display projection

**Files:**
- Add: `src/reporters/privacy.ts`
- Modify: `src/commands/analyze.ts`
- Test: `test/reporters-and-cli.test.ts`

- [x] Define `PrivacyProfile`, deterministic defaults, the redacted-command marker, and an immutable `ReportV2` display projection.
- [x] Use anonymous repository IDs, opaque analysis-scoped finding/session/ref/interval aliases, boundary-aware path scrubbing, and deterministic secret/URL redaction.
- [x] Make strict findings fail closed for evidence and commands; make balanced findings retain only sanitized detail; aggregate strict warnings by code/count.
- [x] Project once before JSON/Markdown/TTY rendering and reuse the same projected JSON for advisory input.
- [x] Sanitize command warnings using the selected profile and confirm focused projection tests are GREEN through a validation subagent.

### Task 3: Add CLI policy and safe defaults

**Files:**
- Modify: `src/cli.ts`
- Test: `test/reporters-and-cli.test.ts`

- [x] Parse `--privacy <profile>` and `--privacy=<profile>` exactly once.
- [x] Select balanced for local TTY/JSON, strict for Markdown, and strict for injected/detected CI unless the user explicitly overrides it.
- [x] Carry the active profile through analyze dispatch and scrub thrown analyze errors at the CLI boundary.
- [x] Preserve current exit-code and usage behavior.

### Task 4: Document, review, verify, and deliver

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-03-shared-output-privacy.md` (checkboxes only after evidence exists)

- [x] Document profile semantics, defaults, CI behavior, explicit raw risk, advisory behavior, and the fact that raw Store data remains local.
- [x] Run independent specification and code-quality reviews; fix only defects introduced within these seven files and re-review to PASS / APPROVED.
- [x] Have a separate validation subagent run Node 20 `npm ci`, `npm run check` (497/497), determinism (1/1), build, and isolated package smoke.
- [x] Run the repository's local GitHub Actions equivalent before push because output policy and CLI logic changed; every locally reproducible CI job passed.
- [x] Confirm exactly seven changed files, 297 added production lines, no Report/Store/parser/rule/package/version/changelog diff, and no generated artifact contamination.
- [x] Commit without amend, push, open PR #39 against `main`, and wait for every remote check and actionable review; all seven checks passed and no actionable review was posted.
- After the PR is merged under the user's standing authorization, clean up only this worktree and its local/remote branch.
