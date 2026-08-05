import { createHash } from "node:crypto";

import {
  ALL_SESSION_CAPABILITIES,
  type Session,
  type SessionCapability,
} from "./model.js";
import {
  compareSourceIdentities,
  projectLegacySourceAdapterId,
  type LegacySourceAdapterId,
  type LegacySourceKind,
  type SourceAdapterId,
  type SourceKind,
} from "./source-identity.js";

export type { SourceAdapterId, SourceKind } from "./source-identity.js";
export type SourceAdapterVersion = "1.0.0";
export type SourceProvenance = "local_filesystem";
export type SourceSensitivity = "sensitive";
export type SourceRetentionClass = "raw_evidence";

export interface SourceDescriptor {
  adapter_id: SourceAdapterId;
  adapter_version: SourceAdapterVersion;
  source_instance_id: string;
  source_kind: SourceKind;
  provided_capabilities: SessionCapability[];
  required_capabilities: SessionCapability[];
  provenance: SourceProvenance;
  sensitivity: SourceSensitivity;
  retention_class: SourceRetentionClass;
  canonical_fingerprint: string;
}

export type SourceDescriptorValidationCode =
  | "invalid_shape"
  | "unknown_field"
  | "unknown_adapter"
  | "unsupported_version"
  | "invalid_field"
  | "invalid_capability"
  | "registry_mismatch"
  | "invalid_fingerprint"
  | "duplicate_source";

export class SourceDescriptorValidationError extends Error {
  readonly code: SourceDescriptorValidationCode;

  constructor(code: SourceDescriptorValidationCode) {
    super(`invalid source descriptor: ${code}`);
    this.name = "SourceDescriptorValidationError";
    this.code = code;
  }
}

interface RegistryEntry {
  adapter_id: LegacySourceAdapterId;
  adapter_version: SourceAdapterVersion;
  source_kind: LegacySourceKind;
  required_capabilities: readonly SessionCapability[];
  provenance: SourceProvenance;
  sensitivity: SourceSensitivity;
  retention_class: SourceRetentionClass;
}

const BUILTIN_SOURCE_REGISTRY: Readonly<
  Record<LegacySourceAdapterId, RegistryEntry>
> = {
  claude: {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    source_kind: "claude_transcript_jsonl",
    required_capabilities: [],
    provenance: "local_filesystem",
    sensitivity: "sensitive",
    retention_class: "raw_evidence",
  },
  codex: {
    adapter_id: "codex",
    adapter_version: "1.0.0",
    source_kind: "codex_rollout_jsonl",
    required_capabilities: [],
    provenance: "local_filesystem",
    sensitivity: "sensitive",
    retention_class: "raw_evidence",
  },
};

