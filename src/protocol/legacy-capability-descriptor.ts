import { types as utilTypes } from "node:util";

import {
  CAPABILITY_DESCRIPTOR_SCHEMA_ID,
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_DESCRIPTOR_VERSION,
  CAPABILITY_UNDECLARED_STATE,
  validateCapabilityDescriptor,
  type CapabilityDeclarationV1,
  type CapabilityDescriptorV1,
} from "./capability-descriptor.js";

export const LEGACY_CAPABILITY_IDS = Object.freeze([
  "approvals",
  "branch_rows",
  "edit_fragments",
  "sidechains",
  "token_usage",
  "tool_timestamps",
] as const);
export type LegacyCapabilityId = typeof LEGACY_CAPABILITY_IDS[number];

export type LegacyCapabilityValidationCode = "invalid_legacy_capabilities";
export class LegacyCapabilityValidationError extends TypeError {
  readonly code: LegacyCapabilityValidationCode;

  constructor(code: LegacyCapabilityValidationCode) {
    super(`invalid legacy capabilities: ${code}`);
    this.name = "LegacyCapabilityValidationError";
    this.code = code;
  }
}

const LEGACY_CAPABILITY_SET = new Set<string>(LEGACY_CAPABILITY_IDS);

function fail(): never {
  throw new LegacyCapabilityValidationError("invalid_legacy_capabilities");
}

function legacyCapabilityValues(value: unknown): LegacyCapabilityId[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) fail();

  let prototype: object | null;
  let length: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    length = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return fail();
  }
  if (
    prototype !== Array.prototype || length === undefined ||
    !("value" in length) || !Number.isSafeInteger(length.value) ||
    length.value < 0 || length.value > LEGACY_CAPABILITY_IDS.length
  ) fail();

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
      PropertyDescriptorMap;
  } catch {
    return fail();
  }
  if (Reflect.ownKeys(descriptors).length !== length.value + 1) fail();

  const result: LegacyCapabilityId[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true || typeof descriptor.value !== "string" ||
      !LEGACY_CAPABILITY_SET.has(descriptor.value) || seen.has(descriptor.value)
    ) fail();
    seen.add(descriptor.value);
    result.push(descriptor.value as LegacyCapabilityId);
  }
  return result;
}

function declaration(
  legacyId: LegacyCapabilityId,
  present: boolean,
): CapabilityDeclarationV1 {
  return {
    id: `ccprof.dev/capabilities/${legacyId}`,
    legacy_id: legacyId,
    version: CAPABILITY_DESCRIPTOR_VERSION,
    requirement: "optional",
    state: present ? "supported_partial" : "unsupported",
    evidence: {
      quality: present ? "unknown" : "none",
      provenance: "adapter_declared",
    },
    timestamp_precision: present && legacyId === "tool_timestamps"
      ? "unknown"
      : "not_applicable",
  };
}

export function legacyCapabilitiesToDescriptor(
  value: unknown,
): CapabilityDescriptorV1 {
  const present = new Set(legacyCapabilityValues(value));
  return validateCapabilityDescriptor({
    $schema: CAPABILITY_DESCRIPTOR_SCHEMA_ID,
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    descriptor_version: CAPABILITY_DESCRIPTOR_VERSION,
    undeclared_capability_state: CAPABILITY_UNDECLARED_STATE,
    capabilities: LEGACY_CAPABILITY_IDS.map((legacyId) =>
      declaration(legacyId, present.has(legacyId))
    ),
  });
}
