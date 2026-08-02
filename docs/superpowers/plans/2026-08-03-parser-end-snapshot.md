# Parser End-Snapshot Freeze Implementation Plan

> **Goal:** Make a report at analysis time `T` depend only on valid transcript rows whose timestamps are at or before `T`.

## Scope

- Add an optional `endedAtMs` cutoff to the Claude and Codex parser entry points used by discovery.
- Apply the cutoff immediately after a row has been decoded as an object and its timestamp has been validated.
- Forward `SessionQuery.endedAtMs` from both discovery adapters.
- Preserve all existing behavior when no cutoff is supplied.
- Do not filter at the analysis start boundary; earlier rows can carry state needed by in-window events.
- Do not change package versions or release metadata.

## Frozen semantics

- A row with `timestampMs <= endedAtMs` is eligible; equality is inclusive.
- A row with a valid timestamp later than `endedAtMs` is ignored before session metadata, branch/cwd inheritance, cumulative snapshots, result replacement, schema warnings, or event pairing can observe it.
- Physical line numbers and Claude `source_index` values are retained; skipped rows do not renumber later rows.
- Files may contain out-of-order timestamps, so parsing continues after a skipped future row.
- Rows with malformed JSON, non-object values, or missing/invalid timestamps retain their existing warning behavior because their temporal position is not trustworthy.
- Claude auxiliary rows keep their existing invalid-timestamp exemption.

## Files

- `src/sources/claude/parser.ts`
- `src/sources/claude/discover.ts`
- `src/sources/codex/parser.ts`
- `src/sources/codex/discover.ts`
- `test/claude-parser.test.ts`
- `test/claude-discover.test.ts`
- `test/codex-parser.test.ts`
- `test/codex-discover.test.ts`
- this plan

## Task 1: Claude parser contract and row cutoff

- [x] Add `ClaudeTranscriptParseOptions` extending the current instrumentation hooks with optional `endedAtMs`.
- [x] Keep the second argument of `parseClaudeTranscriptDetailed` source-compatible for current instrumentation callers.
- [x] Pass `endedAtMs` into the streaming row reader.
- [x] After timestamp validation, skip rows with timestamps later than the cutoff before UUID fallback, metadata extraction, payload compaction, or warnings derived from row contents.
- [x] Preserve physical `line - 1` as `source_index`.

## Task 2: Claude parser regression tests

- [x] Prove the exact boundary is included.
- [x] Prove an out-of-order in-boundary row after a skipped future row is still parsed and retains its physical source index.
- [x] Prove a future cumulative assistant snapshot cannot replace or extend the in-boundary snapshot.
- [x] Prove future branch/cwd metadata and duplicate tool-result content cannot alter the frozen session.
- [x] Prove a valid future row with otherwise malformed payload does not emit payload/schema warnings.
- [x] Prove invalid or missing timestamps preserve existing warning behavior.

## Task 3: Claude discovery forwarding

- [x] Forward `query.endedAtMs` to `parseClaudeTranscriptDetailed`.
- [x] Add a discovery test whose file mtime is eligible but whose future transcript rows would otherwise alter the returned session.

## Task 4: Codex parser contract and row cutoff

- [x] Add optional `endedAtMs` to `ParseCodexSessionOptions`.
- [x] Pass it into `parseRows`.
- [x] After timestamp validation, skip future rows before validating `type` or `payload` and before emitting row-derived warnings.
- [x] Preserve existing behavior when omitted.

## Task 5: Codex parser regression tests

- [x] Prove the exact boundary is included and later out-of-order in-boundary rows remain visible.
- [x] Prove future `session_meta` cannot supply or replace session id, cwd, branch, or confidence.
- [x] Prove a future function result cannot pair with an in-boundary function call.
- [x] Prove a valid future row with an invalid type/payload does not emit a warning.
- [x] Prove invalid or missing timestamps preserve existing warning behavior.

## Task 6: Codex discovery forwarding

- [x] Forward `query.endedAtMs` to `parseCodexSession`.
- [x] Add a discovery test showing future metadata/events do not make an otherwise out-of-scope or metadata-less rollout eligible.

## Task 7: Verification and delivery

- [x] Confirm TypeScript LanguageService references for the changed option types and parser call sites.
- [x] Run focused parser/discovery tests in a dedicated validation subagent.
- [x] Run the repository check and local GitHub Actions equivalent in a dedicated validation subagent.
- [x] Confirm `git diff --check`, changed-file scope (at most 9 files), and added implementation/test lines below 300.
- [x] Confirm package/version files are unchanged.
- [ ] Commit, push, create the PR, and complete CI/review before merge.
