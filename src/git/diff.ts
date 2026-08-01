import {
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./client.js";

export interface NameStatus {
  status: string;
  path: string;
  oldPath?: string;
}

export interface FileDiffEvidence extends NameStatus {
  addedLines: string[];
  binary: boolean;
  contentComplete: boolean;
}

export interface RenameEvidence {
  kind: "rename" | "copy";
  from: string;
  to: string;
  similarity: number | null;
}

export interface CommitEvidence {
  oid: string;
  timestampMs: number;
  subject: string;
  body: string;
  paths: string[];
  changes: NameStatus[];
}

export interface RevertEvidence {
  commitOid: string;
  revertedCommitOid: string;
  subject: string;
  paths: string[];
}

export interface CommitLogEvidence {
  commits: CommitEvidence[];
  reverts: RevertEvidence[];
}

export interface DiffEvidence extends CommitLogEvidence {
  files: FileDiffEvidence[];
  changedPaths: string[];
  survivingPaths: string[];
  renames: RenameEvidence[];
  truncated: boolean;
  caveats: string[];
}

export interface CollectDiffOptions {
  cwd: string;
  baseOid: string;
  headOid: string;
  runner?: CommandRunner;
}

export class GitDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDiffError";
  }
}

const STATUS_PATTERN = /^(?:[AMDTUXB]|[RC]\d{1,3})$/;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function readChange(tokens: readonly string[], index: number): {
  change: NameStatus;
  next: number;
} {
  const status = tokens[index]?.replace(/^\n+/, "");
  if (status === undefined || !STATUS_PATTERN.test(status)) {
    throw new GitDiffError(`invalid name-status record: ${JSON.stringify(tokens[index])}`);
  }
  const paired = status[0] === "R" || status[0] === "C";
  const first = tokens[index + 1];
  const second = paired ? tokens[index + 2] : undefined;
  if (first === undefined || first === "" || (paired && (second === undefined || second === ""))) {
    throw new GitDiffError(`incomplete ${status} name-status record`);
  }
  return paired
    ? {
        change: { status, oldPath: first, path: second as string },
        next: index + 3,
      }
    : { change: { status, path: first }, next: index + 2 };
}

export function parseNameStatus(stdout: string): NameStatus[] {
  const tokens = stdout.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes: NameStatus[] = [];
  for (let index = 0; index < tokens.length; ) {
    const parsed = readChange(tokens, index);
    changes.push(parsed.change);
    index = parsed.next;
  }
  return changes;
}

export function parseCommitLog(stdout: string): CommitLogEvidence {
  const tokens = stdout.split("\0");
  const commits: CommitEvidence[] = [];
  const reverts: RevertEvidence[] = [];
  let index = 0;
  while (index < tokens.length) {
    while (tokens[index] === "" || tokens[index] === "\n") index += 1;
    if (index >= tokens.length) break;
    const oid = tokens[index]?.replace(/^\n+/, "") ?? "";
    const secondsText = tokens[index + 1];
    const subject = tokens[index + 2];
    const body = tokens[index + 3];
    if (
      !OID_PATTERN.test(oid) ||
      secondsText === undefined ||
      !/^\d+$/.test(secondsText) ||
      subject === undefined ||
      body === undefined
    ) {
      throw new GitDiffError(`invalid commit-log header at token ${index}`);
    }
    const timestampMs = Number(secondsText) * 1_000;
    if (!Number.isSafeInteger(timestampMs)) {
      throw new GitDiffError(`invalid commit timestamp: ${secondsText}`);
    }
    index += 4;
    const changes: NameStatus[] = [];
    while (index < tokens.length) {
      while (tokens[index] === "" || tokens[index] === "\n") index += 1;
      if (index >= tokens.length) break;
      const possibleOid = tokens[index]?.replace(/^\n+/, "") ?? "";
      if (
        OID_PATTERN.test(possibleOid) &&
        /^\d+$/.test(tokens[index + 1] ?? "")
      ) {
        break;
      }
      const parsed = readChange(tokens, index);
      changes.push(parsed.change);
      index = parsed.next;
    }
    const paths = uniquePaths(changes.flatMap((change) =>
      change.oldPath === undefined ? [change.path] : [change.oldPath, change.path]
    ));
    const commit = { oid: oid.toLowerCase(), timestampMs, subject, body, paths, changes };
    commits.push(commit);
    const trailer = /^This reverts commit ([0-9a-f]{40}|[0-9a-f]{64})\.\s*$/im.exec(body);
    if (/^Revert ".+"$/.test(subject) && trailer !== null) {
      reverts.push({
        commitOid: commit.oid,
        revertedCommitOid: trailer[1]?.toLowerCase() ?? "",
        subject,
        paths,
      });
    }
  }
  return { commits, reverts };
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function patchSections(stdout: string): string[] {
  const starts = [...stdout.matchAll(/^diff --git /gm)].map(
    (match) => match.index ?? 0,
  );
  return starts.map((start, index) =>
    stdout.slice(start, starts[index + 1] ?? stdout.length)
  );
}

function parsePatchSection(section: string | undefined): {
  addedLines: string[];
  binary: boolean;
} {
  if (section === undefined) return { addedLines: [], binary: false };
  const binary = /^(?:GIT binary patch|Binary files .* differ)$/m.test(section);
  const addedLines: string[] = [];
  let inHunk = false;
  for (const line of section.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      addedLines.push(line.slice(1));
    }
  }
  return { addedLines, binary };
}

