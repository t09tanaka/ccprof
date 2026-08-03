# Local Finding Explanation and Trusted Verification Plan

**Goal:** Keep shared analysis output strict while letting a user inspect one finding locally, and ensure agents execute a finding's verification command only after a fixed allowlist classifies the complete command as trusted.

**Scope:** Add a read-only `ccprof explain <finding-key>` command, make shared finding references resolvable against the current repository's raw Store, centralize verification trust, and harden the bundled retrospective / PR-integration instructions. Do not change Report, Finding, or Store schemas; rules; parsers; analysis results; package version; lockfile; or changelog.

**Limits:** Exactly the nine files listed below. Added production code across `src/**` must stay below 300 lines. No configurable allowlist, command executor, persistent alias mapping, migration, network call, or automatic PR comment.

## Edge cases and safety contract

- Shared strict/balanced references must resolve locally without exposing the raw Store key or relying on an analysis-scoped alias that cannot be reproduced later.
- A reference is deterministic for one stored checkout identity. Linked worktrees may emit different strings; either must resolve the raw key before selecting the latest occurrence across their shared Store. Making the string itself worktree-invariant requires a canonical Store identity at the reporter boundary and remains part of the attachment's broader P1 worktree contract.
- Raw Store keys remain accepted for trusted local workflows; lookup is limited to the Store resolved from the current repository.
- Select the newest matching record by `created_at_ms`, then `analysis_id`, and fail closed on missing or ambiguous references.
- `explain` performs reads only: no Store write, re-analysis, network access, process spawning, or verification execution.
- Sanitize terminal controls in all human output. Keep Store warnings on stderr through the existing command-result boundary.
- Trust the complete trimmed verification string only when its rule and literal recipe match the built-in fixed-recipe allowlist. Dynamic recipes from R002/R006/R008 stay untrusted even if their text resembles a normal test command. Added arguments, environment assignments, pipes, boolean composition, separators, redirects, substitutions, URLs, and redacted markers are untrusted.
- Shared strict/balanced reports redact untrusted verification commands. Local explanation may display the raw command for inspection, but labels it untrusted and explicitly forbids execution.
- `/retro` and the PR snippet share only explicit strict output, inspect details locally for selected findings, never publish explain/raw output, and execute only a command explicitly labeled trusted by `ccprof explain`.

## Semantic impact checked before implementation

TypeScript LanguageService using `tsconfig.test.json` found:

- `CliHandlers`: `src/cli.ts`, `test/advisory.test.ts`, `test/hook-event.test.ts`, `test/hooks-command.test.ts`, and `test/reporters-and-cli.test.ts`. Add the explain test seam as an optional handler so existing injected handler objects remain compatible.
- `ParsedCliCommand`: closed inside `src/cli.ts`.
- `FindingNotFoundError`: `src/cli.ts`, `src/commands/dismiss.ts`, and `test/reporters-and-cli.test.ts`; reuse its existing exit-code contract for unknown explain references.

`ts-rename-helper` is unavailable in this workspace; the TypeScript LanguageService supplied semantic references instead of relying on text search alone.

### Task 1: Add failing contract tests

**Files:**
- Modify: `test/reporters-and-cli.test.ts`

- [x] Assert strict/balanced reports emit the same deterministic opaque finding reference while the stored repository identity is unchanged, while raw output remains unchanged.
- [x] Assert the single trust classifier accepts only the rule-specific fixed recipes and rejects dynamic-rule commands, composition, extra arguments, secrets, URLs, and redacted markers.
- [x] Assert untrusted verification is redacted from strict/balanced shared output.
- [x] Assert explain parsing, dispatch, latest-record lookup, raw/shared-key lookup, full local details, terminal sanitization, warning separation, and unknown-key failure.
- [x] Run only the focused compiled test file through a validation subagent and capture the expected RED failures before production edits (six missing-contract diagnostics; no pre-existing failure).

### Task 2: Centralize references and verification trust

**Files:**
- Modify: `src/reporters/privacy.ts`
- Modify: `src/commands/dismiss.ts`

- [x] Export a deterministic repository-bound shared finding-reference function and use it for strict/balanced finding keys.
- [x] Export one exact verification-command classifier and reuse it in privacy projection.
- [x] Redact untrusted verification commands from both strict and balanced reports without changing raw reports or evidence-command behavior.
- [x] Export the deterministic latest-finding lookup, accepting raw or shared references, for reuse by dismiss and explain.

### Task 3: Add the read-only explain command

**Files:**
- Modify: `src/commands/dismiss.ts` (shared stored-finding lookup and the adjacent read-only explain command)
- Modify: `src/cli.ts`
- Modify: `src/reporters/markdown.ts`
- Test: `test/reporters-and-cli.test.ts`

- [x] Resolve only the current repository and its Store, load history once, and select the latest matching finding without any mutation or process execution.
- [x] Render rule/title/scope/confidence/recoverable/target, complete evidence, suggestion, raw verify text with trusted/untrusted status, and caveats as terminal-sanitized local text.
- [x] Add exact `explain <finding-key>` parsing, usage, optional handler injection, dispatch, warning routing, and existing unknown-key exit code 2 behavior.
- [x] Include the already-projected opaque finding reference in Markdown so a strict PR comment can be drilled into locally.
- [x] Re-run the focused compiled test file through a validation subagent and make it GREEN after review fixes (54/54 on Node 20).

### Task 4: Harden user and agent workflows

**Files:**
- Modify: `README.md`
- Modify: `.claude/commands/retro.md`
- Modify: `integrations/pr-skill-snippet.md`

- [x] Document local-only explanation, repository-bound shared references, linked-worktree lookup behavior, trust labels, and that ccprof never executes verification commands.
- [x] Make retrospective analysis/re-analysis explicitly strict; explain only selected findings; execute only an exactly trusted command; never reconstruct or publish untrusted details.
- [x] Apply the same rules after PR creation, keep Markdown posting explicit opt-in, and prohibit publishing local explain/raw output.

### Task 5: Review, verify, and deliver

- [x] Run independent specification, security, code-quality, and scope reviews; fix only defects introduced in these nine files (PASS / APPROVED / APPROVED).
- [x] Have a validation subagent run Node 20 `npm ci`, `npm run check` (508/508), determinism (1/1), build, isolated package smoke, and `git diff --check`.
- [x] Confirm nine files, 258 added production lines, no schema/rule/parser/package/version/lockfile/changelog diff, and no generated artifacts.
- [x] Run every locally reproducible GitHub Actions equivalent before push; all passed on Node 20.
- [ ] Commit without amend, open a PR against `main`, wait for every check/review, merge under standing authorization, and clean up only this worktree and branch.
