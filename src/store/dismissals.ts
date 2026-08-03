import type { Finding } from "../core/model.js";
import type { StoreWarning } from "./analyses.js";
import { canonicalJson, readLegacyJson } from "./legacy-json.js";
import type { StorePaths } from "./paths.js";
import { openStoreDatabase, storeDatabasePath } from "./sqlite.js";

export const DISMISSAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;

export interface DismissalInput {
  finding_key: string;
  target: string;
  dismissed_at_ms: number;
  strength_min: number;
  reason?: string;
}

export interface DismissalRecord {
  schema_version: 1;
  finding_key: string;
  target: string;
  dismissed_at_ms: number;
  strength_min: number;
  reason?: string;
}

export interface DismissalLoadResult {
  records: DismissalRecord[];
  warnings: StoreWarning[];
}

export interface DismissalSaveResult {
  record: DismissalRecord;
  warnings: StoreWarning[];
}

export interface DismissalDecision {
  suppressed: boolean;
  revived: boolean;
  caveat?: string;
}

export interface AppliedDismissals {
  findings: Finding[];
  suppressed_keys: string[];
}

interface DismissalFile {
  schema_version: 1;
  records: DismissalRecord[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is DismissalRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<DismissalRecord>;
  return record.schema_version === 1 &&
    typeof record.finding_key === "string" &&
    record.finding_key !== "" &&
    typeof record.target === "string" &&
    record.target !== "" &&
    Number.isSafeInteger(record.dismissed_at_ms) &&
    (record.dismissed_at_ms ?? -1) >= 0 &&
    typeof record.strength_min === "number" &&
    Number.isFinite(record.strength_min) &&
    record.strength_min >= 0 &&
    (record.reason === undefined || typeof record.reason === "string");
}

function isDismissalFile(value: unknown): value is DismissalFile {
  if (value === null || typeof value !== "object") return false;
  const file = value as Partial<DismissalFile>;
  return file.schema_version === 1 &&
    Array.isArray(file.records) &&
    file.records.every(isRecord);
}

function recordOrder(
  left: DismissalRecord,
  right: DismissalRecord,
): number {
  return left.finding_key.localeCompare(right.finding_key) ||
    left.dismissed_at_ms - right.dismissed_at_ms ||
    left.target.localeCompare(right.target);
}

function asRecord(input: DismissalInput): DismissalRecord {
  const key = input.finding_key.trim();
  const target = input.target.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (key === "" || target === "") {
    throw new TypeError("dismissal key and target must be non-empty");
  }
  if (
    !Number.isSafeInteger(input.dismissed_at_ms) ||
    input.dismissed_at_ms < 0
  ) {
    throw new TypeError("dismissal time must be a nonnegative safe integer");
  }
  if (!Number.isFinite(input.strength_min) || input.strength_min < 0) {
    throw new TypeError("dismissal strength must be a finite nonnegative number");
  }
  const reason = input.reason?.trim();
  return {
    schema_version: 1,
    finding_key: key,
    target,
    dismissed_at_ms: input.dismissed_at_ms,
    strength_min: input.strength_min,
    ...(reason === undefined || reason === "" ? {} : { reason }),
  };
}

type StoreDatabase = ReturnType<typeof openStoreDatabase>;
type DismissalRow = { finding_key: string; dismissed_at_ms: number; record_json: string };
const LEGACY_DISMISSALS_MIGRATION = "legacy-dismissals-json-v1";

function closeDatabase(database: StoreDatabase | undefined): void {
  try { database?.close(); } catch { /* Preserve the operation result. */ }
}

function storeWarning(code: string, message: string, path: string): StoreWarning {
  return { code, message, path };
}

function dedupeLegacy(records: readonly DismissalRecord[]): DismissalRecord[] {
  const latestByKey = new Map<string, DismissalRecord>();
  for (const record of [...records].sort(recordOrder)) {
    const existing = latestByKey.get(record.finding_key);
    if (existing === undefined || record.dismissed_at_ms >= existing.dismissed_at_ms) {
      latestByKey.set(record.finding_key, record);
    }
  }
  return [...latestByKey.values()].sort(recordOrder);
}

function scanLegacyDismissals(paths: StorePaths): DismissalLoadResult {
  const read = readLegacyJson(paths.dismissals_path);
  if (read.kind === "missing") return { records: [], warnings: [] };
  if (read.kind === "corrupt" || !isDismissalFile(read.value)) {
    const message = read.kind === "corrupt"
      ? read.message : "unsupported or invalid dismissal file";
    return { records: [], warnings: [storeWarning("corrupt_dismissals",
      `Dismissal history was skipped: ${message}`, paths.dismissals_path)] };
  }
  return { records: dedupeLegacy(read.value.records), warnings: [] };
}

function migrationComplete(database: StoreDatabase): boolean {
  return database.prepare("SELECT 1 FROM store_migrations WHERE name = ?")
    .get(LEGACY_DISMISSALS_MIGRATION) !== undefined;
}

function migrateLegacyDismissals(
  database: StoreDatabase,
  paths: StorePaths,
): StoreWarning[] {
  if (migrationComplete(database)) return [];
  const scanned = scanLegacyDismissals(paths);
  return database.transaction(() => {
    if (migrationComplete(database)) return [];
    const insert = database.prepare(`INSERT INTO dismissals
      (finding_key, dismissed_at_ms, record_json) VALUES (?, ?, ?)
      ON CONFLICT(finding_key) DO NOTHING`);
    for (const record of scanned.records) {
      insert.run(record.finding_key, record.dismissed_at_ms, canonicalJson(record));
    }
    database.prepare("INSERT INTO store_migrations(name, completed_at_ms) VALUES (?, ?)")
      .run(LEGACY_DISMISSALS_MIGRATION, Date.now());
    return scanned.warnings;
  }).immediate();
}

function parseDismissalRow(row: DismissalRow): DismissalRecord {
  const value = JSON.parse(row.record_json) as unknown;
  if (!isRecord(value) || canonicalJson(value) !== row.record_json ||
    value.finding_key !== row.finding_key || value.dismissed_at_ms !== row.dismissed_at_ms) {
    throw new TypeError("unsupported, non-canonical, or mismatched dismissal record");
  }
  return value;
}

export async function loadDismissals(
  paths: StorePaths,
): Promise<DismissalLoadResult> {
  const warnings: StoreWarning[] = [];
  let database: StoreDatabase | undefined;
  try {
    database = openStoreDatabase(paths);
    try { warnings.push(...migrateLegacyDismissals(database, paths)); }
    catch (error) {
      warnings.push(storeWarning("corrupt_dismissals",
        `Dismissal history could not be migrated: ${errorMessage(error)}`,
        paths.dismissals_path));
    }
    const rows = database.prepare(`SELECT finding_key, dismissed_at_ms, record_json
      FROM dismissals ORDER BY finding_key`).all() as DismissalRow[];
    const records: DismissalRecord[] = [];
    for (const row of rows) {
      try { records.push(parseDismissalRow(row)); }
      catch (error) {
        warnings.push(storeWarning("corrupt_dismissals",
          `Dismissal record was skipped: ${errorMessage(error)}`,
          `${storeDatabasePath(paths)}#dismissals/${row.finding_key}`));
      }
    }
    return { records: records.sort(recordOrder), warnings };
  } catch (error) {
    return { records: [], warnings: [...warnings, storeWarning("corrupt_dismissals",
      `Dismissal history could not be read: ${errorMessage(error)}`,
      storeDatabasePath(paths))] };
  } finally { closeDatabase(database); }
}

export async function saveDismissal(
  paths: StorePaths,
  input: DismissalInput,
): Promise<DismissalSaveResult> {
  const record = asRecord(input);
  const warnings: StoreWarning[] = [];
  const targetPath = storeDatabasePath(paths);
  let database: StoreDatabase | undefined;
  try {
    database = openStoreDatabase(paths);
    const store = database;
    warnings.push(...migrateLegacyDismissals(store, paths));
    store.transaction(() => store.prepare(`INSERT INTO dismissals
      (finding_key, dismissed_at_ms, record_json) VALUES (?, ?, ?)
      ON CONFLICT(finding_key) DO UPDATE SET
        dismissed_at_ms = excluded.dismissed_at_ms,
        record_json = excluded.record_json`).run(record.finding_key,
          record.dismissed_at_ms, canonicalJson(record))).immediate();
  } catch (error) {
    warnings.push(storeWarning("dismissal_write_failed",
      `Dismissal could not be persisted: ${errorMessage(error)}`, targetPath));
  } finally { closeDatabase(database); }
  return { record, warnings };
}

export function dismissalDecision(
  dismissal: DismissalRecord,
  currentStrengthMin: number,
  nowMs: number,
): DismissalDecision {
  if (!Number.isFinite(currentStrengthMin) || currentStrengthMin < 0) {
    throw new TypeError("current dismissal strength must be finite and nonnegative");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("dismissal comparison time must be a nonnegative safe integer");
  }
  const ageMs = nowMs - dismissal.dismissed_at_ms;
  if (ageMs >= DISMISSAL_WINDOW_MS) {
    return { suppressed: false, revived: false };
  }
  if (currentStrengthMin > dismissal.strength_min * 2) {
    const reason = dismissal.reason === undefined
      ? ""
      : ` Reason: ${dismissal.reason}`;
    return {
      suppressed: false,
      revived: true,
      caveat:
        `Previously dismissed at ${dismissal.strength_min} min; the estimate is now strictly over 2×.${reason}`,
    };
  }
  return { suppressed: true, revived: false };
}

export function applyDismissals(
  findings: readonly Finding[],
  dismissals: readonly DismissalRecord[],
  nowMs: number,
): AppliedDismissals {
  const latestByKey = new Map<string, DismissalRecord>();
  for (const dismissal of dismissals) {
    const existing = latestByKey.get(dismissal.finding_key);
    if (
      existing === undefined ||
      dismissal.dismissed_at_ms >= existing.dismissed_at_ms
    ) {
      latestByKey.set(dismissal.finding_key, dismissal);
    }
  }

  const kept: Finding[] = [];
  const suppressed: string[] = [];
  for (const finding of findings) {
    const dismissal = latestByKey.get(finding.finding_key);
    if (dismissal === undefined) {
      kept.push(finding);
      continue;
    }
    const decision = dismissalDecision(
      dismissal,
      finding.recoverable.min,
      nowMs,
    );
    if (decision.suppressed) {
      suppressed.push(finding.finding_key);
      continue;
    }
    kept.push(
      decision.caveat === undefined
        ? finding
        : {
            ...finding,
            caveats: [...new Set([...finding.caveats, decision.caveat])]
              .sort((left, right) => left.localeCompare(right)),
          },
    );
  }
  return {
    findings: kept,
    suppressed_keys: [...new Set(suppressed)]
      .sort((left, right) => left.localeCompare(right)),
  };
}
