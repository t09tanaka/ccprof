# Analysis Window Branch Reflog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefer trustworthy local branch-creation reflog evidence when deriving the analysis-window start, while retaining the frozen-head and commit-anchor fallbacks.

**Architecture:** `resolvePrContext` freezes the requested head first, then optionally probes only the matching local `refs/heads/<branch>` reflog through the injected `CommandRunner`. It publishes one optional timestamp fact; `resolveAnalysisWindow` owns provenance priority and rejects invalid time facts. Explicit `--since` disables the reflog probe entirely.

**Tech Stack:** TypeScript, Node.js test runner, Git CLI through the existing bounded `CommandRunner`.

---

## File map and constraints

- Modify `src/git/pr-context.ts`: collect and validate local branch reflog evidence; derive a conservative unique-commit fallback from both author and committer times.
- Modify `src/core/analyze.ts`: select explicit, reflog, then commit-anchor starts and suppress reflog probing for explicit starts.
- Modify `test/git.test.ts`: exercise the exact Git commands and all reflog trust failures.
- Modify `test/analysis-window.test.ts`: exercise provenance priority, future fallback, invalid metadata, and explicit probe suppression.
- Create this plan only. Do not change the model, CLI, README, integration tests, package metadata, or lockfile. Keep implementation plus test additions within 300 lines.

`HEAD` checkout reflogs are intentionally excluded. They are worktree-specific rather than branch-specific, and old checkout records can resurrect a stale incarnation of a reused branch name. A later change can add session branch-transition evidence without weakening this branch-ref trust boundary.

### Task 1: Specify branch-reflog trust with failing Git tests

**Files:**
- Modify: `test/git.test.ts`

- [x] **Step 1: Update the existing timestamp expectation to conservative commit evidence**

Parse both author and committer seconds for every unique commit and rename the test to state that the global minimum is selected. Include a rebase-like row whose author time predates its committer time:

```ts
assert.deepEqual(args, ["log", "--format=%at%x00%ct", `${BASE}..${HEAD}`]);
return ok(`300\u0000400\n50\u0000500\n200\u0000200\n`);
assert.equal(context.earliestUniqueCommitAtMs, 50_000);
```

- [x] **Step 2: Add RED tests for trusted SHA-1 and SHA-256 branch reflogs**

Use NUL triples in newest-first order and assert that `branchReflogStartedAtMs` is the timestamp from the newest `branch: Created from ...` row:

```ts
const reflog = [
  HEAD, "refs/heads/topic@{300}", "commit: latest",
  "4".repeat(40), "refs/heads/topic@{200}", "branch: Created from main",
  "5".repeat(40), "refs/heads/topic@{100}", "branch: Created from old-main",
  "",
].join("\0");
assert.equal(context.branchReflogStartedAtMs, 200_000);
```

Also assert the exact commands:

```ts
["rev-parse", "--verify", "--quiet", "--end-of-options", "refs/heads/topic^{commit}"]
["reflog", "show", "-z", "--date=unix", "--format=%H%x00%gD%x00%gs", "--end-of-options", "refs/heads/topic"]
```

Repeat the trusted path with 64-hex object IDs so SHA-256 repositories remain supported.

- [x] **Step 3: Add RED table cases for rejected evidence**

Cover local ref/frozen-head mismatch, truncated stdout, malformed NUL arity, malformed OID, malformed selector/timestamp, latest-row race mismatch, and no creation row. Each successful-but-untrusted evidence source must produce exactly one concise context warning and no `branchReflogStartedAtMs`; a missing local branch or failed reflog command must fall back silently.

- [x] **Step 4: Run focused Git tests and observe the intended failures**

Run:

```bash
npm run build:test
node --test .test-dist/test/git.test.js
```

Expected: FAIL because paired commit timestamps, `branchReflogStartedAtMs`, and the reflog commands are not implemented.

### Task 2: Implement bounded branch-reflog collection

**Files:**
- Modify: `src/git/pr-context.ts`

- [x] **Step 1: Extend only the optional context interfaces**

```ts
export interface PrContext {
  // existing fields
  branchReflogStartedAtMs?: number;
}

export interface ResolvePrContextOptions {
  // existing fields
  includeBranchReflog?: boolean;
}
```

- [x] **Step 2: Parse successful reflog output as complete NUL triples**

Add a helper that accepts only a non-truncated, NUL-terminated sequence of `(OID, selector, subject)` triples. Every OID must match the existing SHA-1/SHA-256 pattern, every selector must equal `refs/heads/<branch>@{<unix-seconds>}`, and each seconds value must convert to a nonnegative safe-integer millisecond value. The latest row OID must equal the already frozen head OID. Return the first (newest) subject beginning `branch: Created from `; otherwise return one warning outcome.

