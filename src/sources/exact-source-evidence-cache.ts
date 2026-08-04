import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Session, SourceWarning } from "../core/model.js";
import type { SourceAdapterId } from "../core/source-descriptor.js";
import { canonicalizeSessionCwds, cwdMatchesRepository } from "./cwd.js";
import { IncrementalParserStateCapacityError, type ParserStateReadResult } from "./jsonl-budget.js";
import { commitEligibleSourceEvidence, createSourceEvidencePair, getSourceEvidencePair,
  normalizeSourceEvidenceEnvelope, sourceEvidenceIdentity } from "../store/source-evidence-cache.js";
import type { StorePaths } from "../store/paths.js";
import { getSourceCatalogEntry } from "../store/source-catalog.js";
import { openStoreDatabase } from "../store/sqlite.js";

const RANGE_BYTES = 4_096;
const CACHE_WARNING: SourceWarning = { code: "source_cache_unavailable",
  message: "Exact source evidence cache was unavailable; cold evidence was used.", source_path: "" };
interface ConsumeOptions<State, Result> {
  adapterId: SourceAdapterId; sourceRoot: string; sourcePath: string;
  endedAtMs?: number; coldFallback?: () => Promise<Result>;
  readState(options: { sourcePath: string; fileHandle: FileHandle }):
    Promise<ParserStateReadResult<State>>;
  projectState(state: State, options?: { endedAtMs?: number }): Result;
}
interface Observation {
  device: number | null; inode: number | null; mtimeMs: number; sizeBytes: number;
  prefixHash: string; suffixHash: string; contentRevision: string;
}
const hash = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function observe(handle: FileHandle, status: Stats): Promise<Observation> {
  const full = createHash("sha256"); const prefix: Buffer[] = [];
  let suffix = Buffer.alloc(0); let position = 0;
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const bytes = Buffer.from(buffer.subarray(0, bytesRead)); full.update(bytes);
    if (position < RANGE_BYTES) prefix.push(bytes.subarray(0, RANGE_BYTES - position));
    suffix = Buffer.concat([suffix, bytes]).subarray(-RANGE_BYTES);
    position += bytesRead;
  }
  const fileIdentity = Number.isSafeInteger(status.dev) && Number.isSafeInteger(status.ino);
  return { device: fileIdentity ? status.dev : null, inode: fileIdentity ? status.ino : null, mtimeMs: Math.trunc(status.mtimeMs),
    sizeBytes: position, prefixHash: hash(Buffer.concat(prefix)), suffixHash: hash(suffix),
    contentRevision: `sha256:${full.digest("hex")}` };
}
const sameFile = (left: Stats, right: Stats) => left.isFile() && right.isFile() &&
  left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeMs === right.mtimeMs;
function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!isAbsolute(value) && value !== ".." &&
    !value.startsWith(`..${sep}`));
}
function evidence<Result>(adapter: SourceAdapterId, value: Result) {
  if (adapter === "claude") return value as { sessions: Session[]; warnings: SourceWarning[] };
  const session = value as Session | null;
  if (session !== null) Reflect.deleteProperty(session.warnings, "push");
  return { sessions: session === null ? [] : [session], warnings: session?.warnings ?? [] };
}
async function stable(handle: FileHandle, path: string, initial: Stats,
  revision: string): Promise<boolean> {
  try {
    const reread = await observe(handle, await handle.stat());
    return reread.contentRevision === revision && sameFile(initial, await handle.stat()) &&
      sameFile(initial, await lstat(path));
  } catch { return false; }
}

