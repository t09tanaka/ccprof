# Common CWD Canonicalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canonicalize and rebase Claude and Codex session working directories through one shared source-layer contract, while preserving an event's explicit Codex working directory and never inventing a repository root when CWD evidence is absent.

**Architecture:** Move Claude's existing CWD canonicalization, repository-membership check, and linked-worktree rebasing into `src/sources/cwd.ts`, then call the same functions from both discovery adapters. Extend the Codex parser so each tool event resolves CWD in the strict order `input.workdir` → `input.cwd` → `session_meta.cwd`; discovery then canonicalizes every observed/event CWD, accepts only a path contained in or linked to the queried repository, and rebases linked-worktree paths into the queried checkout.

**Tech Stack:** TypeScript 5.9, Node.js 20 ESM, Node built-in test runner, Git worktree metadata.

---

## Scope, invariants, and budget

- Explicit event `workdir` wins over event `cwd`; event `cwd` wins over `session_meta.cwd`.
- Empty/whitespace-only event values do not mask the next valid fallback.
- A session with neither event CWD nor metadata CWD keeps `observed_cwds: []`; it is not treated as if it ran at `repoRoot` or `process.cwd()`.
- Symlink aliases are resolved before containment checks.
- A CWD in another checkout of the same Git common directory is eligible and is rebased by its path relative to that checkout root.
- Rebasing works in both directions: linked worktree → main checkout and main checkout → queried linked worktree.
- A CWD in an unrelated repository, or a path outside the queried repository without the same Git common directory, remains ineligible.
- Nonexistent paths retain the deterministic absolute fallback supplied by `canonicalPath`; they do not become repository-relative implicitly.
- Existing branch, time-window, confidence, source-warning, and transcript-symlink behavior is unchanged.
- `TimelineAction`, `CommandIdentity`, findings, report schemas, package metadata, and package version are out of scope.

The hard change budget is **7 files** and **at most 295 added source/test lines**:

| File | Responsibility | Added-line cap |
|---|---|---:|
| `src/sources/cwd.ts` | Shared canonicalization/membership/rebase helpers | 120 |
| `src/sources/claude/discover.ts` | Replace private CWD helpers with shared calls | 20 |
| `src/sources/codex/discover.ts` | Apply shared canonicalization and mapping | 25 |
| `src/sources/codex/parser.ts` | Resolve event CWD precedence/fallback | 20 |
| `test/codex-parser.test.ts` | Parser precedence and missing-evidence contract | 55 |
| `test/codex-discover.test.ts` | Main-checkout → linked-worktree integration | 55 |
| `docs/superpowers/plans/2026-08-03-cwd-canonicalization.md` | This execution plan; excluded from source/test cap | — |

`src/sources/claude/discover.ts` also deletes the old private helper bodies, so its net production diff is negative. Existing Claude discovery tests already cover symlink resolution, linked-worktree → main-checkout rebasing, unrelated-repository rejection, and branch/time invariants; they are required verification even though that test file needs no edit.

### Semantic impact audit

`ts-rename-helper` is unavailable, so the TypeScript LanguageService was used against `tsconfig.test.json` before defining this plan. It found:

- `cwdMatchesRepository`, `canonicalizeSession`, `rebaseWorktreeCwd`, and `alignSessionCwdsToRepository` are private to `src/sources/claude/discover.ts`, with exactly one call site each.
- `buildFunctionCallEvent` is private to `src/sources/codex/parser.ts`, with one call site.
- Public `parseCodexSession` is referenced by Codex discovery and parser tests; its exported signature does not change.
- Public `discoverClaudeSessions` and `discoverCodexSessions` are referenced by their source classes and tests; neither exported signature changes.
- Shared `canonicalPath`, `commonGitDirectory`, and `findGitMarker` are also used outside discovery (`src/store/paths.ts` uses `commonGitDirectory`), so their signatures and behavior remain untouched.

## Task 1: Preserve Codex event CWD evidence

**Files:**
- Modify: `test/codex-parser.test.ts`
- Modify: `src/sources/codex/parser.ts`

