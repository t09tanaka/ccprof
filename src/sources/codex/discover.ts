import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { Session, SourceWarning } from "../../core/model.js";
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
import { parseCodexSession } from "./parser.js";

export interface CodexDiscoverOptions {
  sessionsDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

const ROLLOUT_FILE_PATTERN = /^rollout-.*\.jsonl$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

function intersects(session: Session, query: SessionQuery): boolean {
  return (
    session.started_at_ms <= query.endedAtMs &&
    session.ended_at_ms >= query.startedAtMs
  );
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

function missingBranchWarning(session: Session): SourceWarning {
  const firstEvent = session.events[0];
  return {
    code: "codex_branch_missing",
    message:
      "Matched by canonical cwd because the rollout has no git branch metadata.",
    source_path: session.source_path,
    ...(firstEvent !== undefined
      ? { session_ref: firstEvent.session_ref }
      : {}),
  };
}

/** Recursively collects `rollout-*.jsonl` files anywhere under `directory`. */
async function findRolloutFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findRolloutFiles(path)));
    } else if (entry.isFile() && ROLLOUT_FILE_PATTERN.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Reads the `YYYY/MM/DD` the rollout file lives under, relative to the
 * sessions root, as a UTC midnight timestamp. Returns undefined when the
 * file does not sit exactly three directory levels below the root (an
 * unexpected layout), in which case the caller reads the file rather than
 * risk dropping a session it cannot date.
 */
function directoryDateMs(root: string, filePath: string): number | undefined {
  const segments = relative(root, filePath).split(sep);
  if (segments.length !== 4) {
    return undefined;
  }
  const [year, month, day] = segments;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !/^\d{4}$/u.test(year) ||
    !/^\d{2}$/u.test(month) ||
    !/^\d{2}$/u.test(day)
  ) {
    return undefined;
  }
  const parsed = Date.parse(`${year}-${month}-${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function withinDiscoveryWindow(
  root: string,
  filePath: string,
  query: SessionQuery,
): boolean {
  const dateMs = directoryDateMs(root, filePath);
  if (dateMs === undefined) {
    return true;
  }
  return (
    dateMs >= query.startedAtMs - DAY_MS && dateMs <= query.endedAtMs + DAY_MS
  );
}

export async function discoverCodexSessions(
  sessionsDirectory: string,
  query: SessionQuery,
): Promise<Session[]> {
  let root: string;
  try {
    root = await realpath(sessionsDirectory);
  } catch {
    return [];
  }

  const files = (await findRolloutFiles(root)).sort((left, right) =>
    left.localeCompare(right)
  );
  const repoRoot = await canonicalPath(query.repoRoot);
  const globalWarnings: SourceWarning[] = [];
  const sessions: Session[] = [];

  for (const file of files) {
    if (!withinDiscoveryWindow(root, file, query)) {
      continue;
    }
    let parsed: Session | null;
    try {
      parsed = await parseCodexSession({
        sourcePath: file,
        endedAtMs: query.endedAtMs,
      });
    } catch {
      globalWarnings.push(
        sourceWarning(
          "codex_source_read_error",
          "Could not read a Codex rollout transcript.",
          file,
        ),
      );
      continue;
    }
    if (parsed === null) {
      continue;
    }
    const canonicalSession = await canonicalizeSessionCwds(parsed);
    if (!intersects(canonicalSession, query)) {
      continue;
    }
    if (
      !(await cwdMatchesRepository(
        repoRoot,
        canonicalSession.observed_cwds,
      ))
    ) {
      continue;
    }
    const session = await alignSessionCwdsToRepository(
      canonicalSession,
      repoRoot,
    );

    const branch = session.observed_branches[0];
    if (branch === undefined) {
      sessions.push({
        ...session,
        confidence: "low",
        warnings: [...session.warnings, missingBranchWarning(session)],
      });
      continue;
    }
    if (branch !== query.headBranch) {
      continue;
    }
    sessions.push(session);
  }

  if (globalWarnings.length === 0) {
    return sessions;
  }
  return sessions.map((session) => ({
    ...session,
    warnings: [...session.warnings, ...globalWarnings],
  }));
}

export class CodexSessionSource implements SessionSource {
  readonly #sessionsDirectory: string | undefined;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options?: CodexDiscoverOptions) {
    this.#sessionsDirectory = options?.sessionsDirectory;
    this.#env = options?.env ?? process.env;
  }

  async discover(query: SessionQuery): Promise<Session[]> {
    const sessionsDirectory =
      this.#sessionsDirectory ??
      this.#env.CCPROF_CODEX_SESSIONS_DIR ??
      join(homedir(), ".codex", "sessions");
    return discoverCodexSessions(sessionsDirectory, query);
  }
}
