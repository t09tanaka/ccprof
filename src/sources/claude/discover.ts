import { lstat, readdir, realpath } from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { Confidence, Session, SourceWarning } from "../../core/model.js";
import { canonicalPath } from "../../git/common-dir.js";
import {
  alignSessionCwdsToRepository,
  canonicalizeSessionCwds,
  cwdMatchesRepository,
} from "../cwd.js";
import type {
  SessionQuery,
  SessionSource,
} from "../session-source.js";
import { admitSessionEventPrefix } from "../session-source.js";
import {
  parseClaudeTranscriptDetailed,
  type ClaudeTranscriptParseResult,
} from "./parser.js";

export class ClaudeDiscoveryError extends Error {
  readonly warnings: SourceWarning[];

  constructor(warnings: SourceWarning[]) {
    super("Claude session discovery failed for one or more sources.");
    this.name = "ClaudeDiscoveryError";
    this.warnings = warnings;
  }
}

function sourceWarning(
  code: string,
  message: string,
  sourcePath: string,
): SourceWarning {
  return {
    code,
    message,
    source_path: resolve(sourcePath),
  };
}

async function findJsonlFiles(
  directory: string,
  projectsRoot: string,
  warnings: SourceWarning[],
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    warnings.push(
      sourceWarning(
        "source_read_error",
        "Could not read a Claude projects directory.",
        directory,
      ),
    );
    return [];
  }

  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findJsonlFiles(path, projectsRoot, warnings)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(await canonicalPath(path));
    } else if (entry.isSymbolicLink() && entry.name.endsWith(".jsonl")) {
      let target: string;
      try {
        target = await realpath(path);
      } catch {
        warnings.push(
          sourceWarning(
            "source_read_error",
            "Could not resolve a Claude JSONL symlink.",
            path,
          ),
        );
        continue;
      }
      if (!isWithin(projectsRoot, target)) {
        warnings.push(
          sourceWarning(
            "source_symlink_escape",
            "Skipped a Claude JSONL symlink outside the configured projects directory.",
            path,
          ),
        );
        continue;
      }
      try {
        if (!(await lstat(target)).isFile()) {
          warnings.push(
            sourceWarning(
              "source_read_error",
              "Claude JSONL symlink target is not a regular file.",
              path,
            ),
          );
          continue;
        }
      } catch {
        warnings.push(
          sourceWarning(
            "source_read_error",
            "Could not inspect a Claude JSONL symlink target.",
            path,
          ),
        );
        continue;
      }
      files.push(target);
    }
  }
  return files;
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
}

function intersects(session: Session, query: SessionQuery): boolean {
  return (
    session.started_at_ms <= query.endedAtMs &&
    session.ended_at_ms >= query.startedAtMs
  );
}

function lowerConfidence(confidence: Confidence): Confidence {
  return confidence === "high" ? "medium" : "low";
}

function branchScopedWarning(session: Session): SourceWarning {
  const firstEvent = session.events[0];
  return {
    code: "branch_scoped",
    message: "Multi-branch session was scoped to the head branch.",
    source_path: session.source_path,
    ...(firstEvent !== undefined
      ? { session_ref: firstEvent.session_ref }
      : {}),
  };
}

/**
 * Restricts a session that observed several branches to the events recorded
 * on the queried head branch (the parser already stamps every event with its
 * effective branch). Contiguous head-branch runs become separate segment
 * sessions so the timeline never bridges the removed other-branch spans into
 * inference or human-wait time. Sessions whose events carry no branch
 * metadata at all are kept unchanged, conservatively.
 */
