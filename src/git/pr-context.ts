import {
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./client.js";

export const GH_PR_FIELDS =
  "number,url,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository,createdAt";

const GH_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
} as const;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface FrozenRef {
  label: string;
  oid: string;
}

export interface PrContext {
  repoRoot: string;
  base: FrozenRef;
  head: FrozenRef;
  mergeBaseOid: string;
  prRef: string;
  headBranch: string;
  number?: number;
  url?: string;
  isCrossRepository?: boolean;
  createdAtMs?: number;
  earliestUniqueCommitAtMs?: number;
  resolvedAtMs: number;
  warnings: string[];
}

export interface ResolvePrContextOptions {
  cwd: string;
  input?: string;
  runner?: CommandRunner;
  nowMs?: number;
}

export interface ExplicitRange {
  baseRef: string;
  headRef: string;
  baseLabel: string;
  headLabel: string;
  prRef: string;
}

export interface GhPrMetadata {
  number: number;
  url: string;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  createdAt: string;
}

export class GitContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitContextError";
  }
}

function canonicalLabel(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/tags\//, "");
}

export function parseExplicitRange(input: string): ExplicitRange | null {
  const separators = [...input.matchAll(/\.{2,}/g)];
  const separator = separators[0];
  if (
    separator === undefined ||
    separators.length !== 1 ||
    (separator[0] !== ".." && separator[0] !== "...")
  ) {
    return null;
  }
  const index = separator.index ?? -1;
  const baseRef = input.slice(0, index);
  const headRef = input.slice(index + separator[0].length);
  if (baseRef.length === 0 || headRef.length === 0) return null;
  const baseLabel = canonicalLabel(baseRef);
  const headLabel = canonicalLabel(headRef);
  return {
    baseRef,
    headRef,
    baseLabel,
    headLabel,
    prRef: `${baseLabel}...${headLabel}`,
  };
}

function commandFailure(command: string, args: readonly string[], result: CommandResult): GitContextError {
  const detail = result.stderr.trim();
  return new GitContextError(
    `${command} ${args.join(" ")} failed with exit ${result.code}${detail === "" ? "" : `: ${detail}`}`,
  );
}

