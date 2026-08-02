/**
 * Deterministic extraction of failed test names from tool-result output.
 *
 * Only known framework failure lines are matched; nothing is inferred or
 * completed heuristically. Unrecognized output yields an empty result.
 */

// Terminal control strings are removed line-safely (newlines are preserved,
// unlike sanitizeHumanText, which blanks every C0 control): OSC strings
// (ESC ] ... BEL/ST), then CSI sequences including the C1 form (0x9B).
const OSC_STRING =
  /(?:\u001B\]|\u009D)[^\n]*?(?:\u0007|\u001B\\|\u009C|$)/gmu;
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*(?:[@-~]|$)/gu;
export const MAX_FAILED_TEST_NAMES = 20;

/** Deterministic code-unit ordering, independent of locale tailoring. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface FailedTestNames {
  /** Sorted, deduplicated names, capped at {@link MAX_FAILED_TEST_NAMES}. */
  names: string[];
  /** True when more distinct names were present than the cap allows. */
  truncated: boolean;
}

/** Removes trailing framework timing suffixes such as `(5 ms)` or `12ms`. */
function stripTimingSuffix(value: string): string {
  return value
    .replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)$/u, "")
    .replace(/\s+\d+(?:\.\d+)?ms$/u, "")
    .trim();
}

function matchFailureLine(line: string): string | null {
  // TAP / node --test: `not ok [<n>] - <name>` (subtests are indented).
  // TODO/SKIP directives are expected or skipped outcomes, not failures;
  // only ` # ` starts a directive so `#` inside a name is preserved.
  const tap = /^not ok(?: \d+)? - (.+)$/u.exec(line);
  if (tap !== null) {
    const name = tap[1] ?? "";
    if (/ # (?:todo|skip)(?:\s|$)/iu.test(name)) return null;
    return name;
  }
  // jest failure heading: `● <suite> › <name>`.
  const jestHeading = /^● (.+ › .+)$/u.exec(line);
  if (jestHeading !== null) return jestHeading[1] ?? null;
  // jest per-test failure: `✕ <name>`.
  const jestCross = /^✕ (.+)$/u.exec(line);
  if (jestCross !== null) return stripTimingSuffix(jestCross[1] ?? "");
  // vitest per-test failure: `✗ <name>` / `× <name>`.
  const vitestCross = /^[✗×] (.+)$/u.exec(line);
  if (vitestCross !== null) return stripTimingSuffix(vitestCross[1] ?? "");
  // vitest failure section: `❯ <file> > <suite> > <name>`. The ` > `
  // requirement excludes `❯ file:line:col` stack frames.
  const vitestSection = /^❯ (.+ > .+)$/u.exec(line);
  if (vitestSection !== null) {
    return stripTimingSuffix(vitestSection[1] ?? "");
  }
  // cargo test: `test <name> ... FAILED`.
  const cargo = /^test (.+?) \.\.\. FAILED$/u.exec(line);
  if (cargo !== null) return cargo[1] ?? null;
  // pytest: `FAILED <file>::<name>` with the `::` separator preserved. Node
  // ids may contain spaces (parameterized cases), so the id runs until the
  // ` - ` error separator when present, otherwise to the end of the line.
  const pytest = /^FAILED (.+?)(?: - .*)?$/u.exec(line);
  if (pytest !== null && (pytest[1] ?? "").includes("::")) {
    return pytest[1] ?? null;
  }
  return null;
}

export function extractFailedTestNames(output: string): FailedTestNames {
  const text = output
    .replace(OSC_STRING, "")
    .replace(CSI_SEQUENCE, "");
  const names = new Set<string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const name = matchFailureLine(rawLine.trim());
    if (name !== null && name !== "") names.add(name);
  }
  const sorted = [...names].sort(compareCodeUnits);
  return {
    names: sorted.slice(0, MAX_FAILED_TEST_NAMES),
    truncated: sorted.length > MAX_FAILED_TEST_NAMES,
  };
}
