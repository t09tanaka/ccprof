import type { ToolResultStatus } from "../core/model.js";

export type CommandFamily = "test" | "build" | "check" | "other";
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

export function classifyCommand(raw: string): CommandDescriptor {
  const tokenized = tokenizeCommand(raw);
  const tokens = stripLeadingWrappers(tokenized.tokens);
  const normalized = tokens.map(quoteToken).join(" ");
  if (tokenized.opaque || tokens.length === 0) {
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
