import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Confidence } from "../core/model.js";
import {
  classifyCommand,
  normalizeCommand,
  type CommandDescriptor,
} from "./command.js";

export type TestMapOrigin = "explicit" | "manifest";

export interface TestMapping {
  source: string[];
  tests: string[];
  commands: string[];
  confidence: Confidence;
  origin: TestMapOrigin;
  caveat: string;
}

export interface TestMap {
  mappings: TestMapping[];
  caveats: string[];
}

export interface TestRelevance {
  relevant: boolean | null;
  confidence: Confidence;
  origin: TestMapOrigin | "fallback";
  caveat: string;
  matchedPaths: string[];
}

export class TestMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestMapError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(
  value: unknown,
  label: string,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    throw new TestMapError(`${label} must be a non-empty string array`);
  }
  return value as string[];
}

/**
 * Normalizes a repository-relative path or supported glob. It deliberately
 * rejects traversal and shell-style glob features outside `*` and `**`.
 */
export function normalizeRepoPath(
  value: string,
  options: { glob?: boolean } = {},
): string {
  const slashes = value.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (
    slashes === "" ||
    slashes.includes("\0") ||
    slashes.startsWith("/") ||
    slashes.startsWith("//") ||
    /^[A-Za-z]:\//u.test(slashes)
  ) {
    throw new TestMapError(`path must be repository-relative: ${JSON.stringify(value)}`);
  }
  if (options.glob === true && /[?[\]{}!]/u.test(slashes)) {
    throw new TestMapError(`unsupported glob syntax: ${JSON.stringify(value)}`);
  }
  const segments = slashes.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === "..") {
      throw new TestMapError(`path traversal is not allowed: ${JSON.stringify(value)}`);
    }
    if (segment === ".") continue;
    if (
      options.glob === true &&
      (segment.includes("***") || (segment.includes("**") && segment !== "**"))
    ) {
      throw new TestMapError(
        `** is supported only as a complete path segment: ${JSON.stringify(value)}`,
      );
    }
    if (options.glob !== true && segment.includes("*")) {
      throw new TestMapError(`wildcards are not allowed in observed paths: ${JSON.stringify(value)}`);
    }
    normalized.push(segment);
  }
  if (normalized.length === 0) {
    throw new TestMapError(`path must name a repository entry: ${JSON.stringify(value)}`);
  }
  return normalized.join("/");
}