async function git(
  runner: CommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<CommandResult> {
  return await runner("git", args, { cwd });
}

function parseOid(stdout: string, description: string): string {
  const oid = stdout.trim();
  if (!OID_PATTERN.test(oid)) {
    throw new GitContextError(`git returned an invalid ${description}: ${JSON.stringify(oid)}`);
  }
  return oid.toLowerCase();
}

async function freezeRef(
  runner: CommandRunner,
  cwd: string,
  ref: string,
): Promise<string> {
  const args = [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${ref}^{commit}`,
  ];
  const result = await git(runner, cwd, args);
  if (result.code !== 0) throw commandFailure("git", args, result);
  return parseOid(result.stdout, `commit for ${ref}`);
}

export function parseGhMetadata(stdout: string): GhPrMetadata {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new GitContextError("gh pr view returned invalid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new GitContextError("gh pr view returned invalid metadata");
  }
  const record = value as Record<string, unknown>;
  const stringFields = [
    "url",
    "baseRefName",
    "baseRefOid",
    "headRefName",
    "headRefOid",
    "createdAt",
  ] as const;
  if (
    !Number.isSafeInteger(record.number) ||
    (record.number as number) <= 0 ||
    typeof record.isCrossRepository !== "boolean" ||
    !OID_PATTERN.test(typeof record.baseRefOid === "string" ? record.baseRefOid : "") ||
    !OID_PATTERN.test(typeof record.headRefOid === "string" ? record.headRefOid : "") ||
    stringFields.some(
      (field) => typeof record[field] !== "string" || record[field].length === 0,
    )
  ) {
    throw new GitContextError("gh pr view returned incomplete metadata");
  }
  return value as unknown as GhPrMetadata;
}

function isPrSelector(input: string): boolean {
  return /^[1-9]\d*$/.test(input) || /^https?:\/\/\S+\/pull\/\d+(?:[/?#].*)?$/.test(input);
}

async function readGh(
  runner: CommandRunner,
  cwd: string,
  selector?: string,
): Promise<{ result: CommandResult; metadata?: GhPrMetadata }> {
  const args = [
    "pr",
    "view",
    ...(selector === undefined ? [] : [selector]),
    "--json",
    GH_PR_FIELDS,
  ];
  const result = await runner("gh", args, { cwd, env: GH_ENV });
  if (result.code !== 0) return { result };
  return { result, metadata: parseGhMetadata(result.stdout) };
}

async function earliestUniqueCommit(
  runner: CommandRunner,
  cwd: string,
  baseOid: string,
  headOid: string,
  warnings: string[],
): Promise<number | undefined> {
  const args = ["rev-list", "--timestamp", `${baseOid}..${headOid}`];
  const result = await git(runner, cwd, args);
  if (result.code !== 0) throw commandFailure("git", args, result);
  if (result.stdoutTruncated === true) {
    warnings.push("git rev-list output was truncated; earliest commit time is unavailable");
    return undefined;
  }
  let earliest: number | undefined;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = /^(\d+) ([0-9a-f]{40}|[0-9a-f]{64})$/i.exec(line);
    const milliseconds = match === null ? Number.NaN : Number(match[1]) * 1_000;
    if (!Number.isSafeInteger(milliseconds)) {
      warnings.push(`ignored malformed git rev-list row: ${JSON.stringify(line)}`);
    } else {
      earliest = earliest === undefined ? milliseconds : Math.min(earliest, milliseconds);
    }
  }
  return earliest;
}

interface Resolution {
  baseRef: string;
  headRef: string;
  baseLabel: string;
  headLabel: string;
  number?: number;
  url?: string;
  isCrossRepository?: boolean;
  createdAt?: string;
  frozenBaseOid?: string;
}

export async function resolvePrContext(
  options: ResolvePrContextOptions,
): Promise<PrContext> {
  const runner = options.runner ?? runCommand;
  const rootArgs = ["rev-parse", "--show-toplevel"];
  const rootResult = await git(runner, options.cwd, rootArgs);
  if (rootResult.code !== 0) throw commandFailure("git", rootArgs, rootResult);
  const repoRoot = rootResult.stdout.trim();
  if (repoRoot.length === 0) throw new GitContextError("git returned an empty repository root");

  const warnings: string[] = [];
  const explicit = options.input === undefined ? null : parseExplicitRange(options.input);
  let resolution: Resolution;
  if (explicit !== null) {
    resolution = {
      baseRef: explicit.baseRef,
      headRef: explicit.headRef,
      baseLabel: explicit.baseLabel,
      headLabel: explicit.headLabel,
    };
  } else if (options.input !== undefined) {
    if (!isPrSelector(options.input)) {
      throw new GitContextError(`invalid PR selector: ${options.input}`);
    }
    const gh = await readGh(runner, repoRoot, options.input);
    if (gh.result.code !== 0 || gh.metadata === undefined) {
      throw commandFailure("gh", ["pr", "view", options.input], gh.result);
    }
    resolution = {
      baseRef: gh.metadata.baseRefOid,
      headRef: gh.metadata.headRefOid,
      baseLabel: gh.metadata.baseRefName,
      headLabel: gh.metadata.headRefName,
      number: gh.metadata.number,
      url: gh.metadata.url,
      isCrossRepository: gh.metadata.isCrossRepository,
      createdAt: gh.metadata.createdAt,
    };
  } else {
    let gh: Awaited<ReturnType<typeof readGh>> | undefined;
    try {
      gh = await readGh(runner, repoRoot);
    } catch (error) {
      warnings.push(`gh pr view unavailable: ${(error as Error).message}`);
    }
    if (gh?.metadata !== undefined) {
      resolution = {
        baseRef: gh.metadata.baseRefOid,
        headRef: gh.metadata.headRefOid,
        baseLabel: gh.metadata.baseRefName,
        headLabel: gh.metadata.headRefName,
        number: gh.metadata.number,
        url: gh.metadata.url,
        isCrossRepository: gh.metadata.isCrossRepository,
        createdAt: gh.metadata.createdAt,
      };
    } else {
      if (gh !== undefined) warnings.push(`gh pr view unavailable (exit ${gh.result.code})`);
      const remote = await git(runner, repoRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      const branch = await git(runner, repoRoot, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      const candidates = [
        ...(remote.code === 0 && remote.stdout.trim() !== "" ? [remote.stdout.trim()] : []),
        "main",
        "master",
      ];
      let baseRef: string | undefined;
      let frozenBaseOid: string | undefined;
      for (const candidate of [...new Set(candidates)]) {
        try {
          frozenBaseOid = await freezeRef(runner, repoRoot, candidate);
          baseRef = candidate;
          break;
        } catch {
          // Try the next entirely local candidate; resolution never fetches.
        }
      }
      if (baseRef === undefined) throw new GitContextError("could not resolve a local default branch");
      const headLabel = branch.code === 0 && branch.stdout.trim() !== ""
        ? branch.stdout.trim()
        : "HEAD";
      resolution = {
        baseRef,
        headRef: "HEAD",
        baseLabel: canonicalLabel(baseRef),
        headLabel: canonicalLabel(headLabel),
        ...(frozenBaseOid === undefined ? {} : { frozenBaseOid }),
      };
    }
  }

  const baseOid =
    resolution.frozenBaseOid ??
    (await freezeRef(runner, repoRoot, resolution.baseRef));
  const headOid = await freezeRef(runner, repoRoot, resolution.headRef);
  const mergeArgs = ["merge-base", baseOid, headOid];
  const mergeResult = await git(runner, repoRoot, mergeArgs);
  if (mergeResult.code !== 0) throw commandFailure("git", mergeArgs, mergeResult);
  const mergeBaseOid = parseOid(mergeResult.stdout, "merge base");
  const earliestUniqueCommitAtMs = await earliestUniqueCommit(
    runner,
    repoRoot,
    baseOid,
    headOid,
    warnings,
  );
  const createdAtMs =
    resolution.createdAt === undefined ? undefined : Date.parse(resolution.createdAt);
  if (createdAtMs !== undefined && !Number.isSafeInteger(createdAtMs)) {
    warnings.push(`ignored invalid PR creation time: ${JSON.stringify(resolution.createdAt)}`);
  }
  const resolvedAtMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(resolvedAtMs)) {
    throw new GitContextError("resolvedAtMs must be a safe integer");
  }

  return {
    repoRoot,
    base: { label: resolution.baseLabel, oid: baseOid },
    head: { label: resolution.headLabel, oid: headOid },
    mergeBaseOid,
    prRef: `${resolution.baseLabel}...${resolution.headLabel}`,
    headBranch: resolution.headLabel,
    ...(resolution.number === undefined ? {} : { number: resolution.number }),
    ...(resolution.url === undefined ? {} : { url: resolution.url }),
    ...(resolution.isCrossRepository === undefined
      ? {}
      : { isCrossRepository: resolution.isCrossRepository }),
    ...(createdAtMs === undefined || !Number.isSafeInteger(createdAtMs)
      ? {}
      : { createdAtMs }),
    ...(earliestUniqueCommitAtMs === undefined ? {} : { earliestUniqueCommitAtMs }),
    resolvedAtMs,
    warnings,
  };
}