const DESCRIPTOR_FIELDS = [
  "adapter_id",
  "adapter_version",
  "source_instance_id",
  "source_kind",
  "provided_capabilities",
  "required_capabilities",
  "provenance",
  "sensitivity",
  "retention_class",
  "canonical_fingerprint",
] as const;
const DESCRIPTOR_FIELD_SET = new Set<string>(DESCRIPTOR_FIELDS);
const CAPABILITY_SET = new Set<string>(ALL_SESSION_CAPABILITIES);
const SOURCE_INSTANCE_PATTERN = /^source-[a-f0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function fail(code: SourceDescriptorValidationCode): never {
  throw new SourceDescriptorValidationError(code);
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

function sortedCapabilities(
  capabilities: readonly SessionCapability[],
): SessionCapability[] {
  return [...new Set(capabilities)].sort(compareSourceIdentities);
}

function descriptorFingerprint(
  descriptor: Omit<SourceDescriptor, "canonical_fingerprint">,
): string {
  const canonical = [
    descriptor.adapter_id,
    descriptor.adapter_version,
    descriptor.source_instance_id,
    descriptor.source_kind,
    descriptor.provided_capabilities,
    descriptor.required_capabilities,
    descriptor.provenance,
    descriptor.sensitivity,
    descriptor.retention_class,
  ];
  return `sha256:${digest("ccprof:source-descriptor:v1", canonical)}`;
}

function registryEntry(adapterId: string): RegistryEntry {
  if (adapterId !== "claude" && adapterId !== "codex") {
    return fail("unknown_adapter");
  }
  return BUILTIN_SOURCE_REGISTRY[adapterId];
}

function derivationRegistryEntry(adapterId: string): RegistryEntry {
  const legacyAdapterId = adapterId === "claude" || adapterId === "codex"
    ? adapterId
    : projectLegacySourceAdapterId(adapterId);
  if (legacyAdapterId === undefined) return fail("unknown_adapter");
  return registryEntry(legacyAdapterId);
}

export function deriveSourceDescriptor(
  session: Pick<
    Session,
    "capabilities" | "session_id" | "source" | "source_path"
  >,
): SourceDescriptor {
  if (
    session.session_id === "" ||
    session.session_id.includes("\0") ||
    session.source_path === "" ||
    session.source_path.includes("\0")
  ) {
    return fail("invalid_field");
  }
  const registry = derivationRegistryEntry(session.source);
  const provided = sortedCapabilities(
    session.capabilities ?? ALL_SESSION_CAPABILITIES,
  );
  const sourceInstanceId = `source-${digest("ccprof:source-instance:v1", [
    registry.adapter_id,
    session.session_id.normalize("NFC"),
  ])}`;
  const base: Omit<SourceDescriptor, "canonical_fingerprint"> = {
    adapter_id: registry.adapter_id,
    adapter_version: registry.adapter_version,
    source_instance_id: sourceInstanceId,
    source_kind: registry.source_kind,
    provided_capabilities: provided,
    required_capabilities: [...registry.required_capabilities],
    provenance: registry.provenance,
    sensitivity: registry.sensitivity,
    retention_class: registry.retention_class,
  };
  return { ...base, canonical_fingerprint: descriptorFingerprint(base) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatedCapabilities(value: unknown): SessionCapability[] {
  if (!Array.isArray(value)) return fail("invalid_capability");
  const capabilities: SessionCapability[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.includes("\0") || !CAPABILITY_SET.has(item)) {
      return fail("invalid_capability");
    }
    capabilities.push(item as SessionCapability);
  }
  const canonical = sortedCapabilities(capabilities);
  if (
    canonical.length !== capabilities.length ||
    canonical.some((item, index) => item !== capabilities[index])
  ) {
    return fail("invalid_capability");
  }
  return canonical;
}

export function validateSourceDescriptor(value: unknown): SourceDescriptor {
  if (!isRecord(value)) return fail("invalid_shape");
  const keys = Object.keys(value);
  if (keys.some((key) => !DESCRIPTOR_FIELD_SET.has(key))) {
    return fail("unknown_field");
  }
  if (DESCRIPTOR_FIELDS.some((field) => !Object.hasOwn(value, field))) {
    return fail("invalid_shape");
  }
  if (Object.values(value).some((item) =>
    typeof item === "string" && item.includes("\0")
  )) {
    return fail("invalid_field");
  }
  const adapter = typeof value.adapter_id === "string"
    ? registryEntry(value.adapter_id)
    : fail("unknown_adapter");
  if (value.adapter_version !== adapter.adapter_version) {
    return fail("unsupported_version");
  }
  if (
    typeof value.source_instance_id !== "string" ||
    !SOURCE_INSTANCE_PATTERN.test(value.source_instance_id)
  ) {
    return fail("invalid_field");
  }
  const provided = validatedCapabilities(value.provided_capabilities);
  const required = validatedCapabilities(value.required_capabilities);
  if (
    value.source_kind !== adapter.source_kind ||
    value.provenance !== adapter.provenance ||
    value.sensitivity !== adapter.sensitivity ||
    value.retention_class !== adapter.retention_class ||
    required.length !== adapter.required_capabilities.length ||
    required.some((item, index) => item !== adapter.required_capabilities[index])
  ) {
    return fail("registry_mismatch");
  }
  if (
    typeof value.canonical_fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(value.canonical_fingerprint)
  ) {
    return fail("invalid_fingerprint");
  }
  const base: Omit<SourceDescriptor, "canonical_fingerprint"> = {
    adapter_id: adapter.adapter_id,
    adapter_version: adapter.adapter_version,
    source_instance_id: value.source_instance_id,
    source_kind: adapter.source_kind,
    provided_capabilities: provided,
    required_capabilities: required,
    provenance: adapter.provenance,
    sensitivity: adapter.sensitivity,
    retention_class: adapter.retention_class,
  };
  if (value.canonical_fingerprint !== descriptorFingerprint(base)) {
    return fail("invalid_fingerprint");
  }
  return { ...base, canonical_fingerprint: value.canonical_fingerprint };
}

export function validateSourceDescriptors(value: unknown): SourceDescriptor[] {
  if (!Array.isArray(value)) return fail("invalid_shape");
  const descriptors = value.map(validateSourceDescriptor);
  const identities = new Set<string>();
  for (const descriptor of descriptors) {
    const identity = descriptor.source_instance_id;
    if (identities.has(identity)) return fail("duplicate_source");
    identities.add(identity);
  }
  return descriptors;
}

export function sourceDescriptorsForSessions(
  sessions: readonly Pick<
    Session,
    "capabilities" | "session_id" | "source" | "source_path"
  >[],
): SourceDescriptor[] {
  const descriptors = new Map<string, SourceDescriptor>();
  for (const session of sessions) {
    const descriptor = deriveSourceDescriptor(session);
    const key = `${descriptor.adapter_id}\0${descriptor.source_instance_id}`;
    const previous = descriptors.get(key);
    if (
      previous !== undefined &&
      previous.canonical_fingerprint !== descriptor.canonical_fingerprint
    ) {
      return fail("registry_mismatch");
    }
    descriptors.set(key, descriptor);
  }
  return [...descriptors.values()].sort((left, right) =>
    compareSourceIdentities(left.adapter_id, right.adapter_id) ||
    compareSourceIdentities(left.source_instance_id, right.source_instance_id)
  );
}
