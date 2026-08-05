import type { AdoptionMethod } from "../analysis/adoption-identity.js";
import {
  normalizeAdoptionMethodIdentity,
  normalizeFindingScopeIdentity,
  projectLegacyAdoptionMethod,
  projectLegacyFindingScope,
  type LegacyAdoptionMethod,
  type LegacyFindingScope,
} from "../compat/instruction-resource.js";
import type { FindingScope } from "../core/finding-scope.js";
import type { RuleId } from "../core/model.js";
import type { StoreWarning } from "./analyses.js";
import { canonicalJson, readLegacyJson } from "./legacy-json.js";
import type { StorePaths } from "./paths.js";
import { openStoreDatabase, storeDatabasePath } from "./sqlite.js";

export type { AdoptionMethod } from "../analysis/adoption-identity.js";

export interface AdoptionRecord {
  finding_key: string;
  rule_id: RuleId;
  scope: FindingScope;
  fingerprint: string;
  method: AdoptionMethod;
  detected_at_ms: number;
  evidence: { commit: string; path: string };
}

export interface AdoptionLoadResult {
  records: AdoptionRecord[];
  warnings: StoreWarning[];
}

interface LegacyAdoptionRecord {
  finding_key: string;
  rule_id: RuleId;
  scope: LegacyFindingScope;
  fingerprint: string;
  method: LegacyAdoptionMethod;
  detected_at_ms: number;
  evidence: { commit: string; path: string };
}

interface LegacyAdoptionFile {
  schema_version: 1;
  adoptions: LegacyAdoptionRecord[];
}

const RULE_IDS = new Set([
  "R001",
  "R002",
  "R003",
  "R004",
  "R005",
  "R006",
  "R007",
  "R008",
]);
const LEGACY_SCOPES = new Set(["this_pr", "separate_issue", "claude_md"]);
const LEGACY_METHODS = new Set(["claude_md_edit", "target_file_edit"]);
const ADOPTION_RECORD_KEYS = [
  "detected_at_ms",
  "evidence",
  "finding_key",
  "fingerprint",
  "method",
  "rule_id",
  "scope",
] as const;
const ADOPTION_EVIDENCE_KEYS = ["commit", "path"] as const;
const ADOPTION_FILE_KEYS = ["adoptions", "schema_version"] as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every((key) => expected.includes(key));
}

function isLegacyAdoptionRecord(value: unknown): value is LegacyAdoptionRecord {
  if (!isObjectRecord(value)) return false;
  const evidence = value.evidence;
  return (
    hasExactKeys(value, ADOPTION_RECORD_KEYS) &&
    typeof value.finding_key === "string" &&
    value.finding_key !== "" &&
    typeof value.rule_id === "string" &&
    RULE_IDS.has(value.rule_id) &&
    typeof value.scope === "string" &&
    LEGACY_SCOPES.has(value.scope) &&
    typeof value.fingerprint === "string" &&
    value.fingerprint !== "" &&
    typeof value.method === "string" &&
    LEGACY_METHODS.has(value.method) &&
    Number.isSafeInteger(value.detected_at_ms) &&
    (value.detected_at_ms as number) >= 0 &&
    isObjectRecord(evidence) &&
    hasExactKeys(evidence, ADOPTION_EVIDENCE_KEYS) &&
    typeof evidence.commit === "string" &&
    evidence.commit !== "" &&
    typeof evidence.path === "string" &&
    evidence.path !== ""
  );
}

function isLegacyAdoptionFile(value: unknown): value is LegacyAdoptionFile {
  if (!isObjectRecord(value)) return false;
  const file = value as Partial<LegacyAdoptionFile>;
  return hasExactKeys(value, ADOPTION_FILE_KEYS) &&
    file.schema_version === 1 &&
    Array.isArray(file.adoptions) &&
    file.adoptions.every(isLegacyAdoptionRecord);
}

function dedupeByFindingKey<T extends { finding_key: string }>(
  records: readonly T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const record of records) {
    if (!byKey.has(record.finding_key)) {
      byKey.set(record.finding_key, record);
    }
  }
  return [...byKey.values()]
    .sort((left, right) => left.finding_key.localeCompare(right.finding_key));
}

type StoreDatabase = ReturnType<typeof openStoreDatabase>;
type AdoptionRow = { finding_key: string; detected_at_ms: number; record_json: string };
const LEGACY_ADOPTIONS_MIGRATION = "legacy-adoptions-json-v1";

function closeDatabase(database: StoreDatabase | undefined): void {
  try { database?.close(); } catch { /* Preserve the operation result. */ }
}

function storeWarning(code: string, message: string, path: string): StoreWarning {
  return { code, message, path };
}

interface LegacyAdoptionScanResult {
  records: LegacyAdoptionRecord[];
  warnings: StoreWarning[];
}

function scanLegacyAdoptions(paths: StorePaths): LegacyAdoptionScanResult {
  const read = readLegacyJson(paths.adoptions_path);
  if (read.kind === "missing") return { records: [], warnings: [] };
  if (read.kind === "corrupt" || !isLegacyAdoptionFile(read.value)) {
    const message = read.kind === "corrupt"
      ? read.message : "unsupported or invalid adoption file";
    return { records: [], warnings: [storeWarning("corrupt_adoptions",
      `Adoption history was skipped: ${message}`, paths.adoptions_path)] };
  }
  return { records: dedupeByFindingKey(read.value.adoptions), warnings: [] };
}

