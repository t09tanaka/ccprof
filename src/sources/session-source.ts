import { types as utilTypes } from "node:util";

import {
  ALL_SESSION_CAPABILITIES,
  type JsonObject,
  type JsonValue,
  type NormalizedEvent,
  type Session,
  type SessionCapability,
} from "../core/model.js";
import type {
  SourceAdapterId,
  SourceAdapterVersion,
} from "../core/source-descriptor.js";
import {
  normalizeSourceAdapterId,
  projectLegacySourceAdapterId,
  projectSourceAdapterIdV1,
} from "../core/source-identity.js";
import type { AnalysisBudgetMeter } from "../analysis/budgets.js";

export interface SessionQuery {
  repoRoot: string;
  headBranch: string;
  startedAtMs: number;
  endedAtMs: number;
  analysisBudgetMeter?: AnalysisBudgetMeter;
}

export interface SessionSourceContract {
  adapter_id: SourceAdapterId;
  adapter_version: SourceAdapterVersion;
  capabilities: readonly SessionCapability[];
}
export interface SessionSource {
  readonly contract: SessionSourceContract;
  discover(query: SessionQuery): Promise<Session[]>;
}

export type SessionSourceValidationCode =
  | "invalid_shape" | "unknown_field" | "unknown_adapter"
  | "unsupported_version" | "invalid_capability" | "invalid_discover"
  | "invalid_result" | "adapter_mismatch";
