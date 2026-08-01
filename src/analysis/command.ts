import type { ToolResultStatus } from "../core/model.js";

export type CommandFamily =
  | "test"
  | "build"
  | "check"
  | "vcs"
  | "inspect"
  | "other";
export type CommandEcosystem =
  | "node"
  | "cargo"
  | "pytest"
  | "other";
export type CommandScope = "full" | "targeted" | "unknown";

export interface CommandTokenization {
  tokens: string[];
  opaque: boolean;
  caveats: string[];
}

export interface CommandDescriptor extends CommandTokenization {
  raw: string;
  normalized: string;
  family: CommandFamily;
  ecosystem: CommandEcosystem;
  scope: CommandScope;
  targets: string[];
  pathTargets: string[];
  /**
   * Present only for composite commands (`a && b`, pipes, redirects): the
   * recognized family of each non-`cd` segment in order.
   */
  segmentFamilies?: CommandFamily[];
  /**
   * Present only for composite commands: the wrapper-stripped tokens of each
   * non-`cd` segment, used to match mapped commands against segments.
   */
  segments?: string[][];
  /**
   * Present only for composite commands: the segment separators in order
   * (`&&`, `||`, `;`, `|`). Only all-`&&` composites let an overall success
   * vouch for every segment.
   */
  segmentSeparators?: string[];
  /** The command redirects output to a file whose effect cannot be bounded. */
  redirectsOutput?: boolean;
}

export interface CommandResultSignal {
  status?: ToolResultStatus;
  exitCode?: number;
  exit_code?: number;
  output?: string;
}

export interface CommandResultClassification {
  status: ToolResultStatus;
  definite: boolean;
  source: "metadata" | "exit_code" | "output" | "unknown";
}

type QuoteState = "unquoted" | "single" | "double";

/**
 * Splits historical command text without invoking a shell or expanding any
 * syntax. Shell composition is retained as an opaque signal instead of being
 * interpreted.
 */
