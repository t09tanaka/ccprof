import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import * as adapterSdk from "../src/adapter-sdk/index.js";
import {
  ADAPTER_PROTOCOL_VERSIONS,
  parseSourceAdapterId,
  supportsCapability,
  validateCapabilityDescriptor,
  type AdapterCapabilityNegotiationFailure,
  type AdapterCapabilityNegotiationSuccess,
  type AdapterInitializeParams,
  type AdapterInitializeResult,
  type AdapterNegotiateCapabilitiesParams,
  type AdapterNegotiateCapabilitiesResult,
  type AdapterRpcMethod,
  type AdapterRpcParams,
  type AdapterRpcRequest,
  type AdapterRpcResponse,
  type AdapterRpcResult,
  type AdapterShutdownParams,
  type AdapterShutdownResult,
  type CapabilityDescriptorV1,
  type CapabilitySupportQuery,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSafeIntegerId,
  type JsonRpcStringId,
  type JsonRpcSuccess,
  type SourceAdapterId,
} from "../src/adapter-sdk/index.js";

// @ts-expect-error SessionSource is intentionally not part of the public SDK.
import type { SessionSource } from "../src/adapter-sdk/index.js";
// @ts-expect-error SourceDescriptor is intentionally not part of the public SDK.
import type { SourceDescriptor } from "../src/adapter-sdk/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Expect<Value extends true> = Value;

type ProtocolTupleContract = Expect<Equal<
  typeof ADAPTER_PROTOCOL_VERSIONS,
  readonly ["1.0.0"]
>>;
type MethodContract = Expect<Equal<
  AdapterRpcMethod,
  "initialize" | "negotiateCapabilities" | "shutdown"
>>;
type InitializeParamsContract = Expect<Equal<
  AdapterRpcParams<"initialize">,
  AdapterInitializeParams
>>;
type InitializeResultContract = Expect<Equal<
  AdapterRpcResult<"initialize">,
  AdapterInitializeResult
>>;
type NegotiationParamsContract = Expect<Equal<
  AdapterRpcParams<"negotiateCapabilities">,
  AdapterNegotiateCapabilitiesParams
>>;
type NegotiationResultContract = Expect<Equal<
  AdapterRpcResult<"negotiateCapabilities">,
  AdapterNegotiateCapabilitiesResult
>>;
type ShutdownParamsContract = Expect<Equal<
  AdapterRpcParams<"shutdown">,
  AdapterShutdownParams
>>;
type ShutdownResultContract = Expect<Equal<
  AdapterRpcResult<"shutdown">,
  AdapterShutdownResult
>>;

const compileTimeContracts: readonly true[] = [
  true as ProtocolTupleContract,
  true as MethodContract,
  true as InitializeParamsContract,
  true as InitializeResultContract,
  true as NegotiationParamsContract,
  true as NegotiationResultContract,
  true as ShutdownParamsContract,
  true as ShutdownResultContract,
];

const descriptor: CapabilityDescriptorV1 = {
  $schema:
    "https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/capability-descriptor-v1.schema.json",
  schema_version: 1,
  descriptor_version: "1.0.0",
  undeclared_capability_state: "unknown",
  capabilities: [{
    id: "example.dev/capabilities/transcript",
    version: "1.0.0",
    requirement: "required",
    state: "supported_exact",
    evidence: { quality: "exact", provenance: "adapter_declared" },
    timestamp_precision: "not_applicable",
  }],
};

const requiredQuery = {
  id: "example.dev/capabilities/transcript",
  version: "1.0.0",
} satisfies CapabilitySupportQuery;
const optionalQuery = {
  id: "example.dev/capabilities/optional-metadata",
  version_range: ">=1.0.0 <2.0.0",
} satisfies CapabilitySupportQuery;

const initializeRequest = {
  jsonrpc: "2.0",
  id: "initialize-1",
  method: "initialize",
  params: { protocol_versions: ["1.0.0"] },
} satisfies AdapterRpcRequest<"initialize">;

const initializeResult = {
  protocol_version: "1.0.0",
  adapter_id: parseSourceAdapterId("example.dev/adapters/transcript"),
  adapter_version: "2.3.4",
} satisfies AdapterInitializeResult;

const negotiateRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "negotiateCapabilities",
  params: {
    required: [requiredQuery],
    optional: [optionalQuery],
  },
} satisfies AdapterRpcRequest<"negotiateCapabilities">;

const negotiationSuccess = {
  accepted: true,
  capability_descriptor: descriptor,
} satisfies AdapterCapabilityNegotiationSuccess;

