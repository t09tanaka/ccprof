import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

type JsonObject = Record<string, unknown>;

const SCHEMA_URI = "https://schemas.ccprof.dev/trace-envelope/v1.json";
const SCHEMA_PATH = "schemas/trace-envelope-v1.schema.json";
const FIXTURE_PATH =
  "test/fixtures/protocol/dummy-agent-trace-envelope-v1.json";
const FORBIDDEN_FIXTURE_IDENTITIES = /claude|codex|github|pull_request/iu;

function object(value: unknown, label: string): JsonObject {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonObject;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(process.cwd(), path), "utf8")) as unknown;
}

async function loadContract(): Promise<{
  fixture: JsonObject;
  schema: JsonObject;
  validate: ValidateFunction;
}> {
  const [schemaValue, fixtureValue] = await Promise.all([
    readJson(SCHEMA_PATH),
    readJson(FIXTURE_PATH),
  ]);
  const schema = object(schemaValue, "trace envelope schema");
  const fixture = object(fixtureValue, "dummy-agent fixture");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return { fixture, schema, validate: ajv.compile(schema) };
}

function clone(value: JsonObject): JsonObject {
  return structuredClone(value);
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) =>
    `${error.instancePath || "/"} ${error.message ?? "invalid"}`
  ).join("; ") ?? "no validation errors";
}

function assertValid(
  validate: ValidateFunction,
  value: unknown,
  label: string,
): void {
  assert.equal(
    validate(value),
    true,
    `${label}: ${validationMessage(validate.errors)}`,
  );
}

function assertInvalid(
  validate: ValidateFunction,
  value: unknown,
  label: string,
): void {
  assert.equal(validate(value), false, `${label} unexpectedly validated`);
  assert.ok(validate.errors?.length, `${label} returned no validation errors`);
}

function at(value: JsonObject, key: string): JsonObject {
  return object(value[key], key);
}

test("published Trace Envelope v1 schema is stable, closed, and packaged", async () => {
  const [{ schema }, manifestValue] = await Promise.all([
    loadContract(),
    readJson("package.json"),
  ]);
  const manifest = object(manifestValue, "package manifest");
  const definitions = object(schema.$defs, "$defs");

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, SCHEMA_URI);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "$schema",
    "protocol_version",
    "producer",
    "trace_id",
    "span_id",
    "sequence",
    "timestamp",
    "work_unit",
    "event",
    "privacy",
    "provenance",
  ]);

  for (const name of [
    "producer",
    "timestamp",
    "work_unit",
    "event",
    "privacy",
    "provenance_entry",
  ]) {
    assert.equal(
      object(definitions[name], `$defs.${name}`).additionalProperties,
      false,
      `$defs.${name} must fail closed`,
    );
  }
  const event = object(definitions.event, "$defs.event");
  const eventProperties = object(event.properties, "$defs.event.properties");
  assert.equal(
    object(eventProperties.payload, "$defs.event.properties.payload")
      .additionalProperties,
    true,
    "event.payload is the external-schema-owned exception",
  );

  assert.ok(Array.isArray(manifest.files));
  assert.ok(manifest.files.includes("schemas"));
});

test("neutral dummy-agent fixture validates without vendor or forge identity", async () => {
  const raw = await readFile(resolve(process.cwd(), FIXTURE_PATH), "utf8");
  assert.doesNotMatch(raw, FORBIDDEN_FIXTURE_IDENTITIES);

  const { fixture, validate } = await loadContract();
  assertValid(validate, fixture, "fixture");

  const child = clone(fixture);
  child.parent_span_id = "b7ad6b7169203331";
  assertValid(validate, child, "fixture with parent span");

  const extensiblePayload = clone(fixture);
  at(at(extensiblePayload, "event"), "payload").external_extension = {
    nested: [true, 1, "value"],
  };
  assertValid(validate, extensiblePayload, "externally schema'd payload");
});

test("unknown envelope fields and missing required fields fail closed", async () => {
  const { fixture, validate } = await loadContract();
  const cases: Array<[string, (value: JsonObject) => void]> = [
    ["unknown root field", (value) => {
      value.unknown = true;
    }],
    ["unknown producer field", (value) => {
      at(value, "producer").unknown = true;
    }],
    ["unknown timestamp field", (value) => {
      at(value, "timestamp").unknown = true;
    }],
    ["unknown event wrapper field", (value) => {
      at(value, "event").unknown = true;
    }],
    ["unknown provenance field", (value) => {
      object((value.provenance as unknown[])[0], "provenance[0]").unknown = true;
    }],
    ["missing protocol version", (value) => {
      delete value.protocol_version;
    }],
    ["missing producer version", (value) => {
      delete at(value, "producer").version;
    }],
    ["missing event payload schema", (value) => {
      delete at(value, "event").payload_schema;
    }],
    ["missing privacy", (value) => {
      delete value.privacy;
    }],
  ];

  for (const [label, mutate] of cases) {
    const value = clone(fixture);
    mutate(value);
    assertInvalid(validate, value, label);
  }
});