export class ExactSourceEvidenceCache {
  readonly #paths: StorePaths; readonly #root: string; readonly #observedAtMs: number | undefined;
  readonly #onWarning: ((warning: SourceWarning) => void) | undefined;
  constructor(options: { storePaths: StorePaths; eligibilityRoot: string;
    observedAtMs?: number; onWarning?: (warning: SourceWarning) => void }) {
    this.#paths = options.storePaths; this.#root = options.eligibilityRoot;
    this.#observedAtMs = options.observedAtMs; this.#onWarning = options.onWarning;
  }
  async consume<State, Result>(options: ConsumeOptions<State, Result>): Promise<Result> {
    const root = await realpath(this.#root); const sourceRoot = await realpath(options.sourceRoot);
    const sourcePath = join(await realpath(dirname(resolve(options.sourcePath))),
      basename(options.sourcePath));
    if (!within(sourceRoot, sourcePath)) throw new Error("Source path escaped its root.");
    const before = await lstat(sourcePath);
    if (!before.isFile()) throw new Error("Source path is not a regular file.");
    let handle: FileHandle | undefined;
    let database: ReturnType<typeof openStoreDatabase> | undefined;
    let warned = false;
    const warn = () => { if (!warned) { warned = true; this.#onWarning?.(CACHE_WARNING); } };
    try {
      const flags = constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
      handle = await open(sourcePath, flags);
      const held = await handle.stat();
      if (!sameFile(before, held)) throw new Error("Source identity changed.");
      const observation = await observe(handle, held);
      const eligibilityIdentity = createHash("sha256").update(root).digest("hex");
      const sourceIdentity = sourceEvidenceIdentity(options.adapterId, sourcePath);
      let catalog: ReturnType<typeof getSourceCatalogEntry>, pair;
      try {
        database = openStoreDatabase(this.#paths);
        catalog = getSourceCatalogEntry(database, sourceIdentity);
        pair = getSourceEvidencePair(database, this.#paths.repo_hash,
          eligibilityIdentity, sourceIdentity);
      } catch { warn(); }
      if (pair?.catalog.content_revision === observation.contentRevision) {
        const envelope = normalizeSourceEvidenceEnvelope(JSON.parse(pair.cache.payload_json));
        const projected = envelope.kind === "no-evidence-v1"
          ? (options.adapterId === "claude" ? { sessions: [], warnings: [] } : null) as Result
          : options.projectState(envelope.continuation as State,
              options.endedAtMs === undefined ? {} : { endedAtMs: options.endedAtMs });
        evidence(options.adapterId, projected);
        if (await stable(handle, sourcePath, held, observation.contentRevision)) return projected;
      }
      let read: ParserStateReadResult<State>;
      try { read = await options.readState({ sourcePath, fileHandle: handle }); }
      catch (error) {
        if (!(error instanceof IncrementalParserStateCapacityError) || options.coldFallback === undefined) throw error;
        return await options.coldFallback();
      }
      const full = options.projectState(read.state);
      const requested = options.projectState(read.state,
        options.endedAtMs === undefined ? {} : { endedAtMs: options.endedAtMs });
      const found = evidence(options.adapterId, full);
      evidence(options.adapterId, requested);
      const eligible = await Promise.all(found.sessions.map(async (session) =>
        cwdMatchesRepository(root, (await canonicalizeSessionCwds(session)).observed_cwds)));
      const stateWarnings = (read.state as { warnings?: unknown[] }).warnings ?? [];
      const warningFree = found.warnings.length === 0 && stateWarnings.length === 0 &&
        found.sessions.every((session) => session.warnings.length === 0);
      const negativeReason = found.sessions.length === 0 && warningFree &&
          observation.sizeBytes === 0 ? "empty" as const
        : found.sessions.length > 0 && warningFree && eligible.every((value) => !value)
        ? "other-repository-only" as const : undefined;
      const publish = eligible.length > 0 && eligible.every(Boolean) ? {}
        : negativeReason === undefined ? undefined : { negativeReason };
      if (database !== undefined && read.completeness === "complete" && publish !== undefined &&
        await stable(handle, sourcePath, held, observation.contentRevision)) {
        try {
          const committed = commitEligibleSourceEvidence(database, this.#paths.repo_hash, eligibilityIdentity,
            createSourceEvidencePair({ adapterId: options.adapterId, canonicalPath: sourcePath,
              repositoryIdentity: this.#paths.repo_hash, eligibilityIdentity,
              observedAtMs: catalog?.content_revision === observation.contentRevision
                ? catalog.observed_at_ms : Math.max(this.#observedAtMs ?? observation.mtimeMs,
                    (catalog?.observed_at_ms ?? -1) + 1), observation,
              parserState: read.state as never, evidence: { ...found, ...publish } }));
          if (negativeReason !== undefined && committed !== "stale" && committed !== "conflict")
            return (options.adapterId === "claude" ? { sessions: [], warnings: [] } : null) as Result;
        } catch { warn(); }
      }
      return requested;
    } finally { database?.close(); await handle?.close(); }
  }
}
