import assert from "node:assert/strict";
import test from "node:test";

import * as model from "../src/core/model.js";

type RuntimeFunction = (...args: never[]) => unknown;

function contractFunction<T extends RuntimeFunction>(name: string): T {
  const value = (model as unknown as Record<string, unknown>)[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as T;
}

function snapshotImpact(value: unknown): Record<string, unknown> {
  return contractFunction<(input: unknown) => Record<string, unknown>>(
    "snapshotImpactEstimate",
  )(value);
}

function snapshotConfidence(value: unknown): Record<string, unknown> {
  return contractFunction<(input: unknown) => Record<string, unknown>>(
    "snapshotFindingConfidence",
  )(value);
}

function rejection(
  callback: () => unknown,
  message: "invalid impact estimate" | "invalid finding confidence",
): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.message, message);
    assert.doesNotMatch(error.message, /secret|trap|getter|attacker/iu);
    return true;
  });
}

test("snapshots exact impact estimates without fabricating expected values", () => {
  const range = {
    lower_ms: 10,
    expected_ms: 15,
    upper_ms: 20,
    kind: "critical_path_latency",
  };
  const snapshot = snapshotImpact(range);
  assert.deepEqual(snapshot, range);
  assert.notEqual(snapshot, range);

  assert.deepEqual(snapshotImpact({
    lower_ms: 0,
    upper_ms: 0,
    kind: "resource_cost",
  }), {
    lower_ms: 0,
    upper_ms: 0,
    kind: "resource_cost",
  });
  assert.deepEqual(snapshotImpact({
    lower_ms: 10,
    expected_ms: 10,
    upper_ms: 20,
    kind: "critical_path_latency",
  }).expected_ms, 10);
  assert.deepEqual(snapshotImpact({
    lower_ms: 10,
    expected_ms: 20,
    upper_ms: 20,
    kind: "critical_path_latency",
  }).expected_ms, 20);
});

test("rejects invalid impact numbers and bounds with a content-free error", () => {
  const valid = {
    lower_ms: 0,
    upper_ms: 10,
    kind: "critical_path_latency",
  };
  const invalid: unknown[] = [
    { ...valid, lower_ms: Number.NaN },
    { ...valid, lower_ms: Number.POSITIVE_INFINITY },
    { ...valid, lower_ms: Number.NEGATIVE_INFINITY },
    { ...valid, lower_ms: -1 },
    { ...valid, lower_ms: -0 },
    { ...valid, upper_ms: Number.NaN },
    { ...valid, upper_ms: Number.POSITIVE_INFINITY },
    { ...valid, upper_ms: Number.NEGATIVE_INFINITY },
    { ...valid, upper_ms: -1 },
    { ...valid, upper_ms: -0 },
    { ...valid, lower_ms: 11 },
    { ...valid, expected_ms: Number.NaN },
    { ...valid, expected_ms: Number.POSITIVE_INFINITY },
    { ...valid, expected_ms: -1 },
    { ...valid, expected_ms: -0 },
    { ...valid, expected_ms: 11 },
    { ...valid, expected_ms: undefined },
    { ...valid, kind: "policy_latency" },
  ];
  for (const value of invalid) {
    rejection(() => snapshotImpact(value), "invalid impact estimate");
  }
  rejection(() => snapshotImpact({
    lower_ms: 10,
    expected_ms: 9,
    upper_ms: 20,
    kind: "critical_path_latency",
  }), "invalid impact estimate");
});

test("snapshots exact confidence and validates completeness boundaries", () => {
  for (const source_completeness of [0, 0.5, 1]) {
    const value = {
      evidence: "high",
      causal: "medium",
      source_completeness,
    };
    const snapshot = snapshotConfidence(value);
    assert.deepEqual(snapshot, value);
    assert.notEqual(snapshot, value);
  }

  for (const value of [
    { evidence: "unknown", causal: "high", source_completeness: 1 },
    { evidence: "high", causal: "unknown", source_completeness: 1 },
    { evidence: "high", causal: "high", source_completeness: Number.NaN },
    { evidence: "high", causal: "high", source_completeness: Number.POSITIVE_INFINITY },
    { evidence: "high", causal: "high", source_completeness: -1 },
    { evidence: "high", causal: "high", source_completeness: -0 },
    { evidence: "high", causal: "high", source_completeness: 1.01 },
  ]) {
    rejection(
      () => snapshotConfidence(value),
      "invalid finding confidence",
    );
  }
});

