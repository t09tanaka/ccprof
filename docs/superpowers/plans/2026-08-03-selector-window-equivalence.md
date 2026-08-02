# Selector Window Equivalence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the P0-1 contract that PR-number and PR-URL selectors produce the same analysis semantics as an explicit base/head range when all three resolve to the same frozen commit OIDs and use the same explicit analysis window.

**Architecture:** Add one characterization-style integration test to the existing real-repository analyzer suite. The test creates real base/head commits and a real Claude transcript, intercepts only `gh pr view` to return those frozen OIDs, delegates every Git operation to the real command runner, and compares selector-independent analysis semantics. No production code, package metadata, or version file changes are needed.

**Tech Stack:** TypeScript, Node.js 20 built-in test runner, real `git`, existing `ClaudeSessionSource`, existing `analyze` orchestration.

---

### Task 1: Lock selector equivalence in the full analyzer

**Files:**
- Modify: `test/analyze-integration.test.ts`

- [x] **Step 1: Import the command-runner type used by the `gh` interception boundary**

Change the existing Git client import to:

```ts
import {
  runCommand,
  type CommandRunner,
} from "../src/git/client.js";
```

- [x] **Step 2: Add the real-repository selector-equivalence test**

Add a test next to the primary analyzer integration test that:

1. Builds the repository with `makeRepository`, resolves its real `main` and `feature` commit OIDs, and builds the real Claude fixture with `makeClaudeProjects`.
2. Defines `startedAtMs = Date.parse("2026-01-01T00:00:00.000Z")`, keeps `nowMs = NOW_MS`, and uses `persist: false` for all three analyses.
3. Supplies a `CommandRunner` that intercepts only `gh pr view 17` and `gh pr view <URL>`, returning metadata whose `baseRefOid` and `headRefOid` are the real frozen OIDs; unexpected `gh` calls fail closed, and non-`gh` commands are delegated to `runCommand`.
4. Runs `analyze` for `"17"`, the PR URL, and `"main...feature"`, each with a fresh `ClaudeSessionSource` and the same explicit window/store/test map.
5. Projects selector-independent semantics exactly as follows:

```ts
const comparable = (result: Awaited<ReturnType<typeof analyze>>) => ({
  window: result.window,
  report: {
    version: result.report.version,
    unit: {
      repo: result.report.unit.repo,
      sessions: result.report.unit.sessions,
    },
    summary: result.report.summary,
    findings: result.report.findings,
    caveats: result.report.caveats,
    ...(result.report.skipped_rules === undefined
      ? {}
      : { skipped_rules: result.report.skipped_rules }),
  },
  all_findings: result.allFindings,
  ledger: result.ledger,
  metrics: result.record.metrics,
  command_costs: result.record.command_costs,
  read_observations: result.record.read_observations,
  warnings: result.warnings,
  suppressed_keys: result.suppressedKeys,
});
```

6. Deep-compares both GitHub selector results with the explicit-range result while excluding only the selector-preserving `report.unit.pr_ref`, asserts the complete explicit window, and asserts that the intercepted selectors were exactly the number and URL.

- [x] **Step 3: Verify the contract with focused validation**

Delegate static analysis and tests to the validation agent. Run:

```sh
npm run build:test
node --test --test-name-pattern="PR number, PR URL, and explicit range" .test-dist/test/analyze-integration.test.js
```

Expected: the new integration test passes, demonstrating that existing production behavior already satisfies the contract. Because this is a characterization test for an existing behavior, no deliberate production failure or test-only sabotage is introduced to manufacture a RED phase.

### Task 2: Validate scope and hand off without publishing

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-selector-window-equivalence.md`

- [x] **Step 1: Run the repository validation through the validation agent**

Run under Node.js 20:

```sh
npm run check
git diff --check
```

Expected: typecheck succeeds, the full test suite succeeds, and the diff has no whitespace errors.

- [x] **Step 2: Confirm the scope guard**

Inspect `git status --short`, `git diff --stat`, and `git diff -- package.json package-lock.json`. Expected: only this plan and `test/analyze-integration.test.ts` changed; no production, package, or version files changed; fewer than 10 files and fewer than 300 added lines.

- [x] **Step 3: Hand the clean diff back to the parent flow**

Do not commit, push, create a PR, or merge in this task. Report the exact changed files, added-line count, validation result, and any caveats so the parent `worktree-pr-flow` can perform its required review and publishing stages.
