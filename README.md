# ccprof

`ccprof` is a local profiler that reconciles Claude Code and Codex session logs
with the final Git diff, one PR at a time, and shows where minutes can be
recovered — with evidence and a fix recipe attached. It uses only
deterministic rules, so the same input always produces the same result. No LLM
is involved in the analysis; the opt-in `--advisory` flag can append a clearly
separated LLM advisory section to the output, but the deterministic report
itself never changes.

ccprof measures wasted time in the working process; it does not measure
whether the judgment behind the work was right — choice of approach,
interpretation of requirements, or design quality are out of scope. This is a
deliberate boundary, not an oversight: it is what keeps the analysis
deterministic (no LLM, reproducible). The explicitly opt-in advisory layer
described below is the one exception, and its output stays outside the
deterministic report.

## Requirements and installation

- Node.js 20 or newer
- `git`
- `gh`, but only when resolving a PR number/URL or the current PR from GitHub

Install the published package globally once. From then on the command is always
`ccprof`.

```sh
npm install --global ccprof
ccprof --help
```

To work from source, install the dependencies, build, and link.

```sh
git clone https://github.com/t09tanaka/ccprof.git
cd ccprof
npm install
npm run build
npm link
ccprof --help
```

## Quick start

Run it inside a repository with no arguments to analyze the current PR — or,
when none is found, the diff between the default branch and `HEAD` — and print
a single-screen TTY report.

```sh
ccprof
```

Selecting the current PR explicitly does the same thing.

```sh
ccprof --pr
```

The primary path for agents is JSON v2.

```sh
ccprof --pr --json
ccprof --pr 123 --json
ccprof --pr https://github.com/example/project/pull/123 --json
```

Naming a local base/head directly analyzes without any network access for PR
metadata.

```sh
ccprof --pr main...feature
ccprof --pr main..feature --json
```

Markdown for a PR comment is produced explicitly.

```sh
ccprof --pr main...feature --md
ccprof --pr 123 --md | gh pr comment 123 --body-file -
```

## Commands

```text
ccprof
ccprof --pr [<number|url|base...head>] [--json|--md]
       [--idle-threshold <duration>] [--test-map <path>]
       [--since <RFC3339>] [--commit-lookback <duration>]
ccprof stats [--json]
ccprof dismiss <finding-key> [--reason <text>]
ccprof hook-event [--notify]
ccprof hooks install|uninstall [--global] [--yes]
ccprof --version
```

`--version` (or `-v`) prints `ccprof <version>` and exits 0; `--help` (or `-h`)
prints the usage above. When both are given, `--help` wins.

### Analysis

There are three output formats.

| Invocation | Output |
|---|---|
| `ccprof --pr 123` | A compact TTY report for humans |
| `ccprof --pr 123 --json` | JSON v2 for agents |
| `ccprof --pr 123 --md` | Markdown for a PR comment |

`--json` and `--md` cannot be combined. `--idle-threshold` accepts a bare number
(minutes) or a duration suffixed with `s`, `m`, or `h`.

`--since` sets an explicit analysis start and requires an RFC3339 date-time with
an explicit timezone (`Z`/`z` or `±HH:MM`). Sub-millisecond fractional digits are
truncated deterministically. Leap seconds and timestamps before the Unix epoch
are unsupported. `--commit-lookback` extends the inferred earliest-commit
boundary by a duration using the same `s`, `m`, or `h` syntax. Both options may
be provided; `--since` takes precedence over `--commit-lookback`.

`--advisory` opts in to an additional LLM advisory section:
the rendered report JSON is passed to the locally installed `claude` CLI
(Claude Code, print mode), and up to three judgment-level suggestions come
back in a section that is clearly separated from the deterministic findings.
The deterministic report, the stored analysis record, the baseline, and the
exit code never change; when the `claude` CLI is missing, fails, times out
(60 seconds), or returns nothing, the report is printed unchanged with an
`advisory unavailable` warning on stderr. In `--json` output the section is an
optional top-level `advisory` field (`{ "source": "llm", "text": ... }`) that
is omitted entirely without the flag, keeping the JSON byte-identical to
previous releases.

```sh
ccprof --pr --idle-threshold 45m
ccprof --pr main...feature --idle-threshold 2h --json
ccprof --pr 123 --test-map /absolute/path/to/ccprof-test-map.json --json
ccprof --pr --since 2026-08-03T09:00:00+09:00 --json
ccprof --pr --commit-lookback=2h --json
```

PR resolution order is: an explicit `base...head` / `base..head`, an explicit PR
number or URL, the current PR, and finally the remote default branch (then
`main`, then `master`) against `HEAD`.

