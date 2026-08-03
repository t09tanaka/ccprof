# Windows Test Fixture Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing test fixtures pass consistently on POSIX and Windows without changing production behavior or weakening assertions.

**Architecture:** Keep portability adaptations at test input and mock boundaries. Normalize checkout text once, compare generated paths literally, replace POSIX filesystem/process assumptions with exact builtin interceptions, and retain separate synthetic coverage for Windows-illegal path syntax.

**Tech Stack:** TypeScript, Node.js builtins, `node:test`, GitHub Actions

---

### Task 1: Normalize platform-dependent fixture inputs

**Files:**
- Modify: `test/docs.test.ts`
- Modify: `test/command-and-matcher.test.ts`
- Modify: `test/data-command.test.ts`

- [ ] **Step 1: Record the RED evidence**

Use Windows run `30831758305`, jobs `91747163720` and `91747163587`, where exact newline and dynamically constructed path regular expressions fail. Do not reproduce these host-specific failures by changing production code.

- [ ] **Step 2: Normalize documentation reads**

Change `readDocument` to normalize CRLF only:

```ts
return (await readFile(resolve(process.cwd(), path), "utf8")).replace(
  /\r\n/gu,
  "\n",
);
```

- [ ] **Step 3: Make absolute-path non-leak checks literal**

Replace each `new RegExp(repoRoot|root|paths.root_dir)` assertion with the equivalent complete-string check:

```ts
assert.ok(!message.includes(root));
```

Keep the fixed alphanumeric sentinel regular expression unchanged.

### Task 2: Replace POSIX-only process and permission fixtures

**Files:**
- Modify: `test/git.test.ts`
- Modify: `test/hook-event.test.ts`

- [ ] **Step 1: Intercept only taskkill**

Use `createRequire` and `syncBuiltinESMExports` to replace the CommonJS
`node:child_process.spawn` export inside `withFakeWindowsTaskkill`. Delegate
every command other than exact `taskkill` to the original function. For
`taskkill`, assert `[/PID, pid, /T, /F]` and return a real spawned Node child
that waits `delayMs`, kills the target on success, and exits with `exitCode`.
Restore `spawn` and `process.platform` in `finally`.

- [ ] **Step 2: Preserve taskkill behavioral assertions**

Keep both tests host-independent: successful termination must settle no sooner
than the fake's delay, and exit code 7 must append `process termination failed:
TASKKILL_7`.

- [ ] **Step 3: Inject exact-path EACCES**

Replace `chmod` with a CommonJS `node:fs/promises.readFile` interception. Reject
only when its first argument equals `paths.hook_events_path`, using an error
whose `code` is `EACCES`; delegate every other read. Restore the builtin in
`finally`, then verify the file equals its original oversized bytes plus the
new Stop row.

### Task 3: Keep real Git fixtures Win32-legal

**Files:**
- Modify: `test/rules-primary.test.ts`

- [ ] **Step 1: Replace only real filesystem trailing-space names**

Change real fixture paths from `src/ value.ts ` and `pkg/src/ value.ts ` to
`src/value name.ts` and `pkg/src/value name.ts` throughout repository setup,
session inputs, Git object lookups, and expected observations.

- [ ] **Step 2: Retain synthetic parser coverage**

Leave `const paths = ["src/a b.ts", "src/a  b.ts", "src/trailing.ts "]`
unchanged so trailing whitespace remains covered without creating an illegal
Windows filename.

### Task 4: Verify, review, and complete the PR

**Files:**
- Review all eight changed files

- [ ] **Step 1: Delegate focused and full verification**

Another subagent runs `npm run typecheck`, builds the tests, executes the six
changed test files from `.test-dist`, then runs `npm test`. Expected: every
command passes with zero skips.

- [ ] **Step 2: Run independent reviews in order**

Request specification compliance first, then code quality. Fix only findings
introduced by this PR and repeat delegated verification after any fix.

- [ ] **Step 3: Complete the GitHub lifecycle**

Run the delegated local GitHub-Actions-equivalent checks, push
`feature/windows-test-portability`, create `[Tests] test: make fixtures portable
on Windows`, wait for all existing remote checks, merge with a merge commit,
sync `main`, and invoke `worktree-pr-flow:cleanup`.
