import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  parseExplicitTestMap,
  TestMapError,
  type TestMap,
} from "./test-map.js";
import type { RepositoryPolicyPreferences } from
  "../policy/organization-policy.js";
import {
  snapshotRepositoryApprovalRulePolicy,
  snapshotResourceDomains,
} from "../policy/rule-safety.js";

const CONFIG_PATH = ".ccprof/config.json";
const CONFIG_KEYS = new Set([
  "$schema",
  "schema_version",
  "test_map",
  "policy",
]);
const TEST_MAP_KEYS = new Set(["mappings"]);
const MAPPING_KEYS = new Set(["source", "tests", "commands"]);
const POLICY_KEYS = new Set([
  "minimum_privacy",
  "allow_raw",
  "allow_advisory",
  "allow_export",
  "raw_retention_days_max",
  "required_source_coverage",
  "approval_policy",
  "resource_domains",
]);
const SAFE_IO_CODES = new Set([
  "EACCES",
  "EBADF",
  "EIO",
  "ELOOP",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
]);

export class RepositoryConfigError extends Error {
  constructor(detail: string) {
    super(`${CONFIG_PATH}: ${detail}`);
    this.name = "RepositoryConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = typeof error.code === "string" ? error.code : undefined;
  return code !== undefined && SAFE_IO_CODES.has(code) ? code : undefined;
}

function ioFailure(action: string, error: unknown): RepositoryConfigError {
  const code = errorCode(error);
  return new RepositoryConfigError(
    `${action}${code === undefined ? " (filesystem error)" : ` (${code})`}`,
  );
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertConfigDirectory(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new RepositoryConfigError(
      ".ccprof must be a real repository directory",
    );
  }
}

function assertConfigFile(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new RepositoryConfigError("must be a regular repository file");
  }
}

function assertClosedObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RepositoryConfigError(`${label} must be an object`);
  }
  const unknown = Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .sort()[0];
  if (unknown !== undefined) {
    throw new RepositoryConfigError(
      `${label} contains unknown keys`,
    );
  }
}

function validateClosedTestMap(value: unknown): void {
  assertClosedObject(value, TEST_MAP_KEYS, "test_map");
  if (!Array.isArray(value.mappings)) {
    throw new RepositoryConfigError("test_map.mappings must be an array");
  }
  value.mappings.forEach((mapping, index) => {
    assertClosedObject(mapping, MAPPING_KEYS, `test_map.mappings[${index}]`);
  });
}

interface ParsedRepositoryConfig {
  testMap: TestMap;
  policy: RepositoryPolicyPreferences;
}

function emptyConfig(): ParsedRepositoryConfig {
  return {
    testMap: { mappings: [], caveats: [] },
    policy: {},
  };
}

function assertOptionalPrivacy(
  value: unknown,
): asserts value is RepositoryPolicyPreferences["minimum_privacy"] {
  if (
    value !== undefined && value !== "strict" &&
    value !== "balanced" && value !== "raw"
  ) {
    throw new RepositoryConfigError("policy contains invalid values");
  }
}

function assertOptionalBoolean(
  value: unknown,
): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new RepositoryConfigError("policy contains invalid values");
  }
}

function assertOptionalRetention(
  value: unknown,
): asserts value is number | undefined {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new RepositoryConfigError("policy contains invalid values");
  }
}

function assertOptionalCoverage(
  value: unknown,
): asserts value is number | undefined {
  if (
    value !== undefined &&
    (typeof value !== "number" || !Number.isFinite(value) ||
      value < 0 || value > 1)
  ) {
    throw new RepositoryConfigError("policy contains invalid values");
  }
}

function snapshotRuleSafety<T>(action: () => T): T {
  try {
    return action();
  } catch {
    throw new RepositoryConfigError("policy contains invalid values");
  }
}

function parsePolicyPreferences(
  value: unknown,
): RepositoryPolicyPreferences {
  assertClosedObject(value, POLICY_KEYS, "policy");
  const minimumPrivacy = value.minimum_privacy;
  const allowRaw = value.allow_raw;
  const allowAdvisory = value.allow_advisory;
  const allowExport = value.allow_export;
  const rawRetentionDaysMax = value.raw_retention_days_max;
  const requiredSourceCoverage = value.required_source_coverage;
  assertOptionalPrivacy(minimumPrivacy);
  assertOptionalBoolean(allowRaw);
  assertOptionalBoolean(allowAdvisory);
  assertOptionalBoolean(allowExport);
  assertOptionalRetention(rawRetentionDaysMax);
  assertOptionalCoverage(requiredSourceCoverage);
  const approvalPolicy = value.approval_policy === undefined
    ? undefined
    : snapshotRuleSafety(() =>
      snapshotRepositoryApprovalRulePolicy(value.approval_policy)
    );
  const resourceDomains = value.resource_domains === undefined
    ? undefined
    : snapshotRuleSafety(() => snapshotResourceDomains(
      value.resource_domains,
    ));
  return {
    ...(minimumPrivacy === undefined
      ? {}
      : { minimum_privacy: minimumPrivacy }),
    ...(allowRaw === undefined ? {} : { allow_raw: allowRaw }),
    ...(allowAdvisory === undefined
      ? {}
      : { allow_advisory: allowAdvisory }),
    ...(allowExport === undefined ? {} : { allow_export: allowExport }),
    ...(rawRetentionDaysMax === undefined
      ? {}
      : { raw_retention_days_max: rawRetentionDaysMax }),
    ...(requiredSourceCoverage === undefined
      ? {}
      : { required_source_coverage: requiredSourceCoverage }),
    ...(approvalPolicy === undefined
      ? {}
      : { approval_policy: approvalPolicy }),
    ...(resourceDomains === undefined
      ? {}
      : { resource_domains: resourceDomains }),
  };
}

