# Codex Streaming Parser Implementation Plan

> **Goal:** Read Codex rollout JSONL files line by line with the same streaming pattern as the Claude parser, instead of slurping each file into a single string, without changing any parser output.

## Scope

- Change `parseCodexSession` to a path-based async API: drop `raw` from `ParseCodexSessionOptions` and return `Promise<Session | null>`.
- Stream rollout files via `createReadStream` + `readline.createInterface({ crlfDelay: Infinity })` with a manual 1-based line counter, mirroring `src/sources/claude/parser.ts`.
- Keep every output byte identical: `entry_uuid` `line-N` numbering, warning order and wording, `source_index`, `session_ref`, the session_meta lookup semantics, the `response_item` presence check, the null return for zero events, and the file-name-stem session id fallback.
- In `discoverCodexSessions`, call `parseCodexSession` directly and keep emitting the existing `codex_source_read_error` global warning when the file cannot be read (the stream now rejects instead of `readFile` throwing).
- Do not touch golden fixtures; `test/determinism-golden.test.ts` must pass unchanged.

## Line-splitting note (lone `\r`)

The previous implementation split on `/\r\n|\r|\n/`, so a lone `\r` was a row separator. The streaming implementation adopts the Claude parser's `readline` behavior (`crlfDelay: Infinity`), which also treats `\r\n`, `\n`, and a lone `\r` as line terminators. Unifying on `readline` is an intentional alignment with the Claude parser; no existing test or golden fixture depends on lone-`\r` separators, and all pass unchanged.

## Files

- `src/sources/codex/parser.ts`
- `src/sources/codex/discover.ts`
- `test/codex-parser.test.ts`
- this plan

## Task 1: Streaming parser

- [x] Convert `parseRows` to an async streaming reader (`createReadStream` + `readline`, manual line counter), preserving all validation branches, warning order, and wording.
- [x] Make `parseCodexSession` async and path-based; remove `raw` from `ParseCodexSessionOptions`.
- [x] Update the module doc comment to describe streaming and rejection on unreadable files.

## Task 2: Discovery call site

- [x] Remove the `readFile` slurp from `discoverCodexSessions` and pass `sourcePath` directly.
- [x] Wrap the awaited parse in try/catch so unreadable files still yield the `codex_source_read_error` warning and are skipped.
- [x] Verify via grep that discover and the tests are the only `parseCodexSession` callers.

## Task 3: Tests

- [x] Rewrite `test/codex-parser.test.ts` to the async path-based API: fixture cases pass the fixture path, inline-raw cases write a temp file under `mkdtemp` (named so the file-name-stem fallback still matches) and clean up with `t.after`.
- [x] Confirm `test/codex-discover.test.ts` needs no changes (it already exercises real files on disk).

## Task 4: Verification and delivery

- [x] `npm run check` green: 466/466 tests pass, typecheck clean.
- [x] `test/determinism-golden.test.ts` passes with zero fixture changes.
- [x] Commit implementation and plan separately (no push).