export function tokenizeCommand(raw: string): CommandTokenization {
  const tokens: string[] = [];
  const caveats: string[] = [];
  let token = "";
  let tokenStarted = false;
  let state: QuoteState = "unquoted";
  let opaque = false;

  const flush = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] as string;
    if (state === "single") {
      if (character === "'") {
        state = "unquoted";
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (state === "double") {
      if (character === '"') {
        state = "unquoted";
      } else if (character === "\\") {
        const next = raw[index + 1];
        if (next === undefined) {
          opaque = true;
          caveats.push("Command ends with an incomplete escape.");
        } else {
          token += next;
          index += 1;
        }
      } else {
        if (character === "`" || (character === "$" && raw[index + 1] === "(")) {
          opaque = true;
        }
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === "\n" || character === "\r") {
      opaque = true;
      flush();
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (character === "'") {
      state = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      state = "double";
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const next = raw[index + 1];
      if (next === undefined) {
        opaque = true;
        caveats.push("Command ends with an incomplete escape.");
      } else {
        token += next;
        tokenStarted = true;
        index += 1;
      }
      continue;
    }
    if ("|&;<>`()".includes(character)) {
      opaque = true;
    }
    if (character === "$" && raw[index + 1] === "(") {
      opaque = true;
    }
    if (character === "#" && !tokenStarted) {
      opaque = true;
    }
    token += character;
    tokenStarted = true;
  }

  if (state !== "unquoted") {
    opaque = true;
    caveats.push("Command contains an unmatched quote.");
  }
  flush();
  if (opaque) {
    caveats.push("Shell composition or expansion prevents safe command classification.");
  }
  return { tokens, opaque, caveats: unique(caveats) };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*$/s;

function stripLeadingWrappers(tokens: readonly string[]): string[] {
  let index = 0;
  const stripAssignments = (): void => {
    while (ASSIGNMENT.test(tokens[index] ?? "")) index += 1;
  };
  stripAssignments();
  let changed = true;
  while (changed) {
    changed = false;
    if (tokens[index] === "env") {
      index += 1;
      stripAssignments();
      changed = true;
    }
    if (tokens[index] === "command") {
      index += 1;
      if (tokens[index] === "--") index += 1;
      stripAssignments();
      changed = true;
    }
  }
  return tokens.slice(index);
}

function quoteToken(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(token)
    ? token
    : JSON.stringify(token);
}

function scriptFamily(script: string): CommandFamily {
  if (/^test(?::|-|$)/u.test(script)) {
    return "test";
  }
  if (/^build(?::|-|$)/u.test(script)) {
    return "build";
  }
  if (
    /^(?:check|typecheck|type-check)(?::|-|$)/u.test(script)
  ) {
    return "check";
  }
  return "other";
}

interface FamilyMatch {
  family: CommandFamily;
  ecosystem: CommandEcosystem;
  argumentStart: number;
}

const VCS_EXECUTABLES = new Set(["git", "gh"]);
const INSPECT_EXECUTABLES = new Set([
  "cat",
  "cut",
  "date",
  "df",
  "diff",
  "du",
  "echo",
  "false",
  "file",
  "grep",
  "head",
  "ls",
  "printf",
  "pwd",
  "rg",
  "sleep",
  "stat",
  "tail",
  "test",
  "tr",
  "tree",
  "true",
  "uniq",
  "wc",
  "which",
]);

function sedWritesInPlace(tokens: readonly string[]): boolean {
  return tokens.slice(1).some(
    (token) =>
      token.startsWith("--in-place") ||
      // Short-option clusters containing `i` (-i, -i.bak, -ni, -nEi.bak).
      /^-[a-zA-Z]*i/u.test(token),
  );
}

const FIND_MUTATING_OPTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
]);

function findMutates(tokens: readonly string[]): boolean {
  return tokens
    .slice(1)
    .some(
      (token) =>
        FIND_MUTATING_OPTIONS.has(token) || token.startsWith("-fprint"),
    );
}

function sortWritesOutput(tokens: readonly string[]): boolean {
  return tokens.slice(1).some(
    (token) =>
      token.startsWith("--output") ||
      // Short-option clusters containing `-o` (-o, -oout.txt, -no).
      /^-[a-zA-Z]*o/u.test(token),
  );
}

function executableName(token: string | undefined): string {
  return token?.replaceAll("\\", "/").split("/").at(-1) ?? "";
}

function matchFamily(tokens: readonly string[]): FamilyMatch {
  const executable = executableName(tokens[0]);
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const second = tokens[1] ?? "";
    if (second === "run") {
      return {
        family: scriptFamily(tokens[2] ?? ""),
        ecosystem: "node",
        argumentStart: 3,
      };
    }
    if (second === "t" || second === "test") {
      return { family: "test", ecosystem: "node", argumentStart: 2 };
    }
    if (second === "build") {
      return { family: "build", ecosystem: "node", argumentStart: 2 };
    }
    if (second === "check") {
      return { family: "check", ecosystem: "node", argumentStart: 2 };
    }
    return { family: "other", ecosystem: "node", argumentStart: 2 };
  }
  if (executable === "cargo") {
    const second = tokens[1];
    if (second === "test" || second === "build" || second === "check") {
      return { family: second, ecosystem: "cargo", argumentStart: 2 };
    }
    return { family: "other", ecosystem: "cargo", argumentStart: 2 };
  }
  if (executable === "pytest" || executable === "py.test") {
    return { family: "test", ecosystem: "pytest", argumentStart: 1 };
  }
  if (
    /^(?:python|python3)(?:\.\d+)?$/u.test(executable) &&
    tokens[1] === "-m" &&
    tokens[2] === "pytest"
  ) {
    return { family: "test", ecosystem: "pytest", argumentStart: 3 };
  }
  if (VCS_EXECUTABLES.has(executable)) {
    return { family: "vcs", ecosystem: "other", argumentStart: tokens.length };
  }
  if (
    (executable === "sed" && !sedWritesInPlace(tokens)) ||
    (executable === "find" && !findMutates(tokens)) ||
    (executable === "sort" && !sortWritesOutput(tokens))
  ) {
    return {
      family: "inspect",
      ecosystem: "other",
      argumentStart: tokens.length,
    };
  }
  if (INSPECT_EXECUTABLES.has(executable)) {
    return {
      family: "inspect",
      ecosystem: "other",
      argumentStart: tokens.length,
    };
  }
  return { family: "other", ecosystem: "other", argumentStart: tokens.length };
}

