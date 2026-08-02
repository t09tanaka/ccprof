import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeCommand } from "../analysis/command.js";
import { commandIdentityKey } from "../analysis/command-identity.js";
import { normalizeRepoPath } from "../analysis/test-map.js";
import type {
  AnalysisSummary,
  AnalysisUnit,
  BaselineComparison,
  CommandIdentity,
  Confidence,
  Finding,
} from "../core/model.js";
import type { StorePaths } from "./paths.js";

export interface StoreWarning {
  code: string;
  message: string;
  path: string;
}

export interface StoredCommandCost {
  command: string;
  command_identity?: CommandIdentity;
  duration_min: number;
  session_refs: string[];
}

export interface StoredReadObservation {
  path: string;
  object_id: string;
  duration_min: number;
  session_refs: string[];
  confidence?: Confidence;
}
export interface AnalysisRecordInput {
  analysis_id?: string;
  created_at_ms: number;
  unit: AnalysisUnit;
  summary: AnalysisSummary;
  findings: readonly Finding[];
  metrics?: Readonly<Record<string, number>>;
  command_costs?: readonly StoredCommandCost[];
  read_observations?: readonly StoredReadObservation[];
}

export interface AnalysisRecord {
  schema_version: 1;
  analysis_id: string;
  created_at_ms: number;
  unit: AnalysisUnit;
  summary: AnalysisSummary;
  findings: Finding[];
  metrics: Record<string, number>;
  command_costs: StoredCommandCost[];
  read_observations?: StoredReadObservation[];
}

export interface AnalysisSaveResult {
  record: AnalysisRecord;
  warnings: StoreWarning[];
}

export interface AnalysisHistoryResult {
  records: AnalysisRecord[];
  warnings: StoreWarning[];
}

interface HistoryEntry {
  analysis_id: string;
  created_at_ms: number;
  file: string;
}

