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
 * - R003 (rediscovery): none. `estimatedTokensByToolUseId` is optional,
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

import type { RuleId, Session, SessionCapability } from "../core/model.js";

export const RULE_REQUIRED_CAPABILITIES: Readonly<
  Record<RuleId, readonly SessionCapability[]>
> = {
  R001: ["edit_fragments"],
  R002: [],
  R003: [],
  R004: [],
  R005: ["tool_timestamps"],
  R006: [],
  R007: ["token_usage"],
  R008: [],
};

export interface RuleApplicability {
  rule_id: RuleId;
  applicable: boolean;
  missing: SessionCapability[];
}

function sessionHasCapability(
  session: Session,
  capability: SessionCapability,
): boolean {
  return (
    session.capabilities === undefined ||
    session.capabilities.includes(capability)
  );
}

/**
 * For each rule, a session must have every capability the rule requires.
 * If any session in `sessions` lacks a required capability, the rule is
 * marked inapplicable and that capability is listed in `missing`.
 */
export function ruleApplicability(
  sessions: readonly Session[],
): RuleApplicability[] {
  const ruleIds = Object.keys(RULE_REQUIRED_CAPABILITIES) as RuleId[];
  return ruleIds.map((rule_id) => {
    const required = RULE_REQUIRED_CAPABILITIES[rule_id];
    const missing = required.filter((capability) =>
      sessions.some((session) => !sessionHasCapability(session, capability))
    );
    return { rule_id, applicable: missing.length === 0, missing };
  });
}
