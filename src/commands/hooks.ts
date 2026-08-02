import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import type { CommandExecutionResult } from "./analyze.js";
import { resolveCurrentRepoRoot } from "./stats.js";

/** Substring identifying a hook command entry as ours; also the command
 * ccprof installs (with `--notify` appended), so any Stop entry whose
 * command contains this string is recognized as an existing install. */
export const CCPROF_HOOK_MARKER = "ccprof hook-event";
const INSTALLED_COMMAND = `${CCPROF_HOOK_MARKER} --notify`;

export interface HooksCommandOptions {
  cwd: string;
  action: "install" | "uninstall";
  global: boolean;
  yes: boolean;
  /** Confirmation prompt override. Defaults to a readline prompt when
   * stdin is a TTY; when stdin is not a TTY, `--yes` is required and
   * omitting both throws `HooksConfirmationRequiredError`. */
  confirm?: (message: string) => Promise<boolean>;
}

export interface HooksCommandDependencies {
  resolveRepoRoot?: (cwd: string) => Promise<string>;
  homeDir?: () => string;
}

export class HooksConfirmationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HooksConfirmationRequiredError";
  }
}

export class HooksSettingsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HooksSettingsParseError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Atomic JSON write (temp file + fsync + rename) that preserves the
 * input's own key order, unlike `store/analyses.ts`'s
 * `writeJsonAtomically`, which recursively alphabetizes keys for
 * ccprof's own hash-keyed store files. `.claude/settings.json` is a
 * hand-maintained, often version-controlled user file, so silently
 * reordering its keys on every install/uninstall would be a surprising
 * side effect unrelated to the hook change being made.
 */