const negotiationFailure = {
  accepted: false,
  capability_descriptor: descriptor,
  unavailable_required: [
    {
      query: { id: requiredQuery.id, version: "2.0.0" },
      reason: "unsupported",
    },
    {
      query: { id: "example.dev/capabilities/pending", version: "1.0.0" },
      reason: "unknown",
    },
    {
      query: { id: "example.dev/capabilities/absent", version: "1.0.0" },
      reason: "undeclared",
    },
  ],
} satisfies AdapterCapabilityNegotiationFailure;

const shutdownRequest = {
  jsonrpc: "2.0",
  id: "shutdown-1",
  method: "shutdown",
  params: {},
} satisfies AdapterRpcRequest<"shutdown">;
const shutdownResult = { acknowledged: true } satisfies AdapterShutdownResult;

test("publishes the immutable protocol version and curated runtime surface", () => {
  assert.deepEqual(compileTimeContracts, Array(8).fill(true));
  assert.deepEqual(ADAPTER_PROTOCOL_VERSIONS, ["1.0.0"]);
  assert.equal(Object.isFrozen(ADAPTER_PROTOCOL_VERSIONS), true);
  assert.deepEqual(Object.keys(adapterSdk).sort(), [
    "ADAPTER_PROTOCOL_VERSIONS",
    "parseSourceAdapterId",
    "supportsCapability",
    "validateCapabilityDescriptor",
  ]);

  const adapterId: SourceAdapterId = initializeResult.adapter_id;
  assert.equal(adapterId, "example.dev/adapters/transcript");
  const snapshot = validateCapabilityDescriptor(descriptor);
  assert.equal(supportsCapability(snapshot, requiredQuery), true);
});

test("models JSON-RPC request, notification, success, failure, and response", () => {
  const stringId: JsonRpcStringId = "request-1";
  const integerId: JsonRpcSafeIntegerId = 7;
  const ids: readonly JsonRpcId[] = [stringId, integerId];
  assert.ok(Number.isSafeInteger(integerId));

  const request = {
    jsonrpc: "2.0",
    id: stringId,
    method: "adapter.example/inspect",
    params: { verbose: true },
  } satisfies JsonRpcRequest<"adapter.example/inspect", { verbose: boolean }>;
  const notification = {
    jsonrpc: "2.0",
    method: "adapter.example/progress",
    params: { completed: 1 },
  } satisfies JsonRpcNotification<
    "adapter.example/progress",
    { completed: number }
  >;
  const success = {
    jsonrpc: "2.0",
    id: integerId,
    result: { ok: true },
  } satisfies JsonRpcSuccess<{ ok: boolean }>;
  const failure = {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32600,
      message: "Invalid Request",
      data: { recoverable_id: false },
    },
  } satisfies JsonRpcFailure<{ recoverable_id: boolean }>;
  const responses: readonly JsonRpcResponse<
    { ok: boolean },
    { recoverable_id: boolean }
  >[] = [success, failure];

  assert.deepEqual(ids, ["request-1", 7]);
  assert.equal(request.jsonrpc, "2.0");
  assert.equal("id" in notification, false);
  assert.equal(responses.length, 2);
});

test("correlates lifecycle methods with params and results", () => {
  const initializeResponse = {
    jsonrpc: "2.0",
    id: initializeRequest.id,
    result: initializeResult,
  } satisfies AdapterRpcResponse<"initialize">;
  const negotiateResult: AdapterNegotiateCapabilitiesResult =
    negotiationSuccess;
  const negotiateResponse = {
    jsonrpc: "2.0",
    id: negotiateRequest.id,
    result: negotiateResult,
  } satisfies AdapterRpcResponse<"negotiateCapabilities">;
  const rejectedResult: AdapterNegotiateCapabilitiesResult =
    negotiationFailure;
  const shutdownResponse = {
    jsonrpc: "2.0",
    id: shutdownRequest.id,
    result: shutdownResult,
  } satisfies AdapterRpcResponse<"shutdown">;

  assert.equal(initializeResponse.result.protocol_version, "1.0.0");
  assert.equal(negotiateResponse.result.accepted, true);
  assert.equal(rejectedResult.accepted, false);
  assert.deepEqual(
    rejectedResult.unavailable_required.map(({ reason }) => reason),
    ["unsupported", "unknown", "undeclared"],
  );
  assert.equal(shutdownResponse.result.acknowledged, true);
});

test("package metadata publishes the SDK subpath without closing legacy paths", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(process.cwd(), "package.json"), "utf8"),
  ) as { exports?: unknown; scripts?: Record<string, string> };

  assert.deepEqual(packageJson.exports, {
    "./adapter-sdk": {
      types: "./dist/adapter-sdk/index.d.ts",
      import: "./dist/adapter-sdk/index.js",
    },
    "./dist/*": "./dist/*",
    "./schemas/*": "./schemas/*",
    "./package.json": "./package.json",
  });
  assert.equal(packageJson.scripts?.prepack, "npm run build");
});