const TARGET_OPTIONS = new Set([
  "-k",
  "-p",
  "-t",
  "--bin",
  "--filter",
  "--package",
  "--test",
  "--test-name-pattern",
  "--test-path-pattern",
  "--testNamePattern",
  "--testPathPattern",
]);
const NON_TARGET_OPTIONS = new Set([
  "-q",
  "--all",
  "--all-features",
  "--color",
  "--coverage",
  "--exact",
  "--fail-fast",
  "--locked",
  "--nocapture",
  "--no-fail-fast",
  "--quiet",
  "--release",
  "--run",
  "--runInBand",
  "--verbose",
  "--watch",
  "--workspace",
]);

function extractTargets(args: readonly string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] as string;
    if (value === "--") continue;
    const equals = /^([^=]+)=(.*)$/su.exec(value);
    if (equals !== null && TARGET_OPTIONS.has(equals[1] ?? "")) {
      if ((equals[2] ?? "") !== "") targets.push(equals[2] as string);
      continue;
    }
    if (TARGET_OPTIONS.has(value)) {
      const next = args[index + 1];
      if (next !== undefined && next !== "--") {
        targets.push(next);
        index += 1;
      }
      continue;
    }
    if (value.startsWith("-")) {
      if (!NON_TARGET_OPTIONS.has(value)) {
        // An unknown option may alter selection, but cannot safely be mapped
        // to repository paths. Preserve it as a target signal.
        targets.push(value);
      }
      continue;
    }
    targets.push(value);
  }
  return targets;
}

function normalizePathTarget(target: string): string | null {
  const withoutNode = target.split("::", 1)[0] ?? "";
  const slashes = withoutNode.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (
    slashes === "" ||
    slashes.includes("\0") ||
    slashes.startsWith("/") ||
    /^[A-Za-z]:\//u.test(slashes)
  ) {
    return null;
  }
  const segments = slashes.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    return null;
  }
  const looksLikePath =
    segments.length > 1 ||
    /(?:^|.)\.[A-Za-z0-9*]+$/u.test(slashes) ||
    slashes.includes("*");
  return looksLikePath ? segments.filter((segment) => segment !== ".").join("/") : null;
}

interface CompositeScan {
  /** All tokens in order: words plus separator and redirect operators. */
  canonical: string[];
  /** Marks canonical tokens that are operators and must stay unquoted. */
  bare: boolean[];
  /** Family-judgment tokens per segment, with redirects and targets removed. */
  segments: string[][];
  /** Segment separators in order (`&&`, `||`, `;`, `|`). */
  separators: string[];
  redirectsOutput: boolean;
}

/**
 * Re-scans a shell command and splits it on unquoted `&&`, `||`, `;`, and
 * `|` while dropping redirect operators and their targets from the segment
 * tokens. Anything outside this deterministic grammar (substitution,
 * backquotes, newlines, background `&`, heredocs, unknown operator forms)
 * makes the scan fail so the command stays opaque.
 */
