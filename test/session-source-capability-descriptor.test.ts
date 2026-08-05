import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_DESCRIPTOR_SCHEMA_ID,
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_DESCRIPTOR_VERSION,
  CAPABILITY_UNDECLARED_STATE,
  type CapabilityDescriptorV1,
} from "../src/protocol/capability-descriptor.js";
import {
  legacyCapabilitiesToDescriptor,
} from "../src/protocol/legacy-capability-descriptor.js";
import type { SessionCapability } from "../src/core/model.js";
import {
  SessionSourceValidationError,
  validateSessionSource,
  type SessionSource,
  type SessionSourceContract,
  type SessionSourceValidationCode,
} from "../src/sources/session-source.js";

const LEGACY_ID = (id: SessionCapability): string =>
  `ccprof.dev/capabilities/${id}`;

type MutableDeclaration = {
  id: string;
  legacy_id?: string;
  version?: string;
  version_range?: string;
  requirement: "optional";
  state: string;
  evidence: { quality: string; provenance: string };
  timestamp_precision: string;
};

type MutableDescriptor = {
  $schema: string;
  schema_version: number;
  descriptor_version: string;
  undeclared_capability_state: string;
  capabilities: MutableDeclaration[];
};

type NormalizedContractProbe = {
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly capabilities: readonly SessionCapability[];
  readonly capability_descriptor: CapabilityDescriptorV1;
};

function supported(
  id: string,
  overrides: Partial<MutableDeclaration> = {},
): MutableDeclaration {
  return {
    id,
    version: CAPABILITY_DESCRIPTOR_VERSION,
    requirement: "optional",
    state: "supported_partial",
    evidence: { quality: "partial", provenance: "adapter_declared" },
    timestamp_precision: "not_applicable",
    ...overrides,
  };
}

function unsupported(
  id: string,
  state: "unsupported" | "unknown",
): MutableDeclaration {
  return state === "unsupported"
    ? supported(id, {
      state,
      evidence: { quality: "none", provenance: "adapter_declared" },
      timestamp_precision: "not_applicable",
    })
    : supported(id, {
      state,
      evidence: { quality: "unknown", provenance: "unknown" },
      timestamp_precision: "unknown",
    });
}

function supportedRange(id: string, versionRange: string): MutableDeclaration {
  const result = supported(id);
  delete result.version;
  result.version_range = versionRange;
  return result;
}

function descriptor(
  capabilities: MutableDeclaration[],
): MutableDescriptor {
  return {
    $schema: CAPABILITY_DESCRIPTOR_SCHEMA_ID,
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    descriptor_version: CAPABILITY_DESCRIPTOR_VERSION,
    undeclared_capability_state: CAPABILITY_UNDECLARED_STATE,
    capabilities,
  };
}

function source(contract: unknown): SessionSource {
  return {
    contract: contract as SessionSourceContract,
    discover: async () => [],
  };
}

function normalize(contract: unknown): NormalizedContractProbe {
  return validateSessionSource(source(contract)).contract as unknown as
    NormalizedContractProbe;
}

function assertSourceError(
  action: () => unknown,
  code: SessionSourceValidationCode = "invalid_capability",
  canary = "SECRET_CANARY",
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SessionSourceValidationError);
    assert.equal(error.code, code);
    assert.equal(error.name, "SessionSourceValidationError");
    assert.equal(error.message, `invalid session source: ${code}`);
    assert.equal(error.message.includes(canary), false);
    return true;
  });
}

function contract(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    ...overrides,
  };
}

function assertDeeplyFrozen(value: NormalizedContractProbe): void {
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.capabilities), true);
  assert.equal(Object.isFrozen(value.capability_descriptor), true);
  assert.equal(Object.isFrozen(value.capability_descriptor.capabilities), true);
  for (const declaration of value.capability_descriptor.capabilities) {
    assert.equal(Object.isFrozen(declaration), true);
    assert.equal(Object.isFrozen(declaration.evidence), true);
  }
}

