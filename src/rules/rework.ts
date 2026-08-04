import type {
  GenuineUserEvent,
  MatchedAction,
  R001Cause,
} from "../core/model.js";
import {
  encodeAgentIdentity,
  encodeEventIdentity,
  encodeInvocationIdentity,
  evidenceEventIdentity,
} from "../core/event-identity.js";
import {
  createFindingCandidate,
  impactFromClaim,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";

export interface ReworkOptions {
  userEvents?: readonly GenuineUserEvent[];
  sourceCompleteness?: number;
}

interface ReworkBlock {
  actions: MatchedAction[];
  edits: MatchedAction[];
}

const CAUSE_PATTERNS: readonly [R001Cause, RegExp][] = [
  [
    "ambiguous_task",
    /\b(?:ambiguous|underspecified|unclear task)\b|曖昧|不明確/iu,
  ],
  [
    "missing_context",
    /\b(?:missing context|forgot to mention|context (?:was )?missing)\b|伝え忘れ|前提.{0,8}(?:不足|抜け)/iu,
  ],
  [
    "scope_creep",
    /\b(?:scope creep|out of scope|also add)\b|スコープクリープ|ついでに|追加で/iu,
  ],
  [
    "tool_failure",
    /\b(?:tool|command) (?:failed|failure)\b|(?:ツール|コマンド).{0,8}失敗/iu,
  ],
  [
    "requirements_changed",
    /\b(?:requirements? changed|change the requirements?|instead|rather than)\b|要件.{0,8}変更|仕様変更|じゃなくて/iu,
  ],
];

const CORRECTION_PATTERN =
  /\b(?:wrong|revert|redo|start over|instead|rather than)\b|違う|戻して|やり直し|じゃなくて/iu;

function isReworkEdit(action: MatchedAction): boolean {
  return action.kind === "tool" && action.match === "rework_edit";
}

function directlyCausedInference(
  tool: MatchedAction,
  action: MatchedAction | undefined,
): action is MatchedAction {
  return (
    action !== undefined &&
    action.kind === "inference" &&
    action.match === tool.match &&
    tool.tool_use_id !== undefined &&
    encodeInvocationIdentity(evidenceEventIdentity(action)) ===
      encodeInvocationIdentity(evidenceEventIdentity(tool)) &&
    action.interval.start_ms === tool.interval.end_ms
  );
}

function isRelatedRun(
  action: MatchedAction,
  block: ReworkBlock,
): boolean {
  if (action.kind !== "tool" || action.match !== "contributing_run") {
    return false;
  }
  const reworkPaths = new Set(
    block.edits.flatMap((edit) => edit.paths),
  );
  return (
    action.relevance_paths.length > 0 &&
    action.relevance_paths.every((path) => reworkPaths.has(path))
  );
}

function isContinuous(
  block: ReworkBlock,
  action: MatchedAction,
): boolean {
  const previous = block.actions.at(-1);
  return (
    previous !== undefined &&
    action.interval.start_ms <= previous.interval.end_ms
  );
}

function reworkBlocks(actions: readonly MatchedAction[]): ReworkBlock[] {
  const byAgent = new Map<string, MatchedAction[]>();
  for (const action of orderedActions(actions)) {
    const key = encodeAgentIdentity(evidenceEventIdentity(action));
    const group = byAgent.get(key);
    if (group === undefined) byAgent.set(key, [action]);
    else group.push(action);
  }

  const blocks: ReworkBlock[] = [];
  for (const agentActions of byAgent.values()) {
    let current: ReworkBlock | undefined;
    for (let index = 0; index < agentActions.length; index += 1) {
      const action = agentActions[index];
      if (action === undefined) {
        continue;
      }

      if (isReworkEdit(action)) {
        if (current !== undefined && !isContinuous(current, action)) {
          blocks.push(current);
          current = undefined;
        }
        current ??= { actions: [], edits: [] };
        current.actions.push(action);
        current.edits.push(action);

        const next = agentActions[index + 1];
        if (directlyCausedInference(action, next)) {
          current.actions.push(next);
          index += 1;
        }
        continue;
      }

      if (
        current !== undefined &&
        isContinuous(current, action) &&
        isRelatedRun(action, current)
      ) {
        current.actions.push(action);
        const next = agentActions[index + 1];
        if (directlyCausedInference(action, next)) {
          current.actions.push(next);
          index += 1;
        }
        continue;
      }

      if (current !== undefined) {
        blocks.push(current);
        current = undefined;
      }
    }
    if (current !== undefined) blocks.push(current);
  }
  return blocks.sort(
    (left, right) =>
      (left.actions[0]?.interval.start_ms ?? 0) -
        (right.actions[0]?.interval.start_ms ?? 0) ||
      (left.actions[0]?.action_id ?? "").localeCompare(
        right.actions[0]?.action_id ?? "",
      ),
  );
}

function latestUserEvent(
  block: ReworkBlock,
  events: readonly GenuineUserEvent[],
): GenuineUserEvent | undefined {
  const first = block.actions[0];
  if (first === undefined) return undefined;
  return [...events]
    .filter(
      (event) =>
        encodeAgentIdentity(evidenceEventIdentity(event)) ===
          encodeAgentIdentity(evidenceEventIdentity(first)) &&
        event.timestamp_ms <= first.interval.start_ms,
    )
    .sort(
      (left, right) =>
        right.timestamp_ms - left.timestamp_ms ||
        right.source_index - left.source_index ||
        encodeEventIdentity(evidenceEventIdentity(right)).localeCompare(
          encodeEventIdentity(evidenceEventIdentity(left)),
        ) ||
        right.session_ref.localeCompare(left.session_ref),
    )[0];
}

function causeFor(text: string | undefined): R001Cause {
  if (text === undefined) return "unknown";
  for (const [cause, pattern] of CAUSE_PATTERNS) {
    if (pattern.test(text)) return cause;
  }
  return "unknown";
}

function hasCorrectionSignal(text: string | undefined): boolean {
  if (text === undefined) return false;
  return (
    CORRECTION_PATTERN.test(text) ||
    CAUSE_PATTERNS.some(([, pattern]) => pattern.test(text))
  );
}

function downgradeConfidence(
  confidence: MatchedAction["match_confidence"],
): MatchedAction["match_confidence"] {
  if (confidence === "high") return "medium";
  return "low";
}

function recipeFor(cause: R001Cause) {
  if (cause === "ambiguous_task" || cause === "missing_context") {
    return {
      suggestion:
        "Record the missing task constraint and the rejected approach in CLAUDE.md before the next edit.",
      verify: "git diff -- CLAUDE.md",
    };
  }
  return {
    suggestion:
      "Confirm the corrected requirement and discard the rejected approach before making further edits.",
    verify: "git diff --check",
  };
}

export function detectRework(
  actions: readonly MatchedAction[],
  options: ReworkOptions = {},
) {
  return reworkBlocks(actions).map((block) => {
    const paths = sortedUnique(block.edits.flatMap((action) => action.paths));
    const target = paths.length > 0
      ? paths.join(", ")
      : sortedUnique(block.edits.map((action) => action.target)).join(", ");
    const user = latestUserEvent(block, options.userEvents ?? []);
    const correctionSignal = hasCorrectionSignal(user?.text);
    const cause = causeFor(user?.text);
    const evidenceConfidence = minimumConfidence(
      block.actions.flatMap((action) => [
        action.confidence,
        action.match_confidence,
      ]),
    );
    const causalConfidence = correctionSignal
      ? evidenceConfidence
      : downgradeConfidence(evidenceConfidence);
    const recoverable = recoverableClaim("R001", target, block.actions);
    const caveats = sortedUnique([
      ...block.actions.flatMap((action) => action.caveats),
      ...(correctionSignal
        ? []
        : ["No correction phrase was available; confidence uses diff evidence only."]),
      ...(cause === "unknown"
        ? ["The available evidence does not identify a deterministic rework cause."]
        : []),
      ...(recoverable.bound === "upper"
        ? ["The rework overlapped another agent, so recoverable time is an upper bound."]
        : []),
    ]);
    return createFindingCandidate({
      rule_id: "R001",
      title: "Non-surviving edit rework",
      classification: "behavior",
      cause,
      scope:
        cause === "ambiguous_task" || cause === "missing_context"
          ? "claude_md"
          : cause === "requirements_changed" || cause === "scope_creep"
            ? "this_pr"
            : "separate_issue",
      impact: impactFromClaim(recoverable, "critical_path_latency"),
      finding_confidence: {
        evidence: evidenceConfidence,
        causal: causalConfidence,
        source_completeness: options.sourceCompleteness ?? 1,
      },
      target,
      evidence: {
        session_refs: sortedUnique([
          ...block.actions.flatMap((action) => action.session_refs),
          ...(user === undefined ? [] : [user.session_ref]),
        ]),
        interval_ids: recoverable.intervals.map(
          (interval) => interval.interval_id,
        ),
        paths,
        edit_count: block.edits.length,
        duration_ms: recoverable.estimated_ms,
        correction_signal: correctionSignal,
      },
      intervals: recoverable.intervals,
      fix_recipe: recipeFor(cause),
      caveats,
    });
  });
}