### Stats

Shows the analysis history, baseline, per-rule time, and chronic command cost
stored for the current repository. When the same `finding_key` appears in two or
more analyses it is listed under Recurring findings with the trend between its
first and latest recoverable estimate (improved / worsened / flat).

Adoption is detected deterministically: once a suggestion from a past analysis
is acted on — a `CLAUDE.md` edit, or an edit to the finding's target file, that
appears in git history after the finding was recorded — `stats` lists it under
Adopted suggestions with its outcome: whether the finding recurred after
adoption, the minutes recoverable before and after adoption, and `no_data` when
no analysis has run since. This is **observational only: recurrence absence
does not prove causation**. Findings whose adoption cannot be detected this way
(no target file, or a target outside the repository) are counted separately in
an adoption-coverage line, so the detection gap is visible rather than silently
under-reported.

```sh
ccprof stats
ccprof stats --json
```

### Dismissing a finding

Pass the stable `finding_key` shown in the JSON, TTY, or Markdown output. The
reason is optional.

```sh
ccprof dismiss <finding-key>
ccprof dismiss <finding-key> --reason "Full verification is intentional in this repository"
```

The same key stays suppressed for 14 days and expires exactly at 14 days. Even
within that window the finding reappears if its recoverable estimate becomes
**strictly greater than 2×** the estimate at dismissal time, and the stored
reason is surfaced as a caveat.

### Hooks (automatic notifications)

```sh
ccprof hooks install
ccprof hooks install --global
ccprof hooks uninstall
```

`ccprof hooks install` registers a Claude Code Stop hook (`ccprof hook-event
--notify`) that runs at the end of every agent turn. Installing is idempotent
and preserves the surrounding `.claude/settings.json` verbatim, including key
order; running it again when the entry already exists is a no-op. By default
it edits the repository's `.claude/settings.json`; `--global` targets
`~/.claude/settings.json` instead. Outside an interactive terminal, pass
`--yes` to skip the confirmation prompt. The installed hook invokes
`ccprof` by name, so it requires `ccprof` to be resolvable on `PATH` (e.g.
via `npm install --global ccprof`); if it isn't, `hooks install` still
installs the entry but prints a warning. `ccprof hooks uninstall` (with the
same `--global`/`--yes` flags) removes only the ccprof-installed entry,
leaving any other hooks untouched. Both actions report when there is nothing
to do, and print the settings path they wrote to.

The installed hook does two things on every Stop event:

- It records the real end-of-turn wall-clock time to a per-repository
  `hook-events.jsonl` log, and `ccprof --pr` uses it to extend a session's
  measured end time (within a 30-minute window) whenever it postdates the log
  timestamp. This improves on the log-write-time caveat below for session end
  times specifically, and such hook-verified tails count as active time (not
  idle) as long as they fall within the idle threshold.
- Once per 10 minutes, it also runs a persist-free `ccprof --pr` analysis and
  prints a short findings summary — a notification only. It never blocks the
  agent, never writes an analysis record to the store, and any hook failure
  (bad payload, no repo, an unwritable store) is designed to degrade to
  silent success: the underlying `ccprof hook-event` command always exits 0.

`ccprof hook-event` itself is the hook entrypoint invoked by Claude Code; it
is not meant to be run manually, but is documented here for completeness.
Without `--notify` it only appends the Stop event to the log.

The `hook-events.jsonl` log is bounded automatically: whenever an append
pushes it past 1 MiB, the hook compacts it in place, dropping rows older
than 30 days (and, if that still is not enough, the oldest remaining rows)
so the log never stays above 1 MiB. Compaction is best-effort — like every
other hook failure mode, a failed compaction degrades to silent success.

## JSON v2

In JSON mode, stdout is a single JSON document with no extra logging mixed in.
Warnings go to stderr. The report lists the top 1–3 findings by recoverable
time, but every finding produced by the analysis is written to the store.

```json
{
  "version": 2,
  "unit": {
    "repo": "/work/project",
    "pr_ref": "main...feature",
    "sessions": ["session-1"]
  },
  "summary": {
    "measured_min": 52,
    "idle_excluded_min": 35,
    "estimated_floor_min": 38,
    "recoverable_min": 14,
    "human_wait_min": 4,
    "unexplained_min": 2,
    "baseline": null
  },
  "findings": [
    {
      "finding_key": "6d4f...",
      "rule_id": "R002",
      "title": "Redundant test or build runs",
      "classification": "behavior",
      "cause": null,
      "scope": "this_pr",
      "confidence": "high",
      "evidence": {
        "session_refs": ["session-1#entry-42"],
        "interval_ids": ["R002:session-1#entry-42"],
        "command": "npm test",
        "count": 2
      },
      "recoverable": {
        "min": 14,
        "bound": "point"
      },
      "fix_recipe": {
        "suggestion": "Run the targeted tests while iterating and full verification once at the end",
        "verify": "npm test"
      },
      "caveats": []
    }
  ],
  "caveats": []
}
```

