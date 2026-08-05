import { createHash } from "node:crypto";

import type { AnalyzeWarning } from "../core/analyze.js";
import type { Finding, RuleId } from "../core/model.js";
import type { FindingScope } from "../core/finding-scope.js";
import {
  CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY,
  normalizeFindingScopeIdentity,
  projectLegacyFindingScope,
  type LegacyFindingScope,
} from "../compat/instruction-resource.js";
import { runCommand, type CommandResult, type CommandRunner } from "../git/client.js";
import type { AdoptionMethod, AdoptionRecord } from "../store/adoptions.js";
import { normalizeRepoPath } from "./test-map.js";

const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Stable content fingerprint for a finding, independent of when or how many
 * times it was detected. Only the suggestion text is used from `fix_recipe`;
 * `verify` does not participate.
 */
export function findingFingerprint(
  finding: Pick<Finding, "rule_id" | "fix_recipe"> & {
    scope: FindingScope | LegacyFindingScope;
    target?: string;
  },
): string {
  const legacyScope = projectLegacyFindingScope(
    normalizeFindingScopeIdentity(finding.scope),
  );
  const normalizedSuggestion = finding.fix_recipe.suggestion
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ");
  return createHash("sha256")
    .update(
      `${legacyScope}\0${finding.rule_id}\0${finding.target ?? ""}\0${normalizedSuggestion}`,
    )
    .digest("hex");
}

/**
 * Deterministic keyword extraction used to search later commits for evidence
 * that a suggestion was acted on. NFC-normalizes and lowercases the text,
 * splits on anything that isn't a letter/number/underscore/dot/slash/dash,
 * keeps tokens of length >= 4, dedupes, sorts, and caps at 8 entries.
 */
export function suggestionKeywords(suggestion: string): string[] {
  const normalized = suggestion.normalize("NFC").toLowerCase();
  const tokens = normalized
    .split(/[^\p{L}\p{N}_./-]+/u)
    .filter((token) => token.length >= 4);
  return [...new Set(tokens)]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, 8);
}

export interface AdoptionCandidateFinding {
  finding_key: string;
  rule_id: RuleId;
  scope: FindingScope | LegacyFindingScope;
  target?: string;
  suggestion: string;
  recorded_at_ms: number;
}

export type AdoptionDetectability =
  | "instruction_resource"
  | "target_file"
  | "undetectable";

/**
 * Decides which deterministic detection strategy (if any) applies to a
 * candidate finding, without touching git.
 */
export function detectability(
  finding: Pick<AdoptionCandidateFinding, "scope" | "rule_id" | "target">,
): AdoptionDetectability {
  const scope = normalizeFindingScopeIdentity(finding.scope);
  if (
    scope ===
      CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY.resource.canonical_finding_scope
  ) return "instruction_resource";
  if (finding.rule_id === "R008" || scope === "separate_issue") {
    if (finding.target === undefined) return "undetectable";
    try {
      normalizeRepoPath(finding.target);
      return "target_file";
    } catch {
      return "undetectable";
    }
  }
  return "undetectable";
}

export interface DetectAdoptionsOptions {
  repoRoot: string;
  /** Findings not yet recorded as adopted; already deduped by the caller. */
  candidates: readonly AdoptionCandidateFinding[];
  runner?: CommandRunner;
  /** Stamped into every produced record; keeps detection deterministic. */
  detectedAtMs: number;
}

export interface DetectAdoptionsResult {
  adoptions: AdoptionRecord[];
  warnings: AnalyzeWarning[];
}

interface ClaudeMdCommit {
  oid: string;
  timestampMs: number;
  addedTextLower: string;
}

const CLAUDE_MD_HEADER_LINE = /^([0-9a-f]{40}|[0-9a-f]{64})\x00(\d+)$/gm;

