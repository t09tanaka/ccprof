import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  CliUsageError, parseCliArgs, runCli,
} from "../src/cli.js";

const IDS = [
  "configuration",
  "organization_policy",
  "source_capabilities",
  "parser_budgets",
  "store_schema",
  "store_migrations",
  "store_open",
  "encryption",
] as const;
const ORG_KEYS = [
  "CCPROF_ORGANIZATION",
  "CCPROF_ORGANIZATION_POLICY_PATH",
  "CCPROF_ORGANIZATION_POLICY_SIGNATURE_PATH",
  "CCPROF_ORGANIZATION_POLICY_PUBLIC_KEY_PATH",
] as const;
interface DoctorJson {
  status: "pass" | "warn" | "fail";
  checks: { id: string; status: "pass" | "warn" | "fail";
    code: string; message: string }[];
}

async function fixture(t: TestContext): Promise<{
  root: string; repo: string; dataRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-doctor-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  return { root, repo, dataRoot: join(root, "private-data-root") };
}

async function capture(
  args: readonly string[], repo: string, dataRoot: string,
  organization: Partial<Record<(typeof ORG_KEYS)[number], string>> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const keys = ["CCPROF_DATA_DIR", "CI", ...ORG_KEYS] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.CCPROF_DATA_DIR = dataRoot;
  delete process.env.CI;
  for (const key of ORG_KEYS) {
    const value = organization[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let stdout = "";
  let stderr = "";
  try {
    const code = await runCli(args, {
      cwd: repo,
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    return { code, stdout, stderr };
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("doctor parses its exact public command shapes", () => {
  assert.deepEqual(parseCliArgs(["doctor"]), { kind: "doctor", json: false });
  assert.deepEqual(parseCliArgs(["doctor", "--json"]), {
    kind: "doctor", json: true,
  });
  for (const args of [
    ["doctor", "--unknown"],
    ["doctor", "--json", "extra"],
    ["doctor", "--json", "--json"],
  ]) assert.throws(() => parseCliArgs(args), CliUsageError);
});

test("doctor is deterministic, ordered, warning-safe, and read-only", async (t) => {
  const { repo, dataRoot } = await fixture(t);
  const first = await capture(["doctor", "--json"], repo, dataRoot);
  const second = await capture(["doctor", "--json"], repo, dataRoot);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stderr, "");
  const report = JSON.parse(first.stdout) as DoctorJson;
  assert.equal(report.status, "warn");
  assert.deepEqual(
    report.checks.map((check) => check.id),
    IDS,
  );
  for (const id of ["parser_budgets", "encryption"] as const) {
    assert.equal(report.checks.find((check) => check.id === id)?.status, "warn");
  }
  const textFirst = await capture(["doctor"], repo, dataRoot);
  const textSecond = await capture(["doctor"], repo, dataRoot);
  assert.equal(textFirst.code, 0);
  assert.equal(textFirst.stdout, textSecond.stdout);
  for (const id of IDS) assert.match(textFirst.stdout, new RegExp(id, "u"));
  assert.equal(existsSync(dataRoot), false);
});

test("doctor contains malformed configuration and organization paths", async (t) => {
  const { root, repo, dataRoot } = await fixture(t);
  const secret = "DISTINCTIVE_DOCTOR_SECRET_CANARY";
  await mkdir(join(repo, ".ccprof"));
  await writeFile(join(repo, ".ccprof", "config.json"),
    `{"unknown_secret":"${secret}"`);
  const malformed = await capture(["doctor", "--json"], repo, dataRoot);
  const malformedAgain = await capture(["doctor", "--json"], repo, dataRoot);
  assert.equal(malformed.code, 1);
  assert.deepEqual(malformedAgain, malformed);
  const malformedCheck = (JSON.parse(malformed.stdout) as DoctorJson).checks
    .find((check) => check.id === "configuration");
  assert.deepEqual(malformedCheck, {
    id: "configuration",
    status: "fail",
    code: "configuration_invalid",
    message: "Repository configuration is invalid.",
  });
  assert.ok(malformed.stdout.length <= 4_096);
  assert.ok(malformed.stderr.length <= 1_024);
  assert.doesNotMatch(malformed.stdout + malformed.stderr,
    new RegExp(`${secret}|${repo}|${dataRoot}`, "u"));

  await writeFile(join(repo, ".ccprof", "config.json"),
    JSON.stringify({ schema_version: 1 }));
  const policyPath = join(root, `${secret}-policy.json`);
  const partial = await capture(["doctor", "--json"], repo, dataRoot, {
    CCPROF_ORGANIZATION: "example-org",
    CCPROF_ORGANIZATION_POLICY_PATH: policyPath,
  });
  const partialAgain = await capture(["doctor", "--json"], repo, dataRoot, {
    CCPROF_ORGANIZATION: "example-org",
    CCPROF_ORGANIZATION_POLICY_PATH: policyPath,
  });
  assert.equal(partial.code, 1);
  assert.deepEqual(partialAgain, partial);
  const policyCheck = (JSON.parse(partial.stdout) as DoctorJson).checks
    .find((check) => check.id === "organization_policy");
  assert.deepEqual(policyCheck, {
    id: "organization_policy",
    status: "fail",
    code: "organization_policy_invalid",
    message: "Organization policy configuration is invalid.",
  });
  assert.ok(partial.stdout.length <= 4_096);
  assert.ok(partial.stderr.length <= 1_024);
  assert.doesNotMatch(partial.stdout + partial.stderr,
    new RegExp(`${secret}|${policyPath}`, "u"));
});

test("doctor usage failures remain exit 2", async (t) => {
  const { repo, dataRoot } = await fixture(t);
  for (const args of [
    ["doctor", "--unknown"],
    ["doctor", "--json", "extra"],
  ]) {
    const result = await capture(args, repo, dataRoot);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: ccprof/u);
  }
});