interface HistoryIndex {
  schema_version: 1;
  analyses: HistoryEntry[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJsonValue(entry)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(stableJsonValue(value), null, 2)}\n`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))]
    .sort((left, right) => left.localeCompare(right));
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string");
}

function normalizeCommandIdentity(value: unknown): CommandIdentity {
  if (!isObjectRecord(value)) throw new TypeError("command identity must be an object");
  const cwd = value.repo_relative_cwd;
  if (
    typeof cwd !== "string" ||
    (cwd !== "." && (cwd === "" || cwd.includes("\0") ||
      cwd.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(cwd) ||
      cwd.split("/").some((segment) =>
        segment === "" || segment === "." || segment === "..")))
  ) {
    throw new TypeError("command identity cwd must be normalized and repository-relative");
  }
  const argv = value.normalized_argv;
  if (!isStringArray(argv) || argv.length === 0 || argv[0] === "") {
    throw new TypeError("command identity argv must have a non-empty executable");
  }
  const executor = value.executor;
  if (executor !== "shell" && executor !== "native-tool") {
    throw new TypeError("command identity executor is invalid");
  }
  return { repo_relative_cwd: cwd, normalized_argv: [...argv], executor };
}

function isCommandIdentity(value: unknown): boolean {
  try { normalizeCommandIdentity(value); return true; } catch { return false; }
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
const CLASSIFICATIONS = new Set(["repo", "config", "behavior"]);
const SCOPES = new Set(["this_pr", "separate_issue", "claude_md"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);
const BOUNDS = new Set(["point", "upper"]);
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isStoredFinding(value: unknown): value is Finding {
  if (!isObjectRecord(value)) return false;
  const recoverable = value.recoverable;
  const evidence = value.evidence;
  const fixRecipe = value.fix_recipe;
  return (
    typeof value.finding_key === "string" &&
    value.finding_key !== "" &&
    typeof value.rule_id === "string" &&
    RULE_IDS.has(value.rule_id) &&
    typeof value.title === "string" &&
    typeof value.classification === "string" &&
    CLASSIFICATIONS.has(value.classification) &&
    typeof value.scope === "string" &&
    SCOPES.has(value.scope) &&
    typeof value.confidence === "string" &&
    CONFIDENCES.has(value.confidence) &&
    (
      value.target === undefined ||
      (typeof value.target === "string" && value.target !== "")
    ) &&
    isObjectRecord(recoverable) &&
    finiteNonnegative(recoverable.min) &&
    typeof recoverable.bound === "string" &&
    BOUNDS.has(recoverable.bound) &&
    isObjectRecord(evidence) &&
    isStringArray(evidence.session_refs) &&
    isStringArray(evidence.interval_ids) &&
    (
      evidence.command === undefined ||
      typeof evidence.command === "string"
    ) &&
    isObjectRecord(fixRecipe) &&
    typeof fixRecipe.suggestion === "string" &&
    fixRecipe.suggestion !== "" &&
    typeof fixRecipe.verify === "string" &&
    fixRecipe.verify !== "" &&
    isStringArray(value.caveats)
  );
}

function summaryMetrics(summary: AnalysisSummary): Record<string, number> {
  const rawObserved = summary.measured_min + summary.idle_excluded_min;
  return {
    measured_min: summary.measured_min,
    idle_excluded_min: summary.idle_excluded_min,
    estimated_floor_min: summary.estimated_floor_min,
    recoverable_min: summary.recoverable_min,
    human_wait_min: summary.human_wait_min ?? 0,
    unexplained_min: summary.unexplained_min,
    recoverable_ratio:
      summary.measured_min > 0
        ? summary.recoverable_min / summary.measured_min
        : 0,
    idle_ratio:
      rawObserved > 0 ? summary.idle_excluded_min / rawObserved : 0,
  };
}

function findingCommandCosts(
  findings: readonly Finding[],
): StoredCommandCost[] {
  return findings.flatMap((finding) => {
    const rawIdentity = finding.evidence.command_identity;
    const identity = rawIdentity === undefined
      ? undefined
      : normalizeCommandIdentity(rawIdentity);
    const command = finding.evidence.command;
    if (typeof command !== "string") return [];
    const durationMs = finding.evidence.duration_ms;
    const durationMin = finiteNonnegative(durationMs)
      ? durationMs / 60_000
      : finding.recoverable.min;
    if (!finiteNonnegative(durationMin) || durationMin <= 0) return [];
    return [{
      command,
      ...(identity === undefined ? {} : { command_identity: identity }),
      duration_min: durationMin,
      session_refs: [...finding.evidence.session_refs],
    }];
  });
}

function normalizedCommandCosts(
  costs: readonly StoredCommandCost[],
): StoredCommandCost[] {
  const byKey = new Map<string, StoredCommandCost & { durations: number[] }>();
  for (const cost of costs) {
    const identity = cost.command_identity === undefined
      ? undefined
      : normalizeCommandIdentity(cost.command_identity);
    if (!finiteNonnegative(cost.duration_min) || cost.duration_min <= 0) {
      continue;
    }
    const command = normalizeCommand(cost.command);
    if (command === null) continue;
    const key = identity === undefined
      ? `legacy\0${command}`
      : `identity\0${commandIdentityKey(identity)}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        command,
        ...(identity === undefined ? {} : { command_identity: identity }),
        duration_min: 0,
        durations: [cost.duration_min],
        session_refs: sortedUnique(cost.session_refs),
      });
    } else {
      if (command < existing.command) existing.command = command;
      existing.durations.push(cost.duration_min);
      existing.session_refs = sortedUnique([
        ...existing.session_refs,
        ...cost.session_refs,
      ]);
    }
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, { durations, ...cost }]) => ({
      ...cost,
      duration_min: durations.sort((left, right) => left - right)
        .reduce((total, duration) => total + duration, 0),
    }));
}

