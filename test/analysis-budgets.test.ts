import assert from "node:assert/strict";
import test from "node:test";

import {
  AnalysisBudgetMeter,
  AnalysisBudgetValidationError,
  normalizeAnalysisBudgets,
  normalizeAnalysisBudgetResult,
  type AnalysisBudgetClock,
  type AnalysisBudgets,
} from "../src/analysis/budgets.js";

const LIMIT_KEYS = [
  "max_input_bytes",
  "max_input_events",
  "max_wall_ms",
  "max_cpu_ms",
  "max_output_bytes",
  "max_source_items",
] as const;

function limits(
  overrides: Partial<AnalysisBudgets> = {},
): AnalysisBudgets {
  return {
    max_input_bytes: 10,
    max_input_events: 3,
    max_wall_ms: 20,
    max_cpu_ms: 15,
    max_output_bytes: 200,
    max_source_items: 2,
    ...overrides,
  };
}

class ScriptedClock implements AnalysisBudgetClock {
  readonly #wall: number[];
  readonly #cpu: number[];
  #wallIndex = 0;
  #cpuIndex = 0;

  constructor(wall: number[], cpu: number[]) {
    this.#wall = wall;
    this.#cpu = cpu;
  }

  wall_ms(): number {
    return this.#wall[Math.min(this.#wallIndex++, this.#wall.length - 1)]!;
  }

  cpu_ms(): number {
    return this.#cpu[Math.min(this.#cpuIndex++, this.#cpu.length - 1)]!;
  }
}

function validationCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const validationError = error as AnalysisBudgetValidationError;
    assert.ok(validationError instanceof AnalysisBudgetValidationError);
    assert.equal(validationError.message, "Invalid analysis budgets.");
    return validationError.code;
  }
  assert.fail("expected analysis budget validation to fail");
}

function completeResult() {
  return {
    configured: limits(),
    consumed: {
      input_bytes: 10,
      input_events: 3,
      wall_ms: 20,
      cpu_ms: 15,
      output_bytes: 200,
      source_items: 2,
    },
    observed: {
      input_bytes: 10,
      input_events: 3,
      wall_ms: 20,
      cpu_ms: 15,
      output_bytes: 200,
      source_items: 2,
    },
    completeness: "complete" as const,
    coverage: 1,
  };
}

test("normalizes exactly six detached finite nonnegative safe-integer limits", () => {
  const input = limits();
  const normalized = normalizeAnalysisBudgets(input);

  assert.deepEqual(normalized, input);
  assert.deepEqual(Object.keys(normalized), [...LIMIT_KEYS]);
  assert.notEqual(normalized, input);
  assert.equal(Object.isFrozen(normalized), true);

  input.max_input_bytes = 999;
  assert.equal(normalized.max_input_bytes, 10);
});

test("rejects every missing field and every invalid numeric value without reflection", () => {
  for (const key of LIMIT_KEYS) {
    const candidate = { ...limits() } as Record<string, unknown>;
    delete candidate[key];
    assert.equal(validationCode(() => normalizeAnalysisBudgets(candidate)), "invalid_shape");
  }

  for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1, "10", null]) {
    for (const key of LIMIT_KEYS) {
      const candidate = { ...limits(), [key]: value };
      assert.equal(validationCode(() => normalizeAnalysisBudgets(candidate)), "invalid_value");
    }
  }
});

test("rejects unknown, symbol, hidden, accessor, array, and hostile Proxy shapes", () => {
  assert.equal(validationCode(() => normalizeAnalysisBudgets({
    ...limits(),
    raw_prompt_secret: "token-canary",
  })), "invalid_shape");

  const symbol = { ...limits() } as Record<PropertyKey, unknown>;
  symbol[Symbol("token-canary")] = 1;
  assert.equal(validationCode(() => normalizeAnalysisBudgets(symbol)), "invalid_shape");

  const hidden = { ...limits() } as Record<string, unknown>;
  Object.defineProperty(hidden, "hidden_secret", {
    value: "token-canary",
    enumerable: false,
  });
  assert.equal(validationCode(() => normalizeAnalysisBudgets(hidden)), "invalid_shape");

  let getterReads = 0;
  const accessor = { ...limits() } as Record<string, unknown>;
  Object.defineProperty(accessor, "max_cpu_ms", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("token-canary");
    },
  });
  assert.equal(validationCode(() => normalizeAnalysisBudgets(accessor)), "invalid_shape");
  assert.equal(getterReads, 0);

  assert.equal(validationCode(() => normalizeAnalysisBudgets([])), "invalid_shape");

  for (const trap of ["ownKeys", "getOwnPropertyDescriptor"] as const) {
    const proxy = new Proxy(limits(), {
      [trap]() {
        throw new Error("token-canary");
      },
    });
    assert.equal(validationCode(() => normalizeAnalysisBudgets(proxy)), "invalid_shape");
  }

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(
    validationCode(() => normalizeAnalysisBudgets(revoked.proxy)),
    "invalid_shape",
  );
});

