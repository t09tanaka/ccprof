import Database from "better-sqlite3";
import type { Stats } from "node:fs";
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRepositoryConfig, loadRepositoryPolicyPreferences } from
  "../analysis/repository-config.js";
import { loadConfiguredOrganizationPolicy, resolveEffectivePolicy } from
  "../policy/organization-policy.js";
import { CLAUDE_SESSION_SOURCE_CONTRACT, CODEX_SESSION_SOURCE_CONTRACT } from
  "../sources/session-source.js";
import { resolveStorePaths } from "../store/paths.js";
import { ANALYSIS_BUDGETS_MIGRATION, INCREMENTAL_SOURCES_MIGRATION,
  SOURCE_CATALOG_MIGRATION, STORE_SCHEMA_VERSION, storeDatabasePath } from
  "../store/sqlite.js";

export type DoctorStatus = "pass" | "warn" | "fail";
export type DoctorCheckId = "configuration" | "organization_policy" |
  "source_capabilities" | "parser_budgets" | "store_schema" |
  "store_migrations" | "store_open" | "encryption";

export interface DoctorCheck { id: DoctorCheckId; status: DoctorStatus;
  code: string; message: string; }
export interface DoctorReport {
  schema_version: 1; command: "doctor"; status: DoctorStatus;
  checks: DoctorCheck[]; }
export interface DoctorOptions { cwd: string; json: boolean;
  env?: NodeJS.ProcessEnv; }
interface StoreChecks { schema: DoctorCheck; migrations: DoctorCheck;
  open: DoctorCheck; }

const SUPPORTED_OLD_SCHEMAS = new Set([0, 2, 3, 4]);
const REQUIRED_MIGRATIONS = [SOURCE_CATALOG_MIGRATION,
  ANALYSIS_BUDGETS_MIGRATION, INCREMENTAL_SOURCES_MIGRATION] as const;

function check(id: DoctorCheckId, status: DoctorStatus, code: string,
  message: string): DoctorCheck {
  return { id, status, code, message };
}

function missingStore(): StoreChecks { return {
    schema: check("store_schema", "warn", "store_not_initialized",
      "Store is not initialized."),
    migrations: check("store_migrations", "warn", "store_not_initialized",
      "Store is not initialized."),
    open: check("store_open", "pass", "store_open_not_required",
      "No Store database is present to open."),
  }; }

function failedStore(): StoreChecks { return {
    schema: check("store_schema", "fail", "store_unavailable",
      "Store could not be inspected safely."),
    migrations: check("store_migrations", "fail", "store_unavailable",
      "Store could not be inspected safely."),
    open: check("store_open", "fail", "store_unavailable",
      "Store could not be inspected safely."),
  }; }

