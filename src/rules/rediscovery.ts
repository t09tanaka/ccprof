import { durationMs } from "../core/intervals.js";
import type { Confidence, MatchedAction } from "../core/model.js";
import { normalizeRepoPath } from "../analysis/test-map.js";
import type { AnalysisRecord } from "../store/analyses.js";
import {
  createFindingCandidate, findingKey, normalizeFindingTarget,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";

export interface RediscoveryOptions {
  estimatedTokensByToolUseId?: ReadonlyMap<string, number>;
  history?: readonly AnalysisRecord[];
  currentObjectIdsByPath?: ReadonlyMap<string, string>; crossPrEligibleReadKeys?: ReadonlySet<string>;
}

interface CurrentRead {
  read: MatchedAction;
  inference?: MatchedAction;
  target: string;
  paths: string[];
}

interface HistoricalRediscovery {
  prs: string[];
  durationMin: number;
  sessionRefs: string[];
  confidence: Confidence;
}

interface HistoricalPrEvidence {
  durationMin: number;
  sessionRefs: Set<string>;
  confidence: Confidence;
}

const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function normalizedPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return normalizeRepoPath(value.normalize("NFC"));
  } catch {
    return null;
  }
}

function pathsFor(action: MatchedAction): string[] {
  return sortedUnique(
    action.paths.flatMap((path) => {
      const normalized = normalizedPath(path);
      return normalized === null ? [] : [normalized];
    }),
  );
}

function targetFor(action: MatchedAction, paths: readonly string[]): string {
  return paths.length > 0 ? paths.join(", ") : action.target;
}

function currentReads(
  actions: readonly MatchedAction[],
): CurrentRead[] {
  const byAgent = new Map<string, MatchedAction[]>();
  for (const action of orderedActions(actions)) {
    const key = `${action.session_id}\0${action.agent_id}`;
    const group = byAgent.get(key);
    if (group === undefined) byAgent.set(key, [action]);
    else group.push(action);
  }

  const reads: CurrentRead[] = [];
  for (const agentActions of byAgent.values()) {
    for (let index = 0; index < agentActions.length; index += 1) {
      const read = agentActions[index];
      if (
        read === undefined ||
        read.kind !== "tool" ||
        (read.match !== "safe_read" && read.match !== "duplicate_read")
      ) {
        continue;
      }
      const next = agentActions[index + 1];
      const inference =
        next !== undefined &&
        next.kind === "inference" &&
        next.match === read.match &&
        read.tool_use_id !== undefined &&
        next.tool_use_id === read.tool_use_id &&
        next.interval.start_ms === read.interval.end_ms
          ? next
          : undefined;
      const paths = pathsFor(read);
      reads.push({
        read,
        ...(inference === undefined ? {} : { inference }),
        target: targetFor(read, paths),
        paths,
      });
    }
  }
  return reads;
}

function historicalRediscoveryByPath(
  history: readonly AnalysisRecord[],
  currentObjectIdsByPath: ReadonlyMap<string, string>,
): Map<string, HistoricalRediscovery> {
  const byPathAndPr = new Map<string, Map<string, HistoricalPrEvidence>>();
  for (const record of history) {
    const rawPrRef = record?.unit?.pr_ref;
    if (typeof rawPrRef !== "string" || rawPrRef.trim() === "") continue;
    const prRef = rawPrRef.trim();
    if (!Array.isArray(record.read_observations)) continue;
    for (const observation of record.read_observations) {
      const path = normalizedPath(observation?.path);
      const objectId = typeof observation?.object_id === "string" ? observation.object_id.toLowerCase() : "";
      const currentObjectId = path === null ? undefined : currentObjectIdsByPath.get(path);
      const confidence = observation.confidence ?? "low";
      if (
        path === null || currentObjectId === undefined ||
        !OID_PATTERN.test(objectId) || !OID_PATTERN.test(currentObjectId) ||
        objectId !== currentObjectId.toLowerCase() ||
        typeof observation.duration_min !== "number" || !Number.isFinite(observation.duration_min) || observation.duration_min < 0 ||
        !Array.isArray(observation.session_refs) ||
        observation.session_refs.length === 0 || !observation.session_refs.every((ref) => typeof ref === "string" && ref !== "")
      ) {
        continue;
      }
      let byPr = byPathAndPr.get(path);
      if (byPr === undefined) byPathAndPr.set(path, byPr = new Map());
      const existing = byPr.get(prRef);
      if (existing === undefined) {
        byPr.set(prRef, { durationMin: observation.duration_min,
          sessionRefs: new Set(observation.session_refs), confidence });
      } else {
        existing.durationMin = Math.max(existing.durationMin, observation.duration_min);
        for (const ref of observation.session_refs) existing.sessionRefs.add(ref);
        existing.confidence = minimumConfidence([existing.confidence, confidence]);
      }
    }
  }

  return new Map([...byPathAndPr.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, byPr]) => {
      const prs = [...byPr.entries()].sort(([left], [right]) => left.localeCompare(right));
      return [path, {
        prs: prs.map(([prRef]) => prRef),
        durationMin: prs.reduce((sum, [, value]) => sum + value.durationMin, 0),
        sessionRefs: sortedUnique(prs.flatMap(([, value]) => [...value.sessionRefs])),
        confidence: minimumConfidence(prs.map(([, value]) => value.confidence)),
      }] as const;
    }));
}

