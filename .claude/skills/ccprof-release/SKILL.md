---
name: ccprof-release
description: Use when a maintainer asks to release t09tanaka/ccprof with an exact stable version or resume after manual npm publication.
---

# ccprof release

## Scope and invariants

- Operate only on `t09tanaka/ccprof`. Stop if `origin` or GitHub identifies another repository.
- Derive authority from current Git, npm registry, GitHub PR/Actions/Release, and package artifacts on every invocation. Never trust chat state or a prior checkpoint alone.
- The human must supply an exact stable target version. Never infer, recommend, increment, or normalize it.
- Accept only stable semver `MAJOR.MINOR.PATCH` with no prerelease/build suffix and no leading-zero components. Reject invalid, prerelease, leading-zero, non-increasing, or already-published values before creating a worktree.
- The agent owns preparation and verified GitHub post-processing. npm publication and npm credentials remain human-only.

## Derive current state

Always evaluate these observable states in order:

1. `TARGET_VERSION_REQUIRED`
2. `PREPARATION_REQUIRED`
3. `AWAITING_HUMAN_PUBLISH`
4. `READY_FOR_POSTPROCESSING`
5. `COMPLETE`

### TARGET_VERSION_REQUIRED

No exact valid target was supplied. Ask for it without proposing a value; make no mutation.

### PREPARATION_REQUIRED

The supplied version is valid, but its preparation PR is absent, incomplete, unmerged, or local `main` is not synchronized to the merged commit.

### AWAITING_HUMAN_PUBLISH

The preparation commit and exact tarball passed preflight, but the version is absent from the live npm registry. Emit the checkpoint and hard-stop for the human.

### READY_FOR_POSTPROCESSING

Enter only after a later user message gives explicit confirmation of manual publication, the version exists in the live registry, and a tarball rebuilt from the same release OID has matching `dist.integrity`. Missing registry data or an integrity mismatch must stop all tag and GitHub mutations with evidence.

### COMPLETE

The exact annotated tag targets the verified OID, `release-assets.yml` succeeded, and the GitHub Release, required assets, checksums, build provenance, and SBOM attestation all match.

## Phase A: prepare and verify

1. Before worktree creation, fetch and verify clean, attached, synchronized `main` (`HEAD == origin/main`), repository identity, increasing target, npm absence, and no conflicting local/remote tag, GitHub Release, package, lockfile, or changelog state. Stop with evidence on any conflict.
2. Use the repository's `worktree-pr-flow` from current `origin/main`. In its isolated branch run `npm version <target> --no-git-tag-version` using the supplied version so `package.json` and both root version fields in `package-lock.json` agree.
3. Add the exact version and date to `CHANGELOG.md` in Keep a Changelog format, summarizing only merged changes since the preceding release tag. Review the version/lock/changelog diff.
4. Delegate static analysis and tests under repository policy. Commit normally, open the preparation PR to `main`, complete CI and review, obtain authorized merge, clean the worktree, then synchronize local `main`.
5. During preparation never commit directly to `main`, amend a commit, create/push a tag, bypass protection, or merge without authorization. Pause and rediscover an awaiting PR on resume.
6. Recheck clean synchronized `main`; exact package, lock, and changelog versions; tag/Release/npm conflicts; and record the 40-hex release commit OID.
7. Run exactly one `npm pack --json` per preflight or resume packaging attempt. Preserve its JSON instead of packing again; obtain the absolute tarball path and SRI, and compute SHA-256 from that file.
8. Install that packed tarball globally into an isolated prefix and smoke-test its `ccprof --version`, `ccprof --help`, and `ccprof stats --json` in an isolated runtime repository. Confirm runtime SPDX generation with `npm sbom --omit=dev --sbom-format=spdx`.
9. Report the preparation PR URL, OID, absolute tarball path, SRI, and SHA-256, then emit this fenced checkpoint with concrete values:

```json
{
  "phase": "awaiting_human_publish",
  "preparation_pr": "https://github.com/t09tanaka/ccprof/pull/<number>",
  "version": "<package version>",
  "tag": "v<package version>",
  "commit_oid": "<40-hex OID>",
  "tarball_path": "<absolute path>",
  "integrity": "sha512-...",
  "sha256": "<hex digest>",
  "resume_message": "npm publish completed"
}
```

## Phase B: mandatory human npm publication

- The agent must not execute, wrap, alias, schedule, approve, or otherwise cause `npm publish --access public <absolute-tarball-path>`; display this single inline command for the human to run against the reported tarball.
- Never request, read, print, store, forward, or validate npm tokens or credentials. Do not automate the human action through another agent, tool, script, workflow, reminder, or approval.
- Hard-stop the turn. A log or earlier statement is not authority; require a later confirmation and live registry evidence.

## Phase C: verified GitHub post-processing

1. On the later confirmed invocation, re-fetch and revalidate repository identity, clean synchronized `main`, the preparation PR, versions, changelog, and the exact recorded OID.
2. At that same OID, rebuild the package once using the Phase A packaging rule. Query the live npm version's `dist.integrity` and compare it byte-for-byte with the rebuilt SRI.
3. If the registry version or integrity is missing, stop for propagation/retry. If there is an integrity mismatch, stop before any tag or Release mutation and report both values and OID. Never attempt npm unpublish, rollback, deprecation, republish, or repair.
4. Only after equality, verify a matching local annotated tag or create it at the OID with `git tag -a "v<version>" "<OID>" -m "v<version>"`. Reject any local or remote tag targeting another OID.
5. Push only that tag, never a branch. Locate and wait for the tag's `release-assets.yml` run; rerun a failed matching run instead of creating another tag.
6. Verify the GitHub Release targets the exact tag/OID and contains the exact rebuilt `.tgz`, `ccprof-<version>.spdx.json`, and `SHA256SUMS`; verify checksums plus build-provenance and SBOM attestations whose subject is that tarball. Report `COMPLETE` only then.

## Conflict handling

- Resume idempotently from live observations: reuse only matching PR, OID, tarball metadata, tag, workflow, Release, assets, and attestations.
- Stop on dirty/diverged Git, version disagreement, stale OID, registry mismatch, conflicting tag/Release target, failed checks, or unexpected assets. Show observed versus expected evidence and the smallest human recovery step.
- After npm exists, recovery is limited to registry propagation waits or matching GitHub workflow/asset completion. Never propose npm rollback, unpublish, or republish.
