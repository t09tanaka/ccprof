# Parser Resource Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound file, line, JSON-node/depth, retained-byte, and warning memory growth in both JSONL parsers, with cooperative `AbortSignal` cancellation.

**Architecture:** A source-neutral bounded byte-line reader and budget tracker live in `src/sources/jsonl-budget.ts`. Claude and Codex keep their existing normalization logic, but feed it only rows admitted by the shared tracker; optional controls extend existing option objects without breaking callers. Normalized-event budgeting is a follow-up because it must stop work before event materialization and preserve physical order across Claude sessions.

**Tech Stack:** Node.js streams and `AbortSignal`, strict TypeScript, `node:test`.

---

### Task 1: Lock the resource contract with failing tests

**Files:**
- Modify: `test/claude-parser.test.ts`
- Modify: `test/codex-parser.test.ts`

- [x] **Step 1: Add Claude RED cases**

Add tests that pass `budgets` and `signal` to
`parseClaudeTranscriptDetailed`. Cover an overlong CRLF line, node-heavy and
over-depth rows followed by a valid row, a malformed-row warning flood, a
retained-byte prefix, and pre/mid-read aborts. Assert stable warning codes,
inclusive boundaries, and original abort-reason identity.

```ts
const parsed = await parseClaudeTranscriptDetailed(path, {
  budgets: { maxLineBytes: 128, maxWarnings: 4 },
});
assert.ok(parsed.warnings.some(({ code }) =>
  code === "parser_line_budget_exceeded"));
assert.ok(parsed.warnings.length <= 4);
```

- [x] **Step 2: Add Codex RED cases**

Generate a large rollout at test runtime and configure small retained-byte and
warning caps. Also cover file bytes, nodes/depth, and AbortSignal without
checking process-global RSS thresholds.

```ts
const session = await parseCodexSession({
  sourcePath,
  budgets: { maxRetainedBytes: retainedBytes, maxWarnings: 4 },
});
assert.ok(session);
assert.equal(session.events.length, 64);
assert.ok(session.warnings.length <= 4);
```

- [x] **Step 3: Delegate the focused RED run**

Run:

```bash
npm run build:test
```

Expected: TypeScript rejects the new `budgets` / `signal` option properties or
their imports because production support does not exist yet. Record that this
is the expected feature-missing failure before changing production code.

### Task 2: Add the shared bounded JSONL primitive

**Files:**
- Create: `src/sources/jsonl-budget.ts`
- Test: `test/claude-parser.test.ts`
- Test: `test/codex-parser.test.ts`

- [x] **Step 1: Define finite defaults and validation**

Define and export the shared types, defaults, typed budget error, and tracker.
The implementation accepts zero and rejects negative, fractional, infinite, or
unsafe values.

```ts
export interface JsonlParserBudgets {
  maxFileBytes: number;
  maxLineBytes: number;
  maxNodesPerLine: number;
  maxNestingDepth: number;
  maxRetainedBytes: number;
  maxWarnings: number;
}

export interface JsonlParserControls {
  budgets?: Partial<JsonlParserBudgets>;
  signal?: AbortSignal;
}
```

- [x] **Step 2: Stream bounded physical lines**

Use `createReadStream` in buffer mode, scan chunks for LF, retain at most one
configured line, and yield `{ text, bytes, line }`. Check cumulative file bytes
and `signal` before work; destroy the stream in `finally`.

```ts
export async function* boundedJsonlLines(
  sourcePath: string,
  tracker: JsonlBudgetTracker,
): AsyncGenerator<JsonlLine> {
  tracker.throwIfAborted();
  const input = createReadStream(sourcePath, tracker.signal === undefined
    ? {} : { signal: tracker.signal });
  let parts: Buffer[] = [], partBytes = 0, fileBytes = 0, line = 1;
  try {
    for await (const value of input) {
      tracker.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const admittedLength = Math.min(chunk.byteLength, Math.max(0,
        tracker.budgets.maxFileBytes - fileBytes));
      const admitted = chunk.subarray(0, admittedLength);
      fileBytes += admittedLength;
      let offset = 0;
      while (offset < admitted.byteLength) {
        const newline = admitted.indexOf(0x0a, offset);
        const end = newline < 0 ? admitted.byteLength : newline;
        const part = admitted.subarray(offset, end);
        const bufferedBytes = partBytes + part.byteLength;
        const lastByte = part.at(-1) ?? parts.at(-1)?.at(-1);
        tracker.assertLineBytes(
          bufferedBytes - (lastByte === 0x0d ? 1 : 0), line,
        );
        if (part.byteLength > 0) { parts.push(part); partBytes += part.byteLength; }
        if (newline < 0) break;
        const raw = Buffer.concat(parts, partBytes);
        const content = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
        yield { text: content.toString("utf8"), bytes: content.byteLength, line };
        parts = []; partBytes = 0; line += 1; offset = newline + 1;
      }
      if (admittedLength < chunk.byteLength) {
        throw new ParserBudgetExceededError("file", line);
      }
    }
    if (partBytes > 0) {
      const raw = Buffer.concat(parts, partBytes);
      tracker.assertLineBytes(raw.byteLength, line);
      yield { text: raw.toString("utf8"), bytes: raw.byteLength, line };
    }
  } catch (error) {
    if (tracker.signal?.aborted === true) tracker.throwIfAborted();
    throw error;
  } finally {
    input.destroy();
  }
}
```

