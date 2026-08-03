import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import {
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeCommand } from "../analysis/command.js";
import { commandIdentityKey } from "../analysis/command-identity.js";
import { normalizeRepoPath } from "../analysis/test-map.js";
import { findingCompatibilityMetadata } from "../core/model.js";
import type {
  AnalysisSummary,
  AnalysisUnit,
  BaselineComparison,
  CommandIdentity,
  Confidence,
  Finding,
} from "../core/model.js";
import { canonicalJson, readLegacyJson } from "./legacy-json.js";
import type { StorePaths } from "./paths.js";
import { openStoreDatabase, storeDatabasePath } from "./sqlite.js";

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

export interface AnalysisSnapshotIdentity {
  repo_id: string; base_oid: string; head_oid: string; merge_base_oid: string;
  window: {
    started_at_ms: number; ended_at_ms?: number; end_source: "explicit" | "analysis_time";
    start_source: "explicit" | "branch_reflog" | "session_branch_transition" | "commit_anchor_lookback"; completeness: "complete" | "partial";
  };
  source_digest: string; config_digest: string;
  policy_digest: string; history_digest: string;
}

export interface AnalysisSaveOptions { snapshot?: AnalysisSnapshotIdentity; }
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function analysisDigest(domain: string, value: unknown): string {
  if (domain === "" || domain.includes("\0"))
    throw new TypeError("digest domain must be non-empty and contain no NUL");
  return createHash("sha256").update(`ccprof\0${domain}\0`)
    .update(canonicalJson(value)).digest("hex");
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
    isStringArray(value.caveats) &&
    findingCompatibilityMetadata(value).valid
  );
}

function snapshotStoredFinding(value: Finding): Finding {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const compatibilitySource: Record<string, unknown> = {};
    for (const field of ["rule_version", "compatibility_epoch"] as const) {
      const descriptor = descriptors[field];
      if (descriptor !== undefined) {
        Object.defineProperty(compatibilitySource, field, descriptor);
      }
    }
    const compatibility = findingCompatibilityMetadata(compatibilitySource);
    if (!compatibility.valid) throw new TypeError();
    const read = (field: keyof Finding): unknown => {
      const descriptor = descriptors[field] as PropertyDescriptor | undefined;
      if (descriptor === undefined) return undefined;
      return "value" in descriptor
        ? descriptor.value
        : descriptor.get?.call(value);
    };
    const snapshot = cloneJson({
      finding_key: read("finding_key"),
      rule_id: read("rule_id"),
      title: read("title"),
      target: read("target"),
      classification: read("classification"),
      cause: read("cause"),
      scope: read("scope"),
      confidence: read("confidence"),
      evidence: read("evidence"),
      recoverable: read("recoverable"),
      fix_recipe: read("fix_recipe"),
      caveats: read("caveats"),
      ...(compatibility.metadata ?? {}),
    });
    if (!isStoredFinding(snapshot)) throw new TypeError();
    return snapshot;
  } catch {
    throw new TypeError("invalid finding compatibility metadata");
  }
}