function parseConfig(text: string): ParsedRepositoryConfig {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RepositoryConfigError("must contain valid JSON");
  }
  assertClosedObject(value, CONFIG_KEYS, "config");
  if (value.schema_version !== 1) {
    throw new RepositoryConfigError("schema_version must be 1");
  }
  if (
    value.$schema !== undefined &&
    (typeof value.$schema !== "string" || value.$schema.trim() === "")
  ) {
    throw new RepositoryConfigError("$schema must be a non-empty string");
  }
  const policy = value.policy === undefined
    ? {}
    : parsePolicyPreferences(value.policy);
  if (value.test_map === undefined) {
    return {
      testMap: {
        mappings: [],
        caveats: [],
        config_schema_version: 1,
      },
      policy,
    };
  }
  validateClosedTestMap(value.test_map);
  let parsed: TestMap;
  try {
    parsed = parseExplicitTestMap(value.test_map);
  } catch (error) {
    if (error instanceof TestMapError) {
      throw new RepositoryConfigError("test_map contains invalid mappings");
    }
    throw new RepositoryConfigError("test_map could not be validated");
  }
  return {
    testMap: {
      mappings: parsed.mappings.map((mapping) => ({
        ...mapping,
        origin: "config",
        caveat: "Relevance is based on .ccprof/config.json.",
      })),
      caveats: parsed.caveats,
      config_schema_version: 1,
    },
    policy,
  };
}

async function loadRepositoryConfigDocument(
  repoRoot: string,
): Promise<ParsedRepositoryConfig> {
  const directoryPath = join(repoRoot, ".ccprof");
  const path = join(repoRoot, ".ccprof", "config.json");
  let directoryBefore: Stats;
  try {
    directoryBefore = await lstat(directoryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyConfig();
    throw ioFailure(".ccprof cannot be inspected", error);
  }
  assertConfigDirectory(directoryBefore);

  let pathBefore: Stats;
  try {
    pathBefore = await lstat(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw ioFailure("config file cannot be inspected", error);
    }
    let directoryAfter: Stats;
    try {
      directoryAfter = await lstat(directoryPath);
    } catch (afterError) {
      throw ioFailure(".ccprof cannot be verified", afterError);
    }
    assertConfigDirectory(directoryAfter);
    if (!sameIdentity(directoryBefore, directoryAfter)) {
      throw new RepositoryConfigError(".ccprof changed during lookup");
    }
    return emptyConfig();
  }
  assertConfigFile(pathBefore);

  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw ioFailure("cannot be opened", error);
  }

  let text: string;
  try {
    const openedFile = await handle.stat();
    assertConfigFile(openedFile);
    if (!sameIdentity(pathBefore, openedFile)) {
      throw new RepositoryConfigError("config file changed before opening");
    }
    text = await handle.readFile("utf8");
    let pathAfter: Stats;
    let directoryAfter: Stats;
    try {
      [pathAfter, directoryAfter] = await Promise.all([
        lstat(path),
        lstat(directoryPath),
      ]);
    } catch (error) {
      throw ioFailure("config path cannot be verified", error);
    }
    assertConfigFile(pathAfter);
    assertConfigDirectory(directoryAfter);
    if (!sameIdentity(openedFile, pathAfter)) {
      throw new RepositoryConfigError("config file changed during read");
    }
    if (!sameIdentity(directoryBefore, directoryAfter)) {
      throw new RepositoryConfigError(".ccprof changed during read");
    }
  } catch (error) {
    if (error instanceof RepositoryConfigError) throw error;
    throw ioFailure("cannot be read", error);
  } finally {
    try {
      await handle.close();
    } catch (error) {
      throw ioFailure("cannot be closed", error);
    }
  }
  return parseConfig(text);
}

export async function loadRepositoryConfig(repoRoot: string): Promise<TestMap> {
  return (await loadRepositoryConfigDocument(repoRoot)).testMap;
}

export async function loadRepositoryPolicyPreferences(
  repoRoot: string,
): Promise<RepositoryPolicyPreferences> {
  const policy = (await loadRepositoryConfigDocument(repoRoot)).policy;
  return { ...policy };
}
