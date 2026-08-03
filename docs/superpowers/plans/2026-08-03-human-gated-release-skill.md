# Human-Gated ccprof Release Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-local release skill that prepares a human-selected version through a PR, stops for manual npm publication, and automates only verified post-publication GitHub artifacts.

**Architecture:** A Markdown skill owns the resumable human/agent state machine, while a tag-only GitHub Actions workflow independently rebuilds the tagged package and checks npm SRI before creating attestations and release assets. Static Node tests enforce the safety boundary and workflow ordering without contacting npm or GitHub.

**Tech Stack:** Claude project skills, GitHub Actions YAML, npm 10 on Node.js 20, Node.js built-in test runner, TypeScript.

---

## File map

- Create `.claude/skills/ccprof-release/SKILL.md`: maintainer-facing state machine and commands.
- Create `.claude/skills/ccprof-release/evals/evals.json`: three safe skill evaluation prompts.
- Create `.github/workflows/release-assets.yml`: tag-triggered verification, attestations, and GitHub Release assets.
- Create `test/release-skill.test.ts`: static contract tests for the skill, evals, and README.
- Create `test/release-workflow.test.ts`: static security and ordering tests for the workflow.
- Modify `README.md`: discoverability and human publication boundary.
- Keep `docs/superpowers/specs/2026-08-03-human-gated-release-skill-design.md` as the approved design.
- Add this plan at `docs/superpowers/plans/2026-08-03-human-gated-release-skill.md`.

### Task 1: Add failing release contract tests

**Files:**
- Create: `test/release-skill.test.ts`
- Create: `test/release-workflow.test.ts`

- [ ] **Step 1: Write the failing skill contract tests**

Create tests using `readFile(resolve(process.cwd(), path), "utf8")`. The tests must assert:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string): Promise<string> =>
  readFile(resolve(process.cwd(), path), "utf8");

test("release skill preserves the human publication boundary", async () => {
  const skill = await read(".claude/skills/ccprof-release/SKILL.md");
  assert.match(skill, /^---\nname: ccprof-release\n/);
  assert.match(skill, /exact stable target version/iu);
  assert.match(skill, /worktree-pr-flow/u);
  assert.match(skill, /npm version <target> --no-git-tag-version/u);
  assert.match(skill, /CHANGELOG\.md/u);
  assert.equal(skill.match(/npm publish --access public/gu)?.length, 1);
  assert.match(skill, /must not execute/iu);
  assert.match(skill, /explicitly confirms/iu);
  assert.match(skill, /dist\.integrity/u);
  assert.match(skill, /integrity.*mismatch.*stop/isu);
  assert.ok(skill.indexOf("AWAITING_HUMAN_PUBLISH") < skill.indexOf("READY_FOR_POSTPROCESSING"));
  assert.ok(skill.indexOf("dist.integrity") < skill.indexOf("git tag -a"));
});

test("release evaluations cover preparation, resume, and mismatch", async () => {
  const source = await read(".claude/skills/ccprof-release/evals/evals.json");
  const parsed = JSON.parse(source) as { skill_name: string; evals: Array<{ id: number; prompt: string; expectations: string[] }> };
  assert.equal(parsed.skill_name, "ccprof-release");
  assert.deepEqual(parsed.evals.map(({ id }) => id), [1, 2, 3]);
  assert.match(parsed.evals[0]!.prompt, /0\.3\.0/u);
  assert.match(parsed.evals[1]!.prompt, /published/iu);
  assert.match(parsed.evals[2]!.expectations.join(" "), /mismatch.*before.*tag/iu);
});

test("README documents the maintainer release handoff", async () => {
  const readme = await read("README.md");
  assert.match(readme, /ccprof-release/u);
  assert.match(readme, /human.*npm publish/isu);
  assert.match(readme, /GitHub Release/iu);
});
```

- [ ] **Step 2: Write the failing workflow contract tests**

Create tests that read `.github/workflows/release-assets.yml` and use explicit substring counts and indexes:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string): Promise<string> =>
  readFile(resolve(process.cwd(), path), "utf8");

test("release workflow is tag-only and has no npm write path", async () => {
  const workflow = await read(".github/workflows/release-assets.yml");
  assert.match(workflow, /push:\n\s+tags:\n\s+- "v\*"/u);
  assert.doesNotMatch(workflow, /pull_request:|workflow_dispatch:|release:/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /attestations: write/u);
  assert.match(workflow, /artifact-metadata: write/u);
  assert.doesNotMatch(workflow, /npm publish|NPM_TOKEN|NODE_AUTH_TOKEN|packages: write/u);
});

test("release workflow verifies one exact package before GitHub mutation", async () => {
  const workflow = await read(".github/workflows/release-assets.yml");
  assert.equal(workflow.match(/npm pack --json/gu)?.length, 1);
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /npm sbom --omit=dev --sbom-format=spdx/u);
  assert.match(workflow, /npm view "ccprof@\$VERSION" dist\.integrity/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.match(workflow, /sha256sum/u);
  assert.equal(workflow.match(/uses: actions\/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d/gu)?.length, 2);
  assert.ok(workflow.indexOf("Verify npm registry integrity") < workflow.indexOf("Attest build provenance"));
  assert.ok(workflow.indexOf("Attest SBOM") < workflow.indexOf("Create or update GitHub Release"));
});
```

