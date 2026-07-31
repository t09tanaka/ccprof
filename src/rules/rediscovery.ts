import { durationMs } from "../core/intervals.js";
import type { MatchedAction } from "../core/model.js";
import { normalizeRepoPath } from "../analysis/test-map.js";
import type { AnalysisRecord } from "../store/analyses.js";
import {
  createFindingCandidate,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";

export interface RediscoveryOptions {
  estimatedTokensByToolUseId?: ReadonlyMap<string, number>;
  history?: readonly AnalysisRecord[];
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
}

interface HistoricalPrEvidence {
  durationMin: number;
  sessionRefs: Set<string>;
}

function hasHistoricalDuplicateEvidence(
  finding: AnalysisRecord["findings"][number],
  evidence: object,
): boolean {
  if (Reflect.has(evidence, "duplicate_count")) {
    const duplicateCount = Reflect.get(evidence, "duplicate_count");
    return Number.isSafeInteger(duplicateCount) && duplicateCount > 0;
  }

  const intervalIds = Reflect.get(evidence, "interval_ids");
  return finding.recoverable !== null &&
    typeof finding.recoverable === "object" &&
    typeof finding.recoverable.min === "number" &&
    Number.isFinite(finding.recoverable.min) &&
    finding.recoverable.min > 0 &&
    Array.isArray(intervalIds) &&
    intervalIds.length > 0 &&
    intervalIds.every(
      (intervalId) =>
        typeof intervalId === "string" &&
        intervalId.startsWith("R003:") &&
        intervalId.length > "R003:".length,
    );
}

function normalizedPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return normalizeRepoPath(value.normalize("NFC").trim());
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
): Map<string, HistoricalRediscovery> {
  const byPathAndPr = new Map<string, Map<string, HistoricalPrEvidence>>();
  for (const record of history) {
    const rawPrRef = record?.unit?.pr_ref;
    if (typeof rawPrRef !== "string" || rawPrRef.trim() === "") continue;
    const prRef = rawPrRef.trim();
    if (!Array.isArray(record.findings)) continue;
    for (const finding of record.findings) {
      if (finding?.rule_id !== "R003") continue;
      const evidence: unknown = finding.evidence;
      if (
        evidence === null ||
        typeof evidence !== "object" ||
        Array.isArray(evidence)
      ) {
        continue;
      }
      if (!hasHistoricalDuplicateEvidence(finding, evidence)) continue;
      const rawPaths = Reflect.get(evidence, "paths");
      const rawSessionRefs = Reflect.get(evidence, "session_refs");
      if (
        !Array.isArray(rawPaths) ||
        rawPaths.length === 0 ||
        !rawPaths.every((path) => typeof path === "string") ||
        !Array.isArray(rawSessionRefs) ||
        rawSessionRefs.length === 0 ||
        !rawSessionRefs.every(
          (ref) => typeof ref === "string" && ref !== "",
        )
      ) {
        continue;
      }
      const paths = sortedUnique(
        rawPaths.flatMap((path) => {
          const normalized = normalizedPath(path);
          return normalized === null ? [] : [normalized];
        }),
      );
      if (paths.length === 0) continue;
      const rawDurationMs = Reflect.get(evidence, "duration_ms");
      const durationMin =
        typeof rawDurationMs === "number" &&
          Number.isFinite(rawDurationMs) &&
          rawDurationMs >= 0
          ? rawDurationMs / 60_000
          : finding.recoverable !== null &&
              typeof finding.recoverable === "object" &&
              typeof finding.recoverable.min === "number" &&
              Number.isFinite(finding.recoverable.min) &&
              finding.recoverable.min >= 0
          ? finding.recoverable.min
          : null;
      if (durationMin === null) continue;
      for (const path of paths) {
        let byPr = byPathAndPr.get(path);
        if (byPr === undefined) {
          byPr = new Map();
          byPathAndPr.set(path, byPr);
        }
        const existing = byPr.get(prRef);
        if (existing === undefined) {
          byPr.set(prRef, {
            durationMin,
            sessionRefs: new Set(rawSessionRefs as string[]),
          });
        } else {
          existing.durationMin = Math.max(existing.durationMin, durationMin);
          for (const ref of rawSessionRefs) existing.sessionRefs.add(ref);
        }
      }
    }
  }

  return new Map(
    [...byPathAndPr.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, byPr]) => {
        const orderedPrs = [...byPr.entries()].sort(([left], [right]) =>
          left.localeCompare(right)
        );
        return [path, {
          prs: orderedPrs.map(([prRef]) => prRef),
          durationMin: orderedPrs.reduce(
            (total, [, evidence]) => total + evidence.durationMin,
            0,
          ),
          sessionRefs: sortedUnique(
            orderedPrs.flatMap(([, evidence]) => [...evidence.sessionRefs]),
          ),
        }] as const;
      }),
  );
}

function readIdentity(read: CurrentRead): string {
  return [
    read.read.session_id,
    read.read.agent_id,
    read.read.action_id,
  ].join("\0");
}

export function detectRediscovery(
  actions: readonly MatchedAction[],
  options: RediscoveryOptions = {},
) {
  const reads = currentReads(actions);
  const historyByPath = historicalRediscoveryByPath(options.history ?? []);
  const byTarget = new Map<string, Map<string, CurrentRead>>();
  for (const read of reads) {
    if (read.read.match !== "duplicate_read") continue;
    const group = byTarget.get(read.target) ?? new Map();
    group.set(readIdentity(read), read);
    byTarget.set(read.target, group);
  }
  for (const [path] of historyByPath) {
    for (const read of reads) {
      if (read.paths.length !== 1 || read.paths[0] !== path) continue;
      const group = byTarget.get(path) ?? new Map();
      group.set(readIdentity(read), read);
      byTarget.set(path, group);
    }
  }

  return [...byTarget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([target, readMap]) => {
      const current = [...readMap.values()];
      const duplicates = current.filter(
        ({ read }) => read.match === "duplicate_read",
      );
      const evidenceActions = current.flatMap(({ read, inference }) =>
        inference === undefined ? [read] : [read, inference]
      );
      const claimedActions = duplicates.flatMap(({ read, inference }) =>
        inference === undefined ? [read] : [read, inference]
      );
      const recoverable = recoverableClaim(
        "R003",
        target,
        claimedActions,
      );
      const historical = historyByPath.get(target);
      if (recoverable.estimated_ms === 0 && historical === undefined) return [];
      const toolUseIds = sortedUnique(
        duplicates.flatMap(({ read }) =>
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
        duplicates.map(({ read }) => read.interval),
      );
      const inferenceDurationMs = durationMs(
        duplicates.flatMap(({ inference }) =>
          inference === undefined ? [] : [inference.interval]
        ),
      );
      const confidenceActions =
        claimedActions.length === 0 ? evidenceActions : claimedActions;
      return [createFindingCandidate({
        rule_id: "R003",
        title: "Repeated file rediscovery",
        classification: "behavior",
        cause: null,
        scope: "claude_md",
        confidence: minimumConfidence(
          confidenceActions.flatMap((action) => [
            action.confidence,
            action.match_confidence,
          ]),
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
              `The same path had rediscovery evidence in ${historical.prs.length} prior PR${historical.prs.length === 1 ? "" : "s"}; historical time is evidence only and is not included in this PR's recoverable estimate.`,
            ]),
        ]),
      })];
    });
}
