import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD_SHA = "b7c566a772e6b6bfb58ed0dc250532a479d7789f";
const DOWNLOAD_SHA = "37930b1c2abaa49bbe596cd826c3c89aef350131";
const ATTEST_SHA = "508db95dd578ae2727ebd6217d5ba78e4fbda05d";

async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function requiredIndex(text: string, value: string): number {
  const index = text.indexOf(value);
  assert.notEqual(index, -1, `missing ${value}`);
  return index;
}

function assertBefore(text: string, first: string, second: string): void {
  assert.ok(
    requiredIndex(text, first) < requiredIndex(text, second),
    `${first} must precede ${second}`,
  );
}

function blockBefore(text: string, start: string, end: string): string {
  const startIndex = requiredIndex(text, start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing ${end} after ${start}`);
  return text.slice(startIndex, endIndex);
}

function workflowUses(workflow: string): string[] {
  return [...workflow.matchAll(/^\s+uses:\s*([^\s#]+)\s*(?:#.*)?$/gmu)].map(
    (match) => String(match[1]),
  );
}

test("release workflow has one tag-only path and one environment-gated writer", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");
  const trigger = blockBefore(workflow, "on:", "permissions:");

  assert.deepEqual(
    trigger
      .split("\n")
      .map((line) => line.trim().replace(/["']/gu, ""))
      .filter(Boolean),
    ["on:", "push:", "tags:", "- v*"],
  );
  assert.doesNotMatch(workflow, /pull_request:|workflow_dispatch:|workflow_call:/u);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/u);

  const build = blockBefore(workflow, "  build-verify:", "  publish-release:");
  const publish = workflow.slice(requiredIndex(workflow, "  publish-release:"));
  assert.match(build, /permissions:\s*\n\s+contents:\s*read/u);
  assert.doesNotMatch(build, /id-token:\s*write|contents:\s*write|attestations:\s*write/u);
  assert.match(build, /timeout-minutes:\s*[1-9][0-9]*/u);
  assert.match(publish, /needs:\s*build-verify/u);
  assert.match(publish, /environment:\s*npm/u);
  assert.match(publish, /timeout-minutes:\s*[1-9][0-9]*/u);
  assert.match(publish, /contents:\s*write/u);
  assert.match(publish, /id-token:\s*write/u);
  assert.match(publish, /attestations:\s*write/u);
  assert.match(publish, /artifact-metadata:\s*write/u);
  assert.equal(occurrences(workflow, "id-token: write"), 1);
  assert.equal(occurrences(workflow, "environment: npm"), 1);
  assert.match(workflow, /concurrency:[\s\S]*release-assets-\$\{\{ github\.ref_name \}\}[\s\S]*cancel-in-progress:\s*false/u);
});

test("release workflow uses only pinned official actions and a supported OIDC toolchain", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");
  const uses = workflowUses(workflow);

  assert.deepEqual(uses, [
    `actions/checkout@${CHECKOUT_SHA}`,
    `actions/setup-node@${SETUP_NODE_SHA}`,
    `actions/upload-artifact@${UPLOAD_SHA}`,
    `actions/download-artifact@${DOWNLOAD_SHA}`,
    `actions/setup-node@${SETUP_NODE_SHA}`,
    `actions/attest@${ATTEST_SHA}`,
    `actions/attest@${ATTEST_SHA}`,
  ]);
  for (const action of uses) {
    assert.match(action, /^actions\/[a-z-]+@[0-9a-f]{40}$/u);
  }
  assert.match(workflow, /node-version:\s*["']?24["']?/u);
  assert.equal(occurrences(workflow, "npm install --global npm@11.5.1"), 2);
  assert.doesNotMatch(
    workflow,
    /NPM_TOKEN|NODE_AUTH_TOKEN|NPM_READ_TOKEN|secrets\.|packages:\s*write|_authToken|npm\s+login|npm\s+config\s+set/u,
  );
});

test("build job gates identity and transfers one twice-reproduced exact artifact", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");
  const build = blockBefore(workflow, "  build-verify:", "  publish-release:");

  assert.match(build, /fetch-depth:\s*0/u);
  assert.match(build, /persist-credentials:\s*false/u);
  assert.match(build, /\^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/u);
  assert.match(build, /require\("\.\/package\.json"\)\.version/u);
  assert.match(build, /require\("\.\/package-lock\.json"\)\.version/u);
  assert.match(build, /packages\[""\]\?\.version/u);
  assert.match(build, /git merge-base --is-ancestor HEAD origin\/main/u);
  assert.match(build, /npm ci/u);
  assert.match(build, /npm run check/u);

  assert.equal(occurrences(build, "npm pack --json --pack-destination"), 2);
  assert.match(build, /PACK_DIR_A=\$\(mktemp -d\)/u);
  assert.match(build, /PACK_DIR_B=\$\(mktemp -d\)/u);
  assert.match(build, /INTEGRITY_A/u);
  assert.match(build, /INTEGRITY_B/u);
  assert.match(build, /\[ "\$INTEGRITY_A" = "\$INTEGRITY_B" \]/u);
  assert.match(build, /SHA256_A/u);
  assert.match(build, /SHA256_B/u);
  assert.match(build, /\[ "\$SHA256_A" = "\$SHA256_B" \]/u);
  assert.match(build, /npm install --global --prefix "\$PREFIX" "\$TARBALL"/u);
  assert.match(build, /ccprof stats --privacy strict --json/u);
  assert.match(build, /npm sbom --omit=dev --sbom-format=spdx/u);
  assert.match(build, /sha256sum/u);
  assert.match(build, /release-metadata\.json/u);
  assert.match(build, /name:\s*release-bundle/u);
  assert.match(build, /retention-days:\s*[1-9][0-9]*/u);
});

test("publish job fails closed, publishes one explicit tarball, and confirms registry propagation", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");
  const publish = workflow.slice(requiredIndex(workflow, "  publish-release:"));

  assert.match(publish, /sha256sum --check SHA256SUMS/u);
  assert.match(publish, /release-metadata\.json/u);
  assert.match(publish, /repos\/\$GITHUB_REPOSITORY\/environments\/npm/u);
  assert.match(publish, /required_reviewers/u);
  assert.match(publish, /REVIEWER_COUNT/u);
  assert.match(publish, /\[ "\$REVIEWER_COUNT" -gt 0 \]/u);

  assert.equal(occurrences(workflow, "npm publish"), 1);
  assert.match(
    publish,
    /npm publish "\$TARBALL" --access public --provenance/u,
  );
  assert.doesNotMatch(publish, /npm publish\s+(?:--access|--provenance)/u);
  assert.match(publish, /npm view "ccprof@\$VERSION" dist\.integrity/u);
  assert.match(publish, /E404|404 Not Found/u);
  assert.match(publish, /existing registry integrity mismatch/u);
  assert.match(publish, /network or non-404 registry failure/u);
  assert.match(publish, /existing registry integrity matches; skipping publish/u);
  assert.match(publish, /for ATTEMPT in \$\(seq 1 12\)/u);
  assert.match(publish, /sleep 10/u);
  assert.match(publish, /registry propagation timed out/u);

  assertBefore(publish, "sha256sum --check SHA256SUMS", "npm publish");
  assertBefore(publish, "required_reviewers", "npm publish");
  assertBefore(publish, "npm publish", "for ATTEMPT in $(seq 1 12)");
  assertBefore(publish, "for ATTEMPT in $(seq 1 12)", "actions/attest@");
  assertBefore(publish, "for ATTEMPT in $(seq 1 12)", "gh release");
});

test("attestations and GitHub Release consume the downloaded verified bytes", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");
  const publish = workflow.slice(requiredIndex(workflow, "  publish-release:"));

  assert.equal(occurrences(publish, `actions/attest@${ATTEST_SHA}`), 2);
  assert.equal(occurrences(publish, "subject-path: ${{ env.TARBALL }}"), 2);
  assert.equal(occurrences(publish, "sbom-path: ${{ env.SBOM }}"), 1);
  assert.match(publish, /gh release create "\$TAG"[^\n]*--verify-tag[^\n]*--generate-notes/u);
  assert.match(publish, /gh release upload "\$TAG" "\$TARBALL" "\$SBOM" "\$CHECKSUMS" --clobber/u);
  assert.doesNotMatch(workflow, /npm unpublish|npm deprecate|rollback|republish/iu);
});

test("CI package smoke exercises the installed schema and strict stats privacy", async () => {
  const workflow = await readProjectFile(".github/workflows/ci.yml");
  const packageJob = blockBefore(workflow, "  package-smoke:", "  determinism-golden:");
  assert.match(
    packageJob,
    /"\$RUNNER_TEMP\/ccprof-prefix\/bin\/ccprof" schema report-v3\s*>\s*"\$RUNNER_TEMP\/ccprof-report-v3\.schema\.json"/u,
  );
  assert.match(packageJob, /const schema = JSON\.parse\(/u);
  assert.match(
    packageJob,
    /schema\.properties\.schema_version\.const !== 3/u,
  );
  assert.match(
    packageJob,
    /' "\$RUNNER_TEMP\/ccprof-report-v3\.schema\.json"/u,
  );
  assertBefore(
    packageJob,
    "ccprof\" schema report-v3",
    'mkdir -p "$RUNNER_TEMP/ccprof-smoke-repo"',
  );
  assert.match(packageJob, /ccprof" stats --privacy strict --json/u);
});
