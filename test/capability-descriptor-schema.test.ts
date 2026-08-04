import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

type JsonObject = Record<string, unknown>;
type Evidence = {
  quality: string;
  provenance: string;
};
type Capability = {
  id: string;
  legacy_id?: string;
  version?: string;
  version_range?: string;
  requirement: string;
  state: string;
  evidence: Evidence;
  timestamp_precision: string;
  unexpected?: boolean;
};
type Descriptor = {
  $schema: string;
  schema_version: number;
  descriptor_version: string;
  undeclared_capability_state: string;
  capabilities: Capability[];
  unexpected?: boolean;
};

const SCHEMA_ID =
  "https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/capability-descriptor-v1.schema.json";
const LEGACY_IDS = [
  "approvals",
  "branch_rows",
  "edit_fragments",
  "sidechains",
  "token_usage",
  "tool_timestamps",
];

function object(value: unknown, label: string): JsonObject {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonObject;
}

function property(parent: JsonObject, name: string): JsonObject {
  return object(object(parent.properties, "properties")[name], name);
}

function assertClosedObjects(value: unknown, path = "#"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClosedObjects(item, `${path}/${index}`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const node = value as JsonObject;
  if (node.type === "object") {
    assert.equal(node.additionalProperties, false, `${path} must be closed`);
  }
  for (const [key, child] of Object.entries(node)) {
    assertClosedObjects(child, `${path}/${key}`);
  }
}

async function loadContract(): Promise<{
  schema: JsonObject;
  fixture: Descriptor;
}> {
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
  return {
    schema: object(JSON.parse(schemaRaw), "schema"),
    fixture: JSON.parse(fixtureRaw) as Descriptor,
  };
}

test("publishes a closed Draft 2020-12 capability descriptor contract", async () => {
  const { schema } = await loadContract();
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, SCHEMA_ID);
  assert.equal(schema.type, "object");
  assertClosedObjects(schema);

  assert.equal(property(schema, "schema_version").const, 1);
  assert.equal(property(schema, "descriptor_version").const, "1.0.0");
  assert.equal(property(schema, "undeclared_capability_state").const, "unknown");
  const capabilityId = object(
    object(schema.$defs, "$defs").capability_id,
    "capability_id",
  );
  assert.match(
    String(capabilityId.description),
    /undeclared.+unknown.+not supported/iu,
  );

  const packageJson = object(
    JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")),
    "package.json",
  );
  assert.ok(
    Array.isArray(packageJson.files) && packageJson.files.includes("schemas"),
    "the npm artifact must publish the schemas directory",
  );
});

test("Ajv 2020 accepts the canonical fixture and every support state", async () => {
  const { schema, fixture } = await loadContract();
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));

  const supportedStates: Array<[string, string, string]> = [
    ["supported_exact", "exact", "producer_declared"],
    ["supported_estimated", "estimated", "derived"],
    ["supported_partial", "partial", "observed"],
  ];
  for (const [state, quality, provenance] of supportedStates) {
    const candidate = structuredClone(fixture);
    Object.assign(candidate.capabilities[0]!, {
      requirement: "required",
      state,
      evidence: { quality, provenance },
      timestamp_precision: "nanosecond",
    });
    assert.equal(validate(candidate), true, `${state}: ${JSON.stringify(validate.errors)}`);
  }

  for (const [state, quality, provenance, precision] of [
    ["unsupported", "none", "observed", "not_applicable"],
    ["unknown", "unknown", "unknown", "unknown"],
  ]) {
    const candidate = structuredClone(fixture);
    Object.assign(candidate.capabilities[0]!, {
      state,
      evidence: { quality, provenance },
      timestamp_precision: precision,
    });
    assert.equal(validate(candidate), true, `${state}: ${JSON.stringify(validate.errors)}`);
  }

  for (const rangeValue of [
    "^1.0.0",
    "~1.0.0",
    ">=1.0.0",
    ">=1.0.0 <2.0.0",
    "^1.0.0-alpha.1+build.5",
  ]) {
    const range = structuredClone(fixture);
    delete range.capabilities[0]!.version;
    range.capabilities[0]!.version_range = rangeValue;
    assert.equal(
      validate(range),
      true,
      `${rangeValue}: ${JSON.stringify(validate.errors)}`,
    );
  }
});

