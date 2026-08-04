import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { AnalysisBudgetMeter } from "../../analysis/budgets.js";
import type { Session, SourceWarning } from "../../core/model.js";
import { canonicalPath } from "../../git/common-dir.js";
import {
  alignSessionCwdsToRepository,
  canonicalizeSessionCwds,
  cwdMatchesRepository,
} from "../cwd.js";
import {
  CODEX_SESSION_SOURCE_CONTRACT,
  admitSessionEventPrefix,
  type SessionQuery,
  type SessionSource,
} from "../session-source.js";
import { ParserBudgetExceededError } from "../jsonl-budget.js";
import { CODEX_PARSER_VERSION, PARSER_STATE_SCHEMA_FINGERPRINT,
  parseCodexSession, parseCodexSessionObserved, projectCodexParserState,
  readCodexParserState } from "./parser.js";
import type { ExactSourceEvidenceCache } from "../exact-source-evidence-cache.js";
import { createBuiltInSourceCoverageAccumulator, unavailableSourceCoverage,
  type BuiltInSourceCoverageAccumulator } from "../source-coverage.js";

export interface CodexDiscoverOptions {
  sessionsDirectory?: string;
  env?: NodeJS.ProcessEnv;
}

const ROLLOUT_FILE_PATTERN = /^rollout-.*\.jsonl$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
async function findRolloutFiles(directory: string,
  failed?: () => void): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    failed?.();
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findRolloutFiles(path, failed)));
    } else if (entry.isFile() && ROLLOUT_FILE_PATTERN.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

async function* findRolloutFilesBudgeted(
  directory: string,
  warnings: SourceWarning[],
  meter: AnalysisBudgetMeter,
): AsyncGenerator<string> {
  if (!meter.checkpoint()) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    warnings.push(
      sourceWarning(
        "codex_source_read_error",
        "Could not read a Codex sessions directory.",
        directory,
      ),
    );
    meter.recordSourceFailure();
    return;
  }
  entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    if (!meter.checkpoint()) return;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* findRolloutFilesBudgeted(path, warnings, meter);
      if (meter.stopped) return;
    } else if (entry.isFile() && ROLLOUT_FILE_PATTERN.test(entry.name)) {
      yield path;
    }
  }
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

