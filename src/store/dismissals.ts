import { readFile } from "node:fs/promises";

import type { Finding } from "../core/model.js";
import {
  type StoreWarning,
  writeJsonAtomically,
} from "./analyses.js";
import type { StorePaths } from "./paths.js";

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

export async function loadDismissals(
  paths: StorePaths,
): Promise<DismissalLoadResult> {
  try {
    const value = JSON.parse(
      await readFile(paths.dismissals_path, "utf8"),
    ) as unknown;
    if (!isDismissalFile(value)) {
      throw new TypeError("unsupported or invalid dismissal file");
    }
    const latestByKey = new Map<string, DismissalRecord>();
    for (const record of [...value.records].sort(recordOrder)) {
      const existing = latestByKey.get(record.finding_key);
      if (
        existing === undefined ||
        record.dismissed_at_ms >= existing.dismissed_at_ms
      ) {
        latestByKey.set(record.finding_key, record);
      }
    }
    return {
      records: [...latestByKey.values()].sort(recordOrder),
      warnings: [],
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { records: [], warnings: [] };
    }
    return {
      records: [],
      warnings: [{
        code: "corrupt_dismissals",
        message: `Dismissal history was skipped: ${errorMessage(error)}`,
        path: paths.dismissals_path,
      }],
    };
  }
}

export async function saveDismissal(
  paths: StorePaths,
  input: DismissalInput,
): Promise<DismissalSaveResult> {
  const record = asRecord(input);
  const loaded = await loadDismissals(paths);
  const warnings = [...loaded.warnings];
  const records = loaded.records
    .filter(({ finding_key }) => finding_key !== record.finding_key);
  records.push(record);
  records.sort(recordOrder);
  try {
    await writeJsonAtomically(paths.dismissals_path, {
      schema_version: 1,
      records,
    } satisfies DismissalFile);
  } catch (error) {
    warnings.push({
      code: "dismissal_write_failed",
      message: `Dismissal could not be persisted: ${errorMessage(error)}`,
      path: paths.dismissals_path,
    });
  }
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
