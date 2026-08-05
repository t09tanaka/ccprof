import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  CAPABILITY_DESCRIPTOR_SCHEMA_ID,
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_DESCRIPTOR_VERSION,
  CAPABILITY_UNDECLARED_STATE,
  validateCapabilityDescriptor,
  type CapabilityDescriptorV1,
} from "../src/protocol/capability-descriptor.js";
import {
  LEGACY_CAPABILITY_IDS,
  LegacyCapabilityValidationError,
  legacyCapabilitiesToDescriptor,
} from "../src/protocol/legacy-capability-descriptor.js";

const EXPECTED_LEGACY_IDS = [
  "approvals",
  "branch_rows",
  "edit_fragments",
  "sidechains",
  "token_usage",
  "tool_timestamps",
] as const;

function expectLegacyValidationError(action: () => unknown): void {
  const secret = "must-not-leak";
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LegacyCapabilityValidationError);
    const failure = error as LegacyCapabilityValidationError;
    assert.equal(failure.name, "LegacyCapabilityValidationError");
    assert.equal(failure.code, "invalid_legacy_capabilities");
    assert.equal(
      failure.message,
      "invalid legacy capabilities: invalid_legacy_capabilities",
    );
    assert.doesNotMatch(failure.message, new RegExp(secret, "u"));
    return true;
  });
}

test("maps the exact legacy vocabulary to deterministic v1 declarations", async () => {
  assert.deepEqual(LEGACY_CAPABILITY_IDS, EXPECTED_LEGACY_IDS);
  assert.equal(Object.isFrozen(LEGACY_CAPABILITY_IDS), true);

  const input: unknown[] = ["tool_timestamps", "approvals"];
  const result: CapabilityDescriptorV1 = legacyCapabilitiesToDescriptor(input);
  const present = new Set(input);
  assert.deepEqual(result, {
    $schema: CAPABILITY_DESCRIPTOR_SCHEMA_ID,
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    descriptor_version: CAPABILITY_DESCRIPTOR_VERSION,
    undeclared_capability_state: CAPABILITY_UNDECLARED_STATE,
    capabilities: EXPECTED_LEGACY_IDS.map((legacyId) => {
      const supported = present.has(legacyId);
      return {
        id: `ccprof.dev/capabilities/${legacyId}`,
        legacy_id: legacyId,
        version: "1.0.0",
        requirement: "optional",
        state: supported ? "supported_partial" : "unsupported",
        evidence: {
          quality: supported ? "unknown" : "none",
          provenance: "adapter_declared",
        },
        timestamp_precision: supported && legacyId === "tool_timestamps"
          ? "unknown"
          : "not_applicable",
      };
    }),
  });

  assert.deepEqual(
    legacyCapabilitiesToDescriptor(["approvals", "tool_timestamps"]),
    result,
  );
  assert.deepEqual(validateCapabilityDescriptor(result), result);

  const [schemaRaw, fixtureRaw] = await Promise.all([
    readFile(
      resolve(process.cwd(), "schemas/capability-descriptor-v1.schema.json"),
      "utf8",
    ),
    readFile(
      resolve(
        process.cwd(),
        "test/fixtures/protocol/capability-descriptor-v1.json",
      ),
      "utf8",
    ),
  ]);
  assert.deepEqual(
    legacyCapabilitiesToDescriptor([...EXPECTED_LEGACY_IDS]),
    JSON.parse(fixtureRaw),
  );
  const schema = JSON.parse(schemaRaw) as object;
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
});

test("declares all six capabilities unsupported for an empty legacy array", () => {
  const result: CapabilityDescriptorV1 = legacyCapabilitiesToDescriptor([]);

  assert.equal(result.capabilities.length, EXPECTED_LEGACY_IDS.length);
  for (const declaration of result.capabilities) {
    assert.equal(declaration.state, "unsupported");
    assert.deepEqual(declaration.evidence, {
      quality: "none",
      provenance: "adapter_declared",
    });
    assert.equal(declaration.timestamp_precision, "not_applicable");
  }
});

