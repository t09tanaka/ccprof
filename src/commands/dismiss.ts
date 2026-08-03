import { dirname } from "node:path";

import type { Finding } from "../core/model.js";
import { findGitMarker } from "../git/common-dir.js";
import { GitContextError } from "../git/pr-context.js";
import {
  findingPrivacyReference,
  trustedVerificationCommand,
} from "../reporters/privacy.js";
import { sanitizeHumanText } from "../reporters/sanitize.js";
import {
  loadAnalyses,
  type AnalysisHistoryResult,
  type AnalysisRecord,
} from "../store/analyses.js";
import {
  saveDismissal,
  type DismissalInput,
  type DismissalSaveResult,
} from "../store/dismissals.js";
import {
  resolveStorePaths,
  type StorePaths,
} from "../store/paths.js";
import type { CommandExecutionResult } from "./analyze.js";
import { resolveCurrentRepoRoot } from "./stats.js";

export interface DismissCommandOptions {
  cwd: string;
  findingKey: string;
  reason?: string;
}

export interface DismissCommandDependencies {
  resolveRepoRoot?: (cwd: string) => Promise<string>;
  resolveStorePaths?: (repoRoot: string) => Promise<StorePaths>;
  loadAnalyses?: (
    paths: StorePaths,
  ) => Promise<AnalysisHistoryResult>;
  saveDismissal?: (
    paths: StorePaths,
    input: DismissalInput,
  ) => Promise<DismissalSaveResult>;
  now?: () => number;
}

export class FindingNotFoundError extends Error {
  constructor(findingKey: string) {
    super(`Unknown finding key: ${oneLine(findingKey)}`);
    this.name = "FindingNotFoundError";
  }
}

export class DismissalPersistenceError extends Error {
  constructor(message: string) {
    super(oneLine(message));
    this.name = "DismissalPersistenceError";
  }
}

export class FindingReferenceAmbiguityError extends Error {
  constructor(findingKey: string) {
    super(`Ambiguous finding reference: ${oneLine(findingKey)}`);
    this.name = "FindingReferenceAmbiguityError";
  }
}

function recordOrder(
  left: AnalysisRecord,
  right: AnalysisRecord,
): number {
  return right.created_at_ms - left.created_at_ms ||
    right.analysis_id.localeCompare(left.analysis_id);
}

export function findStoredFinding(
  records: readonly AnalysisRecord[],
  findingKey: string,
): Finding | undefined {
  const rawKeys = new Set<string>();
  for (const record of records) {
    for (const finding of record.findings) {
      if (
        finding.finding_key === findingKey ||
        findingPrivacyReference(
          record.unit.repo,
          finding.finding_key,
        ) === findingKey
      ) {
        rawKeys.add(finding.finding_key);
      }
    }
  }
  if (rawKeys.size === 0) return undefined;
  if (rawKeys.size > 1) {
    throw new FindingReferenceAmbiguityError(findingKey);
  }
  const [rawKey] = rawKeys;
  if (rawKey === undefined) return undefined;

  const occurrences: Array<{ record: AnalysisRecord; finding: Finding }> = [];
  for (const record of records) {
    const duplicates = record.findings.filter(
      (candidate) => candidate.finding_key === rawKey,
    );
    if (duplicates.length > 1) {
      throw new FindingReferenceAmbiguityError(findingKey);
    }
    const [finding] = duplicates;
    if (finding !== undefined) occurrences.push({ record, finding });
  }
  return occurrences
    .sort((left, right) => recordOrder(left.record, right.record))[0]
    ?.finding;
}

