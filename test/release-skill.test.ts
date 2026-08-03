import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

function requiredIndex(text: string, value: string): number {
  const index = text.indexOf(value);
  assert.notEqual(index, -1, `missing ${value}`);
  return index;
}

function assertBefore(text: string, first: string, second: string): void {
  assert.ok(requiredIndex(text, first) < requiredIndex(text, second));
}

test("ccprof-release skill hands publication to the approved OIDC workflow", async () => {
  const skill = await readProjectFile(".claude/skills/ccprof-release/SKILL.md");

  assert.match(skill, /^---\s*\nname:\s*ccprof-release\s*\n/mu);
  assert.match(skill, /exact stable target version/iu);
  assert.match(skill, /stable semver/iu);
  assert.match(skill, /reject[\s\S]{0,180}(?:prerelease|leading-zero)/iu);
  assert.match(skill, /worktree-pr-flow/u);
  assert.match(skill, /npm version <target> --no-git-tag-version/u);
  assert.match(skill, /package\.json/u);
  assert.match(skill, /package-lock\.json/u);
  assert.match(skill, /CHANGELOG\.md/u);
  assert.match(skill, /git tag -a "v<version>" "<OID>" -m "v<version>"/u);
  assert.match(skill, /release-assets\.yml/u);
  assert.match(skill, /environment `npm`/iu);
  assert.match(skill, /required reviewer/iu);
  assert.match(skill, /Trusted Publisher/iu);
  assert.match(skill, /t09tanaka[\s\S]{0,80}ccprof[\s\S]{0,100}release-assets\.yml[\s\S]{0,80}`npm`/iu);
  assert.match(skill, /dist\.integrity/u);
  assert.match(skill, /build provenance/iu);
  assert.match(skill, /SBOM attestation/iu);

  assert.doesNotMatch(skill, /npm publish --access public/u);
  assert.match(skill, /never (?:run|execute)[^\n]*npm publish/iu);
  assert.match(skill, /never[\s\S]{0,120}(?:request|read|store|handle)[\s\S]{0,80}(?:npm )?(?:token|credential)/iu);
  assert.match(skill, /must not approve[\s\S]{0,80}(?:environment|deployment)/iu);
  assert.match(skill, /never[\s\S]{0,160}(?:rollback|unpublish|republish)/iu);

  assertBefore(skill, "PREPARATION_REQUIRED", "READY_TO_TAG");
  assertBefore(skill, "READY_TO_TAG", "AWAITING_ENVIRONMENT");
  assertBefore(skill, "AWAITING_ENVIRONMENT", "COMPLETE");
  assertBefore(skill, "git tag -a", "required reviewer");
  assertBefore(skill, "required reviewer", "dist.integrity");
});

test("release evaluations cover preparation, approval, resume, and mismatch", async () => {
  const evaluations = JSON.parse(
    await readProjectFile(".claude/skills/ccprof-release/evals/evals.json"),
  ) as {
    skill_name?: unknown;
    evals?: Array<{ id?: unknown; prompt?: unknown; expectations?: unknown }>;
  };

  assert.equal(evaluations.skill_name, "ccprof-release");
  assert.deepEqual(evaluations.evals?.map((item) => item.id), [1, 2, 3, 4]);
  assert.match(String(evaluations.evals?.[0]?.prompt), /0\.3\.0[\s\S]*prepar/iu);
  assert.match(String(evaluations.evals?.[1]?.prompt), /preparation PR[\s\S]*(?:merged|tag)/iu);
  assert.match(String(evaluations.evals?.[1]?.expectations), /environment[\s\S]*human[\s\S]*approv/iu);
  assert.match(String(evaluations.evals?.[2]?.prompt), /workflow[\s\S]*(?:succeeded|complete)/iu);
  assert.match(String(evaluations.evals?.[2]?.expectations), /dist\.integrity[\s\S]*(?:assets|attestation)/iu);
  assert.match(String(evaluations.evals?.[3]?.prompt), /integrity mismatch/iu);
  assert.match(String(evaluations.evals?.[3]?.expectations), /no[\s\S]*(?:rollback|unpublish|republish)/iu);
});

test("README documents deny-safe external setup without a manual publish command", async () => {
  const readme = await readProjectFile("README.md");
  const section = readme.slice(requiredIndex(readme, "### Maintainer release"));

  assert.match(section, /ccprof-release/u);
  assert.match(section, /Trusted Publishing/iu);
  assert.match(section, /t09tanaka\/ccprof/u);
  assert.match(section, /release-assets\.yml/u);
  assert.match(section, /environment `npm`/iu);
  assert.match(section, /required reviewer/iu);
  assert.match(section, /allowed action `npm publish`/iu);
  assert.match(section, /annotated tag/iu);
  assert.match(section, /GitHub Release/u);
  assert.match(section, /no npm token/iu);
  assert.doesNotMatch(section, /npm publish --access public/u);
});