- [x] **Step 1: Write the failing precedence test**

Append these focused contracts to `test/codex-parser.test.ts`:

```ts
test("prefers event workdir, then event cwd, then session metadata cwd", () => {
  const call = (id: string, input: Record<string, unknown>): string =>
    JSON.stringify({
      timestamp: `2026-07-31T13:00:0${id}.000Z`,
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: `call-${id}`,
        arguments: JSON.stringify(input),
      },
    });
  const raw = [
    '{"timestamp":"2026-07-31T13:00:00.000Z","type":"session_meta","payload":{"id":"cwd-priority","cwd":"/metadata/repo"}}',
    call("1", { cmd: "pwd", workdir: "/event/workdir", cwd: "/event/cwd" }),
    call("2", { cmd: "pwd", cwd: "/event/cwd" }),
    call("3", { cmd: "pwd" }),
  ].join("\n");

  const session = parseCodexSession({ sourcePath: "cwd-priority.jsonl", raw });
  assert.ok(session);
  const toolCwds = session.events
    .filter((event) => event.kind === "tool_use")
    .map((event) => event.kind === "tool_use" ? event.cwd : undefined);
  assert.deepEqual(toolCwds, [
    "/event/workdir",
    "/event/cwd",
    "/metadata/repo",
  ]);
  assert.deepEqual(session.observed_cwds, [
    "/metadata/repo",
    "/event/workdir",
    "/event/cwd",
  ]);
});

test("does not invent a cwd when event and session metadata omit it", () => {
  const raw = JSON.stringify({
    timestamp: "2026-07-31T14:00:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "call-missing-cwd",
      arguments: JSON.stringify({ cmd: "pwd" }),
    },
  });

  const session = parseCodexSession({ sourcePath: "missing-cwd.jsonl", raw });
  assert.ok(session);
  const tool = session.events.find((event) => event.kind === "tool_use");
  assert.ok(tool?.kind === "tool_use");
  assert.equal(tool.cwd, undefined);
  assert.deepEqual(session.observed_cwds, []);
});
```

- [x] **Step 2: Run the parser test and verify RED**

Run from the worktree using the delegated test agent:

```sh
npm run build:test
node --test .test-dist/test/codex-parser.test.js
```

Expected: the precedence test fails because `input.cwd` and metadata fallback are not yet copied onto tool events. The missing-evidence assertion remains green.

- [x] **Step 3: Implement the minimum precedence/fallback logic**

Change `buildFunctionCallEvent` to accept the already-bounded metadata CWD and resolve every tool event's CWD with nullish precedence:

```ts
function buildFunctionCallEvent(
  row: ParsedRow,
  sessionId: string,
  baseConfidence: Confidence,
  warnings: SourceWarning[],
  sourcePath: string,
  sessionCwd: string | undefined,
): ToolUseEvent | undefined {
```

After the `input` object has been parsed, use this exact resolution:

```ts
  const cwd =
    nonEmptyString(input.workdir) ??
    nonEmptyString(input.cwd) ??
    sessionCwd;
```

Keep command extraction limited to `exec_command`/`shell`, but remove its old `input.workdir`-only CWD assignment. Pass `sessionMetaCwd` at the sole call site:

```ts
      const event = buildFunctionCallEvent(
        row,
        sessionId,
        confidence,
        warnings,
        sourcePath,
        sessionMetaCwd,
      );
```

Build `observed_cwds` from the metadata value followed by distinct tool-event values, without adding an absent value:

```ts
  const observedCwds = [...new Set([
    ...(sessionMetaCwd === undefined ? [] : [sessionMetaCwd]),
    ...events.flatMap((event) =>
      event.kind === "tool_use" &&
        event.cwd !== undefined &&
        event.cwd !== ""
        ? [event.cwd]
        : []
    ),
  ])];
```

Use `observed_cwds: observedCwds` in the returned `Session`. Do not change `ParseCodexSessionOptions`, event types, confidence, or warnings.

- [x] **Step 4: Re-run the parser test and verify GREEN**