- [ ] **Step 3: Delegate the RED run**

Run in a validation subagent:

```sh
npm run build:test && node --test .test-dist/test/release-skill.test.js .test-dist/test/release-workflow.test.js
```

Expected: tests compile, then fail with `ENOENT` for the absent skill, eval, and workflow files. Confirm failures are caused by missing implementation, not TypeScript errors.

- [ ] **Step 4: Commit the RED tests**

```sh
git add test/release-skill.test.ts test/release-workflow.test.ts
git commit -m "test: define human-gated release contracts"
```

### Task 2: Implement the release skill, evaluations, and README handoff

**Files:**
- Create: `.claude/skills/ccprof-release/SKILL.md`
- Create: `.claude/skills/ccprof-release/evals/evals.json`
- Modify: `README.md`
- Test: `test/release-skill.test.ts`

- [ ] **Step 1: Implement the minimal five-state skill**

Use this exact section order so the state and mutation order is auditable:

```markdown
---
name: ccprof-release
description: Release ccprof safely when a maintainer supplies an exact stable version, or resume after the maintainer manually publishes npm; prepares version and changelog by PR, verifies registry integrity, then completes the GitHub release.
---

# ccprof release

## Scope and invariants
## Derive current state
### TARGET_VERSION_REQUIRED
### PREPARATION_REQUIRED
### AWAITING_HUMAN_PUBLISH
### READY_FOR_POSTPROCESSING
### COMPLETE
## Phase A: prepare and verify
## Phase B: mandatory human npm publication
## Phase C: verified GitHub post-processing
## Conflict handling
```

Within those sections, require repository identity `t09tanaka/ccprof`; exact stable, increasing, unpublished user input; `worktree-pr-flow`; `npm version <target> --no-git-tag-version`; Keep a Changelog release notes; normal PR/CI/review/merge/cleanup; clean synchronized `main`; exactly one `npm pack --json`; packed CLI/runtime smoke; runtime-only SPDX; JSON checkpoint fields from the spec; and exactly one displayed human command `npm publish --access public <absolute-tarball-path>`. State that the agent must not execute the command or handle npm credentials. On a later explicit confirmation, rebuild from the same OID, compare live `dist.integrity`, stop on absence/mismatch, then run annotated tag creation with `git tag -a`, push only that tag, wait for `release-assets.yml`, and verify assets and attestations. Matching observed state may be reused; conflicts must stop with evidence.

- [ ] **Step 2: Add the three safe eval cases**

Create valid schema content with no live-mutation files:

```json
{
  "skill_name": "ccprof-release",
  "evals": [
    {
      "id": 1,
      "prompt": "Release ccprof as 0.3.0 in a fixture repository where external mutations are disabled.",
      "expected_output": "Uses exactly 0.3.0 for an isolated preparation PR, without publishing npm or creating a tag.",
      "files": [],
      "expectations": ["Uses the supplied version without selecting another version", "Uses worktree-pr-flow for package, lockfile, and changelog preparation", "Stops before npm publication and tag creation"]
    },
    {
      "id": 2,
      "prompt": "I manually published the prepared tarball; continue the simulated ccprof release with matching registry SRI and external mutations disabled.",
      "expected_output": "Revalidates the release commit and registry SRI before describing the tag and GitHub workflow.",
      "files": [],
      "expectations": ["Requires explicit publication confirmation", "Compares live dist.integrity with the release-commit tarball", "Orders tag and GitHub work after the integrity match"]
    },
    {
      "id": 3,
      "prompt": "npm publish completed; finish the simulated GitHub Release, but the registry SRI differs from the rebuilt tarball and external mutations are disabled.",
      "expected_output": "Stops without a tag or GitHub Release mutation and explains the integrity conflict.",
      "files": [],
      "expectations": ["Stops on the integrity mismatch before tag creation", "Does not suggest npm unpublish, rollback, or republish", "Reports evidence and a human recovery instruction"]
    }
  ]
}
```

