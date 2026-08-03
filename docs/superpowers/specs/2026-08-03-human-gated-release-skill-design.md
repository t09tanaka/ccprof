# Human-Gated ccprof Release Skill Design

## Status

This specification records the user-approved release boundary for `ccprof`.
Version preparation and npm publication remain human actions. The agent
validates those actions and automates only the post-publication GitHub work.

## Goal

Add a project-local `ccprof-release` skill that can be invoked with phrases
such as “release ccprof”, “prepare the next ccprof release”, or “npm publish is
done; finish the release”. The skill must:

1. guide and validate human-owned release preparation;
2. prepare and verify the exact tarball without publishing it;
3. stop for a human to run `npm publish` manually;
4. verify the published registry artifact; and
5. automate the tag, attestations, SBOM, checksums, and GitHub Release.

The workflow is resumable from observable Git, npm registry, GitHub Actions,
and GitHub Release state. It does not add a state file, table, lock, queue, or
other recovery system.

## Chosen approach

Use two repository-owned components:

- `.claude/skills/ccprof-release/SKILL.md` orchestrates human checkpoints,
  delegated local verification, registry verification, tag creation, and final
  GitHub verification.
- `.github/workflows/release-assets.yml` runs after a `v*` tag is pushed. It
  rebuilds and verifies the published artifact, produces attestations and
  release assets, and creates or completes the GitHub Release.

This keeps the irreversible npm action visibly human-owned while retaining a
verifiable connection between the release commit, npm tarball, and GitHub
artifacts.

### Rejected alternatives

- Do not modify the global `npm-release-prep` skill. That would change release
  behavior for unrelated repositories and could surprise other projects.
- Do not implement a skill-only `gh release create` flow. A local process cannot
  issue the GitHub-hosted OIDC attestations required for the release artifact.
- Do not let a tag push publish npm. The user explicitly chose manual npm
  publication, and the workflow must never receive npm publishing credentials.

## Protected contracts and scope

- This implementation PR does not edit `package.json`, `package-lock.json`, or
  `CHANGELOG.md`; those are future human release inputs.
- Package version `0.2.0`, report schema v2, and store schema v2 remain
  unchanged by this PR.
- Stable releases only are supported. A version containing a prerelease suffix
  or a tag other than exact `v${package.json.version}` is rejected.
- Scorecard automation remains the separate PR09b task.
- The implementation is limited to at most 10 changed files and at most 300
  added skill-support/workflow production lines. No custom SBOM normalization
  or persistent release-state subsystem is introduced.

## State machine

The skill derives one of four states on every invocation. State is never trusted
solely from a previous chat response.

1. `PREPARATION_REQUIRED`: version inputs, branch state, changelog, or checks
   are not ready.
2. `AWAITING_HUMAN_PUBLISH`: the exact tarball passed preflight but the npm
   registry version does not exist.
3. `READY_FOR_POSTPROCESSING`: the current user message explicitly confirms
   manual publication, npm contains the version, and its `dist.integrity`
   matches a tarball rebuilt from the same release commit. Registry presence
   alone never authorizes post-processing.
4. `COMPLETE`: the tag points to that commit, the workflow succeeded, and the
   GitHub Release and required assets exist.

Conflicting observable state is never guessed around. A mismatched tag,
registry integrity, release target, or commit stops the skill with evidence and
a human-readable recovery instruction.

## Phase A: human preparation and automated preflight

### Human-owned preparation

The skill first presents this checklist and stops if any item is incomplete:

- update the package version and root lockfile version together;
- update `CHANGELOG.md` for the same stable version;
- send the preparation through the normal PR and merge it;
- return to a clean, synchronized local `main`.

The skill never writes these files, chooses a version, creates the preparation
commit, bypasses branch protection, or pushes a version change.

### Agent-owned preflight

Once preparation exists, the skill verifies:

- current branch is `main`, the worktree is clean, and `HEAD == origin/main`;
- package and lockfile root versions are identical stable semver values;
- the changelog contains the exact version;
- local and remote `v<version>` tags do not already conflict;
- a GitHub Release for the tag does not conflict;
- npm does not already contain the version unless this is a valid resume;
- the release commit is the exact OID used for every later comparison.

Static analysis and tests are delegated according to repository policy. The
preflight then runs the package build, a single `npm pack --json`, packed global
install, `ccprof --version`, `ccprof --help`, and an isolated runtime smoke
test. It also confirms that runtime-only SPDX generation succeeds with:

```sh
npm sbom --omit=dev --sbom-format=spdx
```

The preflight reports an absolute tarball path, package version, proposed tag,
release commit OID, npm SRI integrity, SHA-256 digest, and the exact manual
publish command. If the temporary tarball later disappears, the skill may
rebuild it only after revalidating the same clean commit.

### Checkpoint output

The skill ends Phase A with a fenced JSON checkpoint for human inspection:

```json
{
  "phase": "awaiting_human_publish",
  "version": "<package version>",
  "tag": "v<package version>",
  "commit_oid": "<40-hex OID>",
  "tarball_path": "<absolute path>",
  "integrity": "sha512-...",
  "sha256": "<hex digest>",
  "resume_message": "npm publish completed"
}
```

This output is a receipt, not persisted authority. Resume always rechecks live
state.

## Phase B: mandatory human publication

The skill displays one exact command using the prepared absolute tarball path:

```sh
npm publish --access public <absolute-tarball-path>
```

