import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createBuiltInSourceCoverageAccumulator,
  unavailableSourceCoverage,
} from "../src/sources/source-coverage.js";

const PARSER_STATE_FINGERPRINT: `sha256:${string}` =
  `sha256:${"a".repeat(64)}`;

function expectedFingerprint(adapterId: "claude" | "codex"): string {
  return `sha256:${createHash("sha256")
    .update("source-coverage-schema-v1")
    .update("\0")
    .update(JSON.stringify([
      adapterId,
      "1.0.0",
      "2.0.0",
      PARSER_STATE_FINGERPRINT,
    ]))
    .digest("hex")}`;
}

test("source coverage contract snapshots exact observations", () => {
  const accumulator = createBuiltInSourceCoverageAccumulator(
    "claude",
    "1.0.0",
    "2.0.0",
    PARSER_STATE_FINGERPRINT,
  );

  const initial = accumulator.snapshot();
  assert.deepEqual(initial, {
    status: "available",
    adapter_id: "claude",
    adapter_version: "1.0.0",
    parser_version: "2.0.0",
    schema_fingerprint: expectedFingerprint("claude"),
    files_discovered: 0,
    files_parsed: 0,
    rows_seen: 0,
    rows_accepted: 0,
    events_emitted: 0,
    completeness: "complete",
  });
  assert.equal(Object.isFrozen(initial), true);

  accumulator.recordDiscoveredFile();
  accumulator.recordParsedFile(7, 5, 3, "complete");
  const observed = accumulator.snapshot();
  assert.deepEqual(observed, {
    ...initial,
    files_discovered: 1,
    files_parsed: 1,
    rows_seen: 7,
    rows_accepted: 5,
    events_emitted: 3,
  });
  assert.notEqual(observed, initial);
  assert.equal(Object.isFrozen(observed), true);
});

test("source coverage contract fingerprints are deterministic and adapter-specific", () => {
  const create = (adapterId: "claude" | "codex") =>
    createBuiltInSourceCoverageAccumulator(
      adapterId,
      "1.0.0",
      "2.0.0",
      PARSER_STATE_FINGERPRINT,
    ).snapshot().schema_fingerprint;

  assert.equal(create("claude"), expectedFingerprint("claude"));
  assert.equal(create("claude"), create("claude"));
  assert.equal(create("codex"), expectedFingerprint("codex"));
  assert.notEqual(create("claude"), create("codex"));
  assert.match(create("claude"), /^sha256:[a-f0-9]{64}$/u);
});

test("source coverage contract keeps partial completeness monotonic", () => {
  const accumulator = createBuiltInSourceCoverageAccumulator(
    "codex", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT,
  );
  accumulator.recordDiscoveredFile();
  accumulator.recordParsedFile(1, 1, 0, "partial");
  assert.equal(accumulator.snapshot().completeness, "partial");

  accumulator.recordDiscoveredFile();
  accumulator.recordParsedFile(0, 0, 0, "complete");
  accumulator.markPartial();
  assert.equal(accumulator.snapshot().completeness, "partial");
});

test("source coverage contract rejects invalid identities and observations", () => {
  const create = (...values: unknown[]) =>
    createBuiltInSourceCoverageAccumulator(...values as [
      "claude", "1.0.0", string, `sha256:${string}`,
    ]);
  const invalidCreates: unknown[][] = [
    ["custom", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT],
    ["claude", "2.0.0", "2.0.0", PARSER_STATE_FINGERPRINT],
    ["claude", "1.0.0", "", PARSER_STATE_FINGERPRINT],
    ["claude", "1.0.0", "x".repeat(257), PARSER_STATE_FINGERPRINT],
    ["claude", "1.0.0", "2.0.0", "sha256:ABC"],
  ];
  for (const values of invalidCreates) assert.throws(() => create(...values), TypeError);

  const invalidCounts = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalidCounts) {
    const accumulator = create("claude", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT);
    accumulator.recordDiscoveredFile();
    assert.throws(() => accumulator.recordParsedFile(value, 0, 0, "complete"), TypeError);
    assert.throws(() => accumulator.recordParsedFile(0, value, 0, "complete"), TypeError);
    assert.throws(() => accumulator.recordParsedFile(0, 0, value, "complete"), TypeError);
  }

  const impossibleRows = create("claude", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT);
  impossibleRows.recordDiscoveredFile();
  assert.throws(() => impossibleRows.recordParsedFile(1, 2, 0, "complete"), TypeError);

  const undiscovered = create("claude", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT);
  assert.throws(() => undiscovered.recordParsedFile(0, 0, 0, "complete"), TypeError);
});

test("source coverage contract rejects non-string parser fingerprints without coercion", () => {
  let coercions = 0;
  const fingerprint = {
    toString(): string {
      coercions += 1;
      return PARSER_STATE_FINGERPRINT;
    },
  };
  assert.throws(() => createBuiltInSourceCoverageAccumulator(
    "claude", "1.0.0", "2.0.0",
    fingerprint as unknown as `sha256:${string}`,
  ), TypeError);
  assert.equal(coercions, 0);
});

test("source coverage contract rejects counter overflow", () => {
  const accumulator = createBuiltInSourceCoverageAccumulator(
    "claude", "1.0.0", "2.0.0", PARSER_STATE_FINGERPRINT,
  );
  accumulator.recordDiscoveredFile();
  accumulator.recordParsedFile(Number.MAX_SAFE_INTEGER, 0, 0, "complete");
  accumulator.recordDiscoveredFile();
  assert.throws(
    () => accumulator.recordParsedFile(1, 0, 0, "complete"),
    TypeError,
  );
});

test("source coverage contract exposes one frozen unavailable value", () => {
  const first = unavailableSourceCoverage();
  const second = unavailableSourceCoverage();
  assert.deepEqual(first, { status: "unavailable" });
  assert.equal(first, second);
  assert.equal(Object.isFrozen(first), true);
});
