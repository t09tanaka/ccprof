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

function blockBefore(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end} after ${start}`);
  return text.slice(startIndex, endIndex);
}

function workflowUses(workflow: string): string[] {
  return [...workflow.matchAll(/^\s+uses:\s*([^\s#]+)\s*$/gmu)].map((match) => {
    const action = match[1];
    if (action === undefined) throw new Error("uses line is missing its action");
    return action;
  });
}

function stepBlocks(workflow: string): string[] {
  return workflow.split(/(?=^\s+-\s+name:\s)/gmu);
}

function singleStepContaining(workflow: string, value: string): string {
  const matches = stepBlocks(workflow).filter((step) => step.includes(value));
  assert.equal(matches.length, 1, `expected one step containing ${value}`);
  const step = matches[0];
  if (step === undefined) throw new Error(`missing step containing ${value}`);
  return step;
}

test("release assets workflow is tag-only and cannot publish to npm", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");

  const triggerBlock = blockBefore(workflow, "on:", "permissions:");
  assert.deepEqual(
    triggerBlock
      .split("\n")
      .map((line) => line.trim().replace(/["']/gu, ""))
      .filter(Boolean),
    ["on:", "push:", "tags:", "- v*"],
  );

  const permissions = blockBefore(workflow, "permissions:", "jobs:");
  assert.deepEqual(
    permissions
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean),
    [
    "contents: write",
    "id-token: write",
    "attestations: write",
    "artifact-metadata: write",
    ],
  );
  assert.doesNotMatch(
    workflow,
    /npm publish|NPM_TOKEN|NODE_AUTH_TOKEN|registry-url|always-auth|\.npmrc|_authToken|npm config set/u,
  );
});

test("release assets workflow verifies and attests artifacts in the required order", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");

  assert.equal(occurrences(workflow, "npm pack --json"), 1);
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /npm sbom --omit=dev --sbom-format=spdx/u);
  assert.match(workflow, /npm view "ccprof@\$VERSION" dist\.integrity/u);
  assert.match(workflow, /git merge-base --is-ancestor HEAD origin\/main/u);
  assert.match(workflow, /sha256sum/u);
  assert.match(workflow, /npm sbom --omit=dev --sbom-format=spdx[^\n]*>\s*"?ccprof-\$VERSION\.spdx\.json"?/u);
  assert.match(workflow, /sha256sum[^\n]*"?\$TARBALL"?[^\n]*"?ccprof-\$VERSION\.spdx\.json"?[^\n]*>\s*SHA256SUMS/u);
  assert.match(
    workflow,
    /PACK_INTEGRITY:\s*\$\{\{ steps\.package\.outputs\.integrity \}\}/u,
  );
  const npmViewStep = stepBlocks(workflow).find((step) =>
    step.includes('npm view "ccprof@$VERSION" dist.integrity'),
  );
  assert.ok(npmViewStep, "missing npm-view step");
  const npmViewStepId = npmViewStep.match(/^\s*id:\s*([^\s#]+)/mu)?.[1];
  assert.ok(npmViewStepId, "npm-view step must expose an id");
  const npmViewIndex = workflow.indexOf(npmViewStep);
  const registryBinding = `REGISTRY_INTEGRITY: \${{ steps.${npmViewStepId}.outputs.integrity }}`;
  const registryBindingIndex = workflow.indexOf(registryBinding);
  assert.notEqual(registryBindingIndex, -1, "registry integrity must use npm-view output");
  assert.ok(npmViewIndex < registryBindingIndex, "npm-view must precede its integrity binding");
  assert.match(
    workflow,
    /\[ "\$REGISTRY_INTEGRITY" = "\$PACK_INTEGRITY" \]/u,
  );
  const integrityIndex = workflow.indexOf(
    '[ "$REGISTRY_INTEGRITY" = "$PACK_INTEGRITY" ]',
  );
  const firstAttestationIndex = workflow.indexOf("actions/attest@");
  const releaseIndex = workflow.indexOf("gh release");
  assert.notEqual(integrityIndex, -1, "missing registry integrity equality check");
  assert.notEqual(firstAttestationIndex, -1, "missing provenance attestation");
  assert.notEqual(releaseIndex, -1, "missing GitHub Release command");
  assert.ok(
    integrityIndex < firstAttestationIndex && integrityIndex < releaseIndex,
    "registry integrity must be checked before attestation and release creation",
  );
  assert.ok(
    workflow.indexOf("Attest SBOM") <
      workflow.indexOf("Create or update GitHub Release"),
  );
});

test("release assets workflow validates the release inputs and package smoke tests", async () => {
  const workflow = await readProjectFile(".github/workflows/release-assets.yml");

  assert.deepEqual(workflowUses(workflow), [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
    "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
  ]);
  const checkoutStep = singleStepContaining(
    workflow,
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  );
  assert.match(checkoutStep, /fetch-depth:\s*0/u);
  assert.match(checkoutStep, /persist-credentials:\s*false/u);
  const setupNodeStep = singleStepContaining(
    workflow,
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  );
  assert.match(setupNodeStep, /node-version:\s*["']?20["']?/u);
  assert.match(
    workflow,
    /TAG[^\n]*=~[^\n]*\^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/u,
    "the tag check must reject leading-zero and nonstable versions",
  );
  assert.match(workflow, /VERSION=\$\(node -p 'require\("\.\/package\.json"\)\.version'\)/u);
  assert.match(
    workflow,
    /LOCKFILE_VERSION=\$\(node -p 'require\("\.\/package-lock\.json"\)\.version'\)/u,
    "package-lock root version must be checked",
  );
  assert.match(
    workflow,
    /LOCKFILE_ROOT_VERSION=\$\(node -p 'require\("\.\/package-lock\.json"\)\.packages\[""\]\?\.version'\)/u,
    "package-lock packages root version must be checked",
  );
  assert.match(workflow, /\[ "\$TAG" = "v\$VERSION" \]/u);
  assert.match(workflow, /\[ "\$LOCKFILE_VERSION" = "\$VERSION" \]/u);
  assert.match(workflow, /\[ "\$LOCKFILE_ROOT_VERSION" = "\$VERSION" \]/u);
  assert.match(workflow, /npm ci/u);
  const packageStep = singleStepContaining(workflow, "id: package");
  assert.match(
    packageStep,
    /npm install --global --prefix "\$PREFIX" "\$TARBALL"/u,
  );
  assert.match(packageStep, /export PATH="\$PREFIX\/bin:\$PATH"/u);
  assert.match(
    packageStep,
    /\[ "\$\(ccprof --version\)" = "ccprof \$VERSION" \]/u,
  );
  assert.match(packageStep, /ccprof --help/u);
  assert.match(packageStep, /ccprof stats --json/u);
  const attestations = stepBlocks(workflow).filter((step) =>
    step.includes("actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d"),
  );
  assert.equal(attestations.length, 2);
  for (const step of attestations) {
    assert.match(step, /subject-path:\s*\$\{\{ steps\.package\.outputs\.tarball \}\}/u);
  }
  assert.equal(
    attestations.filter((step) =>
      /sbom-path:\s*\$\{\{ steps\.package\.outputs\.sbom \}\}/u.test(step),
    ).length,
    1,
  );
  assert.match(
    workflow,
    /if ! gh release view "\$TAG"[^\n]*; then[\s\S]*gh release create "\$TAG"[^\n]*--generate-notes[\s\S]*\bfi\b/u,
  );
  assert.match(
    workflow,
    /gh release upload "\$TAG"[^\n]*\$\{\{ steps\.package\.outputs\.tarball \}\}[^\n]*\$\{\{ steps\.package\.outputs\.sbom \}\}[^\n]*\$\{\{ steps\.package\.outputs\.checksums \}\}[^\n]*--clobber/u,
  );
});
