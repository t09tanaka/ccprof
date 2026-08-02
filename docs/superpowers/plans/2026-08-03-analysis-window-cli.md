# Analysis Window CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the core analysis-window controls as strict, deterministic CLI options without changing package versions or unrelated commands.

**Architecture:** Parse `--since` and `--commit-lookback` only in the analyze command path, using a strict RFC3339 parser for the former and the existing duration parser for the latter. Carry both optional millisecond values through the CLI and analyze-command interfaces with conditional spreads, then let the core resolver retain precedence (`since` over commit lookback). Treat an invalid resolved window as a usage error at the CLI boundary.

**Tech Stack:** TypeScript 5.9, Node.js `node:test`, exact optional property types, Markdown documentation.

---

### Task 1: Specify parsing and routing behavior

**Files:**
- Modify: `test/reporters-and-cli.test.ts`

- [x] **Step 1: Add failing parser tests**

Add focused tests that call the public CLI parser and wished-for `parseRfc3339Ms` helper:

```ts
assert.equal(parseRfc3339Ms("1970-01-01T00:00:00Z"), 0);
assert.equal(
  parseRfc3339Ms("2026-08-03T12:34:56.123+09:00"),
  Date.UTC(2026, 7, 3, 3, 34, 56, 123),
);
assert.deepEqual(
  parseCliArgs(["--since=2026-08-03T00:00:00Z", "--commit-lookback", "2h"]),
  {
    kind: "analyze",
    format: "tty",
    color: false,
    sinceMs: Date.UTC(2026, 7, 3),
    commitAnchorLookbackMs: 7_200_000,
  },
);
```

Reject impossible dates/times, missing or ambiguous zones, relative/date-only values, missing values, and duplicate options with `CliUsageError`; accept longer fractions and truncate sub-millisecond digits deterministically.

- [x] **Step 2: Add failing dispatch and command-forwarding tests**

Capture handler and core options and assert epoch zero is retained:

```ts
await runCli(
  ["--since", "1970-01-01T00:00:00Z", "--commit-lookback=5m"],
  runtime,
);
assert.equal(dispatched.sinceMs, 0);
assert.equal(dispatched.commitAnchorLookbackMs, 300_000);

await runAnalyzeCommand(commandOptions, {
  analyze: async (options) => {
    forwarded = options;
    return fixtureResult;
  },
});
assert.equal(forwarded.sinceMs, 0);
```

Add an `InvalidAnalysisWindowError` scenario that expects exit code 2, empty stdout, the error message, and `USAGE` on stderr.

- [x] **Step 3: Run the focused test and verify RED**

Run `npm run build:test`, then the matching reporter CLI test. Expected: compilation or assertions fail because the helper, parsed fields, forwarding, and invalid-window mapping do not exist yet.

### Task 2: Implement strict CLI parsing and propagation

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/commands/analyze.ts`
- Test: `test/reporters-and-cli.test.ts`

- [x] **Step 1: Implement strict RFC3339 parsing**

Export `parseRfc3339Ms(value: string): number`. Match exactly four-digit year, two-digit calendar/time fields, optional fractional seconds, and `Z`/`z` or `±HH:MM`, accepting lowercase `t`/`z`. Validate every component and the zone offset, truncate sub-millisecond fractional digits, and produce a finite, nonnegative safe-integer epoch. Malformed values throw `--since must be an RFC3339 date-time with an explicit timezone`; unsupported epochs throw `--since is outside the supported date range`.

- [x] **Step 2: Parse both analyze options and reject duplicates**

Extend `ParsedAnalyzeCommand` with `sinceMs?: number` and `commitAnchorLookbackMs?: number`. Handle separated and inline forms using the existing option helpers, track both seen states, and return conditional fields only when defined.

- [x] **Step 3: Forward both values through command boundaries**

Extend `AnalyzeCommandOptions` with the same optional fields. In `runCli` and `runAnalyzeCommand`, use conditional spreads rather than truthiness so epoch zero is preserved.

- [x] **Step 4: Map invalid windows to usage failures**

Import `InvalidAnalysisWindowError`, return exit code 2 for it, and print `USAGE` for either usage-error class while leaving other mappings untouched.

- [x] **Step 5: Run the focused test and verify GREEN**

Run the focused reporter CLI test. Expected: all selected parser, routing, forwarding, and error-mapping tests pass with no warnings.

### Task 3: Document the public contract

**Files:**
- Modify: `README.md`
- Modify: `test/docs.test.ts`

- [x] **Step 1: Add a failing documentation-contract assertion**

Require `--since`, `--commit-lookback`, `RFC3339`, `explicit timezone`, and prose that states `--since` takes precedence over `--commit-lookback`.

- [x] **Step 2: Run the documentation test and verify RED**

Run `npm run build:test && node --test .test-dist/test/docs.test.js`. Expected: the direct-CLI documentation contract fails because the new flags are absent.

- [x] **Step 3: Update usage and README examples**

Add both flags to `USAGE` and the README synopsis. Explain accepted formats, both-flags behavior, and precedence, and include one invocation of each.

- [x] **Step 4: Run the documentation test and verify GREEN**

Run the same documentation command. Expected: all documentation tests pass.

### Task 4: Verify scope and completion

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-analysis-window-cli.md`

- [x] **Step 1: Run focused verification**

Run the focused CLI and documentation tests together. Expected: exit 0, no failures.

- [x] **Step 2: Check the constrained diff**

Run `git status --short`, `git diff --stat`, `git diff --numstat`, and a package/version diff. Expected: only the six authorized files changed, implementation/test additions stay within 300 lines, and package/version files are unchanged.

- [x] **Step 3: Mark completed plan steps**

Change only steps backed by observed RED/GREEN or scope evidence from `[ ]` to `[x]`. Do not commit; the parent workflow owns commit, CI, push, and PR creation.