test("Ajv 2020 rejects malformed, ambiguous, and contradictory descriptors", async () => {
  const { schema, fixture } = await loadContract();
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  const reject = (candidate: Descriptor, label: string): void => {
    assert.equal(validate(candidate), false, label);
  };

  const rootUnknown = structuredClone(fixture);
  rootUnknown.unexpected = true;
  reject(rootUnknown, "root unknown field");
  const capabilityUnknown = structuredClone(fixture);
  capabilityUnknown.capabilities[0]!.unexpected = true;
  reject(capabilityUnknown, "capability unknown field");
  const evidenceUnknown = structuredClone(fixture);
  Object.assign(evidenceUnknown.capabilities[0]!.evidence, { unexpected: true });
  reject(evidenceUnknown, "evidence unknown field");

  for (const [field, value] of [
    ["$schema", "https://example.test/wrong.schema.json"],
    ["schema_version", 2],
    ["descriptor_version", "2.0.0"],
    ["undeclared_capability_state", "supported_exact"],
  ] as const) {
    const candidate = structuredClone(fixture) as unknown as JsonObject;
    candidate[field] = value;
    reject(candidate as unknown as Descriptor, `bad ${field}`);
  }

  for (const id of [
    "tool_timestamps",
    "ccprof.dev/tool_timestamps",
    "CCPROF.dev/capabilities/tool_timestamps",
    "ccprof.dev/capabilities/",
  ]) {
    const candidate = structuredClone(fixture);
    candidate.capabilities[0]!.id = id;
    reject(candidate, `malformed id: ${id}`);
  }

  for (const version of ["1.0", "01.0.0", "1.0.0-"]) {
    const candidate = structuredClone(fixture);
    candidate.capabilities[0]!.version = version;
    reject(candidate, `malformed version: ${version}`);
  }
  for (const rangeValue of [
    "latest",
    ">=1",
    ">=01.0.0 <2.0.0",
    ">=1.0.0-01",
    "^1.0.0-alpha.01",
  ]) {
    const candidate = structuredClone(fixture);
    delete candidate.capabilities[0]!.version;
    candidate.capabilities[0]!.version_range = rangeValue;
    reject(candidate, `malformed range: ${rangeValue}`);
  }

  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    const fields: Array<[string, (capability: Capability) => void]> = [
      ["capability id", (capability) => {
        capability.id += terminator;
      }],
      ["legacy id", (capability) => {
        capability.legacy_id = `${capability.legacy_id!}${terminator}`;
      }],
      ["exact version", (capability) => {
        capability.version = `${capability.version!}${terminator}`;
      }],
      [
        "version range",
        (capability) => {
          delete capability.version;
          capability.version_range = `^1.0.0${terminator}`;
        },
      ],
    ];
    for (const [field, mutate] of fields) {
      const candidate = structuredClone(fixture);
      mutate(candidate.capabilities[0]!);
      reject(candidate, `${field} with trailing line terminator`);
    }
  }

  const bothVersions = structuredClone(fixture);
  bothVersions.capabilities[0]!.version_range = "^1.0.0";
  reject(bothVersions, "exact version and range together");
  const noVersion = structuredClone(fixture);
  delete noVersion.capabilities[0]!.version;
  reject(noVersion, "exact version and range both absent");

  for (const [field, value] of [
    ["requirement", "recommended"],
    ["state", "supported"],
    ["timestamp_precision", "minute"],
  ] as const) {
    const candidate = structuredClone(fixture);
    candidate.capabilities[0]![field] = value;
    reject(candidate, `unknown ${field}`);
  }
  for (const [field, value] of [
    ["quality", "verified"],
    ["provenance", "inferred"],
  ] as const) {
    const candidate = structuredClone(fixture);
    candidate.capabilities[0]!.evidence[field] = value;
    reject(candidate, `unknown evidence ${field}`);
  }

  for (const [state, quality] of [
    ["supported_exact", "exact"],
    ["supported_estimated", "estimated"],
    ["supported_partial", "partial"],
  ]) {
    const candidate = structuredClone(fixture);
    Object.assign(candidate.capabilities[0]!, {
      state,
      evidence: { quality, provenance: "observed" },
    });
    delete (candidate.capabilities[0] as Partial<Capability>).evidence;
    reject(candidate, `${state} without evidence`);
  }

  for (const [state, quality, wrongQuality] of [
    ["supported_exact", "exact", "estimated"],
    ["supported_estimated", "estimated", "exact"],
    ["supported_partial", "partial", "exact"],
  ]) {
    const wrongQualityCandidate = structuredClone(fixture);
    Object.assign(wrongQualityCandidate.capabilities[0]!, {
      state,
      evidence: { quality: wrongQuality, provenance: "observed" },
    });
    reject(wrongQualityCandidate, `${state} with wrong evidence quality`);

    const unknownProvenance = structuredClone(fixture);
    Object.assign(unknownProvenance.capabilities[0]!, {
      state,
      evidence: { quality, provenance: "unknown" },
    });
    reject(unknownProvenance, `${state} with unknown provenance`);
  }

  for (const state of ["unsupported", "unknown"]) {
    const candidate = structuredClone(fixture);
    Object.assign(candidate.capabilities[0]!, {
      state,
      evidence: { quality: "exact", provenance: "producer_declared" },
      timestamp_precision: state === "unknown" ? "unknown" : "not_applicable",
    });
    reject(candidate, `${state} with supported evidence`);
  }

  for (const [state, quality, provenance, precision] of [
    ["unsupported", "none", "observed", "unknown"],
    ["unknown", "unknown", "unknown", "not_applicable"],
  ]) {
    const candidate = structuredClone(fixture);
    Object.assign(candidate.capabilities[0]!, {
      state,
      evidence: { quality, provenance },
      timestamp_precision: precision,
    });
    reject(candidate, `${state} with contradictory timestamp precision`);
  }
});

