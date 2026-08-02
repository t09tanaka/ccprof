# LLM Advisory Layer Implementation Plan

> **Goal:** Ship the 0.3-candidate opt-in LLM advisory layer as an `--advisory` analyze flag whose judgment-level suggestions render clearly separated from — and structurally unable to contaminate — the deterministic report, store, and baseline.

## Scope

- Add a boolean `--advisory` analyze flag with the same duplicate guard shape as `--color`.
- Delegate the LLM call to the external `claude` CLI (`claude -p`, 60-second timeout) through the existing `CommandRunner` abstraction; no HTTP client or SDK dependency.
- Send only the sanitized display-report JSON (`renderJsonReport` output) plus fixed instructions; never raw session transcripts or logs.
- Degrade every failure (missing CLI, nonzero exit, timeout, empty output) into one `advisory unavailable: <reason>` warning with the deterministic report and exit code unchanged.
- Render the advisory as a separated section in TTY, Markdown, and JSON output; omit the JSON `advisory` field entirely without the flag so existing output stays byte-identical.
- Do not touch `src/core/analyze.ts`, `ReportV2` (store side), `AnalysisRecord`, or baselines.
- Do not change CHANGELOG or package versions.

## Files

- `src/advisory/advisory.ts` (new)
- `src/cli.ts`
- `src/commands/analyze.ts`
- `src/reporters/json.ts`
- `src/reporters/tty.ts`
- `src/reporters/markdown.ts`
- `test/advisory.test.ts` (new)
- `test/reporters-and-cli.test.ts`
- `README.md`
- this plan

## Task 1: Advisory execution module

- [x] Create `src/advisory/advisory.ts` with `AdvisoryText` (`{ source: "llm"; text: string }`), `buildAdvisoryPrompt`, and `requestAdvisory`.
- [x] Run `claude -p <prompt>` through an injected `CommandRunner` with `timeoutMs` 60 000.
- [x] Compose the prompt from fixed instructions (advisory role, max 3 judgment-level bullets, no restating deterministic findings, respond in Japanese or the input language) plus the display-report JSON only.
- [x] Map thrown runner errors, timeouts, nonzero exits, and empty output to `unavailable` outcomes with concise reasons.
- [x] Truncate successful output to 2 000 characters and pass it through `sanitizeHumanText`.

## Task 2: CLI and command wiring

- [x] Add `--advisory` to `USAGE`, `ParsedAnalyzeCommand`, `parseAnalyzeArgs` (duplicate guard identical in shape to `--color`), and the analyze return object.
- [x] Pass the flag through `runCli` to `AnalyzeCommandOptions.advisory`.
- [x] Add `runCommand?: CommandRunner` to `AnalyzeCommandDependencies` with the real `runCommand` as default.
- [x] Request the advisory in `runAnalyzeCommand` only after `analyze()` (and its internal store write) completed, so advisory text can never reach the store or baseline.
- [x] Append `advisory unavailable: <reason>` to the existing warnings channel on failure, leaving stdout and the exit code untouched.

## Task 3: Reporter separation

- [x] TTY: append an `Advisory (LLM, opt-in — non-deterministic):` trailer after the capped deterministic report, with every advisory line passed through `plainLine`.
- [x] Markdown: append an `## Advisory (LLM)` section with a one-line note that it is opt-in LLM output separate from the deterministic findings.
- [x] JSON: add an optional `advisory` field to the display whitelist only (`ReportV2 & { advisory?: AdvisoryText }`), omitted entirely without the flag for byte-identical output; do not extend `ReportV2` itself.

## Task 4: Documentation

- [x] Document `--advisory` (literal flag string) in the README analysis section.
- [x] Update the 0.3-candidate paragraph to implemented (opt-in).
- [x] Extend the privacy section: nothing is sent by default; with `--advisory` only the display-report JSON (findings, command names, file paths possible) goes through the local `claude` CLI; raw session logs are never sent.
- [x] Qualify the intro determinism claims minimally so they do not contradict the opt-in layer.

## Task 5: Tests and verification

- [x] Parse tests: `--advisory` accepted once, duplicate rejected, existing analyze parse expectations updated with `advisory: false`.
- [x] Fake-runner success: separated advisory section in TTY, JSON, and Markdown; control characters and ANSI sanitized; text truncated to 2 000 characters.
- [x] Fake-runner failure, timeout, empty output, and thrown runner: exactly one warning, byte-identical deterministic report, exit code 0 preserved through `runCli`.
- [x] Flag omitted: JSON has no `advisory` key, output byte-identical, runner never invoked.
- [x] Prompt contract: `claude -p` receives fixed instructions plus `renderJsonReport` output only, with the 60-second timeout.
- [x] `test/docs.test.ts` and the full `npm run check` pass.
