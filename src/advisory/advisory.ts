import type { CommandResult, CommandRunner } from "../git/client.js";
import { sanitizeHumanText } from "../reporters/sanitize.js";

export const ADVISORY_TIMEOUT_MS = 60_000;
export const ADVISORY_MAX_TEXT_CHARS = 2_000;

/**
 * Judgment-level LLM commentary rendered alongside — never inside — the
 * deterministic report. It exists only behind the explicit `--advisory`
 * opt-in, is produced after the analysis (and its store write) completed,
 * and is never persisted: `ReportV2`, `AnalysisRecord`, and baselines are
 * structurally unable to carry it.
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
  let result: CommandResult;
  try {
    result = await runner("claude", ["-p", buildAdvisoryPrompt(reportJson)], {
      timeoutMs: ADVISORY_TIMEOUT_MS,
    });
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (result.timedOut === true) {
    return unavailable("claude CLI timed out");
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