test("canonical legacy projection is exact, unique, sorted, and bijective", async () => {
  const { fixture } = await loadContract();
  const legacyIds = fixture.capabilities.map((capability) => capability.legacy_id);
  const ids = fixture.capabilities.map((capability) => capability.id);

  assert.deepEqual(legacyIds, LEGACY_IDS);
  assert.deepEqual([...legacyIds].sort(), legacyIds);
  assert.equal(new Set(legacyIds).size, LEGACY_IDS.length);
  assert.equal(new Set(ids).size, LEGACY_IDS.length);
  assert.deepEqual(
    ids,
    LEGACY_IDS.map((legacyId) => `ccprof.dev/capabilities/${legacyId}`),
  );
  assert.ok(fixture.capabilities.every(({ requirement }) => requirement === "optional"));
  assert.ok(fixture.capabilities.every(({ state }) => state === "supported_partial"));
  assert.ok(fixture.capabilities.every(({ evidence }) =>
    evidence.quality === "unknown" && evidence.provenance === "adapter_declared"
  ));
  assert.deepEqual(
    fixture.capabilities.map(({ timestamp_precision }) => timestamp_precision),
    [
      "not_applicable",
      "not_applicable",
      "not_applicable",
      "not_applicable",
      "not_applicable",
      "unknown",
    ],
  );
  assert.equal(fixture.capabilities[4]!.legacy_id, "token_usage");
  assert.deepEqual(fixture.capabilities[4]!.evidence, {
    quality: "unknown",
    provenance: "adapter_declared",
  });
});