```sh
npm run build:test
node --test .test-dist/test/codex-parser.test.js
```

Expected: every Codex parser test passes and the new tool CWD order is exact.

## Task 2: Share repository-aware CWD canonicalization

**Files:**
- Modify: `test/codex-discover.test.ts`
- Create: `src/sources/cwd.ts`
- Modify: `src/sources/claude/discover.ts`
- Modify: `src/sources/codex/discover.ts`

- [x] **Step 1: Write the failing Codex worktree mapping test**

Add `realpath` to the existing `node:fs/promises` import and append this integration test to `test/codex-discover.test.ts`:

```ts
test("rebases a main-checkout Codex cwd into the queried linked worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-codex-worktree-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const sessionsDir = join(root, "sessions");
  const mainRepo = join(root, "main-repo");
  const linkedRepo = join(root, "linked-repo");
  const mainNested = join(mainRepo, "packages", "app");
  const linkedNested = join(linkedRepo, "packages", "app");
  const linkedGitDir = join(mainRepo, ".git", "worktrees", "linked");
  await Promise.all([
    mkdir(join(sessionsDir, "2026", "07", "31"), { recursive: true }),
    mkdir(mainNested, { recursive: true }),
    mkdir(linkedNested, { recursive: true }),
    mkdir(linkedGitDir, { recursive: true }),
  ]);
  await writeFile(join(linkedRepo, ".git"), `gitdir: ${linkedGitDir}\n`);
  await writeFile(
    join(sessionsDir, "2026", "07", "31", "rollout-worktree.jsonl"),
    sessionMeta({
      id: "codex-worktree",
      cwd: mainNested,
      branch: "feature/codex",
    }) + rolloutLine({
      timestamp: "2026-07-31T03:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-worktree",
        arguments: JSON.stringify({ cmd: "pwd", workdir: mainNested }),
      },
    }),
  );

  const sessions = await discoverCodexSessions(sessionsDir, {
    repoRoot: linkedRepo,
    headBranch: "feature/codex",
    startedAtMs: Date.parse("2026-07-31T02:00:00.000Z"),
    endedAtMs: Date.parse("2026-07-31T04:00:00.000Z"),
  });

  assert.equal(sessions.length, 1);
  const expectedCwd = await realpath(linkedNested);
  assert.deepEqual(sessions[0]?.observed_cwds, [expectedCwd]);
  const tool = sessions[0]?.events.find((event) => event.kind === "tool_use");
  assert.ok(tool?.kind === "tool_use");
  assert.equal(tool.cwd, expectedCwd);
});
```

- [x] **Step 2: Run focused discovery tests and verify RED**

```sh
npm run build:test
node --test .test-dist/test/codex-discover.test.js .test-dist/test/claude-discover.test.js
```

Expected: the new Codex test fails with zero discovered sessions because Codex currently requires direct containment. Existing Claude symlink/worktree/outside tests remain green.

- [x] **Step 3: Create the shared CWD module**

Create `src/sources/cwd.ts` with the existing Claude semantics extracted under exported adapter-neutral names:

```ts
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Session } from "../core/model.js";
import {
  canonicalPath,
  commonGitDirectory,
  findGitMarker,
} from "../git/common-dir.js";

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
}

function toolEventCwds(session: Session): string[] {
  return session.events.flatMap((event) =>
    event.kind === "tool_use" &&
      event.cwd !== undefined &&
      event.cwd !== ""
      ? [event.cwd]
      : []
  );
}

type CwdMapper = (cwd: string) => Promise<string>;

async function mapSessionCwds(
  session: Session,
  mapper: CwdMapper,
): Promise<Session> {
  const distinctCwds = [...new Set([
    ...session.observed_cwds,
    ...toolEventCwds(session),
  ])];
  const mappedCwds = new Map(
    await Promise.all(
      distinctCwds.map(async (cwd) => [cwd, await mapper(cwd)] as const),
    ),
  );
  const events = session.events.map((event) =>
    event.kind === "tool_use" &&
      event.cwd !== undefined &&
      event.cwd !== ""
      ? { ...event, cwd: mappedCwds.get(event.cwd) ?? event.cwd }
      : event
  );
  return {
    ...session,
    observed_cwds: [...new Set([
      ...session.observed_cwds.map((cwd) => mappedCwds.get(cwd) ?? cwd),
      ...events.flatMap((event) =>
        event.kind === "tool_use" &&
          event.cwd !== undefined &&
          event.cwd !== ""
          ? [event.cwd]
          : []
      ),
    ])],
    events,
  };
}

export async function canonicalizeSessionCwds(
  session: Session,
): Promise<Session> {
  return mapSessionCwds(session, canonicalPath);
}

export async function cwdMatchesRepository(
  repoRoot: string,
  cwds: string[],
): Promise<boolean> {
  if (cwds.some((cwd) => isWithin(repoRoot, cwd))) return true;
  const repoGitDirectory = await commonGitDirectory(repoRoot);
  if (repoGitDirectory === undefined) return false;
  for (const cwd of cwds) {
    if (await commonGitDirectory(cwd) === repoGitDirectory) return true;
  }
  return false;
}

async function rebaseWorktreeCwd(
  cwd: string,
  repoRoot: string,
  repoGitDirectory: string | undefined,
): Promise<string> {
  if (isWithin(repoRoot, cwd) || repoGitDirectory === undefined) return cwd;
  const [marker, cwdGitDirectory] = await Promise.all([
    findGitMarker(cwd),
    commonGitDirectory(cwd),
  ]);
  if (
    marker === undefined ||
    cwdGitDirectory === undefined ||
    cwdGitDirectory !== repoGitDirectory
  ) return cwd;
  const worktreeRoot = await canonicalPath(dirname(marker));
  if (!isWithin(worktreeRoot, cwd)) return cwd;
  const relativeCwd = relative(worktreeRoot, cwd);
  if (
    isAbsolute(relativeCwd) ||
    relativeCwd === ".." ||
    relativeCwd.startsWith(`..${sep}`)
  ) return cwd;
  const rebased = await canonicalPath(resolve(repoRoot, relativeCwd));
  return isWithin(repoRoot, rebased) ? rebased : cwd;
}

export async function alignSessionCwdsToRepository(
  session: Session,
  repoRoot: string,
): Promise<Session> {
  const repoGitDirectory = await commonGitDirectory(repoRoot);
  return mapSessionCwds(
    session,
    async (cwd) => rebaseWorktreeCwd(cwd, repoRoot, repoGitDirectory),
  );
}
```

Do not export `isWithin` or `rebaseWorktreeCwd`; callers need only the three session-level operations.

- [x] **Step 4: Replace Claude's private CWD helpers with the shared module**

Import the three exported helpers in `src/sources/claude/discover.ts`. Keep Claude's local `isWithin` for transcript-symlink containment, but delete the private `cwdMatchesRepository`, `rebaseWorktreeCwd`, and `alignSessionCwdsToRepository` bodies.

Replace `canonicalizeSession` with source-path handling wrapped around the shared CWD normalization:

```ts
async function canonicalizeSession(session: Session): Promise<Session> {
  const [canonicalSession, sourcePath] = await Promise.all([
    canonicalizeSessionCwds(session),
    canonicalPath(session.source_path),
  ]);
  return {
    ...canonicalSession,
    source_path: sourcePath,
    warnings: canonicalSession.warnings.map((warning) => ({
      ...warning,
      source_path: sourcePath,
    })),
  };
}
```

The existing calls to `cwdMatchesRepository` and `alignSessionCwdsToRepository` keep their arguments unchanged. Remove only imports made unused by deleting the private Git-worktree helpers.

- [x] **Step 5: Apply the same pipeline to Codex discovery**

Import `canonicalizeSessionCwds`, `cwdMatchesRepository`, and `alignSessionCwdsToRepository` in `src/sources/codex/discover.ts`. After parsing and before the time/CWD checks, normalize the full session:

