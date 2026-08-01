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
}

interface ApprovalSignal {
  action: AttributedTimelineAction;
  source: "explicit" | "phrase";
  confidence: Confidence;
  reason?: string;
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
  const approvalActions = approvals.map(({ action }) => action);
  const recoverable = recoverableClaim(
    "R004",
    "approval-wait",
    approvalActions,
  );
  const totalWaitMs = durationMs(waits.map((action) => action.interval));
  const nonApprovalWaitMs = durationMs(
    subtractIntervals(
      waits.map((action) => action.interval),
      approvalActions.map((action) => action.interval),
    ),
  );
  const phraseBased = approvals.some(({ source }) => source === "phrase");
  const confidence =
    approvals.length === 0
      ? "low"
      : minimumConfidence(approvals.map((signal) => signal.confidence));

  return [createFindingCandidate({
    rule_id: "R004",
    title: "Approval-related human wait",
    classification: "config",
    cause: null,
    scope: "separate_issue",
    confidence,
    target: "approval-wait",
    evidence: {
      session_refs: sortedUnique(
        waits.flatMap((action) => action.session_refs),
      ),
      interval_ids: waits.map((action) => `R004:${action.action_id}`),
      count: waits.length,
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
    },
    recoverable,
    fix_recipe: {
      suggestion:
        "Add the repeated safe approval pattern to the agent permission allowlist in a separate configuration change.",
      verify: "ccprof --json",
    },
    caveats: sortedUnique([
      "Non-approval human wait is evidence only and is not included in recoverable time.",
      ...(phraseBased
        ? ["Approval phrase matching uses a small conservative phrase set."]
        : []),
      ...(approvals.length === 0
        ? ["No approval cause was proven, so no recoverable time is claimed."]
        : []),
      ...(recoverable.bound === "upper"
        ? ["An approval wait overlapped another agent, so recoverable time is an upper bound."]
        : []),
    ]),
  })];
}