function migrationComplete(database: StoreDatabase): boolean {
  return database.prepare("SELECT 1 FROM store_migrations WHERE name = ?")
    .get(LEGACY_ADOPTIONS_MIGRATION) !== undefined;
}

function migrateLegacyAdoptions(
  database: StoreDatabase,
  paths: StorePaths,
): StoreWarning[] {
  if (migrationComplete(database)) return [];
  const scanned = scanLegacyAdoptions(paths);
  return database.transaction(() => {
    if (migrationComplete(database)) return [];
    const insert = database.prepare(`INSERT INTO adoptions
      (finding_key, detected_at_ms, record_json) VALUES (?, ?, ?)
      ON CONFLICT(finding_key) DO NOTHING`);
    for (const record of scanned.records) {
      insert.run(record.finding_key, record.detected_at_ms, canonicalJson(record));
    }
    database.prepare("INSERT INTO store_migrations(name, completed_at_ms) VALUES (?, ?)")
      .run(LEGACY_ADOPTIONS_MIGRATION, Date.now());
    return scanned.warnings;
  }).immediate();
}

function normalizeLegacyAdoptionRecord(
  record: LegacyAdoptionRecord,
): AdoptionRecord {
  return {
    finding_key: record.finding_key,
    rule_id: record.rule_id,
    scope: normalizeFindingScopeIdentity(record.scope),
    fingerprint: record.fingerprint,
    method: normalizeAdoptionMethodIdentity(record.method),
    detected_at_ms: record.detected_at_ms,
    evidence: { ...record.evidence },
  };
}

function parseAdoptionRow(row: AdoptionRow): AdoptionRecord {
  const value = JSON.parse(row.record_json) as unknown;
  if (!isLegacyAdoptionRecord(value)) {
    throw new TypeError("unsupported, non-canonical, or mismatched adoption record");
  }
  if (canonicalJson(value) !== row.record_json) {
    throw new TypeError("unsupported, non-canonical, or mismatched adoption record");
  }
  if (value.finding_key !== row.finding_key ||
    value.detected_at_ms !== row.detected_at_ms) {
    throw new TypeError("unsupported, non-canonical, or mismatched adoption record");
  }
  return normalizeLegacyAdoptionRecord(value);
}

function projectLegacyAdoptionRecord(
  record: AdoptionRecord,
): LegacyAdoptionRecord {
  try {
    const projected: LegacyAdoptionRecord = {
      finding_key: record.finding_key,
      rule_id: record.rule_id,
      scope: projectLegacyFindingScope(record.scope),
      fingerprint: record.fingerprint,
      method: projectLegacyAdoptionMethod(record.method),
      detected_at_ms: record.detected_at_ms,
      evidence: {
        commit: record.evidence.commit,
        path: record.evidence.path,
      },
    };
    if (!isLegacyAdoptionRecord(projected)) {
      throw new TypeError("invalid adoption record");
    }
    return projected;
  } catch {
    throw new TypeError("invalid adoption record");
  }
}

export async function loadAdoptions(
  paths: StorePaths,
): Promise<AdoptionLoadResult> {
  const warnings: StoreWarning[] = [];
  let database: StoreDatabase | undefined;
  try {
    database = openStoreDatabase(paths);
    try { warnings.push(...migrateLegacyAdoptions(database, paths)); }
    catch (error) {
      warnings.push(storeWarning("corrupt_adoptions",
        `Adoption history could not be migrated: ${errorMessage(error)}`,
        paths.adoptions_path));
    }
    const rows = database.prepare(`SELECT finding_key, detected_at_ms, record_json
      FROM adoptions ORDER BY finding_key`).all() as AdoptionRow[];
    const records: AdoptionRecord[] = [];
    for (const row of rows) {
      try { records.push(parseAdoptionRow(row)); }
      catch (error) {
        warnings.push(storeWarning("corrupt_adoptions",
          `Adoption record was skipped: ${errorMessage(error)}`,
          `${storeDatabasePath(paths)}#adoptions/${row.finding_key}`));
      }
    }
    return { records: dedupeByFindingKey(records), warnings };
  } catch (error) {
    return { records: [], warnings: [...warnings, storeWarning("corrupt_adoptions",
      `Adoption history could not be read: ${errorMessage(error)}`,
      storeDatabasePath(paths))] };
  } finally { closeDatabase(database); }
}

export async function saveAdoptions(
  paths: StorePaths,
  records: readonly AdoptionRecord[],
): Promise<StoreWarning[]> {
  if (records.length === 0) return [];
  const warnings: StoreWarning[] = [];
  const targetPath = storeDatabasePath(paths);
  let database: StoreDatabase | undefined;
  try {
    const projected = records.map(projectLegacyAdoptionRecord);
    const deduped = dedupeByFindingKey(projected);
    database = openStoreDatabase(paths);
    const store = database;
    warnings.push(...migrateLegacyAdoptions(store, paths));
    store.transaction(() => {
      const insert = store.prepare(`INSERT INTO adoptions
        (finding_key, detected_at_ms, record_json) VALUES (?, ?, ?)
        ON CONFLICT(finding_key) DO NOTHING`);
      for (const record of deduped) {
        insert.run(record.finding_key, record.detected_at_ms, canonicalJson(record));
      }
    }).immediate();
  } catch (error) {
    warnings.push(storeWarning("adoption_write_failed",
      `Adoptions could not be persisted: ${errorMessage(error)}`, targetPath));
  } finally { closeDatabase(database); }
  return warnings;
}