export class SessionSourceValidationError extends Error {
  readonly code: SessionSourceValidationCode;
  constructor(code: SessionSourceValidationCode) {
    super(`invalid session source: ${code}`);
    this.name = "SessionSourceValidationError";
    this.code = code;
  }
}
const VALIDATION_ERRORS = new WeakSet<object>();
export function isSessionSourceValidationError(
  value: unknown,
): value is SessionSourceValidationError {
  return typeof value === "object" && value !== null && VALIDATION_ERRORS.has(value);
}
const CONTRACT_FIELDS = ["adapter_id", "adapter_version", "capabilities"] as const;
const CONTRACT_FIELD_SET = new Set<string>(CONTRACT_FIELDS);
const CAPABILITY_SET = new Set<string>(ALL_SESSION_CAPABILITIES);
const MAX_DISCOVERY_ITEMS = 100_000;
const MAX_JSON_DEPTH = 256;
const MAX_JSON_VALUES = 100_000;
const MAX_JSON_UTF8_BYTES = 8 * 1024 * 1024;
function fail(code: SessionSourceValidationCode): never {
  const error = new SessionSourceValidationError(code);
  VALIDATION_ERRORS.add(error);
  throw error;
}
function canonicalBuiltinSourceAdapterId(
  value: unknown,
  code: SessionSourceValidationCode,
): SourceAdapterId {
  let normalized: SourceAdapterId;
  try {
    normalized = normalizeSourceAdapterId(value);
  } catch {
    return fail(code);
  }
  if (projectLegacySourceAdapterId(normalized) === undefined) return fail(code);
  return normalized;
}
function denseArrayValues(
  value: unknown,
  code: "invalid_capability" | "invalid_result",
  maximumLength = MAX_DISCOVERY_ITEMS,
  allowBoundedWarningPush = false,
): unknown[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) return fail(code);
  let prototype: object | null;
  let length: PropertyDescriptor | undefined;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    length = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return fail(code);
  }
  if (prototype !== Array.prototype) return fail(code);
  if (
    length === undefined || !("value" in length) ||
    !Number.isSafeInteger(length.value) || length.value < 0 ||
    length.value > maximumLength
  ) return fail(code);
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
      PropertyDescriptorMap;
  } catch {
    return fail(code);
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  const push = descriptors.push;
  const hasAllowedPush = allowBoundedWarningPush &&
    push !== undefined && "value" in push &&
    typeof push.value === "function" && push.enumerable === true &&
    push.configurable === true && push.writable === true;
  if (
    ownKeys.length !== length.value + 1 + (hasAllowedPush ? 1 : 0) ||
    ownKeys.some((key) =>
      key !== "length" && !(hasAllowedPush && key === "push") &&
      (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key))
    )
  ) return fail(code);
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[index.toString(10)];
    if (
      descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) return fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function warningArrayValues(value: unknown): unknown[] {
  return denseArrayValues(
    value,
    "invalid_result",
    MAX_DISCOVERY_ITEMS,
    true,
  );
}
function validatedCapabilities(
  value: unknown,
  requireCanonical: boolean,
): readonly SessionCapability[] {
  const values = denseArrayValues(
    value,
    "invalid_capability",
    ALL_SESSION_CAPABILITIES.length,
  );
  const capabilities: SessionCapability[] = [];
  for (const item of values) {
    if (
      typeof item !== "string" || item.includes("\0") ||
      !CAPABILITY_SET.has(item)
    ) return fail("invalid_capability");
    capabilities.push(item as SessionCapability);
  }
  const canonical = [...new Set(capabilities)].sort(compareCodeUnits);
  if (
    canonical.length !== capabilities.length ||
    (requireCanonical && canonical.some((item, index) =>
      item !== capabilities[index]
    ))
  ) return fail("invalid_capability");
  return Object.freeze(canonical);
}
function makeContract(
  adapter_id: SourceAdapterId,
  capabilities: readonly SessionCapability[],
): SessionSourceContract {
  return Object.freeze({
    adapter_id,
    adapter_version: "1.0.0",
    capabilities: validatedCapabilities(capabilities, true),
  });
}
export const CLAUDE_SESSION_SOURCE_CONTRACT = makeContract(
  "claude",
  [...ALL_SESSION_CAPABILITIES].sort(compareCodeUnits),
);
export const CODEX_SESSION_SOURCE_CONTRACT = makeContract(
  "codex",
  ["edit_fragments", "tool_timestamps"],
);
function validateContract(value: unknown): SessionSourceContract {
  if (
    value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) return fail("invalid_shape");
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail("invalid_shape");
  }
  if (prototype !== Object.prototype) return fail("invalid_shape");
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) =>
      typeof key !== "string" || !CONTRACT_FIELD_SET.has(key)
    )
  ) return fail("unknown_field");
  if (CONTRACT_FIELDS.some((field) => !Object.hasOwn(descriptors, field))) {
    return fail("invalid_shape");
  }
  for (const field of CONTRACT_FIELDS) {
    const descriptor = descriptors[field]!;
    if (
      descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail("invalid_shape");
    }
  }
  const adapterId = canonicalBuiltinSourceAdapterId(
    descriptors.adapter_id!.value,
    "unknown_adapter",
  );
  if (descriptors.adapter_version!.value !== "1.0.0") {
    return fail("unsupported_version");
  }
  return makeContract(
    adapterId,
    validatedCapabilities(descriptors.capabilities!.value, true),
  );
}
function ownContract(source: object): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, "contract");
  } catch {
    return fail("invalid_shape");
  }
  if (
    descriptor === undefined || !("value" in descriptor) ||
    descriptor.enumerable !== true
  ) return fail("invalid_shape");
  return descriptor.value;
}
function discoverMethod(
  source: object,
): (this: unknown, query: SessionQuery) => unknown {
  let current: object | null = source;
  while (current !== null && current !== Object.prototype) {
    if (utilTypes.isProxy(current)) return fail("invalid_discover");
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, "discover");
    } catch {
      return fail("invalid_discover");
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        return fail("invalid_discover");
      }
      return descriptor.value as (this: unknown, query: SessionQuery) => unknown;
    }
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return fail("invalid_discover");
    }
  }
  return fail("invalid_discover");
}
function dataObject(
  value: unknown,
  allowNullPrototype = false,
  maximumKeys = MAX_DISCOVERY_ITEMS,
): Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) return fail("invalid_result");
  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return fail("invalid_result");
  }
  if (
    prototype !== Object.prototype &&
    !(allowNullPrototype && prototype === null)
  ) return fail("invalid_result");
  if (keys.length > maximumKeys) return fail("invalid_result");
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string") return fail("invalid_result");
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return fail("invalid_result");
    }
    if (
      descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return fail("invalid_result");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) return fail("invalid_result");
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const snapshot = dataObject(value);
  exactFields(snapshot, required, optional);
  return snapshot;
}

