export const CANONICAL_FINDING_SCOPES = Object.freeze({
  this_pr: "this_pr",
  separate_issue: "separate_issue",
  instruction_resource: "instruction_resource",
} as const);

export type FindingScope =
  (typeof CANONICAL_FINDING_SCOPES)[keyof typeof CANONICAL_FINDING_SCOPES];

export type FindingScopeValidationCode = "invalid_finding_scope";

export class FindingScopeValidationError extends TypeError {
  readonly code: FindingScopeValidationCode;

  constructor(code: FindingScopeValidationCode) {
    super(`invalid finding scope: ${code}`);
    this.name = "FindingScopeValidationError";
    this.code = code;
  }
}

const CANONICAL_FINDING_SCOPE_VALUES = new Set<string>(
  Object.values(CANONICAL_FINDING_SCOPES),
);

export function parseFindingScope(value: unknown): FindingScope {
  if (
    typeof value !== "string" ||
    !CANONICAL_FINDING_SCOPE_VALUES.has(value)
  ) {
    throw new FindingScopeValidationError("invalid_finding_scope");
  }
  return value as FindingScope;
}
