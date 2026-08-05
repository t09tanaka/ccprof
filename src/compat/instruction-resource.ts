import {
  CANONICAL_FINDING_SCOPES,
  parseFindingScope,
} from "../core/finding-scope.js";
import type { FindingScope } from "../core/finding-scope.js";
import {
  CANONICAL_ADOPTION_METHODS,
  parseAdoptionMethod,
} from "../analysis/adoption-identity.js";
import type { AdoptionMethod } from "../analysis/adoption-identity.js";

export const LEGACY_FINDING_SCOPES = Object.freeze({
  this_pr: "this_pr",
  separate_issue: "separate_issue",
  claude_md: "claude_md",
} as const);

export type LegacyFindingScope =
  (typeof LEGACY_FINDING_SCOPES)[keyof typeof LEGACY_FINDING_SCOPES];

export const LEGACY_ADOPTION_METHODS = Object.freeze({
  target_file_edit: "target_file_edit",
  claude_md_edit: "claude_md_edit",
} as const);

export type LegacyAdoptionMethod =
  (typeof LEGACY_ADOPTION_METHODS)[keyof typeof LEGACY_ADOPTION_METHODS];

export function normalizeFindingScopeIdentity(value: unknown): FindingScope {
  if (value === LEGACY_FINDING_SCOPES.claude_md) {
    return CANONICAL_FINDING_SCOPES.instruction_resource;
  }
  return parseFindingScope(value);
}

export function projectLegacyFindingScope(value: unknown): LegacyFindingScope {
  const scope = parseFindingScope(value);
  return scope === CANONICAL_FINDING_SCOPES.instruction_resource
    ? LEGACY_FINDING_SCOPES.claude_md
    : scope;
}

export function normalizeAdoptionMethodIdentity(
  value: unknown,
): AdoptionMethod {
  if (value === LEGACY_ADOPTION_METHODS.claude_md_edit) {
    return CANONICAL_ADOPTION_METHODS.instruction_resource_edit;
  }
  return parseAdoptionMethod(value);
}

export function projectLegacyAdoptionMethod(
  value: unknown,
): LegacyAdoptionMethod {
  const method = parseAdoptionMethod(value);
  return method === CANONICAL_ADOPTION_METHODS.instruction_resource_edit
    ? LEGACY_ADOPTION_METHODS.claude_md_edit
    : method;
}

export const CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY = Object.freeze({
  resource: Object.freeze({
    path: "CLAUDE.md",
    legacy_finding_scope: LEGACY_FINDING_SCOPES.claude_md,
    canonical_finding_scope: CANONICAL_FINDING_SCOPES.instruction_resource,
  }),
  detector: Object.freeze({
    evidence_path: "CLAUDE.md",
    legacy_adoption_method: LEGACY_ADOPTION_METHODS.claude_md_edit,
    canonical_adoption_method:
      CANONICAL_ADOPTION_METHODS.instruction_resource_edit,
    qualifier: "suggestion_keyword_in_added_text_after_recorded_at",
    selection: "oldest_qualifying_commit",
  }),
} as const);
