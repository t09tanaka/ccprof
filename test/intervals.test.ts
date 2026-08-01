import assert from "node:assert/strict";
import test from "node:test";

import {
  durationMs,
  intersectIntervals,
  normalizeInterval,
  overlapsAny,
  roundMinutes,
  subtractIntervals,
  unionIntervals,
} from "../src/core/intervals.js";

test("normalizeInterval clones valid input and discards invalid ranges", () => {
  const input = { start_ms: 10, end_ms: 20 };
  const normalized = normalizeInterval(input);

  assert.deepEqual(normalized, input);
  assert.notStrictEqual(normalized, input);
  assert.equal(normalizeInterval({ start_ms: 10, end_ms: 10 }), null);
  assert.equal(normalizeInterval({ start_ms: 20, end_ms: 10 }), null);
  assert.equal(normalizeInterval({ start_ms: Number.NaN, end_ms: 10 }), null);
  assert.equal(normalizeInterval({ start_ms: 0, end_ms: Number.POSITIVE_INFINITY }), null);
});

test("normalizeInterval rejects fractional and unsafe-integer endpoints", () => {
  assert.equal(normalizeInterval({ start_ms: 0.5, end_ms: 10 }), null);
  assert.equal(normalizeInterval({ start_ms: 0, end_ms: 10.5 }), null);
  assert.equal(
    normalizeInterval({
      start_ms: Number.MAX_SAFE_INTEGER + 1,
      end_ms: Number.MAX_SAFE_INTEGER + 3,
    }),
    null,
  );
  assert.equal(
    normalizeInterval({
      start_ms: 0,
      end_ms: Number.MAX_SAFE_INTEGER + 1,
    }),
    null,
  );
});

test("unionIntervals sorts unsorted inputs and merges overlaps", () => {
  assert.deepEqual(
    unionIntervals([
      { start_ms: 20, end_ms: 30 },
      { start_ms: 0, end_ms: 10 },
      { start_ms: 8, end_ms: 20 },
    ]),
    [{ start_ms: 0, end_ms: 30 }],
  );
});

test("unionIntervals merges touching ranges for accounting continuity", () => {
  assert.deepEqual(
    unionIntervals([
      { start_ms: 10, end_ms: 20 },
      { start_ms: 0, end_ms: 10 },
      { start_ms: 30, end_ms: 40 },
    ]),
    [
      { start_ms: 0, end_ms: 20 },
      { start_ms: 30, end_ms: 40 },
    ],
  );
});

test("unionIntervals removes nested and invalid ranges without mutating input", () => {
  const input = [
    { start_ms: 5, end_ms: 8 },
    { start_ms: 0, end_ms: 20 },
    { start_ms: 2, end_ms: 3 },
    { start_ms: 7, end_ms: 7 },
    { start_ms: 9, end_ms: 4 },
    { start_ms: Number.NEGATIVE_INFINITY, end_ms: 4 },
  ];
  const snapshot = input.map((interval) => ({ ...interval }));
  const result = unionIntervals(input);

  assert.deepEqual(result, [{ start_ms: 0, end_ms: 20 }]);
  assert.deepEqual(input, snapshot);
  assert.notStrictEqual(result[0], input[1]);
});

test("intersectIntervals returns sorted positive intersections", () => {
  assert.deepEqual(
    intersectIntervals(
      [
        { start_ms: 20, end_ms: 40 },
        { start_ms: 0, end_ms: 15 },
      ],
      [
        { start_ms: 10, end_ms: 30 },
        { start_ms: 35, end_ms: 50 },
      ],
    ),
    [
      { start_ms: 10, end_ms: 15 },
      { start_ms: 20, end_ms: 30 },
      { start_ms: 35, end_ms: 40 },
    ],
  );
});

test("touching half-open ranges have no intersection", () => {
  assert.deepEqual(
    intersectIntervals(
      [{ start_ms: 0, end_ms: 10 }],
      [{ start_ms: 10, end_ms: 20 }],
    ),
    [],
  );
});

test("subtractIntervals splits ranges and normalizes both inputs", () => {
  assert.deepEqual(
    subtractIntervals(
      [
        { start_ms: 30, end_ms: 40 },
        { start_ms: 0, end_ms: 30 },
      ],
      [
        { start_ms: 25, end_ms: 35 },
        { start_ms: 10, end_ms: 20 },
      ],
    ),
    [
      { start_ms: 0, end_ms: 10 },
      { start_ms: 20, end_ms: 25 },
      { start_ms: 35, end_ms: 40 },
    ],
  );
});

test("subtractIntervals ignores touching cuts and can remove a full range", () => {
  assert.deepEqual(
    subtractIntervals(
      [
        { start_ms: 0, end_ms: 10 },
        { start_ms: 20, end_ms: 30 },
      ],
      [
        { start_ms: 10, end_ms: 20 },
        { start_ms: 19, end_ms: 31 },
      ],
    ),
    [{ start_ms: 0, end_ms: 10 }],
  );
});

test("overlapsAny requires positive overlap", () => {
  assert.equal(
    overlapsAny(
      [{ start_ms: 0, end_ms: 10 }],
      [{ start_ms: 9, end_ms: 20 }],
    ),
    true,
  );
  assert.equal(
    overlapsAny(
      [{ start_ms: 0, end_ms: 10 }],
      [{ start_ms: 10, end_ms: 20 }],
    ),
    false,
  );
  assert.equal(
    overlapsAny(
      [{ start_ms: 0, end_ms: 10 }],
      [{ start_ms: 5, end_ms: 5 }],
    ),
    false,
  );
});

test("durationMs sums the interval union rather than raw overlaps", () => {
  assert.equal(
    durationMs([
      { start_ms: 20, end_ms: 30 },
      { start_ms: 0, end_ms: 10 },
      { start_ms: 5, end_ms: 25 },
      { start_ms: 30, end_ms: 30 },
    ]),
    30,
  );
});

test("roundMinutes rounds non-negative milliseconds to two decimals", () => {
  assert.equal(roundMinutes(0), 0);
  assert.equal(roundMinutes(60_000), 1);
  assert.equal(roundMinutes(90_000), 1.5);
  assert.equal(roundMinutes(60_600), 1.01);
  assert.equal(roundMinutes(60_299), 1);
});

test("roundMinutes clamps negative values without returning negative zero", () => {
  const rounded = roundMinutes(-1);

  assert.equal(rounded, 0);
  assert.equal(Object.is(rounded, -0), false);
});
