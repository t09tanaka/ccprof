# Parser Resource Budgets Specification

## Scope

This change bounds the resources consumed while parsing one Claude Code or
Codex JSONL transcript. It adds programmatic, optional parser controls and
keeps every existing caller source-compatible.

Normalized-event budgeting and the incremental mtime/size/hash catalog are
intentionally excluded. They are separate PRs because an event cap must be
enforced before event materialization and in physical cross-session source
order, while persistent caching has a separate lifecycle. Combining either
with bounded ingestion would exceed the repository's review limit.

Package version `0.2.0`, report schema v2, and store schema v2 remain unchanged.

## API

Both parser option types accept:

```ts
interface JsonlParserControls {
  budgets?: Partial<JsonlParserBudgets>;
  signal?: AbortSignal;
}

interface JsonlParserBudgets {
  maxFileBytes: number;
  maxLineBytes: number;
  maxNodesPerLine: number;
  maxNestingDepth: number;
  maxRetainedBytes: number;
  maxWarnings: number;
}
```

Omitted controls use finite exported defaults. Every supplied limit must be a
nonnegative safe integer. Invalid controls fail before opening the transcript.

## Semantics

- File and line limits count physical input bytes, not UTF-16 code units.
  Limits are inclusive: a file or line exactly at its limit is accepted.
- The line reader consumes bounded `Buffer` chunks and never asks
  `readline` to assemble an unbounded line.
- `maxNodesPerLine` counts the parsed JSON root plus all descendant JSON values
  using an iterative walk. `maxNestingDepth` is checked by that same walk before
  recursive schema adapters run. An over-budget row is skipped; later rows may
  still be parsed.
- `maxRetainedBytes` counts the physical bytes of valid rows retained for
  normalization. When the next row would cross the limit, parsing stops at
  the previous complete row.
- `maxWarnings` includes the terminal warning-budget marker. Once the cap is
  reached, further warnings are discarded without growing memory.
- A file, line, or retained-byte limit returns the safely parsed prefix
  with a `parser_*_budget_exceeded` warning whenever a session can be returned.
  Claude's detailed result can carry the warning even with no session. Codex
  rejects with `ParserBudgetExceededError` only when no event exists to carry
  the warning; discovery already converts parser rejection into a source
  warning.
- Abort is not a parser warning. A pre-aborted or mid-read `AbortSignal`
  rejects with the original `signal.reason`, closes the stream, and returns no
  misleading partial success.

## Edge cases

- An unterminated final line is still a line and is subject to its byte limit.
- CRLF delimiters are not part of the line-content limit; both bytes still
  count toward the physical file budget.
- Split UTF-8 sequences are reassembled from raw buffers before decoding.
- A single deeply nested or very wide row cannot reach recursive adapters after
  exceeding the iterative depth/node checks.
- Empty and malformed-row floods cannot create unbounded warning arrays.
- A budget of zero accepts no unit of that resource and never divides by or
  silently substitutes a default.
- Budget exhaustion never changes already accepted event identities, order,
  status evidence, or timestamps.

## Acceptance tests

- Both parser APIs remain callable with their previous arguments.
- Exact-boundary and one-byte-over file/line cases are deterministic.
- Deep/wide rows above the depth/node caps are skipped and warned.
- Retained row bytes never exceed their configured cap.
- A generated large JSONL fixture terminates with bounded retained rows and
  warnings instead of retaining the complete fixture.
- Abort rejects with the original reason and is not converted into a partial
  `Session`.
- Existing parser fixtures remain byte-for-byte behaviorally unchanged under
  default controls.