function evidenceTarget(finding: Finding): string {
  for (const key of ["command", "path", "target"] as const) {
    const value = finding.evidence[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  const paths = finding.evidence.paths;
  if (
    Array.isArray(paths) &&
    paths.every((value) => typeof value === "string")
  ) {
    const target = paths.join(" | ").trim();
    if (target !== "") return target;
  }
  return finding.title;
}

function warningText(
  warning: AnalysisHistoryResult["warnings"][number],
): string {
  return oneLine(`[${warning.code}] ${warning.message} (${warning.path})`);
}

const BIDI_CONTROLS =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

function withoutBidiControls(value: string): string {
  return value.replace(BIDI_CONTROLS, "");
}

function oneLine(value: string): string {
  return withoutBidiControls(sanitizeHumanText(value))
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function escapedHumanText(value: string): string {
  return JSON.stringify(withoutBidiControls(value)).slice(1, -1)
    .replace(/[\u007F-\u009F\u2028\u2029]/gu, (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
}

function evidenceText(finding: Finding): string {
  return JSON.stringify(finding.evidence, null, 2)
    .split("\n")
    .map((line) => withoutBidiControls(sanitizeHumanText(line))
      .replace(/\u2028/gu, "\\u2028")
      .replace(/\u2029/gu, "\\u2029"))
    .join("\n");
}

function explanationText(finding: Finding): string {
  const verification = trustedVerificationCommand(finding);
  const verificationBlock = verification === undefined
    ? [
      "Verification trust: untrusted",
      `Verification command (display only; do not execute): ${escapedHumanText(finding.fix_recipe.verify)}`,
    ]
    : [
      "Verification trust: trusted",
      `Trusted verification command: ${oneLine(verification)}`,
    ];
  const target = finding.target === undefined
    ? []
    : [`Target: ${oneLine(finding.target)}`];
  const caveats = finding.caveats.length === 0
    ? ["Caveats: none"]
    : ["Caveats:", ...finding.caveats.map((value) => `- ${oneLine(value)}`)];
  return `${[
    "Local sensitive finding details — do not share this output.",
    `Finding key: ${oneLine(finding.finding_key)}`,
    `Rule: ${oneLine(String(finding.rule_id))}`,
    `Title: ${oneLine(finding.title)}`,
    `Classification: ${oneLine(String(finding.classification))}`,
    `Cause: ${oneLine(String(finding.cause ?? "none"))}`,
    `Scope: ${oneLine(String(finding.scope))}`,
    `Confidence: ${oneLine(String(finding.confidence))}`,
    `Recoverable: ${oneLine(String(finding.recoverable.min))} min (${oneLine(String(finding.recoverable.bound))})`,
    ...target,
    `Suggestion: ${oneLine(finding.fix_recipe.suggestion)}`,
    ...verificationBlock,
    "Evidence:",
    evidenceText(finding),
    ...caveats,
  ].join("\n")}\n`;
}

async function resolveExplainRepoRoot(cwd: string): Promise<string> {
  const marker = await findGitMarker(cwd);
  if (marker === undefined) {
    throw new GitContextError("could not find a local Git repository");
  }
  return dirname(marker);
}

export interface ExplainCommandOptions {
  cwd: string;
  findingKey: string;
}

export interface ExplainCommandDependencies {
  resolveRepoRoot?: (cwd: string) => Promise<string>;
  resolveStorePaths?: (repoRoot: string) => Promise<StorePaths>;
  loadAnalyses?: (
    paths: StorePaths,
  ) => Promise<AnalysisHistoryResult>;
}

export async function runExplainCommand(
  options: ExplainCommandOptions,
  dependencies: ExplainCommandDependencies = {},
): Promise<CommandExecutionResult> {
  const findingKey = options.findingKey.trim();
  if (findingKey === "") {
    throw new FindingNotFoundError(options.findingKey);
  }
  const repoRoot = await (
    dependencies.resolveRepoRoot ?? resolveExplainRepoRoot
  )(options.cwd);
  const paths = await (
    dependencies.resolveStorePaths ?? resolveStorePaths
  )(repoRoot);
  const history = await (
    dependencies.loadAnalyses ?? loadAnalyses
  )(paths);
  const finding = findStoredFinding(history.records, findingKey);
  if (finding === undefined) {
    throw new FindingNotFoundError(findingKey);
  }
  return {
    stdout: explanationText(finding),
    warnings: history.warnings.map(warningText),
  };
}

export async function runDismissCommand(
  options: DismissCommandOptions,
  dependencies: DismissCommandDependencies = {},
): Promise<CommandExecutionResult> {
  const findingKey = options.findingKey.trim();
  if (findingKey === "") {
    throw new FindingNotFoundError(options.findingKey);
  }
  const repoRoot = await (
    dependencies.resolveRepoRoot ?? resolveCurrentRepoRoot
  )(options.cwd);
  const paths = await (
    dependencies.resolveStorePaths ?? resolveStorePaths
  )(repoRoot);
  const history = await (
    dependencies.loadAnalyses ?? loadAnalyses
  )(paths);
  const finding = findStoredFinding(history.records, findingKey);
  if (finding === undefined) {
    throw new FindingNotFoundError(findingKey);
  }
  const save = dependencies.saveDismissal ?? saveDismissal;
  const saved = await save(paths, {
    finding_key: finding.finding_key,
    target: evidenceTarget(finding),
    dismissed_at_ms: (dependencies.now ?? Date.now)(),
    strength_min: finding.recoverable.min,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  });
  const failed = saved.warnings.find(
    (warning) => warning.code === "dismissal_write_failed",
  );
  if (failed !== undefined) {
    throw new DismissalPersistenceError(failed.message);
  }
  return {
    stdout: `Dismissed ${oneLine(findingKey)} for 14 days.\n`,
    warnings: [
      ...history.warnings.map(warningText),
      ...saved.warnings.map(warningText),
    ],
  };
}