function segmentMatches(value: string, pattern: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`, "u").test(value);
}

export function pathMatchesGlob(path: string, glob: string): boolean {
  let normalizedPath: string;
  let normalizedGlob: string;
  try {
    normalizedPath = normalizeRepoPath(path);
    normalizedGlob = normalizeRepoPath(glob, { glob: true });
  } catch {
    return false;
  }
  const pathSegments = normalizedPath.split("/");
  const globSegments = normalizedGlob.split("/");
  const memo = new Map<string, boolean>();
  const visit = (pathIndex: number, globIndex: number): boolean => {
    const key = `${pathIndex}:${globIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    const pattern = globSegments[globIndex];
    if (pattern === undefined) {
      result = pathIndex === pathSegments.length;
    } else if (pattern === "**") {
      result =
        visit(pathIndex, globIndex + 1) ||
        (pathIndex < pathSegments.length && visit(pathIndex + 1, globIndex));
    } else {
      const current = pathSegments[pathIndex];
      result =
        current !== undefined &&
        segmentMatches(current, pattern) &&
        visit(pathIndex + 1, globIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

function normalizeMappingCommands(commands: readonly string[]): string[] {
  return unique(commands.map((command) => {
    const normalized = normalizeCommand(command);
    if (normalized === null) {
      throw new TestMapError(
        `mapped command must be a single non-empty command: ${JSON.stringify(command)}`,
      );
    }
    return normalized;
  }));
}

export function parseExplicitTestMap(value: unknown): TestMap {
  if (!isRecord(value) || !Array.isArray(value.mappings)) {
    throw new TestMapError("test map must contain a mappings array");
  }
  const mappings = value.mappings.map((entry, index): TestMapping => {
    if (!isRecord(entry)) {
      throw new TestMapError(`mappings[${index}] must be an object`);
    }
    const source = stringArray(entry.source, `mappings[${index}].source`)
      .map((pattern) => normalizeRepoPath(pattern, { glob: true }));
    const tests = stringArray(entry.tests, `mappings[${index}].tests`)
      .map((pattern) => normalizeRepoPath(pattern, { glob: true }));
    const commands = normalizeMappingCommands(
      stringArray(entry.commands, `mappings[${index}].commands`),
    );
    return {
      source: unique(source),
      tests: unique(tests),
      commands,
      confidence: "high",
      origin: "explicit",
      caveat: "Relevance is based on the explicit test map.",
    };
  });
  return { mappings, caveats: [] };
}

export async function loadExplicitTestMap(path: string): Promise<TestMap> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TestMapError(`cannot read explicit test map: ${detail}`);
  }
  return parseExplicitTestMap(parsed);
}

function nodeCommands(scriptNames: readonly string[]): string[] {
  const commands: string[] = [];
  for (const name of scriptNames) {
    for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
      commands.push(`${manager} run ${name}`);
      if (name === "test" || name === "build" || name === "check") {
        commands.push(`${manager} ${name}`);
      }
    }
  }
  return unique(commands.map((command) => normalizeCommand(command) as string));
}

async function packageMapping(repoRoot: string): Promise<{
  mapping: TestMapping | null;
  caveats: string[];
}> {
  const manifestPath = join(repoRoot, "package.json");
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { mapping: null, caveats: [] };
    return {
      mapping: null,
      caveats: [`package.json could not be read: ${errorMessage(error)}`],
    };
  }
  try {
    const manifest = JSON.parse(text) as unknown;
    if (!isRecord(manifest) || !isRecord(manifest.scripts)) {
      return {
        mapping: null,
        caveats: ["package.json has no readable scripts object."],
      };
    }
    const names = Object.keys(manifest.scripts).filter(
      (name) => classifyCommand(`npm run ${name}`).family !== "other",
    );
    if (names.length === 0) return { mapping: null, caveats: [] };
    return {
      mapping: {
        source: ["src/**", "lib/**", "app/**", "packages/**/src/**"],
        tests: [
          "test/**",
          "tests/**",
          "**/*.test.*",
          "**/*.spec.*",
          "**/__tests__/**",
        ],
        commands: nodeCommands(names),
        confidence: "medium",
        origin: "manifest",
        caveat: "Relevance is inferred from package.json scripts and JavaScript conventions.",
      },
      caveats: [],
    };
  } catch (error) {
    return {
      mapping: null,
      caveats: [`package.json could not be parsed: ${errorMessage(error)}`],
    };
  }
}

async function cargoMapping(repoRoot: string): Promise<{
  mapping: TestMapping | null;
  caveats: string[];
}> {
  const manifestPath = join(repoRoot, "Cargo.toml");
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { mapping: null, caveats: [] };
    return {
      mapping: null,
      caveats: [`Cargo.toml could not be read: ${errorMessage(error)}`],
    };
  }
  if (!/^\s*\[(?:package|workspace)\]\s*$/mu.test(text)) {
    return {
      mapping: null,
      caveats: ["Cargo.toml lacks a package or workspace section."],
    };
  }
  return {
    mapping: {
      source: ["src/**", "crates/**/src/**"],
      tests: ["tests/**", "crates/**/tests/**"],
      commands: ["cargo test", "cargo build", "cargo check"],
      confidence: "medium",
      origin: "manifest",
      caveat: "Relevance is inferred from Cargo.toml and Rust conventions.",
    },
    caveats: [],
  };
}

export async function discoverManifestTestMap(
  repoRoot: string,
): Promise<TestMap> {
  const [node, cargo] = await Promise.all([
    packageMapping(repoRoot),
    cargoMapping(repoRoot),
  ]);
  return {
    mappings: [node.mapping, cargo.mapping].flatMap((mapping) =>
      mapping === null ? [] : [mapping]
    ),
    caveats: [...node.caveats, ...cargo.caveats],
  };
}

export function mergeTestMaps(...maps: readonly TestMap[]): TestMap {
  return {
    mappings: maps.flatMap((map) => map.mappings),
    caveats: unique(maps.flatMap((map) => map.caveats)),
  };
}

function commandTokens(command: string): string[] {
  return classifyCommand(command).tokens;
}

function commandMatches(
  descriptor: CommandDescriptor,
  mappedCommand: string,
): boolean {
  const mapped = commandTokens(mappedCommand);
  return (
    !descriptor.opaque &&
    mapped.length > 0 &&
    mapped.every((token, index) => descriptor.tokens[index] === token)
  );
}

export function hasMappedCommand(
  descriptor: CommandDescriptor,
  map: TestMap,
): boolean {
  return map.mappings.some((mapping) =>
    mapping.commands.some((command) => commandMatches(descriptor, command))
  );
}

