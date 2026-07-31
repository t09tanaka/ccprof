import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const DOCUMENT_PATHS = [
  "README.md",
  ".claude/commands/retro.md",
  "integrations/pr-skill-snippet.md",
] as const;

async function readDocument(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

test("documentation uses only the installed ccprof command", async () => {
  const documents = await Promise.all(
    DOCUMENT_PATHS.map(async (path) => ({
      path,
      text: await readDocument(path),
    })),
  );

  for (const document of documents) {
    assert.match(document.text, /\bccprof\b/u, document.path);
    assert.doesNotMatch(document.text, /\bnpx\s+ccprof\b/u, document.path);
  }
});

test("README documents the complete direct CLI and analysis contract", async () => {
  const readme = await readDocument("README.md");

  for (const expected of [
    "npm install --global ccprof",
    "npm link",
    "\nccprof\n",
    "ccprof --pr",
    "ccprof --pr 123 --json",
    "ccprof --pr main...feature --md",
    "ccprof stats",
    "ccprof stats --json",
    "ccprof dismiss <finding-key>",
    "--idle-threshold",
    "--test-map",
    "\"version\": 2",
    "unexplained_min",
    "finding_key",
    "this_pr",
    "separate_issue",
    "claude_md",
    "CCPROF_DATA_DIR",
    "Claude Code",
    "R001",
    "R008",
    "npm run build",
    "npm test",
    "npm run typecheck",
  ]) {
    assert.ok(readme.includes(expected), `README is missing ${expected}`);
  }

  assert.match(readme, /ローカル.*(?:送信|アップロード).*しない/su);
  assert.match(readme, /放置.*(?:除外|含めない)/su);
  assert.match(readme, /タイムスタンプ.*(?:限界|厳密ではない)/su);
  assert.match(readme, /14\s*日/u);
  assert.match(readme, /2\s*[×倍]/u);
  assert.match(readme, /Phase\s*1/u);
});

test("retro command fixes only this_pr findings and never creates issues automatically", async () => {
  const retro = await readDocument(".claude/commands/retro.md");

  assert.ok(retro.includes("ccprof --pr --json"));
  assert.ok(retro.includes("scope: this_pr"));
  assert.match(retro, /自動作成しない/u);
  assert.match(retro, /separate_issue|claude_md/u);
});

test("PR integration runs after creation and keeps Markdown posting opt-in", async () => {
  const snippet = await readDocument("integrations/pr-skill-snippet.md");

  assert.ok(snippet.includes("gh pr create"));
  assert.ok(snippet.includes("ccprof --pr --json"));
  assert.ok(snippet.includes("ccprof --pr --md"));
  assert.ok(
    snippet.indexOf("gh pr create") < snippet.indexOf("ccprof --pr --json"),
  );
  assert.match(snippet, /PR 作成成功後/u);
  assert.match(snippet, /明示的.*オプトイン/su);
  assert.match(snippet, /自動作成しない/u);
});