async function writeJsonPreservingKeyOrder(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function resolveSettingsPath(
  options: HooksCommandOptions,
  dependencies: HooksCommandDependencies,
): Promise<string> {
  if (options.global) {
    const home = (dependencies.homeDir ?? homedir)();
    return join(home, ".claude", "settings.json");
  }
  const repoRoot = await (
    dependencies.resolveRepoRoot ?? resolveCurrentRepoRoot
  )(options.cwd);
  return join(repoRoot, ".claude", "settings.json");
}

/**
 * Reads and parses the settings file. `undefined` means the file does not
 * exist (a legitimate, non-error state for both install and uninstall).
 * Any other read failure, or a parse/shape failure, throws
 * `HooksSettingsParseError` so the caller never overwrites content it
 * couldn't fully understand.
 */
async function readSettings(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HooksSettingsParseError(
      `${path} is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new HooksSettingsParseError(
      `${path} must contain a JSON object at its root`,
    );
  }
  return parsed;
}

function isMarkerCommand(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const command = entry.command;
  return typeof command === "string" && command.includes(CCPROF_HOOK_MARKER);
}

function hasMarkerEntry(settings: Record<string, unknown>): boolean {
  const hooksValue = settings.hooks;
  if (!isRecord(hooksValue) || !Array.isArray(hooksValue.Stop)) return false;
  return hooksValue.Stop.some((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
    return group.hooks.some(isMarkerCommand);
  });
}

/**
 * Rejects a settings file whose `hooks` or `hooks.Stop` shape isn't what
 * ccprof can safely merge into. Silently replacing a malformed value
 * (e.g. `hooks: "oops"` or `hooks.Stop: {}`) with fresh containers would
 * discard whatever the user actually had there, so install treats this
 * as a hard error (mirrors the corrupt-JSON case: no write, exit 5)
 * instead. Uninstall does not call this - its own shape checks already
 * no-op tolerantly on anything unexpected, per its "nothing to remove"
 * contract.
 */
function assertInstallableShape(
  settings: Record<string, unknown>,
  settingsPath: string,
): void {
  const hooksValue = settings.hooks;
  if (hooksValue === undefined) return;
  if (!isRecord(hooksValue)) {
    throw new HooksSettingsParseError(
      `${settingsPath}: "hooks" must be a JSON object, found ` +
        describeType(hooksValue),
    );
  }
  const stopValue = hooksValue.Stop;
  if (stopValue !== undefined && !Array.isArray(stopValue)) {
    throw new HooksSettingsParseError(
      `${settingsPath}: "hooks.Stop" must be a JSON array, found ` +
        describeType(stopValue),
    );
  }
}

/** Appends a new Stop group carrying the ccprof entry, leaving every other
 * key and existing Stop group untouched. Callers must call
 * `assertInstallableShape` first so `hooks`/`hooks.Stop` are known to be
 * either absent or the expected object/array shape. */
function withInstalledEntry(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const hooksValue = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const stopValue = Array.isArray(hooksValue.Stop) ? [...hooksValue.Stop] : [];
  stopValue.push({
    hooks: [{ type: "command", command: INSTALLED_COMMAND }],
  });
  hooksValue.Stop = stopValue;
  return { ...settings, hooks: hooksValue };
}

interface UninstallResult {
  changed: boolean;
  settings: Record<string, unknown>;
}

/**
 * Removes only the Stop hook entries whose command contains the ccprof
 * marker. Groups left with no entries are dropped entirely (they only
 * ever held `{ hooks: [...] }`, so an empty result is an empty
 * container); an emptied `Stop` array and an emptied top-level `hooks`
 * object are cleaned up the same way. Any group carrying keys beyond
 * `hooks`, or any entry without the marker, is preserved as-is.
 */
function withoutInstalledEntries(
  settings: Record<string, unknown>,
): UninstallResult {
  const hooksValue = settings.hooks;
  if (!isRecord(hooksValue) || !Array.isArray(hooksValue.Stop)) {
    return { changed: false, settings };
  }

  let changed = false;
  const nextStop: unknown[] = [];
  for (const group of hooksValue.Stop) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      nextStop.push(group);
      continue;
    }
    const filtered = group.hooks.filter((entry) => !isMarkerCommand(entry));
    if (filtered.length === group.hooks.length) {
      nextStop.push(group);
      continue;
    }
    changed = true;
    const isOnlyHooksKey = Object.keys(group).length === 1;
    if (filtered.length === 0 && isOnlyHooksKey) continue;
    nextStop.push({ ...group, hooks: filtered });
  }

  if (!changed) return { changed: false, settings };

  const nextHooks: Record<string, unknown> = { ...hooksValue };
  if (nextStop.length === 0) {
    delete nextHooks.Stop;
  } else {
    nextHooks.Stop = nextStop;
  }

  const nextSettings: Record<string, unknown> = { ...settings };
  if (Object.keys(nextHooks).length === 0) {
    delete nextSettings.hooks;
  } else {
    nextSettings.hooks = nextHooks;
  }
  return { changed: true, settings: nextSettings };
}

async function defaultConfirm(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function resolveConfirmation(
  options: HooksCommandOptions,
  message: string,
): Promise<boolean> {
  if (options.yes) return true;
  if (options.confirm !== undefined) return options.confirm(message);
  if (process.stdin.isTTY !== true) {
    throw new HooksConfirmationRequiredError(
      "hooks install/uninstall requires --yes outside an interactive terminal",
    );
  }
  return defaultConfirm(message);
}

export async function runHooksCommand(
  options: HooksCommandOptions,
  dependencies: HooksCommandDependencies = {},
): Promise<CommandExecutionResult> {
  const settingsPath = await resolveSettingsPath(options, dependencies);
  const settings = await readSettings(settingsPath);

  if (options.action === "install") {
    const current = settings ?? {};
    assertInstallableShape(current, settingsPath);
    if (hasMarkerEntry(current)) {
      return {
        stdout: "ccprof hook entries already installed\n",
        warnings: [],
      };
    }
    const confirmed = await resolveConfirmation(
      options,
      `Install ccprof Stop hook into ${settingsPath}?`,
    );
    if (!confirmed) {
      return { stdout: "aborted\n", warnings: [] };
    }
    await writeJsonPreservingKeyOrder(
      settingsPath,
      withInstalledEntry(current),
    );
    return {
      stdout: `Installed ccprof Stop hook into ${settingsPath}\n`,
      warnings: [],
    };
  }

  if (settings === undefined) {
    return { stdout: "No ccprof hook entries found\n", warnings: [] };
  }
  const removal = withoutInstalledEntries(settings);
  if (!removal.changed) {
    return { stdout: "No ccprof hook entries found\n", warnings: [] };
  }
  const confirmed = await resolveConfirmation(
    options,
    `Remove ccprof hook entries from ${settingsPath}?`,
  );
  if (!confirmed) {
    return { stdout: "aborted\n", warnings: [] };
  }
  await writeJsonPreservingKeyOrder(settingsPath, removal.settings);
  return {
    stdout: `Removed ccprof hook entries from ${settingsPath}\n`,
    warnings: [],
  };
}
