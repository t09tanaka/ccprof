import { createHash } from "node:crypto";
import type { AnalyzeWarning } from "../core/analyze.js";
import { findingCompatibilityMetadata } from "../core/model.js";
import type {
  CommandIdentity,
  Finding,
  FindingEvidence,
  JsonValue,
  ReportV2,
} from "../core/model.js";
import type { StatsReport } from "./stats.js";
export type PrivacyProfile = "strict" | "balanced" | "raw";
type DisplayProfile = Exclude<PrivacyProfile, "raw">;
type Copy = readonly [raw: string, replacement: string];
const REDACTED_COMMAND = "[redacted-command]";
const SAFE_COMMAND = /^(?:npm test|npm run (?:test|check|lint|typecheck|build)|pnpm (?:test|check|lint|typecheck|build)|yarn (?:test|check|lint|typecheck|build)|bun test|cargo test|go test|pytest|python3? -m pytest|node --test|ccprof --json|git diff --check|git diff -- CLAUDE\.md)$/u;
const COMMANDISH = /(?:^|\s)(?:\.\/scripts(?:\/|\b)|curl|wget|ssh|scp|bash|zsh|sh|rm|git|gh|kubectl|docker|make|aws|az|gcloud|deno|mvn|gradle|npm|pnpm|yarn|bun|cargo|go|pytest|python3?|node|ccprof)\b|&&|\|\||[;|]/u;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/giu;
const SESSION_IDENTIFIER =
  /\bsession[-_:][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu;
const SECRET = /--(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|secret|token)(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s,"'`<>]+)|(?:authorization\s*:\s*(?:bearer|basic)\s+|(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|password|passwd|secret|token)\s*[:=]\s*)[^\s,"'`<>]+|\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Z][A-Z0-9]{1,9}-\d+)\b|-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/giu;

export function findingPrivacyReference(
  repositoryIdentity: string,
  rawKey: string,
): string {
  const digest = createHash("sha256")
    .update("ccprof:finding-reference:v1\0")
    .update(repositoryIdentity)
    .update("\0")
    .update(rawKey)
    .digest("hex")
    .slice(0, 24);
  return `finding-${digest}`;
}

export function trustedVerificationCommand(
  finding: Finding,
): string | undefined {
  const command = finding.fix_recipe.verify.trim();
  if (finding.rule_id === "R001") {
    return command === "git diff --check" ||
        command === "git diff -- CLAUDE.md"
      ? command
      : undefined;
  }
  if (finding.rule_id === "R003") {
    return command === "git diff -- CLAUDE.md" ? command : undefined;
  }
  if (
    finding.rule_id === "R004" ||
    finding.rule_id === "R005" ||
    finding.rule_id === "R007"
  ) {
    return command === "ccprof --json" ? command : undefined;
  }
  return undefined;
}

export function defaultPrivacyProfile(format: "tty" | "json" | "markdown", ci: boolean): PrivacyProfile {
  return ci || format === "markdown" ? "strict" : "balanced";
}
function hasSecret(value: string): boolean {
  return new RegExp(SECRET.source, "iu").test(value);
}
function replaceLiteral(value: string, raw: string, replacement: string): string {
  return raw === "" ? value : value.split(raw).join(replacement);
}
function repoPattern(repoRoot: string): RegExp | undefined {
  if (repoRoot === "") return undefined;
  let pattern = "";
  for (const char of repoRoot) {
    pattern += char === "/" || char === "\\"
      ? "[\\\\/]"
      : char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_])${pattern}(?=$|[\\\\/\\s\"'<>()[\\]{}:;,])`,
    "giu",
  );
}
export function sanitizePrivacyText(text: string, profile: PrivacyProfile,
  repoRoot?: string, sessions: readonly string[] = []): string {
  if (profile === "raw") return text;
  let value = text;
  for (const session of [...new Set(sessions)].sort((a, b) => b.length - a.length)) {
    value = replaceLiteral(value, session, "[session]");
  }
  value = value.replace(/(["'])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^"'`\r\n]*\1/gu, "[path]");
  const repo = repoRoot === undefined ? undefined : repoPattern(repoRoot);
  if (repo !== undefined) value = value.replace(repo, "$1[repository]");
  return value.replace(URL, "[url]")
    .replace(SESSION_IDENTIFIER, "[session]")
    .replace(/\\\\[^\\/\r\n]+[\\/][^\r\n]*?(?=$|[,;"'`<>)\]}])/gu, "[path]")
    .replace(/\b[A-Za-z]:[\\/][^\r\n]*?(?=$|[,;"'`<>)\]}])/gu, "[path]")
    .replace(/(^|[\s("'`=:\[{},;])\/(?!\/)[^\r\n]*?(?=$|[,;"'`<>)\]}])/gu, "$1[path]")
    .replace(SECRET, "[secret]");
}
function safeCommand(command: string, profile: DisplayProfile,
  repoRoot: string, sessions: readonly string[]): string | undefined {
  if (hasSecret(command)) return REDACTED_COMMAND;
  if (profile === "strict") {
    return SAFE_COMMAND.test(command.trim()) ? command.trim() : undefined;
  }
  return sanitizePrivacyText(command, profile, repoRoot, sessions);
}
function safeText(text: string, profile: DisplayProfile, repoRoot: string,
  sessions: readonly string[], copies: readonly Copy[] = []): string {
  let value = text;
  for (const [raw, replacement] of [...copies].sort((a, b) => b[0].length - a[0].length)) {
    value = replaceLiteral(value, raw, replacement);
  }
  if (COMMANDISH.test(value) && (hasSecret(value) || profile === "strict")) {
    return SAFE_COMMAND.test(value.trim()) ? value.trim() : REDACTED_COMMAND;
  }
  return sanitizePrivacyText(value, profile, repoRoot, sessions);
}
function sanitizeJson(value: JsonValue, key: string, repoRoot: string,
  sessions: readonly string[]): JsonValue {
  if (typeof value === "string") {
    return /command|verify|argv/iu.test(key)
      ? safeCommand(value, "balanced", repoRoot, sessions) ?? REDACTED_COMMAND
      : safeText(value, "balanced", repoRoot, sessions);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (/argv/iu.test(key) && hasSecret(value.join(" "))) return [REDACTED_COMMAND];
    return value.map((item) => sanitizeJson(item, key, repoRoot, sessions));
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    sanitizePrivacyText(childKey, "balanced", repoRoot, sessions),
    sanitizeJson(child, childKey, repoRoot, sessions),
  ]));
}
function opaque(scope: string, kind: string, value: string): string {
  const hash = createHash("sha256").update(scope).update("\0")
    .update(kind).update("\0").update(value).digest("hex").slice(0, 12);
  return `${kind}-${hash}`;
}
function commandCopies(finding: Finding, profile: DisplayProfile,
  repoRoot: string, sessions: readonly string[]): Copy[] {
  const evidence = finding.evidence.command;
  const verification = trustedVerificationCommand(finding) ?? REDACTED_COMMAND;
  return [
    ...(typeof evidence === "string" && evidence !== ""
      ? [[evidence, profile === "strict" ? REDACTED_COMMAND :
        safeCommand(evidence, profile, repoRoot, sessions) ?? REDACTED_COMMAND] as Copy]
      : []),
    ...(finding.fix_recipe.verify === "" ? [] : [[
      finding.fix_recipe.verify,
      verification,
    ] as Copy]),
  ];
}
function projectedFinding(finding: Finding, profile: DisplayProfile,
  scope: string, repoRoot: string, sessions: readonly string[]): Finding {
  const compatibility = findingCompatibilityMetadata(finding);
  const copies = commandCopies(finding, profile, repoRoot, sessions);
  const evidence: FindingEvidence = profile === "strict" ? {
    session_refs: finding.evidence.session_refs.map((ref) => opaque(scope, "session-ref", ref)),
    interval_ids: finding.evidence.interval_ids.map((id) => opaque(scope, "interval", id)),
  } : {
    ...(sanitizeJson(finding.evidence, "evidence", repoRoot, sessions) as FindingEvidence),
    session_refs: finding.evidence.session_refs.map((ref) => opaque(scope, "session-ref", ref)),
    interval_ids: finding.evidence.interval_ids.map((id) => opaque(scope, "interval", id)),
  };
  return {
    finding_key: findingPrivacyReference(repoRoot, finding.finding_key),
    rule_id: finding.rule_id,
    ...(compatibility.valid && compatibility.metadata !== undefined
      ? compatibility.metadata
      : {}),
    title: safeText(finding.title, profile, repoRoot, sessions, copies),
    ...(profile === "balanced" && finding.target !== undefined
      ? { target: safeText(finding.target, profile, repoRoot, sessions, copies) } : {}),
    classification: finding.classification,
    cause: finding.cause,
    scope: finding.scope,
    confidence: finding.confidence,
    evidence,
    recoverable: { ...finding.recoverable },
    fix_recipe: {
      suggestion: safeText(finding.fix_recipe.suggestion, profile, repoRoot, sessions, copies),
      verify: trustedVerificationCommand(finding) ?? REDACTED_COMMAND,
    },
    caveats: profile === "strict" ? [] : finding.caveats.map((value) =>
      safeText(value, profile, repoRoot, sessions, copies)
    ),
  };
}
function reportCaveats(report: ReportV2, profile: DisplayProfile,
  repoRoot: string, sessions: readonly string[]): string[] {
  const copies = report.findings.flatMap((finding) =>
    commandCopies(finding, profile, repoRoot, sessions)
  );
  if (profile === "balanced") {
    return report.caveats.map((value) => safeText(value, profile, repoRoot, sessions, copies));
  }
  const counts = new Map<string, number>();
  const limitations: string[] = [];
  for (const value of report.caveats) {
    const warning = /^\[([^\]\r\n]+)\](?:\s|$)/u.exec(value);
    if (warning === null) limitations.push(safeText(value, profile, repoRoot, sessions, copies));
    else { const code = warning[1] ?? ""; counts.set(code, (counts.get(code) ?? 0) + 1); }
  }
  return [
    ...[...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([code, count]) =>
      `[${sanitizePrivacyText(code, profile, repoRoot, sessions)}] ${count} warning${count === 1 ? "" : "s"}`
    ),
    ...limitations,
  ];
}

function projectedAnalysisBudget(
  budget: NonNullable<ReportV2["analysis_budget"]>,
): NonNullable<ReportV2["analysis_budget"]> {
  return {
    configured: { ...budget.configured },
    consumed: { ...budget.consumed },
    observed: { ...budget.observed },
    completeness: budget.completeness,
    ...(budget.truncation_reason === undefined
      ? {}
      : { truncation_reason: budget.truncation_reason }),
    coverage: budget.coverage,
  };
}

export function projectReportPrivacy(report: ReportV2, profile: PrivacyProfile): ReportV2 {
  if (profile === "raw") return report;
  const scope = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  const repoRoot = report.unit.repo;
  const sessions = report.unit.sessions;
  return {
    version: 2,
    unit: {
      repo: opaque(scope, "repository", repoRoot),
      pr_ref: opaque(scope, "ref", report.unit.pr_ref),
      sessions: sessions.map((session) => opaque(scope, "session", session)),
    },
    ...(report.analysis_budget === undefined
      ? {}
      : { analysis_budget: projectedAnalysisBudget(report.analysis_budget) }),
    ...(report.sources === undefined
      ? {}
      : { sources: structuredClone(report.sources) }),
    summary: structuredClone(report.summary),
    findings: report.findings.map((finding) => projectedFinding(
      finding, profile, scope, repoRoot, sessions,
    )),
    caveats: reportCaveats(report, profile, repoRoot, sessions),
    ...(report.rule_coverage === undefined ? {} : {
      rule_coverage: report.rule_coverage.map((entry) => ({
        rule_id: entry.rule_id,
        eligible_sessions: entry.eligible_sessions,
        total_sessions: entry.total_sessions,
        status: entry.status,
        missing_capabilities: [...entry.missing_capabilities],
        completeness: entry.completeness,
        truncated: entry.truncated,
      })),
    }),
    ...(report.skipped_rules === undefined ? {} : {
      skipped_rules: report.skipped_rules.map((entry) => ({
        rule_id: entry.rule_id, missing: [...entry.missing],
      })),
    }),
  };
}

function balancedStatsIdentity(
  command: string,
  identity: CommandIdentity,
  repoRoot: string,
): CommandIdentity | undefined {
  if (identity.repo_relative_cwd !== ".") return undefined;
  const safeDisplay = safeCommand(command, "strict", repoRoot, []);
  const safeArgv = safeCommand(
    identity.normalized_argv.join(" "),
    "strict",
    repoRoot,
    [],
  );
  if (
    safeDisplay === undefined ||
    safeDisplay === REDACTED_COMMAND ||
    safeArgv !== safeDisplay
  ) {
    return undefined;
  }
  return {
    repo_relative_cwd: ".",
    normalized_argv: [...identity.normalized_argv],
    executor: identity.executor,
  };
}

export function projectStatsPrivacy(
  stats: StatsReport,
  profile: PrivacyProfile,
  repoRoot: string,
): StatsReport {
  if (profile === "raw") return stats;
  const projectText = (value: string): string =>
    safeText(value, profile, repoRoot, []);
  return {
    history_count: stats.history_count,
    baseline_metrics: stats.baseline_metrics.map((entry) => ({
      metric: projectText(entry.metric),
      value: entry.value,
      baseline: entry.baseline,
    })),
    chronic_commands: stats.chronic_commands.map((entry) => {
      const command = safeCommand(entry.command, profile, repoRoot, []) ??
        REDACTED_COMMAND;
      const identity = profile === "balanced" &&
          entry.command_identity !== undefined
        ? balancedStatsIdentity(
          entry.command,
          entry.command_identity,
          repoRoot,
        )
        : undefined;
      return {
        command,
        ...(identity === undefined ? {} : { command_identity: identity }),
        presence_count: entry.presence_count,
        cost_ratio: entry.cost_ratio,
        estimated_min: entry.estimated_min,
      };
    }),
    rule_minutes: stats.rule_minutes.map((entry) => ({ ...entry })),
    recurring_findings: stats.recurring_findings.map((entry) => ({
      finding_key: findingPrivacyReference(repoRoot, entry.finding_key),
      rule_id: entry.rule_id,
      title: projectText(entry.title),
      occurrence_count: entry.occurrence_count,
      first_min: entry.first_min,
      first_bound: entry.first_bound,
      last_min: entry.last_min,
      last_bound: entry.last_bound,
      trend: entry.trend,
    })),
    adoptions: stats.adoptions.map((entry) => ({
      finding_key: findingPrivacyReference(repoRoot, entry.finding_key),
      rule_id: entry.rule_id,
      title: projectText(entry.title),
      method: entry.method,
      detected_at_ms: entry.detected_at_ms,
      analyses_after: entry.analyses_after,
      recurrences_after: entry.recurrences_after,
      minutes_before: entry.minutes_before,
      minutes_after: entry.minutes_after,
      status: entry.status,
    })),
    adoption_coverage: { ...stats.adoption_coverage },
  };
}

export function privacyWarningTexts(warnings: readonly AnalyzeWarning[], profile: PrivacyProfile,
  repoRoot?: string, sessions: readonly string[] = []): string[] {
  if (profile === "strict") {
    const counts = new Map<string, number>();
    for (const warning of warnings) counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([code, count]) =>
      `[${sanitizePrivacyText(code, profile, repoRoot, sessions)}] ${count} warning${count === 1 ? "" : "s"}`
    );
  }
  return warnings.map((warning) => sanitizePrivacyText(
    `[${warning.code}] ${warning.message}${warning.source === undefined ? "" : profile === "raw" ? ` (${warning.source})` : " ([path])"}`,
    profile, repoRoot, sessions,
  ));
}
