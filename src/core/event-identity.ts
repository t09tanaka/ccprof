import type {
  NormalizedEvent,
  Session,
  TimelineAction,
} from "./model.js";

export interface EventIdentity {
  source_adapter_id: string;
  source_instance_id: string;
  session_id: string;
  agent_id: string;
  tool_use_id?: string;
  source_index: number;
}

type CanonicalValue = number | string | undefined;

const UNATTRIBUTED_SOURCE_ADAPTER = "ccprof:unattributed";
const UNATTRIBUTED_SOURCE_INSTANCE = "ccprof:unattributed";

function tagged(value: CanonicalValue): readonly unknown[] {
  if (value === undefined) return ["absent"];
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("identity numbers must be safe integers");
    }
    return ["number", value];
  }
  return ["string", value];
}

function encode(
  domain: string,
  values: readonly CanonicalValue[],
): string {
  return JSON.stringify([
    "ccprof:event-identity",
    1,
    tagged(domain),
    ...values.map(tagged),
  ]);
}

function toolUseId(event: NormalizedEvent): string | undefined {
  return event.kind === "tool_use" || event.kind === "tool_result"
    ? event.tool_use_id
    : undefined;
}

export function eventIdentity(
  session: Pick<Session, "source" | "source_path">,
  event: NormalizedEvent,
): EventIdentity {
  const id = toolUseId(event);
  return {
    source_adapter_id: session.source,
    source_instance_id: session.source_path,
    session_id: event.session_id,
    agent_id: event.agent_id,
    ...(id === undefined ? {} : { tool_use_id: id }),
    source_index: event.source_index,
  };
}

export function encodeEventIdentity(identity: EventIdentity): string {
  return encode("event", [
    identity.source_adapter_id,
    identity.source_instance_id,
    identity.session_id,
    identity.agent_id,
    identity.tool_use_id,
    identity.source_index,
  ]);
}

export function encodeInvocationIdentity(identity: EventIdentity): string {
  return encode("invocation", [
    identity.source_adapter_id,
    identity.source_instance_id,
    identity.session_id,
    identity.agent_id,
    identity.tool_use_id,
  ]);
}

export function encodeAgentIdentity(identity: EventIdentity): string {
  return encode("agent", [
    identity.source_adapter_id,
    identity.source_instance_id,
    identity.session_id,
    identity.agent_id,
  ]);
}

export function encodeSessionIdentity(identity: EventIdentity): string {
  return encode("session", [
    identity.source_adapter_id,
    identity.source_instance_id,
    identity.session_id,
  ]);
}

export function encodeIdentityScope(
  domain: string,
  identityKey: string,
  ...values: readonly CanonicalValue[]
): string {
  return encode(`scope:${domain}`, [identityKey, ...values]);
}

/**
 * Low-level rule and matcher tests may construct actions directly. Production
 * actions emitted by buildTimeline always carry event_identity.
 */
export function evidenceEventIdentity(
  evidence: Pick<
    TimelineAction,
    "agent_id" | "event_identity" | "session_id" | "tool_use_id"
  > & { source_index?: number },
): EventIdentity {
  if (evidence.event_identity !== undefined) return evidence.event_identity;
  return {
    source_adapter_id: UNATTRIBUTED_SOURCE_ADAPTER,
    source_instance_id: UNATTRIBUTED_SOURCE_INSTANCE,
    session_id: evidence.session_id,
    agent_id: evidence.agent_id,
    ...(evidence.tool_use_id === undefined
      ? {}
      : { tool_use_id: evidence.tool_use_id }),
    source_index: evidence.source_index ?? 0,
  };
}