The time fields mean:

```text
raw_observed = measured_min + idle_excluded_min
measured_min = normal_min + point_recoverable_min + human_wait_min + unexplained_min
estimated_floor_min = measured_min - point_recoverable_min
```

`human_wait_min` is sub-threshold human wait (waiting for a reply between turns
and waiting for an AskUserQuestion answer). It is reported separately because it
is not agent inefficiency. Waits that can be proven to be approval-driven still
count toward `recoverable_min` as before. `unexplained_min` is active time that
could be classified neither as normal cost nor as a deterministic reduction
candidate. It is kept so that unknown waste is never silently folded into normal
cost. Findings with `bound: "upper"` are displayed but do not reduce the
estimated floor.

### How `scope` is used

- `this_pr`: a candidate you can fix and re-verify in the current feature PR
- `separate_issue`: a candidate to propose as separate work, e.g. repository infrastructure
- `claude_md`: a candidate improvement to the Claude Code workflow or `CLAUDE.md`

The integration templates only auto-fix `this_pr` in the current PR.
`separate_issue` and `claude_md` are presented as proposals; no Issue or extra PR
is created automatically.

## Time measurement and away time

Tool execution, inference, and human wait are assembled as intervals between
timestamps. Overlapping time across multiple sessions or sidechains is not added
up twice — the union of wall-clock intervals is used. When a single session
observed several branches, only the intervals recorded on the head branch are
counted (rows without branch information are attributed to the preceding
branch), so work and edits on other branches never leak into the current PR.

Human wait that **strictly exceeds** the idle threshold is separated out as away
time. Away time is life, not work, so it is recorded in `idle_excluded_min` and
excluded from `measured_min` and from recoverable time. Sub-threshold human wait
is reported as `human_wait_min`, split out from unexplained. Sub-threshold waits
can be summed, but logs alone cannot distinguish "stepped away" from "thinking
it over".

