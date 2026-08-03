# Advisory Process Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep privacy-projected advisory reports out of process metadata while bounding advisory input/output and terminating timed-out descendant processes without changing ordinary git/gh command behavior.

**Architecture:** Extend the existing `CommandRunner` with optional, backward-compatible stdin, environment, and process-tree controls. The advisory boundary will preflight the complete UTF-8 prompt, pass it only through stdin to `claude -p`, use an exact minimal environment allowlist, and reject truncated stdout. Default runner behavior remains inherited environment, ignored stdin, and single-process timeout termination.

**Tech Stack:** TypeScript 5.9, Node.js `child_process.spawn`, Node's built-in test runner, existing ccprof command/advisory abstractions.

---

## Scope and edge cases

- In scope: audit 4.2 only—advisory stdin, UTF-8 preflight, minimal environment, per-stream output caps, EPIPE handling, and timeout process-tree termination.
- Out of scope: signed organization policy, Report v3, Store/schema changes, new CLI flags, and changes to ordinary git/gh invocations.
- UTF-8 limits are measured in bytes, not JavaScript code units; over-limit prompts fail before the runner is called and are never truncated.
- The report canary may appear only in `CommandOptions.stdin`; it must not appear in argv, environment, warning reasons, or captured runner error text.
- stdout and stderr each receive their own 64 KiB capture budget. Any stdout truncation makes the advisory unavailable; the existing 2,000-character display limit remains unchanged for complete output.
- stdin completion can race with child exit. EPIPE or another stdin write failure must produce a nonzero result without embedding stdin content in diagnostics.
- POSIX process-tree termination uses a detached process group and a negative-PID signal only when explicitly requested. Windows uses shell-free `taskkill /PID <pid> /T /F`. Existing callers keep single-process behavior.
- The advisory environment is a fixed allowlist. Claude/Anthropic credentials are allowed only in the child environment and must never be copied into diagnostics.

### Task 1: Specify command-runner stdin and process controls

**Files:**

- Modify: `test/git.test.ts`
- Modify: `src/git/client.ts`

- [x] **Step 1: Add failing runner tests**

Add focused tests for UTF-8 stdin roundtrip, pre-spawn byte rejection, replace-vs-inherit environment behavior, EPIPE/non-reading-child failure, independent output caps, and descendant timeout termination. The core assertions are:

```ts
const roundtrip = await runCommand(
  process.execPath,
  ["-e", "process.stdin.pipe(process.stdout)"],
  { stdin: "日本語", maxStdinBytes: 9 },
);
assert.equal(roundtrip.stdout, "日本語");

await assert.rejects(
  runCommand(process.execPath, ["-e", "process.exit(0)"], {
    stdin: "日本語",
    maxStdinBytes: 8,
  }),
  /stdin exceeds maxStdinBytes/u,
);
```

The descendant test creates a temporary marker path, starts a descendant that would write it after the timeout, runs with `killProcessGroup: true`, waits beyond the write delay, and asserts the marker does not exist.

- [x] **Step 2: Delegate the focused test and verify RED**

Run:

```sh
npm run build:test && node --test --test-name-pattern='runCommand' .test-dist/test/git.test.js
```

Expected: FAIL because `stdin`, `maxStdinBytes`, `envMode`, and `killProcessGroup` are not implemented and descendant termination leaves the marker-writing process alive.

- [x] **Step 3: Add backward-compatible command options and implementation**

Extend `CommandOptions` without changing the `CommandRunner` signature shape:

```ts
export interface CommandOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  envMode?: "inherit" | "replace";
  stdin?: string | Uint8Array;
  maxStdinBytes?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  killProcessGroup?: boolean;
}
```

Before `spawn`, validate limits and compute stdin bytes using UTF-8 for strings. Use `stdio: ["pipe", "pipe", "pipe"]` only when stdin is present; otherwise retain ignored stdin. `envMode` defaults to `inherit`. Set `detached: true` only for requested POSIX process-group termination. End stdin once, record write errors by stable error code only, and make an EPIPE/non-reading-child result nonzero.

On timeout, preserve code 124 and `timedOut: true`. For `killProcessGroup: true`, signal `-child.pid` on POSIX and spawn `taskkill` with literal arguments and `shell: false` on Windows. Do not change existing non-group timeout behavior.

- [x] **Step 4: Delegate focused tests and verify GREEN**

Run the same focused command. Expected: all selected runner tests pass with no warnings.

- [x] **Step 5: Commit the runner contract**

```sh
git add src/git/client.ts test/git.test.ts
git commit -m "feat: harden command process controls"
```

Include `Co-Authored-By: Codex <noreply@openai.com>` and do not amend or bypass hooks.

### Task 2: Move advisory prompt to bounded stdin

**Files:**

- Modify: `test/advisory.test.ts`
- Modify: `src/advisory/advisory.ts`

- [x] **Step 1: Add failing advisory privacy tests**

Replace the argv prompt expectation with exact `args: ["-p"]` and assert these options:

