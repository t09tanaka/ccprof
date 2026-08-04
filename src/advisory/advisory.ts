import type { CommandResult, CommandRunner } from "../git/client.js";
import { sanitizeHumanText } from "../reporters/sanitize.js";

export const ADVISORY_TIMEOUT_MS = 60_000;
export const ADVISORY_MAX_STDIN_BYTES = 1024 * 1024;
export const ADVISORY_MAX_OUTPUT_BYTES = 64 * 1024;
export const ADVISORY_MAX_TEXT_CHARS = 2_000;
export const ADVISORY_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "ComSpec",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
] as const;

function environmentValue(
  source: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const direct = source[key];
  if (direct !== undefined || process.platform !== "win32") return direct;
  const match = Object.keys(source).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return match === undefined ? undefined : source[match];
}

export function buildAdvisoryEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of ADVISORY_ENV_KEYS) {
    const value = environmentValue(source, key);
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/**
 * Judgment-level LLM commentary rendered alongside — never inside — the
 * deterministic report. It exists only behind the explicit `--advisory`
 * opt-in, and is never persisted. Unbudgeted commands produce it after the
 * analysis and Store write; budgeted commands may produce it before the write
 * solely to finalize outbound bytes. In both paths it remains in the display
 * closure and is never passed to `ReportV2`, `AnalysisRecord`, snapshots,
 * baselines, or the Store.
 */
export interface AdvisoryText {
  source: "llm";
  text: string;
}

export type AdvisoryOutcome =
  | { kind: "available"; advisory: AdvisoryText }
  | { kind: "unavailable"; reason: string };

const ADVISORY_INSTRUCTIONS = [
  "You are the opt-in advisory layer of ccprof.",
  "The JSON below is the result of a deterministic analysis of the",
  "working process behind an agent-delegated pull request.",
  "Offer at most 3 judgment-level observations about wasted effort in",
  "that working process which deterministic rules cannot detect, as",
  "concise bullet points.",
  "Do not restate or paraphrase the deterministic findings.",
  "Respond in Japanese, or in the language of the report content when",
  "it clearly differs.",
].join(" ");

/**
 * The prompt contains only the fixed instructions plus the display-report
 * JSON (`renderJsonReport` output; JSON.stringify escaping only — the
 * human-text sanitizer deliberately does not run on JSON output). Raw
 * session transcripts and logs are deliberately never included.
 */
export function buildAdvisoryPrompt(reportJson: string): string {
  return `${ADVISORY_INSTRUCTIONS}\n\n${reportJson}`;
}

/**
 * Asks the locally installed `claude` CLI (Claude Code, print mode) for
 * advisory text. Every failure mode — missing CLI, nonzero exit, timeout,
 * empty output, a throwing runner — degrades into an `unavailable` outcome
 * so the deterministic report and the exit code stay untouched.
 */
export async function requestAdvisory(
  reportJson: string,
  runner: CommandRunner,
): Promise<AdvisoryOutcome> {
  const prompt = buildAdvisoryPrompt(reportJson);
  if (Buffer.byteLength(prompt, "utf8") > ADVISORY_MAX_STDIN_BYTES) {
    return unavailable(
      `advisory input exceeds ${ADVISORY_MAX_STDIN_BYTES}-byte limit`,
    );
  }
  let result: CommandResult;
  try {
    result = await runner("claude", ["-p"], {
      stdin: prompt,
      maxStdinBytes: ADVISORY_MAX_STDIN_BYTES,
      env: buildAdvisoryEnvironment(),
      envMode: "replace",
      timeoutMs: ADVISORY_TIMEOUT_MS,
      maxOutputBytes: ADVISORY_MAX_OUTPUT_BYTES,
      killProcessGroup: true,
    });
  } catch {
    return unavailable("claude CLI could not be started");
  }
  if (result.timedOut === true) {
    return unavailable("claude CLI timed out");
  }
  if (result.stdoutTruncated === true) {
    return unavailable(
      `claude CLI output exceeded ${ADVISORY_MAX_OUTPUT_BYTES}-byte limit`,
    );
  }
  if (result.code !== 0) {
    return unavailable(`claude CLI exited with code ${result.code}`);
  }
  // Sanitize line by line: sanitizeHumanText folds C0 controls (including
  // "\n") into spaces, which would collapse the advisory bullets into one
  // long line in every reporter.
  const text = result.stdout
    .slice(0, ADVISORY_MAX_TEXT_CHARS)
    .split(/\r?\n/u)
    .map((line) => sanitizeHumanText(line).trim())
    .filter((line) => line !== "")
    .join("\n")
    .trim();
  if (text === "") {
    return unavailable("claude CLI produced no output");
  }
  return { kind: "available", advisory: { source: "llm", text } };
}

function unavailable(reason: string): AdvisoryOutcome {
  return { kind: "unavailable", reason };
}