function parseClaudeMdLog(stdout: string): ClaudeMdCommit[] {
  const headers: { oid: string; timestampMs: number; start: number; end: number }[] = [];
  CLAUDE_MD_HEADER_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLAUDE_MD_HEADER_LINE.exec(stdout)) !== null) {
    const oid = (match[1] ?? "").toLowerCase();
    const seconds = Number(match[2]);
    if (!Number.isSafeInteger(seconds)) continue;
    const timestampMs = seconds * 1_000;
    if (!Number.isSafeInteger(timestampMs)) continue;
    headers.push({
      oid,
      timestampMs,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return headers.map((header, index) => {
    const sectionEnd = headers[index + 1]?.start ?? stdout.length;
    const section = stdout.slice(header.end, sectionEnd);
    const addedLines = section
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    return {
      oid: header.oid,
      timestampMs: header.timestampMs,
      addedTextLower: addedLines.join("\n").normalize("NFC").toLowerCase(),
    };
  });
}

interface TargetCommit {
  oid: string;
  timestampMs: number;
}

function parseTargetLog(stdout: string): TargetCommit[] {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line): TargetCommit[] => {
      const [oid, secondsText] = line.split("\0");
      if (oid === undefined || secondsText === undefined) return [];
      if (!OID_PATTERN.test(oid) || !/^\d+$/.test(secondsText)) return [];
      const timestampMs = Number(secondsText) * 1_000;
      if (!Number.isSafeInteger(timestampMs)) return [];
      return [{ oid: oid.toLowerCase(), timestampMs }];
    });
}

/**
 * Selects the chronologically oldest commit among those that already
 * satisfy the caller's qualifying condition, with the commit oid as a
 * deterministic tie-breaker for equal timestamps.
 */
function oldestQualifying<T extends { oid: string; timestampMs: number }>(
  commits: readonly T[],
): T | undefined {
  return commits.reduce<T | undefined>((oldest, current) => {
    if (oldest === undefined) return current;
    if (current.timestampMs < oldest.timestampMs) return current;
    if (current.timestampMs === oldest.timestampMs && current.oid < oldest.oid) {
      return current;
    }
    return oldest;
  }, undefined);
}

function makeRecord(
  candidate: AdoptionCandidateFinding,
  method: AdoptionMethod,
  commit: string,
  path: string,
  detectedAtMs: number,
): AdoptionRecord {
  const scope = normalizeFindingScopeIdentity(candidate.scope);
  return {
    finding_key: candidate.finding_key,
    rule_id: candidate.rule_id,
    scope,
    fingerprint: findingFingerprint({
      scope,
      rule_id: candidate.rule_id,
      fix_recipe: { suggestion: candidate.suggestion, verify: "" },
      ...(candidate.target === undefined ? {} : { target: candidate.target }),
    }),
    method,
    detected_at_ms: detectedAtMs,
    evidence: { commit, path },
  };
}

function detectionFailedWarning(path: string, stderr: string): AnalyzeWarning {
  const detail = stderr.trim();
  return {
    code: "adoption_detection_failed",
    message: `git log for ${path} failed${detail === "" ? "" : `: ${detail}`}`,
    source: path,
  };
}

/**
 * `runCommand` can return a successful exit code while the captured output
 * was still cut short (byte cap or timeout kill). Acting on that partial
 * `stdout` risks mistaking incomplete history for "no adoption". Detect it
 * explicitly so callers skip the affected candidate(s) instead.
 */
function partialOutputWarning(path: string, result: CommandResult): AnalyzeWarning | undefined {
  if (!result.timedOut && !result.stdoutTruncated) return undefined;
  const reasons = [
    result.timedOut === true ? "timed out" : undefined,
    result.stdoutTruncated === true ? "output truncated" : undefined,
  ].filter((reason): reason is string => reason !== undefined);
  return {
    code: "adoption_detection_failed",
    message: `git log for ${path} produced partial output (${reasons.join(", ")}); skipping adoption detection`,
    source: path,
  };
}

