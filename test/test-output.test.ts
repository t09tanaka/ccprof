import assert from "node:assert/strict";
import test from "node:test";

import { extractFailedTestNames } from "../src/analysis/test-output.js";

test("extracts TAP and node --test failures including indented subtests", () => {
  const output = [
    "# Subtest: math suite",
    "    # Subtest: adds numbers",
    "    not ok 1 - adds numbers",
    "      ---",
    "      duration_ms: 1.2",
    "      ...",
    "not ok 2 - top level failure",
    "ok 3 - passes fine",
    "1..3",
  ].join("\n");
  assert.deepEqual(extractFailedTestNames(output), {
    names: ["adds numbers", "top level failure"],
    truncated: false,
  });
});

test("extracts jest failure headings and cross marks without timings", () => {
  const output = [
    "FAIL src/math.test.ts",
    "  math suite",
    "    ✕ adds numbers (5 ms)",
    "    ✓ subtracts numbers (1 ms)",
    "",
    "● math suite › adds numbers",
    "",
    "● Console",
    "",
    "  expect(received).toBe(expected)",
  ].join("\n");
  assert.deepEqual(extractFailedTestNames(output), {
    names: ["adds numbers", "math suite › adds numbers"],
    truncated: false,
  });
});

test("extracts vitest failures and ignores stack frames", () => {
  const output = [
    " FAIL  src/math.test.ts > math suite > adds numbers",
    "   × adds numbers 12ms",
    "   ✗ multiplies numbers",
    "   ✓ subtracts numbers",
    " ❯ src/math.test.ts > math suite > adds numbers",
    " ❯ src/math.test.ts:10:5",
    "",
  ].join("\n");
  assert.deepEqual(extractFailedTestNames(output), {
    names: [
      "adds numbers",
      "multiplies numbers",
      "src/math.test.ts > math suite > adds numbers",
    ],
    truncated: false,
  });
});

test("extracts cargo and pytest failures verbatim", () => {
  const output = [
    "test tests::flaky_case ... FAILED",
    "test tests::stable_case ... ok",
    "FAILED tests/test_a.py::test_one - AssertionError: boom",
    "FAILED tests/test_b.py::TestSuite::test_two",
    "PASSED tests/test_a.py::test_three",
    "FAILED not-a-pytest-line",
  ].join("\n");
  assert.deepEqual(extractFailedTestNames(output), {
    names: [
      "tests::flaky_case",
      "tests/test_a.py::test_one",
      "tests/test_b.py::TestSuite::test_two",
    ],
    truncated: false,
  });
});

test("strips ANSI escapes before matching and deduplicates names", () => {
  const output = [
    "\u001B[31mnot ok 1 - flaky case\u001B[0m",
    "not ok 2 - flaky case",
  ].join("\n");
  assert.deepEqual(extractFailedTestNames(output), {
    names: ["flaky case"],
    truncated: false,
  });
});

test("returns an empty result for empty or unrecognized output", () => {
  assert.deepEqual(extractFailedTestNames(""), {
    names: [],
    truncated: false,
  });
  assert.deepEqual(
    extractFailedTestNames("Error: something exploded\n  at main.js:1"),
    { names: [], truncated: false },
  );
});

test("caps the extracted names at 20 and reports truncation", () => {
  const output = Array.from(
    { length: 25 },
    (_, index) => `not ok ${index + 1} - case ${String(index + 1).padStart(2, "0")}`,
  ).join("\n");
  const result = extractFailedTestNames(output);
  assert.equal(result.names.length, 20);
  assert.equal(result.truncated, true);
  assert.equal(result.names[0], "case 01");
});
