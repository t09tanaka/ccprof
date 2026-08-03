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
  runDataCommand,
  type DataCommandOptions,
} from "./commands/data.js";
import {
  FindingNotFoundError,
  runDismissCommand,
  runExplainCommand,
  type DismissCommandOptions,
  type ExplainCommandOptions,
} from "./commands/dismiss.js";
import {
  runHookEventCommand,
  type HookEventCommandOptions,
} from "./commands/hook-event.js";
import {
  HooksConfirmationRequiredError,
  runHooksCommand,
  type HooksCommandOptions,
} from "./commands/hooks.js";
import {
  runStatsCommand,
  type StatsCommandOptions,
} from "./commands/stats.js";
import {
  InvalidAnalysisWindowError,
  NoAnalyzableTimestampsError,
  NoMatchingSessionsError,
} from "./core/analyze.js";
import type { RuleId } from "./core/model.js";
import { GitContextError } from "./git/pr-context.js";
import {
  defaultPrivacyProfile,
  sanitizePrivacyText,
  type PrivacyProfile,
} from "./reporters/privacy.js";
import { sanitizeHumanText } from "./reporters/sanitize.js";
import { listRuleManifests, ruleManifest } from "./rules/manifest.js";

export const USAGE = `Usage: ccprof [--pr [<number|url|base...head>]] [--json|--md]
              [--idle-threshold <duration>] [--test-map <path>] [--color]
              [--since <RFC3339>] [--commit-lookback <duration>]
              [--privacy <strict|balanced|raw>] [--advisory]
       ccprof stats [--json] [--privacy <strict|balanced|raw>]
       ccprof dismiss <finding-key> [--reason <text>]
       ccprof explain <finding-key>
       ccprof hook-event [--notify]
       ccprof hooks install|uninstall [--global] [--yes]
       ccprof data gc|delete
       ccprof rules list
       ccprof rules explain <rule-id>
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
  advisory: boolean;
  privacy?: PrivacyProfile;
  pr?: string;
  sinceMs?: number;
  commitAnchorLookbackMs?: number;
  idleThresholdMs?: number;
  testMapPath?: string;
}

export interface ParsedStatsCommand {
  kind: "stats";
  json: boolean;
  privacy?: PrivacyProfile;
}

export interface ParsedDismissCommand {
  kind: "dismiss";
  findingKey: string;
  reason?: string;
}

export interface ParsedExplainCommand {
  kind: "explain";
  findingKey: string;
}

export interface ParsedHookEventCommand {
  kind: "hook-event";
  notify: boolean;
}

export interface ParsedHooksCommand {
  kind: "hooks";
  action: "install" | "uninstall";
  global: boolean;
  yes: boolean;
}

export interface ParsedDataCommand {
  kind: "data";
  action: "gc" | "delete";
}

export type ParsedRulesCommand =
  | { kind: "rules"; action: "list" }
  | { kind: "rules"; action: "explain"; ruleId: RuleId };

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
  | ParsedExplainCommand
  | ParsedHookEventCommand
  | ParsedHooksCommand
  | ParsedDataCommand
  | ParsedRulesCommand
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
  explain?: (
    options: ExplainCommandOptions,
  ) => Promise<CommandExecutionResult>;
  hookEvent: (
    options: HookEventCommandOptions,
  ) => Promise<CommandExecutionResult>;
  hooks: (
    options: HooksCommandOptions,
  ) => Promise<CommandExecutionResult>;
  data?: (
    options: DataCommandOptions,
  ) => Promise<CommandExecutionResult>;
}

export interface CliRuntime {
  cwd?: string;
  /** Override CI detection; CI defaults analysis output to strict privacy. */
  ci?: boolean;
  handlers?: CliHandlers;
  stdout?: (value: string) => void;
  stdoutIsTTY?: boolean;
  stderr?: (value: string) => void;
  /**
   * Pre-collected stdin text for the `hook-event` command. Tests inject
   * this to avoid touching `process.stdin`; when omitted, `runCli` reads
   * stdin to completion before dispatching `hook-event`.
   */
  stdinText?: string;
}

const defaultHandlers: CliHandlers = {
  analyze: runAnalyzeCommand,
  stats: runStatsCommand,
  dismiss: runDismissCommand,
  explain: runExplainCommand,
  hookEvent: runHookEventCommand,
  hooks: runHooksCommand,
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

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 &&
      (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseRfc3339Ms(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/iu
    .exec(value);
  const invalid = (): never => {
    throw new CliUsageError(
      "--since must be an RFC3339 date-time with an explicit timezone",
    );
  };
  if (match === null) {
    throw new CliUsageError(
      "--since must be an RFC3339 date-time with an explicit timezone",
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const zone = match[8] as string;
  const isZulu = zone.toUpperCase() === "Z";
  const offsetHour = isZulu ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = isZulu ? 0 : Number(zone.slice(4, 6));
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) {
    invalid();
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  const offsetSign = zone.startsWith("-") ? -1 : 1;
  const offsetMs = offsetSign *
    (offsetHour * 60 + offsetMinute) * 60_000;
  const timestamp = local.getTime() - offsetMs;
  if (
    !Number.isFinite(timestamp) ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    throw new CliUsageError("--since is outside the supported date range");
  }
  return timestamp;
}

function parseAnalyzeArgs(
  args: readonly string[],
): ParsedAnalyzeCommand {
  let format: AnalyzeOutputFormat = "tty";
  let color = false;
  let advisory = false;
  let privacy: PrivacyProfile | undefined;
  let pr: string | undefined;
  let sinceMs: number | undefined;
  let commitAnchorLookbackMs: number | undefined;
  let idleThresholdMs: number | undefined;
  let testMapPath: string | undefined;
  let sawPr = false;
  let sawFormat = false;
  let sawColor = false;
  let sawAdvisory = false;
  let sawPrivacy = false;
  let sawSince = false;
  let sawCommitLookback = false;
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
    if (token === "--advisory") {
      if (sawAdvisory) {
        throw new CliUsageError("--advisory was specified twice");
      }
      sawAdvisory = true;
      advisory = true;
      continue;
    }
    if (token === "--privacy") {
      if (sawPrivacy) {
        throw new CliUsageError("--privacy was specified twice");
      }
      sawPrivacy = true;
      const selected = requiredOptionValue(args, index, "--privacy");
      privacy = parsePrivacyProfile(selected.value);
      index = selected.nextIndex;
      continue;
    }
    const inlinePrivacy = token.startsWith("--privacy=")
      ? inlineOptionValue(token, "--privacy")
      : null;
    if (inlinePrivacy !== null) {
      if (sawPrivacy) {
        throw new CliUsageError("--privacy was specified twice");
      }
      sawPrivacy = true;
      privacy = parsePrivacyProfile(inlinePrivacy);
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
    if (token === "--since") {
      if (sawSince) throw new CliUsageError("--since was specified twice");
      sawSince = true;
      const selected = requiredOptionValue(args, index, "--since");
      sinceMs = parseRfc3339Ms(selected.value);
      index = selected.nextIndex;
      continue;
    }
    const inlineSince = token.startsWith("--since=")
      ? inlineOptionValue(token, "--since")
      : null;
    if (inlineSince !== null) {
      if (sawSince) throw new CliUsageError("--since was specified twice");
      sawSince = true;
      sinceMs = parseRfc3339Ms(inlineSince);
      continue;
    }
    if (token === "--commit-lookback") {
      if (sawCommitLookback) {
        throw new CliUsageError("--commit-lookback was specified twice");
      }
      sawCommitLookback = true;
      const selected = requiredOptionValue(
        args,
        index,
        "--commit-lookback",
      );
      commitAnchorLookbackMs = parseDurationMs(selected.value);
      index = selected.nextIndex;
      continue;
    }
    const inlineCommitLookback = token.startsWith("--commit-lookback=")
      ? inlineOptionValue(token, "--commit-lookback")
      : null;
    if (inlineCommitLookback !== null) {
      if (sawCommitLookback) {
        throw new CliUsageError("--commit-lookback was specified twice");
      }
      sawCommitLookback = true;
      commitAnchorLookbackMs = parseDurationMs(inlineCommitLookback);
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
    advisory,
    ...(privacy === undefined ? {} : { privacy }),
    ...(pr === undefined ? {} : { pr }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(commitAnchorLookbackMs === undefined
      ? {}
      : { commitAnchorLookbackMs }),
    ...(idleThresholdMs === undefined ? {} : { idleThresholdMs }),
    ...(testMapPath === undefined ? {} : { testMapPath }),
  };
}

function isPrivacyProfile(value: unknown): value is PrivacyProfile {
  return value === "strict" || value === "balanced" || value === "raw";
}

function parsePrivacyProfile(value: string): PrivacyProfile {
  if (isPrivacyProfile(value)) return value;
  throw new CliUsageError("--privacy must be strict, balanced, or raw");
}

function parseStatsArgs(
  args: readonly string[],
): ParsedStatsCommand {
  let json = false;
  let privacy: PrivacyProfile | undefined;
  let sawPrivacy = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === "--json") {
      if (json) throw new CliUsageError(`unknown stats argument: ${token}`);
      json = true;
      continue;
    }
    if (token === "--privacy") {
      if (sawPrivacy) {
        throw new CliUsageError("--privacy was specified twice");
      }
      sawPrivacy = true;
      const selected = requiredOptionValue(args, index, "--privacy");
      privacy = parsePrivacyProfile(selected.value);
      index = selected.nextIndex;
      continue;
    }
    const inlinePrivacy = token.startsWith("--privacy=")
      ? inlineOptionValue(token, "--privacy")
      : null;
    if (inlinePrivacy !== null) {
      if (sawPrivacy) {
        throw new CliUsageError("--privacy was specified twice");
      }
      sawPrivacy = true;
      privacy = parsePrivacyProfile(inlinePrivacy);
      continue;
    }
    throw new CliUsageError(`unknown stats argument: ${token}`);
  }
  return {
    kind: "stats",
    json,
    ...(privacy === undefined ? {} : { privacy }),
  };
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

function parseExplainArgs(
  args: readonly string[],
): ParsedExplainCommand {
  const findingKey = args[0];
  if (
    findingKey === undefined ||
    findingKey.startsWith("-") ||
    findingKey.trim() === ""
  ) {
    throw new CliUsageError("explain requires a finding key");
  }
  if (args.length !== 1) {
    throw new CliUsageError(`unknown explain argument: ${args[1]}`);
  }
  return { kind: "explain", findingKey };
}

function parseHookEventArgs(
  args: readonly string[],
): ParsedHookEventCommand {
  let notify = false;
  for (const token of args) {
    if (token !== "--notify" || notify) {
      throw new CliUsageError(`unknown hook-event argument: ${token}`);
    }
    notify = true;
  }
  return { kind: "hook-event", notify };
}

function parseHooksArgs(args: readonly string[]): ParsedHooksCommand {
  const action = args[0];
  if (action !== "install" && action !== "uninstall") {
    throw new CliUsageError("hooks requires an install or uninstall action");
  }
  let global = false;
  let yes = false;
  for (const token of args.slice(1)) {
    if (token === "--global") {
      if (global) throw new CliUsageError("--global was specified twice");
      global = true;
      continue;
    }
    if (token === "--yes") {
      if (yes) throw new CliUsageError("--yes was specified twice");
      yes = true;
      continue;
    }
    throw new CliUsageError(`unknown hooks argument: ${token}`);
  }
  return { kind: "hooks", action, global, yes };
}

function parseDataArgs(args: readonly string[]): ParsedDataCommand {
  const action = args[0];
  if ((action !== "gc" && action !== "delete") || args.length !== 1) {
    throw new CliUsageError("data requires exactly one gc or delete action");
  }
  return { kind: "data", action };
}

function parseRulesArgs(args: readonly string[]): ParsedRulesCommand {
  const action = args[0];
  if (action === "list") {
    if (args.length !== 1) {
      throw new CliUsageError(
        "rules list does not accept additional arguments",
      );
    }
    return { kind: "rules", action };
  }
  if (action === "explain") {
    const id = args[1];
    if (id === undefined || args.length !== 2) {
      throw new CliUsageError("rules explain requires exactly one rule id");
    }
    try {
      return { kind: "rules", action, ruleId: ruleManifest(id).id };
    } catch (error) {
      throw new CliUsageError(errorMessage(error));
    }
  }
  throw new CliUsageError("rules requires list or explain <rule-id>");
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
  if (args[0] === "explain") return parseExplainArgs(args.slice(1));
  if (args[0] === "hook-event") return parseHookEventArgs(args.slice(1));
  if (args[0] === "hooks") return parseHooksArgs(args.slice(1));
  if (args[0] === "data") return parseDataArgs(args.slice(1));
  if (args[0] === "rules") return parseRulesArgs(args.slice(1));
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
    error instanceof InvalidAnalysisWindowError ||
    error instanceof FindingNotFoundError ||
    error instanceof HooksConfirmationRequiredError
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

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Dispatches `hook-event` outside `runCli`'s main try/catch so nothing -
 * not a malformed `--notify` flag, not a stdin read failure, not a handler
 * throw - can turn into a nonzero exit. Claude Code treats any nonzero
 * hook exit as a blocking failure, so this command must always report
 * success even when it privately did nothing.
 */
async function runHookEventDispatch(
  commandArgs: readonly string[],
  runtime: CliRuntime,
  handlers: CliHandlers,
  cwd: string,
  stdout: (value: string) => void,
  stderr: (value: string) => void,
): Promise<void> {
  try {
    const parsed = parseHookEventArgs(commandArgs);
    const stdinText = runtime.stdinText ?? await readStdinText();
    const result = await handlers.hookEvent({
      cwd,
      stdinText,
      notify: parsed.notify,
    });
    stdout(withTrailingNewline(result.stdout));
    for (const warning of result.warnings) {
      stderr(withTrailingNewline(sanitizeHumanText(warning)));
    }
  } catch {
    // Swallowed by design: see the doc comment above.
  }
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
  const ci = runtime.ci ?? detectedCi(process.env.CI);
  if (args[0] === "hook-event") {
    await runHookEventDispatch(
      args.slice(1),
      runtime,
      handlers,
      cwd,
      stdout,
      stderr,
    );
    return 0;
  }
  const explicitPrivacy = args.map((token, index) =>
    token.startsWith("--privacy=") ? token.slice(10) :
      args[index - 1] === "--privacy" ? token : ""
  ).find(isPrivacyProfile);
  let activePrivacy: PrivacyProfile | undefined = args[0] === "stats"
    ? ci ? "strict" : explicitPrivacy ?? "balanced"
    : args[0] === "explain" && ci
      ? "strict"
      : ["stats", "dismiss", "explain", "hooks", "data", "rules"]
          .includes(args[0] ?? "")
        ? undefined
        : explicitPrivacy ??
          (ci || args.includes("--md") ? "strict" : "balanced");
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
    if (command.kind === "rules") {
      const value = command.action === "list"
        ? listRuleManifests()
        : ruleManifest(command.ruleId);
      stdout(`${JSON.stringify(value, null, 2)}\n`);
      return 0;
    }
    if (command.kind === "explain" && ci) {
      throw new CliUsageError("explain is local-only and unavailable in CI");
    }
    let result: CommandExecutionResult;
    if (command.kind === "analyze") {
      activePrivacy = command.privacy ??
        defaultPrivacyProfile(command.format, ci);
      result = await handlers.analyze({
        cwd,
        format: command.format,
        color: command.color ||
          (command.format === "tty" && stdoutIsTTY),
        ...(command.advisory ? { advisory: true } : {}),
        privacy: activePrivacy,
        ...(command.pr === undefined ? {} : { pr: command.pr }),
        ...(command.sinceMs === undefined
          ? {}
          : { sinceMs: command.sinceMs }),
        ...(command.commitAnchorLookbackMs === undefined
          ? {}
          : { commitAnchorLookbackMs: command.commitAnchorLookbackMs }),
        ...(command.idleThresholdMs === undefined
          ? {}
          : { idleThresholdMs: command.idleThresholdMs }),
        ...(command.testMapPath === undefined
          ? {}
          : { testMapPath: command.testMapPath }),
      });
    } else if (command.kind === "stats") {
      activePrivacy = ci ? "strict" : command.privacy ?? "balanced";
      result = await handlers.stats({
        cwd,
        json: command.json,
        privacy: activePrivacy,
      });
    } else if (command.kind === "dismiss") {
      result = await handlers.dismiss({
        cwd,
        findingKey: command.findingKey,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      });
    } else if (command.kind === "explain") {
      result = await (handlers.explain ?? runExplainCommand)({
        cwd,
        findingKey: command.findingKey,
      });
    } else if (command.kind === "hooks") {
      result = await handlers.hooks({
        cwd,
        action: command.action,
        global: command.global,
        yes: command.yes,
      });
    } else if (command.kind === "data") {
      result = await (handlers.data ?? runDataCommand)({
        cwd,
        action: command.action,
      });
    } else {
      // command.kind === "hook-event": runCli dispatches hook-event before
      // this try/catch (see below) so its always-exit-0 contract holds even
      // for CLI-level parse errors. Unreachable in practice; kept only so
      // the analyze/stats/dismiss/explain/hooks/data/rules narrowing above
      // stays exhaustive.
      throw new CliUsageError("hook-event must be dispatched separately");
    }
    stdout(withTrailingNewline(result.stdout));
    for (const warning of result.warnings) {
      stderr(withTrailingNewline(sanitizeHumanText(
        activePrivacy === undefined
          ? warning
          : sanitizePrivacyText(warning, activePrivacy, cwd, []),
      )));
    }
    return 0;
  } catch (error) {
    const code = exitCodeFor(error);
    const detail = activePrivacy === "strict"
      ? "analysis failed (details hidden by strict privacy)"
      : errorMessage(error);
    const message = activePrivacy === undefined ? detail : sanitizePrivacyText(
      detail, activePrivacy, cwd, [],
    );
    stderr(`ccprof: ${sanitizeHumanText(message)}\n`);
    if (
      code === 2 &&
      (error instanceof CliUsageError ||
        error instanceof InvalidAnalysisWindowError)
    ) {
      stderr(USAGE);
    }
    return code;
  }
}

function detectedCi(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && normalized !== "" &&
    normalized !== "false" && normalized !== "0";
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