function scopeSessionToHeadBranch(
  session: Session,
  headBranch: string,
): Session[] {
  if (session.events.some((event) => event.branch === undefined)) {
    return [session];
  }
  const byAgent = new Map<string, Session["events"]>();
  for (const event of session.events) {
    const group = byAgent.get(event.agent_id);
    if (group === undefined) byAgent.set(event.agent_id, [event]);
    else group.push(event);
  }

  const runs: { agentId: string; run: number; events: Session["events"] }[] =
    [];
  for (const [agentId, agentEvents] of byAgent) {
    let current: Session["events"] = [];
    let currentEpoch: number | undefined;
    let run = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      runs.push({ agentId, run, events: current });
      run += 1;
      current = [];
    };
    for (const event of agentEvents) {
      if (event.branch === headBranch) {
        // Within one agent lane, an epoch change between two head-branch
        // events proves a departure recorded only on rows without events.
        if (current.length > 0 && event.branch_epoch !== currentEpoch) {
          flush();
        }
        currentEpoch = event.branch_epoch;
        current.push(event);
      } else {
        flush();
        currentEpoch = undefined;
      }
    }
    flush();
  }
  if (runs.length === 0) return [];
  const includedCount = runs.reduce(
    (total, entry) => total + entry.events.length,
    0,
  );
  if (
    includedCount === session.events.length &&
    runs.length === byAgent.size
  ) {
    return [session];
  }
  return runs.map(({ agentId, run, events }, index) => {
    const timestamps = events.map((event) => event.timestamp_ms);
    const segment: Session = {
      ...session,
      // The timeline builds per-(source_path, session_id, agent_id) interval
      // lanes, so segments need distinct source identities to stay disjoint
      // while other agents' unbroken runs remain whole.
      source_path: `${session.source_path}#branch-segment-${agentId}-${run.toString(10)}`,
      events: [...events],
      started_at_ms: Math.min(...timestamps),
      ended_at_ms: Math.max(...timestamps),
      warnings: [...session.warnings],
    };
    return index === 0
      ? {
          ...segment,
          warnings: [...segment.warnings, branchScopedWarning(session)],
        }
      : segment;
  });
}

function missingBranchWarning(session: Session): SourceWarning {
  const firstEvent = session.events[0];
  return {
    code: "branch_missing",
    message:
      "Matched by canonical cwd and time because the transcript has no branch metadata.",
    source_path: session.source_path,
    ...(firstEvent !== undefined
      ? { session_ref: firstEvent.session_ref }
      : {}),
  };
}

async function canonicalizeSession(session: Session): Promise<Session> {
  const [canonicalSession, sourcePath] = await Promise.all([
    canonicalizeSessionCwds(session),
    canonicalPath(session.source_path),
  ]);
  return {
    ...canonicalSession,
    source_path: sourcePath,
    warnings: canonicalSession.warnings.map((warning) => ({
      ...warning,
      source_path: sourcePath,
    })),
  };
}

