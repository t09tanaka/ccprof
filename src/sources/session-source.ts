import { types as utilTypes } from "node:util";

import {
  ALL_SESSION_CAPABILITIES,
  type Session,
  type SessionCapability,
} from "../core/model.js";
import type { SourceAdapterId, SourceAdapterVersion } from "../core/source-descriptor.js";
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

const CONTRACT_FIELDS = ["adapter_id", "adapter_version", "capabilities"] as const;
const CONTRACT_FIELD_SET = new Set<string>(CONTRACT_FIELDS);
const CAPABILITY_SET = new Set<string>(ALL_SESSION_CAPABILITIES);
function fail(code: SessionSourceValidationCode): never {
  throw new SessionSourceValidationError(code);
}

function denseArrayValues(
  value: unknown,
  code: "invalid_capability" | "invalid_result",
): unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return fail(code);
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch {
    return fail(code);
  }
  if (prototype !== Array.prototype) return fail(code);
  const length = descriptors.length;
  if (
    length === undefined || !("value" in length) ||
    !Number.isSafeInteger(length.value) || length.value < 0
  ) return fail(code);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== length.value + 1 ||
    ownKeys.some((key) =>
      key !== "length" &&
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

function validatedCapabilities(
  value: unknown,
  requireCanonical: boolean,
): readonly SessionCapability[] {
  const values = denseArrayValues(value, "invalid_capability");
  if (values.length > ALL_SESSION_CAPABILITIES.length) {
    return fail("invalid_capability");
  }
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
export const CLAUDE_SESSION_SOURCE_CONTRACT = makeContract("claude", [...ALL_SESSION_CAPABILITIES].sort(compareCodeUnits));
export const CODEX_SESSION_SOURCE_CONTRACT = makeContract("codex", ["edit_fragments", "tool_timestamps"]);
function validateContract(value: unknown): SessionSourceContract {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    utilTypes.isProxy(value)
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
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      return fail("invalid_shape");
    }
  }
  const adapterId = descriptors.adapter_id!.value;
  if (adapterId !== "claude" && adapterId !== "codex") {
    return fail("unknown_adapter");
  }
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

function sessionSnapshot(value: unknown): Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return fail("invalid_result");
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail("invalid_result");
  }
  if (prototype !== Object.prototype) return fail("invalid_result");
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return fail("invalid_result");
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      return fail("invalid_result");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function validateDiscoveredSessions(
  value: unknown,
  contract: SessionSourceContract,
): Session[] {
  return denseArrayValues(value, "invalid_result").map((candidate) => {
    const snapshot = sessionSnapshot(candidate);
    if (snapshot.source !== contract.adapter_id) return fail("adapter_mismatch");
    const capabilities = snapshot.capabilities === undefined
      ? contract.capabilities
      : validatedCapabilities(snapshot.capabilities, false);
    const declared = new Set(contract.capabilities);
    if (capabilities.some((capability) => !declared.has(capability))) {
      return fail("invalid_capability");
    }
    return {
      ...snapshot,
      capabilities: Object.freeze([...capabilities]),
    } as unknown as Session;
  });
}

export function validateSessionSource(value: unknown): SessionSource {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) return fail("invalid_shape");
  const contract = validateContract(ownContract(value));
  const discover = discoverMethod(value);
  return Object.freeze({
    contract,
    async discover(query: SessionQuery): Promise<Session[]> {
      const result = await discover.call(value, query);
      return validateDiscoveredSessions(result, contract);
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
    const lastSourceLine =
      lastSourceIndex + (session.source === "claude" ? 1 : 0);
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