The agent must not execute, wrap, alias, schedule, or approve this command. It
must not read, print, request, or store an npm token. The GitHub workflow also
contains no `npm publish`, `NPM_TOKEN`, or `NODE_AUTH_TOKEN` path.

The turn stops here. Only a later user message confirming publication permits
registry verification and authorizes the defined tag/GitHub post-processing.
A pasted successful-looking log is not sufficient by itself; npm registry
state is authoritative.

## Phase C: verified post-publication automation

On resume, the skill revalidates the clean `main` commit and rebuilds the
tarball if needed. It reads the published version and `dist.integrity` from the
npm registry. The registry SRI must exactly equal the SRI produced by
`npm pack --json` for the release commit.

If the package is absent, the skill fails fast and asks the user to retry after
registry propagation. If integrity differs, it stops before creating or
pushing a tag. It never unpublishes, deprecates, republishes, or otherwise tries
to repair npm automatically.

After a match, the skill:

1. creates an annotated `v<version>` tag at the verified commit, or verifies an
   existing local tag points to that exact OID;
2. rejects a conflicting remote tag;
3. pushes only the verified tag;
4. locates and waits for the resulting `release-assets.yml` run; and
5. verifies the completed GitHub Release, assets, and attestations.

## Tag-triggered GitHub workflow

The workflow runs only for pushed `v*` tags and performs these gates before any
GitHub Release mutation:

- full-history checkout of the tag with persisted credentials disabled;
- exact stable tag/package/lockfile version equality;
- tagged commit ancestry from `origin/main`;
- the repository's Node 20 runtime, `npm ci`, full project checks, one local
  pack, packed install, and CLI smoke;
- npm registry `dist.integrity` equality with the local pack.

It then generates a runtime-only SPDX JSON document directly from the tag
checkout. The generated document itself is attested and attached; it need not
be byte-identical to the preflight probe. A SHA-256 checksum file covers the
tarball and SBOM.

The workflow uses SHA-pinned official `actions/checkout`, `actions/setup-node`,
and unified `actions/attest`. It issues build provenance for the exact tarball
and an SBOM attestation for that tarball, then creates the GitHub Release or
uploads missing assets with safe rerun behavior. New releases use generated
release notes; reruns never create a second release for the same tag.

Required job permissions are limited to:

```yaml
permissions:
  contents: write
  id-token: write
  attestations: write
  artifact-metadata: write
```

No npm registry write permission or npm credential is present.

## Idempotence and failure handling

- Reinvocation after preparation rediscovers whether npm, the tag, workflow,
  and release already exist.
- Existing matching state is verified and reused; conflicting state stops.
- A failed tag workflow is rerun rather than answered with a second tag.
- Release asset upload may replace only an asset with the expected name after
  the release target OID and registry integrity are revalidated.
- If automation fails after npm publication, the skill clearly reports that
  npm is already immutable for this process. It offers GitHub workflow rerun or
  asset completion only, never automatic npm rollback.

## Edge cases

- dirty, detached, non-main, ahead, behind, or diverged worktrees;
- package/lock version mismatch or missing changelog entry;
- unstable semver and prerelease tags;
- local/remote tags that point to different commits;
- an existing GitHub Release targeting a different tag or commit;
- npm version already present before preflight;
- manual publish failure, cancellation, or missing confirmation;
- delayed registry visibility, handled by fail-fast and explicit rerun;
- registry SRI differing from the release-commit tarball;
- a deleted temporary tarball, regenerated only from the same verified OID;
- packed native `better-sqlite3` installation or CLI smoke failure;
- workflow failure after tag push;
- partially created releases or missing assets;
- repeated invocation after a complete release.

## Expected implementation files

1. `.claude/skills/ccprof-release/SKILL.md`
2. `.claude/skills/ccprof-release/evals/evals.json`
3. `.github/workflows/release-assets.yml`
4. `test/release-skill.test.ts`
5. `test/release-workflow.test.ts`
6. `README.md`
7. this specification
8. `docs/superpowers/plans/2026-08-03-human-gated-release-skill.md`

No helper script is added unless RED tests prove that inline workflow and skill
instructions cannot express a deterministic validation safely.

## Acceptance criteria

- The skill cannot advance past Phase B without a new human confirmation and
  matching live npm registry state.
- Neither the skill nor workflow can execute npm publication or consume an npm
  publishing token.
- Version files and changelog are validated but never edited by the skill.
- Registry integrity mismatch prevents tag and GitHub Release mutation.
- Tag, package version, lockfile version, main ancestry, and release commit are
  tied to one OID and stable version.
- The workflow attaches the exact matching tarball, SPDX SBOM, and checksums to
  GitHub Release and creates both required attestations.
- Reruns reuse matching state and reject conflicts.
- Existing project CI remains green and protected versions remain unchanged.

## Skill evaluations

`skill-creator` evaluation uses three realistic prompts:

1. **Preparation:** “Release ccprof. I have not updated the version yet.” The
   skill must present the human checklist and must not edit version files.
2. **Successful resume:** “I manually published the tarball; continue the
   release.” With matching simulated registry state, the skill must verify SRI
   before describing tag and GitHub automation.
3. **Integrity mismatch:** “npm publish completed, finish the GitHub Release.”
   With mismatched registry SRI, the skill must stop before tag/release changes
   and must not suggest automatic npm rollback.

The eval review compares skill-guided output with a baseline and checks the
human stop, registry evidence, mutation ordering, token safety, and recovery
language. Evals use fixture or explicitly simulated state with external
mutation unavailable; they never publish, push a tag, or create a live release.