```ts
assert.deepEqual(call.args, ["-p"]);
assert.equal(call.options?.stdin, buildAdvisoryPrompt(reportJson));
assert.equal(call.options?.maxStdinBytes, ADVISORY_MAX_STDIN_BYTES);
assert.equal(call.options?.maxOutputBytes, ADVISORY_MAX_OUTPUT_BYTES);
assert.equal(call.options?.envMode, "replace");
assert.equal(call.options?.killProcessGroup, true);
```

Add a canary report test proving the canary occurs only in stdin, not argv, environment, unavailable reason, or rendered warning. Add a multi-byte prompt that is one byte above 1 MiB and assert the fake runner has zero calls. Add a truncated-stdout case and retain the existing nonzero/timeout/empty/throwing failure matrix and byte-identical no-advisory test.

- [x] **Step 2: Delegate advisory tests and verify RED**

Run:

```sh
npm run build:test && node --test .test-dist/test/advisory.test.js
```

Expected: FAIL because the prompt is still argv[1], limits/options are missing, over-limit input still calls the runner, and truncated stdout is accepted.

- [x] **Step 3: Implement advisory constants, environment projection, and failure behavior**

Export:

```ts
export const ADVISORY_MAX_STDIN_BYTES = 1024 * 1024;
export const ADVISORY_MAX_OUTPUT_BYTES = 64 * 1024;
export const ADVISORY_ENV_KEYS = [
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "SystemRoot", "ComSpec",
  "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_STATE_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN", "TMPDIR", "TMP", "TEMP", "LANG",
  "LANGUAGE", "LC_ALL", "LC_CTYPE",
] as const;
```

Build a fresh environment object by copying only present keys from the source environment. Do not pass `NODE_OPTIONS`, generic proxy variables, or GitHub/AWS/npm credentials.

Build the complete prompt once, preflight with `Buffer.byteLength(prompt, "utf8")`, and return a fixed unavailable reason when it exceeds the cap. Invoke:

```ts
runner("claude", ["-p"], {
  stdin: prompt,
  maxStdinBytes: ADVISORY_MAX_STDIN_BYTES,
  env: buildAdvisoryEnvironment(),
  envMode: "replace",
  timeoutMs: ADVISORY_TIMEOUT_MS,
  maxOutputBytes: ADVISORY_MAX_OUTPUT_BYTES,
  killProcessGroup: true,
});
```

Return fixed, content-free reasons for thrown runner errors. Treat `stdoutTruncated` as unavailable before sanitizing/display truncation.

- [x] **Step 4: Delegate advisory tests and verify GREEN**

Run the same advisory command. Expected: all advisory tests pass and no canary appears outside stdin.

- [x] **Step 5: Commit advisory hardening**

```sh
git add src/advisory/advisory.ts test/advisory.test.ts
git commit -m "fix: keep advisory reports out of process metadata"
```

Include the Codex coauthor and do not amend.

### Task 3: Document the advisory process boundary

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-03-advisory-process-hardening.md`

- [x] **Step 1: Update documentation**

Document that `claude` is invoked exactly as `claude -p`, receives the privacy-projected prompt only over bounded stdin, receives only the named operational/config/auth environment allowlist, applies 1 MiB input and per-stream 64 KiB output caps, rejects truncated stdout, keeps the 2,000-character display cap, and kills the requested process tree after 60 seconds. State that signed organization policy is a later PR.

- [x] **Step 2: Mark the focused plan complete**

Change completed task checkboxes in this file to `[x]` after their RED/GREEN evidence and commits exist.

- [x] **Step 3: Delegate full verification**

Run:

```sh
npm run check
```

Expected: typecheck and all unit/integration tests pass with zero failures.

- [x] **Step 4: Commit documentation**

```sh
git add README.md docs/superpowers/plans/2026-08-03-advisory-process-hardening.md
git commit -m "docs: document advisory process safeguards"
```

Include the Codex coauthor and do not amend.

### Task 4: Pre-push and PR completion gates

**Files:**

- Verify only; modify implementation/test/docs files only if a failing check or in-scope review finding requires it.

- [x] **Step 1: Delegate local GitHub Actions equivalence**

Have the dedicated verifier enumerate changed-file-matching workflows and run the applicable `.github/workflows/ci.yml` jobs locally, preserving workflow order and commands. Expected: typecheck, unit/integration, package smoke, and determinism golden checks pass.

- [x] **Step 2: Push and open the PR against main**

Push `feature/advisory-process-hardening` and create a non-draft PR to `main` with Summary, Breaking / Impact, exact Test plan, `Tests: modified`, and `Rollback: revert-safe`.

- [ ] **Step 3: Run PR completion semantics**

Run `ccprof --pr --json` when available, address only `scope: this_pr`, and monitor all GitHub checks. The final implementation commit must already have independent spec-compliance and code-quality approvals; if this step changes implementation, re-run delegated local verification and both reviews before merging.

- [ ] **Step 4: Merge and clean up the worktree**

After remote CI is green and both reviews approve, merge the PR with **Create a merge commit**, synchronize the main checkout, then verify a clean worktree and zero unpushed commits. Remove `.worktrees/advisory-process-hardening` and delete only the local `feature/advisory-process-hardening` branch.
