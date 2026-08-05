import { types as utilTypes } from "node:util";

export const CAPABILITY_DESCRIPTOR_SCHEMA_ID =
  "https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/capability-descriptor-v1.schema.json";
export const CAPABILITY_DESCRIPTOR_SCHEMA_VERSION = 1 as const;
export const CAPABILITY_DESCRIPTOR_VERSION = "1.0.0" as const;
export const CAPABILITY_UNDECLARED_STATE = "unknown" as const;

export type CapabilityState =
  | "supported_exact" | "supported_estimated" | "supported_partial"
  | "unsupported" | "unknown";
export type CapabilityEvidenceQuality =
  | "exact" | "estimated" | "partial" | "unknown" | "none";
export type CapabilityEvidenceProvenance =
  | "producer_declared" | "adapter_declared" | "observed" | "derived"
  | "unknown";
export type CapabilityTimestampPrecision =
  | "nanosecond" | "microsecond" | "millisecond" | "second" | "unknown"
  | "not_applicable";
export interface CapabilityEvidenceV1 {
  readonly quality: CapabilityEvidenceQuality;
  readonly provenance: CapabilityEvidenceProvenance;
}
type VersionContract =
  | { readonly version: string; readonly version_range?: never }
  | { readonly version?: never; readonly version_range: string };
interface CapabilityDeclarationBaseV1 {
  readonly id: string;
  readonly legacy_id?: string;
  readonly requirement: "required" | "optional";
  readonly state: CapabilityState;
  readonly evidence: CapabilityEvidenceV1;
  readonly timestamp_precision: CapabilityTimestampPrecision;
}
export type CapabilityDeclarationV1 = CapabilityDeclarationBaseV1 &
  VersionContract;
export interface CapabilityDescriptorV1 {
  readonly $schema: typeof CAPABILITY_DESCRIPTOR_SCHEMA_ID;
  readonly schema_version: typeof CAPABILITY_DESCRIPTOR_SCHEMA_VERSION;
  readonly descriptor_version: typeof CAPABILITY_DESCRIPTOR_VERSION;
  readonly undeclared_capability_state: typeof CAPABILITY_UNDECLARED_STATE;
  readonly capabilities: readonly CapabilityDeclarationV1[];
}
export type CapabilitySupportQuery = Readonly<{ id: string }> & VersionContract;

export type CapabilityDescriptorValidationCode = "invalid_descriptor";
export class CapabilityDescriptorValidationError extends TypeError {
  readonly code: CapabilityDescriptorValidationCode;
  constructor(code: CapabilityDescriptorValidationCode) {
    super(`invalid capability descriptor: ${code}`);
    this.name = "CapabilityDescriptorValidationError";
    this.code = code;
  }
}

const CAPABILITY_ID_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\/capabilities\/[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*(?![\s\S])/u;
const LEGACY_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}(?![\s\S])/u;
const SEMVER_SOURCE =
  "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)" +
  "(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)" +
  "(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?" +
  "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const SEMVER_PATTERN = new RegExp(`^${SEMVER_SOURCE}(?![\\s\\S])`, "u");
const RANGE_PATTERN = new RegExp(
  `^(?:[~^]|>=|>|<=|<)${SEMVER_SOURCE}` +
    `(?: (?:>=|>|<=|<)${SEMVER_SOURCE})?(?![\\s\\S])`,
  "u",
);
const STATES = new Set<string>([
  "supported_exact", "supported_estimated", "supported_partial",
  "unsupported", "unknown",
]);
const QUALITIES = new Set<string>([
  "exact", "estimated", "partial", "unknown", "none",
]);
const PROVENANCES = new Set<string>([
  "producer_declared", "adapter_declared", "observed", "derived", "unknown",
]);
const KNOWN_PROVENANCES = new Set<string>([
  "producer_declared", "adapter_declared", "observed", "derived",
]);
const PRECISIONS = new Set<string>([
  "nanosecond", "microsecond", "millisecond", "second", "unknown",
  "not_applicable",
]);

function fail(code: CapabilityDescriptorValidationCode): never {
  throw new CapabilityDescriptorValidationError(code);
}

function dataObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  code: CapabilityDescriptorValidationCode,
): Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) fail(code);
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
      PropertyDescriptorMap;
  } catch {
    return fail(code);
  }
  if (prototype !== Object.prototype) fail(code);
  const allowedSet = new Set(allowed);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowedSet.has(key))) {
    fail(code);
  }
  if (required.some((field) => !Object.hasOwn(descriptors, field))) fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(
  value: unknown,
  code: CapabilityDescriptorValidationCode,
): unknown[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) fail(code);
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
      PropertyDescriptorMap;
  } catch {
    return fail(code);
  }
  const length = descriptors.length;
  if (
    prototype !== Array.prototype || !length || !("value" in length) ||
    !Number.isSafeInteger(length.value) || length.value < 0 ||
    Reflect.ownKeys(descriptors).length !== length.value + 1
  ) fail(code);
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(code);
    }
    result.push(descriptor.value);
  }
  return result;
}

