/**
 * Deterministic extraction of failed test names from tool-result output.
 *
 * Only known framework failure lines are matched; nothing is inferred or
 * completed heuristically. Unrecognized output yields an empty result.
 */

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
export const MAX_FAILED_TEST_NAMES = 20;

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
  // TAP / node --test: `not ok <n> - <name>` (subtests are indented).
  const tap = /^not ok \d+ - (.+)$/u.exec(line);
  if (tap !== null) return tap[1] ?? null;
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
  // pytest: `FAILED <file>::<name>` with the `::` separator preserved.
  const pytest = /^FAILED (\S+)/u.exec(line);
  if (pytest !== null && (pytest[1] ?? "").includes("::")) {
    return pytest[1] ?? null;
  }
  return null;
}

export function extractFailedTestNames(output: string): FailedTestNames {
  const names = new Set<string>();
  for (const rawLine of output.replace(ANSI_PATTERN, "").split(/\r?\n/u)) {
    const name = matchFailureLine(rawLine.trim());
    if (name !== null && name !== "") names.add(name);
  }
  const sorted = [...names].sort((left, right) => left.localeCompare(right));
  return {
    names: sorted.slice(0, MAX_FAILED_TEST_NAMES),
    truncated: sorted.length > MAX_FAILED_TEST_NAMES,
  };
}