A known limitation is that timestamps are log write times, not the exact start
and end of a tool call or of inference. End times are never guessed for tools
whose result is missing; those are treated as zero time with low confidence. Git
itself has no branch creation time either, so when a PR creation time is
unavailable the oldest head-only commit is used as the start boundary and a
caveat is attached. For session end times specifically, installing the Stop
hook (see [Hooks (automatic notifications)](#hooks-automatic-notifications))
narrows this gap by recording the real wall-clock end of each turn instead of
relying on the last log write.

Known coordination, delegation, and investigation tools that can be identified
deterministically by name (TodoWrite / Agent / Skill / WebFetch and so on), and
known-safe single commands (`git` / `gh` and read-only ones such as `ls`, `cat`,
`rg`) are classified as normal cost rather than unexplained. Composite commands
such as `cd backend && npm test` or `npm test 2>&1 | tail` follow the same rule,
but only when every segment is known (test/build/check/vcs/read-only/`cd`) and
the whole line is interpretable apart from redirections. Unknown tools (MCP tools
and the like) and shell composition containing unknown segments or command
substitution stay unexplained as before. AskUserQuestion is treated as waiting
for a user answer (human wait) rather than as tool execution time, and is
separated into `idle_excluded_min` as away time when it strictly exceeds the idle
threshold.

## Overriding test relevance

`package.json` for JS/TS, `Cargo.toml` for Rust, and common test paths are
detected automatically. To raise precision explicitly, save the following JSON
outside the repository and pass it with `--test-map`.

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

```sh
ccprof --pr --test-map /absolute/path/to/test-map.json --json
```

Command strings recorded in the logs are used for classification only; they are
never re-executed.

## Detection rules

| ID | What it detects | Recoverable estimate | Typical scope |
|---|---|---|---|
| R001 | Rework edits that leave no trace in the final diff | point | `this_pr` / `claude_md` / `separate_issue` |
| R002 | Test or build runs unrelated to the change | point | `this_pr` |
| R003 | Re-reading the same file with no edit in between | point or upper | `claude_md` |
| R004 | Proven approval wait (other input waits go to `human_wait_min`) | point | `separate_issue` |
| R005 | Independent reads executed serially | upper | `claude_md` |
| R006 | Chronic command cost across multiple analyses | upper | `separate_issue` |
| R007 | Results over 50,000 tokens and compaction | upper | `claude_md` / `separate_issue` |
| R008 | The same test failing then passing with no related edit | point or upper | `separate_issue` |

R006 requires at least 5 past analyses, occurrences in at least 3 of them, and at
least 30% of all measured time. In Phase 1, R008 decides per normalized command
rather than per test name; failed test names are extracted deterministically from
the failing run's output and included in the evidence (`failed_tests`), for TAP,
jest, vitest, cargo, and pytest.

## Supported sources and schema drift

Two sources are discovered together by default: **Claude Code** (normally
`~/.claude/projects`) and **Codex** (normally `~/.codex/sessions`, overridden
with `CCPROF_CODEX_SESSIONS_DIR`). Sessions from both are filtered to the
repository's canonical working directory and the query's head branch before
being combined into a single analysis.

Claude Code's JSONL is an unpublished schema, so drift is absorbed at the parser
boundary. For cumulative snapshots sharing a `message.id` the final form wins,
and different content fragments split across the same ID are joined in order.
Malformed rows, unknown content blocks, and missing results degrade into warnings
and lower confidence instead of taking analyzable sessions down with them.
Sidechains and compaction are normalized as well.

Markdown, baselines, and store-driven R006 were originally Phase 2 items, but
they are included in this release. Framework-specific flaky test name
extraction remains a future extension. The opt-in LLM advisory layer that was
a candidate for 0.3 is now implemented as the `--advisory` flag — offering
judgment-level suggestions alongside the deterministic findings above, clearly
separated from them. Deterministic analysis stays the default either way;
nothing here changes without an explicit opt-in.

### Codex sessions and skipped rules

Codex's rollout transcripts do not carry every field Claude Code's logs do. A
rule whose detection is structurally blind without a capability is skipped for
sessions that lack it, rather than silently reporting a false zero:

| Rule | Requires | Why it is skipped for Codex sessions |
|---|---|---|
| R007 (context-bloat) | `token_usage` | Codex rollouts do not record per-result token counts, so the large-result and compaction thresholds have nothing to measure against. |

R005 (serial-slack) needs `tool_timestamps` and R001 (rework) needs
`edit_fragments`; Codex rollouts provide both (`apply_patch` patch bodies are
carried as edit fragments, with file paths taken from their
`*** Update/Add/Delete File:` headers), so neither rule is skipped for Codex
sessions. The authoritative mapping is `RULE_REQUIRED_CAPABILITIES` in
`src/rules/capabilities.ts`.

A rollout with no recorded git branch is still accepted on working-directory
match alone, at low confidence, rather than being dropped.

When any analyzed session lacks a capability a rule requires, that rule is
listed in `skipped_rules` in JSON v2 and summarized in the TTY and Markdown
reports as `Skipped rules (source lacks required data): ...`.

## Privacy and storage

Analysis, diff reconciliation, and store writes all happen locally; by design
ccprof never sends or uploads session contents or findings as telemetry.
Resolving a PR number/URL or the current PR may make an installed `gh pr view`
fetch metadata from GitHub. Pass `base...head` to avoid the network entirely.

By default no LLM is contacted either. Only when `--advisory` is passed
explicitly, the display-report JSON — the same document `--json`
prints, which can include findings, command names, and file paths — is handed
to the locally installed `claude` CLI, which sends it to its configured LLM
provider. Raw session transcripts and logs are never sent; the advisory prompt
contains nothing beyond fixed instructions and that report JSON.

The store lives outside the repository, in a per-repository directory:

```text
$XDG_DATA_HOME/ccprof/<sha256(canonical-repo-path)>/
~/.local/share/ccprof/<sha256(canonical-repo-path)>/
```

For verification or unusual layouts, `CCPROF_DATA_DIR` overrides the storage
root, `CCPROF_CLAUDE_PROJECTS_DIR` overrides the Claude projects directory, and
`CCPROF_CODEX_SESSIONS_DIR` overrides the Codex sessions directory.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success (including zero findings) |
| 2 | CLI usage error |
| 3 | Repository or PR context could not be resolved |
| 4 | No supported session or no analyzable timestamps |
| 5 | Unrecoverable source / git / store error |

A few corrupt JSONL rows do not produce code 5 as long as an analyzable session
remains.

## Development

```sh
npm install
npm run build
npm test
npm run typecheck
npm run check
```

Individual tests compile TypeScript into a test output directory and then run
under the Node built-in test runner. There are no runtime dependencies; only
`git`, and `gh` when needed, are invoked as external processes.

## License

MIT — see [LICENSE](LICENSE).