function stringValue(
  value: unknown,
  pattern: RegExp,
  maximum: number,
  code: CapabilityDescriptorValidationCode,
): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) {
    fail(code);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  code: CapabilityDescriptorValidationCode,
): T {
  if (typeof value !== "string" || !values.has(value)) fail(code);
  return value as T;
}

function versionContract(
  value: Record<string, unknown>,
  code: CapabilityDescriptorValidationCode,
): VersionContract {
  const hasVersion = Object.hasOwn(value, "version");
  const hasRange = Object.hasOwn(value, "version_range");
  if (hasVersion === hasRange) fail(code);
  return hasVersion
    ? { version: stringValue(value.version, SEMVER_PATTERN, 128, code) }
    : { version_range: stringValue(value.version_range, RANGE_PATTERN, 256, code) };
}

function declaration(value: unknown): CapabilityDeclarationV1 {
  const code = "invalid_descriptor";
  const object = dataObject(value, [
    "id", "legacy_id", "version", "version_range", "requirement", "state",
    "evidence", "timestamp_precision",
  ], ["id", "requirement", "state", "evidence", "timestamp_precision"], code);
  const evidenceObject = dataObject(
    object.evidence, ["quality", "provenance"], ["quality", "provenance"], code,
  );
  const state = enumValue<CapabilityState>(object.state, STATES, code);
  const quality = enumValue<CapabilityEvidenceQuality>(
    evidenceObject.quality, QUALITIES, code,
  );
  const provenance = enumValue<CapabilityEvidenceProvenance>(
    evidenceObject.provenance, PROVENANCES, code,
  );
  const precision = enumValue<CapabilityTimestampPrecision>(
    object.timestamp_precision, PRECISIONS, code,
  );
  const known = KNOWN_PROVENANCES.has(provenance);
  const consistent =
    (state === "supported_exact" && quality === "exact" && known) ||
    (state === "supported_estimated" && quality === "estimated" && known) ||
    (state === "supported_partial" &&
      (quality === "partial" || quality === "unknown") && known) ||
    (state === "unsupported" && quality === "none" && known &&
      precision === "not_applicable") ||
    (state === "unknown" && quality === "unknown" && provenance === "unknown" &&
      precision === "unknown");
  if (!consistent) fail(code);
  const evidence = Object.freeze({ quality, provenance });
  const legacy = Object.hasOwn(object, "legacy_id")
    ? { legacy_id: stringValue(object.legacy_id, LEGACY_ID_PATTERN, 64, code) }
    : {};
  return Object.freeze({
    id: stringValue(object.id, CAPABILITY_ID_PATTERN, 255, code),
    ...legacy,
    ...versionContract(object, code),
    requirement: enumValue(object.requirement, new Set(["required", "optional"]), code),
    state,
    evidence,
    timestamp_precision: precision,
  }) as CapabilityDeclarationV1;
}

export function validateCapabilityDescriptor(value: unknown): CapabilityDescriptorV1 {
  const code = "invalid_descriptor";
  const object = dataObject(value, [
    "$schema", "schema_version", "descriptor_version",
    "undeclared_capability_state", "capabilities",
  ], [
    "$schema", "schema_version", "descriptor_version",
    "undeclared_capability_state", "capabilities",
  ], code);
  if (
    object.$schema !== CAPABILITY_DESCRIPTOR_SCHEMA_ID ||
    object.schema_version !== CAPABILITY_DESCRIPTOR_SCHEMA_VERSION ||
    object.descriptor_version !== CAPABILITY_DESCRIPTOR_VERSION ||
    object.undeclared_capability_state !== CAPABILITY_UNDECLARED_STATE
  ) fail(code);
  const capabilities = denseArray(object.capabilities, code).map(declaration);
  if (capabilities.length === 0) fail(code);
  const ids = new Set(capabilities.map(({ id }) => id));
  if (ids.size !== capabilities.length) fail(code);
  return Object.freeze({
    $schema: CAPABILITY_DESCRIPTOR_SCHEMA_ID,
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    descriptor_version: CAPABILITY_DESCRIPTOR_VERSION,
    undeclared_capability_state: CAPABILITY_UNDECLARED_STATE,
    capabilities: Object.freeze(capabilities),
  });
}

export function supportsCapability(
  descriptor: CapabilityDescriptorV1,
  query: CapabilitySupportQuery,
): boolean {
  try {
    const object = dataObject(
      query, ["id", "version", "version_range"], ["id"], "invalid_descriptor",
    );
    const id = stringValue(
      object.id, CAPABILITY_ID_PATTERN, 255, "invalid_descriptor",
    );
    const requested = versionContract(object, "invalid_descriptor");
    const snapshot = validateCapabilityDescriptor(descriptor);
    const found = snapshot.capabilities.find((item) => item.id === id);
    if (!found || found.state === "unsupported" || found.state === "unknown") {
      return false;
    }
    return Object.hasOwn(requested, "version") === Object.hasOwn(found, "version") &&
      ("version" in requested
        ? requested.version === found.version
        : requested.version_range === found.version_range);
  } catch {
    return false;
  }
}