function readIdentity(read: Pick<CurrentRead, "read">, path?: string): string {
  return [
    read.read.session_id,
    read.read.agent_id,
    read.read.action_id,
    ...(path === undefined ? [] : [path]),
  ].join("\0");
}

export function detectRediscovery(
  actions: readonly MatchedAction[],
  options: RediscoveryOptions = {},
) {
  const reads = currentReads(actions);
  const historyByPath = historicalRediscoveryByPath(options.history ?? [], options.currentObjectIdsByPath ?? new Map());
  const byTarget = new Map<string, Map<string, CurrentRead>>();
  for (const read of reads) {
    const exact = (path: string) => historyByPath.has(path) && (options.crossPrEligibleReadKeys === undefined || options.crossPrEligibleReadKeys.has(readIdentity(read, path)));
    const historicalPath = read.read.match === "duplicate_read" || read.paths.length === 1 ? read.paths.find(exact) : undefined;
    const target = historicalPath ?? (read.read.match === "duplicate_read" ? read.target : undefined);
    if (target === undefined) continue;
    const group = byTarget.get(target) ?? new Map();
    group.set(readIdentity(read), read);
    byTarget.set(target, group);
  }

  return [...byTarget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([target, readMap]) => {
      const current = [...readMap.values()];
      const duplicates = current.filter(
        ({ read }) => read.match === "duplicate_read",
      );
      const eligible = ({ read, paths }: CurrentRead) => paths.includes(target) && (options.crossPrEligibleReadKeys === undefined || options.crossPrEligibleReadKeys.has(readIdentity({ read }, target)));
      const historical = current.some(eligible) ? historyByPath.get(target) : undefined;
      const claimedReads = current.filter((read) =>
        read.read.match === "duplicate_read" || (historical !== undefined && eligible(read)));
      const evidenceActions = current.flatMap(({ read, inference }) =>
        inference === undefined ? [read] : [read, inference]
      );
      const claimedActions = claimedReads.flatMap(({ read, inference }) =>
        inference === undefined ? [read] : [read, inference]
      );
      const recoverable = recoverableClaim(
        "R003",
        target,
        claimedActions,
      );
      if (recoverable.estimated_ms === 0 && historical === undefined) return [];
      const toolUseIds = sortedUnique(
        claimedReads.flatMap(({ read }) =>
          read.tool_use_id === undefined ? [] : [read.tool_use_id]
        ),
      );
      const missingTokenEvidence = toolUseIds.some(
        (id) => options.estimatedTokensByToolUseId?.get(id) === undefined,
      );
      const estimatedTokens = toolUseIds.reduce((total, id) => {
        const tokens = options.estimatedTokensByToolUseId?.get(id);
        return total +
          (tokens !== undefined && Number.isSafeInteger(tokens) && tokens >= 0
            ? tokens
            : 0);
      }, 0);
      const readDurationMs = durationMs(
        claimedReads.map(({ read }) => read.interval),
      );
      const inferenceDurationMs = durationMs(
        claimedReads.flatMap(({ inference }) =>
          inference === undefined ? [] : [inference.interval]
        ),
      );
      const confidenceActions =
        claimedActions.length === 0 ? evidenceActions : claimedActions;
      return [{ ...createFindingCandidate({
        rule_id: "R003",
        title: "Repeated file rediscovery",
        classification: "behavior",
        cause: null,
        scope: "claude_md",
        confidence: minimumConfidence(
          confidenceActions.flatMap((action) => [
            action.confidence,
            action.match_confidence,
          ]).concat(historical?.confidence ?? []),
        ),
        target,
        evidence: {
          session_refs: sortedUnique(
            evidenceActions.flatMap((action) => action.session_refs),
          ),
          interval_ids: recoverable.intervals.map(
            (interval) => interval.interval_id,
          ),
          paths: sortedUnique(
            current.flatMap(({ paths }) => paths),
          ),
          duplicate_count: duplicates.length,
          current_read_count: current.length,
          duration_ms: recoverable.estimated_ms,
          read_duration_ms: readDurationMs,
          post_result_inference_ms: inferenceDurationMs,
          estimated_tokens: estimatedTokens,
          ...(historical === undefined
            ? {}
            : {
              historical_prs: historical.prs,
              historical_duration_min: historical.durationMin,
              historical_session_refs: historical.sessionRefs,
            }),
        },
        recoverable,
        fix_recipe: {
          suggestion:
            `Record why and when to inspect \`${target}\` in CLAUDE.md so unchanged content is not reread.`,
          verify: "git diff -- CLAUDE.md",
        },
        caveats: sortedUnique([
          ...evidenceActions.flatMap((action) => action.caveats),
          ...(missingTokenEvidence
            ? ["Token-size evidence was unavailable for at least one duplicate read."]
            : []),
          ...(recoverable.bound === "upper"
            ? ["At least one duplicate read overlapped another agent, so recoverable time is an upper bound."]
            : []),
          ...(historical === undefined
            ? []
            : [
              `The same path and blob were read in ${historical.prs.length} prior PR${historical.prs.length === 1 ? "" : "s"}; historical time is evidence only and is not included in this PR's recoverable estimate.`,
            ]),
        ]),
      }), finding_key: findingKey("R003", normalizeFindingTarget(target) === target && !/[\uD800-\uDFFF]/u.test(target) ? target : `\0path:${Buffer.from(target, "utf16le").toString("hex")}`) }];
    });
}
