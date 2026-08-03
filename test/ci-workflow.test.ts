import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const SUPPORTED_NODE_ENGINES = "22.x || 24.x";

async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

function jobBlocks(workflow: string): Map<string, string> {
  const normalized = workflow.replaceAll("\r\n", "\n");
  const jobsAt = normalized.indexOf("\njobs:\n");
  assert.notEqual(jobsAt, -1, "workflow must define jobs");
  const jobs = normalized.slice(jobsAt + 1);
  const headers = [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gmu)].map(
    (match) => ({ id: match[1] ?? "", index: match.index }),
  );
  return new Map(headers.map((header, index) => [
    header.id,
    jobs.slice(header.index, headers[index + 1]?.index ?? jobs.length),
  ]));
}

function job(workflow: string, id: string): string {
  const block = jobBlocks(workflow).get(id);
  assert.ok(block, `missing workflow job ${id}`);
  return block;
}

function yamlList(block: string, key: string): string[] {
  const lines = block.split("\n");
  const keyIndex = lines.findIndex((line) =>
    line.trimStart().startsWith(`${key}:`)
  );
  assert.notEqual(keyIndex, -1, `missing ${key} list`);
  const line = lines[keyIndex];
  if (line === undefined) throw new Error(`missing ${key} line`);
  const tail = line.slice(line.indexOf(":") + 1).trim();
  if (tail.startsWith("[") && tail.endsWith("]")) {
    return tail.slice(1, -1).split(",").map((value) =>
      value.trim().replace(/^['"]|['"]$/gu, "")
    ).filter(Boolean);
  }
  const indent = line.length - line.trimStart().length;
  const values: string[] = [];
  for (const candidate of lines.slice(keyIndex + 1)) {
    if (candidate.trim() === "") continue;
    const candidateIndent = candidate.length - candidate.trimStart().length;
    if (candidateIndent <= indent) break;
    if (candidateIndent === indent + 2 && candidate.trimStart().startsWith("- ")) {
      values.push(candidate.trimStart().slice(2).replace(/^['"]|['"]$/gu, ""));
    }
  }
  assert.ok(values.length > 0, `${key} must be a YAML list`);
  return values;
}

function actionRefs(workflow: string): Array<{ action: string; ref: string }> {
  return [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s*([^\s#]+)/gmu)].map(
    (match) => {
      const token = match[1] ?? "";
      const separator = token.lastIndexOf("@");
      return {
        action: separator === -1 ? token : token.slice(0, separator),
        ref: separator === -1 ? "" : token.slice(separator + 1),
      };
    },
  );
}

function mappingKeys(block: string, key: string): string[] {
  const lines = block.split("\n");
  const keyIndex = lines.findIndex((line) => line.trim() === `${key}:`);
  assert.notEqual(keyIndex, -1, `missing ${key} mapping`);
  const line = lines[keyIndex];
  if (line === undefined) throw new Error(`missing ${key} line`);
  const indent = line.length - line.trimStart().length;
  const keys: string[] = [];
  for (const candidate of lines.slice(keyIndex + 1)) {
    if (candidate.trim() === "") continue;
    const candidateIndent = candidate.length - candidate.trimStart().length;
    if (candidateIndent <= indent) break;
    if (candidateIndent !== indent + 2) continue;
    const match = /^([a-z][a-z0-9-]*):/u.exec(candidate.trimStart());
    if (match?.[1] !== undefined) keys.push(match[1]);
  }
  return keys;
}

function sectionBefore(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return text.slice(startIndex, endIndex);
}

function assertNativeInstallLane(block: string): void {
  assert.match(block, new RegExp(`actions/checkout@${CHECKOUT_SHA}`, "u"));
  assert.match(block, new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`, "u"));
  assert.match(block, /^\s+cache:\s*npm\s*$/mu);
  assert.match(block, /^\s+- run:\s*npm ci\s*$/mu);
  assert.match(
    block,
    /^\s+- run:\s*node tools\/smoke-better-sqlite3\.cjs\s*$/mu,
  );
}

function assertRuntimeLane(block: string): void {
  assertNativeInstallLane(block);
  assert.match(block, /^\s+- run:\s*npm test\s*$/mu);
}

test("workflow job parsing accepts CRLF checkouts", async () => {
  const workflow = await readProjectFile(".github/workflows/ci.yml");
  const crlfWorkflow = workflow.replaceAll("\r\n", "\n")
    .replaceAll("\n", "\r\n");
  assert.deepEqual(
    [...jobBlocks(crlfWorkflow).keys()].sort(),
    [...jobBlocks(workflow).keys()].sort(),
  );
});

test("CI keeps explicit permissions, concurrency, pinned actions, and timeouts", async () => {
  const workflow = await readProjectFile(".github/workflows/ci.yml");
  assert.deepEqual(
    sectionBefore(workflow, "permissions:", "concurrency:")
      .split("\n").map((line) => line.trim()).filter(Boolean),
    ["permissions:", "contents: read"],
  );
  assert.equal(workflow.match(/^\s*permissions:/gmu)?.length, 1);
  assert.deepEqual(
    sectionBefore(workflow, "concurrency:", "jobs:")
      .split("\n").map((line) => line.trim()).filter(Boolean),
    [
      "concurrency:",
      "group: ${{ github.workflow }}-${{ github.ref }}",
      "cancel-in-progress: true",
    ],
  );
  const blocks = jobBlocks(workflow);
  assert.deepEqual([...blocks.keys()].sort(), [
    "arm64-native-smoke",
    "determinism-golden",
    "node26-canary",
    "package-smoke",
    "typecheck",
    "unit-and-integration-matrix",
    "unit-and-integration-tests",
  ].sort());
  for (const [id, block] of blocks) {
    assert.match(block, /^\s+timeout-minutes:\s*\d+\s*$/mu, `${id} timeout`);
  }
  for (const { action, ref } of actionRefs(workflow)) {
    assert.match(ref, /^[a-f0-9]{40}$/u, `${action} must use a full SHA`);
    if (action === "actions/checkout") assert.equal(ref, CHECKOUT_SHA);
    if (action === "actions/setup-node") assert.equal(ref, SETUP_NODE_SHA);
  }
  assert.equal(actionRefs(workflow).filter(({ action }) =>
    action === "actions/checkout").length, 6);
  assert.equal(actionRefs(workflow).filter(({ action }) =>
    action === "actions/setup-node").length, 6);
});

test("CI has the exact six blocking Node 22 and 24 platform pairs", async () => {
  const workflow = await readProjectFile(".github/workflows/ci.yml");
  const matrix = job(workflow, "unit-and-integration-matrix");
  assert.match(matrix, /^\s+fail-fast:\s*false\s*$/mu);
  assert.doesNotMatch(matrix, /continue-on-error/u);
  assert.deepEqual(mappingKeys(matrix, "matrix").sort(), ["node-version", "os"]);
  assert.doesNotMatch(matrix, /^\s+(?:include|exclude):/mu);
  const systems = yamlList(matrix, "os");
  const nodes = yamlList(matrix, "node-version");
  const pairs = systems.flatMap((system) =>
    nodes.map((node) => `${system}/node-${node}`)
  );
  assert.deepEqual(pairs.sort(), [
    "ubuntu-latest/node-22",
    "ubuntu-latest/node-24",
    "macos-latest/node-22",
    "macos-latest/node-24",
    "windows-latest/node-22",
    "windows-latest/node-24",
  ].sort());
  assert.match(matrix, /runs-on:\s*\$\{\{ matrix\.os \}\}/u);
  assert.match(matrix, /node-version:\s*\$\{\{ matrix\.node-version \}\}/u);
  assertRuntimeLane(matrix);
});

test("CI excludes Node 20 while Node 26 remains a separate nonblocking canary", async () => {
  const workflow = await readProjectFile(".github/workflows/ci.yml");
  assert.equal(jobBlocks(workflow).has("node20-compatibility"), false);
  assert.doesNotMatch(workflow, /node20-compatibility|node-version:\s*20/u);

  const node26 = job(workflow, "node26-canary");
  assert.match(node26, /runs-on:\s*ubuntu-latest/u);
  assert.match(node26, /^    continue-on-error:\s*true\s*$/mu);
  assert.match(node26, /node-version:\s*26/u);
  assertRuntimeLane(node26);
  assert.match(node26, /^\s+- run:\s*npm run typecheck\s*$/mu);
});

test("ARM64 native smoke is blocking, pinned, isolated, and runs on real ARM64", async () => {
  const workflow = await readProjectFile(".github/workflows/ci.yml");
  const arm64 = job(workflow, "arm64-native-smoke");
  assert.match(arm64, /^\s+name:\s*arm64-native-smoke\s*$/mu);
  assert.match(arm64, /^\s+runs-on:\s*ubuntu-24\.04-arm\s*$/mu);
  assert.match(arm64, /^\s+node-version:\s*24\s*$/mu);
  assert.doesNotMatch(arm64, /continue-on-error/u);
  assertNativeInstallLane(arm64);
  assert.match(
    arm64,
    /^\s+- run:\s*node -e ['"][^\r\n]*process\.arch[^\r\n]*arm64[^\r\n]*['"]\s*$/mu,
  );
  assert.doesNotMatch(arm64, /^\s+- run:\s*npm test\s*$/mu);
});

test("the legacy test name is an always-run success-only aggregate gate", async () => {
  const workflow = await readProjectFile(".github/workflows/ci.yml");
  const aggregate = job(workflow, "unit-and-integration-tests");
  assert.match(aggregate, /^\s+name:\s*unit-and-integration-tests\s*$/mu);
  assert.deepEqual(
    yamlList(aggregate, "needs").sort(),
    ["arm64-native-smoke", "unit-and-integration-matrix"],
  );
  assert.match(aggregate, /^    if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/mu);
  assert.doesNotMatch(aggregate, /^    continue-on-error:/mu);
  assert.match(
    aggregate,
    /MATRIX_RESULT:\s*\$\{\{\s*needs\.unit-and-integration-matrix\.result\s*\}\}/u,
  );
  assert.match(
    aggregate,
    /ARM64_RESULT:\s*\$\{\{\s*needs\.arm64-native-smoke\.result\s*\}\}/u,
  );
  assert.match(
    aggregate,
    /if \[ "\$MATRIX_RESULT" != "success" \] \|\| \[ "\$ARM64_RESULT" != "success" \]; then\s+exit 1\s+fi/u,
  );
  assert.doesNotMatch(aggregate, /node20-compatibility|node26-canary|NODE20_RESULT/u);
  assert.doesNotMatch(
    aggregate,
    /actions\/checkout|actions\/setup-node|npm ci|smoke-better-sqlite3|^\s+- run:\s*npm test\s*$/mu,
  );
});

test("package metadata supports exactly Node 22.x and 24.x", async () => {
  const packageJson = JSON.parse(
    await readProjectFile("package.json"),
  ) as { engines?: unknown };
  const lockfile = JSON.parse(
    await readProjectFile("package-lock.json"),
  ) as { packages?: Record<string, { engines?: unknown }> };

  assert.deepEqual(packageJson.engines, { node: SUPPORTED_NODE_ENGINES });
  assert.deepEqual(lockfile.packages?.[""]?.engines, {
    node: SUPPORTED_NODE_ENGINES,
  });
});

test("existing named checks and CodeQL use Node 24", async () => {
  const [ci, codeql] = await Promise.all([
    readProjectFile(".github/workflows/ci.yml"),
    readProjectFile(".github/workflows/codeql.yml"),
  ]);
  for (const id of ["typecheck", "package-smoke", "determinism-golden"]) {
    const block = job(ci, id);
    assert.match(block, new RegExp(`^\\s+name:\\s*${id}\\s*$`, "mu"));
    assert.match(block, /node-version:\s*24/u);
  }
  assert.match(codeql, /permissions:[\s\S]*security-events:\s*write/u);
  assert.deepEqual(
    sectionBefore(codeql, "permissions:", "jobs:")
      .split("\n").map((line) => line.trim()).filter(Boolean).sort(),
    [
      "permissions:",
      "contents: read",
      "packages: read",
      "security-events: write",
    ].sort(),
  );
  assert.equal(codeql.match(/^\s*permissions:/gmu)?.length, 1);
  assert.match(job(codeql, "codeql"), /timeout-minutes:\s*15/u);
  assert.match(job(codeql, "codeql"), /node-version:\s*24/u);
  for (const { action, ref } of actionRefs(codeql)) {
    assert.match(ref, /^[a-f0-9]{40}$/u, `${action} must use a full SHA`);
  }
});

test("the native addon smoke is portable and closes its in-memory database", async () => {
  const smoke = await readProjectFile("tools/smoke-better-sqlite3.cjs");
  assert.match(smoke, /require\(["']better-sqlite3["']\)/u);
  assert.match(smoke, /new Database\(["']:memory:["']\)/u);
  assert.match(smoke, /prepare\(["']SELECT 42 AS value["']\)\.get\(\)/u);
  assert.match(smoke, /finally\s*\{[\s\S]*database\.close\(\)[\s\S]*\}/u);
});

test("documentation defines the supported, EOL, canary, ARM64, and case-folding contracts", async () => {
  const readme = await readProjectFile("README.md");
  assert.match(
    readme,
    /Node(?:\.js)? 22\.x and 24\.x[\s\S]{0,160}only supported/u,
  );
  assert.match(
    readme,
    /Node(?:\.js)? 20,? 23,? and 25[\s\S]{0,120}EOL[\s\S]{0,80}unsupported/u,
  );
  assert.match(readme, /Node(?:\.js)? 26[\s\S]{0,120}non-blocking[\s\S]{0,80}canary/u);
  assert.match(readme, /Node(?:\.js)? 26[\s\S]{0,160}not a support claim/u);
  assert.match(
    readme,
    /ARM64[\s\S]{0,200}ubuntu-24\.04-arm[\s\S]{0,200}better-sqlite3/u,
  );
  assert.match(
    readme,
    /case-insensitive filesystem[\s\S]{0,240}(?:explicit|capability)[\s\S]{0,80}skip/u,
  );
  assert.match(
    readme,
    /case-insensitive filesystem[\s\S]{0,400}Windows[\s\S]{0,120}macOS[\s\S]{0,120}matrix/u,
  );
});
