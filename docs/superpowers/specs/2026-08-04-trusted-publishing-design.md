# Trusted npm publishing and reproducible release design

## Status and supersession

This specification replaces the manual npm-publication boundary in
`2026-08-03-human-gated-release-skill-design.md`. The human still chooses the
exact stable version and approves the GitHub deployment, but GitHub Actions
publishes the verified tarball through npm Trusted Publishing. No release is
performed while implementing this specification.

## Official requirements

- npm Trusted Publishing uses short-lived OIDC credentials and requires npm
  CLI 11.5.1+ and Node.js 22.14.0+ on GitHub-hosted runners. Its npm registry
  record must name the exact owner, repository, workflow filename, environment,
  and allowed publish action: <https://docs.npmjs.com/trusted-publishers/>.
- GitHub OIDC requires `id-token: write`; an environment becomes part of the
  token identity when the job references one:
  <https://docs.github.com/en/actions/reference/security/oidc>.
- Required reviewers hold an environment job before it starts. The repository
  administrator must create environment `npm`, add at least one required
  reviewer, and should prevent self-review and administrator bypass:
  <https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments>.
- GitHub artifact and SBOM attestations require `id-token: write` and
  `attestations: write`: <https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>.
- The environment REST response exposes protection rules, allowing the workflow
  to fail before publication if `npm` has no required reviewer:
  <https://docs.github.com/en/rest/deployments/environments>.

External setup is deliberately not automated. npm must have one GitHub Actions
Trusted Publisher for owner `t09tanaka`, repository `ccprof`, workflow
`release-assets.yml`, environment `npm`, and action `npm publish`. If any field
is absent or differs, npm rejects OIDC publication. No npm token is a fallback.

## Chosen design

Use two jobs in the existing tag-only workflow:

1. `build-verify` has only `contents: read`. It validates the stable
   `vMAJOR.MINOR.PATCH` tag, package/lock equality, and main ancestry; runs the
   project checks; packs twice into separate clean directories; compares both
   npm SRI and SHA-256; smoke-tests one exact tarball; creates the SPDX SBOM,
   checksums, and immutable release metadata; then transfers those bytes with
   pinned official upload/download artifact actions.
2. `publish-release` depends on `build-verify`, names environment `npm`, and is
   the only job with OIDC and write permissions. After approval it revalidates
   artifact checksums and metadata, verifies the environment has required
   reviewers, and queries npm. A missing version (confirmed 404) executes the
   workflow's single `npm publish <tarball> --access public --provenance`.
   An existing version resumes only if `dist.integrity` already equals the
   prebuilt SRI. Network/non-404 failures and mismatches stop closed. A bounded
   propagation loop must observe the exact SRI before GitHub provenance/SBOM
   attestations and GitHub Release assets are created or updated.

The second job combines publish and release because both npm Trusted Publishing
and GitHub attestations require an OIDC token. A three-job design would either
grant OIDC to two jobs (violating the single privileged-job boundary) or lose
GitHub attestations. A single all-in-one job was rejected because dependency
installation and build scripts would run with release credentials.

## Identity and permission contract

- Trigger: only a pushed tag matching `v*`; no pull request,
  `workflow_dispatch`, or reusable-workflow publish path.
- Stable-tag, package version, both lockfile root versions, and main ancestry
  must match before artifact transfer.
- All actions are official GitHub actions pinned to immutable commit SHAs.
- Workflow default permission is `contents: read`. Only `publish-release` gets
  `contents: write`, `id-token: write`, `attestations: write`, and
  `artifact-metadata: write`, plus environment `npm`.
- No `NPM_TOKEN`, `NODE_AUTH_TOKEN`, npm secret, `packages: write`, local
  credential, third-party action, or publish-from-working-directory is allowed.
- The transferred tarball is the first of two byte-identical packs. Its npm SRI
  and SHA-256 are recorded. Each consumer verifies `SHA256SUMS`; npm publishes
  the explicit downloaded tarball path exactly once at most.
- GitHub Release assets are that same tarball, its SPDX document, and checksum
  file. Both GitHub attestations name that tarball as subject.

## Safe resume and failure behavior

- **Existing registry version:** matching SRI skips publication and resumes
  downstream work; mismatching SRI stops permanently for human investigation.
- **Registry propagation:** retry a fixed number of times with a fixed delay;
  fail without attestation or Release mutation if equality is not observed.
- **Publish succeeds, downstream fails:** rerun sees the matching registry SRI,
  does not publish again, and safely recreates attestations/uploads assets.
- **Artifact substitution:** download plus checksum/metadata verification fails
  before registry access or write operations.
- **Environment missing or unprotected:** the job checks public environment
  protection metadata and fails before publish if no required reviewer exists.
  A denied or unapproved deployment never starts.
- **Prerelease, leading-zero, mismatched tag, or non-main tag:** fail before
  packing or publication.
- **Partial GitHub Release:** reuse the exact tag and idempotently replace only
  the three expected assets after registry equality.

There is no automated rollback, unpublish, republish, deprecation, queue, lock,
or recovery service.

## Release-skill state machine

The skill retains exact-version input and its preparation PR. After that PR
merges, it revalidates synchronized `main`, creates/pushes one annotated tag at
the verified commit, finds the resulting `release-assets.yml` run, and waits
for a human required-reviewer decision on environment `npm`. It never requests
or handles npm credentials and never runs `npm publish` locally. Completion
requires matching npm `dist.integrity`, exact Release assets/checksums, and both
GitHub attestations. Existing registry bytes with a mismatch, conflicting tags,
or an unapproved/failed workflow remain hard stops with no npm rollback.

