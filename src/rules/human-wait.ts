import {
  durationMs,
  normalizeInterval,
  subtractIntervals,
} from "../core/intervals.js";
import type {
  AssistantEvent,
  Confidence,
} from "../core/model.js";
import type { AttributedTimelineAction } from "../analysis/timeline.js";
import {
  approvalRecommendationDecision,
  compareUtf8,
  type EffectiveRuleSafetyPolicy,
} from "../policy/rule-safety.js";
import {
  createFindingCandidate,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";

export const APPROVAL_PROMPT_PHRASES = [
  "allow this command",
  "approval required",
  "permission required",
  "please approve",
  "実行を許可",
  "承認が必要",
  "許可が必要",
] as const;

export interface HumanWaitOptions {
  assistantEvents?: readonly AssistantEvent[];
  sourceCompleteness?: number;
  ruleSafety?: EffectiveRuleSafetyPolicy;
}

interface ApprovalSignal {
  action: AttributedTimelineAction;
  source: "explicit" | "phrase";
  confidence: Confidence;
  reason?: string;
}

type LatencyClassification =
  | "approval_policy_latency"
  | "repeated_safe_approval_latency";

interface ApprovalPartitions {
  generic: ApprovalSignal[];
  repeatedSafe: ApprovalSignal[];
  repeatedCanonicalCommands: string[];
}

function matchingPhrase(
  text: string,
): (typeof APPROVAL_PROMPT_PHRASES)[number] | undefined {
  const normalized = text.normalize("NFC").toLocaleLowerCase("en-US");
  return APPROVAL_PROMPT_PHRASES.find((phrase) =>
    normalized.includes(phrase)
  );
}

function approvalSignal(
  action: AttributedTimelineAction,
  assistantsByRef: ReadonlyMap<string, AssistantEvent>,
): ApprovalSignal | undefined {
  if (action.approval !== undefined) {
    if (!action.approval.required) return undefined;
    return {
      action,
      source: "explicit",
      confidence: action.confidence,
      ...(action.approval.reason === undefined
        ? {}
        : { reason: action.approval.reason }),
    };
  }
  const prompt = action.session_refs
    .map((ref) => assistantsByRef.get(ref))
    .flatMap((event) => {
      if (event === undefined) return [];
      const phrase = matchingPhrase(event.text);
      return phrase === undefined ? [] : [{ event, phrase }];
    })[0];
  if (prompt === undefined) return undefined;
  return {
    action,
    source: "phrase",
    confidence: minimumConfidence([action.confidence, "medium"]),
    reason: prompt.phrase,
  };
}

function partitionApprovals(
  approvals: readonly ApprovalSignal[],
  ruleSafety: EffectiveRuleSafetyPolicy | undefined,
): ApprovalPartitions {
  const decision = approvalRecommendationDecision(
    approvals.map(({ action }) => action.command),
    ruleSafety,
  );
  if (
    decision.kind === "denied" ||
    decision.commands.length !== approvals.length
  ) {
    return {
      generic: [...approvals],
      repeatedSafe: [],
      repeatedCanonicalCommands: [],
    };
  }

  const indexesByCanonicalCommand = new Map<string, number[]>();
  for (let index = 0; index < decision.commands.length; index += 1) {
    const command = decision.commands[index];
    if (command === undefined || !command.allowed) continue;
    const indexes = indexesByCanonicalCommand.get(command.canonical_command);
    if (indexes === undefined) {
      indexesByCanonicalCommand.set(command.canonical_command, [index]);
    } else {
      indexes.push(index);
    }
  }

  const repeatedCanonicalCommands = [...indexesByCanonicalCommand]
    .filter(([, indexes]) => indexes.length >= 2)
    .map(([command]) => command)
    .sort(compareUtf8);
  const repeatedCommands = new Set(repeatedCanonicalCommands);
  const repeatedIndexes = new Set<number>();
  for (const [command, indexes] of indexesByCanonicalCommand) {
    if (!repeatedCommands.has(command)) continue;
    for (const index of indexes) repeatedIndexes.add(index);
  }

  return {
    generic: approvals.filter((_, index) => !repeatedIndexes.has(index)),
    repeatedSafe: approvals.filter((_, index) => repeatedIndexes.has(index)),
    repeatedCanonicalCommands,
  };
}

function latencyCandidate(
  classification: LatencyClassification,
  evidenceWaits: readonly AttributedTimelineAction[],
  approvals: readonly ApprovalSignal[],
  sourceCompleteness: number,
  canonicalCommands?: readonly string[],
) {
  const target = classification === "approval_policy_latency"
    ? "approval-policy-latency"
    : "repeated-safe-approval-latency";
  const approvalActions = approvals.map(({ action }) => action);
  const recoverable = recoverableClaim("R004", target, approvalActions);
  const totalWaitMs = durationMs(
    evidenceWaits.map((action) => action.interval),
  );
  const nonApprovalWaitMs = durationMs(
    subtractIntervals(
      evidenceWaits.map((action) => action.interval),
      approvalActions.map((action) => action.interval),
    ),
  );
  const phraseBased = approvals.some(({ source }) => source === "phrase");
  const confidence = approvals.length === 0
    ? "low"
    : minimumConfidence(approvals.map((signal) => signal.confidence));
  const isGeneric = classification === "approval_policy_latency";
  const commandList = canonicalCommands?.map((command) => `\`${command}\``)
    .join(", ");

  return createFindingCandidate({
    rule_id: "R004",
    title: isGeneric
      ? "Approval policy latency"
      : "Repeated safe approval latency",
    classification: "config",
    cause: null,
    scope: "separate_issue",
    impact: {
      lower_ms: 0,
      upper_ms: recoverable.estimated_ms,
      kind: "critical_path_latency",
    },
    finding_confidence: {
      evidence: confidence,
      causal: confidence,
      source_completeness: sourceCompleteness,
    },
    policy_dependent: true,
    target,
    evidence: {
      session_refs: sortedUnique(
        evidenceWaits.flatMap((action) => action.session_refs),
      ),
      interval_ids: evidenceWaits.map(
        (action) => `R004:${action.action_id}`,
      ),
      latency_classification: classification,
      count: evidenceWaits.length,
      approval_count: approvals.length,
      total_wait_ms: totalWaitMs,
      approval_wait_ms: recoverable.estimated_ms,
      non_approval_wait_ms: nonApprovalWaitMs,
      approval_detection: sortedUnique(
        approvals.map(({ source }) => source),
      ),
      approval_reasons: sortedUnique(
        approvals.flatMap(({ reason }) =>
          reason === undefined ? [] : [reason]
        ),
      ),
      ...(canonicalCommands === undefined
        ? {}
        : { canonical_commands: [...canonicalCommands] }),
    },
    intervals: recoverable.intervals,
    fix_recipe: {
      suggestion: isGeneric
        ? "Review whether the measured approval latency is required by policy before changing permissions."
        : `Ask an administrator to review an allowlist change for these repeated safe approval commands: ${commandList}.`,
      verify: "ccprof --json",
    },
    caveats: sortedUnique([
      ...(nonApprovalWaitMs > 0
        ? [
            "Non-approval human wait is evidence only and is not included in approval latency.",
          ]
        : []),
      ...(phraseBased
        ? ["Approval phrase matching uses a small conservative phrase set."]
        : []),
      ...(approvals.length === 0
        ? ["No approval cause was proven, so observed approval latency is zero."]
        : []),
      ...(recoverable.bound === "upper"
        ? ["An approval wait overlapped another agent."]
        : []),
    ]),
  });
}

export function detectHumanWait(
  actions: readonly AttributedTimelineAction[],
  options: HumanWaitOptions = {},
) {
  const waits = orderedActions(actions).filter(
    (action) =>
      action.kind === "human_wait" &&
      normalizeInterval(action.interval) !== null,
  );
  if (waits.length === 0) return [];

  const assistantsByRef = new Map(
    (options.assistantEvents ?? []).map((event) => [
      event.session_ref,
      event,
    ]),
  );
  const approvals = waits.flatMap((action) => {
    const signal = approvalSignal(action, assistantsByRef);
    return signal === undefined ? [] : [signal];
  });
  const partitions = partitionApprovals(approvals, options.ruleSafety);
  const approvalActions = new Set(approvals.map(({ action }) => action));
  const genericApprovalActions = new Set(
    partitions.generic.map(({ action }) => action),
  );
  const repeatedActions = new Set(
    partitions.repeatedSafe.map(({ action }) => action),
  );
  const genericEvidenceWaits = waits.filter(
    (action) =>
      !approvalActions.has(action) || genericApprovalActions.has(action),
  );
  const repeatedEvidenceWaits = waits.filter((action) =>
    repeatedActions.has(action)
  );
  const sourceCompleteness = options.sourceCompleteness ?? 1;

  return [
    ...(genericEvidenceWaits.length === 0
      ? []
      : [latencyCandidate(
          "approval_policy_latency",
          genericEvidenceWaits,
          partitions.generic,
          sourceCompleteness,
        )]),
    ...(repeatedEvidenceWaits.length === 0
      ? []
      : [latencyCandidate(
          "repeated_safe_approval_latency",
          repeatedEvidenceWaits,
          partitions.repeatedSafe,
          sourceCompleteness,
          partitions.repeatedCanonicalCommands,
        )]),
  ];
}