function mappingPathRelation(
  descriptor: CommandDescriptor,
  editedPaths: readonly string[],
  mapping: TestMapping,
): { relevant: boolean | null; matchedPaths: string[] } {
  const sourceOrTest = [...mapping.source, ...mapping.tests];
  const matchingEdits = editedPaths.filter((path) =>
    sourceOrTest.some((pattern) => pathMatchesGlob(path, pattern))
  );
  if (descriptor.scope !== "targeted") {
    return {
      relevant: matchingEdits.length > 0,
      matchedPaths: matchingEdits,
    };
  }
  if (descriptor.pathTargets.length === 0) {
    return { relevant: null, matchedPaths: [] };
  }
  const mappedTargets = descriptor.pathTargets.filter((path) =>
    sourceOrTest.some((pattern) => pathMatchesGlob(path, pattern))
  );
  if (
    editedPaths.some((edited) =>
      descriptor.pathTargets.some((target) => pathsDirectlyRelated(edited, target))
    )
  ) {
    return {
      relevant: true,
      matchedPaths: editedPaths.filter((edited) =>
        descriptor.pathTargets.some((target) => pathsDirectlyRelated(edited, target))
      ),
    };
  }
  if (mappedTargets.length > 0) {
    return {
      relevant: matchingEdits.length > 0,
      matchedPaths: matchingEdits,
    };
  }
  return { relevant: null, matchedPaths: [] };
}

export function evaluateTestRelevance(
  descriptor: CommandDescriptor,
  rawEditedPaths: readonly string[],
  map: TestMap,
): TestRelevance {
  const editedPaths = unique(rawEditedPaths.flatMap((path) => {
    try {
      return [normalizeRepoPath(path)];
    } catch {
      return [];
    }
  }));
  const applicable = map.mappings.filter((mapping) =>
    mapping.commands.some((command) => commandMatches(descriptor, command))
  );
  const explicit = applicable.filter((mapping) => mapping.origin === "explicit");
  const selected = explicit.length > 0
    ? explicit
    : applicable.filter((mapping) => mapping.origin === "manifest");
  if (selected.length > 0) {
    const decisions = selected.map((mapping) => ({
      mapping,
      ...mappingPathRelation(descriptor, editedPaths, mapping),
    }));
    const relevant = decisions.some((decision) => decision.relevant === true)
      ? true
      : decisions.every((decision) => decision.relevant === false)
        ? false
        : null;
    const first = decisions[0] as (typeof decisions)[number];
    return {
      relevant,
      confidence: first.mapping.confidence,
      origin: first.mapping.origin,
      caveat: unique(decisions.map((decision) => decision.mapping.caveat)).join(" "),
      matchedPaths: unique(decisions.flatMap((decision) => decision.matchedPaths)),
    };
  }
  return fallbackRelevance(descriptor, editedPaths);
}

function fallbackRelevance(
  descriptor: CommandDescriptor,
  editedPaths: readonly string[],
): TestRelevance {
  const base = {
    confidence: "low" as const,
    origin: "fallback" as const,
    caveat: "Relevance uses a conservative path/command fallback.",
  };
  if (
    descriptor.opaque ||
    descriptor.family === "other" ||
    editedPaths.length === 0
  ) {
    return { ...base, relevant: null, matchedPaths: [] };
  }
  if (
    descriptor.scope === "targeted" &&
    descriptor.pathTargets.length === 0
  ) {
    return { ...base, relevant: null, matchedPaths: [] };
  }
  if (descriptor.pathTargets.length > 0) {
    const matchedPaths = editedPaths.filter((edited) =>
      descriptor.pathTargets.some((target) => pathsDirectlyRelated(edited, target))
    );
    return {
      ...base,
      relevant: matchedPaths.length > 0,
      matchedPaths,
    };
  }
  const matchedPaths = editedPaths.filter((path) =>
    /\.(?:[cm]?[jt]sx?|rs|py|rb|go|java|kt|swift|c|cc|cpp|h|hpp)$/iu.test(path)
  );
  return {
    ...base,
    relevant: matchedPaths.length > 0,
    matchedPaths,
  };
}

function pathsDirectlyRelated(left: string, right: string): boolean {
  if (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  ) {
    return true;
  }
  return pathStem(left) === pathStem(right);
}

function pathStem(path: string): string {
  const basename = path.split("/").at(-1)?.toLowerCase() ?? "";
  return basename
    .replace(/\.[^.]+$/u, "")
    .replace(/\.(?:test|spec)$/u, "")
    .replace(/^(?:test_|test-)/u, "");
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
