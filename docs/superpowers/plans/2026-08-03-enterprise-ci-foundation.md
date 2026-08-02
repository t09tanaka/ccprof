# Enterprise CI Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every pull request run stable correctness, package, dependency, and CodeQL checks while adding the minimum repository security ownership files.

**Architecture:** Keep CI read-only by default and split checks into stable job names suitable for a later GitHub ruleset. Pin third-party actions to reviewed commit SHAs. Add one byte-for-byte reporter golden test so determinism has an explicit required check.

**Tech Stack:** GitHub Actions, Node.js 20, npm, TypeScript, Node test runner.

---

## Scope and edge cases

- Do not change `package.json` or `package-lock.json` version fields.
- Install the packed tarball under `RUNNER_TEMP`, never into the runner's shared global prefix.
- Keep action permissions at `contents: read`; grant `security-events: write` only to CodeQL.
- Keep required-check names literal and matrix-free in this PR.
- Use private vulnerability reporting instead of inventing a security email address.
- Branch rules and repository security toggles are GitHub settings applied only after this PR is merged.

### Task 1: Add a byte-identical JSON golden test

**Files:**
- Create: `test/determinism-golden.test.ts`

- [ ] **Step 1: Add the exact reporter contract fixture**

~~~ts
import assert from "node:assert/strict";
import test from "node:test";

import type { ReportV2 } from "../src/core/model.js";
import { renderJsonReport } from "../src/reporters/json.js";

const report: ReportV2 = {
  version: 2,
  unit: {
    repo: "/repo",
    pr_ref: "main...feature",
    sessions: ["session-a"],
  },
  summary: {
    measured_min: 1,
    idle_excluded_min: 0,
    estimated_floor_min: 1,
    recoverable_min: 0,
    human_wait_min: 0,
    unexplained_min: 0,
    baseline: null,
  },
  findings: [],
  caveats: [],
};

const golden = `{
  "version": 2,
  "unit": {
    "repo": "/repo",
    "pr_ref": "main...feature",
    "sessions": [
      "session-a"
    ]
  },
  "summary": {
    "measured_min": 1,
    "idle_excluded_min": 0,
    "estimated_floor_min": 1,
    "recoverable_min": 0,
    "human_wait_min": 0,
    "unexplained_min": 0,
    "baseline": null
  },
  "findings": [],
  "caveats": []
}
`;

test("JSON report is byte-identical for a fixed analysis snapshot", () => {
  const first = renderJsonReport(report);
  const second = renderJsonReport(structuredClone(report));

  assert.equal(first, golden);
  assert.equal(second, golden);
});
~~~

- [ ] **Step 2: Run only the new gate**

Run: `npm run build:test && node --test .test-dist/test/determinism-golden.test.js`

Expected: 1 test passes and 0 fail.

### Task 2: Add core pull-request checks

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Add stable required jobs**

Use `actions/checkout` commit `3d3c42e5aac5ba805825da76410c181273ba90b1` and `actions/setup-node` commit `820762786026740c76f36085b0efc47a31fe5020`. The workflow must:

- trigger on pushes to `main` and pull requests targeting `main`;
- define jobs named `typecheck`, `unit-and-integration-tests`, `package-smoke`, and `determinism-golden`;
- run `npm ci` before each check;
- run `npm run typecheck`, `npm test`, and the Task 1 command in their matching jobs;
- in package smoke, run `npm pack --pack-destination "$RUNNER_TEMP/ccprof-pack"`, install the sole tarball with `npm install --global --prefix "$RUNNER_TEMP/ccprof-prefix"`, then execute the installed `ccprof --version` and `ccprof --help`;
- use per-job `timeout-minutes: 10` and workflow concurrency cancellation.

- [ ] **Step 2: Validate the workflow syntax by inspection and local command equivalence**

Run the exact local equivalents: `npm run typecheck`, `npm test`, `npm run build:test && node --test .test-dist/test/determinism-golden.test.js`, and an isolated `npm pack` smoke test.

Expected: every command exits 0; the repository version files remain unchanged.

### Task 3: Add security checks

**Files:**
- Create: `.github/workflows/codeql.yml`
- Create: `.github/workflows/dependency-review.yml`

- [ ] **Step 1: Add CodeQL**

Pin every `github/codeql-action` use to `f205ea1c3313d32999d8d6a48b4f6530d4437b38` (v4.37.4). Trigger on pushes and pull requests for `main` plus a weekly schedule. Give only `security-events: write`, `packages: read`, and `contents: read`; initialize `javascript-typescript`, run `npm ci` and `npm run build`, then analyze. The job name is `codeql`.

- [ ] **Step 2: Add dependency review**

Pin `actions/dependency-review-action` to `a1d282b36b6f3519aa1f3fc636f609c47dddb294` (v5.0.0), trigger only on pull requests to `main`, keep `contents: read`, and fail on `moderate` or higher severity. The job name is `dependency-review`.

### Task 4: Add ownership and security maintenance metadata

**Files:**
- Create: `.github/CODEOWNERS`
- Create: `.github/dependabot.yml`
- Create: `SECURITY.md`

- [ ] **Step 1: Add repository ownership**

~~~text
* @t09tanaka
~~~

- [ ] **Step 2: Configure weekly dependency updates**

Configure separate weekly `npm` and `github-actions` update entries rooted at `/`, each with an open pull-request limit of 5. Do not alter any dependency or package version in this PR.

- [ ] **Step 3: Add the reporting policy**

State that the latest release and `main` receive security fixes; older releases are unsupported. Direct reporters to `https://github.com/t09tanaka/ccprof/security/advisories/new`, tell them not to open public issues, request reproduction/impact/affected versions, and make no response-time promise.

### Task 5: Verify, review, and commit

**Files:**
- Verify all files above plus this plan.

- [ ] **Step 1: Run complete verification**

Run: `npm run check`

Expected: typecheck succeeds and all tests, including the new golden test, pass.

- [ ] **Step 2: Run package smoke in an isolated temporary directory**

Run the workflow-equivalent pack/install/help/version sequence using `mktemp -d`.

Expected: both CLI commands exit 0 and no global host prefix changes.

- [ ] **Step 3: Review scope**

Confirm `git diff -- package.json package-lock.json` is empty, no more than the listed files changed, and no worktree-local environment file is staged.

- [ ] **Step 4: Commit**

Stage only the listed files and commit as `ci: establish enterprise pull request checks` with the Codex co-author trailer.