test("accepts zero and exact boundaries without truncation", () => {
  const zero = new AnalysisBudgetMeter(
    limits({
      max_input_bytes: 0,
      max_input_events: 0,
      max_wall_ms: 0,
      max_cpu_ms: 0,
      max_output_bytes: 0,
      max_source_items: 0,
    }),
    new ScriptedClock([10, 10], [5, 5]),
  );
  assert.equal(zero.checkpoint(), true);
  assert.equal(zero.result().completeness, "complete");
  assert.equal(zero.result().coverage, 1);

  const exact = new AnalysisBudgetMeter(
    limits(),
    new ScriptedClock([100, 120], [50, 65]),
  );
  assert.equal(exact.admitSourceItem(), true);
  assert.equal(exact.admitSourceItem(), true);
  assert.equal(exact.admitInputBytes(10), 10);
  assert.equal(exact.admitInputEvents(3), 3);
  assert.equal(exact.checkpoint(), true);
  assert.equal(exact.admitOutputBytes(200), 200);
  assert.deepEqual(exact.result(), {
    configured: limits(),
    consumed: {
      input_bytes: 10,
      input_events: 3,
      wall_ms: 20,
      cpu_ms: 15,
      output_bytes: 200,
      source_items: 2,
    },
    observed: {
      input_bytes: 10,
      input_events: 3,
      wall_ms: 20,
      cpu_ms: 15,
      output_bytes: 200,
      source_items: 2,
    },
    completeness: "complete",
    coverage: 1,
  });
});

test("admits only an exact prefix on one-over input and reports finite coverage", () => {
  const meter = new AnalysisBudgetMeter(
    limits(),
    new ScriptedClock([0], [0]),
  );

  assert.equal(meter.admitInputBytes(11), 10);
  assert.equal(meter.stopped, true);
  assert.deepEqual(meter.result(), {
    configured: limits(),
    consumed: {
      input_bytes: 10,
      input_events: 0,
      wall_ms: 0,
      cpu_ms: 0,
      output_bytes: 0,
      source_items: 0,
    },
    observed: {
      input_bytes: 11,
      input_events: 0,
      wall_ms: 0,
      cpu_ms: 0,
      output_bytes: 0,
      source_items: 0,
    },
    completeness: "partial",
    truncation_reason: "max_input_bytes",
    coverage: 10 / 11,
  });
});

