---
name: ccprof-release
description: Use when a maintainer asks to prepare, publish, resume, or verify an exact stable ccprof release through npm Trusted Publishing.
---

# ccprof release

## Scope and invariants

- Operate only on `t09tanaka/ccprof`; stop if local Git, `origin`, or GitHub says otherwise.
- Derive state from current Git, npm, GitHub PR/Actions/Environment/Release,
  and artifact evidence on every invocation. Chat checkpoints are not authority.
- Require the human's exact stable target version. Never infer, recommend,
  increment, or normalize it. Accept stable semver only; reject prerelease,
  build-suffixed, leading-zero, non-increasing, or conflicting versions before
  creating a worktree.
- The agent prepares the version PR and tag, then observes the hosted workflow.
  The agent never runs `npm publish` locally and never holds npm authority.

## External administrator prerequisite

Before any release tag, an administrator must configure:

- GitHub environment `npm` with human approval protection (prefer prevention
  of self-review and administrator bypass); and
- one npm Trusted Publisher with owner `t09tanaka`, repository `ccprof`, exact
  workflow filename `release-assets.yml`, environment `npm`, and allowed action
  `npm publish`.

The workflow verifies the GitHub approval rule before registry mutation, and
npm checks the exact OIDC identity. Missing or mismatched setup must fail
closed; there is no token fallback.

## Derive current state

Evaluate these states in order:

1. `TARGET_VERSION_REQUIRED`
2. `PREPARATION_REQUIRED`
3. `READY_TO_TAG`
4. `AWAITING_ENVIRONMENT`
5. `VERIFYING_RELEASE`
6. `COMPLETE`

### TARGET_VERSION_REQUIRED

No exact valid target was supplied. Ask for it and make no mutation.

### PREPARATION_REQUIRED

The version is valid, but its preparation PR is absent, incomplete, unmerged,
or local `main` is not synchronized to its merge commit.

### READY_TO_TAG

Preparation is merged; clean synchronized `main`, version metadata, changelog,
repository identity, and tag/Release conflicts all pass; no matching workflow
run has started.

### AWAITING_ENVIRONMENT

The exact annotated tag was pushed and `release-assets.yml` is waiting for a
designated human reviewer on environment `npm`. The agent must not approve the
deployment, bypass protection, or ask for a credential. Report the Actions URL
and wait for a human decision.

### VERIFYING_RELEASE

The workflow was approved and is running or finished. Registry integrity must
equal the workflow's recorded SRI before the GitHub Release, build provenance,
and SBOM attestation are accepted.

### COMPLETE

The stable tag targets the preparation merge OID; the workflow succeeded; npm
integrity matches; and the exact tarball, SPDX file, `SHA256SUMS`, provenance,
and SBOM attestation all verify.

## Phase A: prepare the version PR

1. Fetch and verify clean attached synchronized `main` (`HEAD == origin/main`),
   repository identity, increasing target, and absence of conflicting local or
   remote tag, GitHub Release, or registry version. Stop with evidence on any
   conflict. A known matching registry version is valid only when resuming an
   already-tagged workflow.
2. Use `worktree-pr-flow` from `origin/main`. Run
   `npm version <target> --no-git-tag-version` with the supplied version so
   `package.json` and both root version fields in `package-lock.json` agree.
3. Add that version and date to `CHANGELOG.md`, summarizing only merged changes
   since the previous release tag. Review the version/lock/changelog diff.
4. Delegate checks, commit normally, open the preparation PR to `main`, complete
   CI/review, merge only with authorization, clean the worktree, and synchronize
   local `main`. Never amend, commit directly to `main`, or tag before merge.

## Phase B: tag and await human approval

1. Revalidate clean synchronized `main`, exact versions/changelog, repository,
   conflicts, and the 40-hex release OID. Verify the environment exists with an
   approval rule; npm publisher configuration remains an administrator-owned
   prerequisite because no npm credential is available to inspect it.
2. Verify an existing annotated tag or create exactly:
   `git tag -a "v<version>" "<OID>" -m "v<version>"`. Reject a lightweight tag,
   another target, or a conflicting remote tag; push only this tag.
3. Locate the tag's `release-assets.yml` run. If it is held, report the run URL
   and hard-stop for a required reviewer. Never approve or bypass an environment
   deployment and never execute, wrap, schedule, or delegate npm publication.

## Phase C: observe and verify

1. Resume from live tag, workflow, registry, Release, asset, and attestation
   state. Rerun only the matching failed workflow; never create another tag.
2. A rerun may skip its sole hosted publish step only when the existing registry
   `dist.integrity` exactly matches its verified tarball SRI. Missing data may
   be propagation; mismatching bytes are a hard stop.
3. Wait for workflow success, then verify the tag/OID, npm integrity, exact
   `.tgz`, `ccprof-<version>.spdx.json`, `SHA256SUMS`, their checksums, and both
   attestations. Report `COMPLETE` only after every observation agrees.

## Conflict and credential handling

- Stop on dirty/diverged Git, version disagreement, stale OID, mismatching
  registry bytes, missing approval protection, conflicting tag/Release, failed
  checks, or unexpected assets. Show observed and expected evidence.
- Never request, read, store, or handle an npm token or credential, and do not
  inspect local npm authentication files.
- Never attempt rollback, unpublish, republish, deprecation, or automatic
  recovery. After registry publication, recovery is limited to bounded
  propagation waits and resuming the exact GitHub workflow.