export async function discoverClaudeSessions(
  projectsDirectory: string,
  query: SessionQuery,
): Promise<Session[]> {
  const sourceFailures: SourceWarning[] = [];
  const globalSourceWarnings: SourceWarning[] = [];
  let projectsRoot: string;
  try {
    projectsRoot = await realpath(projectsDirectory);
  } catch {
    throw new ClaudeDiscoveryError([
      sourceWarning(
        "source_read_error",
        "Could not resolve the configured Claude projects directory.",
        projectsDirectory,
      ),
    ]);
  }
  const repoRoot = await canonicalPath(query.repoRoot);
  const files = await findJsonlFiles(
    projectsRoot,
    projectsRoot,
    globalSourceWarnings,
  );
  sourceFailures.push(...globalSourceWarnings);
  const sessions: Session[] = [];
  const seen = new Set<string>();
  const parsedPaths = new Set<string>();

  for (const file of files) {
    if (query.analysisBudgetMeter?.stopped === true) break;
    if (parsedPaths.has(file)) {
      continue;
    }
    parsedPaths.add(file);
    // A transcript's mtime is at or after its last event, so a file last
    // written before the query window opened cannot intersect it. Skipping
    // those files avoids parsing every historical transcript on each run.
    let fileSize: number | undefined;
    try {
      const status = await lstat(file);
      if (status.mtimeMs < query.startedAtMs) {
        continue;
      }
      fileSize = status.size;
    } catch {
      if (query.analysisBudgetMeter !== undefined) {
        query.analysisBudgetMeter.recordSourceFailure();
        break;
      }
      // Fall through to the parse path, which reports unreadable files.
    }
    let admittedFileBytes: number | undefined;
    if (query.analysisBudgetMeter !== undefined) {
      if (!query.analysisBudgetMeter.admitSourceItem()) break;
      if (
        fileSize === undefined ||
        !Number.isSafeInteger(fileSize) ||
        fileSize < 0
      ) {
        query.analysisBudgetMeter.recordSourceFailure();
        break;
      }
      admittedFileBytes = query.analysisBudgetMeter.admitInputBytes(fileSize);
      if (admittedFileBytes === 0 && fileSize > 0) break;
    }
    let parsed: ClaudeTranscriptParseResult;
    try {
      parsed = await parseClaudeTranscriptDetailed(file, {
        endedAtMs: query.endedAtMs,
        ...(admittedFileBytes === undefined
          ? {}
          : { budgets: { maxFileBytes: admittedFileBytes } }),
      });
    } catch {
      const readWarning = sourceWarning(
        "source_read_error",
        "Could not read a Claude JSONL transcript.",
        file,
      );
      sourceFailures.push(readWarning);
      globalSourceWarnings.push(readWarning);
      query.analysisBudgetMeter?.recordSourceFailure();
      if (query.analysisBudgetMeter !== undefined) break;
      continue;
    }
    if (parsed.sessions.length === 0 && parsed.warnings.length > 0) {
      sourceFailures.push(...parsed.warnings);
      query.analysisBudgetMeter?.recordSourceFailure();
      globalSourceWarnings.push(
        sourceWarning(
          "source_parse_error",
          `Skipped a Claude transcript that produced ${parsed.warnings.length.toString(10)} parse warning(s) and no session.`,
          file,
        ),
      );
    }
    const parsedSessions = query.analysisBudgetMeter === undefined
      ? parsed.sessions
      : admitSessionEventPrefix(parsed.sessions, query.analysisBudgetMeter);
    for (const rawSession of parsedSessions) {
      const session = await canonicalizeSession(rawSession);
      if (!intersects(session, query)) {
        continue;
      }
      if (
        !(await cwdMatchesRepository(repoRoot, session.observed_cwds))
      ) {
        continue;
      }

      const hasBranch = session.observed_branches.length > 0;
      if (
        hasBranch &&
        !session.observed_branches.includes(query.headBranch)
      ) {
        continue;
      }
      let segments: Session[] = [session];
      if (
        hasBranch &&
        session.observed_branches.some(
          (branch) => branch !== query.headBranch,
        )
      ) {
        segments = scopeSessionToHeadBranch(session, query.headBranch)
          .filter((segment) => intersects(segment, query));
        if (segments.length === 0) {
          continue;
        }
      }
      for (const [segmentIndex, segment] of segments.entries()) {
        const key = [
          session.session_id,
          session.source_path,
          segmentIndex.toString(10),
        ].join("\u0000");
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const alignedSession = await alignSessionCwdsToRepository(
          segment,
          repoRoot,
        );
        if (hasBranch) {
          sessions.push(alignedSession);
        } else {
          sessions.push({
            ...alignedSession,
            confidence: lowerConfidence(alignedSession.confidence),
            warnings: [
              ...alignedSession.warnings,
              missingBranchWarning(alignedSession),
            ],
          });
        }
      }
    }
  }
  if (sessions.length === 0 && sourceFailures.length > 0) {
    throw new ClaudeDiscoveryError(sourceFailures);
  }
  if (globalSourceWarnings.length === 0) {
    return sessions;
  }
  return sessions.map((session) => ({
    ...session,
    warnings: [...session.warnings, ...globalSourceWarnings],
  }));
}

export class ClaudeSessionSource implements SessionSource {
  readonly budgetCooperative = true;
  readonly #projectsDirectory: string;

  constructor(projectsDirectory: string) {
    this.#projectsDirectory = projectsDirectory;
  }

  async discover(query: SessionQuery): Promise<Session[]> {
    return discoverClaudeSessions(this.#projectsDirectory, query);
  }
}