function requireSuccess(args: readonly string[], result: CommandResult): void {
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new GitDiffError(
      `git ${args.join(" ")} failed with exit ${result.code}${detail === "" ? "" : `: ${detail}`}`,
    );
  }
}

export async function collectDiffEvidence(
  options: CollectDiffOptions,
): Promise<DiffEvidence> {
  if (!OID_PATTERN.test(options.baseOid) || !OID_PATTERN.test(options.headOid)) {
    throw new GitDiffError("diff endpoints must be frozen commit OIDs");
  }
  const runner = options.runner ?? runCommand;
  const triple = `${options.baseOid}...${options.headOid}`;
  const double = `${options.baseOid}..${options.headOid}`;
  const patchArgs = [
    "--no-pager",
    "diff",
    "--find-renames",
    "--binary",
    "--patch",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--end-of-options",
    triple,
    "--",
  ];
  const statusArgs = [
    "--no-pager",
    "diff",
    "--find-renames",
    "--name-status",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--end-of-options",
    triple,
    "--",
  ];
  const logArgs = [
    "--no-pager",
    "log",
    "--no-show-signature",
    "--format=%H%x00%ct%x00%s%x00%B%x00",
    "--name-status",
    "--find-renames",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--end-of-options",
    double,
    "--",
  ];
  const [patchResult, statusResult, logResult] = await Promise.all([
    runner("git", patchArgs, { cwd: options.cwd }),
    runner("git", statusArgs, { cwd: options.cwd }),
    runner("git", logArgs, { cwd: options.cwd }),
  ]);
  requireSuccess(patchArgs, patchResult);
  requireSuccess(statusArgs, statusResult);
  requireSuccess(logArgs, logResult);
  if (statusResult.stdoutTruncated === true) {
    throw new GitDiffError("authoritative name-status output was truncated");
  }

  const changes = parseNameStatus(statusResult.stdout);
  const sections = patchSections(patchResult.stdout);
  const patchTruncated = patchResult.stdoutTruncated === true;
  const logTruncated = logResult.stdoutTruncated === true;
  const truncated = patchTruncated || logTruncated;
  const caveats: string[] = [];
  if (patchTruncated) caveats.push("Git diff output was truncated.");
  if (logTruncated) {
    caveats.push("Git commit-log output was truncated; commit evidence is unavailable.");
  }
  const patchPairingComplete = sections.length === changes.length;
  if (!patchPairingComplete) {
    caveats.push("Patch sections could not be paired completely with name-status records.");
  }
  const files = changes.map((change, index): FileDiffEvidence => {
    const section = patchPairingComplete ? sections[index] : undefined;
    const content = parsePatchSection(section);
    return {
      ...change,
      ...content,
      contentComplete:
        patchPairingComplete && !truncated && !content.binary && section !== undefined,
    };
  });
  const binaryPaths = files.filter((file) => file.binary).map((file) => file.path);
  if (binaryPaths.length > 0) {
    caveats.push(`Binary content is unavailable for: ${binaryPaths.join(", ")}`);
  }

  const changedPaths = uniquePaths(changes.flatMap((change) =>
    change.oldPath === undefined ? [change.path] : [change.oldPath, change.path]
  ));
  const survivingPaths = uniquePaths(changes.flatMap((change) => {
    if (change.status === "D") return [];
    if (change.status.startsWith("C") && change.oldPath !== undefined) {
      return [change.oldPath, change.path];
    }
    return [change.path];
  }));
  const renames = changes.flatMap((change): RenameEvidence[] => {
    const kind = change.status[0];
    if ((kind !== "R" && kind !== "C") || change.oldPath === undefined) return [];
    const similarityText = change.status.slice(1);
    return [{
      kind: kind === "R" ? "rename" : "copy",
      from: change.oldPath,
      to: change.path,
      similarity: /^\d+$/.test(similarityText) ? Number(similarityText) : null,
    }];
  });
  const log: CommitLogEvidence = logTruncated
    ? { commits: [], reverts: [] }
    : parseCommitLog(logResult.stdout);
  return {
    files,
    changedPaths,
    survivingPaths,
    renames,
    truncated,
    caveats,
    ...log,
  };
}
