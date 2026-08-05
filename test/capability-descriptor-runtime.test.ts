import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_DESCRIPTOR_SCHEMA_ID,
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_DESCRIPTOR_VERSION,
  CAPABILITY_UNDECLARED_STATE,
  CapabilityDescriptorValidationError,
  supportsCapability,
  validateCapabilityDescriptor,
  type CapabilityDescriptorV1,
} from "../src/protocol/capability-descriptor.js";

type MutableRecord = Record<PropertyKey, unknown>;
type RuntimeCapabilityShape = {
  readonly id: string;
  readonly legacy_id?: string;
  readonly version?: string;
  readonly requirement: string;
  readonly state: string;
  readonly evidence: {
    readonly quality: string;
    readonly provenance: string;
  };
  readonly timestamp_precision: string;
};
type RuntimeDescriptorShape = {
  readonly $schema: string;
  readonly schema_version: number;
  readonly descriptor_version: string;
  readonly undeclared_capability_state: string;
  readonly capabilities: readonly RuntimeCapabilityShape[];
};

function capability(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "dev.example/capabilities/fixtures",
    legacy_id: "fixtures",
    version: "1.2.3",
    requirement: "required",
    state: "supported_exact",
    evidence: { quality: "exact", provenance: "producer_declared" },
    timestamp_precision: "microsecond",
    ...overrides,
  };
}

function descriptor(
  capabilities: unknown[] = [capability()],
): MutableRecord {
  return {
    $schema: CAPABILITY_DESCRIPTOR_SCHEMA_ID,
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    descriptor_version: CAPABILITY_DESCRIPTOR_VERSION,
    undeclared_capability_state: CAPABILITY_UNDECLARED_STATE,
    capabilities,
  };
}

function expectValidationError(
  action: () => unknown,
): void {
  const code = "invalid_descriptor";
  const secret = "must-not-leak";
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CapabilityDescriptorValidationError);
    const failure = error as CapabilityDescriptorValidationError;
    assert.equal(failure.name, "CapabilityDescriptorValidationError");
    assert.equal(failure.code, code);
    assert.equal(failure.message, `invalid capability descriptor: ${code}`);
    assert.doesNotMatch(failure.message, new RegExp(secret, "u"));
    return true;
  });
}

test("validates a detached frozen descriptor and all five support states", () => {
  const input = descriptor([
    capability({ id: "dev.example/capabilities/exact" }),
    capability({
      id: "dev.example/capabilities/estimated",
      state: "supported_estimated",
      evidence: { quality: "estimated", provenance: "derived" },
    }),
    capability({
      id: "dev.example/capabilities/partial",
      state: "supported_partial",
      evidence: { quality: "unknown", provenance: "adapter_declared" },
      timestamp_precision: "unknown",
    }),
    capability({
      id: "dev.example/capabilities/unsupported",
      state: "unsupported",
      evidence: { quality: "none", provenance: "observed" },
      timestamp_precision: "not_applicable",
    }),
    capability({
      id: "dev.example/capabilities/unknown",
      state: "unknown",
      evidence: { quality: "unknown", provenance: "unknown" },
      timestamp_precision: "unknown",
    }),
    capability({
      id: "dev.example/capabilities/ranged",
      version: undefined,
      version_range: ">=1.0.0 <2.0.0",
    }),
  ]);
  delete (input.capabilities as MutableRecord[])[5]!.version;
  const snapshot = validateCapabilityDescriptor(input) as RuntimeDescriptorShape;

  assert.deepEqual(snapshot, input);
  assert.notEqual(snapshot, input);
  assert.notEqual(snapshot.capabilities, input.capabilities);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.capabilities), true);
  assert.ok(snapshot.capabilities.every(Object.isFrozen));
  assert.ok(snapshot.capabilities.every(({ evidence }) => Object.isFrozen(evidence)));

  (input.capabilities as MutableRecord[])[0]!.id =
    "dev.example/capabilities/mutated";
  ((input.capabilities as MutableRecord[])[0]!.evidence as MutableRecord).quality =
    "estimated";
  assert.equal(snapshot.capabilities[0]!.id, "dev.example/capabilities/exact");
  assert.equal(snapshot.capabilities[0]!.evidence.quality, "exact");
});

