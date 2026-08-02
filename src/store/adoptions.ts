import { readFile } from "node:fs/promises";

import type { RuleId, Scope } from "../core/model.js";
import {
  type StoreWarning,
  writeJsonAtomically,
} from "./analyses.js";
import type { StorePaths } from "./paths.js";

export type AdoptionMethod = "claude_md_edit" | "target_file_edit";

export interface AdoptionRecord {
  finding_key: string;
  rule_id: RuleId;
  scope: Scope;
  fingerprint: string;
  method: AdoptionMethod;
  detected_at_ms: number;
  evidence: { commit: string; path: string };
}

export interface AdoptionLoadResult {
  records: AdoptionRecord[];
  warnings: StoreWarning[];
}

interface AdoptionFile {
  schema_version: 1;
  adoptions: AdoptionRecord[];
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
const SCOPES = new Set(["this_pr", "separate_issue", "claude_md"]);
const METHODS = new Set(["claude_md_edit", "target_file_edit"]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAdoptionRecord(value: unknown): value is AdoptionRecord {
  if (!isObjectRecord(value)) return false;
  const evidence = value.evidence;
  return (
    typeof value.finding_key === "string" &&
    value.finding_key !== "" &&
    typeof value.rule_id === "string" &&
    RULE_IDS.has(value.rule_id) &&
    typeof value.scope === "string" &&
    SCOPES.has(value.scope) &&
    typeof value.fingerprint === "string" &&
    value.fingerprint !== "" &&
    typeof value.method === "string" &&
    METHODS.has(value.method) &&
    Number.isSafeInteger(value.detected_at_ms) &&
    (value.detected_at_ms as number) >= 0 &&
    isObjectRecord(evidence) &&
    typeof evidence.commit === "string" &&
    evidence.commit !== "" &&
    typeof evidence.path === "string" &&
    evidence.path !== ""
  );
}

function isAdoptionFile(value: unknown): value is AdoptionFile {
  if (!isObjectRecord(value)) return false;
  const file = value as Partial<AdoptionFile>;
  return file.schema_version === 1 &&
    Array.isArray(file.adoptions) &&
    file.adoptions.every(isAdoptionRecord);
}

function dedupeByFindingKey(
  records: readonly AdoptionRecord[],
): AdoptionRecord[] {
  const byKey = new Map<string, AdoptionRecord>();
  for (const record of records) {
    if (!byKey.has(record.finding_key)) {
      byKey.set(record.finding_key, record);
    }
  }
  return [...byKey.values()]
    .sort((left, right) => left.finding_key.localeCompare(right.finding_key));
}

export async function loadAdoptions(
  paths: StorePaths,
): Promise<AdoptionLoadResult> {
  try {
    const value = JSON.parse(
      await readFile(paths.adoptions_path, "utf8"),
    ) as unknown;
    if (!isAdoptionFile(value)) {
      throw new TypeError("unsupported or invalid adoption file");
    }
    return { records: dedupeByFindingKey(value.adoptions), warnings: [] };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { records: [], warnings: [] };
    }
    return {
      records: [],
      warnings: [{
        code: "corrupt_adoptions",
        message: `Adoption history was skipped: ${errorMessage(error)}`,
        path: paths.adoptions_path,
      }],
    };
  }
}

export async function saveAdoptions(
  paths: StorePaths,
  records: readonly AdoptionRecord[],
): Promise<StoreWarning[]> {
  const deduped = dedupeByFindingKey(records);
  try {
    await writeJsonAtomically(paths.adoptions_path, {
      schema_version: 1,
      adoptions: deduped,
    } satisfies AdoptionFile);
    return [];
  } catch (error) {
    return [{
      code: "adoption_write_failed",
      message: `Adoptions could not be persisted: ${errorMessage(error)}`,
      path: paths.adoptions_path,
    }];
  }
}
