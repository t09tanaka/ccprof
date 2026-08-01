import { createHash } from "node:crypto";

import { durationMs, normalizeInterval } from "../core/intervals.js";
import type {
  Confidence,
  FindingCandidate,
  FindingEvidence,
  JsonObject,
  JsonValue,
  RecoverableClaim,
  RuleId,
  TimelineAction,
} from "../core/model.js";

export interface FindingCandidateInput
  extends Omit<FindingCandidate, "finding_key" | "target" | "evidence" | "caveats"> {
  target: string;
  evidence: FindingEvidence;
  caveats: readonly string[];
}

export function normalizeFindingTarget(target: string): string {
  const normalized = target.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (normalized === "") {
    throw new TypeError("finding target must be non-empty");
  }
  return normalized;
}

export function findingKey(ruleId: RuleId, target: string): string {
  return createHash("sha256")
    .update(`${ruleId}\0${normalizeFindingTarget(target)}`)
    .digest("hex");
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) {
      return sortedUnique(value);
    }
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function canonicalEvidence(evidence: FindingEvidence): FindingEvidence {
  const canonical = canonicalJson(evidence as JsonObject) as JsonObject;
  return {
    ...canonical,
    session_refs: sortedUnique(evidence.session_refs),
    interval_ids: sortedUnique(evidence.interval_ids),
  };
}

export function createFindingCandidate(
  input: FindingCandidateInput,
): FindingCandidate {
  const target = normalizeFindingTarget(input.target);
  const evidence = canonicalEvidence(input.evidence);
  const errors: string[] = [];
  if (evidence.session_refs.length === 0) {
    errors.push("evidence session refs must be non-empty");
  }
  if (
    input.fix_recipe.suggestion.trim() === "" ||
    input.fix_recipe.verify.trim() === ""
  ) {
    errors.push("recipe suggestion and verify fields must be non-empty");
  }
  if (errors.length > 0) {
    throw new TypeError(`invalid finding: ${errors.join("; ")}`);
  }
  return {
    ...input,
    finding_key: findingKey(input.rule_id, target),
    target,
    evidence,
    recoverable: {
      ...input.recoverable,
      intervals: [...input.recoverable.intervals],
    },
    fix_recipe: {
      suggestion: input.fix_recipe.suggestion.trim(),
      verify: input.fix_recipe.verify.trim(),
    },
    caveats: sortedUnique(input.caveats),
  };
}

export function recoverableClaim(
  ruleId: RuleId,
  target: string,
  actions: readonly Pick<
    TimelineAction,
    "action_id" | "concurrent" | "interval"
  >[],
): RecoverableClaim {
  const normalizedTarget = normalizeFindingTarget(target);
  const byId = new Map<
    string,
    {
      interval_id: string;
      target: string;
      start_ms: number;
      end_ms: number;
      concurrent: boolean;
    }
  >();
  for (const action of actions) {
    const interval = normalizeInterval(action.interval);
    if (interval === null) continue;
    const intervalId = `${ruleId}:${action.action_id}`;
    const existing = byId.get(intervalId);
    if (
      existing !== undefined &&
      (existing.start_ms !== interval.start_ms ||
        existing.end_ms !== interval.end_ms)
    ) {
      throw new TypeError(`conflicting interval id: ${intervalId}`);
    }
    byId.set(intervalId, {
      interval_id: intervalId,
      target: normalizedTarget,
      ...interval,
      concurrent: action.concurrent || existing?.concurrent === true,
    });
  }
  const entries = [...byId.values()].sort(
    (left, right) =>
      left.start_ms - right.start_ms ||
      left.end_ms - right.end_ms ||
      left.interval_id.localeCompare(right.interval_id),
  );
  return {
    bound: entries.some((entry) => entry.concurrent) ? "upper" : "point",
    estimated_ms: durationMs(entries),
    intervals: entries.map(({ concurrent: _concurrent, ...interval }) => interval),
  };
}

export function minimumConfidence(
  values: readonly Confidence[],
): Confidence {
  const rank: Record<Confidence, number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  return values.reduce<Confidence>(
    (minimum, value) => rank[value] < rank[minimum] ? value : minimum,
    "high",
  );
}

export function orderedActions<T extends TimelineAction>(
  actions: readonly T[],
): T[] {
  return [...actions].sort(
    (left, right) =>
      left.interval.start_ms - right.interval.start_ms ||
      left.interval.end_ms - right.interval.end_ms ||
      left.session_id.localeCompare(right.session_id) ||
      left.agent_id.localeCompare(right.agent_id) ||
      left.action_id.localeCompare(right.action_id),
  );
}
