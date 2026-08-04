# Doctor CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, read-only `ccprof doctor [--json]` command that reports configuration, policy, source, budget, Store, and encryption readiness without exposing sensitive values.

**Architecture:** A focused doctor command builds one fixed-order diagnostic snapshot and renders either text or JSON from that snapshot. It reuses repository configuration, organization policy, source contract, Store path, and Store schema APIs; SQLite is opened with `readonly` and `fileMustExist`, and missing or migration-pending stores are reported without creating or upgrading anything. CLI dispatch remains isolated so every existing command keeps its current parsing and output behavior.

**Tech Stack:** TypeScript ESM, Node.js filesystem APIs, better-sqlite3 read-only connections, node:test.

---

## Scope and edge cases

- The check order is fixed: `configuration`, `organization_policy`, `source_capabilities`, `parser_budgets`, `store_schema`, `store_migrations`, `store_open`, `encryption`.
- A missing repository config is valid. Malformed JSON, unknown fields, unsafe symlinks, permission failures, and a file that changes during read are failures with a fixed code and bounded generic message.
- Organization policy can be absent, fully configured and applicable, or fail closed because its four environment variables are partial, unreadable, mismatched, or untrusted. Paths, organization names, signatures, and key material are never returned.
- Built-in Claude and Codex contracts are snapshotted and sorted; custom sources are outside this command because no custom source is selected by `doctor`.
- The current CLI has no operator-configurable analyzer budget profile. This is a truthful warning, not a fabricated pass or zero-valued budget.
- A missing Store is `not_initialized` and must not create a directory or database. A regular existing database is opened read-only; old supported versions are migration-pending warnings, the current version requires all current migration markers, and future/corrupt/unsafe/unreadable stores fail with fixed codes.
- SQLite diagnostics must not enable WAL, chmod, migrate, repair, backfill, vacuum, or write any pragma. Concurrent replacement or deletion produces a bounded failure.
- This release has no Store encryption/key-management consumer, so encryption is an explicit warning rather than a false pass.
- Text and JSON omit timestamps and raw exception strings. The same state produces byte-identical output. JSON keys and check order are fixed.
- Exit `0` means no failed checks (warnings may exist), exit `1` means one or more failed checks, exit `2` remains CLI usage failure, and existing exit codes/commands remain unchanged.
- Windows file identity and permissions are not inferred; only portable regular-file/symlink checks and SQLite read-only open are used.

### Task 1: Define the doctor contract with failing tests

**Files:**
- Create: `test/doctor-command.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing command tests**

Add tests that call `runCli(["doctor"] ...)` and `runCli(["doctor", "--json"] ...)` in temporary repositories. Assert the eight IDs and stable order, JSON/text determinism across two runs, `0` for pass/warn, `1` for malformed repository config, `2` for extra/unknown arguments, no raw malformed content or configured paths in output, and no Store creation for a missing Store.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build:test && node --test .test-dist/test/doctor-command.test.js`

Expected: FAIL because `doctor` is parsed as analysis input and no doctor result exists.

- [ ] **Step 3: Commit the RED contract**

```bash
git add test/doctor-command.test.ts docs/superpowers/plans/2026-08-05-doctor-cli.md
git commit -m "test: define doctor diagnostics contract"
```

### Task 2: Implement the read-only snapshot and renderers

**Files:**
- Create: `src/commands/doctor.ts`
- Modify: `src/cli.ts`
- Test: `test/doctor-command.test.ts`

- [ ] **Step 1: Implement the minimum snapshot**

Create `DoctorCheck` and `DoctorReport` closed shapes with fixed status/code/message fields. Reuse `loadRepositoryConfig`, `loadRepositoryPolicyPreferences`, `loadConfiguredOrganizationPolicy`, `resolveEffectivePolicy`, `CLAUDE_SESSION_SOURCE_CONTRACT`, `CODEX_SESSION_SOURCE_CONTRACT`, `resolveStorePaths`, `storeDatabasePath`, `STORE_SCHEMA_VERSION`, and the three exported migration names. Open an existing regular non-symlink database only as `new Database(path, { readonly: true, fileMustExist: true })`, read `user_version`, current migration names, and `PRAGMA quick_check`, then close it in `finally`.

- [ ] **Step 2: Implement deterministic rendering and exit status**

Return `{ stdout, warnings: [], exitCode }`; JSON uses `JSON.stringify(report, null, 2)`, while text emits `ccprof doctor: <status>` followed by one `[PASS|WARN|FAIL] <id>: <message>` line per fixed-order check. Derive overall status from checks, with any fail winning over warn.

- [ ] **Step 3: Add strict CLI parsing and dispatch**

Parse only `doctor` and `doctor --json`; include the command in usage; dispatch directly to `runDoctorCommand({ cwd, json, env: process.env })` and return its exit code. Do not change analysis, schema, rules, policy preloading, or existing handler contracts.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run build:test && node --test .test-dist/test/doctor-command.test.js`

Expected: PASS with deterministic text/JSON, safe failures, and no Store writes.

- [ ] **Step 5: Commit implementation**

```bash
git add src/commands/doctor.ts src/cli.ts test/doctor-command.test.ts
git commit -m "feat: add read-only doctor diagnostics"
```

### Task 3: Document and verify the public command

**Files:**
- Modify: `README.md`
- Test: `test/doctor-command.test.ts`

- [ ] **Step 1: Add a failing documentation assertion**

Assert README documents `ccprof doctor [--json]`, all eight check categories, read-only/no repair behavior, and exit codes `0`, `1`, and `2`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build:test && node --test .test-dist/test/doctor-command.test.js`

Expected: FAIL because README has no doctor section.

- [ ] **Step 3: Add concise operator documentation**

Update the Commands block and add a Doctor section describing deterministic output, warnings, privacy-safe messages, read-only Store inspection, unsupported encryption status, and the exit code contract.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run build:test && node --test .test-dist/test/doctor-command.test.js`

Expected: PASS.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md test/doctor-command.test.ts
git commit -m "docs: describe doctor diagnostics"
```

### Task 4: Review and release gates

**Files:**
- Review: all branch changes

- [ ] **Step 1: Confirm scope mechanically**

Run `git diff --stat origin/main...HEAD` and production-line counts. Expected: at most 10 changed files and at most 300 changed production TypeScript lines.

- [ ] **Step 2: Run delegated verification**

Delegate focused test, `npm run check`, `npm run build`, and the changed-workflow local GitHub Actions reproduction to test agents. Expected: all pass.

- [ ] **Step 3: Run spec then quality review**

Spec review must confirm every requested check and read-only/privacy/exit behavior. Quality review must find no P0-P2 correctness, privacy, determinism, or cross-platform issue.

- [ ] **Step 4: Commit review fixes without amend**

For each issue, first add a focused failing regression test, verify RED, implement the smallest fix, verify GREEN, and create a new `fix:` commit.

- [ ] **Step 5: Push, open PR, monitor CI and review, then merge and clean up**

Push only after local Actions pass. Create a PR to `main`, run the ccprof PR self-profile if available, monitor all remote checks and independent review in parallel, merge with a merge commit under the user's standing authorization, then remove the clean worktree and local feature branch.