type NormalizedReadObservation = StoredReadObservation & { confidence: Confidence };
function normalizeReadObservation(value: unknown): NormalizedReadObservation {
  if (!isObjectRecord(value)) throw new TypeError("read observation must be an object");
  let path: string;
  try { path = normalizeRepoPath(typeof value.path === "string"
    ? value.path.normalize("NFC") : ""); }
  catch { throw new TypeError("read observation path must be repository-relative"); }
  const objectId = typeof value.object_id === "string" ? value.object_id.toLowerCase() : "";
  if (!OID_PATTERN.test(objectId)) throw new TypeError("invalid read observation object_id");
  if (!finiteNonnegative(value.duration_min)) throw new TypeError("invalid read observation duration_min");
  if (!isStringArray(value.session_refs) || value.session_refs.some((ref) => ref === ""))
    throw new TypeError("invalid read observation session_refs");
  const confidence = value.confidence ?? "low";
  if (typeof confidence !== "string" || !CONFIDENCES.has(confidence))
    throw new TypeError("invalid read observation confidence");
  return { path, object_id: objectId, duration_min: value.duration_min,
    session_refs: sortedUnique(value.session_refs), confidence: confidence as Confidence };
}
function normalizedReadObservations(values: readonly StoredReadObservation[]) {
  const byIdentity = new Map<string, NormalizedReadObservation>();
  for (const raw of values) {
    const value = normalizeReadObservation(raw);
    const key = `${value.path}\0${value.object_id}`;
    const prior = byIdentity.get(key);
    byIdentity.set(key, prior === undefined ? value : {
      ...value, duration_min: prior.duration_min + value.duration_min,
      session_refs: sortedUnique([...prior.session_refs, ...value.session_refs]),
      confidence: prior.confidence === "low" || value.confidence === "low"
        ? "low" : prior.confidence === "medium" || value.confidence === "medium" ? "medium" : "high",
    });
  }
  const result = [...byIdentity.values()].sort((left, right) => left.path.localeCompare(right.path) ||
    left.object_id.localeCompare(right.object_id));
  if (result.some(({ duration_min }) => !Number.isFinite(duration_min)))
    throw new TypeError("invalid read observation duration_min total");
  return result;
}
function isStoredReadObservation(value: unknown): boolean {
  try {
    const normalized = normalizeReadObservation(value);
    const raw = value as StoredReadObservation;
    return raw.path === normalized.path && raw.object_id === normalized.object_id &&
      (raw.confidence === undefined || raw.confidence === normalized.confidence) &&
      raw.session_refs.join("\0") === normalized.session_refs.join("\0");
  } catch { return false; }
}
function validateInput(input: AnalysisRecordInput): void {
  if (
    !Number.isSafeInteger(input.created_at_ms) ||
    input.created_at_ms < 0
  ) {
    throw new TypeError("analysis created_at_ms must be a nonnegative safe integer");
  }
  if (
    input.analysis_id !== undefined &&
    input.analysis_id.trim() === ""
  ) {
    throw new TypeError("analysis_id must be non-empty when provided");
  }
  if (input.unit.repo.trim() === "" || input.unit.pr_ref.trim() === "") {
    throw new TypeError("analysis unit repo and pr_ref must be non-empty");
  }
}