test("legacy-only contracts gain a detached descriptor and keep their projection", () => {
  const capabilities: SessionCapability[] = ["approvals", "tool_timestamps"];
  const normalized = normalize(contract({ capabilities }));

  assert.deepEqual(normalized.capabilities, capabilities);
  assert.deepEqual(
    normalized.capability_descriptor,
    legacyCapabilitiesToDescriptor(capabilities),
  );
  assert.notEqual(normalized.capabilities, capabilities);
  assertDeeplyFrozen(normalized);

  capabilities.length = 0;
  assert.deepEqual(normalized.capabilities, ["approvals", "tool_timestamps"]);
});

test("descriptor-only contracts project supported legacy IDs and preserve neutral IDs", () => {
  const neutralId = "dummy.example/capabilities/neutral_signal";
  const input = descriptor([
    supported(LEGACY_ID("tool_timestamps")),
    unsupported(LEGACY_ID("edit_fragments"), "unknown"),
    supported(neutralId, {
      state: "supported_exact",
      evidence: { quality: "exact", provenance: "producer_declared" },
    }),
    supported(LEGACY_ID("token_usage"), {
      state: "supported_estimated",
      evidence: { quality: "estimated", provenance: "observed" },
    }),
    unsupported(LEGACY_ID("branch_rows"), "unsupported"),
    supported(LEGACY_ID("approvals")),
  ]);

  const normalized = normalize(contract({ capability_descriptor: input }));

  assert.deepEqual(normalized.capabilities, [
    "approvals",
    "token_usage",
    "tool_timestamps",
  ]);
  assert.deepEqual(
    normalized.capability_descriptor.capabilities.map(({ id }) => id),
    [
      "ccprof.dev/capabilities/approvals",
      "ccprof.dev/capabilities/branch_rows",
      "ccprof.dev/capabilities/edit_fragments",
      "ccprof.dev/capabilities/token_usage",
      "ccprof.dev/capabilities/tool_timestamps",
      neutralId,
    ],
  );
  assert.equal(
    normalized.capability_descriptor.capabilities.some(({ id }) => id === neutralId),
    true,
  );
  assertDeeplyFrozen(normalized);
});

test("dual contracts require exact projection agreement without adapter inference", () => {
  const matching = descriptor([
    supported(LEGACY_ID("approvals")),
    unsupported(LEGACY_ID("branch_rows"), "unsupported"),
    supported("dummy.example/capabilities/neutral_signal"),
  ]);
  const normalized = normalize(contract({
    capabilities: ["approvals"],
    capability_descriptor: matching,
  }));
  assert.deepEqual(normalized.capabilities, ["approvals"]);

  assertSourceError(() => normalize(contract({
    capabilities: ["approvals"],
    capability_descriptor: descriptor([
      unsupported(LEGACY_ID("approvals"), "unknown"),
    ]),
  })));
  assertSourceError(() => normalize(contract({
    capabilities: [],
    capability_descriptor: descriptor([
      supported(LEGACY_ID("approvals")),
    ]),
  })));
});

test("unsupported, unknown, unmatched, and range-only declarations do not project", () => {
  const normalized = normalize(contract({
    capability_descriptor: descriptor([
      unsupported(LEGACY_ID("approvals"), "unsupported"),
      unsupported(LEGACY_ID("branch_rows"), "unknown"),
      supported(LEGACY_ID("edit_fragments"), {
        version: "2.0.0",
      }),
      supportedRange(LEGACY_ID("sidechains"), "^1.0.0"),
      supported("dummy.example/capabilities/neutral_signal"),
    ]),
  }));

  assert.deepEqual(normalized.capabilities, []);
  assert.equal(normalized.capability_descriptor.capabilities.length, 5);
});

