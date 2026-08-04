import { types as utilTypes } from "node:util";

import {
  classifyCommand,
  tokenizeCommand,
} from "../analysis/command.js";

export interface ApprovalRulePolicy {
  safe_patterns: string[];
  allow_rule_recommendation: boolean;
}

export interface RepositoryApprovalRulePolicy {
  safe_patterns?: string[];
  allow_rule_recommendation?: boolean;
}

export interface ResourceDomainPolicy {
  match: string[];
  domain: string;
  parallel_safe: boolean;
}

export interface EffectiveRuleSafetyPolicy {
  approval?: {
    allow_rule_recommendation: boolean;
    organization_safe_patterns: string[];
    repository_safe_patterns?: string[];
  };
  organization_resource_domains: ResourceDomainPolicy[];
  repository_resource_domains?: ResourceDomainPolicy[];
}

export type ApprovalCommandDecision =
  | { allowed: true; canonical_command: string }
  | { allowed: false };

export type ApprovalRecommendationDecision =
  | { kind: "evaluated"; commands: ApprovalCommandDecision[] }
  | { kind: "denied" };

export type ResourceDomainDecision =
  | { kind: "parallel_safe" | "parallel_unsafe"; domain: string }
  | { kind: "investigation_candidate" };

export interface DecisionBudget {
  remaining: number;
  exhausted: boolean;
}

const MAX_PATTERNS = 64;
const MAX_DOMAINS = 64;
const MAX_DOMAIN_PATTERNS = 32;
const MAX_PATTERN_BYTES = 256;
const MAX_WILDCARDS = 16;
const MAX_COMMAND_BYTES = 4_096;
const MAX_DECISION_ACTIONS = 64;
const MAX_UNIQUE_COMMANDS = 32;
const MAX_DECISION_STEPS = 65_536;
const SAFE_COMMAND_FIXED_STEPS = 4;

const APPROVAL_KEYS = new Set([
  "safe_patterns",
  "allow_rule_recommendation",
]);
const RESOURCE_DOMAIN_KEYS = new Set([
  "match",
  "domain",
  "parallel_safe",
]);
const EFFECTIVE_KEYS = new Set([
  "approval",
  "organization_resource_domains",
  "repository_resource_domains",
]);
const EFFECTIVE_APPROVAL_KEYS = new Set([
  "allow_rule_recommendation",
  "organization_safe_patterns",
  "repository_safe_patterns",
]);
const DOMAIN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const BARE_EXECUTABLE = /^[A-Za-z0-9_.-]+$/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*$/su;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const SIMPLE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/u;

const WINDOWS_LAUNCHERS = new Map<string, string>([
  ["npm.cmd", "npm"],
  ["pnpm.cmd", "pnpm"],
  ["yarn.cmd", "yarn"],
  ["bun.exe", "bun"],
  ["cargo.exe", "cargo"],
  ["git.exe", "git"],
  ["node.exe", "node"],
  ["rg.exe", "rg"],
]);

const READ_ONLY_EXECUTABLES = new Set([
  "cat",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "stat",
  "tail",
  "wc",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

const UNSAFE_GIT_OPTIONS = [
  "--ext-diff",
  "--output",
  "--textconv",
  "--open-files-in-pager",
] as const;
const GIT_GREP_PAGER_OPTION = "--open-files-in-pager";
const GIT_GREP_PAGER_MINIMUM_PREFIX = "--op";

export class RuleSafetyPolicyValidationError extends Error {
  constructor() {
    super("invalid rule safety policy");
    this.name = "RuleSafetyPolicyValidationError";
  }
}

function invalid(): never {
  throw new RuleSafetyPolicyValidationError();
}

function validated<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof RuleSafetyPolicyValidationError) throw error;
    invalid();
  }
}

function captureClosedObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (
    typeof value !== "object" || value === null ||
    utilTypes.isProxy(value) || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid();
  }
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) invalid();
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined || !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalid();
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function captureArray(value: unknown, maxLength: number): unknown[] {
  if (
    typeof value !== "object" || value === null ||
    utilTypes.isProxy(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    invalid();
  }
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 || lengthDescriptor.value > maxLength
  ) {
    invalid();
  }
  const length = lengthDescriptor.value as number;
  const allowedKeys = new Set<string>(["length"]);
  const captured: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined || !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalid();
    }
    captured.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) invalid();
  }
  return captured;
}

function boundedUtf8(value: string, maxBytes: number): boolean {
  return value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes;
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function normalizeCommandPattern(value: string): string {
  return validated(() => {
    if (typeof value !== "string" || !boundedUtf8(value, MAX_PATTERN_BYTES)) {
      invalid();
    }
    const normalized = value
      .normalize("NFC")
      .trim()
      .replace(/\s+/gu, " ")
      .replace(/\*+/gu, "*");
    if (
      normalized === "" || CONTROL.test(normalized) ||
      !boundedUtf8(normalized, MAX_PATTERN_BYTES)
    ) {
      invalid();
    }
    let wildcards = 0;
    for (const character of normalized) {
      if (character === "*") wildcards += 1;
    }
    if (wildcards > MAX_WILDCARDS) invalid();
    return normalized;
  });
}

function snapshotPatterns(value: unknown, maxLength: number): string[] {
  const patterns = captureArray(value, maxLength).map((entry) => {
    if (typeof entry !== "string") invalid();
    return normalizeCommandPattern(entry);
  }).sort(compareUtf8);
  for (let index = 1; index < patterns.length; index += 1) {
    if (patterns[index - 1] === patterns[index]) invalid();
  }
  return patterns;
}

function snapshotApproval(value: unknown): ApprovalRulePolicy {
  const captured = captureClosedObject(value, APPROVAL_KEYS);
  if (typeof captured.allow_rule_recommendation !== "boolean") invalid();
  return {
    safe_patterns: snapshotPatterns(captured.safe_patterns, MAX_PATTERNS),
    allow_rule_recommendation: captured.allow_rule_recommendation,
  };
}

export function snapshotApprovalRulePolicy(
  value: unknown,
): ApprovalRulePolicy {
  return validated(() => snapshotApproval(value));
}

function snapshotRepositoryApproval(
  value: unknown,
): RepositoryApprovalRulePolicy {
  const captured = captureClosedObject(value, APPROVAL_KEYS);
  const safePatterns = captured.safe_patterns;
  const allowRecommendation = captured.allow_rule_recommendation;
  if (
    allowRecommendation !== undefined &&
    typeof allowRecommendation !== "boolean"
  ) {
    invalid();
  }
  const patterns = safePatterns === undefined
    ? undefined
    : snapshotPatterns(safePatterns, MAX_PATTERNS);
  return {
    ...(patterns === undefined ? {} : { safe_patterns: patterns }),
    ...(allowRecommendation === undefined
      ? {}
      : { allow_rule_recommendation: allowRecommendation }),
  };
}

export function snapshotRepositoryApprovalRulePolicy(
  value: unknown,
): RepositoryApprovalRulePolicy {
  return validated(() => snapshotRepositoryApproval(value));
}

function comparePatternArrays(
  left: readonly string[],
  right: readonly string[],
): number {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    const compared = compareUtf8(left[index] as string, right[index] as string);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function compareResourceDomains(
  left: ResourceDomainPolicy,
  right: ResourceDomainPolicy,
): number {
  const domain = compareUtf8(left.domain, right.domain);
  if (domain !== 0) return domain;
  const matches = comparePatternArrays(left.match, right.match);
  if (matches !== 0) return matches;
  return Number(left.parallel_safe) - Number(right.parallel_safe);
}

function snapshotResourceDomain(value: unknown): ResourceDomainPolicy {
  const captured = captureClosedObject(value, RESOURCE_DOMAIN_KEYS);
  const domain = captured.domain;
  const parallelSafe = captured.parallel_safe;
  if (
    typeof domain !== "string" || !DOMAIN.test(domain) ||
    typeof parallelSafe !== "boolean"
  ) {
    invalid();
  }
  const match = snapshotPatterns(captured.match, MAX_DOMAIN_PATTERNS);
  if (match.length === 0) invalid();
  return { match, domain, parallel_safe: parallelSafe };
}

function snapshotDomains(value: unknown): ResourceDomainPolicy[] {
  const domains = captureArray(value, MAX_DOMAINS)
    .map(snapshotResourceDomain)
    .sort(compareResourceDomains);
  for (let index = 1; index < domains.length; index += 1) {
    if (compareResourceDomains(
      domains[index - 1] as ResourceDomainPolicy,
      domains[index] as ResourceDomainPolicy,
    ) === 0) {
      invalid();
    }
  }
  return domains;
}

export function snapshotResourceDomains(
  value: unknown,
): ResourceDomainPolicy[] {
  return validated(() => snapshotDomains(value));
}

function snapshotEffectiveApproval(value: unknown):
  EffectiveRuleSafetyPolicy["approval"] {
  const captured = captureClosedObject(value, EFFECTIVE_APPROVAL_KEYS);
  const allowRecommendation = captured.allow_rule_recommendation;
  if (typeof allowRecommendation !== "boolean") invalid();
  const organizationPatterns = snapshotPatterns(
    captured.organization_safe_patterns,
    MAX_PATTERNS,
  );
  const repositoryValue = captured.repository_safe_patterns;
  const repositoryPatterns = repositoryValue === undefined
    ? undefined
    : snapshotPatterns(repositoryValue, MAX_PATTERNS);
  return {
    allow_rule_recommendation: allowRecommendation,
    organization_safe_patterns: organizationPatterns,
    ...(repositoryPatterns === undefined
      ? {}
      : { repository_safe_patterns: repositoryPatterns }),
  };
}

function snapshotEffective(value: unknown): EffectiveRuleSafetyPolicy {
  const captured = captureClosedObject(value, EFFECTIVE_KEYS);
  const approvalValue = captured.approval;
  const approval = approvalValue === undefined
    ? undefined
    : snapshotEffectiveApproval(approvalValue);
  const organizationDomains = snapshotDomains(
    captured.organization_resource_domains,
  );
  const repositoryValue = captured.repository_resource_domains;
  const repositoryDomains = repositoryValue === undefined
    ? undefined
    : snapshotDomains(repositoryValue);
  return {
    ...(approval === undefined ? {} : { approval }),
    organization_resource_domains: organizationDomains,
    ...(repositoryDomains === undefined
      ? {}
      : { repository_resource_domains: repositoryDomains }),
  };
}

export function snapshotEffectiveRuleSafetyPolicy(
  value: unknown,
): EffectiveRuleSafetyPolicy {
  return validated(() => snapshotEffective(value));
}

export function canonicalRuleSafetySnapshot(
  value: EffectiveRuleSafetyPolicy,
): EffectiveRuleSafetyPolicy {
  return snapshotEffectiveRuleSafetyPolicy(value);
}

export function resolveRuleSafetyPolicy(
  organizationApproval: ApprovalRulePolicy | undefined,
  organizationDomains: readonly ResourceDomainPolicy[],
  repositoryApproval?: RepositoryApprovalRulePolicy,
  repositoryDomains?: readonly ResourceDomainPolicy[],
): EffectiveRuleSafetyPolicy {
  return validated(() => {
    const organizationApprovalSnapshot = organizationApproval === undefined
      ? undefined
      : snapshotApproval(organizationApproval);
    const organizationDomainSnapshot = snapshotDomains(organizationDomains);
    const repositoryApprovalSnapshot = repositoryApproval === undefined
      ? undefined
      : snapshotRepositoryApproval(repositoryApproval);
    const repositoryDomainSnapshot = repositoryDomains === undefined
      ? undefined
      : snapshotDomains(repositoryDomains);
    const approval = organizationApprovalSnapshot === undefined
      ? undefined
      : {
          allow_rule_recommendation:
            organizationApprovalSnapshot.allow_rule_recommendation &&
            repositoryApprovalSnapshot?.allow_rule_recommendation !== false,
          organization_safe_patterns: [
            ...organizationApprovalSnapshot.safe_patterns,
          ],
          ...(repositoryApprovalSnapshot?.safe_patterns === undefined
            ? {}
            : {
                repository_safe_patterns: [
                  ...repositoryApprovalSnapshot.safe_patterns,
                ],
              }),
        };
    return {
      ...(approval === undefined ? {} : { approval }),
      organization_resource_domains: organizationDomainSnapshot,
      ...(repositoryDomainSnapshot === undefined
        ? {}
        : { repository_resource_domains: repositoryDomainSnapshot }),
    };
  });
}

export function createDecisionBudget(): DecisionBudget {
  return { remaining: MAX_DECISION_STEPS, exhausted: false };
}

function spend(budget: DecisionBudget, amount = 1): boolean {
  if (
    budget.exhausted || !Number.isSafeInteger(amount) || amount < 0 ||
    !Number.isSafeInteger(budget.remaining) || budget.remaining < amount
  ) {
    budget.remaining = 0;
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= amount;
  return true;
}

export function commandPatternMatches(
  canonicalCommand: string,
  normalizedPattern: string,
  budget: DecisionBudget,
): boolean {
  if (
    budget.exhausted || !boundedUtf8(canonicalCommand, MAX_COMMAND_BYTES) ||
    !boundedUtf8(normalizedPattern, MAX_PATTERN_BYTES)
  ) {
    return false;
  }
  let commandIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let retryCommandIndex = 0;
  while (commandIndex < canonicalCommand.length) {
    if (!spend(budget)) return false;
    if (
      patternIndex < normalizedPattern.length &&
      normalizedPattern[patternIndex] === canonicalCommand[commandIndex]
    ) {
      patternIndex += 1;
      commandIndex += 1;
    } else if (normalizedPattern[patternIndex] === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      retryCommandIndex = commandIndex;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      retryCommandIndex += 1;
      commandIndex = retryCommandIndex;
    } else {
      return false;
    }
  }
  while (normalizedPattern[patternIndex] === "*") {
    if (!spend(budget)) return false;
    patternIndex += 1;
  }
  return patternIndex === normalizedPattern.length;
}

function quoteToken(token: string): string {
  return SIMPLE_TOKEN.test(token) ? token : JSON.stringify(token);
}

function mappedCommandTokens(raw: string): string[] | undefined {
  if (!boundedUtf8(raw, MAX_COMMAND_BYTES)) return undefined;
  const tokenized = tokenizeCommand(raw);
  if (tokenized.opaque || tokenized.tokens.length === 0) return undefined;
  const first = tokenized.tokens[0] as string;
  const leading = raw.trimStart();
  const whitespace = leading.search(/\s/u);
  const rawFirst = whitespace < 0 ? leading : leading.slice(0, whitespace);
  if (
    rawFirst !== first ||
    first === "." || first === ".." || first === "env" ||
    first === "command" || ASSIGNMENT.test(first) ||
    !BARE_EXECUTABLE.test(first) || first.includes("/") || first.includes("\\")
  ) {
    return undefined;
  }
  const mapped = WINDOWS_LAUNCHERS.get(first.toLowerCase()) ?? first;
  return [mapped, ...tokenized.tokens.slice(1)];
}

function unsafeGitOption(value: string, subcommand: string): boolean {
  const fixedUnsafe = UNSAFE_GIT_OPTIONS.some(
    (option) => value === option || value.startsWith(`${option}=`),
  );
  if (fixedUnsafe || subcommand !== "grep") return fixedUnsafe;

  // Git parse-options accepts bundled short options and unambiguous long
  // abbreviations. In `git grep`, uppercase O takes an optional pager value,
  // and `--op` is already a unique prefix of --open-files-in-pager.
  if (
    value.startsWith("-") && !value.startsWith("--") &&
    value.slice(1).includes("O")
  ) {
    return true;
  }
  const equals = value.indexOf("=");
  const name = equals < 0 ? value : value.slice(0, equals);
  return name.length >= GIT_GREP_PAGER_MINIMUM_PREFIX.length &&
    GIT_GREP_PAGER_OPTION.startsWith(name);
}

function unsafeInspectOption(executable: string, value: string): boolean {
  return executable === "rg" &&
    (value === "--pre" || value.startsWith("--pre="));
}

export function safeCanonicalCommand(
  raw: string,
  budget?: DecisionBudget,
): string | undefined {
  if (typeof raw !== "string" || !boundedUtf8(raw, MAX_COMMAND_BYTES)) {
    return undefined;
  }
  if (
    budget !== undefined &&
    !spend(budget, raw.length + SAFE_COMMAND_FIXED_STEPS)
  ) {
    return undefined;
  }
  const normalizedRaw = raw.normalize("NFC");
  if (
    CONTROL.test(normalizedRaw) ||
    !boundedUtf8(normalizedRaw, MAX_COMMAND_BYTES)
  ) {
    return undefined;
  }
  const tokens = mappedCommandTokens(normalizedRaw);
  if (tokens === undefined) return undefined;
  const executable = tokens[0] as string;
  const canonical = tokens.map(quoteToken).join(" ");
  if (!boundedUtf8(canonical, MAX_COMMAND_BYTES)) return undefined;

  if (executable === "node") {
    return tokens[1] === "--test" ? canonical : undefined;
  }

  const descriptor = classifyCommand(canonical);
  if (
    descriptor.opaque || descriptor.segmentFamilies !== undefined ||
    descriptor.redirectsOutput === true || descriptor.tokens.length === 0
  ) {
    return undefined;
  }
  if (
    descriptor.family === "test" || descriptor.family === "build" ||
    descriptor.family === "check"
  ) {
    return canonical;
  }
  if (
    descriptor.family === "inspect" &&
    READ_ONLY_EXECUTABLES.has(executable) &&
    !tokens.slice(1).some((value) => unsafeInspectOption(executable, value))
  ) {
    return canonical;
  }
  if (descriptor.family !== "vcs" || executable !== "git") return undefined;
  const subcommand = tokens[1];
  if (
    subcommand === undefined || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) ||
    tokens.slice(2).some((value) => unsafeGitOption(value, subcommand))
  ) {
    return undefined;
  }
  return canonical;
}

function captureDecisionCommands(
  value: unknown,
): Array<string | undefined> | undefined {
  try {
    const entries = captureArray(value, MAX_DECISION_ACTIONS);
    if (entries.some(
      (entry) => entry !== undefined && typeof entry !== "string"
    )) {
      return undefined;
    }
    return entries as Array<string | undefined>;
  } catch {
    return undefined;
  }
}

function canonicalCommands(
  rawCommands: readonly (string | undefined)[],
  budget: DecisionBudget,
): Array<string | undefined> | undefined {
  const cache = new Map<string, string | undefined>();
  const result: Array<string | undefined> = [];
  for (const raw of rawCommands) {
    if (!spend(budget)) return undefined;
    if (raw === undefined) {
      result.push(undefined);
      continue;
    }
    if (!spend(budget)) return undefined;
    if (!cache.has(raw)) {
      if (cache.size >= MAX_UNIQUE_COMMANDS) return undefined;
      cache.set(raw, safeCanonicalCommand(raw, budget));
      if (budget.exhausted) return undefined;
    }
    result.push(cache.get(raw));
  }
  return result;
}

function patternsMatch(
  canonicalCommand: string,
  patterns: readonly string[],
  budget: DecisionBudget,
): boolean | undefined {
  for (const pattern of patterns) {
    if (!spend(budget)) return undefined;
    const matches = commandPatternMatches(canonicalCommand, pattern, budget);
    if (budget.exhausted) return undefined;
    if (matches) return true;
  }
  return false;
}

export function approvalRecommendationDecision(
  rawCommandsValue: readonly (string | undefined)[],
  effectiveValue: EffectiveRuleSafetyPolicy | undefined,
): ApprovalRecommendationDecision {
  if (effectiveValue === undefined) return { kind: "denied" };
  const effective = snapshotEffectiveRuleSafetyPolicy(effectiveValue);
  const approval = effective.approval;
  if (approval === undefined || !approval.allow_rule_recommendation) {
    return { kind: "denied" };
  }
  const rawCommands = captureDecisionCommands(rawCommandsValue);
  if (rawCommands === undefined) return { kind: "denied" };
  const budget = createDecisionBudget();
  const canonical = canonicalCommands(rawCommands, budget);
  if (canonical === undefined) return { kind: "denied" };

  const commands: ApprovalCommandDecision[] = [];
  for (const command of canonical) {
    if (command === undefined) {
      commands.push({ allowed: false });
      continue;
    }
    const organizationMatch = patternsMatch(
      command,
      approval.organization_safe_patterns,
      budget,
    );
    if (organizationMatch === undefined) return { kind: "denied" };
    if (!organizationMatch) {
      commands.push({ allowed: false });
      continue;
    }
    const repositoryMatch = approval.repository_safe_patterns === undefined
      ? true
      : patternsMatch(command, approval.repository_safe_patterns, budget);
    if (repositoryMatch === undefined) return { kind: "denied" };
    commands.push(repositoryMatch
      ? { allowed: true, canonical_command: command }
      : { allowed: false });
  }
  return { kind: "evaluated", commands };
}

interface LayerDomain {
  domain: string;
  parallelSafe: boolean;
}

function domainForCommand(
  canonicalCommand: string,
  domains: readonly ResourceDomainPolicy[],
  budget: DecisionBudget,
): LayerDomain | undefined | null {
  let matched: LayerDomain | undefined;
  for (const entry of domains) {
    if (!spend(budget)) return null;
    const entryMatches = patternsMatch(canonicalCommand, entry.match, budget);
    if (entryMatches === undefined) return null;
    if (!entryMatches) continue;
    if (matched !== undefined) return undefined;
    matched = {
      domain: entry.domain,
      parallelSafe: entry.parallel_safe,
    };
  }
  return matched;
}

export function resourceDomainDecision(
  rawCommandsValue: readonly (string | undefined)[],
  effectiveValue: EffectiveRuleSafetyPolicy | undefined,
): ResourceDomainDecision {
  const investigation = { kind: "investigation_candidate" } as const;
  if (effectiveValue === undefined) return investigation;
  const effective = snapshotEffectiveRuleSafetyPolicy(effectiveValue);
  if (effective.organization_resource_domains.length === 0) {
    return investigation;
  }
  const rawCommands = captureDecisionCommands(rawCommandsValue);
  if (rawCommands === undefined || rawCommands.length === 0) {
    return investigation;
  }
  const budget = createDecisionBudget();
  const canonical = canonicalCommands(rawCommands, budget);
  if (
    canonical === undefined ||
    canonical.some((command) => command === undefined)
  ) {
    return investigation;
  }
  const ordered = (canonical as string[]).sort(compareUtf8);

  let sharedDomain: string | undefined;
  let parallelSafe = true;
  for (const command of ordered) {
    const organization = domainForCommand(
      command,
      effective.organization_resource_domains,
      budget,
    );
    if (organization === undefined || organization === null) {
      return investigation;
    }
    let repository: LayerDomain | undefined;
    if (effective.repository_resource_domains !== undefined) {
      const resolvedRepository = domainForCommand(
        command,
        effective.repository_resource_domains,
        budget,
      );
      if (resolvedRepository === undefined || resolvedRepository === null) {
        return investigation;
      }
      repository = resolvedRepository;
      if (repository.domain !== organization.domain) return investigation;
    }
    if (sharedDomain === undefined) sharedDomain = organization.domain;
    if (sharedDomain !== organization.domain) return investigation;
    parallelSafe = parallelSafe && organization.parallelSafe &&
      (repository?.parallelSafe ?? true);
  }
  if (budget.exhausted || sharedDomain === undefined) return investigation;
  return {
    kind: parallelSafe ? "parallel_safe" : "parallel_unsafe",
    domain: sharedDomain,
  };
}