test("fails closed when one-over usage cannot be represented safely", () => {
  const meter = new AnalysisBudgetMeter(
    limits({ max_input_bytes: Number.MAX_SAFE_INTEGER }),
    new ScriptedClock([0], [0]),
  );

  assert.equal(
    meter.admitInputBytes(Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(meter.admitInputBytes(1), 0);

  const result = meter.result();
  assert.equal(result.completeness, "partial");
  assert.equal(result.truncation_reason, "max_input_bytes");
  assert.equal(result.coverage, 0);
  assert.equal(result.consumed.input_bytes, Number.MAX_SAFE_INTEGER);
  assert.equal(result.observed.input_bytes, Number.MAX_SAFE_INTEGER);
});

test("applies one-over semantics to events, output, and source items", () => {
  const cases = [
    {
      act: (meter: AnalysisBudgetMeter) => meter.admitInputEvents(4),
      admitted: 3,
      reason: "max_input_events",
    },
    {
      act: (meter: AnalysisBudgetMeter) => meter.admitOutputBytes(201),
      admitted: 200,
      reason: "max_output_bytes",
    },
    {
      act: (meter: AnalysisBudgetMeter) => {
        assert.equal(meter.admitSourceItem(), true);
        assert.equal(meter.admitSourceItem(), true);
        return meter.admitSourceItem() ? 3 : 2;
      },
      admitted: 2,
      reason: "max_source_items",
    },
  ] as const;

  for (const entry of cases) {
    const meter = new AnalysisBudgetMeter(
      limits(),
      new ScriptedClock([0], [0]),
    );
    assert.equal(entry.act(meter), entry.admitted);
    assert.equal(meter.result().truncation_reason, entry.reason);
    assert.ok(meter.result().coverage >= 0 && meter.result().coverage < 1);
  }
});

test("selects a stable reason when wall and CPU cross together", () => {
  const meter = new AnalysisBudgetMeter(
    limits({ max_wall_ms: 5, max_cpu_ms: 5 }),
    new ScriptedClock([10, 16], [20, 27]),
  );

  assert.equal(meter.checkpoint(), false);
  const result = meter.result();
  assert.equal(result.truncation_reason, "max_wall_ms");
  assert.equal(result.consumed.wall_ms, 6);
  assert.equal(result.consumed.cpu_ms, 7);
  assert.equal(result.observed.wall_ms, 6);
  assert.equal(result.observed.cpu_ms, 7);
  assert.equal(result.coverage, 5 / 7);
});

test("contains backwards, NaN, and unsafe clock readings as meter_error", () => {
  for (const clock of [
    new ScriptedClock([10, 9], [20, 21]),
    new ScriptedClock([10, Number.NaN], [20, 21]),
    new ScriptedClock([10, 11], [20, Number.MAX_SAFE_INTEGER + 1]),
  ]) {
    const meter = new AnalysisBudgetMeter(limits(), clock);
    assert.equal(meter.checkpoint(), false);
    assert.equal(meter.result().truncation_reason, "meter_error");
    assert.equal(meter.result().coverage, 0);
    assert.equal(Number.isFinite(meter.result().consumed.wall_ms), true);
    assert.equal(Number.isFinite(meter.result().consumed.cpu_ms), true);
  }
});

test("rejects regression from the last checkpoint and retains accepted elapsed time", () => {
  const meter = new AnalysisBudgetMeter(
    limits(),
    new ScriptedClock([10, 20, 15], [0, 1, 2]),
  );

  assert.equal(meter.checkpoint(), true);
  assert.equal(meter.result().consumed.wall_ms, 10);
  assert.equal(meter.checkpoint(), false);
  assert.equal(meter.result().truncation_reason, "meter_error");
  assert.equal(meter.result().consumed.wall_ms, 10);
  assert.equal(meter.result().observed.wall_ms, 10);
  assert.equal(meter.result().consumed.cpu_ms, 1);
});

test("source failure and zero-budget attempts are partial without NaN", () => {
  const failed = new AnalysisBudgetMeter(
    limits(),
    new ScriptedClock([0], [0]),
  );
  failed.recordSourceFailure();
  assert.equal(failed.result().truncation_reason, "source_failure");
  assert.equal(failed.result().coverage, 0);

  const zero = new AnalysisBudgetMeter(
    limits({ max_source_items: 0 }),
    new ScriptedClock([0], [0]),
  );
  assert.equal(zero.admitSourceItem(), false);
  assert.equal(zero.result().truncation_reason, "max_source_items");
  assert.equal(zero.result().coverage, 0);
  assert.ok(zero.result().coverage >= 0 && zero.result().coverage <= 1);
});

test("result snapshots are detached from the meter and from each other", () => {
  const meter = new AnalysisBudgetMeter(
    limits(),
    new ScriptedClock([0], [0]),
  );
  meter.admitInputEvents(2);
  const first = meter.result();
  const second = meter.result();

  assert.notEqual(first, second);
  assert.notEqual(first.configured, second.configured);
  assert.notEqual(first.consumed, second.consumed);
  first.configured.max_input_events = 999;
  first.consumed.input_events = 999;
  assert.equal(meter.result().configured.max_input_events, 3);
  assert.equal(meter.result().consumed.input_events, 2);
});

test("normalizes a detached exact analysis budget result", () => {
  const input = completeResult();
  const normalized = normalizeAnalysisBudgetResult(input);

  assert.deepEqual(normalized, input);
  assert.notEqual(normalized, input);
  assert.notEqual(normalized.configured, input.configured);
  assert.notEqual(normalized.consumed, input.consumed);
  assert.notEqual(normalized.observed, input.observed);

  input.configured.max_input_bytes = 999;
  input.consumed.input_bytes = 999;
  assert.equal(normalized.configured.max_input_bytes, 10);
  assert.equal(normalized.consumed.input_bytes, 10);
});

test("rejects malformed or hostile analysis budget results without reading accessors", () => {
  const malformed: unknown[] = [
    { ...completeResult(), extra: "token-canary" },
    { ...completeResult(), coverage: Number.NaN },
    { ...completeResult(), coverage: -0.1 },
    { ...completeResult(), coverage: 1.1 },
    { ...completeResult(), completeness: "partial" },
    { ...completeResult(), truncation_reason: "max_input_bytes" },
    {
      ...completeResult(),
      consumed: { ...completeResult().consumed, input_bytes: 10.5 },
    },
    {
      ...completeResult(),
      observed: { ...completeResult().observed, secret: "token-canary" },
    },
    {
      ...completeResult(),
      completeness: "partial",
      truncation_reason: "token-canary",
      coverage: 0,
    },
  ];
  const missing = completeResult() as Record<string, unknown>;
  delete missing.observed;
  malformed.push(missing);

  for (const value of malformed) {
    assert.ok([
      "invalid_shape",
      "invalid_value",
    ].includes(validationCode(() => normalizeAnalysisBudgetResult(value))));
  }

  let getterReads = 0;
  const accessor = completeResult() as Record<string, unknown>;
  Object.defineProperty(accessor, "coverage", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("token-canary");
    },
  });
  assert.ok([
    "invalid_shape",
    "invalid_value",
  ].includes(validationCode(() => normalizeAnalysisBudgetResult(accessor))));
  assert.equal(getterReads, 0);

  const proxy = new Proxy(completeResult(), {
    ownKeys() {
      throw new Error("token-canary");
    },
  });
  assert.equal(
    validationCode(() => normalizeAnalysisBudgetResult(proxy)),
    "invalid_shape",
  );
});