- [x] **Step 3: Bound nodes/depth, retained bytes, and warnings**

Count JSON nodes and nesting depth with an explicit stack before recursive
schema adapters run. Track valid-row bytes before retaining the row. Provide a
warning array whose overridden `push` never grows beyond `maxWarnings` and
reserves the last slot for `parser_warning_budget_exceeded`.

- [x] **Step 4: Delegate focused GREEN verification**

Run the focused compiled parser budget and abort tests. Result: all 14/14
focused cases passed after GREEN.

### Task 3: Integrate budgets into the Claude parser

**Files:**
- Modify: `src/sources/claude/parser.ts`
- Test: `test/claude-parser.test.ts`

- [x] **Step 1: Extend the existing options without breaking instrumentation**

```ts
export interface ClaudeTranscriptParseOptions
  extends ClaudeParserInstrumentation, JsonlParserControls {
  endedAtMs?: number;
}
```

- [x] **Step 2: Replace `readline` row ingestion**

Read shared bounded lines, parse JSON only after line admission, check the node
budget before compaction, reserve retained bytes before `rows.push`, and map
budget errors to stable `SourceWarning` codes. Keep row line/source indices and
all current default parsing behavior.

- [x] **Step 3: Reject deep rows, preserve abort reasons, and avoid spread bounds**

Check the signal while grouping and normalizing. Reject over-depth rows before
recursive helpers, rethrow the original reason for mid-read cancellation, and
compute session timestamp bounds iteratively rather than spreading a large
array into `Math.min`/`Math.max`.

- [x] **Step 4: Delegate Claude GREEN verification**

Run:

```bash
npm run build:test && node --test --test-name-pattern="budget|abort|large" .test-dist/test/claude-parser.test.js
```

Expected: all matching Claude tests pass with no unexpected warnings.

### Task 4: Integrate budgets into the Codex parser

**Files:**
- Modify: `src/sources/codex/parser.ts`
- Test: `test/codex-parser.test.ts`

- [x] **Step 1: Extend `ParseCodexSessionOptions`**

```ts
export interface ParseCodexSessionOptions extends JsonlParserControls {
  sourcePath: string;
  endedAtMs?: number;
}
```

- [x] **Step 2: Admit only bounded rows**

Use the same line, node/depth, retained-byte, warning, and abort behavior as
Claude. Keep Codex's metadata precedence and status evidence unchanged. If
exhaustion occurs before any event exists, rethrow the typed budget error rather
than returning an unexplained `null`.

- [x] **Step 3: Delegate Codex GREEN verification**

Run:

```bash
npm run build:test && node --test --test-name-pattern="budget|abort|large" .test-dist/test/codex-parser.test.js
```

Expected: all matching Codex tests pass with bounded retained rows and warnings.

### Task 5: Document and verify the bounded parser contract

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-03-parser-resource-budgets.md`

- [x] **Step 1: Document defaults and behavior**

In “Supported sources and schema drift”, state that both JSONL adapters use
finite physical file/line, JSON-node/depth, retained-byte, and warning limits;
exhaustion preserves a warned prefix, and programmatic callers can supply an
AbortSignal.

- [x] **Step 2: Delegate full validation**

Run the repository's Node 20 local workflow equivalents: typecheck, the full
unit suite, deterministic golden test, package smoke, and the CodeQL npm build
step. Keep CodeQL initialization/analysis and dependency review remote-only.

- [x] **Step 3: Reassert scope and protected versions**

Confirm at most 10 changed files, no more than 300 added production lines, and
no diff in `package.json`, `package-lock.json`, report schema, or store schema.

- [x] **Step 4: Commit only after the orchestrator lifts the current hold**

```bash
git add README.md src/sources/jsonl-budget.ts \
  src/sources/claude/parser.ts src/sources/codex/parser.ts \
  test/claude-parser.test.ts test/codex-parser.test.ts \
  docs/superpowers/specs/2026-08-03-parser-resource-budgets.md \
  docs/superpowers/plans/2026-08-03-parser-resource-budgets.md
git commit -m "feat(parser): enforce transcript resource budgets"
```

Expected: a normal verified commit; never use `--no-verify` or amend.

## Current validation record

- TDD RED reproduced the missing `budgets`/`signal` API and shared module, then
  the review-remediation RED cases reproduced both remaining P2 defects.
- Delegated GREEN verification passed all 14/14 focused parser budget and abort
  cases.
- Before rebasing, Node.js 20.20.2 passed the full 541/541 suite, build, and
  package smoke verification.
- After rebasing, the local workflow passed typecheck, all 563/563 unit tests,
  package smoke, and determinism checks. The CodeQL npm build step also passed;
  CodeQL initialization/analysis and dependency review remain remote-only.
- Independent review found two P2 defects: lone-CR EOF accounting and Codex
  nested-argument exhaustion without a surviving event. Both were fixed with
  RED-first tests, and the final code review was CLEAN.
- Scope remains 8 changed files and 298 added production lines. Package version
  `0.2.0`, report schema v2, and store schema v2 are unchanged.
- Feature and validation commits were created and rebased. Push, PR creation,
  and remote checks are still pending.
