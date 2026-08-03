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

- Node.js 22.x and 24.x are the only supported runtimes; Node.js 20, 23, and 25 are EOL and unsupported.
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
       [--privacy <strict|balanced|raw>] [--advisory]
ccprof stats [--json] [--privacy <strict|balanced|raw>]
ccprof explain <finding-key>
ccprof dismiss <finding-key> [--reason <text>]
ccprof hook-event [--notify]
ccprof hooks install|uninstall [--global] [--yes]
ccprof data gc|delete
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

Analysis output is projected through a privacy profile before rendering. Local TTY
and JSON output default to `balanced`; Markdown defaults to `strict`, as does any
format when CI is detected. An explicit `--privacy strict`, `balanced`, or `raw`
overrides that default. See [Privacy and storage](#privacy-and-storage) before
using `raw` in logs, PR comments, or automation.

`--since` sets an explicit analysis start and requires an RFC3339 date-time with
an explicit timezone (`Z`/`z` or `±HH:MM`). Sub-millisecond fractional digits are
truncated deterministically. Leap seconds and timestamps before the Unix epoch
are unsupported. `--commit-lookback` extends the inferred earliest-commit
boundary by a duration using the same `s`, `m`, or `h` syntax. Both options may
be provided; `--since` takes precedence over `--commit-lookback`.

`--advisory` opts in to an additional LLM advisory section:
the locally installed Claude Code CLI is invoked exactly as `claude -p`, and
the complete privacy-projected report prompt is sent only over stdin—never in
argv. A UTF-8 prompt over 1 MiB is rejected before the process starts and is
never truncated. Stdout and stderr are each captured up to 64 KiB; truncated
stdout is not used as an advisory, while complete output keeps the existing
2,000-character display cap. The 60-second timeout terminates the requested
process tree. Up to three judgment-level suggestions come back in a section
that is clearly separated from the deterministic findings.

The deterministic report, the stored analysis record, the baseline, and the
exit code never change; when the `claude` CLI is missing, fails, times out,
exceeds a bound, or returns nothing, the report is printed unchanged with an
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

### Explaining a finding locally

Use the repository-bound opaque finding reference shown by `strict` or
`balanced` output to inspect its full evidence locally:

```sh
ccprof explain <finding-key>
```

The command refuses to run when CI is detected. In a local terminal it resolves
the reference through a filesystem lookup against only the current repository's
Store, selects the latest matching raw finding, and displays it without modifying
the Store. Its output is local sensitive data: it can contain full evidence,
paths, session references, and commands. Do not paste it into a PR, comment,
log, or other shared system.

Linked worktrees share one Store. Their checkout-bound reference strings can
differ, but a reference emitted by either worktree resolves the raw key and then
selects the latest matching finding across that shared Store.

Each explanation contains one fixed `Verification trust:` line. Only a trusted
result also contains a `Trusted verification command:` line. Only fixed
rule-authored literal recipes can be trusted. Dynamic recipes from R002, R006,
and R008 are always untrusted, even if their text resembles a safe command.
Never reconstruct, shorten, guess, or execute an untrusted recipe. `explain`
never spawns the verification recipe.

This local explanation does not alter raw Store records, their schema, or the
report/package version.

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
ccprof stats --privacy strict --json
```

Local stats output defaults to `balanced`; an explicit local `--privacy`
selection wins. Detected CI always enforces `strict` for stats, so
`--privacy balanced` or `--privacy raw` cannot weaken shared-log protection.
The projection is display-only and does not alter analysis history or adoption
records in the Store.

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
    "repo": "repo-1",
    "pr_ref": "ref-1",
    "sessions": ["session-1"]
  },
  "sources": [
    {
      "adapter_id": "claude",
      "adapter_version": "1.0.0",
      "source_instance_id": "source-0e596344ad7c80946741116ed2a54665d0a55027b6a78d6bfb4f1c9dd2872a6d",
      "source_kind": "claude_transcript_jsonl",
      "provided_capabilities": [
        "approvals",
        "branch_rows",
        "edit_fragments",
        "sidechains",
        "token_usage",
        "tool_timestamps"
      ],
      "required_capabilities": [],
      "provenance": "local_filesystem",
      "sensitivity": "sensitive",
      "retention_class": "raw_evidence",
      "canonical_fingerprint": "sha256:d2a320e97e2dd44189283e8d839c346dbcadac97eb0100200e27e23bafe24278"
    }
  ],
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
      "finding_key": "finding-1",
      "rule_id": "R002",
      "title": "Redundant test or build runs",
      "classification": "behavior",
      "cause": null,
      "scope": "this_pr",
      "confidence": "high",
      "evidence": {
        "session_refs": ["session-ref-1"],
        "interval_ids": ["interval-1"],
        "command": "npm test",
        "count": 2
      },
      "recoverable": {
        "min": 14,
        "bound": "point"
      },
      "fix_recipe": {
        "suggestion": "Run the targeted tests while iterating and full verification once at the end",
        "verify": "[redacted-command]"
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

## Configuring test relevance

Root `package.json` scripts for JS/TS, root `Cargo.toml` conventions for Rust,
and common test paths are detected automatically. A repository can keep more
precise mappings under version control in `.ccprof/config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/config.schema.json",
  "schema_version": 1,
  "test_map": {
    "mappings": [
      {
        "source": ["src/**"],
        "tests": ["test/**"],
        "commands": ["npm test", "npm run test:unit"]
      }
    ]
  }
}
```

The v1 contract is strict. Unknown versions or keys, malformed JSON, unsafe
repository paths, symlinks, and non-regular config files stop analysis instead
of silently falling back. The published JSON Schema is included in the npm
package as `schemas/config.schema.json`; `$schema` is optional and does not
affect analysis or its config digest.

For each command, an explicit `--test-map` mapping takes precedence over a
repository config mapping, which takes precedence over an inferred manifest
mapping. Lower-precedence mappings remain available for commands not covered by
a higher-precedence layer. Nested workspace manifests are not inferred yet; use
repository or explicit mappings for them until workspace-scoped adapters land.

For a one-off or externally managed override, save the test-map object itself
and pass it with `--test-map`:

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
never re-executed. This repository-config addition leaves the package at 0.2.0,
the JSON Report contract at v2, and the Store schema at v2.

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

Each new report includes one validated descriptor per distinct source instance.
The built-in registry accepts only `claude@1.0.0` with source kind
`claude_transcript_jsonl` and `codex@1.0.0` with source kind
`codex_rollout_jsonl`. A descriptor has exactly `adapter_id`,
`adapter_version`, `source_instance_id`, `source_kind`, sorted
`provided_capabilities`, sorted `required_capabilities`, `provenance`,
`sensitivity`, `retention_class`, and `canonical_fingerprint`. Both built-ins
currently declare no prerequisite capabilities; provided capabilities retain
the existing session-source compatibility rule where an omitted declaration
means all known capabilities.

`source_instance_id` is a domain-separated SHA-256 alias of the adapter and
NFC-normalized logical session ID, so linked-worktree copies remain stable while
the raw session ID and source path are never emitted. `canonical_fingerprint`
is a separate domain-separated SHA-256 digest of the other nine canonical
fields. Validation rejects unknown adapters, versions, fields, capability
names, NULs, malformed aliases, non-canonical capability arrays, registry or
fingerprint mismatches, and duplicate source instances with stable errors that
do not echo rejected values. The descriptor field is additive: older v2 reports
without `sources` remain readable and keep their previous rendered bytes.

Claude Code's JSONL is an unpublished schema, so drift is absorbed at the parser
boundary. For cumulative snapshots sharing a `message.id` the final form wins,
and different content fragments split across the same ID are joined in order.
Malformed rows, unknown content blocks, and missing results degrade into warnings
and lower confidence instead of taking analyzable sessions down with them.
Sidechains and compaction are normalized as well.

Both JSONL adapters enforce finite per-transcript parser budgets by default:
512 MiB per file, 8 MiB per physical line, 200,000 JSON nodes per line, nesting
depth 128, 128 MiB of retained valid-row bytes, and 1,000 warnings. Exhaustion
preserves a deterministic warned prefix (a node-heavy or over-depth row alone
is skipped), while a warning flood is capped. Programmatic parser callers can
override individual limits and supply an `AbortSignal`; limits are inclusive,
CRLF delimiters do not consume the line-content budget, and cancellation
rejects with its original reason instead of returning a misleading partial
success.

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

Before JSON, Markdown, or TTY output is rendered, ccprof applies one of three
display-only privacy profiles:

| Profile | Intended use | Output policy |
|---|---|---|
| `strict` | CI logs and PR comments | Replaces repository, finding, session, reference, and interval identities with opaque aliases; drops detailed evidence and all but a small fixed allowlist of safe verification commands; groups warnings by code and count. |
| `balanced` | Local TTY and JSON inspection | Keeps useful repository-relative evidence and safe commands while redacting absolute paths, raw session identities, URLs, credentials, tokens, and secret-bearing text. |
| `raw` | Explicit trusted local debugging only | Preserves the previous report and warning values (terminal-control sanitization still applies). Raw output can expose repository paths, session identifiers, commands, URLs, or secrets and must not be pasted into shared systems without review. |

Local TTY/JSON defaults to `balanced`. Analysis Markdown and detected CI default
to `strict`; an explicit analysis `--privacy` value wins, including in CI.
Stats also defaults to `balanced` locally, but detected CI always enforces
`strict` even when `balanced` or `raw` is requested. Projection never changes
the deterministic raw report or the analysis record stored on disk.

By default no LLM is contacted either. Only when `--advisory` is passed
explicitly, the already projected display-report JSON is handed to the locally
installed `claude` CLI, which sends it to its configured LLM provider. The
advisory therefore receives the selected privacy profile's view, never the raw
report behind a strict or balanced invocation. Raw session transcripts and logs
are never sent; the advisory prompt contains nothing beyond fixed instructions
and that projected report JSON. Selecting `--privacy raw --advisory` explicitly
accepts the same raw-output disclosure risk.

The advisory child receives a replacement environment containing only fixed
operational, home, platform, Claude/Anthropic configuration and authentication,
temporary-directory, and locale variables. Unrelated GitHub, AWS, npm, proxy,
and `NODE_OPTIONS` values are excluded. Authentication values can still be
sensitive; they are passed only to the child environment and are never copied
into advisory warnings. Signed organization policy and an administrative
advisory kill switch are intentionally deferred to a later enterprise-policy
change.

The store lives outside the repository, in a per-repository directory:

```text
$XDG_DATA_HOME/ccprof/<sha256(canonical-repo-path)>/
~/.local/share/ccprof/<sha256(canonical-repo-path)>/
```

Analysis history, dismissals, and adoptions are stored transactionally in the
repository-scoped `store.sqlite3` database, with SQLite running in WAL mode.
Deterministic analysis snapshots are stored separately from their executions.
A snapshot is reused only when the repository and Git OIDs, effective analysis
window, source, configuration, policy, history, and normalized analysis payload
are all identical; each rerun still records its execution without inflating
stats or baselines. Adoption saves are additive: the first record for a finding
key is immutable, while later saves can add other finding keys.

On first access, legacy `analyses/*.json`, `dismissals.json`, and
`adoptions.json` records are imported once. Corrupt input produces warnings and
is skipped; committed migration markers prevent later rescans. All legacy JSON
and the analysis index remain untouched. This is a one-way migration, so using
an older ccprof that still writes those legacy stores afterward is unsupported.
Hook events remain JSONL.

Store retention is manual and repository-scoped. `ccprof data gc` first
finishes all three legacy migrations, then retains analysis executions and
adoptions for 90 days, removes unreferenced analysis snapshots, and removes
dismissals once their 14-day lifetime is reached. It also compacts hook events
to the newest valid rows from the last 30 days within a 1 MiB cap, reclaims
SQLite space, and removes the retained legacy files only after every migration
marker is committed. Records exactly on the 90-day or 30-day cutoff are kept;
dismissals exactly 14 days old have expired and are removed.

`ccprof data delete` explicitly removes the complete Store directory for the
current repository, including SQLite sidecars, hook events, legacy files, and
unknown remnants. It does not open SQLite, so it can remove an unsupported
future Store schema. A concurrent writer can recreate data after either
command; no exact-once or automatic-recovery guarantee is provided.

Store records remain raw so local baselines and history retain their existing
identity and evidence. Privacy profiles govern rendered output and advisory
input; they do not rewrite the Store. Protect the data directory as local
sensitive data.

Source descriptors contain only fixed registry metadata and opaque hashes.
Strict, balanced, and raw output therefore preserve the same descriptor values;
none of the profiles introduces a raw session ID, transcript path, or secret.

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
under the Node built-in test runner. `better-sqlite3` provides the embedded
SQLite runtime; only `git`, and `gh` when needed, are invoked as external
processes.

Node.js 22.x and 24.x are the only supported runtimes. Node.js 20, 23, and 25
are EOL and unsupported. Both supported lines run in a blocking matrix on
Ubuntu, macOS, and Windows; every lane loads and queries the native
`better-sqlite3` addon before running the full suite. A native ARM64
`ubuntu-24.04-arm` job performs a clean install and runs the `better-sqlite3`
smoke. The case-insensitive filesystem test uses an explicit capability skip
on case-sensitive hosts; the Windows and macOS matrix lanes own that coverage.
Node.js 26 remains a non-blocking canary and is not a support claim. The
package's `engines` field remains authoritative for supported runtimes.

### Maintainer release

Use [`ccprof-release`](.claude/skills/ccprof-release/SKILL.md) to prepare the
version, lockfile, and changelog PR, then create the exact annotated tag. The
tag-only workflow uses npm Trusted Publishing after a human approves environment
`npm`; the agent uses no npm token and never publishes locally. Before release,
an administrator must configure that environment with a required reviewer and
configure npm for repository `t09tanaka/ccprof`, workflow
`release-assets.yml`, environment `npm`, and allowed action `npm publish`. The
workflow reproducibly verifies one tarball, publishes those exact bytes with
OIDC provenance, and then creates the matching GitHub Release assets and
attestations.

## License

MIT — see [LICENSE](LICENSE).
