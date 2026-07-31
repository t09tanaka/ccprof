# ccprof Implementation Design

**Date:** 2026-07-31

**Source of truth:** The user-provided “ccprof 設計書（第2版）”, updated to include
`summary.unexplained_min`, plus the user's explicit override that the installed
entry point is the direct `ccprof` command rather than `npx ccprof`.

## Delivery scope

The first usable release implements the complete deterministic Claude Code
pipeline:

- a `SessionSource` abstraction and a tolerant Claude Code JSONL source;
- PR resolution, session discovery, timeline attribution, diff matching, and
  test/source relevance;
- R001–R005, R007, and command-level R008;
- interval-ledger accounting, including `unexplained_min`;
- the repository-local logical store in the user data directory, dismissal
  history, and stable finding keys;
- JSON v2 and one-screen TTY output;
- a globally installable `ccprof` executable, a PR-skill snippet, and a
  `/retro` command template.

The implementation also includes the externally specified, low-coupling
reporting features from the next roadmap step: Markdown output, baseline
comparison, `stats`, and store-driven R006. Codex parsing remains an extension
point because the supplied design does not define a Codex log contract.
Framework-specific flaky-test name extraction and recipe-effect tracking remain
future refinements; command-level R008 is complete.

## Chosen approach

Use strict TypeScript compiled to an ESM Node CLI.

- `package.json` exposes `"bin": { "ccprof": "dist/cli.js" }`.
- Users install once and invoke `ccprof` directly. Development uses
  `npm link`.
- The runtime has no third-party dependencies. JSONL, filesystem traversal,
  hashing, subprocesses, ANSI output, argument parsing, and streaming use Node
  built-ins.
- Git remains an external `git` subprocess, as required by the source design.
- The parser, timeline, matcher, rules, and ledger are independently testable
  pure modules around narrow I/O adapters.

A Rust binary was considered. It would satisfy the direct executable
preference, but it adds target-specific artifact and installer work without
improving this JSONL/git-bound workload. A TypeScript global binary preserves
the original implementation rationale while still meeting the updated command
contract.

## Command contract

```text
ccprof
ccprof --pr [<number|url|base...head>] [--json|--md]
       [--idle-threshold <duration>] [--test-map <path>]
ccprof stats [--json]
ccprof dismiss <finding-key> [--reason <text>]
```

`ccprof` with no arguments analyzes the current branch. Resolution order is:

1. an explicit `base...head` or `base..head`;
2. an explicit PR number/URL via optional `gh pr view`;
3. the current PR via optional `gh pr view`;
4. the remote default branch (then `main`, then `master`) against `HEAD`.

The local `base...head` path is network-free. Git has no branch-creation
timestamp, so the earliest commit unique to the head is the deterministic start
bound. An actual PR creation time is used only when `gh` returns one; otherwise
analysis time is the end bound and the report contains a caveat.

`--idle-threshold` accepts a number of minutes or a duration ending in `s`, `m`,
or `h`. `--test-map` accepts a JSON document:

```json
{
  "mappings": [
    {
      "source": ["src/**"],
      "tests": ["test/**"],
      "commands": ["npm test", "npm run test:unit"]
    }
  ]
}
```

The environment variables `CCPROF_CLAUDE_PROJECTS_DIR` and
`CCPROF_DATA_DIR` provide explicit non-repository overrides for testing and
unusual installations. Normal use needs neither.

## Module boundaries

```text
src/
  cli.ts                     process boundary and exit codes
  commands/                  analyze, stats, dismiss orchestration
  core/
    model.ts                 normalized events and JSON v2 contract
    intervals.ts             interval union/subtraction/overlap
    ledger.ts                exclusive time attribution and summary
    analyze.ts               deterministic pipeline coordinator
  sources/
    session-source.ts        source interface
    claude/discover.ts       ~/.claude/projects discovery/filtering
    claude/parser.ts         tolerant JSONL parser and snapshot dedupe
  git/
    client.ts                safe argv-based git/gh subprocess adapter
    pr-context.ts            base/head/time resolution
    diff.ts                  final diff and revert evidence
  analysis/
    timeline.ts              tool/inference/human/away intervals
    command.ts               command normalization and result status
    diff-matcher.ts          edit/run/read contribution classification
    test-map.ts              manifest, path fallback, explicit override
  rules/                     R001–R008 pure detectors
  store/                     analyses, dismissals, baselines
  reporters/                 JSON, TTY, Markdown, stats
```