export function makeAnalysisRecord(
  input: AnalysisRecordInput,
): AnalysisRecord {
  validateInput(input);
  const metrics = {
    ...summaryMetrics(input.summary),
    ...Object.fromEntries(
      Object.entries(input.metrics ?? {})
        .filter(([, value]) => Number.isFinite(value))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  const costs = normalizedCommandCosts(
    input.command_costs ?? findingCommandCosts(input.findings),
  );
  const content = {
    schema_version: 1 as const,
    created_at_ms: input.created_at_ms,
    unit: {
      repo: input.unit.repo,
      pr_ref: input.unit.pr_ref,
      sessions: sortedUnique(input.unit.sessions),
    },
    summary: cloneJson(input.summary),
    findings: cloneJson([...input.findings]),
    metrics,
    command_costs: costs,
    ...(input.read_observations === undefined ? {} :
      { read_observations: normalizedReadObservations(input.read_observations) }),
  };
  const generatedId = createHash("sha256")
    .update(stableStringify(content))
    .digest("hex");
  return {
    ...content,
    analysis_id: input.analysis_id?.trim() ?? generatedId,
  };
}

function recordOrder(
  left: Pick<AnalysisRecord, "analysis_id" | "created_at_ms">,
  right: Pick<AnalysisRecord, "analysis_id" | "created_at_ms">,
): number {
  return left.created_at_ms - right.created_at_ms ||
    left.analysis_id.localeCompare(right.analysis_id);
}

function recordFileName(record: AnalysisRecord): string {
  const idHash = createHash("sha256")
    .update(record.analysis_id)
    .digest("hex");
  return `${String(record.created_at_ms).padStart(16, "0")}-${idHash}.json`;
}

function isRecord(value: unknown): value is AnalysisRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<AnalysisRecord>;
  if (
    record.schema_version !== 1 ||
    typeof record.analysis_id !== "string" ||
    record.analysis_id === "" ||
    !Number.isSafeInteger(record.created_at_ms) ||
    (record.created_at_ms ?? -1) < 0 ||
    !isObjectRecord(record.unit) ||
    typeof record.unit.repo !== "string" ||
    typeof record.unit.pr_ref !== "string" ||
    !isStringArray(record.unit.sessions) ||
    !isObjectRecord(record.summary) ||
    !Array.isArray(record.findings) ||
    !record.findings.every(isStoredFinding) ||
    record.metrics === undefined ||
    record.metrics === null ||
    !isObjectRecord(record.metrics) ||
    !Array.isArray(record.command_costs) ||
    (record.read_observations !== undefined &&
      (!Array.isArray(record.read_observations) ||
        !record.read_observations.every(isStoredReadObservation)))
  ) {
    return false;
  }
  const summary = record.summary;
  // Legacy records predate human_wait_min; a missing value is treated as 0.
  if (
    summary.human_wait_min !== undefined &&
    !finiteNonnegative(summary.human_wait_min)
  ) {
    return false;
  }
  return [
    summary.measured_min,
    summary.idle_excluded_min,
    summary.estimated_floor_min,
    summary.recoverable_min,
    summary.unexplained_min,
  ].every(finiteNonnegative) &&
    Object.values(record.metrics).every((entry) =>
      typeof entry === "number" && Number.isFinite(entry)
    ) &&
    record.command_costs.every((cost) =>
      cost !== null &&
      typeof cost === "object" &&
      typeof cost.command === "string" &&
      finiteNonnegative(cost.duration_min) &&
      Array.isArray(cost.session_refs) &&
      cost.session_refs.every((entry) => typeof entry === "string") &&
      (cost.command_identity === undefined ||
        isCommandIdentity(cost.command_identity))
    );
}

function isHistoryIndex(value: unknown): value is HistoryIndex {
  if (value === null || typeof value !== "object") return false;
  const index = value as Partial<HistoryIndex>;
  return index.schema_version === 1 &&
    Array.isArray(index.analyses) &&
    index.analyses.every((entry) =>
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.analysis_id === "string" &&
      Number.isSafeInteger(entry.created_at_ms) &&
      typeof entry.file === "string"
    );
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

/**
 * Writes within the destination directory, flushes the file, closes it, and
 * performs one atomic rename. It intentionally does not add a lock.
 */
export async function writeJsonAtomically(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(stableStringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function inspectIndex(
  paths: StorePaths,
): Promise<StoreWarning[]> {
  try {
    const parsed = JSON.parse(
      await readFile(paths.history_index_path, "utf8"),
    ) as unknown;
    if (!isHistoryIndex(parsed)) {
      return [{
        code: "corrupt_history_index",
        message: "History index has an unsupported or invalid shape; immutable records were scanned instead.",
        path: paths.history_index_path,
      }];
    }
    return [];
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    return [{
      code: "corrupt_history_index",
      message: `History index could not be read; immutable records were scanned instead: ${errorMessage(error)}`,
      path: paths.history_index_path,
    }];
  }
}

export async function loadAnalyses(
  paths: StorePaths,
): Promise<AnalysisHistoryResult> {
  const warnings = await inspectIndex(paths);
  let files: string[];
  try {
    files = (await readdir(paths.analyses_dir))
      .filter((file) => file.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { records: [], warnings };
    }
    return {
      records: [],
      warnings: [
        ...warnings,
        {
          code: "history_read_failed",
          message: `Analysis history could not be read: ${errorMessage(error)}`,
          path: paths.analyses_dir,
        },
      ],
    };
  }

  const recordsById = new Map<string, AnalysisRecord>();
  for (const file of files) {
    const path = join(paths.analyses_dir, file);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!isRecord(value)) {
        throw new TypeError("unsupported or invalid analysis record");
      }
      if (recordsById.has(value.analysis_id)) {
        warnings.push({
          code: "duplicate_analysis_record",
          message: `Duplicate analysis ID ${value.analysis_id} was skipped.`,
          path,
        });
        continue;
      }
      recordsById.set(value.analysis_id, value);
    } catch (error) {
      warnings.push({
        code: "corrupt_analysis_record",
        message: `Analysis record was skipped: ${errorMessage(error)}`,
        path,
      });
    }
  }
  return {
    records: [...recordsById.values()].sort(recordOrder),
    warnings,
  };
}

function historyIndex(
  paths: StorePaths,
  records: readonly AnalysisRecord[],
): HistoryIndex {
  return {
    schema_version: 1,
    analyses: [...records].sort(recordOrder).map((record) => ({
      analysis_id: record.analysis_id,
      created_at_ms: record.created_at_ms,
      file: recordFileName(record),
    })),
  };
}

function asRecord(
  input: AnalysisRecord | AnalysisRecordInput,
): AnalysisRecord {
  return isRecord(input) ? cloneJson(input) : makeAnalysisRecord(input);
}

export async function saveAnalysis(
  paths: StorePaths,
  input: AnalysisRecord | AnalysisRecordInput,
): Promise<AnalysisSaveResult> {
  const record = asRecord(input);
  const warnings: StoreWarning[] = [];
  const targetPath = join(paths.analyses_dir, recordFileName(record));
  try {
    await mkdir(paths.analyses_dir, { recursive: true });
    try {
      const existing = await readFile(targetPath, "utf8");
      if (existing !== stableStringify(record)) {
        warnings.push({
          code: "analysis_record_conflict",
          message: "An immutable analysis record already exists with different content.",
          path: targetPath,
        });
        return { record, warnings };
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await writeJsonAtomically(targetPath, record);
    }
  } catch (error) {
    warnings.push({
      code: "analysis_write_failed",
      message: `Analysis could not be persisted: ${errorMessage(error)}`,
      path: targetPath,
    });
    return { record, warnings };
  }

  const loaded = await loadAnalyses(paths);
  warnings.push(...loaded.warnings);
  try {
    await writeJsonAtomically(
      paths.history_index_path,
      historyIndex(paths, loaded.records),
    );
  } catch (error) {
    warnings.push({
      code: "index_write_failed",
      message: `History index could not be updated: ${errorMessage(error)}`,
      path: paths.history_index_path,
    });
  }
  return { record, warnings };
}

function roundedMetric(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function computeBaseline(
  current: AnalysisRecord,
  history: readonly AnalysisRecord[],
  windowSize = 10,
): BaselineComparison | null {
  if (!Number.isSafeInteger(windowSize) || windowSize <= 0) {
    throw new TypeError("baseline window must be a positive safe integer");
  }
  const prior = history
    .filter(
      (record) =>
        record.analysis_id !== current.analysis_id &&
        record.created_at_ms < current.created_at_ms,
    )
    .sort(recordOrder)
    .slice(-windowSize);
  if (prior.length < 3) return null;

  const notable = Object.entries(current.metrics)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([metric, value]) => {
      if (!Number.isFinite(value)) return [];
      const historical = prior.flatMap((record) => {
        const entry = record.metrics[metric];
        return entry !== undefined && Number.isFinite(entry) ? [entry] : [];
      });
      if (historical.length < 3) return [];
      return [{
        metric,
        value: roundedMetric(value),
        baseline: roundedMetric(
          historical.reduce((total, entry) => total + entry, 0) /
            historical.length,
        ),
      }];
    });
  return { prs: prior.length, notable };
}
