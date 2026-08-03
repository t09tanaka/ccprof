import { createHash } from "node:crypto";

import { durationMs, normalizeInterval } from "../core/intervals.js";
import { encodeEventIdentity } from "../core/event-identity.js";
import {
  findingScoringRationale,
  findingSeverity,
  projectFindingConfidence,
  projectFindingRecoverable,
  snapshotFindingConfidence,
  snapshotImpactEstimate,
} from "../core/model.js";
import type {
  Confidence,
  FindingCandidate,
  FindingEvidence,
  ImpactEstimate,
  JsonObject,
  JsonValue,
  RecoverableClaim,
  RecoverableInterval,
  RuleId,
  TimelineAction,
} from "../core/model.js";
import { ruleManifest } from "./manifest.js";

export interface FindingCandidateInput
  extends Omit<
    FindingCandidate,
    | "finding_key"
    | "target"
    | "evidence"
    | "caveats"
    | "confidence"
    | "recoverable"
    | "severity"
    | "scoring_rationale"
  > {
  target: string;
  evidence: FindingEvidence;
  caveats: readonly string[];
  intervals: readonly RecoverableInterval[];
  policy_dependent?: boolean;
}

export function normalizeFindingTarget(target: string): string {
  const normalized = target.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (normalized === "") {
    throw new TypeError("finding target must be non-empty");
  }
  return normalized;
}

export function findingKeyForCompatibility(
  ruleId: RuleId,
  target: string,
  epoch: number,
): string {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new TypeError("compatibility epoch must be a positive safe integer");
  }
  const prefix = epoch === 1 ? ruleId : `${ruleId}@${epoch}`;
  return createHash("sha256")
    .update(`${prefix}\0${normalizeFindingTarget(target)}`)
    .digest("hex");
}

export function findingKey(ruleId: RuleId, target: string): string {
  return findingKeyForCompatibility(
    ruleId,
    target,
    ruleManifest(ruleId).compatibility_epoch,
  );
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ""))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function canonicalJson(value: JsonValue, propertyName?: string): JsonValue {
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) {
      return propertyName === "normalized_argv" ? [...value] : sortedUnique(value);
    }
    return value.map((entry) => canonicalJson(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry, key)]),
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
  const impact = snapshotImpactEstimate(input.impact);
  const findingConfidence = snapshotFindingConfidence(
    input.finding_confidence,
  );
  const projectedRecoverable = projectFindingRecoverable(impact);
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
    finding_key: findingKey(input.rule_id, target),
    rule_id: input.rule_id,
    title: input.title,
    classification: input.classification,
    cause: input.cause,
    scope: input.scope,
    confidence: projectFindingConfidence(findingConfidence),
    target,
    evidence,
    impact,
    finding_confidence: findingConfidence,
    severity: findingSeverity(impact, findingConfidence),
    scoring_rationale: findingScoringRationale(impact, findingConfidence, {
      ...(input.policy_dependent === true ? { policy_dependent: true } : {}),
    }),
    recoverable: {
      bound: projectedRecoverable.bound,
      estimated_ms: impact.upper_ms,
      intervals: input.intervals.map((interval) => ({ ...interval })),
    },
    fix_recipe: {
      suggestion: input.fix_recipe.suggestion.trim(),
      verify: input.fix_recipe.verify.trim(),
    },
    caveats: sortedUnique(input.caveats),
  };
}

export function impactFromClaim(
  claim: RecoverableClaim,
  kind: ImpactEstimate["kind"],
): ImpactEstimate {
  return {
    lower_ms: claim.bound === "point" ? claim.estimated_ms : 0,
    upper_ms: claim.estimated_ms,
    kind,
  };
}

export function recoverableClaim(
  ruleId: RuleId,
  target: string,
  actions: readonly Pick<
    TimelineAction,
    "action_id" | "concurrent" | "event_identity" | "interval"
  >[],
): RecoverableClaim {
  const normalizedTarget = normalizeFindingTarget(target);
  const normalizedActions = actions.flatMap((action) => {
    const interval = normalizeInterval(action.interval);
    if (interval === null) return [];
    return [{
      action,
      interval,
      baseIntervalId: `${ruleId}:${action.action_id}`,
      identityKey: action.event_identity === undefined
        ? undefined
        : encodeEventIdentity(action.event_identity),
    }];
  });
  const identitiesByBaseId = new Map<string, Set<string | undefined>>();
  for (const { baseIntervalId, identityKey } of normalizedActions) {
    const identities = identitiesByBaseId.get(baseIntervalId) ??
      new Set<string | undefined>();
    identities.add(identityKey);
    identitiesByBaseId.set(baseIntervalId, identities);
  }
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
  for (const {
    action,
    interval,
    baseIntervalId,
    identityKey,
  } of normalizedActions) {
    const identityCollision =
      (identitiesByBaseId.get(baseIntervalId)?.size ?? 0) > 1;
    const intervalId = identityCollision && identityKey !== undefined
      ? `${baseIntervalId}:${createHash("sha256")
        .update("ccprof:recoverable-interval-identity:v1\0", "utf8")
        .update(identityKey, "utf8")
        .digest("hex")
        .slice(0, 32)}`
      : baseIntervalId;
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
