import { ALL_SESSION_CAPABILITIES, type RuleId, type SessionCapability } from "../core/model.js";
import type { SourceAdapterId } from "../core/source-descriptor.js";
export interface RuleManifest {
  id: RuleId;
  version: string;
  compatibility_epoch: number;
  required_capabilities: SessionCapability[];
  supported_sources: SourceAdapterId[];
  impact_kind: "critical_path_latency" | "resource_cost" | "policy_latency" | "evidence_only";
  default_mode: "enabled" | "observe_only" | "disabled";
  aggregation_policy: "sum" | "union" | "max" | "never_aggregate";
  evidence_schema: string;
  policy_risk: "low" | "medium" | "high";
}

type ValidationCode =
  | "invalid_catalog" | "invalid_entry" | "missing_field" | "unknown_field"
  | "duplicate_id" | "invalid_rule_id" | "unknown_rule_id" | "missing_rule_id"
  | "invalid_version" | "invalid_epoch" | "version_epoch_mismatch"
  | "invalid_capability" | "invalid_source" | "invalid_impact_kind"
  | "invalid_mode" | "invalid_aggregation_policy" | "invalid_evidence_schema"
  | "invalid_policy_risk";
export class RuleManifestValidationError extends Error {
  constructor(
    public readonly code: ValidationCode,
    public readonly index?: number,
    public readonly field?: string,
  ) {
    super(`invalid rule manifest${index === undefined ? "" : ` at index ${index}`}${
      field === undefined ? "" : ` field ${field}`}: ${code}`);
    this.name = "RuleManifestValidationError";
  }
}
const RULE_IDS = ["R001", "R002", "R003", "R004", "R005", "R006", "R007", "R008"] as const satisfies readonly RuleId[];
const FIELDS = [
  "id", "version", "compatibility_epoch", "required_capabilities",
  "supported_sources", "impact_kind", "default_mode", "aggregation_policy",
  "evidence_schema", "policy_risk",
] as const;
const FIELD_SET = new Set<string>(FIELDS);
const RULE_ID_SET = new Set<string>(RULE_IDS);
const CAPABILITY_SET = new Set<string>(ALL_SESSION_CAPABILITIES);
const SOURCE_IDS = ["claude", "codex"] as const;
const SOURCE_SET = new Set<string>(SOURCE_IDS);
const VERSION_PATTERN = /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
function fail(code: ValidationCode, index?: number, field?: string): never {
  throw new RuleManifestValidationError(code, index, field);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonicalId(value: string): string { return value.normalize("NFC").trim().toUpperCase(); }
function isCanonicalList(
  value: unknown,
  allowed: ReadonlySet<string>,
): value is string[] {
  if (!Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !allowed.has(item))) {
    return false;
  }
  const strings = value as string[];
  const sorted = [...new Set(strings)].sort((a, b) => a.localeCompare(b));
  return sorted.length === strings.length &&
    sorted.every((item, index) => item === strings[index]);
}
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
function enumValue<T extends string>(
  value: unknown, values: readonly T[], code: ValidationCode,
  index: number,
  field: string,
): T {
  return typeof value === "string" && values.includes(value as T)
    ? value as T : fail(code, index, field);
}
const ROWS = [
  ["R001", ["edit_fragments"], "critical_path_latency", "enabled", "union", "medium"],
  ["R002", [], "critical_path_latency", "enabled", "union", "low"],
  ["R003", [], "critical_path_latency", "enabled", "union", "low"],
  ["R004", [], "policy_latency", "observe_only", "never_aggregate", "high"],
  ["R005", ["tool_timestamps"], "resource_cost", "enabled", "max", "medium"],
  ["R006", [], "resource_cost", "enabled", "max", "medium"],
  ["R007", ["token_usage"], "critical_path_latency", "enabled", "max", "low"],
  ["R008", [], "critical_path_latency", "enabled", "union", "medium"],
] as const;
const RAW_CATALOG: RuleManifest[] = ROWS.map(([
  id, capabilities, impact, mode, aggregation, risk,
]) => ({
  id, version: "1.0.0", compatibility_epoch: 1,
  required_capabilities: [...capabilities], supported_sources: [...SOURCE_IDS],
  impact_kind: impact, default_mode: mode, aggregation_policy: aggregation,
  evidence_schema: `ccprof://rules/${id}/evidence/v1`, policy_risk: risk,
}));
export function validateRuleManifestCatalog(value: unknown): RuleManifest[] {
  if (!Array.isArray(value)) return fail("invalid_catalog");
  const entries = value.map((entry, index) => {
    if (!isRecord(entry)) return fail("invalid_entry", index);
    for (const field of FIELDS) {
      if (!Object.hasOwn(entry, field)) return fail("missing_field", index, field);
    }
    const unknown = Object.keys(entry).filter((key) => !FIELD_SET.has(key)).sort()[0];
    if (unknown !== undefined) return fail("unknown_field", index, unknown);
    return Object.fromEntries(FIELDS.map((field) => [field, entry[field]]));
  });
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (typeof entry.id !== "string") continue;
    const normalized = canonicalId(entry.id);
    if (seen.has(normalized)) return fail("duplicate_id", index, "id");
    seen.add(normalized);
  }
  const manifests = entries.map((entry, index): RuleManifest => {
    if (typeof entry.id !== "string") return fail("invalid_rule_id", index, "id");
    const normalized = canonicalId(entry.id);
    if (entry.id !== normalized || !/^R\d{3}$/u.test(entry.id)) {
      return fail("invalid_rule_id", index, "id");
    }
    if (!RULE_ID_SET.has(entry.id)) return fail("unknown_rule_id", index, "id");
    const id = entry.id as RuleId;
    const declared = RAW_CATALOG.find((candidate) => candidate.id === id)!;
    const version = typeof entry.version === "string"
      ? VERSION_PATTERN.exec(entry.version)
      : null;
    if (version === null) return fail("invalid_version", index, "version");
    const epoch = entry.compatibility_epoch;
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0) {
      return fail("invalid_epoch", index, "compatibility_epoch");
    }
    if (version[1] !== String(epoch)) {
      return fail("version_epoch_mismatch", index, "compatibility_epoch");
    }
    if (entry.version !== declared.version) {
      return fail("invalid_version", index, "version");
    }
    if (epoch !== declared.compatibility_epoch) {
      return fail("invalid_epoch", index, "compatibility_epoch");
    }
    if (!isCanonicalList(entry.required_capabilities, CAPABILITY_SET) ||
      !sameList(entry.required_capabilities, declared.required_capabilities)) {
      return fail("invalid_capability", index, "required_capabilities");
    }
    if (!isCanonicalList(entry.supported_sources, SOURCE_SET) ||
      !sameList(entry.supported_sources, declared.supported_sources)) {
      return fail("invalid_source", index, "supported_sources");
    }
    const impact = enumValue(entry.impact_kind,
      ["critical_path_latency", "resource_cost", "policy_latency", "evidence_only"],
      "invalid_impact_kind", index, "impact_kind");
    if (impact !== declared.impact_kind) {
      return fail("invalid_impact_kind", index, "impact_kind");
    }
    const mode = enumValue(entry.default_mode, ["enabled", "observe_only", "disabled"],
      "invalid_mode", index, "default_mode");
    if (mode !== declared.default_mode) {
      return fail("invalid_mode", index, "default_mode");
    }
    const aggregation = enumValue(entry.aggregation_policy,
      ["sum", "union", "max", "never_aggregate"],
      "invalid_aggregation_policy", index, "aggregation_policy");
    if (aggregation !== declared.aggregation_policy) {
      return fail("invalid_aggregation_policy", index, "aggregation_policy");
    }
    if (entry.evidence_schema !== declared.evidence_schema) {
      return fail("invalid_evidence_schema", index, "evidence_schema");
    }
    const risk = enumValue(entry.policy_risk, ["low", "medium", "high"],
      "invalid_policy_risk", index, "policy_risk");
    if (risk !== declared.policy_risk) {
      return fail("invalid_policy_risk", index, "policy_risk");
    }
    return {
      id, version: entry.version as string, compatibility_epoch: epoch,
      required_capabilities: [...entry.required_capabilities] as SessionCapability[],
      supported_sources: [...entry.supported_sources] as SourceAdapterId[],
      impact_kind: impact, default_mode: mode, aggregation_policy: aggregation,
      evidence_schema: entry.evidence_schema as string, policy_risk: risk,
    };
  });
  for (const id of RULE_IDS) {
    if (!manifests.some((entry) => entry.id === id)) {
      return fail("missing_rule_id", undefined, id);
    }
  }
  return manifests.sort((left, right) => left.id.localeCompare(right.id));
}
const BUILTIN_CATALOG = Object.freeze(
  validateRuleManifestCatalog(RAW_CATALOG).map((entry) => Object.freeze({
    ...entry,
    required_capabilities: Object.freeze(entry.required_capabilities),
    supported_sources: Object.freeze(entry.supported_sources),
  })),
);
function clone(entry: (typeof BUILTIN_CATALOG)[number]): RuleManifest {
  return {
    ...entry,
    required_capabilities: [...entry.required_capabilities],
    supported_sources: [...entry.supported_sources],
  };
}
export function listRuleManifests(): RuleManifest[] { return BUILTIN_CATALOG.map(clone); }
export function ruleManifest(id: string): RuleManifest {
  const entry = BUILTIN_CATALOG.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new TypeError(`unknown rule id ${id}; expected ${RULE_IDS.join(", ")}`);
  }
  return clone(entry);
}
