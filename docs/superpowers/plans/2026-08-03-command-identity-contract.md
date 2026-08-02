# Command Identity Contract and Propagation Plan

> **Goal:** Carry a repository-relative, argv-aware command identity from
> normalized tool CWD evidence through timeline matching, without yet migrating
> rule/store/history grouping.

## Scope and invariants

- Add `CommandIdentity` with `repo_relative_cwd`, `normalized_argv`, and
  `executor`; do not add `selected_env_digest` in this PR.
- Preserve `normalized_command` for the staged R002/R006/R008 and store
  migrations that follow.
- Copy canonical absolute CWD evidence into tool timeline actions; build the
  repository-relative identity only in the matcher, where `repoRoot` exists.
- Never treat missing, relative, mixed-format, or repository-external CWD as
  repository root. Such runs get no identity and never share the successful-run
  cache.
- Use existing non-opaque `classifyCommand()` tokens as argv. Do not invent
  argv for opaque shell syntax or arbitrary native tools.
- Normalize only path separators implied by the detected path flavor. A
  backslash in a POSIX filename is not rewritten as a Windows separator.
- Root identity is `.`, nested identity uses `/`, and tuple keys use JSON
  serialization to avoid delimiter collisions.
- Known shell-runner tool names use `shell`; another tool that explicitly
  carries a command uses `native-tool`. Inputs without a command never get a
  fabricated argv.
- Keep signatures unchanged and add only optional fields. Do not change
  report/store schemas, rules, command-cost aggregation, or package/version
  metadata.

## Files and budget

The hard budget is 7 files including this plan and fewer than 300 added
source/test lines:

- `src/core/model.ts`
- new `src/analysis/command-identity.ts`
- `src/analysis/timeline.ts`
- `src/analysis/diff-matcher.ts`
- `test/command-and-matcher.test.ts`
- `test/timeline.test.ts`
- this plan

TypeScript LanguageService 5.9.3 confirmed that the affected public types have
many consumers (`TimelineAction` 24 references, `MatchedAction` 96,
`matchTimelineActions` 56), so optional fields and unchanged signatures are
required.

## Task 1: Identity contract and pure helpers

- [x] Add `CommandExecutor = "shell" | "native-tool"` and
  `CommandIdentity` to `src/core/model.ts`.
- [x] Add optional `cwd` to `TimelineAction` and optional
  `command_identity` to `MatchedAction`.
- [x] Write RED tests for POSIX root/nested paths, Windows drive/UNC paths,
  relative/outside/different-drive/mixed-format rejection, and separator
  normalization.
- [x] Write RED tests for quoted/empty argv elements, tuple collision
  resistance, and shell/native-tool key separation.
- [x] Implement pure helpers in `src/analysis/command-identity.ts` to:
  - derive repository-relative CWD without filesystem I/O;
  - build an identity from a non-opaque, non-empty command descriptor;
  - serialize the identity as a JSON tuple key;
  - format `. :: npm test` / `packages/api :: npm test` display targets.
- [x] Keep invalid or incomplete inputs as `undefined`; do not fall back to
  the legacy command as an identity key.

## Task 2: Timeline and matcher propagation

- [x] Add RED timeline tests proving tool actions copy `ToolUseEvent.cwd` and
  causal inference actions retain the same CWD evidence.
- [x] Copy CWD at the two timeline action construction sites without changing
  interval/session/tool correlation.
- [x] Build an executor-aware identity for safe command-bearing tools in the
  matcher using `options.repoRoot`, the action/tool CWD, and existing tokens.
- [x] Use the identity tuple key for successful-run cache reads/writes. Runs
  without identity neither seed nor query that cache.
- [x] Use the CWD-aware display as the matched run target while retaining the
  legacy `normalized_command` field unchanged.
- [x] Add the conservative caveat when a recognized run lacks a safe identity.
- [x] Propagate CWD, identity, target, and normalized command from a causal
  tool classification into its inference action.
- [x] Add matcher tests for api → web → api: the web run cannot reuse the api
  success, while the final api run can.
- [x] Prove two identity-less runs never share success cache state and prove
  shell/native-tool tuple keys remain distinct.

## Task 3: Review, verification, and delivery

- [x] Independent specification review confirms the contract, path boundary,
  propagation, and explicit exclusions.
- [x] Independent quality review checks deterministic ordering, no absolute
  path leakage in identity/display, safe command parsing, cache behavior, and
  existing matcher semantics.
- [x] A separate validation worker runs Node 20 `npm ci`, `npm run check`,
  focused command/matcher/timeline tests, determinism, build, and package
  smoke.
- [x] Run the repository's local GitHub Actions equivalent before push because
  matcher logic changes.
- [x] Confirm exactly 7 changed files, fewer than 300 added source/test lines,
  clean diff, and no package/version/CHANGELOG change.
- [ ] Commit, rebase onto current `origin/main`, revalidate, push, and create a
  PR against `main`.
- [ ] Complete required remote checks and review, then merge under the user's
  authorization and clean up only this worktree/local branch.

## Explicit follow-ups

- R002 grouping, evidence, target, and finding-key migration.
- Command-cost/store compatibility and stats/R006 migration.
- R008 flaky episode grouping/history migration.
- Environment-sensitive identity via an optional selected environment digest.