function scanCompositeCommand(raw: string): CompositeScan | null {
  const canonical: string[] = [];
  const bare: boolean[] = [];
  const segments: string[][] = [];
  const separators: string[] = [];
  let segment: string[] = [];
  let redirectsOutput = false;
  let token = "";
  let tokenStarted = false;
  let tokenAllDigits = true;
  let state: QuoteState = "unquoted";
  let pendingRedirectTarget = false;

  const flushWord = (): void => {
    if (!tokenStarted) return;
    canonical.push(token);
    bare.push(false);
    if (pendingRedirectTarget) {
      pendingRedirectTarget = false;
    } else {
      segment.push(token);
    }
    token = "";
    tokenStarted = false;
    tokenAllDigits = true;
  };
  const endSegment = (): boolean => {
    flushWord();
    if (pendingRedirectTarget || segment.length === 0) return false;
    segments.push(segment);
    segment = [];
    return true;
  };
  const pushOperator = (operator: string): void => {
    canonical.push(operator);
    bare.push(true);
  };
  const pushSeparator = (separator: string): void => {
    pushOperator(separator);
    separators.push(separator);
  };
  const appendWordCharacter = (character: string, quoted: boolean): void => {
    token += character;
    tokenStarted = true;
    if (quoted || !/^[0-9]$/u.test(character)) tokenAllDigits = false;
  };
  const scanDupDigits = (start: number): { digits: string; next: number } | null => {
    let index = start;
    let digits = "";
    while (/^[0-9]$/u.test(raw[index] ?? "")) {
      digits += raw[index];
      index += 1;
    }
    const boundary = raw[index];
    if (
      digits === "" ||
      (boundary !== undefined && !/\s/u.test(boundary) &&
        !"|&;<>".includes(boundary))
    ) {
      return null;
    }
    return { digits, next: index };
  };

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] as string;
    if (state === "single") {
      if (character === "'") state = "unquoted";
      else appendWordCharacter(character, true);
      tokenStarted = true;
      tokenAllDigits = false;
      continue;
    }
    if (state === "double") {
      if (character === '"') {
        state = "unquoted";
      } else if (character === "\\") {
        const next = raw[index + 1];
        if (next === undefined) return null;
        appendWordCharacter(next, true);
        index += 1;
      } else if (
        character === "`" ||
        (character === "$" && raw[index + 1] === "(")
      ) {
        return null;
      } else {
        appendWordCharacter(character, true);
      }
      tokenStarted = true;
      tokenAllDigits = false;
      continue;
    }

    if (character === "\n" || character === "\r") return null;
    if (/\s/u.test(character)) {
      flushWord();
      continue;
    }
    if (character === "'" || character === '"') {
      state = character === "'" ? "single" : "double";
      tokenStarted = true;
      tokenAllDigits = false;
      continue;
    }
    if (character === "\\") {
      const next = raw[index + 1];
      if (next === undefined) return null;
      appendWordCharacter(next, true);
      index += 1;
      continue;
    }
    if (character === "`" || character === "(" || character === ")") return null;
    if (character === "$" && raw[index + 1] === "(") return null;
    if (character === "#" && !tokenStarted) return null;
    if (character === "&") {
      if (raw[index + 1] === "&") {
        if (!endSegment()) return null;
        pushSeparator("&&");
        index += 1;
        continue;
      }
      if (raw[index + 1] === ">") {
        flushWord();
        if (pendingRedirectTarget) return null;
        let operator = "&>";
        index += 1;
        if (raw[index + 1] === ">") {
          operator = "&>>";
          index += 1;
        }
        pushOperator(operator);
        pendingRedirectTarget = true;
        redirectsOutput = true;
        continue;
      }
      return null;
    }
    if (character === "|") {
      if (raw[index + 1] === "&") return null;
      if (!endSegment()) return null;
      if (raw[index + 1] === "|") {
        pushSeparator("||");
        index += 1;
      } else {
        pushSeparator("|");
      }
      continue;
    }
    if (character === ";") {
      if (raw[index + 1] === ";") return null;
      if (!endSegment()) return null;
      pushSeparator(";");
      continue;
    }
    if (character === ">" || character === "<") {
      if (pendingRedirectTarget) return null;
      let descriptorPrefix = "";
      if (tokenStarted && tokenAllDigits && token !== "") {
        descriptorPrefix = token;
        token = "";
        tokenStarted = false;
        tokenAllDigits = true;
      } else {
        flushWord();
      }
      if (character === "<") {
        if (raw[index + 1] === "<") return null;
        if (raw[index + 1] === "&") {
          const dup = scanDupDigits(index + 2);
          if (dup === null) return null;
          pushOperator(`${descriptorPrefix}<&${dup.digits}`);
          index = dup.next - 1;
          continue;
        }
        pushOperator(`${descriptorPrefix}<`);
        pendingRedirectTarget = true;
        continue;
      }
      let operator = `${descriptorPrefix}>`;
      if (raw[index + 1] === ">") {
        operator += ">";
        index += 1;
      }
      if (raw[index + 1] === "&") {
        if (operator.endsWith(">>")) return null;
        const dup = scanDupDigits(index + 2);
        if (dup === null) return null;
        pushOperator(`${operator}&${dup.digits}`);
        index = dup.next - 1;
        continue;
      }
      pushOperator(operator);
      pendingRedirectTarget = true;
      redirectsOutput = true;
      continue;
    }
    appendWordCharacter(character, false);
  }

  if (state !== "unquoted") return null;
  if (!endSegment()) return null;
  return { canonical, bare, segments, separators, redirectsOutput };
}