test("rejects partial, extra, hidden, accessor, prototype, and proxy inputs", () => {
  const impact = {
    lower_ms: 0,
    upper_ms: 10,
    kind: "critical_path_latency",
  };
  const confidence = {
    evidence: "high",
    causal: "high",
    source_completeness: 1,
  };

  const hiddenImpact = { ...impact };
  Object.defineProperty(hiddenImpact, "secret", {
    value: "attacker-secret",
    enumerable: false,
  });
  const hiddenConfidence = { ...confidence };
  Object.defineProperty(hiddenConfidence, "secret", {
    value: "attacker-secret",
    enumerable: false,
  });

  let impactGetterCalls = 0;
  const accessorImpact = { ...impact };
  Object.defineProperty(accessorImpact, "lower_ms", {
    enumerable: true,
    get() {
      impactGetterCalls += 1;
      throw new Error("secret getter value");
    },
  });
  let confidenceGetterCalls = 0;
  const accessorConfidence = { ...confidence };
  Object.defineProperty(accessorConfidence, "causal", {
    enumerable: true,
    get() {
      confidenceGetterCalls += 1;
      throw new Error("secret getter value");
    },
  });

  const impactWithSymbol = { ...impact } as Record<PropertyKey, unknown>;
  impactWithSymbol[Symbol("secret")] = "attacker-secret";
  const confidenceWithSymbol = { ...confidence } as Record<PropertyKey, unknown>;
  confidenceWithSymbol[Symbol("secret")] = "attacker-secret";

  const revokedImpact = Proxy.revocable({ ...impact }, {});
  revokedImpact.revoke();
  const revokedConfidence = Proxy.revocable({ ...confidence }, {});
  revokedConfidence.revoke();

  const invalidImpacts: unknown[] = [
    null,
    [],
    { lower_ms: 0, kind: "critical_path_latency" },
    { ...impact, extra: "attacker-secret" },
    hiddenImpact,
    accessorImpact,
    impactWithSymbol,
    Object.assign(Object.create(null), impact),
    new Proxy({ ...impact }, {}),
    new Proxy({ ...impact }, {
      ownKeys() {
        throw new Error("secret trap value");
      },
    }),
    revokedImpact.proxy,
  ];
  for (const value of invalidImpacts) {
    rejection(() => snapshotImpact(value), "invalid impact estimate");
  }
  assert.equal(impactGetterCalls, 0);

  const invalidConfidences: unknown[] = [
    null,
    [],
    { evidence: "high", causal: "high" },
    { ...confidence, extra: "attacker-secret" },
    hiddenConfidence,
    accessorConfidence,
    confidenceWithSymbol,
    Object.assign(Object.create(null), confidence),
    new Proxy({ ...confidence }, {}),
    new Proxy({ ...confidence }, {
      getOwnPropertyDescriptor() {
        throw new Error("secret trap value");
      },
    }),
    revokedConfidence.proxy,
  ];
  for (const value of invalidConfidences) {
    rejection(
      () => snapshotConfidence(value),
      "invalid finding confidence",
    );
  }
  assert.equal(confidenceGetterCalls, 0);
});

test("derives scalar projections, severity, and fixed-order rationale", () => {
  const projectConfidence = contractFunction<
    (value: Record<string, unknown>) => string
  >("projectFindingConfidence");
  const projectRecoverable = contractFunction<
    (value: Record<string, unknown>) => Record<string, unknown>
  >("projectFindingRecoverable");
  const severity = contractFunction<
    (impact: Record<string, unknown>, confidence: Record<string, unknown>) => string
  >("findingSeverity");
  const rationale = contractFunction<
    (
      impact: Record<string, unknown>,
      confidence: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => string[]
  >("findingScoringRationale");
  const strictHigh = contractFunction<
    (value: Record<string, unknown>) => boolean
  >("isStrictHighConfidence");

  const exact = {
    lower_ms: 120,
    upper_ms: 120,
    kind: "critical_path_latency",
  };
  const upper = {
    lower_ms: 0,
    upper_ms: 120,
    kind: "critical_path_latency",
  };
  const high = {
    evidence: "high",
    causal: "high",
    source_completeness: 1,
  };
  const partial = { ...high, source_completeness: 0.5 };

  assert.equal(projectConfidence(high), "high");
  assert.equal(projectConfidence(partial), "medium");
  assert.equal(projectConfidence({ ...high, causal: "low" }), "low");
  assert.deepEqual(projectRecoverable(exact), { min: 0.002, bound: "point" });
  assert.deepEqual(projectRecoverable(upper), { min: 0.002, bound: "upper" });
  assert.equal(severity({ ...upper, upper_ms: 0 }, high), "info");
  assert.equal(severity(exact, high), "high");
  assert.equal(severity(upper, partial), "medium");
  assert.equal(severity(upper, { ...high, causal: "low" }), "low");
  assert.equal(strictHigh(high), true);
  assert.equal(strictHigh(partial), false);
  assert.deepEqual(rationale(
    {
      lower_ms: 0,
      upper_ms: 120,
      kind: "resource_cost",
    },
    partial,
    { policy_dependent: true, legacy_projection: true },
  ), [
    "estimated_upper_only",
    "resource_cost_only",
    "policy_dependent",
    "partial_source",
    "legacy_projection",
  ]);
  assert.deepEqual(rationale(exact, high), ["observed_lower_bound"]);
});
