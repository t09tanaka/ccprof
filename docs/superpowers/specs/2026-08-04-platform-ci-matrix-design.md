# Platform CI Matrix Design

## Goal

Make ccprof's advertised runtime compatibility visible and blocking across the
three hosted operating systems, while retaining the existing branch-protection
check name and adding an explicitly non-blocking next-Node canary.

## Scope

This change is limited to GitHub Actions configuration, a portable
`better-sqlite3` smoke helper, static workflow contract tests, and support
documentation. It does not change `package.json` engines, package version,
production runtime code, release semantics, Trusted Publishing, reporting,
storage, manifests, or export gates. The tag-only release-assets workflow is
left unchanged.

## Blocking compatibility contract

The primary test job is a fail-fast-disabled matrix with the exact Cartesian
product of Ubuntu, macOS, and Windows runners and Node.js 22 and 24: six
blocking combinations. Every leg checks out the repository, sets up its matrix
Node version with the npm cache, runs `npm ci`, opens and queries an in-memory
`better-sqlite3` database through the portable smoke helper, closes it, and
runs the complete test suite.

The advertised Node.js 20 floor remains a separate blocking Ubuntu job with
the same install, native-addon smoke, and full-test sequence. A lightweight
aggregate job keeps the exact `unit-and-integration-tests` name used by branch
protection. It uses `always()`, depends on both the six-leg matrix and Node 20
job, and succeeds only when both dependency results are `success`. It performs
no duplicate checkout, install, smoke, or test work.

Existing `typecheck`, `package-smoke`, and `determinism-golden` check names are
unchanged and run on Node.js 24. CodeQL setup also moves to Node.js 24.

## Canary contract

Ubuntu Node.js 26 is a separate job with job-level `continue-on-error: true`.
It checks out, installs, runs the native-addon smoke, typechecks, and runs the
full suite. It is deliberately absent from the aggregate job's dependencies,
so a genuine next-runtime incompatibility remains visible without weakening
the supported-runtime gates.

Node.js 26 is documented as a canary only, not as a support claim. The
`engines` declaration remains authoritative.

## Native-addon smoke

A CommonJS helper under `tools/` requires `better-sqlite3`, opens an in-memory
database, executes a simple `SELECT`, validates the result, and closes the
database in `finally`. Invoking it as `node tools/smoke-better-sqlite3.cjs`
avoids shell-specific quoting and temporary-path behavior on Windows.

## Failure and cancellation semantics

- Matrix `fail-fast: false` lets every platform/runtime result remain visible.
- A failed or cancelled matrix/Node 20 dependency still schedules the
  aggregate because it uses `always()`; the aggregate then fails explicitly.
- Node 26 cannot cancel or fail a blocking gate because it is non-blocking and
  outside the aggregate dependency graph.
- Every job has a timeout, workflow concurrency still cancels superseded runs,
  and permissions stay read-only except for the existing CodeQL permissions.
- Every third-party action remains pinned to an immutable commit SHA.

## Verification

Static workflow contract tests are written before the workflow changes. They
assert the exact six blocking pairs, retained Node 20 job, non-blocking Node 26
canary, native smoke calls, aggregate dependencies and failure semantics, exact
check names, pinned actions, timeouts, concurrency, permissions, CodeQL Node
24, documentation wording, and the absence of duplicated test work in the
aggregate. Existing release workflow tests protect the unchanged tag-only
release-assets behavior.

Local verification covers the static contracts, typecheck, full suite, package
smoke, determinism, and CodeQL build phase on the host OS. The pull request is
not merged until all remote blocking Ubuntu, macOS, and Windows matrix legs are
green; Node 26 may be red only for a genuine canary incompatibility.