No module imports a reporter from the deterministic core. I/O adapters return
warnings as data; malformed source rows or unavailable optional integrations do
not abort an otherwise useful analysis.

## Normalized source model

Every parsed session contains identity, source path, observed cwd/branch values,
warnings, and ordered normalized events. Event kinds are:

- genuine user message;
- assistant message;
- tool use;
- tool result;
- compaction.

Tool uses carry the original tool-use ID, tool name, normalized command when
present, extracted paths, edit payload fragments when available, and the stable
`<session-id>#<entry-uuid>` reference. Tool results carry success/failure,
bounded output text, byte/token estimates, and the matching tool-use ID.

For assistant snapshot rows, the parser groups only rows with a non-empty
`message.id` and retains the last file-order snapshot. Rows without that ID are
never deduplicated. Malformed lines, invalid timestamps, missing results, and
unknown content blocks become warnings or low-confidence partial events rather
than fatal errors.

## Timeline and wall-clock model

Tool uses are paired with results by tool-use ID. Missing results produce a
zero-duration, low-confidence action rather than an invented end time.

Each agent/sidechain gets an ordered timeline. Across agents and sessions,
measured wall-clock uses interval union, never duration summation. Categories
are:

- tool execution: tool use to matching result;
- inference/API: genuine user or tool result to the next assistant event;
- human wait: a completed assistant turn to the next genuine user event;
- away: a human-wait interval strictly greater than the configured threshold.

Away intervals are removed from active measured time. Nested or overlapping
sidechain work is unioned. A finding touching concurrent agent intervals is
marked `bound: "upper"`.

## Time ledger and `unexplained_min`

The updated specification contains two incompatible wordings: the schema
example and TTY example treat measured time as idle-excluded, while the added
identity includes idle within measured time. The implementation preserves both
quantities and exposes the schema with these definitions:

```text
raw_observed       = measured_min + idle_excluded_min
measured_min       = normal_min + point_recoverable_min + unexplained_min
estimated_floor_min = measured_min - point_recoverable_min
```

All values come from interval set operations before rounding. No summary value
is calculated by summing finding durations.

The ledger owns each point-attributed interval once, using this precedence:

1. R008 flaky-test investigation;
2. R001 rework;
3. R002 redundant run;
4. R003 rediscovery and R007 context bloat;
5. R004 approval-related human wait, which is normally disjoint.

R005 and any other `upper` finding remain visible and ranked but do not reduce
`estimated_floor_min`, because the summary schema cannot honestly express an
upper-bound total. Normal time is positively identified contributing
edit/run/read work and its directly adjacent inference. Remaining active time
is `unexplained_min`; it is never silently treated as normal.

General model/API latency is not recoverable. R001 may include only the
inference interval directly enclosed by a proven non-contributing edit block.
For R003, token size is evidence; the recoverable estimate uses the measured
duplicate-read execution and directly caused post-result inference interval,
not a fabricated universal token-to-minute conversion.

## Diff matching

The git adapter obtains:

- `git diff --find-renames --binary base...head`;
- changed paths and textual added content;
- `git log base..head` subjects and changed paths, including revert subjects.

Edit tools expose paths and inserted/replacement fragments when the log schema
provides them. An edit contributes when its path survives in the final diff and
a meaningful normalized fragment survives in the final file/diff. A path-only
edit to a changed file is classified as contributing with lower confidence.
An edit with a strong payload whose path or payload does not survive is rework.
Opaque shell mutations, binary hunks, deletes, and ambiguous renames are not
called rework without supporting revert evidence; they remain unexplained with
a caveat.