- [x] **Step 3: Probe only a trustworthy local branch ref**

Skip `headBranch === "HEAD"`. Otherwise resolve:

```ts
git rev-parse --verify --quiet --end-of-options refs/heads/<branch>^{commit}
```

A nonzero result means the local branch is absent and is silent. A valid local OID unequal to the frozen head emits one mismatch warning. Only an equal OID permits:

```ts
git reflog show -z --date=unix --format=%H%x00%gD%x00%gs --end-of-options refs/heads/<branch>
```

A nonzero reflog result is silent. Truncation, malformed successful output, a latest-row mismatch, or no creation record emits one warning and yields no timestamp.

- [x] **Step 4: Make the commit fallback conservative across both Git clocks**

Replace the misleading author-date comment and `%at` invocation with:

```ts
// The earlier clock avoids excluding work after rebases rewrite committer dates;
// trustworthy branch-creation reflog evidence remains the preferred start.
const args = ["log", "--format=%at%x00%ct", `${baseOid}..${headOid}`];
```

Validate both fields in every row, ignore malformed rows with the existing warning, and take the global minimum of all valid author and committer timestamps.

- [x] **Step 5: Run focused Git tests to GREEN**

Run:

```bash
npm run build:test
node --test .test-dist/test/git.test.js
```

Expected: PASS.

### Task 3: Specify analysis-window provenance and explicit suppression

**Files:**
- Modify: `test/analysis-window.test.ts`

- [x] **Step 1: Add RED provenance tests**

Assert a valid reflog time beats the commit anchor and remains partial:

```ts
assert.deepEqual(
  resolveAnalysisWindow(context({ branchReflogStartedAtMs: 350 })),
  {
    started_at_ms: 350,
    ended_at_ms: 1_000,
    start_source: "branch_reflog",
    end_source: "analysis_time",
    completeness: "partial",
  },
);
```

Also assert explicit `sinceMs` still wins over a valid reflog fact.

- [x] **Step 2: Add RED invalid/future cases**

Negative or unsafe-integer reflog metadata must throw `InvalidAnalysisWindowError`. A reflog timestamp after resolution must add exactly this dedicated warning and then use the existing commit fallback:

```ts
{
  code: "invalid_branch_reflog_start",
  message: "The branch reflog start followed analysis resolution; the commit anchor fallback was used.",
}
```

A reflog creation later than `earliestUniqueCommitAtMs` represents a local branch created from an already-existing PR tip, not the start of the work. Emit `branch_reflog_after_commit_anchor` with `The branch reflog start followed the earliest unique commit; the commit anchor fallback was used.` and fall back.

- [x] **Step 3: Verify RED**

Run:

```bash
npm run build:test
node --test .test-dist/test/analysis-window.test.js
```

Expected: FAIL because reflog provenance and validation are not implemented.

### Task 4: Implement provenance priority and explicit probe suppression

**Files:**
- Modify: `src/core/analyze.ts`

- [x] **Step 1: Validate and select the reflog fact**

After explicit handling and before commit-anchor handling, return `start_source: "branch_reflog"` only when the timestamp is at or before `resolvedAtMs` and, when present, at or before `earliestUniqueCommitAtMs`. For a future timestamp append `invalid_branch_reflog_start`; for one later than the commit anchor append `branch_reflog_after_commit_anchor`; then continue into the unchanged commit fallback.

- [x] **Step 2: Disable collection for explicit starts**

Pass this option into `resolvePrContext`:

```ts
includeBranchReflog: options.sinceMs === undefined,
```

This prevents explicit `--since` analyses from performing a local reflog probe or generating reflog warnings.

- [x] **Step 3: Run both focused suites to GREEN**

Run:

```bash
npm run build:test
node --test .test-dist/test/git.test.js .test-dist/test/analysis-window.test.js
```

Expected: PASS.

### Task 5: Final scope and safety checks

**Files:**
- Inspect only the five files listed above.

- [x] **Step 1: Confirm the diff and line budget**

Run:

```bash
git status --short
git diff --stat
git diff --numstat -- src/git/pr-context.ts src/core/analyze.ts test/git.test.ts test/analysis-window.test.ts
```

Expected: exactly five changed files including this plan; implementation/test additions do not exceed 300 lines.

- [x] **Step 2: Confirm release metadata is untouched**

Run:

```bash
git diff --exit-code -- package.json package-lock.json
```

Expected: exit 0 with no output.

- [x] **Step 3: Confirm focused tests once more**

Run:

```bash
npm run build:test
node --test .test-dist/test/git.test.js .test-dist/test/analysis-window.test.js
```

Expected: PASS with no failures. Do not run the full suite and do not commit; the parent workflow owns those steps.
