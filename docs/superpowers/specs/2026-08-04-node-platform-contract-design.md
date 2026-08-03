# Node Runtime and Platform Edge Contract Design

## Goal

Make the supported Node.js runtime contract exact and machine-verifiable, then
close only the platform-edge coverage gaps left after the existing six-lane
hosted-OS matrix and Windows portability work.

This design supersedes the Node.js 20 support statements in
`2026-08-04-platform-ci-matrix-design.md`. The already-merged matrix,
portable `better-sqlite3` smoke helper, and platform fixture fixes remain the
foundation.

## Support contract

The package supports exactly Node.js `22.x || 24.x`. The same value appears in
the root package record in `package-lock.json`, and README documentation names
these as the only supported runtime lines. Node.js 20, 23, and 25 are EOL and
are not formal or blocking compatibility targets.

The existing exact matrix remains blocking:

- Ubuntu with Node.js 22 and 24
- macOS with Node.js 22 and 24
- Windows with Node.js 22 and 24

Node.js 26 remains an Ubuntu canary with job-level `continue-on-error: true`.
It stays outside the aggregate support gate and is explicitly not a support
claim until it reaches LTS and the package contract changes separately.

## ARM64 native-addon contract

A blocking `arm64-native-smoke` job runs on the native
`ubuntu-24.04-arm` GitHub-hosted runner with Node.js 24. It asserts
`process.arch === "arm64"`, performs a clean `npm ci`, and executes the existing
portable `better-sqlite3` open/query/close smoke helper. The stable
`unit-and-integration-tests` aggregate depends on both this job and the six-leg
matrix, so branch protection cannot report the compatibility gate as green
when the ARM64 install or native load fails.

One ARM64/Node.js 24 lane is sufficient for this atomic change: the six-lane
matrix already tests both supported Node ABIs and all three hosted operating
systems, while the new lane adds the missing CPU dimension without duplicating
the full suite. Expanding every OS/runtime/CPU Cartesian product is outside
scope.

## Edge-contract inventory

The implementation records and reuses the following existing executable
evidence rather than creating look-alike fixtures:

| Contract | Existing evidence |
| --- | --- |
| Windows drive and UNC normalization | `test/command-and-matcher.test.ts` exercises same-drive, different-drive, mixed-flavor, and UNC roots through `deriveRepoRelativeCwd`. |
| symlink and Windows junction handling | `test/store.test.ts` exercises canonical aliases and rejects symlinked/junction store directories without touching targets. |
| linked Git worktree | `test/store.test.ts` creates a real linked worktree and proves shared canonical/store identity. |
| separate Git directory | `test/store.test.ts` creates `git init --separate-git-dir` plus a linked worktree and proves shared identity. |
| native addon installation and loading | Every supported OS/runtime matrix leg runs `npm ci` and the portable SQLite smoke helper. |
| abrupt process termination | `test/git.test.ts` exercises POSIX descendant group termination, hard settlement with inherited stdio, and delayed/failing Windows `taskkill`. |

Three focused executable contracts fill genuine gaps:

1. A case-insensitive-filesystem test creates one mixed-case directory and
   resolves it through a differently cased spelling. It explicitly skips when
   the host filesystem is case-sensitive. The static workflow contract proves
   that the complete suite runs on both Windows and macOS hosted runners, so
   this is a capability skip rather than an unowned platform omission.
2. A Unicode repository-path test creates an NFD-named directory and proves
   canonical repository paths and hashes are NFC-normalized. This is stable on
   filesystems that preserve, decompose, or coalesce Unicode names.
3. A real bare Git repository test proves PR-context resolution rejects the
   missing worktree with `GitContextError`. Bare repositories must fail safely;
   they do not receive a fabricated checkout or Store identity.

## Edge cases and invariants

- Case behavior is probed from the temporary filesystem; it is never inferred
  only from `process.platform`.
- A case-sensitive filesystem produces an explicit test skip, not a false pass
  or a production behavior change.
- Unicode assertions compare canonical identity after NFC normalization and do
  not assume whether two spellings can coexist as distinct directory entries.
- Windows drive and UNC semantics continue to use `node:path.win32`, even when
  their deterministic unit tests execute on a non-Windows host.
- Symlink creation may be unavailable on some Windows installations; existing
  junction-aware tests preserve their explicit capability skips.
- Linked worktrees use the common Git directory; separate-git-dir markers may
  be absolute or relative.
- Bare repositories fail before source discovery, report generation, or Store
  writes.
- The ARM64 lane uses a native ARM runner rather than emulation and validates
  both the reported architecture and the installed addon.
- Node.js 26 failure is visible but cannot weaken or block the supported-runtime
  aggregate.
- No shared type, interface, or function signature changes. No production code
  change is expected; if RED evidence exposes a portability defect, only that
  directly caused defect may be fixed.

## Scope

Expected files are `package.json`, the root package record in
`package-lock.json`, `README.md`, `.github/workflows/ci.yml`,
`test/ci-workflow.test.ts`, one focused platform-edge test, and the required
design/plan documents. The configuration JSON schema, release workflows,
package version, tag/publish behavior, Store schema, CLI semantics, and all
unrelated hardening remain unchanged.

## Verification

Static workflow tests enforce the exact engine string, absence of a Node.js 20
job, exact six supported platform/runtime pairs, isolated Node.js 26 canary,
native ARM64 install/smoke lane, aggregate dependencies, README wording,
pinned actions, timeouts, and least-privilege workflow settings.

The focused platform tests are written and observed RED before package/workflow
implementation. A delegated verifier then runs focused tests, typecheck, the
complete suite, package smoke, determinism, workflow lint, and the repository's
local GitHub Actions procedure. Independent specification and quality/security
reviews run before push. The PR targets `main`; every remote blocking check is
green before merge and cleanup. No tag, publish, or release is performed.