Reads are safe by default. A repeated read becomes an R003 candidate only when
the same normalized path is read again without an intervening edit, and the
first read completed successfully.

## Command and test relevance

Command normalization removes harmless whitespace differences and known
wrapper prefixes while preserving target/filter arguments. Commands are never
re-executed from parsed text.

Test/build recognition has three confidence levels:

1. explicit `--test-map`: high;
2. `package.json`/Cargo conventions and script names: medium or high;
3. conservative path/command fallback: low.

A repeated full-suite command is redundant only when no relevant edit occurred
since the previous successful equivalent run. A targeted command is redundant
when the intervening edited paths cannot map to its explicit targets. The first
validation after relevant edits is normal.

R008 requires the same normalized test command to fail then pass with no
relevant edit between them. Unrelated intervening edits lower confidence.
Timeout/cancellation without a definite failure is not a flaky-test signal.

## Rules and finding contract

Every detector returns candidates containing:

- `finding_key`, derived from `(rule_id, normalized target)`;
- the version-2 schema fields;
- concrete evidence and session references;
- point or upper recoverable intervals used by the ledger;
- a specific suggestion and verification command;
- caveats explaining degraded evidence.

Findings are sorted by recoverable minutes descending, then rule ID, then key.
Reporters show one to three non-dismissed findings. The store receives all
findings before display filtering.

Cause labels and scope follow the source design. In particular:

- R001 chooses only evidence-backed causes, otherwise `unknown`;
- R002 is behavior/`this_pr`;
- R003 and R005 are behavior/`claude_md`;
- R004 is config/`separate_issue`;
- R006 and R008 are repo/`separate_issue`;
- R007 is behavior/`claude_md` unless the target is an external tool, then
  repo/`separate_issue`.

## Store and dismissal

The store root is
`$XDG_DATA_HOME/ccprof/<sha256(canonical-repo-path)>/`, falling back to
`~/.local/share/ccprof/…`. It contains immutable per-analysis JSON records, a
small deterministic history index, and dismissal records.

Writes use a temporary sibling plus rename. No database, queue, lock, migration,
or recovery daemon is introduced. A write failure produces a stderr warning and
still returns the analysis.

A dismissal records key, reason, timestamp, and the finding's recoverable
strength. It suppresses the same key for 14 days. At exactly 14 days it expires;
within the window, only a new strength strictly greater than twice the dismissed
strength revives it. The prior reason is added as a caveat when revived.

Baseline output uses up to the previous ten analyses and remains `null` until
three exist. R006 requires at least five historical analyses, occurrence in at
least three, and a normalized command accounting for at least 30% of measured
time across those analyses. These constants are reported in evidence.

## Reporting and errors

JSON stdout contains only one valid JSON v2 document. Warnings and operational
errors go to stderr. TTY output begins with the one-line conclusion, shows at
most three findings, and ends with compact caveats. Markdown is pipe-safe and
contains no ANSI escapes.

Exit codes:

- `0`: analysis/report/dismiss/stats succeeded, including no findings;
- `2`: CLI usage error;
- `3`: repository or PR context cannot be resolved;
- `4`: no matching sessions or no analyzable timestamps;
- `5`: unrecoverable source/git/store error.

Partial malformed JSONL does not produce exit 5 when at least one session remains
analyzable.

## Testing strategy

Use the built-in Node test runner against TypeScript compiled by a dedicated
test tsconfig. Fixtures cover:

- duplicate assistant snapshots and malformed/missing fields;
- tool pairing, away threshold boundaries, and sidechain interval union;
- edit survival/rework, rename/delete/binary ambiguity, and revert evidence;
- JS and Rust command relevance plus explicit test maps;
- every rule, including overlap precedence and R008 fail→pass;
- time-accounting identities before and after rounding;
- dismissal boundaries and strength revival;
- JSON shape, deterministic ordering, TTY/Markdown content, CLI exit codes;
- a fixture repository/session end-to-end analysis.

After unit/integration verification, run the built CLI read-only against
available real Claude Code histories with the data store redirected to a
temporary directory. Real-log findings are a validation gate, not golden test
data and are never committed.