const COMPOSITE_FAMILY_PRIORITY: readonly CommandFamily[] = [
  "test",
  "build",
  "check",
  "vcs",
  "inspect",
];

/**
 * Classifies a composite command whose segments are all deterministically
 * recognized (test/build/check/vcs/inspect, with `cd` as an ignorable
 * wrapper). Returns null when any segment is unknown so the command stays
 * opaque and unexplained.
 */
function classifyCompositeCommand(raw: string): CommandDescriptor | null {
  const scan = scanCompositeCommand(raw);
  if (scan === null) return null;
  const segmentFamilies: CommandFamily[] = [];
  const strippedSegments: string[][] = [];
  const familySegmentArgs: { family: CommandFamily; args: string[] }[] = [];
  for (const segmentTokens of scan.segments) {
    const stripped = stripLeadingWrappers(segmentTokens);
    if (stripped.length === 0) return null;
    if (executableName(stripped[0]) === "cd") continue;
    const match = matchFamily(stripped);
    if (match.family === "other") return null;
    segmentFamilies.push(match.family);
    strippedSegments.push(stripped);
    if (
      match.family === "test" ||
      match.family === "build" ||
      match.family === "check"
    ) {
      familySegmentArgs.push({
        family: match.family,
        args: stripped.slice(match.argumentStart),
      });
    }
  }
  const family = COMPOSITE_FAMILY_PRIORITY.find((candidate) =>
    segmentFamilies.includes(candidate)
  );
  if (family === undefined) return null;
  const soleFamilySegment =
    familySegmentArgs.length === 1 ? familySegmentArgs[0] : undefined;
  const targets =
    soleFamilySegment === undefined ? [] : extractTargets(soleFamilySegment.args);
  const pathTargets = unique(
    targets.flatMap((target) => {
      const normalizedPath = normalizePathTarget(target);
      return normalizedPath === null ? [] : [normalizedPath];
    }),
  );
  return {
    raw,
    normalized: scan.canonical
      .map((entry, position) =>
        scan.bare[position] === true ? entry : quoteToken(entry)
      )
      .join(" "),
    tokens: [...scan.canonical],
    opaque: false,
    family,
    ecosystem: "other",
    scope:
      soleFamilySegment === undefined
        ? "unknown"
        : targets.length === 0
          ? "full"
          : "targeted",
    targets,
    pathTargets,
    caveats: [],
    segmentFamilies,
    segments: strippedSegments,
    segmentSeparators: [...scan.separators],
    ...(scan.redirectsOutput ? { redirectsOutput: true } : {}),
  };
}

/**
 * Conservative signal that a command may modify repository files in ways the
 * matcher cannot bound: vcs invocations (also inside composites) and output
 * redirects to files.
 */
export function commandMayMutateRepo(raw: string): boolean {
  const descriptor = classifyCommand(raw);
  return (
    descriptor.family === "vcs" ||
    descriptor.redirectsOutput === true ||
    (descriptor.segmentFamilies ?? []).includes("vcs")
  );
}

