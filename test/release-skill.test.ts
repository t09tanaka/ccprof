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

test("ccprof-release skill defines the human-gated publishing contract", async () => {
  const skill = await readProjectFile(".claude/skills/ccprof-release/SKILL.md");

  assert.match(skill, /^---\s*\nname:\s*ccprof-release\s*\n/mu);
  assert.match(skill, /exact\s+stable\s+target\s+version/iu);
  assert.match(skill, /stable\s+semver/iu);
  assert.match(skill, /(?:reject|do\s+not\s+accept)[\s\S]{0,160}(?:pre-?release|leading[ -]?zero)/iu);
  assert.match(skill, /worktree-pr-flow/u);
  assert.match(skill, /npm version <target> --no-git-tag-version/u);
  assert.match(skill, /supplied\s+version/iu);
  assert.match(skill, /package\.json/u);
  assert.match(skill, /package-lock\.json/u);
  assert.match(skill, /CHANGELOG\.md/u);

  const publishCommand = "npm publish --access public";
  assert.equal(occurrences(skill, publishCommand), 1);
  assert.match(skill, /must\s+not\s+execute[^\n]*npm publish --access public/iu);
  assert.match(skill, /explicit\s+confirmation/iu);
  assert.match(skill, /dist\.integrity/u);
  assert.match(skill, /integrity\s+mismatch[\s\S]{0,240}stop/iu);
  assertBefore(skill, "AWAITING_HUMAN_PUBLISH", "READY_FOR_POSTPROCESSING");
  assertBefore(skill, "explicit confirmation", "dist.integrity");
  assertBefore(skill, "dist.integrity", "git tag -a");
  assertBefore(skill, "integrity mismatch", "git tag -a");
});

test("ccprof-release evaluations cover the supported publication handoff", async () => {
  const evaluations = JSON.parse(
    await readProjectFile(".claude/skills/ccprof-release/evals/evals.json"),
  ) as {
    skill_name?: unknown;
    evals?: Array<{ id?: unknown; prompt?: unknown; expectations?: unknown }>;
  };

  assert.equal(evaluations.skill_name, "ccprof-release");
  assert.deepEqual(
    evaluations.evals?.map((evaluation) => evaluation.id),
    [1, 2, 3],
  );
  assert.match(
    String(evaluations.evals?.[0]?.prompt),
    /release[\s\S]{0,80}0\.3\.0[\s\S]{0,160}prepar/iu,
  );
  assert.match(
    String(evaluations.evals?.[1]?.prompt),
    /manually\s+published[\s\S]{0,160}(?:continue|resume)/iu,
  );
  assert.match(
    String(evaluations.evals?.[2]?.prompt),
    /integrity\s+mismatch/iu,
  );
  assert.match(
    String(evaluations.evals?.[2]?.expectations),
    /no\s+(?:npm\s+)?publish[\s\S]*no\s+(?:git\s+)?tag/iu,
  );
  assert.match(
    String(evaluations.evals?.[2]?.expectations),
    /(?:SRI|integrity)[\s\S]*before[\s\S]*tag/iu,
  );
  assert.match(
    String(evaluations.evals?.[2]?.expectations),
    /no\s+npm\s+rollback/iu,
  );
});

test("README advertises the human publication boundary", async () => {
  const readme = await readProjectFile("README.md");

  assert.match(readme, /^#{1,3}\s+Maintainer release\b/imu);
  assert.match(readme, /ccprof-release/u);
  assert.match(readme, /human[\s\S]{0,100}npm publish --access public/iu);
  assert.match(readme, /GitHub Release/u);
  assert.ok(
    requiredIndex(readme, "npm publish --access public") <
      requiredIndex(readme, "GitHub Release"),
    "README must describe human publishing before GitHub Release postprocessing",
  );
});
