import type { SourceAdapterId } from "../core/source-identity.js";
import type {
  CapabilityDescriptorV1,
  CapabilitySupportQuery,
} from "../protocol/capability-descriptor.js";

export type JsonRpcStringId = string;

/** A numeric JSON-RPC ID for which `Number.isSafeInteger(id)` must be true. */
export type JsonRpcSafeIntegerId = number;

export type JsonRpcId = JsonRpcStringId | JsonRpcSafeIntegerId;

export interface JsonRpcRequest<
  Method extends string = string,
  Params = unknown,
> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: Method;
  readonly params: Params;
}

export interface JsonRpcNotification<
  Method extends string = string,
  Params = unknown,
> {
  readonly jsonrpc: "2.0";
  readonly id?: never;
  readonly method: Method;
  readonly params: Params;
}

export interface JsonRpcSuccess<Result = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: Result;
  readonly error?: never;
}

export interface JsonRpcError<Data = unknown> {
  readonly code: number;
  readonly message: string;
  readonly data?: Data;
}

export interface JsonRpcFailure<Data = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcError<Data>;
  readonly result?: never;
}

export type JsonRpcResponse<Result = unknown, ErrorData = unknown> =
  | JsonRpcSuccess<Result>
  | JsonRpcFailure<ErrorData>;

export const ADAPTER_PROTOCOL_VERSIONS = Object.freeze(["1.0.0"] as const);

export type AdapterProtocolVersion =
  typeof ADAPTER_PROTOCOL_VERSIONS[number];

/** A semantic version string. Wire validation is outside this type-only v1. */
export type AdapterSemanticVersion = string;

export interface AdapterInitializeParams {
  /** Non-empty preference order, highest preference first. */
  readonly protocol_versions: readonly [
    AdapterProtocolVersion,
    ...AdapterProtocolVersion[],
  ];
}

export interface AdapterInitializeResult {
  /** Must be one of the protocol versions offered in the request. */
  readonly protocol_version: AdapterProtocolVersion;
  /** Must be a namespaced identity accepted by `parseSourceAdapterId`. */
  readonly adapter_id: SourceAdapterId;
  readonly adapter_version: AdapterSemanticVersion;
}

export interface AdapterNegotiateCapabilitiesParams {
  readonly required: readonly CapabilitySupportQuery[];
  readonly optional: readonly CapabilitySupportQuery[];
}

export type RequiredCapabilityUnavailableReason =
  | "unsupported"
  | "unknown"
  | "undeclared";

export interface UnavailableRequiredCapability {
  readonly query: CapabilitySupportQuery;
  /** A version-contract mismatch is reported as `unsupported`. */
  readonly reason: RequiredCapabilityUnavailableReason;
}

export interface AdapterCapabilityNegotiationSuccess {
  readonly accepted: true;
  readonly capability_descriptor: CapabilityDescriptorV1;
}

export interface AdapterCapabilityNegotiationFailure {
  readonly accepted: false;
  readonly capability_descriptor: CapabilityDescriptorV1;
  readonly unavailable_required: readonly [
    UnavailableRequiredCapability,
    ...UnavailableRequiredCapability[],
  ];
}

export type AdapterNegotiateCapabilitiesResult =
  | AdapterCapabilityNegotiationSuccess
  | AdapterCapabilityNegotiationFailure;

/** A closed, empty params object. */
export type AdapterShutdownParams = Readonly<Record<string, never>>;

export interface AdapterShutdownResult {
  readonly acknowledged: true;
}

export interface AdapterRpcMethodMap {
  readonly initialize: {
    readonly params: AdapterInitializeParams;
    readonly result: AdapterInitializeResult;
  };
  readonly negotiateCapabilities: {
    readonly params: AdapterNegotiateCapabilitiesParams;
    readonly result: AdapterNegotiateCapabilitiesResult;
  };
  readonly shutdown: {
    readonly params: AdapterShutdownParams;
    readonly result: AdapterShutdownResult;
  };
}

export type AdapterRpcMethod = keyof AdapterRpcMethodMap;

export type AdapterRpcParams<Method extends AdapterRpcMethod> =
  AdapterRpcMethodMap[Method]["params"];

export type AdapterRpcResult<Method extends AdapterRpcMethod> =
  AdapterRpcMethodMap[Method]["result"];

export type AdapterRpcRequest<
  Method extends AdapterRpcMethod = AdapterRpcMethod,
> = Method extends AdapterRpcMethod
  ? JsonRpcRequest<Method, AdapterRpcMethodMap[Method]["params"]>
  : never;

export type AdapterRpcResponse<
  Method extends AdapterRpcMethod = AdapterRpcMethod,
  ErrorData = unknown,
> = Method extends AdapterRpcMethod
  ? JsonRpcResponse<AdapterRpcMethodMap[Method]["result"], ErrorData>
  : never;