test("returns a detached deeply frozen descriptor and accepts frozen input", () => {
  const input: unknown[] = ["approvals"];
  const result: CapabilityDescriptorV1 = legacyCapabilitiesToDescriptor(input);
  input[0] = "branch_rows";

  assert.equal(result.capabilities[0]!.legacy_id, "approvals");
  assert.equal(result.capabilities[0]!.state, "supported_partial");
  assert.equal(result.capabilities[1]!.state, "unsupported");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.capabilities), true);
  assert.ok(result.capabilities.every(Object.isFrozen));
  assert.ok(result.capabilities.every(({ evidence }) => Object.isFrozen(evidence)));

  assert.deepEqual(
    legacyCapabilitiesToDescriptor(Object.freeze(["approvals"])),
    result,
  );
});

test("rejects malformed legacy arrays with content-free errors", () => {
  for (const value of [
    undefined,
    null,
    true,
    "approvals",
    {},
    new Set(["approvals"]),
    ["must-not-leak"],
    [1],
    ["approvals", "approvals"],
    new Array(1),
    new Array(7),
  ]) {
    expectLegacyValidationError(() => legacyCapabilitiesToDescriptor(value));
  }

  const extra = ["approvals"];
  Object.defineProperty(extra, "extra", { value: true, enumerable: true });
  expectLegacyValidationError(() => legacyCapabilitiesToDescriptor(extra));

  const symbol = ["approvals"];
  Object.defineProperty(symbol, Symbol("must-not-leak"), {
    value: true,
    enumerable: true,
  });
  expectLegacyValidationError(() => legacyCapabilitiesToDescriptor(symbol));

  const nonEnumerable = ["approvals"];
  Object.defineProperty(nonEnumerable, "0", {
    value: "approvals",
    enumerable: false,
  });
  expectLegacyValidationError(() => legacyCapabilitiesToDescriptor(nonEnumerable));
});

test("rejects accessors, proxies, revoked proxies, and hostile prototypes", () => {
  let getterCalls = 0;
  const accessor = ["approvals"];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-leak";
    },
  });
  expectLegacyValidationError(() => legacyCapabilitiesToDescriptor(accessor));
  assert.equal(getterCalls, 0);

  expectLegacyValidationError(() =>
    legacyCapabilitiesToDescriptor(new Proxy(["approvals"], {}))
  );
  const revoked = Proxy.revocable(["approvals"], {});
  revoked.revoke();
  expectLegacyValidationError(() =>
    legacyCapabilitiesToDescriptor(revoked.proxy)
  );

  const replacedPrototype = ["approvals"];
  Object.setPrototypeOf(replacedPrototype, null);
  expectLegacyValidationError(() =>
    legacyCapabilitiesToDescriptor(replacedPrototype)
  );

  class CapabilityArray extends Array<string> {}
  expectLegacyValidationError(() =>
    legacyCapabilitiesToDescriptor(new CapabilityArray("approvals"))
  );
});

test("rejects invalid key sets before collecting property descriptors", () => {
  const oversized = new Array(7);
  const polluted: string[] = [];
  for (let index = 0; index < 64; index += 1) {
    Object.defineProperty(polluted, `extra_${index}`, {
      value: "must-not-leak",
      enumerable: true,
    });
  }
  const original = Object.getOwnPropertyDescriptors;
  const reads = new Map<object, number>([
    [oversized, 0],
    [polluted, 0],
  ]);
  Object.getOwnPropertyDescriptors = ((target: object) => {
    const count = reads.get(target);
    if (count !== undefined) reads.set(target, count + 1);
    return original(target);
  }) as typeof Object.getOwnPropertyDescriptors;
  try {
    expectLegacyValidationError(() =>
      legacyCapabilitiesToDescriptor(oversized)
    );
    expectLegacyValidationError(() =>
      legacyCapabilitiesToDescriptor(polluted)
    );
  } finally {
    Object.getOwnPropertyDescriptors = original;
  }
  assert.equal(reads.get(oversized), 0);
  assert.equal(reads.get(polluted), 0);
});
