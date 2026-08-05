export const CANONICAL_ADOPTION_METHODS = Object.freeze({
  target_file_edit: "target_file_edit",
  instruction_resource_edit: "instruction_resource_edit",
} as const);

export type AdoptionMethod =
  (typeof CANONICAL_ADOPTION_METHODS)[keyof typeof CANONICAL_ADOPTION_METHODS];

export type AdoptionMethodValidationCode = "invalid_adoption_method";

export class AdoptionMethodValidationError extends TypeError {
  readonly code: AdoptionMethodValidationCode;

  constructor(code: AdoptionMethodValidationCode) {
    super(`invalid adoption method: ${code}`);
    this.name = "AdoptionMethodValidationError";
    this.code = code;
  }
}

const CANONICAL_ADOPTION_METHOD_VALUES = new Set<string>(
  Object.values(CANONICAL_ADOPTION_METHODS),
);

export function parseAdoptionMethod(value: unknown): AdoptionMethod {
  if (
    typeof value !== "string" ||
    !CANONICAL_ADOPTION_METHOD_VALUES.has(value)
  ) {
    throw new AdoptionMethodValidationError("invalid_adoption_method");
  }
  return value as AdoptionMethod;
}