function snapshotStoredFindings(values: readonly Finding[]): Finding[] {
  try {
    if (!Array.isArray(values)) throw new TypeError();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(values, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) throw new TypeError();
    const snapshots: Finding[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
      if (descriptor === undefined) throw new TypeError();
      const value = "value" in descriptor
        ? descriptor.value
        : descriptor.get?.call(values);
      snapshots.push(snapshotStoredFinding(value as Finding));
    }
    return snapshots;
  } catch {
    throw new TypeError("invalid finding compatibility metadata");
  }
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
  const findings = snapshotStoredFindings(input.findings);
  const metrics = {
    ...summaryMetrics(input.summary),
    ...Object.fromEntries(
      Object.entries(input.metrics ?? {})
        .filter(([, value]) => Number.isFinite(value))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
  const costs = normalizedCommandCosts(
    input.command_costs ?? findingCommandCosts(findings),
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
    findings,
    metrics,
    command_costs: costs,
    ...(input.read_observations === undefined ? {} :
      { read_observations: normalizedReadObservations(input.read_observations) }),
  };
  const generatedId = createHash("sha256")
    .update(canonicalJson(content))
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
    await handle.writeFile(canonicalJson(value), "utf8");
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

function asRecord(
  input: AnalysisRecord | AnalysisRecordInput,
): AnalysisRecord {
  try {
    const record = makeAnalysisRecord(input);
    if (!isRecord(record)) throw new TypeError();
    return record;
  } catch {
    throw new TypeError("invalid analysis record");
  }
}

type StoreDatabase = ReturnType<typeof openStoreDatabase>;
function closeDatabase(database: StoreDatabase | undefined): void { try { database?.close(); } catch { /* Preserve the operation result. */ } }
type SnapshotEnvelope = { schema_version: 1; identity: AnalysisSnapshotIdentity |
  { mode: "content-fallback" }; payload: Omit<AnalysisRecord, "analysis_id" | "created_at_ms"> };
const LEGACY_ANALYSES_MIGRATION = "legacy-analyses-json-v1", HEX_64 = /^[0-9a-f]{64}$/u;
const WINDOW_STARTS = new Set(["explicit", "branch_reflog", "session_branch_transition", "commit_anchor_lookback"]);
function normalizeSnapshotIdentity(value: AnalysisSnapshotIdentity): AnalysisSnapshotIdentity {
  const oid = (entry: unknown, label: string, pattern = OID_PATTERN): string => {
    const normalized = typeof entry === "string" ? entry.toLowerCase() : "";
    if (!pattern.test(normalized)) throw new TypeError(`invalid snapshot ${label}`);
    return normalized;
  };
  const window = value?.window;
  if (!isObjectRecord(window) || !Number.isSafeInteger(window.started_at_ms) || window.started_at_ms < 0 ||
    !WINDOW_STARTS.has(window.start_source) || (window.end_source !== "explicit" &&
      window.end_source !== "analysis_time") || (window.completeness !== "complete" &&
      window.completeness !== "partial") || (window.end_source === "explicit"
        ? !Number.isSafeInteger(window.ended_at_ms) || (window.ended_at_ms ?? -1) < window.started_at_ms
        : window.ended_at_ms !== undefined)) {
    throw new TypeError("invalid snapshot window");
  }
  return {
    repo_id: oid(value.repo_id, "repo_id", HEX_64), base_oid: oid(value.base_oid, "base_oid"),
    head_oid: oid(value.head_oid, "head_oid"),
    merge_base_oid: oid(value.merge_base_oid, "merge_base_oid"),
    window: { started_at_ms: window.started_at_ms, start_source: window.start_source,
      end_source: window.end_source, completeness: window.completeness,
      ...(window.ended_at_ms === undefined ? {} : { ended_at_ms: window.ended_at_ms }) },
    source_digest: oid(value.source_digest, "source_digest", HEX_64),
    config_digest: oid(value.config_digest, "config_digest", HEX_64),
    policy_digest: oid(value.policy_digest, "policy_digest", HEX_64), history_digest: oid(value.history_digest, "history_digest", HEX_64),
  };
}
function snapshotEnvelope(record: AnalysisRecord, identity?: AnalysisSnapshotIdentity): SnapshotEnvelope {
  const { analysis_id: _id, created_at_ms: _time, ...payload } = record;
  return { schema_version: 1, identity: identity === undefined
      ? { mode: "content-fallback" } : normalizeSnapshotIdentity(identity),
    payload: cloneJson(payload) };
}
class StoreConflict extends Error {
  constructor(readonly code: "analysis_record_conflict" | "analysis_snapshot_conflict", message: string) { super(message); }
}
function insertAnalysis(database: StoreDatabase, record: AnalysisRecord,
  identity?: AnalysisSnapshotIdentity): void {
  const envelope = snapshotEnvelope(record, identity);
  const recordJson = canonicalJson(envelope);
  const snapshotId = analysisDigest("analysis-snapshot-v1", envelope);
  const execution = database.prepare(`SELECT e.snapshot_id, e.executed_at_ms, s.record_json
    FROM analysis_executions e JOIN analysis_snapshots s USING (snapshot_id)
    WHERE e.execution_id = ?`).get(record.analysis_id) as
      { snapshot_id: string; executed_at_ms: number; record_json: string } | undefined;
  if (execution !== undefined) {
    if (execution.snapshot_id === snapshotId && execution.executed_at_ms === record.created_at_ms &&
      execution.record_json === recordJson) return;
    throw new StoreConflict("analysis_record_conflict",
      "An immutable analysis execution already exists with different content.");
  }
  const existing = database.prepare(
    "SELECT record_json FROM analysis_snapshots WHERE snapshot_id = ?",
  ).get(snapshotId) as { record_json: string } | undefined;
  if (existing !== undefined && existing.record_json !== recordJson) {
    throw new StoreConflict("analysis_snapshot_conflict",
      "An analysis snapshot hash already exists with different content.");
  }
  if (existing === undefined) database.prepare(`INSERT INTO analysis_snapshots
    (snapshot_id, created_at_ms, record_json) VALUES (?, ?, ?)`)
    .run(snapshotId, record.created_at_ms, recordJson);
  else database.prepare(`UPDATE analysis_snapshots SET created_at_ms = MIN(created_at_ms, ?)
    WHERE snapshot_id = ?`).run(record.created_at_ms, snapshotId);
  database.prepare(`INSERT INTO analysis_executions
    (execution_id, snapshot_id, executed_at_ms) VALUES (?, ?, ?)`)
    .run(record.analysis_id, snapshotId, record.created_at_ms);
}
function migrationWarning(code: string, message: string, path: string): StoreWarning { return { code, message, path }; }
class CorruptLegacyRecord extends Error {}
function readLegacyRecord(path: string): AnalysisRecord {
  const read = readLegacyJson(path);
  if (read.kind === "missing") throw new Error("legacy analysis file disappeared while scanning");
  if (read.kind === "corrupt") throw new CorruptLegacyRecord(read.message);
  if (!isRecord(read.value)) throw new CorruptLegacyRecord("unsupported or invalid analysis record");
  return read.value;
}
function scanLegacyAnalyses(paths: StorePaths): { records: AnalysisRecord[]; warnings: StoreWarning[] } {
  let directory;
  try { directory = lstatSync(paths.analyses_dir); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return { records: [], warnings: [] };
    throw error;
  }
  if (directory.isSymbolicLink() || !directory.isDirectory())
    throw new Error("legacy analyses path is not a regular directory");
  const files = readdirSync(paths.analyses_dir).filter((file) => file.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  const records: AnalysisRecord[] = [], warnings: StoreWarning[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const path = join(paths.analyses_dir, file);
    try {
      const value = readLegacyRecord(path);
      if (seen.has(value.analysis_id)) {
        warnings.push(migrationWarning("duplicate_analysis_record",
          `Duplicate analysis ID ${value.analysis_id} was skipped.`, path));
      } else { seen.add(value.analysis_id); records.push(value); }
    } catch (error) {
      if (!(error instanceof CorruptLegacyRecord)) throw error;
      warnings.push(migrationWarning("corrupt_analysis_record",
        `Analysis record was skipped: ${errorMessage(error)}`, path));
    }
  }
  const after = lstatSync(paths.analyses_dir);
  if (!after.isDirectory() || after.dev !== directory.dev || after.ino !== directory.ino)
    throw new Error("legacy analyses directory changed while scanning");
  return { records, warnings };
}
function migrationComplete(database: StoreDatabase): boolean {
  return database.prepare("SELECT 1 FROM store_migrations WHERE name = ?")
    .get(LEGACY_ANALYSES_MIGRATION) !== undefined;
}
function migrateLegacyAnalyses(database: StoreDatabase, paths: StorePaths): StoreWarning[] {
  if (migrationComplete(database)) return [];
  const scanned = scanLegacyAnalyses(paths);
  return database.transaction(() => {
    if (migrationComplete(database)) return [];
    for (const record of scanned.records) insertAnalysis(database, record);
    database.prepare("INSERT INTO store_migrations(name, completed_at_ms) VALUES (?, ?)")
      .run(LEGACY_ANALYSES_MIGRATION, Date.now());
    return scanned.warnings;
  }).immediate();
}
function parseSnapshot(recordJson: string, snapshotId: string,
  executionId: string, executedAtMs: number): AnalysisRecord {
  const value = JSON.parse(recordJson) as unknown;
  if (!isObjectRecord(value) || value.schema_version !== 1 ||
    !isObjectRecord(value.payload) || "analysis_id" in value.payload ||
    "created_at_ms" in value.payload || !isObjectRecord(value.identity) ||
    canonicalJson(value) !== recordJson ||
    analysisDigest("analysis-snapshot-v1", value) !== snapshotId) {
    throw new TypeError("unsupported or invalid analysis snapshot");
  }
  if (value.identity.mode === "content-fallback") {
    if (Object.keys(value.identity).length !== 1) throw new TypeError("invalid fallback identity");
  } else {
    const normalized = normalizeSnapshotIdentity(value.identity as unknown as AnalysisSnapshotIdentity);
    if (canonicalJson(normalized) !== canonicalJson(value.identity))
      throw new TypeError("non-canonical snapshot identity");
  }
  const record = { ...value.payload, analysis_id: executionId, created_at_ms: executedAtMs };
  if (!isRecord(record)) throw new TypeError("unsupported or invalid analysis record");
  return record;
}

export async function loadAnalyses(paths: StorePaths): Promise<AnalysisHistoryResult> {
  const warnings: StoreWarning[] = [];
  let database: StoreDatabase | undefined;
  try {
    database = openStoreDatabase(paths);
    try { warnings.push(...migrateLegacyAnalyses(database, paths)); }
    catch (error) { warnings.push(migrationWarning("history_read_failed",
      `Analysis history could not be migrated: ${errorMessage(error)}`, paths.analyses_dir)); }
    const rows = database.prepare(`SELECT s.snapshot_id, s.record_json,
      e.execution_id, e.executed_at_ms FROM analysis_snapshots s
      JOIN analysis_executions e ON e.rowid =
        (SELECT oldest.rowid FROM analysis_executions oldest
          WHERE oldest.snapshot_id = s.snapshot_id
          ORDER BY oldest.executed_at_ms, oldest.execution_id LIMIT 1)
      ORDER BY e.executed_at_ms, e.execution_id`).all() as {
        snapshot_id: string; record_json: string; execution_id: string; executed_at_ms: number }[];
    const records: AnalysisRecord[] = [];
    for (const row of rows) {
      try { records.push(parseSnapshot(row.record_json, row.snapshot_id,
        row.execution_id, row.executed_at_ms)); }
      catch (error) { warnings.push(migrationWarning("corrupt_analysis_record",
        `Analysis snapshot was skipped: ${errorMessage(error)}`,
        `${storeDatabasePath(paths)}#analysis_snapshots/${row.snapshot_id}`)); }
    }
    return { records: records.sort(recordOrder), warnings };
  } catch (error) {
    return { records: [], warnings: [...warnings, migrationWarning("history_read_failed",
      `Analysis history could not be read: ${errorMessage(error)}`, storeDatabasePath(paths))] };
  } finally { closeDatabase(database); }
}

export async function saveAnalysis(
  paths: StorePaths,
  input: AnalysisRecord | AnalysisRecordInput,
  options: AnalysisSaveOptions = {},
): Promise<AnalysisSaveResult> {
  const record = asRecord(input);
  const warnings: StoreWarning[] = [];
  const targetPath = storeDatabasePath(paths);
  let database: StoreDatabase | undefined;
  try {
    database = openStoreDatabase(paths);
    warnings.push(...migrateLegacyAnalyses(database, paths));
    database.transaction(() => insertAnalysis(database as StoreDatabase, record, options.snapshot)).immediate();
  } catch (error) {
    warnings.push({
      code: error instanceof StoreConflict ? error.code : "analysis_write_failed",
      message: `Analysis could not be persisted: ${errorMessage(error)}`,
      path: targetPath,
    });
  } finally { closeDatabase(database); }
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
