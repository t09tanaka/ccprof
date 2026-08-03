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

test("ccprof-release skill defines the human-gated publishing contract", async () => {
  const skill = await readProjectFile(".claude/skills/ccprof-release/SKILL.md");

  assert.match(skill, /^---\s*\nname:\s*ccprof-release\s*\n/mu);
  assert.match(skill, /exact\s+stable\s+target\s+version/iu);
  assert.match(skill, /worktree-pr-flow/u);
  assert.match(skill, /npm version <target> --no-git-tag-version/u);
  assert.match(skill, /CHANGELOG\.md/u);

  const publishCommand = "npm publish --access public";
  assert.equal(occurrences(skill, publishCommand), 1);
  assert.match(skill, /must\s+not\s+execute[^\n]*npm publish --access public/iu);
  assert.match(skill, /explicit\s+confirmation/iu);
  assert.match(skill, /dist\.integrity/u);
  assert.match(skill, /integrity\s+mismatch[\s\S]{0,240}stop/iu);

  assert.ok(
    skill.indexOf("AWAITING_HUMAN_PUBLISH") <
      skill.indexOf("READY_FOR_POSTPROCESSING"),
    "AWAITING_HUMAN_PUBLISH must precede READY_FOR_POSTPROCESSING",
  );
  assert.ok(
    skill.indexOf("dist.integrity") < skill.indexOf("git tag -a"),
    "registry integrity must be verified before tagging",
  );
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
  assert.match(String(evaluations.evals?.[0]?.prompt), /0\.3\.0/u);
  assert.match(
    String(evaluations.evals?.[1]?.prompt),
    /published|manual\s+publication/iu,
  );
  assert.match(
    String(evaluations.evals?.[2]?.expectations),
    /mismatch[\s\S]*stops?[\s\S]*before[\s\S]*tag/iu,
  );
});

test("README advertises the human publication boundary", async () => {
  const readme = await readProjectFile("README.md");

  assert.match(readme, /ccprof-release/u);
  assert.match(readme, /human[ -]?(?:controlled|gated)[\s\S]{0,120}npm publish/iu);
  assert.match(readme, /GitHub Release/u);
});
