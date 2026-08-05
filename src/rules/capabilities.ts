/**
 * Per-rule session capability requirements.
 *
 * A rule is listed against a `SessionCapability` when the corresponding
 * event field is load-bearing for that rule's detection logic: without it,
 * the rule is structurally blind (it silently finds nothing) or would
 * misattribute evidence it does not actually have. Verified against each
 * rule's implementation in `src/rules/*.ts`:
 *
 * - R001 (rework): `edit_fragments`. `matchEdit` in
 *   `src/analysis/diff-matcher.ts` classifies an edit as `rework_edit`
 *   primarily from surviving/absent edit fragments; without fragments, most
 *   edits degrade to low-confidence `contributing_edit` (or fall back to
 *   revert-commit evidence only), so `detectRework`, which only looks at
 *   `match === "rework_edit"`, misses genuine rework.
 * - R002 (redundant-runs): none. Operates on already-matched
 *   `redundant_run` actions and command strings/timestamps only.
 * - R003 (rediscovery): none. `estimatedTokensByEventIdentity` is optional,
 *   evidence-only input (see `missingTokenEvidence` caveat); its absence
 *   degrades an evidence field, it does not block detection.
 * - R004 (human-wait): none. Explicit `ToolUseEvent.approval` is one of two
 *   detection paths; the phrase-based fallback already covers sessions
 *   without it, so approvals data is not load-bearing for this rule.
 * - R005 (serial-slack): `tool_timestamps`. Action intervals come from
 *   `tool_use`/`tool_result` timestamps (`toolAction` in
 *   `src/analysis/timeline.ts`); without distinct, accurate per-tool
 *   timestamps every action collapses to a zero-duration interval, and
 *   `detectSerialSlack` (which measures serial-duration-minus-longest-call)
 *   would find nothing.
 * - R006 (chronic-cost): none. Reads historical `AnalysisRecord`s, not
 *   session events.
 * - R007 (context-bloat): `token_usage`. Detection is driven entirely by
 *   `ToolResultEvent.estimated_tokens` / `CompactionEvent.estimated_tokens`
 *   token-count evidence; without it the large-result and compaction
 *   grouping in `detectContextBloat` has nothing to threshold against.
 * - R008 (flaky-test): none. Uses test run pass/fail classification and
 *   edit relevance, not any of the six capabilities.
 */

import type {
  AnalysisWindow,
  RuleCoverage,
  RuleId,
  Session,
  SessionCapability,
} from "../core/model.js";
import {
  CAPABILITY_DESCRIPTOR_VERSION,
  supportsCapability,
} from "../protocol/capability-descriptor.js";
import { listRuleManifests } from "./manifest.js";

export const RULE_REQUIRED_CAPABILITIES: Readonly<
  Record<RuleId, readonly SessionCapability[]>
> = Object.freeze(Object.fromEntries(listRuleManifests().map((manifest) => [
  manifest.id,
  Object.freeze([...manifest.required_capabilities]),
]))) as Readonly<Record<RuleId, readonly SessionCapability[]>>;

export interface RuleApplicability {
  rule_id: RuleId;
  applicable: boolean;
  missing: SessionCapability[];
}

export function sessionSupportsCapability(
  session: Session,
  capability: SessionCapability,
): boolean {
  return session.capabilities?.includes(capability) === true &&
    session.capability_descriptor !== undefined &&
    supportsCapability(session.capability_descriptor, {
      id: `ccprof.dev/capabilities/${capability}`,
      version: CAPABILITY_DESCRIPTOR_VERSION,
    });
}

export function sessionSupportsRule(
  session: Session,
  ruleId: RuleId,
): boolean {
  return RULE_REQUIRED_CAPABILITIES[ruleId].every((capability) =>
    sessionSupportsCapability(session, capability)
  );
}

const PARSER_TRUNCATION_WARNING =
  /^parser_(?:(?:file|line|node|depth|byte|warning)_budget_exceeded|[a-z0-9_]*truncated)$/u;

function parserEvidenceTruncated(session: Session): boolean {
  return session.warnings.some(({ code }) =>
    PARSER_TRUNCATION_WARNING.test(code)
  );
}

export function ruleCoverage(
  sessions: readonly Session[],
  windowCompleteness: AnalysisWindow["completeness"] = "complete",
): RuleCoverage[] {
  const totalSessions = sessions.length;
  const ruleIds = (Object.keys(RULE_REQUIRED_CAPABILITIES) as RuleId[]).sort();
  return ruleIds.map((rule_id): RuleCoverage => {
    const required = RULE_REQUIRED_CAPABILITIES[rule_id];
    const eligible = sessions.filter((session) =>
      sessionSupportsRule(session, rule_id)
    );
    const missing = [...new Set(sessions.flatMap((session) =>
      required.filter((capability) =>
        !sessionSupportsCapability(session, capability)
      )
    ))].sort((left, right) => left.localeCompare(right));
    const eligibleSessions = eligible.length;
    return {
      rule_id,
      eligible_sessions: eligibleSessions,
      total_sessions: totalSessions,
      status: eligibleSessions === totalSessions ? "full" : "partial",
      missing_capabilities: missing,
      completeness: totalSessions === 0 ? 1 : eligibleSessions / totalSessions,
      truncated: windowCompleteness === "partial" ||
        eligible.some(parserEvidenceTruncated),
    };
  });
}

/**
 * For each rule, a session must have every capability the rule requires.
 * If any session in `sessions` lacks a required capability, the rule is
 * marked inapplicable and that capability is listed in `missing`.
 */
export function ruleApplicability(
  sessions: readonly Session[],
): RuleApplicability[] {
  return ruleCoverage(sessions).map((entry) => ({
    rule_id: entry.rule_id,
    applicable: entry.status === "full",
    missing: [...entry.missing_capabilities],
  }));
}
