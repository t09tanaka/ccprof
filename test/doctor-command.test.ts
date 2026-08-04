import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";

import {
  CliUsageError, parseCliArgs, runCli, USAGE,
} from "../src/cli.js";
import { runDoctorCommand } from "../src/commands/doctor.js";
import { resolveStorePaths } from "../src/store/paths.js";
import {
  INCREMENTAL_SOURCES_MIGRATION,
  openStoreDatabase,
  storeDatabasePath,
} from "../src/store/sqlite.js";

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
  schema_version: 1;
  command: "doctor";
  status: "pass" | "warn" | "fail";
  checks: { id: string; status: "pass" | "warn" | "fail";
    code: string; message: string }[];
}

function storeChecks(report: DoctorJson): DoctorJson["checks"] {
  return report.checks.filter((check) => check.id.startsWith("store_"));
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

test("doctor preserves global help precedence", async (t) => {
  assert.deepEqual(parseCliArgs(["doctor", "--help"]), { kind: "help" });
  const { repo, dataRoot } = await fixture(t);

  const result = await capture(["doctor", "--help"], repo, dataRoot);

  assert.deepEqual(result, { code: 0, stdout: USAGE, stderr: "" });
});

test("README documents the doctor command contract", async () => {
  const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
  const prose = readme.replaceAll(/\s+/gu, " ");

  assert.match(readme, /ccprof doctor \[--json\]/u);
  for (const phrase of [
    "configuration",
    "organization policy",
    "source capabilities",
    "parser budgets",
    "Store schema",
    "migration",
    "open health",
    "encryption",
  ]) {
    assert.match(prose, new RegExp(phrase, "u"));
  }
  for (const property of ["deterministically", "privacy-safe", "read-only"]) {
    assert.match(readme, new RegExp(property, "u"));
  }
  assert.match(
    prose,
    /Doctor does not create the Store, initialize it, migrate it, repair it, backfill it/u,
  );
  assert.match(prose, /A missing Store is reported as a warning/u);
  assert.match(
    prose,
    /An unconfigured or unavailable operator parser budget profile is reported as a warning/u,
  );
  assert.match(
    prose,
    /Unavailable encryption support is reported as a warning/u,
  );
  assert.match(prose, /Warnings still use exit 0 when no check failed/u);
  assert.match(prose, /Exit 0 means no check failed/u);
  assert.match(prose, /exit 1 means at least one check failed/u);
  assert.match(prose, /exit 2 means invalid command usage/u);
});

test("doctor command exposes an empty warnings collection", async (t) => {
  const { repo, dataRoot } = await fixture(t);
  const result = await runDoctorCommand({
    cwd: repo,
    json: true,
    env: { CCPROF_DATA_DIR: dataRoot },
  });

  assert.deepEqual(Object.keys(result), ["stdout", "warnings", "exitCode"]);
  assert.deepEqual((result as unknown as { warnings: unknown }).warnings, []);
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
  assert.deepEqual(Object.keys(report), [
    "schema_version", "command", "status", "checks",
  ]);
  assert.equal(report.schema_version, 1);
  assert.equal(report.command, "doctor");
  assert.equal(report.status, "warn");
  assert.deepEqual(
    report.checks.map((check) => check.id),
    IDS,
  );
  for (const id of ["parser_budgets", "encryption"] as const) {
    assert.equal(report.checks.find((check) => check.id === id)?.status, "warn");
  }
  assert.deepEqual(
    storeChecks(report).map(({ id, status }) => ({ id, status })),
    [
      { id: "store_schema", status: "warn" },
      { id: "store_migrations", status: "warn" },
      { id: "store_open", status: "pass" },
    ],
  );
  const textFirst = await capture(["doctor"], repo, dataRoot);
  const textSecond = await capture(["doctor"], repo, dataRoot);
  assert.equal(textFirst.code, 0);
  assert.equal(textFirst.stdout, textSecond.stdout);
  for (const id of IDS) assert.match(textFirst.stdout, new RegExp(id, "u"));
  assert.equal(existsSync(dataRoot), false);
});

test("doctor reports a healthy current store without modifying it", async (t) => {
  const { repo, dataRoot } = await fixture(t);
  const paths = await resolveStorePaths(repo, {
    env: { CCPROF_DATA_DIR: dataRoot },
  });
  openStoreDatabase(paths).close();
  const path = storeDatabasePath(paths);
  const before = await readFile(path);

  const result = await capture(["doctor", "--json"], repo, dataRoot);

  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout) as DoctorJson;
  assert.deepEqual(
    storeChecks(report).map(({ id, status }) => ({ id, status })),
    [
      { id: "store_schema", status: "pass" },
      { id: "store_migrations", status: "pass" },
      { id: "store_open", status: "pass" },
    ],
  );
  assert.deepEqual(await readFile(path), before);
});