test("W3C trace, span, and optional parent identifiers fail invalid encodings", async () => {
  const { fixture, validate } = await loadContract();
  const cases: Array<[string, (value: JsonObject) => void]> = [
    ["all-zero trace", (value) => {
      value.trace_id = "0".repeat(32);
    }],
    ["short trace", (value) => {
      value.trace_id = "a".repeat(31);
    }],
    ["uppercase trace", (value) => {
      value.trace_id = "4BF92F3577B34DA6A3CE929D0E0E4736";
    }],
    ["non-hex trace", (value) => {
      value.trace_id = `${"a".repeat(31)}g`;
    }],
    ["all-zero span", (value) => {
      value.span_id = "0".repeat(16);
    }],
    ["long span", (value) => {
      value.span_id = "a".repeat(17);
    }],
    ["all-zero parent", (value) => {
      value.parent_span_id = "0".repeat(16);
    }],
    ["uppercase parent", (value) => {
      value.parent_span_id = "B7AD6B7169203331";
    }],
  ];

  for (const [label, mutate] of cases) {
    const value = clone(fixture);
    mutate(value);
    assertInvalid(validate, value, label);
  }
});

test("sequence and nanoseconds reject negative, unsafe, malformed, and lossy values", async () => {
  const { fixture, validate } = await loadContract();
  const cases: Array<[string, (value: JsonObject) => void]> = [
    ["negative sequence", (value) => {
      value.sequence = -1;
    }],
    ["fractional sequence", (value) => {
      value.sequence = 1.5;
    }],
    ["unsafe sequence", (value) => {
      value.sequence = 9_007_199_254_740_992;
    }],
    ["numeric wall time", (value) => {
      at(value, "timestamp").wall_time_unix_ns = 9_007_199_254_740_992;
    }],
    ["negative wall time", (value) => {
      at(value, "timestamp").wall_time_unix_ns = "-1";
    }],
    ["leading-zero monotonic offset", (value) => {
      at(value, "timestamp").monotonic_offset_ns = "01";
    }],
    ["signed monotonic offset", (value) => {
      at(value, "timestamp").monotonic_offset_ns = "+1";
    }],
    ["fractional uncertainty", (value) => {
      at(value, "timestamp").uncertainty_ns = "1.5";
    }],
    ["exponent uncertainty", (value) => {
      at(value, "timestamp").uncertainty_ns = "1e3";
    }],
    ["empty uncertainty", (value) => {
      at(value, "timestamp").uncertainty_ns = "";
    }],
    ["overlong wall time", (value) => {
      at(value, "timestamp").wall_time_unix_ns = "1".repeat(40);
    }],
  ];

  for (const [label, mutate] of cases) {
    const value = clone(fixture);
    mutate(value);
    assertInvalid(validate, value, label);
  }
});

test("namespaces, absolute URIs, privacy, and JSON-pointer provenance are constrained", async () => {
  const { fixture, validate } = await loadContract();
  const cases: Array<[string, (value: JsonObject) => void]> = [
    ["unnamespaced producer", (value) => {
      at(value, "producer").id = "dummy-agent";
    }],
    ["uppercase producer namespace", (value) => {
      at(value, "producer").id = "Org.example.dummy-agent";
    }],
    ["unnamespaced work-unit kind", (value) => {
      at(value, "work_unit").kind = "task";
    }],
    ["relative event type", (value) => {
      at(value, "event").type = "events/task-observed";
    }],
    ["relative payload schema", (value) => {
      at(value, "event").payload_schema = "/schemas/event.json";
    }],
    ["relative provenance source", (value) => {
      object((value.provenance as unknown[])[0], "provenance[0]").source =
        "clock/wall";
    }],
    ["relative provenance pointer", (value) => {
      object((value.provenance as unknown[])[0], "provenance[0]").path =
        "timestamp/wall_time_unix_ns";
    }],
    ["invalid JSON-pointer escape", (value) => {
      object((value.provenance as unknown[])[0], "provenance[0]").path =
        "/event/~2invalid";
    }],
    ["unknown privacy classification", (value) => {
      at(value, "privacy").classification = "secret-ish";
    }],
    ["string retention state", (value) => {
      at(value, "privacy").content_retained = "false";
    }],
  ];

  for (const [label, mutate] of cases) {
    const value = clone(fixture);
    mutate(value);
    assertInvalid(validate, value, label);
  }
});
