#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runAnalyzeCommand,
  type AnalyzeCommandOptions,
  type AnalyzeOutputFormat,
  type CommandExecutionResult,
} from "./commands/analyze.js";
import {
  FindingNotFoundError,
  runDismissCommand,
  type DismissCommandOptions,
} from "./commands/dismiss.js";
import {
  runStatsCommand,
  type StatsCommandOptions,
} from "./commands/stats.js";
import {
  NoAnalyzableTimestampsError,
  NoMatchingSessionsError,
} from "./core/analyze.js";
import { GitContextError } from "./git/pr-context.js";
import { sanitizeHumanText } from "./reporters/sanitize.js";

export const USAGE = `Usage: ccprof [--pr [<number|url|base...head>]] [--json|--md]
              [--idle-threshold <duration>] [--test-map <path>] [--color]
       ccprof stats [--json]
       ccprof dismiss <finding-key> [--reason <text>]
       ccprof --version
`;

/**
 * Resolve the package version from the nearest package.json above this module.
 * Walking up keeps `dist/cli.js` and the test build layout on the same path.
 */
export function resolvePackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = resolve(directory, "package.json");
    const version = readVersionField(manifest);
    if (version !== null) return version;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("package.json with a version field was not found");
    }
    directory = parent;
  }
}

function readVersionField(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" && version !== "" ? version : null;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface ParsedAnalyzeCommand {
  kind: "analyze";
  format: AnalyzeOutputFormat;
  color: boolean;
  pr?: string;
  idleThresholdMs?: number;
  testMapPath?: string;
}

export interface ParsedStatsCommand {
  kind: "stats";
  json: boolean;
}

export interface ParsedDismissCommand {
  kind: "dismiss";
  findingKey: string;
  reason?: string;
}

export interface ParsedHelpCommand {
  kind: "help";
}

export interface ParsedVersionCommand {
  kind: "version";
}

export type ParsedCliCommand =
  | ParsedAnalyzeCommand
  | ParsedStatsCommand
  | ParsedDismissCommand
  | ParsedHelpCommand
  | ParsedVersionCommand;

export interface CliHandlers {
  analyze: (
    options: AnalyzeCommandOptions,
  ) => Promise<CommandExecutionResult>;
  stats: (
    options: StatsCommandOptions,
  ) => Promise<CommandExecutionResult>;
  dismiss: (
    options: DismissCommandOptions,
  ) => Promise<CommandExecutionResult>;
}

export interface CliRuntime {
  cwd?: string;
  handlers?: CliHandlers;
  stdout?: (value: string) => void;
  stdoutIsTTY?: boolean;
  stderr?: (value: string) => void;
}

const defaultHandlers: CliHandlers = {
  analyze: runAnalyzeCommand,
  stats: runStatsCommand,
  dismiss: runDismissCommand,
};

function requiredOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } {
  const value = args[index + 1];
  if (
    value === undefined ||
    value.startsWith("-") ||
    value.trim() === ""
  ) {
    throw new CliUsageError(`${option} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function inlineOptionValue(
  token: string,
  option: string,
): string | null {
  const prefix = `${option}=`;
  if (!token.startsWith(prefix)) return null;
  const value = token.slice(prefix.length);
  if (value.trim() === "") {
    throw new CliUsageError(`${option} requires a value`);
  }
  return value;
}

export function parseDurationMs(value: string): number {
  const match = /^((?:\d+(?:\.\d*)?)|(?:\.\d+))([smh]?)$/u.exec(
    value.trim(),
  );
  if (match === null) {
    throw new CliUsageError(
      "duration must be nonnegative minutes or end in s, m, or h",
    );
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "s"
    ? 1_000
    : match[2] === "h"
      ? 60 * 60 * 1_000
      : 60 * 1_000;
  const milliseconds = Math.round(amount * multiplier);
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(milliseconds)
  ) {
    throw new CliUsageError("duration is outside the supported range");
  }
  return milliseconds;
}

function parseAnalyzeArgs(
  args: readonly string[],
): ParsedAnalyzeCommand {
  let format: AnalyzeOutputFormat = "tty";
  let color = false;
  let pr: string | undefined;
  let idleThresholdMs: number | undefined;
  let testMapPath: string | undefined;
  let sawPr = false;
  let sawFormat = false;
  let sawColor = false;
  let sawIdle = false;
  let sawTestMap = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === "--json" || token === "--md") {
      if (sawFormat) {
        throw new CliUsageError("--json and --md are mutually exclusive");
      }
      sawFormat = true;
      format = token === "--json" ? "json" : "markdown";
      continue;
    }
    if (token === "--color") {
      if (sawColor) throw new CliUsageError("--color was specified twice");
      sawColor = true;
      color = true;
      continue;
    }
    if (token === "--pr") {
      if (sawPr) throw new CliUsageError("--pr was specified twice");
      sawPr = true;
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        if (next.trim() === "") {
          throw new CliUsageError("--pr selector must be non-empty");
        }
        pr = next;
        index += 1;
      }
      continue;
    }
    const inlinePr = token.startsWith("--pr=")
      ? inlineOptionValue(token, "--pr")
      : null;
    if (inlinePr !== null) {
      if (sawPr) throw new CliUsageError("--pr was specified twice");
      sawPr = true;
      pr = inlinePr;
      continue;
    }
    if (token === "--idle-threshold") {
      if (sawIdle) {
        throw new CliUsageError("--idle-threshold was specified twice");
      }
      sawIdle = true;
      const selected = requiredOptionValue(
        args,
        index,
        "--idle-threshold",
      );
      idleThresholdMs = parseDurationMs(selected.value);
      index = selected.nextIndex;
      continue;
    }
    const inlineIdle = token.startsWith("--idle-threshold=")
      ? inlineOptionValue(token, "--idle-threshold")
      : null;
    if (inlineIdle !== null) {
      if (sawIdle) {
        throw new CliUsageError("--idle-threshold was specified twice");
      }
      sawIdle = true;
      idleThresholdMs = parseDurationMs(inlineIdle);
      continue;
    }
    if (token === "--test-map") {
      if (sawTestMap) {
        throw new CliUsageError("--test-map was specified twice");
      }
      sawTestMap = true;
      const selected = requiredOptionValue(args, index, "--test-map");
      testMapPath = selected.value;
      index = selected.nextIndex;
      continue;
    }
    const inlineTestMap = token.startsWith("--test-map=")
      ? inlineOptionValue(token, "--test-map")
      : null;
    if (inlineTestMap !== null) {
      if (sawTestMap) {
        throw new CliUsageError("--test-map was specified twice");
      }
      sawTestMap = true;
      testMapPath = inlineTestMap;
      continue;
    }
    throw new CliUsageError(`unknown analyze argument: ${token}`);
  }
  return {
    kind: "analyze",
    format,
    color,
    ...(pr === undefined ? {} : { pr }),
    ...(idleThresholdMs === undefined ? {} : { idleThresholdMs }),
    ...(testMapPath === undefined ? {} : { testMapPath }),
  };
}

function parseStatsArgs(
  args: readonly string[],
): ParsedStatsCommand {
  let json = false;
  for (const token of args) {
    if (token !== "--json" || json) {
      throw new CliUsageError(`unknown stats argument: ${token}`);
    }
    json = true;
  }
  return { kind: "stats", json };
}

function parseDismissArgs(
  args: readonly string[],
): ParsedDismissCommand {
  const findingKey = args[0];
  if (
    findingKey === undefined ||
    findingKey.startsWith("-") ||
    findingKey.trim() === ""
  ) {
    throw new CliUsageError("dismiss requires a finding key");
  }
  let reason: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === "--reason") {
      if (reason !== undefined) {
        throw new CliUsageError("--reason was specified twice");
      }
      const selected = requiredOptionValue(args, index, "--reason");
      reason = selected.value;
      index = selected.nextIndex;
      continue;
    }
    const inlineReason = token.startsWith("--reason=")
      ? inlineOptionValue(token, "--reason")
      : null;
    if (inlineReason !== null) {
      if (reason !== undefined) {
        throw new CliUsageError("--reason was specified twice");
      }
      reason = inlineReason;
      continue;
    }
    throw new CliUsageError(`unknown dismiss argument: ${token}`);
  }
  return {
    kind: "dismiss",
    findingKey,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function parseCliArgs(
  args: readonly string[],
): ParsedCliCommand {
  if (args.includes("--help") || args.includes("-h")) {
    return { kind: "help" };
  }
  if (args.includes("--version") || args.includes("-v")) {
    return { kind: "version" };
  }
  if (args[0] === "stats") return parseStatsArgs(args.slice(1));
  if (args[0] === "dismiss") return parseDismissArgs(args.slice(1));
  return parseAnalyzeArgs(args);
}

function withTrailingNewline(value: string): string {
  return value === "" || value.endsWith("\n") ? value : `${value}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitCodeFor(error: unknown): number {
  if (
    error instanceof CliUsageError ||
    error instanceof FindingNotFoundError
  ) {
    return 2;
  }
  if (error instanceof GitContextError) return 3;
  if (
    error instanceof NoMatchingSessionsError ||
    error instanceof NoAnalyzableTimestampsError
  ) {
    return 4;
  }
  return 5;
}

export async function runCli(
  args: readonly string[],
  runtime: CliRuntime = {},
): Promise<number> {
  const usesDefaultStdout = runtime.stdout === undefined;
  const stdout = runtime.stdout ?? ((value: string) => {
    process.stdout.write(value);
  });
  const stdoutIsTTY = runtime.stdoutIsTTY ??
    (usesDefaultStdout && process.stdout.isTTY === true);
  const stderr = runtime.stderr ?? ((value: string) => {
    process.stderr.write(value);
  });
  const handlers = runtime.handlers ?? defaultHandlers;
  const cwd = runtime.cwd ?? process.cwd();
  try {
    const command = parseCliArgs(args);
    if (command.kind === "help") {
      stdout(USAGE);
      return 0;
    }
    if (command.kind === "version") {
      stdout(`ccprof ${resolvePackageVersion()}\n`);
      return 0;
    }
    let result: CommandExecutionResult;
    if (command.kind === "analyze") {
      result = await handlers.analyze({
        cwd,
        format: command.format,
        color: command.color ||
          (command.format === "tty" && stdoutIsTTY),
        ...(command.pr === undefined ? {} : { pr: command.pr }),
        ...(command.idleThresholdMs === undefined
          ? {}
          : { idleThresholdMs: command.idleThresholdMs }),
        ...(command.testMapPath === undefined
          ? {}
          : { testMapPath: command.testMapPath }),
      });
    } else if (command.kind === "stats") {
      result = await handlers.stats({
        cwd,
        json: command.json,
      });
    } else {
      result = await handlers.dismiss({
        cwd,
        findingKey: command.findingKey,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      });
    }
    stdout(withTrailingNewline(result.stdout));
    for (const warning of result.warnings) {
      stderr(withTrailingNewline(sanitizeHumanText(warning)));
    }
    return 0;
  } catch (error) {
    const code = exitCodeFor(error);
    stderr(`ccprof: ${sanitizeHumanText(errorMessage(error))}\n`);
    if (code === 2 && error instanceof CliUsageError) {
      stderr(USAGE);
    }
    return code;
  }
}

export function isDirectExecution(
  moduleUrl: string,
  executablePath: string | undefined,
): boolean {
  if (executablePath === undefined) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const canonicalPath = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return canonicalPath(modulePath) === canonicalPath(executablePath);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
