import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

test("release assets workflow is tag-only and cannot publish to npm", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");

  assert.match(workflow, /^on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+-\s+["']v\*["']/mu);
  assert.doesNotMatch(workflow, /^\s*(?:pull_request|workflow_dispatch|release):/mu);
  for (const permission of [
    "contents: write",
    "id-token: write",
    "attestations: write",
    "artifact-metadata: write",
  ]) {
    assert.ok(workflow.includes(permission), `missing ${permission}`);
  }
  assert.doesNotMatch(workflow, /packages:\s*write/u);
  assert.doesNotMatch(workflow, /npm publish|NPM_TOKEN|NODE_AUTH_TOKEN/u);
});

test("release assets workflow verifies and attests artifacts in the required order", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");

  assert.equal(occurrences(workflow, "npm pack --json"), 1);
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /npm sbom --omit=dev --sbom-format=spdx/u);
  assert.match(workflow, /npm view "ccprof@\$VERSION" dist\.integrity/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.match(workflow, /sha256sum/u);
  assert.equal(
    occurrences(
      workflow,
      "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
    ),
    2,
  );
  assert.ok(
    workflow.indexOf("Verify npm registry integrity") <
      workflow.indexOf("Attest build provenance"),
  );
  assert.ok(
    workflow.indexOf("Attest SBOM") <
      workflow.indexOf("Create or update GitHub Release"),
  );
});

test("release assets workflow validates the release inputs and package smoke tests", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");

  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/u,
  );
  assert.match(
    workflow,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/u,
  );
  assert.match(workflow, /node-version:\s*["']?20["']?/u);
  assert.match(workflow, /fetch-depth:\s*0/u);
  assert.match(workflow, /persist-credentials:\s*false/u);
  assert.match(
    workflow,
    /TAG[^\n]*=~[^\n]*\^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/u,
    "the tag check must reject leading-zero and nonstable versions",
  );
  assert.match(workflow, /package\.json/u);
  assert.match(
    workflow,
    /require\(["']\.\/package-lock\.json["']\)\.version/u,
    "package-lock root version must be checked",
  );
  assert.match(
    workflow,
    /require\(["']\.\/package-lock\.json["']\)\.packages\[["']["']\]\??\.version/u,
    "package-lock packages root version must be checked",
  );
  assert.match(
    workflow,
    /(?:VERSION|PACKAGE_VERSION)[^\n]*(?:!=|!==)[^\n]*(?:TAG|GITHUB_REF_NAME)/u,
    "package and tag versions must be identical",
  );
  assert.match(workflow, /npm ci/u);
  assert.match(workflow, /npm install --global/u);
  assert.match(workflow, /ccprof --version/u);
  assert.match(workflow, /ccprof --help/u);
  assert.match(workflow, /ccprof stats --json/u);
  assert.equal(occurrences(workflow, "subject-path:"), 2);
  assert.equal(occurrences(workflow, "sbom-path:"), 1);
  assert.match(workflow, /gh release create/u);
  assert.match(workflow, /--generate-notes/u);
  assert.match(workflow, /gh release upload/u);
  assert.match(workflow, /--clobber/u);
});
