# Windows Test Fixture Portability Design

## Context

The platform matrix work first exercised the existing suite on Windows with
Node.js 22 and 24. Run `30831758305` (jobs `91747163720` and `91747163587`)
failed in test fixtures even though the native `better-sqlite3` canary passed
and no product defect was identified. This prerequisite makes those fixtures
portable before the matrix is enabled.

## Scope

This change is test-only. It updates six existing test files and adds this
design plus its implementation plan. It does not change `src/`, workflow or
package configuration, documentation behavior, supported runtimes, production
error handling, or assertion strength. No test is skipped or made
non-blocking.

## Design

### Documentation line endings

`test/docs.test.ts` normalizes CRLF to LF once in `readDocument`. Exact
documentation assertions continue to operate on the same text, while checkout
line-ending policy no longer changes their result. Lone carriage returns are
not normalized because they are not a supported line-ending conversion.

### Sensitive-path assertions

Assertions in `test/command-and-matcher.test.ts` and
`test/data-command.test.ts` that check whether an absolute temporary path
leaked into output use literal string containment. An absolute Windows path is
data, not a regular expression: backslashes, brackets, parentheses, or other
regular-expression metacharacters must remain literal. Existing regular
expressions whose input is a fixed alphanumeric sentinel remain unchanged.

### Windows taskkill fixture

`test/git.test.ts` intercepts the exact `taskkill` spawn through the CommonJS
`node:child_process` export and calls `syncBuiltinESMExports` so the production
module's named ESM binding observes it. All other commands delegate to the
original `spawn`. The intercepted command returns a real Node child process,
retaining normal child-process events, delay behavior, exit codes, and process
termination without relying on a POSIX shebang or `PATH` separator. The helper
restores both `spawn` and `process.platform` in `finally`.

### Compaction failure fixture

`test/hook-event.test.ts` replaces the permission-bit assumption with an
exact-path `node:fs/promises.readFile` interception that rejects with
`EACCES`. The oversized log append still uses the real filesystem; only the
subsequent compaction read fails. The test restores the builtin export before
reading the file and verifies the original bytes plus appended row remain.

### Git path fixture

The real Git repository in `test/rules-primary.test.ts` uses
`value name.ts`, which keeps an interior space that exercises Git's quoted path
handling and is legal on Windows. The separate synthetic parser case for
`src/trailing.ts ` remains unchanged, preserving trailing-space coverage where
no real Windows filesystem entry is required.

## Edge Cases and Invariants

- CRLF normalization occurs only at the documentation read boundary.
- Literal non-leak checks work for backslashes and regular-expression
  metacharacters and still fail if the complete sensitive path is present.
- Builtin mocks are restored after success, rejection, or assertion failure;
  interception is limited to the exact command or exact path.
- Non-`taskkill` spawns preserve their original arguments, options, streams,
  callbacks, and events.
- Delayed taskkill success must delay `runCommand` settlement; exit code 7 must
  still surface `TASKKILL_7` on every host OS.
- The EACCES fixture does not block append, cleanup, or unrelated reads.
- Real Git fixtures use only Win32-legal names, while the synthetic trailing
  whitespace parser assertion remains intact.
- The suite contains zero new skips and production behavior is byte-for-byte
  untouched by this PR.

## Verification

The failed Windows jobs are the RED evidence. Delegated verification will run
the focused six test files, typecheck, and the complete suite on the local
host. The prerequisite PR's existing GitHub checks must pass. The resumed
platform matrix PR will then provide the definitive Windows Node.js 22/24
acceptance across all six blocking legs.