async function discoverCodexSessionsUnbudgeted(
  sessionsDirectory: string,
  query: SessionQuery,
  evidenceCache?: ExactSourceEvidenceCache,
  coverage?: BuiltInSourceCoverageAccumulator,
): Promise<Session[] | undefined> {
  let root: string;
  try {
    root = await realpath(sessionsDirectory);
  } catch {
    return coverage === undefined ? [] : undefined;
  }
  const files = (await findRolloutFiles(root, () => coverage?.markPartial())).sort((left, right) =>
    left.localeCompare(right)
  );
  const repoRoot = await canonicalPath(query.repoRoot);
  const globalWarnings: SourceWarning[] = [];
  const sessions: Session[] = [];
  for (const file of files) {
    if (!withinDiscoveryWindow(root, file, query)) continue;
    coverage?.recordDiscoveredFile();
    let parsed: Session | null;
    try {
      if (coverage !== undefined) {
        const observed = await parseCodexSessionObserved(
          { sourcePath: file, endedAtMs: query.endedAtMs });
        parsed = observed.result;
        coverage.recordParsedFile(observed.observation.rows_seen,
          observed.observation.rows_accepted, observed.observation.events_emitted,
          observed.observation.completeness);
      } else parsed = evidenceCache === undefined
        ? await parseCodexSession({ sourcePath: file, endedAtMs: query.endedAtMs })
        : await evidenceCache.consume({ adapterId: "codex", sourceRoot: root,
            sourcePath: file, endedAtMs: query.endedAtMs,
            readState: readCodexParserState, projectState: projectCodexParserState,
            coldFallback: () => parseCodexSession({ sourcePath: file, endedAtMs: query.endedAtMs }) });
    } catch {
      coverage?.markPartial();
      globalWarnings.push(
        sourceWarning(
          "codex_source_read_error",
          "Could not read a Codex rollout transcript.",
          file,
        ),
      );
      continue;
    }
    if (parsed === null) continue;
    const canonicalSession = await canonicalizeSessionCwds(parsed);
    if (!intersects(canonicalSession, query)) continue;
    if (
      !(await cwdMatchesRepository(repoRoot, canonicalSession.observed_cwds))
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
    if (branch === query.headBranch) sessions.push(session);
  }
  return globalWarnings.length === 0
    ? sessions
    : sessions.map((session) => ({
        ...session,
        warnings: [...session.warnings, ...globalWarnings],
      }));
}

export async function discoverCodexSessions(
  sessionsDirectory: string,
  query: SessionQuery,
  evidenceCache?: ExactSourceEvidenceCache,
): Promise<Session[]> {
  const meter = query.analysisBudgetMeter;
  if (meter === undefined) {
    return (await discoverCodexSessionsUnbudgeted(
      sessionsDirectory, query, evidenceCache)) ?? [];
  }
  if (!meter.checkpoint()) return [];
  let root: string;
  try {
    root = await realpath(sessionsDirectory);
  } catch {
    meter.recordSourceFailure();
    return [];
  }

  if (!meter.checkpoint()) return [];
  const repoRoot = await canonicalPath(query.repoRoot);
  if (!meter.checkpoint()) return [];
  const globalWarnings: SourceWarning[] = [];
  const files = findRolloutFilesBudgeted(root, globalWarnings, meter);
  const sessions: Session[] = [];

  fileLoop: for await (const file of files) {
    if (!meter.checkpoint()) break;
    if (!withinDiscoveryWindow(root, file, query)) {
      continue;
    }
    let fileSize: number | undefined;
    let admittedFileBytes: number | undefined;
    if (!meter.admitSourceItem()) break;
    try {
      fileSize = (await stat(file)).size;
    } catch {
      meter.recordSourceFailure();
      globalWarnings.push(
        sourceWarning(
          "codex_source_read_error",
          "Could not inspect a Codex rollout transcript.",
          file,
        ),
      );
      break;
    }
    if (!meter.checkpoint()) break;
    if (
      fileSize === undefined ||
      !Number.isSafeInteger(fileSize) ||
      fileSize < 0
    ) {
      meter.recordSourceFailure();
      break;
    }
    admittedFileBytes = meter.admitInputBytes(fileSize);
    if (admittedFileBytes === 0 && fileSize > 0) break;
    let parsed: Session | null;
    try {
      parsed = await parseCodexSession({
        sourcePath: file,
        endedAtMs: query.endedAtMs,
        ...(admittedFileBytes === undefined
          ? {}
          : { budgets: { maxFileBytes: admittedFileBytes } }),
      });
    } catch (error) {
      const expectedByteTruncation =
        admittedFileBytes !== undefined &&
        fileSize !== undefined &&
        admittedFileBytes < fileSize &&
        error instanceof ParserBudgetExceededError &&
        error.budget === "file";
      if (!expectedByteTruncation) {
        globalWarnings.push(
          sourceWarning(
            "codex_source_read_error",
            "Could not read a Codex rollout transcript.",
            file,
          ),
        );
        meter.recordSourceFailure();
      }
      break;
    }
    if (parsed === null) {
      continue;
    }
    const knownBranchMismatch = parsed.observed_branches.some(
      (branch) => branch !== query.headBranch,
    );
    const admitted = admitSessionEventPrefix([parsed], meter);
    const admittedSession = admitted[0];
    if (admittedSession === undefined) break;
    if (knownBranchMismatch) continue;
    if (!meter.stopped && !meter.checkpoint()) break;
    const canonicalSession = await canonicalizeSessionCwds(admittedSession);
    if (!intersects(canonicalSession, query)) {
      continue;
    }
    if (!meter.stopped && !meter.checkpoint()) break;
    if (
      !(await cwdMatchesRepository(
        repoRoot,
        canonicalSession.observed_cwds,
      ))
    ) {
      continue;
    }
    if (!meter.stopped && !meter.checkpoint()) {
      break fileLoop;
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

export async function discoverCodexSessionsObserved(
  sessionsDirectory: string, query: SessionQuery,
) {
  if (query.analysisBudgetMeter !== undefined)
    throw new TypeError("Observed Codex discovery is cold and unbudgeted.");
  const coverage = createBuiltInSourceCoverageAccumulator("codex", "1.0.0",
    CODEX_PARSER_VERSION, PARSER_STATE_SCHEMA_FINGERPRINT);
  const sessions = await discoverCodexSessionsUnbudgeted(
    sessionsDirectory, query, undefined, coverage);
  return sessions === undefined
    ? { sessions: [], source_coverage: unavailableSourceCoverage() }
    : { sessions, source_coverage: coverage.snapshot() };
}

export class CodexSessionSource implements SessionSource {
  readonly contract = CODEX_SESSION_SOURCE_CONTRACT;
  readonly #sessionsDirectory: string | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #evidenceCache: ExactSourceEvidenceCache | undefined;

  constructor(options?: CodexDiscoverOptions, evidenceCache?: ExactSourceEvidenceCache) {
    this.#sessionsDirectory = options?.sessionsDirectory;
    this.#env = options?.env ?? process.env;
    this.#evidenceCache = evidenceCache;
  }

  async discover(query: SessionQuery): Promise<Session[]> {
    const sessionsDirectory =
      this.#sessionsDirectory ??
      this.#env.CCPROF_CODEX_SESSIONS_DIR ??
      join(homedir(), ".codex", "sessions");
    return discoverCodexSessions(sessionsDirectory, query, this.#evidenceCache);
  }
}