async function detectInstructionResourceAdoptions(
  candidates: readonly AdoptionCandidateFinding[],
  repoRoot: string,
  runner: CommandRunner,
  detectedAtMs: number,
  warnings: AnalyzeWarning[],
): Promise<AdoptionRecord[]> {
  if (candidates.length === 0) return [];
  const compatibility = CLAUDE_MD_INSTRUCTION_RESOURCE_COMPATIBILITY;
  const result = await runner(
    "git",
    [
      "--no-pager",
      "log",
      "--format=%H%x00%ct",
      "-p",
      "--unified=0",
      "--",
      compatibility.resource.path,
    ],
    { cwd: repoRoot },
  );
  const partialWarning = partialOutputWarning(
    compatibility.detector.evidence_path,
    result,
  );
  if (partialWarning !== undefined) {
    warnings.push(partialWarning);
    return [];
  }
  if (result.code !== 0) {
    warnings.push(detectionFailedWarning(
      compatibility.detector.evidence_path,
      result.stderr,
    ));
    return [];
  }
  const commits = parseClaudeMdLog(result.stdout);
  const adoptions: AdoptionRecord[] = [];
  for (const candidate of candidates) {
    const keywords = suggestionKeywords(candidate.suggestion);
    const qualifying = commits.filter(
      (commit) =>
        commit.timestampMs > candidate.recorded_at_ms &&
        keywords.some((keyword) => commit.addedTextLower.includes(keyword)),
    );
    const match = oldestQualifying(qualifying);
    if (match !== undefined) {
      adoptions.push(makeRecord(
        candidate,
        compatibility.detector.canonical_adoption_method,
        match.oid,
        compatibility.detector.evidence_path,
        detectedAtMs,
      ));
    }
  }
  return adoptions;
}

async function detectTargetFileAdoption(
  candidate: AdoptionCandidateFinding,
  repoRoot: string,
  runner: CommandRunner,
  detectedAtMs: number,
  warnings: AnalyzeWarning[],
): Promise<AdoptionRecord | undefined> {
  let target: string;
  try {
    target = normalizeRepoPath(candidate.target ?? "");
  } catch {
    return undefined;
  }
  const result = await runner(
    "git",
    // `:(literal)` disables git's pathspec magic/fnmatch after `--` so a
    // target string sourced from session logs (e.g. containing `?`, `*`,
    // `[...]`, or `:!...`) is matched as an exact literal path rather than a
    // glob or exclusion pattern.
    ["--no-pager", "log", "--format=%H%x00%ct", "--", `:(literal)${target}`],
    { cwd: repoRoot },
  );
  const partialWarning = partialOutputWarning(target, result);
  if (partialWarning !== undefined) {
    warnings.push(partialWarning);
    return undefined;
  }
  if (result.code !== 0) {
    warnings.push(detectionFailedWarning(target, result.stderr));
    return undefined;
  }
  const commits = parseTargetLog(result.stdout);
  const qualifying = commits.filter((commit) => commit.timestampMs > candidate.recorded_at_ms);
  const match = oldestQualifying(qualifying);
  return match === undefined
    ? undefined
    : makeRecord(candidate, "target_file_edit", match.oid, target, detectedAtMs);
}

export async function detectAdoptions(
  options: DetectAdoptionsOptions,
): Promise<DetectAdoptionsResult> {
  const runner = options.runner ?? runCommand;
  const warnings: AnalyzeWarning[] = [];
  const instructionResourceCandidates: AdoptionCandidateFinding[] = [];
  const targetFileCandidates: AdoptionCandidateFinding[] = [];
  for (const candidate of options.candidates) {
    const kind = detectability(candidate);
    if (kind === "instruction_resource") {
      instructionResourceCandidates.push(candidate);
    } else if (kind === "target_file") targetFileCandidates.push(candidate);
  }

  const adoptions = await detectInstructionResourceAdoptions(
    instructionResourceCandidates,
    options.repoRoot,
    runner,
    options.detectedAtMs,
    warnings,
  );
  for (const candidate of targetFileCandidates) {
    const record = await detectTargetFileAdoption(
      candidate,
      options.repoRoot,
      runner,
      options.detectedAtMs,
      warnings,
    );
    if (record !== undefined) adoptions.push(record);
  }

  return { adoptions, warnings };
}