```ts
    const canonicalSession = await canonicalizeSessionCwds(parsed);
    if (!intersects(canonicalSession, query)) continue;
    if (
      !(await cwdMatchesRepository(
        repoRoot,
        canonicalSession.observed_cwds,
      ))
    ) continue;
    const session = await alignSessionCwdsToRepository(
      canonicalSession,
      repoRoot,
    );
```

Use `session` for branch selection and every push. Preserve the entire aligned `observed_cwds` array instead of replacing it with the former first `canonicalCwd`. Delete Codex's private CWD `isWithin`; retain `relative` and `sep` because date-directory filtering still uses them.

- [x] **Step 6: Re-run focused source tests and verify GREEN**

```sh
npm run build:test
node --test .test-dist/test/codex-parser.test.js .test-dist/test/codex-discover.test.js .test-dist/test/claude-discover.test.js .test-dist/test/combined-source.test.js
```

Expected: all focused tests pass. Specifically, existing Claude tests still prove symlink resolution, linked → main rebasing, and outside rejection; existing Codex frozen-end/parser tests prove absent future metadata does not become an implicit root; and the new Codex test proves reverse main → linked mapping through the shared code.

## Task 3: Scope, quality, and delivery gates

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-cwd-canonicalization.md`

- [x] **Step 1: Perform spec-compliance review**

Dispatch a fresh reviewer with the requirements and the full `origin/main...HEAD` diff. Require confirmation that precedence, symlink canonicalization, bidirectional worktree rebasing, outside rejection, and missing-evidence behavior are all covered, and that no `TimelineAction`/`CommandIdentity`/report/version work entered the diff.

- [x] **Step 2: Perform code-quality review**

After spec approval, dispatch a separate reviewer. Require attention to path-containment checks, Git common-directory equality, deterministic ordering/deduplication, parser snapshot bounds, source warnings, and any accidental behavior broadening. Send actionable findings back to the implementer and repeat both review gates after fixes.

- [x] **Step 3: Delegate full local validation on Node 20**

The validation subagent runs:

```sh
npm run check
npm run build
npm pack --dry-run
```

It also verifies:

```sh
git diff --check
git diff --stat origin/main...HEAD
git diff -- package.json package-lock.json CHANGELOG.md
```

Expected: typecheck/lint-equivalent checks pass, the full test suite is green, build and package smoke tests pass, whitespace is clean, no version/package/changelog diff exists, no more than 7 files changed, and added source/test lines do not exceed 295.

- [x] **Step 4: Run the repository's local GitHub Actions workflow before push**

Use `/run-github-actions-locally` because this PR changes logic. Fix only failures caused by this diff, create new commits rather than amending, and repeat until the local CI-equivalent is green.

- [x] **Step 5: Commit, push, and create the PR**

Stage only the seven scoped files. Commit the logic/tests and this plan with a conventional message such as:

```sh
git add src/sources/cwd.ts src/sources/claude/discover.ts src/sources/codex/discover.ts src/sources/codex/parser.ts test/codex-parser.test.ts test/codex-discover.test.ts docs/superpowers/plans/2026-08-03-cwd-canonicalization.md
git commit -m "fix: canonicalize session working directories"
git push -u origin feature/cwd-canonicalization
gh pr create --base main --head feature/cwd-canonicalization --title "fix: canonicalize session working directories" --body "## Summary
- share repository-aware CWD canonicalization across Claude and Codex
- preserve Codex workdir/cwd/session metadata precedence
- rebase same-repository linked-worktree paths without accepting missing or unrelated CWDs

## Validation
- npm run check
- npm run build
- npm pack --dry-run
- local GitHub Actions workflow"
```

The PR body must summarize the common CWD pipeline, list the precedence and worktree tests, state that package/version files are unchanged, and include local validation results.

- [x] **Step 6: Complete the pre-merge CI/review gate**

Every required GitHub check and review succeeded for the implementation head.
Merge and cleanup follow only after this documentation commit also passes the
required checks; the merged commit is then verified on `origin/main` before
the worktree cleanup safety guards run.