test("normalization is deterministic, detached, deeply frozen, and repeatable", () => {
  const firstEntry = supported(LEGACY_ID("tool_timestamps"));
  const secondEntry = supported(LEGACY_ID("approvals"));
  const mutable = descriptor([firstEntry, secondEntry]);
  const forward = normalize(contract({ capability_descriptor: mutable }));
  const reverse = normalize(contract({
    capability_descriptor: descriptor([secondEntry, firstEntry]),
  }));

  assert.equal(
    JSON.stringify(forward.capability_descriptor),
    JSON.stringify(reverse.capability_descriptor),
  );
  assert.deepEqual(
    forward.capability_descriptor.capabilities.map(({ id }) => id),
    [LEGACY_ID("approvals"), LEGACY_ID("tool_timestamps")],
  );

  firstEntry.id = "dummy.example/capabilities/mutated";
  firstEntry.evidence.quality = "none";
  mutable.capabilities.length = 0;
  mutable.descriptor_version = "9.9.9";
  assert.deepEqual(forward.capabilities, ["approvals", "tool_timestamps"]);
  assert.deepEqual(
    forward.capability_descriptor.capabilities.map(({ id }) => id),
    [LEGACY_ID("approvals"), LEGACY_ID("tool_timestamps")],
  );

  const once = validateSessionSource(source({
    adapter_id: "claude",
    adapter_version: "1.0.0",
    capability_descriptor: reverse.capability_descriptor,
  }));
  const twice = validateSessionSource(once);
  const onceContract = once.contract as unknown as NormalizedContractProbe;
  const twiceContract = twice.contract as unknown as NormalizedContractProbe;
  assert.deepEqual(twiceContract, onceContract);
  assert.notEqual(twiceContract, onceContract);
  assert.notEqual(
    twiceContract.capability_descriptor,
    onceContract.capability_descriptor,
  );
  assertDeeplyFrozen(twiceContract);
});

test("malformed and hostile capability representations fail with fixed errors", () => {
  assertSourceError(() => normalize(contract({})));
  assertSourceError(() => normalize(contract({ capabilities: undefined })));
  assertSourceError(() => normalize(contract({ capability_descriptor: undefined })));
  assertSourceError(() => normalize(contract({ capabilities: [
    "approvals",
    "approvals",
  ] })));
  assertSourceError(() => normalize(contract({ capabilities: [
    "tool_timestamps",
    "approvals",
  ] })));

  const invalidDescriptors: unknown[] = [
    { ...descriptor([supported(LEGACY_ID("approvals"))]), extra: "SECRET_CANARY" },
    descriptor([
      supported(LEGACY_ID("approvals")),
      supported(LEGACY_ID("approvals")),
    ]),
    descriptor([supported(LEGACY_ID("approvals"), {
      state: "supported_exact",
      evidence: { quality: "none", provenance: "adapter_declared" },
    })]),
  ];
  for (const invalid of invalidDescriptors) {
    assertSourceError(() => normalize(contract({ capability_descriptor: invalid })));
  }

  let traps = 0;
  const hostile = new Proxy(descriptor([supported(LEGACY_ID("approvals"))]), {
    get: () => {
      traps += 1;
      throw new Error("SECRET_CANARY get");
    },
    getOwnPropertyDescriptor: () => {
      traps += 1;
      throw new Error("SECRET_CANARY descriptor");
    },
    getPrototypeOf: () => {
      traps += 1;
      throw new Error("SECRET_CANARY prototype");
    },
    ownKeys: () => {
      traps += 1;
      throw new Error("SECRET_CANARY keys");
    },
  });
  assertSourceError(() => normalize(contract({ capability_descriptor: hostile })));

  const nestedHostile = new Proxy(supported(LEGACY_ID("approvals")), {
    get: () => {
      traps += 1;
      throw new Error("SECRET_CANARY nested get");
    },
    getOwnPropertyDescriptor: () => {
      traps += 1;
      throw new Error("SECRET_CANARY nested descriptor");
    },
    getPrototypeOf: () => {
      traps += 1;
      throw new Error("SECRET_CANARY nested prototype");
    },
    ownKeys: () => {
      traps += 1;
      throw new Error("SECRET_CANARY nested keys");
    },
  });
  assertSourceError(() => normalize(contract({
    capability_descriptor: descriptor([nestedHostile]),
  })));

  const revocable = Proxy.revocable(
    descriptor([supported(LEGACY_ID("approvals"))]),
    {},
  );
  revocable.revoke();
  assertSourceError(() => normalize(contract({
    capability_descriptor: revocable.proxy,
  })));

  let reads = 0;
  const accessor = supported(LEGACY_ID("approvals")) as MutableDeclaration &
    Record<string, unknown>;
  Object.defineProperty(accessor, "state", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("SECRET_CANARY getter");
    },
  });
  assertSourceError(() => normalize(contract({
    capability_descriptor: descriptor([accessor]),
  })));
  assert.equal(traps, 0);
  assert.equal(reads, 0);
});