test("rejects malformed, duplicate, ambiguous, and contradictory descriptors", () => {
  const reject = (mutate: (value: MutableRecord) => void): void => {
    const candidate = descriptor();
    mutate(candidate);
    expectValidationError(() => validateCapabilityDescriptor(candidate));
  };

  for (const [field, value] of [
    ["$schema", "https://example.test/must-not-leak"],
    ["schema_version", 2],
    ["descriptor_version", "2.0.0"],
    ["undeclared_capability_state", "supported_exact"],
  ] as const) reject((root) => { root[field] = value; });
  reject((root) => { root.unexpected = true; });
  reject((root) => { delete root.capabilities; });
  reject((root) => { root.capabilities = []; });

  for (const id of [
    "fixtures",
    "DEV.example/capabilities/fixtures",
    "dev.example/capabilities/",
    "dev.example/capabilities/fixtures\n",
  ]) {
    reject((root) => {
      (root.capabilities as MutableRecord[])[0]!.id = id;
    });
  }
  for (const [field, value] of [
    ["legacy_id", "fixtures\r"],
    ["version", "01.0.0"],
    ["version", "1.0.0\u2028"],
    ["requirement", "recommended"],
    ["state", "supported"],
    ["timestamp_precision", "minute"],
  ] as const) {
    reject((root) => {
      (root.capabilities as MutableRecord[])[0]![field] = value;
    });
  }
  reject((root) => {
    const item = (root.capabilities as MutableRecord[])[0]!;
    delete item.version;
    item.version_range = "^1.0.0\u2029";
  });
  reject((root) => {
    (root.capabilities as MutableRecord[])[0]!.version_range = "^1.0.0";
  });
  reject((root) => {
    delete (root.capabilities as MutableRecord[])[0]!.version;
  });
  reject((root) => {
    (root.capabilities as MutableRecord[])[0]!.unexpected = true;
  });
  reject((root) => {
    ((root.capabilities as MutableRecord[])[0]!.evidence as MutableRecord).unexpected =
      true;
  });
  reject((root) => {
    root.capabilities = [capability(), capability({ state: "supported_partial" })];
  });

  for (const [state, quality, provenance, precision] of [
    ["supported_exact", "estimated", "observed", "microsecond"],
    ["supported_exact", "exact", "unknown", "microsecond"],
    ["supported_estimated", "exact", "derived", "microsecond"],
    ["supported_partial", "exact", "observed", "unknown"],
    ["unsupported", "none", "observed", "unknown"],
    ["unknown", "unknown", "unknown", "not_applicable"],
  ] as const) {
    reject((root) => {
      Object.assign((root.capabilities as MutableRecord[])[0]!, {
        state,
        evidence: { quality, provenance },
        timestamp_precision: precision,
      });
    });
  }
});