function text(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_result");
  return value;
}

function nonnegativeInteger(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
    Object.is(value, -0)
  ) return fail("invalid_result");
  return value;
}

function safeInteger(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    Object.is(value, -0)
  ) return fail("invalid_result");
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return fail("invalid_result");
  }
  return value as T;
}

function stringArray(value: unknown): string[] {
  return denseArrayValues(value, "invalid_result").map(text);
}

interface JsonBudget {
  values: number;
  utf8Bytes: number;
}

function addJsonText(value: string, budget: JsonBudget): void {
  if (value.length > MAX_JSON_UTF8_BYTES) return fail("invalid_result");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_JSON_UTF8_BYTES - budget.utf8Bytes) {
    return fail("invalid_result");
  }
  budget.utf8Bytes += bytes;
}

function snapshotJson(value: unknown): JsonValue {
  const holder: { value?: JsonValue } = {};
  const seen = new WeakSet<object>();
  const budget: JsonBudget = { values: 0, utf8Bytes: 0 };
  const pending: Array<{
    value: unknown;
    target: object;
    key: string | number;
    depth: number;
  }> = [{ value, target: holder, key: "value", depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    budget.values += 1;
    if (
      budget.values > MAX_JSON_VALUES || current.depth > MAX_JSON_DEPTH
    ) return fail("invalid_result");
    const candidate = current.value;
    if (candidate === null || typeof candidate === "boolean") {
      Reflect.set(current.target, current.key, candidate);
      continue;
    }
    if (typeof candidate === "string") {
      addJsonText(candidate, budget);
      Reflect.set(current.target, current.key, candidate);
      continue;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        return fail("invalid_result");
      }
      Reflect.set(current.target, current.key, candidate);
      continue;
    }
    if (
      candidate === null || typeof candidate !== "object" ||
      utilTypes.isProxy(candidate) || seen.has(candidate)
    ) return fail("invalid_result");
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      const values = denseArrayValues(
        candidate,
        "invalid_result",
        MAX_JSON_VALUES - budget.values,
      );
      const snapshot = new Array<JsonValue>(values.length);
      Reflect.set(current.target, current.key, snapshot);
      for (let index = values.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: values[index],
          target: snapshot,
          key: index,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    const values = dataObject(
      candidate,
      true,
      MAX_JSON_VALUES - budget.values,
    );
    const keys = Object.keys(values);
    if (keys.length > MAX_JSON_VALUES - budget.values) {
      return fail("invalid_result");
    }
    const snapshot: JsonObject = {};
    Reflect.set(current.target, current.key, snapshot);
    for (const key of keys) {
      addJsonText(key, budget);
      Object.defineProperty(snapshot, key, {
        value: null,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      pending.push({
        value: values[key],
        target: snapshot,
        key,
        depth: current.depth + 1,
      });
    }
  }
  return holder.value!;
}

const EVENT_BASE_REQUIRED = [
  "timestamp_ms", "session_id", "entry_uuid", "session_ref", "source_index",
  "agent_id", "is_sidechain", "confidence", "kind",
] as const;
const EVENT_BASE_OPTIONAL = [
  "event_identity", "parent_uuid", "branch", "branch_epoch",
] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;
const RESULT_STATUSES = [
  "success", "failure", "timeout", "cancelled", "unknown",
] as const;
const RESULT_STATUS_SOURCES = [
  "explicit_status", "exit_code", "tool_adapter", "output_pattern", "none",
] as const;

function eventIdentitySnapshot(
  value: unknown,
  session: Pick<Session, "session_id" | "source" | "source_path">,
  event: Pick<NormalizedEvent, "agent_id" | "source_index"> & {
    tool_use_id?: string;
  },
): NonNullable<NormalizedEvent["event_identity"]> {
  const row = exactObject(
    value,
    [
      "source_adapter_id", "source_instance_id", "session_id", "agent_id",
      "source_index",
    ],
    ["tool_use_id"],
  );
  const sourceAdapterId = canonicalBuiltinSourceAdapterId(
    row.source_adapter_id,
    "invalid_result",
  );
  const identity = {
    source_adapter_id: projectSourceAdapterIdV1(sourceAdapterId),
    source_instance_id: text(row.source_instance_id),
    session_id: text(row.session_id),
    agent_id: text(row.agent_id),
    ...(row.tool_use_id === undefined
      ? {}
      : { tool_use_id: text(row.tool_use_id) }),
    source_index: nonnegativeInteger(row.source_index),
  };
  if (
    sourceAdapterId !== session.source ||
    identity.source_instance_id !== session.source_path ||
    identity.session_id !== session.session_id ||
    identity.agent_id !== event.agent_id ||
    identity.source_index !== event.source_index ||
    identity.tool_use_id !== event.tool_use_id
  ) return fail("invalid_result");
  return identity;
}

function approvalSnapshot(value: unknown): NonNullable<
  Extract<NormalizedEvent, { kind: "tool_use" }>["approval"]
> {
  const row = exactObject(value, ["required"], ["reason"]);
  if (typeof row.required !== "boolean") return fail("invalid_result");
  return {
    required: row.required,
    ...(row.reason === undefined ? {} : { reason: text(row.reason) }),
  };
}

function statusEvidenceSnapshot(value: unknown): NonNullable<
  Extract<NormalizedEvent, { kind: "tool_result" }>["status_evidence"]
> {
  const row = exactObject(value, ["status", "source", "confidence"]);
  return {
    status: oneOf(row.status, RESULT_STATUSES),
    source: oneOf(row.source, RESULT_STATUS_SOURCES),
    confidence: oneOf(row.confidence, CONFIDENCES),
  };
}

function eventSnapshot(
  value: unknown,
  session: Pick<Session, "session_id" | "source" | "source_path">,
): NormalizedEvent {
  const row = dataObject(value);
  const kind = oneOf(row.kind, [
    "genuine_user", "assistant", "tool_use", "tool_result", "compaction",
  ] as const);
  const required = kind === "genuine_user"
    ? [...EVENT_BASE_REQUIRED, "text"]
    : kind === "assistant"
      ? [...EVENT_BASE_REQUIRED, "text"]
      : kind === "tool_use"
        ? [
            ...EVENT_BASE_REQUIRED, "tool_use_id", "tool_name", "input",
            "paths", "edit_fragments",
          ]
        : kind === "tool_result"
          ? [
              ...EVENT_BASE_REQUIRED, "tool_use_id", "status", "output",
              "output_bytes", "estimated_tokens",
            ]
          : [...EVENT_BASE_REQUIRED, "summary"];
  const optional = kind === "assistant"
    ? [...EVENT_BASE_OPTIONAL, "message_id", "input_tokens", "output_tokens"]
    : kind === "tool_use"
      ? [...EVENT_BASE_OPTIONAL, "command", "cwd", "approval"]
      : kind === "tool_result"
        ? [...EVENT_BASE_OPTIONAL, "status_evidence", "exit_code"]
        : kind === "compaction"
          ? [...EVENT_BASE_OPTIONAL, "estimated_tokens"]
          : [...EVENT_BASE_OPTIONAL];
  exactFields(row, required, optional);
  const sessionId = text(row.session_id);
  const sourceIndex = nonnegativeInteger(row.source_index);
  const agentId = text(row.agent_id);
  if (sessionId !== session.session_id) return fail("invalid_result");
  const toolUseId = kind === "tool_use" || kind === "tool_result"
    ? text(row.tool_use_id)
    : undefined;
  const eventIdentity = row.event_identity === undefined
    ? undefined
    : eventIdentitySnapshot(row.event_identity, session, {
        agent_id: agentId,
        source_index: sourceIndex,
        ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
      });
  const base = {
    timestamp_ms: nonnegativeInteger(row.timestamp_ms),
    session_id: sessionId,
    entry_uuid: text(row.entry_uuid),
    session_ref: text(row.session_ref),
    source_index: sourceIndex,
    agent_id: agentId,
    is_sidechain: typeof row.is_sidechain === "boolean"
      ? row.is_sidechain
      : fail("invalid_result"),
    confidence: oneOf(row.confidence, CONFIDENCES),
    ...(eventIdentity === undefined ? {} : { event_identity: eventIdentity }),
    ...(row.parent_uuid === undefined
      ? {}
      : { parent_uuid: text(row.parent_uuid) }),
    ...(row.branch === undefined ? {} : { branch: text(row.branch) }),
    ...(row.branch_epoch === undefined
      ? {}
      : { branch_epoch: nonnegativeInteger(row.branch_epoch) }),
  };
  if (kind === "genuine_user") {
    return { ...base, kind, text: text(row.text) };
  }
  if (kind === "assistant") {
    return {
      ...base,
      kind,
      text: text(row.text),
      ...(row.message_id === undefined
        ? {}
        : { message_id: text(row.message_id) }),
      ...(row.input_tokens === undefined
        ? {}
        : { input_tokens: nonnegativeInteger(row.input_tokens) }),
      ...(row.output_tokens === undefined
        ? {}
        : { output_tokens: nonnegativeInteger(row.output_tokens) }),
    };
  }
  if (kind === "tool_use") {
    const input = snapshotJson(row.input);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return fail("invalid_result");
    }
    return {
      ...base,
      kind,
      tool_use_id: toolUseId!,
      tool_name: text(row.tool_name),
      input,
      paths: stringArray(row.paths),
      edit_fragments: stringArray(row.edit_fragments),
      ...(row.command === undefined ? {} : { command: text(row.command) }),
      ...(row.cwd === undefined ? {} : { cwd: text(row.cwd) }),
      ...(row.approval === undefined
        ? {}
        : { approval: approvalSnapshot(row.approval) }),
    };
  }
  if (kind === "tool_result") {
    const status = oneOf(row.status, RESULT_STATUSES);
    const statusEvidence = row.status_evidence === undefined
      ? undefined
      : statusEvidenceSnapshot(row.status_evidence);
    if (statusEvidence !== undefined && statusEvidence.status !== status) {
      return fail("invalid_result");
    }
    return {
      ...base,
      kind,
      tool_use_id: toolUseId!,
      status,
      ...(statusEvidence === undefined
        ? {}
        : { status_evidence: statusEvidence }),
      output: text(row.output),
      output_bytes: nonnegativeInteger(row.output_bytes),
      estimated_tokens: nonnegativeInteger(row.estimated_tokens),
      ...(row.exit_code === undefined
        ? {}
        : { exit_code: safeInteger(row.exit_code) }),
    };
  }
  return {
    ...base,
    kind,
    summary: text(row.summary),
    ...(row.estimated_tokens === undefined
      ? {}
      : { estimated_tokens: nonnegativeInteger(row.estimated_tokens) }),
  };
}

function warningSnapshot(value: unknown): Session["warnings"][number] {
  const row = exactObject(
    value,
    ["code", "message", "source_path"],
    ["line", "session_ref"],
  );
  return {
    code: text(row.code),
    message: text(row.message),
    source_path: text(row.source_path),
    ...(row.line === undefined ? {} : { line: nonnegativeInteger(row.line) }),
    ...(row.session_ref === undefined
      ? {}
      : { session_ref: text(row.session_ref) }),
  };
}

function validateDiscoveredSessions(
  value: unknown,
  contract: SessionSourceContract,
): Session[] {
  return denseArrayValues(value, "invalid_result").map((candidate) => {
    const snapshot = dataObject(candidate);
    exactFields(snapshot, [
      "session_id", "source", "source_path", "observed_cwds",
      "observed_branches", "started_at_ms", "ended_at_ms", "confidence",
      "events", "warnings",
    ], ["capabilities", "verified_ended_at_ms"]);
    const source = canonicalBuiltinSourceAdapterId(
      snapshot.source,
      "adapter_mismatch",
    );
    if (source !== contract.adapter_id) return fail("adapter_mismatch");
    const capabilities = snapshot.capabilities === undefined
      ? contract.capabilities
      : validatedCapabilities(snapshot.capabilities, false);
    const declared = new Set(contract.capabilities);
    if (capabilities.some((capability) => !declared.has(capability))) {
      return fail("invalid_capability");
    }
    const sessionId = text(snapshot.session_id);
    const sourcePath = text(snapshot.source_path);
    const sessionIdentity = {
      session_id: sessionId,
      source,
      source_path: sourcePath,
    };
    return {
      session_id: sessionId,
      source,
      source_path: sourcePath,
      observed_cwds: stringArray(snapshot.observed_cwds),
      observed_branches: stringArray(snapshot.observed_branches),
      started_at_ms: nonnegativeInteger(snapshot.started_at_ms),
      ended_at_ms: nonnegativeInteger(snapshot.ended_at_ms),
      confidence: oneOf(snapshot.confidence, CONFIDENCES),
      events: denseArrayValues(snapshot.events, "invalid_result").map((event) =>
        eventSnapshot(event, sessionIdentity)
      ),
      warnings: warningArrayValues(snapshot.warnings).map(
        warningSnapshot,
      ),
      capabilities: Object.freeze([...capabilities]),
      ...(snapshot.verified_ended_at_ms === undefined
        ? {}
        : {
            verified_ended_at_ms: nonnegativeInteger(
              snapshot.verified_ended_at_ms,
            ),
          }),
    };
  });
}

function normalizeDiscoveredSessions(
  value: unknown,
  contract: SessionSourceContract,
): Session[] {
  try {
    return validateDiscoveredSessions(value, contract);
  } catch (error) {
    if (isSessionSourceValidationError(error)) throw error;
    return fail("invalid_result");
  }
}

function isRevokedProxyResultError(value: unknown): boolean {
  if (
    value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    !utilTypes.isNativeError(value)
  ) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "message");
    return Object.getPrototypeOf(value) === TypeError.prototype &&
      descriptor !== undefined && "value" in descriptor &&
      descriptor.value === "Cannot perform 'get' on a proxy that has been revoked";
  } catch {
    return false;
  }
}

