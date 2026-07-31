import { durationMs } from "../core/intervals.js";
import type { MatchedAction } from "../core/model.js";
import {
  createFindingCandidate,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";

export interface RediscoveryOptions {
  estimatedTokensByToolUseId?: ReadonlyMap<string, number>;
}

interface DuplicateRead {
  read: MatchedAction;
  inference?: MatchedAction;
  target: string;
}

function targetFor(action: MatchedAction): string {
  const paths = sortedUnique(action.paths);
  return paths.length > 0 ? paths.join(", ") : action.target;
}

function duplicateReads(
  actions: readonly MatchedAction[],
): DuplicateRead[] {
  const byAgent = new Map<string, MatchedAction[]>();
  for (const action of orderedActions(actions)) {
    const key = `${action.session_id}\0${action.agent_id}`;
    const group = byAgent.get(key);
    if (group === undefined) byAgent.set(key, [action]);
    else group.push(action);
  }

  const duplicates: DuplicateRead[] = [];
  for (const agentActions of byAgent.values()) {
    for (let index = 0; index < agentActions.length; index += 1) {
      const read = agentActions[index];
      if (
        read === undefined ||
        read.kind !== "tool" ||
        read.match !== "duplicate_read"
      ) {
        continue;
      }
      const next = agentActions[index + 1];
      const inference =
        next !== undefined &&
        next.kind === "inference" &&
        next.match === "duplicate_read" &&
        read.tool_use_id !== undefined &&
        next.tool_use_id === read.tool_use_id &&
        next.interval.start_ms === read.interval.end_ms
          ? next
          : undefined;
      duplicates.push({
        read,
        ...(inference === undefined ? {} : { inference }),
        target: targetFor(read),
      });
    }
  }
  return duplicates;
}

export function detectRediscovery(
  actions: readonly MatchedAction[],
  options: RediscoveryOptions = {},
) {
  const byTarget = new Map<string, DuplicateRead[]>();
  for (const duplicate of duplicateReads(actions)) {
    const group = byTarget.get(duplicate.target);
    if (group === undefined) byTarget.set(duplicate.target, [duplicate]);
    else group.push(duplicate);
  }

  return [...byTarget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([target, duplicates]) => {
      const claimedActions = duplicates.flatMap(({ read, inference }) =>
        inference === undefined ? [read] : [read, inference]
      );
      const recoverable = recoverableClaim(
        "R003",
        target,
        claimedActions,
      );
      if (recoverable.estimated_ms === 0) return [];
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
      return [createFindingCandidate({
        rule_id: "R003",
        title: "Repeated file rediscovery",
        classification: "behavior",
        cause: null,
        scope: "claude_md",
        confidence: minimumConfidence(
          claimedActions.flatMap((action) => [
            action.confidence,
            action.match_confidence,
          ]),
        ),
        target,
        evidence: {
          session_refs: sortedUnique(
            claimedActions.flatMap((action) => action.session_refs),
          ),
          interval_ids: recoverable.intervals.map(
            (interval) => interval.interval_id,
          ),
          paths: sortedUnique(
            duplicates.flatMap(({ read }) => read.paths),
          ),
          duplicate_count: duplicates.length,
          duration_ms: recoverable.estimated_ms,
          read_duration_ms: readDurationMs,
          post_result_inference_ms: inferenceDurationMs,
          estimated_tokens: estimatedTokens,
        },
        recoverable,
        fix_recipe: {
          suggestion:
            `Record why and when to inspect \`${target}\` in CLAUDE.md so unchanged content is not reread.`,
          verify: "git diff -- CLAUDE.md",
        },
        caveats: sortedUnique([
          ...claimedActions.flatMap((action) => action.caveats),
          ...(missingTokenEvidence
            ? ["Token-size evidence was unavailable for at least one duplicate read."]
            : []),
          ...(recoverable.bound === "upper"
            ? ["At least one duplicate read overlapped another agent, so recoverable time is an upper bound."]
            : []),
        ]),
      })];
    });
}