export function classifyCommand(raw: string): CommandDescriptor {
  const tokenized = tokenizeCommand(raw);
  const tokens = stripLeadingWrappers(tokenized.tokens);
  const normalized = tokens.map(quoteToken).join(" ");
  if (tokenized.opaque || tokens.length === 0) {
    const composite = classifyCompositeCommand(raw);
    if (composite !== null) return composite;
    return {
      raw,
      normalized,
      tokens,
      opaque: true,
      family: "other",
      ecosystem: "other",
      scope: "unknown",
      targets: [],
      pathTargets: [],
      caveats: unique([
        ...tokenized.caveats,
        ...(tokens.length === 0 ? ["Command has no executable after wrappers."] : []),
      ]),
    };
  }
  const family = matchFamily(tokens);
  const targets = extractTargets(tokens.slice(family.argumentStart));
  const pathTargets = unique(
    targets.flatMap((target) => {
      const normalizedPath = normalizePathTarget(target);
      return normalizedPath === null ? [] : [normalizedPath];
    }),
  );
  return {
    raw,
    normalized,
    tokens,
    opaque: false,
    family: family.family,
    ecosystem: family.ecosystem,
    scope:
      family.family === "other"
        ? "unknown"
        : targets.length === 0
          ? "full"
          : "targeted",
    targets,
    pathTargets,
    caveats: tokenized.caveats,
  };
}

export function normalizeCommand(raw: string): string | null {
  const command = classifyCommand(raw);
  return command.opaque || command.normalized === "" ? null : command.normalized;
}

function hasPositiveCount(output: string, word: string): boolean {
  const expression = new RegExp(`(?:^|\\b)([0-9]+)\\s+${word}\\b`, "giu");
  return [...output.matchAll(expression)].some((match) => Number(match[1]) > 0);
}

export function classifyCommandResult(
  command: CommandDescriptor,
  signal: CommandResultSignal,
): CommandResultClassification {
  const base = classifySegmentAgnosticResult(command, signal);
  const separators = command.segmentSeparators ?? [];
  if (
    separators.length === 0 ||
    base.status === "timeout" ||
    base.status === "cancelled" ||
    base.status === "unknown"
  ) {
    return base;
  }
  if (separators.some((separator) => separator !== "&&")) {
    // With `|`, `;`, or `||`, the overall result reflects only one segment,
    // so neither success nor failure can be attributed to the test segment.
    return { status: "unknown", definite: false, source: "unknown" };
  }
  // All-`&&`: overall success proves every segment succeeded, but an overall
  // failure cannot name the failing segment.
  return base.status === "failure" ? { ...base, definite: false } : base;
}

function classifySegmentAgnosticResult(
  command: CommandDescriptor,
  signal: CommandResultSignal,
): CommandResultClassification {
  if (
    signal.status === "success" ||
    signal.status === "failure"
  ) {
    return { status: signal.status, definite: true, source: "metadata" };
  }
  if (signal.status === "timeout" || signal.status === "cancelled") {
    return { status: signal.status, definite: false, source: "metadata" };
  }
  const exitCode = signal.exitCode ?? signal.exit_code;
  if (exitCode !== undefined && Number.isSafeInteger(exitCode)) {
    return {
      status: exitCode === 0 ? "success" : "failure",
      definite: true,
      source: "exit_code",
    };
  }
  if (command.opaque) {
    return { status: "unknown", definite: false, source: "unknown" };
  }
  const output = signal.output ?? "";
  if (
    /\b(?:timed out|timeout)\b/iu.test(output) ||
    /\b(?:cancelled|canceled|aborted)\b/iu.test(output)
  ) {
    return {
      status: /\b(?:timed out|timeout)\b/iu.test(output) ? "timeout" : "cancelled",
      definite: false,
      source: "output",
    };
  }
  if (
    hasPositiveCount(output, "failed") ||
    /^FAIL(?:\s|$)/mu.test(output) ||
    /test result:\s*FAILED/iu.test(output) ||
    /^npm ERR!/mu.test(output)
  ) {
    return { status: "failure", definite: true, source: "output" };
  }
  if (
    hasPositiveCount(output, "passed") ||
    /test result:\s*ok\b/iu.test(output) ||
    /\bbuild succeeded\b/iu.test(output)
  ) {
    return { status: "success", definite: true, source: "output" };
  }
  return { status: "unknown", definite: false, source: "unknown" };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