test("doctor leaves a supported old store pending and unmodified", async (t) => {
  const { repo, dataRoot } = await fixture(t);
  const paths = await resolveStorePaths(repo, {
    env: { CCPROF_DATA_DIR: dataRoot },
  });
  const database = openStoreDatabase(paths);
  database.prepare("DELETE FROM store_migrations WHERE name = ?")
    .run(INCREMENTAL_SOURCES_MIGRATION);
  database.pragma("user_version = 4");
  database.close();
  const path = storeDatabasePath(paths);
  const before = await readFile(path);

  const result = await capture(["doctor", "--json"], repo, dataRoot);

  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout) as DoctorJson;
  assert.deepEqual(
    storeChecks(report).map(({ id, status }) => ({ id, status })),
    [
      { id: "store_schema", status: "warn" },
      { id: "store_migrations", status: "warn" },
      { id: "store_open", status: "pass" },
    ],
  );
  assert.deepEqual(await readFile(path), before);
  const readonly = new Database(path, { readonly: true, fileMustExist: true });
  assert.equal(Number(readonly.pragma("user_version", { simple: true })), 4);
  readonly.close();
});

test("doctor reads WAL state without creating Store sidecars", async (t) => {
  const { repo, dataRoot } = await fixture(t);
  const paths = await resolveStorePaths(repo, {
    env: { CCPROF_DATA_DIR: dataRoot },
  });
  openStoreDatabase(paths).close();
  const path = storeDatabasePath(paths);
  const writer = `
    import Database from "better-sqlite3";
    const database = new Database(process.argv[1]);
    database.pragma("wal_autocheckpoint = 0");
    database.prepare("DELETE FROM store_migrations WHERE name = ?")
      .run(process.argv[2]);
    database.pragma("user_version = 4");
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawnSync(process.execPath, [
    "--input-type=module", "-e", writer, path,
    INCREMENTAL_SOURCES_MIGRATION,
  ], { cwd: process.cwd() });
  if (process.platform === "win32") {
    assert.equal(child.signal, null);
    assert.notEqual(child.status, null);
    assert.notEqual(child.status, 0);
  } else {
    assert.equal(child.signal, "SIGKILL");
  }
  await rm(`${path}-shm`, { force: true });
  const snapshot = async () => Object.fromEntries(await Promise.all(
    (await readdir(paths.repo_dir)).sort().map(async (name) => {
      const file = join(paths.repo_dir, name);
      const [bytes, status] = await Promise.all([
        readFile(file), stat(file, { bigint: true }),
      ]);
      return [name, {
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mtimeNs: status.mtimeNs,
      }];
    }),
  ));
  const before = await snapshot();

  const result = await capture(["doctor", "--json"], repo, dataRoot);

  assert.equal(result.code, 0);
  assert.deepEqual(
    storeChecks(JSON.parse(result.stdout) as DoctorJson)
      .map(({ id, status }) => ({ id, status })),
    [
      { id: "store_schema", status: "warn" },
      { id: "store_migrations", status: "warn" },
      { id: "store_open", status: "pass" },
    ],
  );
  assert.deepEqual(await snapshot(), before);
});

test("doctor recognizes an empty v0 store without initializing it", async (t) => {
  const { repo, dataRoot } = await fixture(t);
  const paths = await resolveStorePaths(repo, {
    env: { CCPROF_DATA_DIR: dataRoot },
  });
  await mkdir(paths.repo_dir, { recursive: true });
  const path = storeDatabasePath(paths);
  new Database(path).close();
  const before = await readFile(path);

  const result = await capture(["doctor", "--json"], repo, dataRoot);

  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout) as DoctorJson;
  assert.deepEqual(
    storeChecks(report).map(({ id, status }) => ({ id, status })),
    [
      { id: "store_schema", status: "warn" },
      { id: "store_migrations", status: "warn" },
      { id: "store_open", status: "pass" },
    ],
  );
  assert.deepEqual(await readFile(path), before);
});

test("doctor contains a corrupt store failure without modifying it", async (t) => {
  const { repo, dataRoot } = await fixture(t);
  const paths = await resolveStorePaths(repo, {
    env: { CCPROF_DATA_DIR: dataRoot },
  });
  await mkdir(paths.repo_dir, { recursive: true });
  const path = storeDatabasePath(paths);
  await writeFile(path, "DISTINCTIVE_CORRUPT_STORE_CANARY");
  const before = await readFile(path);

  const result = await capture(["doctor", "--json"], repo, dataRoot);

  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout) as DoctorJson;
  assert.deepEqual(
    storeChecks(report).map(({ id, status }) => ({ id, status })),
    [
      { id: "store_schema", status: "fail" },
      { id: "store_migrations", status: "fail" },
      { id: "store_open", status: "fail" },
    ],
  );
  assert.deepEqual(await readFile(path), before);
  assert.equal(result.stdout.includes("DISTINCTIVE_CORRUPT_STORE_CANARY"), false);
  assert.equal(result.stdout.includes(repo), false);
  assert.equal(result.stdout.includes(dataRoot), false);
  assert.ok(result.stdout.length <= 4_096);
  assert.equal(result.stderr, "");
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
  const malformedOutput = malformed.stdout + malformed.stderr;
  for (const value of [secret, repo, dataRoot]) {
    assert.equal(malformedOutput.includes(value), false);
  }
  const malformedText = await capture(["doctor"], repo, dataRoot);
  const malformedTextAgain = await capture(["doctor"], repo, dataRoot);
  assert.equal(malformedText.code, 1);
  assert.deepEqual(malformedTextAgain, malformedText);
  assert.ok(malformedText.stdout.includes(
    "[FAIL] configuration: Repository configuration is invalid.",
  ));
  assert.ok(malformedText.stdout.length <= 4_096);
  assert.ok(malformedText.stderr.length <= 1_024);
  const malformedTextOutput = malformedText.stdout + malformedText.stderr;
  for (const value of [secret, repo, dataRoot]) {
    assert.equal(malformedTextOutput.includes(value), false);
  }

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
  const partialOutput = partial.stdout + partial.stderr;
  for (const value of [secret, policyPath]) {
    assert.equal(partialOutput.includes(value), false);
  }
  const partialText = await capture(["doctor"], repo, dataRoot, {
    CCPROF_ORGANIZATION: "example-org",
    CCPROF_ORGANIZATION_POLICY_PATH: policyPath,
  });
  const partialTextAgain = await capture(["doctor"], repo, dataRoot, {
    CCPROF_ORGANIZATION: "example-org",
    CCPROF_ORGANIZATION_POLICY_PATH: policyPath,
  });
  assert.equal(partialText.code, 1);
  assert.deepEqual(partialTextAgain, partialText);
  assert.ok(partialText.stdout.includes(
    "[FAIL] organization_policy: Organization policy configuration is invalid.",
  ));
  assert.ok(partialText.stdout.length <= 4_096);
  assert.ok(partialText.stderr.length <= 1_024);
  const partialTextOutput = partialText.stdout + partialText.stderr;
  for (const value of [secret, policyPath, repo, dataRoot]) {
    assert.equal(partialTextOutput.includes(value), false);
  }
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