- [ ] **Step 3: Document the maintainer handoff**

Add a `### Maintainer releases` subsection under `## Development`. It must point to `.claude/skills/ccprof-release/SKILL.md`, say the maintainer selects the exact version and alone runs npm publish, and say the skill prepares the version/lock/changelog PR and verifies/finishes GitHub Release artifacts after publication.

- [ ] **Step 4: Delegate the GREEN skill test**

```sh
npm run build:test && node --test .test-dist/test/release-skill.test.js
```

Expected: all release-skill tests pass.

- [ ] **Step 5: Commit the skill slice**

```sh
git add .claude/skills/ccprof-release/SKILL.md .claude/skills/ccprof-release/evals/evals.json README.md
git commit -m "feat: add human-gated ccprof release skill"
```

### Task 3: Implement the tag-triggered release assets workflow

**Files:**
- Create: `.github/workflows/release-assets.yml`
- Test: `test/release-workflow.test.ts`

- [ ] **Step 1: Implement the minimal privileged workflow**

Use only `push.tags: ["v*"]`, per-tag non-cancelling concurrency, `ubuntu-latest`, and a 20-minute timeout. Set only `contents: write`, `id-token: write`, `attestations: write`, and `artifact-metadata: write`. Pin:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  with:
    fetch-depth: 0
    persist-credentials: false
- uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
  with:
    node-version: 20
    cache: npm
```

Before mutation, validate the stable `v<package version>` tag, both lockfile root versions, and `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`; then run `npm ci`, `npm run check`, one `npm pack --json`, packed global install, `ccprof --version`, `ccprof --help`, isolated `ccprof stats --json`, and exact npm `dist.integrity` equality. Generate `ccprof-$VERSION.spdx.json` with `npm sbom --omit=dev --sbom-format=spdx` and `SHA256SUMS` over the tarball and SBOM.

Use `actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d` once with `subject-path` for build provenance, then once with the same `subject-path` plus `sbom-path`. Last, with `GH_TOKEN: ${{ github.token }}`, create the verified tag's release with generated notes only if absent, then upload the tarball, SBOM, and checksums using `gh release upload --clobber`. The workflow must not contain npm publication, npm credentials, version edits, or third-party actions.

- [ ] **Step 2: Delegate the GREEN workflow test**

```sh
npm run build:test && node --test .test-dist/test/release-workflow.test.js
```

Expected: all release-workflow tests pass.

- [ ] **Step 3: Commit the workflow slice**

```sh
git add .github/workflows/release-assets.yml
git commit -m "ci: attest verified release assets"
```

### Task 4: Verify scope, skill behavior, and the complete branch

**Files:**
- Modify only if a failing contract identifies a gap in the seven implementation/spec files above.

- [ ] **Step 1: Self-review spec coverage and placeholders**

```sh
rg -n "TB""D|TO""DO|implem""ent later|fill"" in details|Simil""ar to|appropriate error"" handling" docs/superpowers/plans/2026-08-03-human-gated-release-skill.md .claude/skills/ccprof-release/SKILL.md
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
git diff origin/main...HEAD -- package.json package-lock.json CHANGELOG.md
```

Expected: the red-flag scan, whitespace check, and protected-version diff are empty; exactly the eight planned paths are changed.

- [ ] **Step 2: Run three with-skill and three baseline evals safely**

Dispatch fresh agents for every eval. With-skill agents read the new skill; baseline agents receive only the prompt. Explicitly disable external writes, tag pushes, PR creation, npm publication, and GitHub Release mutation. Grade the expectations into `grading.json`, aggregate `benchmark.json`, and create a static review page with skill-creator's `eval-viewer/generate_review.py`. Keep all run artifacts outside the Git worktree.

- [ ] **Step 3: Run the repository's local GitHub Actions checks**

Use `/run-github-actions-locally` through a validation subagent because this branch adds workflow logic. Expected: typecheck, all tests, package smoke, deterministic golden, and workflow contract checks pass.

- [ ] **Step 4: Perform two-stage and final review**

First dispatch a spec-compliance reviewer against the approved design and plan. Only after approval, dispatch a code-quality/security reviewer over `origin/main...HEAD`. Fix findings in new commits and repeat the relevant review.

- [ ] **Step 5: Complete and merge the PR**

Push `feature/human-gated-release-skill`, create a PR to `main`, run `/pr-complete`, wait for all required checks, merge using the user's standing authorization, then run `worktree-pr-flow:cleanup` and synchronize the primary checkout to `main`.
