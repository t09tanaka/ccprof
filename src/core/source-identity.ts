export type NamespacedSourceIdentity = string;
export type ProducerId = NamespacedSourceIdentity;
export type SourceAdapterId = NamespacedSourceIdentity;
export type SourceKind = NamespacedSourceIdentity;

export type LegacySourceAdapterId = "claude" | "codex";
export type LegacySourceKind =
  | "claude_transcript_jsonl"
  | "codex_rollout_jsonl";

export const CANONICAL_SOURCE_ADAPTER_IDS = Object.freeze({
  claude: "ccprof.dev/adapters/claude",
  codex: "ccprof.dev/adapters/codex",
} satisfies Readonly<Record<LegacySourceAdapterId, SourceAdapterId>>);

export const CANONICAL_SOURCE_KIND_IDS = Object.freeze({
  claude_transcript_jsonl:
    "ccprof.dev/source-kinds/claude-transcript-jsonl",
  codex_rollout_jsonl: "ccprof.dev/source-kinds/codex-rollout-jsonl",
} satisfies Readonly<Record<LegacySourceKind, SourceKind>>);

export type SourceIdentityValidationCode = "invalid_namespaced_name";

export class SourceIdentityValidationError extends TypeError {
  readonly code: SourceIdentityValidationCode;

  constructor(code: SourceIdentityValidationCode) {
    super(`invalid source identity: ${code}`);
    this.name = "SourceIdentityValidationError";
    this.code = code;
  }
}

const NAMESPACED_NAME_PATTERN =
  /^(?:[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\/[a-z][a-z0-9._-]{0,63})*(?![\s\S])/u;
const MAX_NAMESPACED_NAME_LENGTH = 255;

function parseNamespacedSourceIdentity(
  value: unknown,
): NamespacedSourceIdentity {
  if (
    typeof value !== "string" ||
    value.length > MAX_NAMESPACED_NAME_LENGTH ||
    !NAMESPACED_NAME_PATTERN.test(value)
  ) {
    throw new SourceIdentityValidationError("invalid_namespaced_name");
  }
  return value;
}

export function parseProducerId(value: unknown): ProducerId {
  return parseNamespacedSourceIdentity(value);
}

export function parseSourceAdapterId(value: unknown): SourceAdapterId {
  return parseNamespacedSourceIdentity(value);
}

export function parseSourceKind(value: unknown): SourceKind {
  return parseNamespacedSourceIdentity(value);
}

function legacyValue<T extends string>(
  compatibility: Readonly<Record<T, string>>,
  value: unknown,
): string | undefined {
  return typeof value === "string" && Object.hasOwn(compatibility, value)
    ? compatibility[value as T]
    : undefined;
}

export function normalizeSourceAdapterId(value: unknown): SourceAdapterId {
  return legacyValue(CANONICAL_SOURCE_ADAPTER_IDS, value) ??
    parseSourceAdapterId(value);
}

export function normalizeSourceKind(value: unknown): SourceKind {
  return legacyValue(CANONICAL_SOURCE_KIND_IDS, value) ?? parseSourceKind(value);
}

function projectLegacyValue<T extends string>(
  compatibility: Readonly<Record<T, string>>,
  value: string,
): T | undefined {
  for (const legacy of Object.keys(compatibility) as T[]) {
    if (compatibility[legacy] === value) return legacy;
  }
  return undefined;
}

export function projectLegacySourceAdapterId(
  value: SourceAdapterId,
): LegacySourceAdapterId | undefined {
  return projectLegacyValue(CANONICAL_SOURCE_ADAPTER_IDS, value);
}

export function projectLegacySourceKind(
  value: SourceKind,
): LegacySourceKind | undefined {
  return projectLegacyValue(CANONICAL_SOURCE_KIND_IDS, value);
}

export function compareSourceIdentities(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