test("rejects hostile data without invoking getters or leaking input", () => {
  let getterCalls = 0;
  expectValidationError(() => validateCapabilityDescriptor([]));
  expectValidationError(() => validateCapabilityDescriptor(Object.create(null)));

  const accessor = descriptor();
  Object.defineProperty(accessor, "$schema", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-leak";
    },
  });
  expectValidationError(() => validateCapabilityDescriptor(accessor));
  assert.equal(getterCalls, 0);

  const nonEnumerable = descriptor();
  Object.defineProperty(nonEnumerable, "schema_version", {
    value: 1,
    enumerable: false,
  });
  expectValidationError(() => validateCapabilityDescriptor(nonEnumerable));

  const symbol = descriptor();
  symbol[Symbol("must-not-leak")] = true;
  expectValidationError(() => validateCapabilityDescriptor(symbol));
  expectValidationError(() => validateCapabilityDescriptor(new Proxy(descriptor(), {})));

  const revoked = Proxy.revocable(descriptor(), {});
  revoked.revoke();
  expectValidationError(() => validateCapabilityDescriptor(revoked.proxy));

  const capabilityAccessor = descriptor();
  Object.defineProperty((capabilityAccessor.capabilities as MutableRecord[])[0]!, "id", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-leak";
    },
  });
  expectValidationError(() => validateCapabilityDescriptor(capabilityAccessor));
  assert.equal(getterCalls, 0);

  const evidenceAccessor = descriptor();
  Object.defineProperty(
    (evidenceAccessor.capabilities as MutableRecord[])[0]!
      .evidence as MutableRecord,
    "quality",
    {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-leak";
      },
    },
  );
  expectValidationError(() => validateCapabilityDescriptor(evidenceAccessor));
  assert.equal(getterCalls, 0);

  const arrayProxy = descriptor();
  arrayProxy.capabilities = new Proxy(
    arrayProxy.capabilities as MutableRecord[],
    {},
  );
  expectValidationError(() => validateCapabilityDescriptor(arrayProxy));

  const evidenceProxy = descriptor();
  const evidenceCapability = (evidenceProxy.capabilities as MutableRecord[])[0]!;
  evidenceCapability.evidence = new Proxy(
    evidenceCapability.evidence as MutableRecord,
    {},
  );
  expectValidationError(() => validateCapabilityDescriptor(evidenceProxy));
});

test("support lookup is namespaced, state-aware, and version fail-closed", () => {
  const declarations = [
    ["exact", "supported_exact", "exact", "producer_declared"],
    ["estimated", "supported_estimated", "estimated", "derived"],
    ["partial", "supported_partial", "partial", "observed"],
    ["unsupported", "unsupported", "none", "observed"],
    ["unknown", "unknown", "unknown", "unknown"],
  ].map(([suffix, state, quality, provenance]) => capability({
    id: `dev.example/capabilities/${suffix}`,
    legacy_id: suffix,
    state,
    evidence: { quality, provenance },
    timestamp_precision: state === "unsupported"
      ? "not_applicable"
      : state === "unknown" ? "unknown" : "microsecond",
  }));
  const ranged = capability({
    id: "dev.example/capabilities/ranged",
    legacy_id: "ranged",
    version_range: "^1.0.0",
  });
  delete ranged.version;
  declarations.push(ranged);
  const snapshot = validateCapabilityDescriptor(descriptor(declarations));

  for (const suffix of ["exact", "estimated", "partial"]) {
    assert.equal(supportsCapability(snapshot, {
      id: `dev.example/capabilities/${suffix}`,
      version: "1.2.3",
    }), true);
  }
  for (const suffix of ["unsupported", "unknown", "undeclared"]) {
    assert.equal(supportsCapability(snapshot, {
      id: `dev.example/capabilities/${suffix}`,
      version: "1.2.3",
    }), false);
  }
  assert.equal(supportsCapability(snapshot, { id: "exact", version: "1.2.3" }), false);
  assert.equal(supportsCapability(snapshot, {
    id: "dev.example/capabilities/exact",
    version: "2.0.0",
  }), false);
  assert.equal(supportsCapability(snapshot, {
    id: "dev.example/capabilities/exact",
    version_range: "^1.0.0",
  }), false);
  assert.equal(supportsCapability(snapshot, {
    id: "dev.example/capabilities/ranged",
    version_range: "^1.0.0",
  }), true);
  assert.equal(supportsCapability(snapshot, {
    id: "dev.example/capabilities/ranged",
    version_range: ">=1.0.0 <2.0.0",
  }), false);
  assert.equal(supportsCapability(snapshot, {
    id: "dev.example/capabilities/ranged",
    version: "1.2.3",
  }), false);
  assert.equal(supportsCapability(snapshot, {
    id: "dev.example/capabilities/exact",
    version: "1.2.3\n",
  }), false);
});

test("validated types retain the fixed schema surface", () => {
  const snapshot: CapabilityDescriptorV1 = validateCapabilityDescriptor(descriptor());
  assert.equal(snapshot.$schema, CAPABILITY_DESCRIPTOR_SCHEMA_ID);
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.descriptor_version, "1.0.0");
  assert.equal(snapshot.undeclared_capability_state, "unknown");
});