async function pathStatus(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function copyStore(path: string):
Promise<{ directory: string; databasePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ccprof-doctor-"));
  const databasePath = join(directory, "store.sqlite3");
  try {
    await copyFile(path, databasePath);
    const walPath = `${path}-wal`;
    const before = await pathStatus(walPath);
    if (before !== undefined) {
      if (before.isSymbolicLink() || !before.isFile()) throw new Error();
      await copyFile(walPath, `${databasePath}-wal`);
    }
    const after = await pathStatus(walPath);
    if (before === undefined ? after !== undefined :
      after === undefined || !sameFile(before, after)) throw new Error();
    return { directory, databasePath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function inspectStore(cwd: string, env: NodeJS.ProcessEnv):
Promise<StoreChecks> {
  const paths = await resolveStorePaths(cwd, { env });
  const repositoryStatus = await pathStatus(paths.repo_dir);
  if (repositoryStatus === undefined) return missingStore();
  if (repositoryStatus.isSymbolicLink() || !repositoryStatus.isDirectory())
    return failedStore();

  const databasePath = storeDatabasePath(paths);
  const databaseStatus = await pathStatus(databasePath);
  if (databaseStatus === undefined) return missingStore();
  if (databaseStatus.isSymbolicLink() || !databaseStatus.isFile())
    return failedStore();

  let database: Database.Database | undefined;
  let version: number | undefined;
  let markers: Set<string> | undefined;
  let healthy = false;
  let closeFailed = false;
  let stablePath = false;
  let temporaryDirectory: string | undefined;
  try {
    const copy = await copyStore(databasePath);
    temporaryDirectory = copy.directory;
    database = new Database(copy.databasePath,
      { readonly: true, fileMustExist: true });
    version = Number(database.pragma("user_version", { simple: true }));
    const quickCheck = database.pragma("quick_check(1)") as
      { quick_check?: unknown }[];
    healthy = quickCheck.length === 1 && quickCheck[0]?.quick_check === "ok";
    if (version === 0) markers = new Set();
    else {
      const rows = database.prepare(`
        SELECT name FROM store_migrations
        WHERE name IN (?, ?, ?)
      `).all(...REQUIRED_MIGRATIONS) as { name?: unknown }[];
      markers = new Set(rows.flatMap(({ name }) =>
        typeof name === "string" ? [name] : []));
    }
    const after = await lstat(databasePath);
    stablePath = !after.isSymbolicLink() && after.isFile() &&
      sameFile(databaseStatus, after);
  } catch {
    return failedStore();
  } finally {
    try { database?.close(); } catch { closeFailed = true; }
    if (temporaryDirectory !== undefined) {
      try { await rm(temporaryDirectory, { recursive: true, force: true }); }
      catch { closeFailed = true; }
    }
  }

  if (version === undefined || markers === undefined ||
    !Number.isSafeInteger(version) || version < 0 || !stablePath) {
    return failedStore();
  }

  const supportedOld = SUPPORTED_OLD_SCHEMAS.has(version);
  const schema = version === STORE_SCHEMA_VERSION
    ? check("store_schema", "pass", "store_schema_current",
        "Store schema is current.")
    : supportedOld
      ? check("store_schema", "warn", "store_migration_pending",
          "Store schema migration is pending.")
      : check("store_schema", "fail", "store_schema_unsupported",
          "Store schema is unsupported.");
  const migrations = version === STORE_SCHEMA_VERSION &&
    REQUIRED_MIGRATIONS.every((name) => markers.has(name))
    ? check("store_migrations", "pass", "store_migrations_current",
        "Store migrations are complete.")
    : supportedOld
      ? check("store_migrations", "warn", "store_migration_pending",
          "Store migrations are pending.")
      : check("store_migrations", "fail", "store_migrations_invalid",
          "Store migration state is invalid.");
  const open = healthy && !closeFailed
    ? check("store_open", "pass", "store_open_ok",
        "Store opened read-only and passed quick_check.")
    : check("store_open", "fail", "store_open_failed",
        "Store could not be inspected safely.");
  return { schema, migrations, open };
}

function sourceCapabilitiesCheck(): DoctorCheck {
  const contracts = [CLAUDE_SESSION_SOURCE_CONTRACT,
    CODEX_SESSION_SOURCE_CONTRACT].sort((left, right) =>
      left.adapter_id < right.adapter_id ? -1 :
        left.adapter_id > right.adapter_id ? 1 : 0);
  const summary = contracts.map((contract) =>
    `${contract.adapter_id}@${contract.adapter_version} ` +
    `(${contract.capabilities.join(", ")})`
  ).join("; ");
  return check("source_capabilities", "pass",
    "source_capabilities_available",
    `Built-in source capabilities: ${summary}.`,
  );
}

export async function runDoctorCommand(options: DoctorOptions): Promise<{
  stdout: string; warnings: readonly string[]; exitCode: number;
}> {
  const env = options.env ?? process.env;
  let configuration: DoctorCheck;
  try {
    await loadRepositoryConfig(options.cwd);
    configuration = check("configuration", "pass", "configuration_valid",
      "Repository configuration is valid.");
  } catch {
    configuration = check("configuration", "fail", "configuration_invalid",
      "Repository configuration is invalid.");
  }

  let organization: DoctorCheck;
  try {
    const repository = await loadRepositoryPolicyPreferences(options.cwd);
    const configured = await loadConfiguredOrganizationPolicy(env);
    resolveEffectivePolicy({
      ...(configured === undefined ? {} : { organization: configured }),
      repository,
      request: { privacy: "balanced", advisory: false },
    });
    organization = check("organization_policy", "pass",
      "organization_policy_valid",
      "Organization policy configuration is valid.");
  } catch {
    organization = check("organization_policy", "fail",
      "organization_policy_invalid",
      "Organization policy configuration is invalid.");
  }

  const store = await inspectStore(options.cwd, env).catch(failedStore);
  const checks: DoctorCheck[] = [
    configuration,
    organization,
    sourceCapabilitiesCheck(),
    check("parser_budgets", "warn", "parser_budgets_not_configured",
      "No operator-configured analysis budget profile is available."),
    store.schema,
    store.migrations,
    store.open,
    check("encryption", "warn", "encryption_not_supported",
      "Store encryption and key management are unavailable in this release."),
  ];
  const status = checks.some((item) => item.status === "fail") ? "fail"
    : checks.some((item) => item.status === "warn") ? "warn" : "pass";
  const report: DoctorReport = {
    schema_version: 1, command: "doctor", status, checks,
  };
  const stdout = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : [`ccprof doctor: ${status}`, ...checks.map((item) =>
        `[${item.status.toUpperCase()}] ${item.id}: ${item.message}`)]
      .join("\n") + "\n";
  return { stdout, warnings: [], exitCode: status === "fail" ? 1 : 0 };
}
