# Versioned Repository Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load a version-controlled `.ccprof/config.json` through a strict v1
contract, apply its test mappings between CLI and manifest mappings, publish its
JSON Schema, and attribute it in the existing snapshot `config_digest`.

**Architecture:** A focused repository-config loader owns fixed-path safe I/O and
closed-object validation, then delegates mapping normalization to the existing
test-map parser. Test maps gain a `config` provenance and optional repository
schema version; the existing resolution and snapshot pipeline consumes those
values without changing CLI, report, package, or Store versions.

**Tech Stack:** TypeScript, Node.js 20 filesystem APIs and test runner, JSON
Schema draft 2020-12.

---

## Scope boundary

- This PR implements config v1 only.
- Workspace-scoped mappings require command-CWD-aware mapping selection and are
  a follow-up worktree/PR.
- npm/pnpm/Cargo nested manifests and Nx, Turborepo, Bazel, Gradle, Maven, and Go
  adapters follow after that foundation. They are not partially approximated here.
- Package version stays `0.2.0`; Report schema stays v2; Store schema stays v2.
- Maximum: ten changed files and fewer than 300 added production lines.

## Edge cases and invariants

- Missing `.ccprof/config.json` is byte-compatible with current map resolution and
  snapshot config digests.
- The config path is fixed below the resolved repository root. `O_NOFOLLOW` and
  a regular-file check reject symlinks, directories, and other special files.
- Malformed JSON, unreadable input, unknown version, unknown key at any object
  level, invalid `$schema`, unsafe path/glob, and invalid command fail closed.
- Errors name `.ccprof/config.json` but do not echo arbitrary file contents or an
  absolute external target.
- `$schema` is informational and excluded from digest input. `schema_version: 1`
  is included when the repository config exists, even if its mapping list is empty.
- For each matching command, origin precedence is `explicit` > `config` >
  `manifest`; unrelated lower-level mappings remain available as fallback.
- Existing normalization, deterministic snapshot sorting, and mapping
  deduplication remain authoritative.

## Semantic impact analysis

`ts-rename-helper` is unavailable. TypeScript Language Service references were
inspected before implementation:

- `TestMapOrigin`: three declarations/usages, all in `src/analysis/test-map.ts`.
- `discoverManifestTestMap`: implementation, `src/core/analyze.ts`, and two test
  call sites (six semantic references including import/definition).
- `loadExplicitTestMap`: implementation, `src/core/analyze.ts`, and two test call
  sites (six semantic references including import/definition).
- internal `resolveTestMap`: definition and one call in `src/core/analyze.ts`.
- No public CLI, Report, Store, or shared model signature changes are needed.

### Task 1: Specify RED repository-config behavior

**Files:**
- Modify: `test/command-and-matcher.test.ts`

- [ ] Add a missing-config test expecting an empty map with no config schema
  version.
- [ ] Add a valid v1 test that writes `.ccprof/config.json`, includes `$schema`,
  and verifies normalized paths/commands, `origin: "config"`, and schema version 1.
- [ ] Add table-driven rejection tests for malformed JSON, version 2, unknown
  keys at all levels, wrong `$schema` type, traversal/absolute paths, and invalid
  commands.
- [ ] Add symlink and non-regular-file rejection tests.
- [ ] Add a packaged-schema test that checks its closed-object shape and the npm
  `files` allowlist.
- [ ] Defer execution to the independent validator as explicitly required; the
  expected initial failure is the missing repository-config module/schema.

### Task 2: Add config provenance and precedence RED tests

**Files:**
- Modify: `test/command-and-matcher.test.ts`

- [ ] Construct explicit, config, and manifest mappings for the same command with
  disjoint source globs.
- [ ] Assert explicit wins when present, config wins without explicit, and
  manifest wins without either higher origin.
- [ ] Assert merge order and propagated config schema version are deterministic.
- [ ] Defer the focused RED execution to the validator; expected failure is that
  `config` is not a valid `TestMapOrigin` and no precedence tier exists.

### Task 3: Implement the strict config loader and published schema

**Files:**
- Create: `src/analysis/repository-config.ts`
- Create: `schemas/config.schema.json`
- Modify: `package.json`

- [ ] Add `RepositoryConfigError` and `loadRepositoryConfig(repoRoot)`.
- [ ] Open only `<repoRoot>/.ccprof/config.json` with `O_RDONLY | O_NOFOLLOW`,
  verify `FileHandle.stat().isFile()`, read UTF-8, and close on every path.
- [ ] Return an empty map only for `ENOENT`; convert all other I/O and validation
  failures to stable repository-relative errors.
- [ ] Validate exact allowed keys and scalar/container types before passing the
  test-map payload to the existing parser for path/glob/command normalization.
- [ ] Add the draft-2020-12 JSON Schema with `const: 1`, closed objects, and the
  same array/string constraints as runtime validation.
- [ ] Add `schemas` to package `files` without changing package version or lockfile
  metadata.

### Task 4: Implement origin precedence and config loading

**Files:**
- Modify: `src/analysis/test-map.ts`
- Modify: `src/core/analyze.ts`

- [ ] Extend `TestMapOrigin` with `config` and `TestMap` with optional
  `config_schema_version: 1`.
- [ ] Let the repository loader relabel normalized explicit mappings as config
  mappings with a config-specific caveat.
- [ ] Update `mergeTestMaps` to retain the single supported schema version.
- [ ] Select applicable mappings by explicit/config/manifest precedence in
  `evaluateTestRelevance`.
- [ ] Load repository config alongside root manifests in `resolveTestMap`, always
  validate it, and merge CLI/injected, config, and manifest layers.
- [ ] Add `repository_config_schema_version` to the existing config-digest input
  only when config exists; keep absent-config digest bytes unchanged.

### Task 5: Prove snapshot attribution

**Files:**
- Modify: `test/analyze-integration.test.ts`

- [ ] Analyze the same repository/session before and after adding a valid empty v1
  config, using the existing SQLite test store.
- [ ] Read the canonical snapshot envelopes and assert their `config_digest`
  values differ while package/report/store versions remain untouched.
- [ ] Defer RED/GREEN runs and the full suite to the independent validator.

### Task 6: Document the repository-owned contract

**Files:**
- Modify: `README.md`

- [ ] Replace the external-only test-map section with automatic root manifests,
  `.ccprof/config.json` v1 example, strict failure behavior, precedence, schema
  location, and retained `--test-map` override.
- [ ] State that nested workspace adapters are not yet inferred and require
  explicit mappings until the follow-up PR.
- [ ] Reassert package `0.2.0`, JSON Report v2, and Store schema v2 are unchanged.

### Task 7: Delegated validation and handoff

- [ ] Independent validator runs focused tests, typecheck, complete Node test
  suite, build, `git diff --check`, and package smoke showing the schema in the
  tarball.
- [ ] Reassert no package/report/store version changes and no workspace adapter
  implementation leaked into this PR.
- [ ] Review changed-file count and production additions; stop and split if the
  approved budget is exceeded.
- [ ] Only after validation, the root agent handles commit, push, PR, CI, review,
  merge, and worktree cleanup through `worktree-pr-flow`.