export function validateSessionSource(value: unknown): SessionSource {
  if (
    value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) return fail("invalid_shape");
  const contract = validateContract(ownContract(value));
  const discover = discoverMethod(value);
  return Object.freeze({
    contract,
    async discover(query: SessionQuery): Promise<Session[]> {
      let result: unknown;
      try {
        result = await discover.call(value, query);
      } catch (error) {
        if (isRevokedProxyResultError(error)) return fail("invalid_result");
        throw error;
      }
      return normalizeDiscoveredSessions(result, contract);
    },
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptionalCodeUnits(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareCodeUnits(left, right);
}

function toolUseId(event: Session["events"][number]): string | undefined {
  return event.kind === "tool_use" || event.kind === "tool_result"
    ? event.tool_use_id
    : undefined;
}

function eventConfidence(
  events: readonly Session["events"][number][],
): Session["confidence"] {
  let confidence: Session["confidence"] = "high";
  for (const event of events) {
    if (event.confidence === "low") return "low";
    if (event.confidence === "medium") confidence = "medium";
  }
  return confidence;
}

export function admitSessionEventPrefix(
  sessions: readonly Session[],
  meter: AnalysisBudgetMeter,
): Session[] {
  const physicalOrder = sessions.flatMap((session, sessionIndex) =>
    session.events.map((event, eventIndex) => ({
      event,
      eventIndex,
      session,
      sessionIndex,
    }))
  ).sort((left, right) =>
    left.event.source_index - right.event.source_index ||
    compareCodeUnits(left.session.source_path, right.session.source_path) ||
    compareCodeUnits(left.session.source, right.session.source) ||
    compareCodeUnits(left.event.session_id, right.event.session_id) ||
    compareCodeUnits(left.event.agent_id, right.event.agent_id) ||
    compareOptionalCodeUnits(
      toolUseId(left.event),
      toolUseId(right.event),
    ) ||
    compareCodeUnits(left.event.session_ref, right.event.session_ref) ||
    compareCodeUnits(left.event.entry_uuid, right.event.entry_uuid) ||
    compareCodeUnits(left.event.kind, right.event.kind) ||
    left.sessionIndex - right.sessionIndex ||
    left.eventIndex - right.eventIndex
  );
  const admittedCount = meter.admitInputEvents(physicalOrder.length);
  const truncated = admittedCount < physicalOrder.length;
  const admittedBySession = new Map<number, Session["events"]>();
  for (const { event, sessionIndex } of physicalOrder.slice(0, admittedCount)) {
    const events = admittedBySession.get(sessionIndex);
    if (events === undefined) admittedBySession.set(sessionIndex, [event]);
    else events.push(event);
  }
  return sessions.flatMap((session, sessionIndex) => {
    const events = admittedBySession.get(sessionIndex);
    if (events === undefined || events.length === 0) return [];
    let startedAtMs = events[0]!.timestamp_ms;
    let endedAtMs = startedAtMs;
    for (const { timestamp_ms: timestampMs } of events) {
      if (timestampMs < startedAtMs) startedAtMs = timestampMs;
      if (timestampMs > endedAtMs) endedAtMs = timestampMs;
    }
    const admittedSessionRefs = new Set(
      events.map(({ session_ref }) => session_ref),
    );
    const lastSourceIndex = events.reduce(
      (last, { source_index }) => Math.max(last, source_index),
      -1,
    );
    const lastSourceLine = lastSourceIndex + (
      projectSourceAdapterIdV1(session.source) === "claude" ? 1 : 0
    );
    const observedCwds = [...new Set(events.flatMap((event) =>
      event.kind === "tool_use" && event.cwd !== undefined && event.cwd !== ""
        ? [event.cwd]
        : []
    ))];
    const observedBranches = [...new Set(events.flatMap(({ branch }) =>
      branch === undefined ? [] : [branch]
    ))];
    const warnings = session.warnings.filter((warning) => {
      if (!truncated) return true;
      if (
        warning.session_ref !== undefined &&
        !admittedSessionRefs.has(warning.session_ref)
      ) {
        return false;
      }
      if (warning.line !== undefined && warning.line > lastSourceLine) {
        return false;
      }
      return warning.session_ref !== undefined || warning.line !== undefined;
    });
    const baseSession = (() => {
      if (!truncated) return session;
      const { verified_ended_at_ms: _verifiedEndedAtMs, ...rest } = session;
      return rest;
    })();
    return [{
      ...baseSession,
      ...(truncated
        ? {
            observed_cwds: observedCwds,
            observed_branches: observedBranches,
            confidence: eventConfidence(events),
          }
        : {}),
      events,
      started_at_ms: startedAtMs,
      ended_at_ms: endedAtMs,
      warnings,
    }];
  });
}
