# Trusted publishing implementation plan

> Execute with `superpowers:subagent-driven-development`; delegate all tests,
> static analysis, and local Actions checks under repository policy.

**Goal:** Publish the exact reproducibly built ccprof tarball through npm OIDC
after a GitHub Environment approval, then attest and release the same bytes.

**Scope:** Eight files: workflow, project release skill, skill evaluations,
README maintainer runbook, two static contract tests, this plan, and the design.
No version or changelog bump and no real tag/release/publication.

### Task 1: Add RED workflow contracts

Modify `test/release-workflow.test.ts` first. Assert tag-only trigger; two-job
ordering; least permissions; `environment: npm`; exact npm/Node floor; pinned
official checkout/setup/upload/download/attest actions; two isolated packs and
SRI/SHA equality; checksum revalidation; exact one explicit-tarball publish;
no credentials/third-party paths; safe existing-version resume; non-404 and
integrity fail-closed behavior; bounded propagation; and registry equality
before attest/release. Delegate the focused test and record expected failure.

### Task 2: Add RED skill/runbook contracts

Modify `test/release-skill.test.ts` first. Assert the skill/evals/README replace
manual publication with prepare-PR → annotated tag → Environment approval →
OIDC workflow → registry/assets/attestation verification; document exact npm
publisher/environment prerequisites; and forbid local credentials, local
publish, rollback, and unpublish. Delegate the focused test and record expected
failure.

### Task 3: Implement the workflow

Refactor `.github/workflows/release-assets.yml` into unprivileged
`build-verify` and Environment-gated `publish-release`. Keep concurrency and
timeouts. Validate versions/ancestry, run checks, produce two isolated tarballs,
compare SRI/SHA, smoke the chosen exact tarball, build SBOM/checksums/metadata,
and transfer using pinned official artifact actions. Revalidate bytes and
required reviewers, safely branch on registry 404 versus exact matching resume,
publish the explicit tarball once, poll for equality, then attest and upload the
same assets. Delegate focused GREEN tests.

### Task 4: Update operator guidance

Rewrite `.claude/skills/ccprof-release/SKILL.md`, its `evals/evals.json`, and
README's maintainer section for Trusted Publishing and the human Environment
approval. Preserve version preparation, observable resume, tag identity, and
final verification. Remove the manual publish command/boundary and explicitly
state external npm/GitHub setup and no agent-held tokens. Delegate focused
GREEN tests.

### Task 5: Verify, review, and publish the PR

Delegate full tests/static analysis and `/run-github-actions-locally`. Obtain
independent spec and quality/security reviews, fixing only regressions caused
by this change. Commit logical units without amend, push only after local CI is
green, open `[Release] ci: publish npm packages with trusted provenance` to
`main`, wait for remote checks, merge when green, synchronize `main`, and clean
the worktree/branch. Never create a release tag or execute npm publication.
