import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  analyze,
  NoAnalyzableTimestampsError,
  NoMatchingSessionsError,
} from "../src/core/analyze.js";
import { runAnalyzeCommand } from "../src/commands/analyze.js";
import type { Interval, ReportV2, Session } from "../src/core/model.js";
import {
  discoverManifestTestMap,
  parseExplicitTestMap,
} from "../src/analysis/test-map.js";
import {
  runCommand,
  type CommandRunner,
} from "../src/git/client.js";
import { findGitMarker } from "../src/git/common-dir.js";
import { selectorRefDigest } from "../src/git/pr-context.js";
import { listRuleManifests } from "../src/rules/manifest.js";
import {
  ClaudeDiscoveryError,
  ClaudeSessionSource,
} from "../src/sources/claude/discover.js";
import { CombinedSessionSource } from "../src/sources/combined.js";
import { CodexSessionSource } from "../src/sources/codex/discover.js";
import { alignSessionCwdsToRepository } from "../src/sources/cwd.js";
import {
  CLAUDE_SESSION_SOURCE_CONTRACT,
  CODEX_SESSION_SOURCE_CONTRACT,
  type SessionQuery,
  type SessionSource,
  type SessionSourceContract,
} from "../src/sources/session-source.js";
import {
  analysisDigest,
  loadAnalyses,
  saveAnalysis,
} from "../src/store/analyses.js";
import { loadAdoptions } from "../src/store/adoptions.js";
import { saveDismissal } from "../src/store/dismissals.js";
import { resolveStorePaths } from "../src/store/paths.js";
import { openStoreDatabase } from "../src/store/sqlite.js";
import {
  resolveRuleSafetyPolicy,
  RuleSafetyPolicyValidationError,
  type EffectiveRuleSafetyPolicy,
} from "../src/policy/rule-safety.js";
import type { EffectivePolicy } from "../src/policy/organization-policy.js";

const NOW_MS = Date.parse("2026-01-01T01:00:00.000Z");
const FEATURE_COMMIT_DATE = "2026-01-01T00:00:00.000Z";

function sourceContract(
  source: Session["source"],
): SessionSourceContract {
  return source === "claude"
    ? CLAUDE_SESSION_SOURCE_CONTRACT
    : CODEX_SESSION_SOURCE_CONTRACT;
}

function sourceForSessions(
  sessions: readonly Session[],
): SessionSource | CombinedSessionSource {
  const sources = (["claude", "codex"] as const).flatMap((adapter) => {
    const matching = sessions.filter(({ source }) => source === adapter);
    return matching.length === 0
      ? []
      : [{
          contract: sourceContract(adapter),
          discover: async () => [...matching],
        } satisfies SessionSource];
  });
  return sources.length < 2
    ? sources[0] ?? {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => [],
      }
    : new CombinedSessionSource(sources);
}

async function git(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const result = await runCommand("git", args, {
    cwd,
    env,
    timeoutMs: 10_000,
  });
  assert.equal(
    result.code,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function makeRepository(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "ccprof test"]);
  await git(repo, ["config", "user.email", "ccprof@example.invalid"]);
  await write(
    join(repo, "package.json"),
    `${JSON.stringify({
      private: true,
      scripts: { test: "node --test" },
    }, null, 2)}\n`,
  );
  await write(join(repo, "src/value.ts"), "export const value = 1;\n");
  await git(repo, ["add", "package.json", "src/value.ts"]);
  await git(repo, ["commit", "-m", "base"], {
    GIT_AUTHOR_DATE: "2025-12-31T23:00:00.000Z",
    GIT_COMMITTER_DATE: "2025-12-31T23:00:00.000Z",
  });
  await git(repo, ["switch", "-c", "feature"]);
  await write(join(repo, "src/value.ts"), "export const value = 2;\n");
  await git(repo, ["add", "src/value.ts"]);
  await git(repo, ["commit", "-m", "feature"], {
    GIT_AUTHOR_DATE: FEATURE_COMMIT_DATE,
    GIT_COMMITTER_DATE: FEATURE_COMMIT_DATE,
  });
  return repo;
}

async function makeClaudeProjects(
  root: string,
  repo: string,
): Promise<string> {
  const projects = join(root, "claude-projects");
  const fixturePath = join(
    process.cwd(),
    "test/fixtures/e2e/session.jsonl",
  );
  const fixture = await readFile(fixturePath, "utf8");
  const escapedRepo = JSON.stringify(repo).slice(1, -1);
  const editRows = [
    {
      type: "assistant",
      sessionId: "e2e-session",
      uuid: "a5-unrelated-edit",
      timestamp: "2026-01-01T00:02:42.000Z",
      cwd: repo,
      gitBranch: "feature",
      message: {
        id: "m5-unrelated-edit",
        content: [{
          type: "tool_use",
          id: "edit-unrelated",
          name: "Edit",
          input: {
            file_path: "docs/readme.md",
            old_string: "",
            new_string: "temporary unrelated documentation note",
          },
        }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
    {
      type: "user",
      sessionId: "e2e-session",
      uuid: "r5-unrelated-edit",
      timestamp: "2026-01-01T00:02:48.000Z",
      cwd: repo,
      gitBranch: "feature",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "edit-unrelated",
          content: "updated",
          is_error: false,
        }],
      },
    },
  ].map((row) => JSON.stringify(row));
  const rendered = fixture
    .replaceAll("__REPO_ROOT__", escapedRepo)
    .replace("__LARGE_OUTPUT__", "x".repeat(200_004))
    .split("\n")
    .flatMap((line) =>
      line.includes('"uuid":"a6"') ? [...editRows, line] : [line]
    )
    .join("\n");
  await write(join(projects, "fixture", "e2e-session.jsonl"), rendered);
  return projects;
}

function queryCapturingClaudeSource(projects: string): {
  source: SessionSource;
  queries: SessionQuery[];
} {
  const source = new ClaudeSessionSource(projects);
  const queries: SessionQuery[] = [];
  return {
    source: {
      contract: CLAUDE_SESSION_SOURCE_CONTRACT,
      discover: async (query) => {
        queries.push({ ...query });
        return await source.discover(query);
      },
    },
    queries,
  };
}

/** A Claude projects directory whose only transcript is malformed, so
 * `discoverClaudeSessions` finds zero sessions and throws
 * `ClaudeDiscoveryError` - used to exercise `defaultSessionSource`'s
 * per-source error surfacing without injecting a `sessionSource`. */
async function makeMalformedClaudeProjects(root: string): Promise<string> {
  const projects = join(root, "claude-projects-malformed");
  await write(join(projects, "malformed.jsonl"), "{malformed\n");
  return projects;
}

/** A Codex sessions directory with one valid rollout inside the repo, on
 * `branch`, with two distinct event timestamps (a single-timestamp session
 * cannot form an analyzable interval). */
async function makeCodexSessions(
  root: string,
  repo: string,
  branch: string,
): Promise<string> {
  const sessionsDir = join(root, "codex-sessions");
  const dayDir = join(sessionsDir, "2026", "01", "01");
  await mkdir(dayDir, { recursive: true });
  const rows = [
    JSON.stringify({
      timestamp: "2026-01-01T00:02:00.000Z",
      type: "session_meta",
      payload: { id: "codex-integration", cwd: repo, git: { branch } },
    }),
    JSON.stringify({
      timestamp: "2026-01-01T00:02:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: "codex integration check",
      },
    }),
    JSON.stringify({
      timestamp: "2026-01-01T00:02:11.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "on it" },
    }),
  ];
  await writeFile(
    join(dayDir, "rollout-codex-integration.jsonl"),
    `${rows.join("\n")}\n`,
  );
  return sessionsDir;
}

function seedSummary() {
  return {
    measured_min: 10,
    idle_excluded_min: 0,
    estimated_floor_min: 9,
    recoverable_min: 1,
    human_wait_min: 0,
    unexplained_min: 1,
    baseline: null,
  } as const;
}

function policySensitiveRuleSafety(): EffectiveRuleSafetyPolicy {
  return resolveRuleSafetyPolicy(
    {
      safe_patterns: ["npm *"],
      allow_rule_recommendation: true,
    },
    [{
      match: ["npm *"],
      domain: "node-workspace",
      parallel_safe: true,
    }],
  );
}

function commandPolicy(
  overrides: Partial<EffectivePolicy> = {},
): EffectivePolicy {
  return {
    governed: false,
    privacy: "raw",
    allow_raw: true,
    allow_advisory: true,
    advisory_enabled: true,
    allow_export: true,
    required_source_coverage: 0,
    ...overrides,
  };
}

function storedPolicyDigest(
  history: Awaited<ReturnType<typeof loadAnalyses>>,
): string {
  assert.deepEqual(history.warnings, []);
  const entry = history.entries?.[0];
  assert.ok(entry !== undefined);
  assert.equal("mode" in entry.identity, false);
  if ("mode" in entry.identity) {
    assert.fail("expected a rich analysis snapshot identity");
  }
  return entry.identity.policy_digest;
}

function policySensitiveSession(sessionId: string, repo: string): Session {
  const t0 = NOW_MS - 600_000;
  const shared = {
    session_id: sessionId,
    agent_id: "main",
    is_sidechain: false,
    confidence: "high" as const,
  };
  const approvalTurn = (
    index: number,
    offsetMs: number,
    path: string,
  ): Session["events"] => {
    const toolUseId = `policy-read-${index}`;
    return [
      {
        ...shared,
        kind: "assistant" as const,
        timestamp_ms: t0 + offsetMs,
        entry_uuid: `approval-prompt-${index}`,
        session_ref: `${sessionId}#approval-prompt-${index}`,
        source_index: index * 4,
        text: "Approval required for this validation.",
      },
      {
        ...shared,
        kind: "tool_use" as const,
        timestamp_ms: t0 + offsetMs,
        entry_uuid: `approval-use-${index}`,
        session_ref: `${sessionId}#approval-use-${index}`,
        source_index: index * 4 + 1,
        tool_use_id: toolUseId,
        tool_name: "Read",
        input: {},
        paths: [path],
        edit_fragments: [],
        command: "npm test",
        cwd: repo,
        approval: {
          required: true,
          reason: "validation requires approval",
        },
      },
      {
        ...shared,
        kind: "genuine_user" as const,
        timestamp_ms: t0 + offsetMs + 100,
        entry_uuid: `approval-answer-${index}`,
        session_ref: `${sessionId}#approval-answer-${index}`,
        source_index: index * 4 + 2,
        text: "Approved.",
      },
      {
        ...shared,
        kind: "tool_result" as const,
        timestamp_ms: t0 + offsetMs + 110,
        entry_uuid: `approval-result-${index}`,
        session_ref: `${sessionId}#approval-result-${index}`,
        source_index: index * 4 + 3,
        tool_use_id: toolUseId,
        status: "success" as const,
        output: "ok",
        output_bytes: 2,
        estimated_tokens: 1,
      },
    ];
  };
  const serialRead = (
    index: number,
    offsetMs: number,
    path: string,
  ): Session["events"] => {
    const toolUseId = `serial-read-${index}`;
    return [
      {
        ...shared,
        kind: "tool_use",
        timestamp_ms: t0 + offsetMs,
        entry_uuid: `serial-use-${index}`,
        session_ref: `${sessionId}#serial-use-${index}`,
        source_index: 10 + index * 2,
        tool_use_id: toolUseId,
        tool_name: "Read",
        input: {},
        paths: [path],
        edit_fragments: [],
        command: "npm test",
        cwd: repo,
      },
      {
        ...shared,
        kind: "tool_result",
        timestamp_ms: t0 + offsetMs + 100,
        entry_uuid: `serial-result-${index}`,
        session_ref: `${sessionId}#serial-result-${index}`,
        source_index: 11 + index * 2,
        tool_use_id: toolUseId,
        status: "success",
        output: "ok",
        output_bytes: 2,
        estimated_tokens: 1,
      },
    ];
  };
  return {
    session_id: sessionId,
    source: "claude",
    source_path: join(repo, `${sessionId}.jsonl`),
    observed_cwds: [repo],
    observed_branches: ["feature"],
    started_at_ms: t0,
    ended_at_ms: t0 + 610,
    confidence: "high",
    events: [
      ...approvalTurn(0, 0, "package.json"),
      ...approvalTurn(1, 200, "src/value.ts"),
      {
        ...shared,
        kind: "tool_use",
        timestamp_ms: t0 + 350,
        entry_uuid: "group-boundary-use",
        session_ref: `${sessionId}#group-boundary-use`,
        source_index: 8,
        tool_use_id: "group-boundary",
        tool_name: "CustomUnknownTool",
        input: {},
        paths: [],
        edit_fragments: [],
      },
      {
        ...shared,
        kind: "tool_result",
        timestamp_ms: t0 + 360,
        entry_uuid: "group-boundary-result",
        session_ref: `${sessionId}#group-boundary-result`,
        source_index: 9,
        tool_use_id: "group-boundary",
        status: "success",
        output: "ok",
        output_bytes: 2,
        estimated_tokens: 1,
      },
      ...serialRead(0, 400, "package.json"),
      ...serialRead(1, 510, "src/value.ts"),
    ],
    warnings: [],
  };
}

test("core snapshots one injected rule policy for both R004 and R005", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-rule-policy-core-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const mutablePolicy = policySensitiveRuleSafety();
    const approval = mutablePolicy.approval;
    const domain = mutablePolicy.organization_resource_domains[0];
    assert.ok(approval !== undefined);
    assert.ok(domain !== undefined);
    let resolverCalls = 0;

    const authorized = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      persist: false,
      resolveRuleSafetyPolicy: async (resolvedRepo: string) => {
        resolverCalls += 1;
        assert.equal(resolvedRepo, repo);
        return mutablePolicy;
      },
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => {
          approval.organization_safe_patterns[0] = "cargo *";
          domain.match[0] = "cargo *";
          domain.parallel_safe = false;
          return [policySensitiveSession("authorized-policy", repo)];
        },
      },
    });

    assert.equal(resolverCalls, 1);
    const repeatedApproval = authorized.allFindings.find(
      ({ rule_id, evidence }) =>
        rule_id === "R004" &&
        evidence.latency_classification ===
          "repeated_safe_approval_latency",
    );
    const parallelSafe = authorized.allFindings.find(
      ({ rule_id }) => rule_id === "R005",
    );
    assert.ok(repeatedApproval !== undefined);
    assert.deepEqual(repeatedApproval.evidence.canonical_commands, [
      "npm test",
    ]);
    assert.match(repeatedApproval.fix_recipe.suggestion, /allowlist/iu);
    assert.ok(parallelSafe !== undefined);
    assert.equal(
      parallelSafe.evidence.parallelization_classification,
      "parallel_safe",
    );
    assert.equal(parallelSafe.evidence.resource_domain, "node-workspace");
    assert.match(
      parallelSafe.fix_recipe.suggestion,
      /parallel tool invocation/iu,
    );

    const unconfigured = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      persist: false,
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => [policySensitiveSession("absent-policy", repo)],
      },
    });
    const genericApproval = unconfigured.allFindings.find(
      ({ rule_id }) => rule_id === "R004",
    );
    const investigation = unconfigured.allFindings.find(
      ({ rule_id }) => rule_id === "R005",
    );
    assert.ok(genericApproval !== undefined);
    assert.equal(
      genericApproval.evidence.latency_classification,
      "approval_policy_latency",
    );
    assert.equal(
      Object.hasOwn(genericApproval.evidence, "canonical_commands"),
      false,
    );
    assert.ok(investigation !== undefined);
    assert.equal(
      investigation.evidence.parallelization_classification,
      "investigation_candidate",
    );
    assert.equal(
      Object.hasOwn(investigation.evidence, "resource_domain"),
      false,
    );
    assert.doesNotMatch(
      investigation.fix_recipe.suggestion,
      /parallel tool invocation/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("core rejects an invalid rule policy before discovery or persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-invalid-rule-policy-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const canary = "RULE_POLICY_RESOLVER_CANARY";
    const hostile = new Proxy(
      { organization_resource_domains: [] },
      {
        ownKeys: () => {
          throw new Error(canary);
        },
      },
    ) as EffectiveRuleSafetyPolicy;
    let discoveryCalls = 0;

    await assert.rejects(
      analyze({
        cwd: repo,
        pr: "main...feature",
        nowMs: NOW_MS,
        storePaths,
        resolveRuleSafetyPolicy: async () => hostile,
        sessionSource: {
          contract: CLAUDE_SESSION_SOURCE_CONTRACT,
          discover: async () => {
            discoveryCalls += 1;
            return [policySensitiveSession("must-not-run", repo)];
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof RuleSafetyPolicyValidationError);
        assert.equal(error.message, "invalid rule safety policy");
        assert.equal(error.message.includes(canary), false);
        return true;
      },
    );
    assert.equal(discoveryCalls, 0);
    assert.deepEqual((await loadAnalyses(storePaths)).records, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linked-worktree analyze uses one canonical effective policy for core identity and rendering", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-linked-rule-policy-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const linkedRepoPath = join(repo, ".test-worktrees", "policy-linked");
    await mkdir(dirname(linkedRepoPath), { recursive: true });
    await git(repo, ["worktree", "add", "--detach", linkedRepoPath, "feature"]);
    const linkedRepo = await realpath(linkedRepoPath);
    const commandStorePaths = await resolveStorePaths(linkedRepo, {
      env: { CCPROF_DATA_DIR: join(root, "command-data") },
    });
    const referenceStorePaths = await resolveStorePaths(linkedRepo, {
      env: { CCPROF_DATA_DIR: join(root, "reference-data") },
    });
    assert.notEqual(linkedRepo, commandStorePaths.canonical_repo);
    assert.equal(commandStorePaths.canonical_repo, repo);

    const ruleSafety = policySensitiveRuleSafety();
    const canonicalPolicy = commandPolicy({
      governed: true,
      organization: "example-corp",
      privacy: "strict",
      allow_raw: false,
      allow_advisory: false,
      advisory_enabled: false,
      rule_safety: ruleSafety,
    });
    const unauthorizedPatternCanary = "pnpm test --linked-policy-canary";
    const unauthorizedDomainCanary = "linked-policy-canary";
    const linkedPathPolicy = commandPolicy({
      rule_safety: resolveRuleSafetyPolicy(
        {
          safe_patterns: [unauthorizedPatternCanary],
          allow_rule_recommendation: true,
        },
        [{
          match: [unauthorizedPatternCanary],
          domain: unauthorizedDomainCanary,
          parallel_safe: true,
        }],
      ),
    });
    const source = {
      contract: CLAUDE_SESSION_SOURCE_CONTRACT,
      discover: async () => [
        policySensitiveSession("linked-policy-session", linkedRepo),
      ],
    };

    await analyze({
      cwd: linkedRepo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths: referenceStorePaths,
      sessionSource: source,
      resolveRuleSafetyPolicy: async () => ruleSafety,
    });
    const referenceHistory = await loadAnalyses(referenceStorePaths);

    const resolvedRepos: string[] = [];
    let advisoryCalls = 0;
    const output = await runAnalyzeCommand({
      cwd: linkedRepo,
      pr: "main...feature",
      format: "json",
      color: false,
      privacy: "raw",
      advisory: true,
    }, {
      analyze: async (options) => await analyze({
        ...options,
        nowMs: NOW_MS,
        storePaths: commandStorePaths,
        sessionSource: source,
      }),
      resolvePolicy: async (resolvedRepo) => {
        resolvedRepos.push(resolvedRepo);
        return resolvedRepo === commandStorePaths.canonical_repo
          ? canonicalPolicy
          : linkedPathPolicy;
      },
      runCommand: async () => {
        advisoryCalls += 1;
        throw new Error("advisory must remain disabled by canonical policy");
      },
    });

    assert.deepEqual(resolvedRepos, [commandStorePaths.canonical_repo]);
    assert.equal(advisoryCalls, 0);
    assert.ok(output.warnings.some((warning) =>
      warning.includes("[policy_advisory_disabled]")
    ));
    const strictReport = JSON.parse(output.stdout) as ReportV2;
    const strictApproval = strictReport.findings.find(
      ({ rule_id }) => rule_id === "R004",
    );
    assert.ok(strictApproval !== undefined);
    assert.equal(strictApproval.fix_recipe.suggestion, "[redacted-command]");
    assert.equal(output.stdout.includes("npm test"), false);
    for (const finding of strictReport.findings) {
      assert.deepEqual(Object.keys(finding.evidence).sort(), [
        "interval_ids",
        "session_refs",
      ]);
      assert.equal(Object.hasOwn(finding.evidence, "canonical_commands"), false);
      assert.equal(Object.hasOwn(finding.evidence, "resource_domain"), false);
    }
    assert.equal(output.stdout.includes(unauthorizedPatternCanary), false);
    assert.equal(output.stdout.includes(unauthorizedDomainCanary), false);

    const commandHistory = await loadAnalyses(commandStorePaths);
    assert.equal(commandHistory.records.length, 1);
    const findings = commandHistory.records[0]?.findings ?? [];
    const approval = findings.find(({ rule_id, evidence }) =>
      rule_id === "R004" &&
      evidence.latency_classification === "repeated_safe_approval_latency"
    );
    const serial = findings.find(({ rule_id }) => rule_id === "R005");
    assert.deepEqual(approval?.evidence.canonical_commands, ["npm test"]);
    assert.equal(
      serial?.evidence.parallelization_classification,
      "parallel_safe",
    );
    assert.equal(serial?.evidence.resource_domain, "node-workspace");
    assert.equal(
      storedPolicyDigest(commandHistory),
      storedPolicyDigest(referenceHistory),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linked-worktree canonical rule-safety denial persists no authorized recipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-linked-policy-denial-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const linkedRepoPath = join(repo, ".test-worktrees", "policy-denial");
    await mkdir(dirname(linkedRepoPath), { recursive: true });
    await git(repo, ["worktree", "add", "--detach", linkedRepoPath, "feature"]);
    const linkedRepo = await realpath(linkedRepoPath);
    const storePaths = await resolveStorePaths(linkedRepo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    assert.notEqual(linkedRepo, storePaths.canonical_repo);
    assert.equal(storePaths.canonical_repo, repo);

    const linkedPathPolicy = commandPolicy({
      rule_safety: policySensitiveRuleSafety(),
    });
    const canonicalPolicy = commandPolicy({
      governed: true,
      organization: "example-corp",
      privacy: "balanced",
      rule_safety: resolveRuleSafetyPolicy(
        {
          safe_patterns: ["cargo *"],
          allow_rule_recommendation: true,
        },
        [{
          match: ["cargo *"],
          domain: "rust-workspace",
          parallel_safe: false,
        }],
      ),
    });
    const resolvedRepos: string[] = [];

    await runAnalyzeCommand({
      cwd: linkedRepo,
      pr: "main...feature",
      format: "json",
      color: false,
      privacy: "raw",
    }, {
      analyze: async (options) => await analyze({
        ...options,
        nowMs: NOW_MS,
        storePaths,
        sessionSource: {
          contract: CLAUDE_SESSION_SOURCE_CONTRACT,
          discover: async () => [
            policySensitiveSession("canonical-denial", linkedRepo),
          ],
        },
      }),
      resolvePolicy: async (resolvedRepo) => {
        resolvedRepos.push(resolvedRepo);
        return resolvedRepo === storePaths.canonical_repo
          ? canonicalPolicy
          : linkedPathPolicy;
      },
    });

    assert.deepEqual(resolvedRepos, [storePaths.canonical_repo]);
    const history = await loadAnalyses(storePaths);
    assert.equal(history.records.length, 1);
    const findings = history.records[0]?.findings ?? [];
    const approval = findings.find(({ rule_id }) => rule_id === "R004");
    const serial = findings.find(({ rule_id }) => rule_id === "R005");
    assert.equal(
      approval?.evidence.latency_classification,
      "approval_policy_latency",
    );
    assert.equal(
      Object.hasOwn(approval?.evidence ?? {}, "canonical_commands"),
      false,
    );
    assert.equal(
      serial?.evidence.parallelization_classification,
      "investigation_candidate",
    );
    assert.equal(
      Object.hasOwn(serial?.evidence ?? {}, "resource_domain"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linked-worktree canonical policy failure precedes discovery and persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-linked-policy-failure-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const linkedRepoPath = join(repo, ".test-worktrees", "policy-failure");
    await mkdir(dirname(linkedRepoPath), { recursive: true });
    await git(repo, ["worktree", "add", "--detach", linkedRepoPath, "feature"]);
    const linkedRepo = await realpath(linkedRepoPath);
    const storePaths = await resolveStorePaths(linkedRepo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    assert.notEqual(linkedRepo, storePaths.canonical_repo);
    assert.equal(storePaths.canonical_repo, repo);

    const invalidCanonicalPolicy = new Error("canonical policy invalid");
    const linkedPathPolicy = commandPolicy({
      rule_safety: policySensitiveRuleSafety(),
    });
    const resolvedRepos: string[] = [];
    let discoveryCalls = 0;

    await assert.rejects(
      runAnalyzeCommand({
        cwd: linkedRepo,
        pr: "main...feature",
        format: "json",
        color: false,
        privacy: "raw",
      }, {
        analyze: async (options) => await analyze({
          ...options,
          nowMs: NOW_MS,
          storePaths,
          sessionSource: {
            contract: CLAUDE_SESSION_SOURCE_CONTRACT,
            discover: async () => {
              discoveryCalls += 1;
              return [policySensitiveSession("must-not-persist", linkedRepo)];
            },
          },
        }),
        resolvePolicy: async (resolvedRepo) => {
          resolvedRepos.push(resolvedRepo);
          if (resolvedRepo === storePaths.canonical_repo) {
            throw invalidCanonicalPolicy;
          }
          return linkedPathPolicy;
        },
      }),
      (error: unknown) => error === invalidCanonicalPolicy,
    );

    assert.deepEqual(resolvedRepos, [storePaths.canonical_repo]);
    assert.equal(discoveryCalls, 0);
    assert.deepEqual((await loadAnalyses(storePaths)).records, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linked-worktree budget partial keeps canonical policy identity without Store paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-linked-budget-policy-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const linkedRepoPath = join(repo, ".test-worktrees", "policy-budget");
    await mkdir(dirname(linkedRepoPath), { recursive: true });
    await git(repo, ["worktree", "add", "--detach", linkedRepoPath, "feature"]);
    const linkedRepo = await realpath(linkedRepoPath);
    assert.notEqual(linkedRepo, repo);

    const canonicalPolicy = commandPolicy({
      governed: true,
      organization: "canonical-policy",
      privacy: "strict",
      allow_raw: false,
      allow_advisory: false,
      advisory_enabled: false,
      rule_safety: policySensitiveRuleSafety(),
    });
    const linkedPatternCanary = "npm test --linked-budget-policy-canary";
    const linkedDomainCanary = "linked-budget-policy-canary";
    const linkedPathPolicy = commandPolicy({
      privacy: "raw",
      allow_advisory: true,
      advisory_enabled: true,
      rule_safety: resolveRuleSafetyPolicy(
        {
          safe_patterns: [linkedPatternCanary],
          allow_rule_recommendation: true,
        },
        [{
          match: [linkedPatternCanary],
          domain: linkedDomainCanary,
          parallel_safe: true,
        }],
      ),
    });
    const advisoryCanary = "LINKED_BUDGET_ADVISORY_CANARY";
    const resolvedRepos: string[] = [];
    let discoveryCalls = 0;
    let projectorCalls = 0;
    let advisoryCalls = 0;
    let wallReads = 0;
    let partialReport: ReportV2 | undefined;
    let preparedOutput: string | undefined;

    const output = await runAnalyzeCommand({
      cwd: linkedRepo,
      pr: "main...feature",
      format: "json",
      color: false,
      privacy: "raw",
      advisory: true,
      budgets: {
        max_input_bytes: 1_000_000,
        max_input_events: 1_000,
        max_wall_ms: 0,
        max_cpu_ms: 1_000_000,
        max_output_bytes: 1_000_000,
        max_source_items: 1_000,
      },
      budgetClock: {
        wall_ms: () => wallReads++,
        cpu_ms: () => 0,
      },
    }, {
      analyze: async (options) => {
        assert.equal(Object.hasOwn(options, "storePaths"), false);
        const outputProjector = options.outputProjector;
        assert.ok(outputProjector !== undefined);
        const result = await analyze({
          ...options,
          nowMs: NOW_MS,
          persist: false,
          sessionSource: {
            contract: CLAUDE_SESSION_SOURCE_CONTRACT,
            discover: async () => {
              discoveryCalls += 1;
              return [policySensitiveSession("must-not-discover", linkedRepo)];
            },
          },
          outputProjector: async (report) => {
            projectorCalls += 1;
            return await outputProjector(report);
          },
        });
        partialReport = result.report;
        preparedOutput = result.preparedOutput;
        return result;
      },
      resolvePolicy: async (resolvedRepo) => {
        resolvedRepos.push(resolvedRepo);
        return resolvedRepo === repo ? canonicalPolicy : linkedPathPolicy;
      },
      runCommand: async () => {
        advisoryCalls += 1;
        throw new Error(advisoryCanary);
      },
    });

    assert.deepEqual(resolvedRepos, [repo]);
    assert.equal(discoveryCalls, 0);
    assert.equal(projectorCalls, 1);
    assert.equal(advisoryCalls, 0);
    assert.ok(partialReport !== undefined);
    assert.equal(partialReport.unit.repo, repo);
    assert.equal(
      partialReport.analysis_budget?.truncation_reason,
      "max_wall_ms",
    );
    assert.equal(preparedOutput, output.stdout);
    assert.ok(output.warnings.some((warning) =>
      warning.includes("[policy_advisory_disabled]")
    ));
    const strictReport = JSON.parse(output.stdout) as ReportV2;
    assert.notEqual(strictReport.unit.repo, repo);
    assert.notEqual(strictReport.unit.repo, linkedRepo);
    const visibleOutput = `${output.stdout}\n${output.warnings.join("\n")}`;
    assert.equal(visibleOutput.includes(repo), false);
    assert.equal(visibleOutput.includes(linkedRepo), false);
    assert.equal(visibleOutput.includes(linkedPatternCanary), false);
    assert.equal(visibleOutput.includes(linkedDomainCanary), false);
    assert.equal(visibleOutput.includes(advisoryCanary), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrates a deterministic PR analysis, stores all findings, and applies dismissal only to display", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-analyze-"));
  try {
    const repo = await makeRepository(root);
    const projects = await makeClaudeProjects(root, repo);
    const resolvedStorePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const storePaths = {
      ...resolvedStorePaths,
      canonical_repo: join(root, "canonical-repository"),
    };
    for (let index = 0; index < 3; index += 1) {
      await saveAnalysis(storePaths, {
        analysis_id: `history-${index}`,
        created_at_ms: NOW_MS - ((index + 1) * 1_000),
        unit: {
          repo,
          pr_ref: `main...history-${index}`,
          sessions: [`history-${index}`],
        },
        summary: seedSummary(),
        findings: [],
        metrics: { human_wait_ratio: 0.1 + (index * 0.1) },
        command_costs: [],
      });
    }

    const options = {
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
    } as const;
    const firstSource = queryCapturingClaudeSource(projects);
    const first = await analyze({
      ...options,
      sessionSource: firstSource.source,
    });
    const secondSource = queryCapturingClaudeSource(projects);
    const second = await analyze({
      ...options,
      nowMs: NOW_MS + 60_000,
      sessionSource: secondSource.source,
    });

    assert.deepEqual(second.report, first.report);
    assert.deepEqual(second.allFindings, first.allFindings);
    assert.deepEqual(first.window, {
      started_at_ms: Date.parse(FEATURE_COMMIT_DATE),
      ended_at_ms: NOW_MS,
      start_source: "commit_anchor_lookback",
      end_source: "analysis_time",
      completeness: "partial",
    });
    assert.equal(
      firstSource.queries[0]?.startedAtMs,
      0,
    );
    assert.equal(
      firstSource.queries[0]?.endedAtMs,
      first.window.ended_at_ms,
    );
    assert.deepEqual(first.report.unit.sessions, ["e2e-session"]);
    assert.equal(first.report.summary.baseline?.prs, 3);
    assert.ok(
      first.warnings.some(({ code }) => code === "invalid_json"),
      "source warnings must survive orchestration",
    );

    const expectedRules = ["R001", "R002", "R003", "R004", "R007", "R008"];
    assert.deepEqual(
      [...new Set(first.allFindings.map(({ rule_id }) => rule_id))].sort(),
      expectedRules,
    );
    assert.equal(
      first.allFindings.find(({ rule_id }) => rule_id === "R007")
        ?.recoverable.bound,
      "upper",
    );
    assert.ok(
      Number(
        first.allFindings.find(({ rule_id }) => rule_id === "R007")
          ?.evidence.max_estimated_tokens,
      ) > 50_000,
    );
    const flaky = first.allFindings.find(({ rule_id }) => rule_id === "R008");
    assert.equal(flaky?.confidence, "low");
    assert.equal(flaky?.evidence.unrelated_edit_count, 1);
    assert.deepEqual(flaky?.evidence.unrelated_edit_paths, [
      "docs/readme.md",
    ]);

    const severityRank = { info: 0, low: 1, medium: 2, high: 3 } as const;
    const confidenceRank = { low: 0, medium: 1, high: 2 } as const;
    const expectedTop = [...first.allFindings]
      .filter(({ recoverable }) => recoverable.min > 0)
      .sort(
        (left, right) =>
          (right.impact?.upper_ms ?? right.recoverable.min * 60_000) -
            (left.impact?.upper_ms ?? left.recoverable.min * 60_000) ||
          (right.impact?.lower_ms ?? 0) - (left.impact?.lower_ms ?? 0) ||
          severityRank[right.severity ?? "info"] -
            severityRank[left.severity ?? "info"] ||
          confidenceRank[right.confidence] - confidenceRank[left.confidence] ||
          left.rule_id.localeCompare(right.rule_id) ||
          left.finding_key.localeCompare(right.finding_key),
      )
      .slice(0, 3)
      .map(({ finding_key }) => finding_key);
    assert.deepEqual(
      first.report.findings.map(({ finding_key }) => finding_key),
      expectedTop,
    );

    assert.equal(
      first.report.summary.measured_min,
      first.ledger.normal_min +
        first.report.summary.recoverable_min +
        first.report.summary.human_wait_min +
        first.report.summary.unexplained_min,
    );
    assert.equal(
      first.ledger.raw_observed_min,
      first.report.summary.measured_min +
        first.report.summary.idle_excluded_min,
    );
    assert.deepEqual(
      (first.ledger as typeof first.ledger & {
        highConfidenceLowerBoundIntervals?: Interval[];
      }).highConfidenceLowerBoundIntervals,
      [],
    );
    assert.equal(
      first.report.summary.estimated_floor_min,
      first.report.summary.measured_min,
    );

    const stored = await loadAnalyses(storePaths);
    const current = stored.records.find(
      ({ unit }) => unit.pr_ref === "main...feature",
    );
    assert.ok(current);
    assert.equal(current.unit.repo, storePaths.canonical_repo);
    const workspaceId = analysisDigest(
      "terminal-stats-workspace-v1",
      storePaths.canonical_repo,
    );
    const terminalStats = current.terminal_stats_snapshot;
    assert.ok(terminalStats);
    assert.deepEqual(terminalStats.cohort, {
      repository_id: storePaths.repo_hash,
      workspace_id: workspaceId,
      changed_files: 1,
      changed_lines: 2,
    });
    assert.equal(
      terminalStats.measured_wall_ms,
      first.ledger.totals_ms.measured,
    );
    assert.equal(
      terminalStats.human_wait_ms,
      first.ledger.totals_ms.human_wait,
    );
    assert.equal(
      terminalStats.unexplained_ms,
      first.ledger.totals_ms.unexplained,
    );
    assert.deepEqual(
      terminalStats.rules.map((row) => ({
        rule_id: row.rule_id,
        rule_version: row.rule_version,
        compatibility_epoch: row.compatibility_epoch,
      })),
      listRuleManifests().map((manifest) => ({
        rule_id: manifest.id,
        rule_version: manifest.version,
        compatibility_epoch: manifest.compatibility_epoch,
      })),
    );
    assert.equal(
      terminalStats.rules.reduce(
        (total, row) => total + row.confirmed_critical_path_ms,
        0,
      ),
      terminalStats.confirmed_critical_path_ms,
    );
    assert.equal(
      terminalStats.rules.reduce(
        (total, row) => total + row.estimated_critical_path_upper_ms,
        0,
      ),
      terminalStats.estimated_critical_path_upper_ms,
    );
    assert.equal(
      terminalStats.rules.reduce(
        (total, row) => total + row.resource_cost_ms,
        0,
      ),
      terminalStats.resource_cost_ms,
    );
    const currentEntry = stored.entries?.find(
      ({ record }) => record.unit.pr_ref === "main...feature",
    );
    assert.ok(currentEntry);
    assert.equal("mode" in currentEntry.identity, false);
    assert.deepEqual(
      "mode" in currentEntry.identity
        ? undefined
        : currentEntry.identity.selector,
      {
        kind: "explicit_range",
        range: "triple_dot",
        base_ref_digest: selectorRefDigest(
          "explicit_range",
          "base",
          "main",
        ),
        head_ref_digest: selectorRefDigest(
          "explicit_range",
          "head",
          "feature",
        ),
      },
    );
    assert.equal(
      stored.records.filter(({ unit }) => unit.pr_ref === "main...feature")
        .length,
      1,
      "a deterministic rerun must reuse the immutable record",
    );
    const database = openStoreDatabase(storePaths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 4);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 5);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions WHERE snapshot_id = (SELECT snapshot_id FROM analysis_executions WHERE execution_id = ?)",
      ).pluck().get(first.record.analysis_id), 2);
    } finally {
      database.close();
    }
    assert.deepEqual(
      current.findings.map(({ finding_key }) => finding_key),
      first.allFindings.map(({ finding_key }) => finding_key),
    );
    const allByKey = new Map(
      first.allFindings.map((finding) => [finding.finding_key, finding]),
    );
    const storedByKey = new Map(
      current.findings.map((finding) => [finding.finding_key, finding]),
    );
    for (const finding of first.allFindings) {
      const storedFinding = storedByKey.get(finding.finding_key);
      assert.ok(storedFinding);
      assert.deepEqual(storedFinding.impact, finding.impact);
      assert.deepEqual(storedFinding.recoverable, finding.recoverable);
    }
    for (const finding of first.report.findings) {
      const allFinding = allByKey.get(finding.finding_key);
      assert.ok(allFinding);
      assert.deepEqual(finding.impact, allFinding.impact);
      assert.deepEqual(finding.recoverable, allFinding.recoverable);
    }
    assert.equal(current.summary.baseline?.prs, 3);
    const npmTestCost = current.command_costs.find(
      ({ command }) => command === "npm test",
    );
    assert.equal(
      npmTestCost?.duration_min,
      1,
      "overlapping runs of the same normalized command use wall-clock union",
    );
    assert.deepEqual(npmTestCost?.command_identity, {
      repo_relative_cwd: ".",
      normalized_argv: ["npm", "test"],
      executor: "shell",
    });

    const approval = first.allFindings.find(
      ({ rule_id }) => rule_id === "R004",
    );
    assert.ok(approval);
    await saveDismissal(storePaths, {
      finding_key: approval.finding_key,
      target: "approval-wait",
      dismissed_at_ms: NOW_MS - 1,
      strength_min: approval.recoverable.min,
      reason: "accepted for this workflow",
    });
    const dismissed = await analyze(options);
    assert.ok(
      dismissed.allFindings.some(
        ({ finding_key }) => finding_key === approval.finding_key,
      ),
      "dismissed findings remain in the complete stored population",
    );
    assert.ok(
      dismissed.report.findings.every(
        ({ finding_key }) => finding_key !== approval.finding_key,
      ),
      "dismissal filters only the displayed top findings",
    );
    assert.ok(dismissed.suppressedKeys.includes(approval.finding_key));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binary diffs suppress line cohorts and cohort policy changes snapshot identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-analyze-cohort-policy-"));
  try {
    const repo = await makeRepository(root);
    await writeFile(join(repo, "asset.bin"), Buffer.from([0, 1, 2, 3]));
    await git(repo, ["add", "asset.bin"]);
    await git(repo, ["commit", "-m", "binary fixture"], {
      GIT_AUTHOR_DATE: "2026-01-01T00:30:00.000Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:30:00.000Z",
    });
    const projects = await makeClaudeProjects(root, repo);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const common = {
      cwd: repo,
      pr: "main...feature",
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
    } as const;

    const defaultFloor = await analyze({
      ...common,
      nowMs: NOW_MS,
      minimumCohortSize: 5,
    });
    const organizationFloor = await analyze({
      ...common,
      nowMs: NOW_MS + 60_000,
      minimumCohortSize: 20,
    });

    assert.equal(
      "changed_lines" in
        (defaultFloor.record.terminal_stats_snapshot?.cohort ?? {}),
      false,
    );
    assert.equal(
      defaultFloor.record.terminal_stats_snapshot?.cohort.changed_files,
      2,
    );
    assert.equal(
      "changed_lines" in
        (organizationFloor.record.terminal_stats_snapshot?.cohort ?? {}),
      false,
    );

    const entries = (await loadAnalyses(storePaths)).entries ?? [];
    assert.equal(entries.length, 2);
    const policyDigests = entries.flatMap(({ identity }) =>
      "mode" in identity ? [] : [identity.policy_digest]
    );
    assert.equal(policyDigests.length, 2);
    assert.notEqual(policyDigests[0], policyDigests[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linked worktrees preserve existing and missing root-absolute reads in both directions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-linked-snapshot-"));
  try {
    const repo = await realpath(await makeRepository(root));
    assert.equal(await findGitMarker(join(repo, "bad\0child")), undefined);
    const linkedRepoPath = join(repo, ".test-worktrees", "linked");
    await mkdir(dirname(linkedRepoPath), { recursive: true });
    await git(repo, ["worktree", "add", "--detach", linkedRepoPath, "feature"]);
    const linkedRepo = await realpath(linkedRepoPath);
    await Promise.all([
      mkdir(join(repo, "packages", "api"), { recursive: true }),
      mkdir(join(linkedRepo, "packages", "api"), { recursive: true }),
    ]);
    const dataRoot = join(root, "data");
    const mainStorePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: dataRoot },
    });
    const linkedStorePaths = await resolveStorePaths(linkedRepo, {
      env: { CCPROF_DATA_DIR: dataRoot },
    });
    assert.equal(linkedStorePaths.canonical_repo, mainStorePaths.canonical_repo);
    assert.equal(linkedStorePaths.repo_dir, mainStorePaths.repo_dir);

    const session = (origin: string): Session => {
      const value = coordinationSession("linked-session", origin, "TodoWrite");
      const toolCwd = join(origin, "packages", "api");
      return {
        ...value,
        observed_cwds: [toolCwd],
        events: value.events.map((event) => event.kind === "tool_use"
          ? {
              ...event,
              paths: [
                ...event.paths.map((path) => join(origin, path)),
                ...(event.tool_use_id === "read-1"
                  ? [join(origin, "deleted", "nested", "value.ts")]
                  : []),
              ],
              cwd: toolCwd,
            }
          : event),
      };
    };
    const source = (origin: string): SessionSource => ({
      contract: CLAUDE_SESSION_SOURCE_CONTRACT,
      discover: async ({ repoRoot }) => [
        await alignSessionCwdsToRepository(session(origin), repoRoot),
      ],
    });
    const first = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths: mainStorePaths,
      sessionSource: source(repo),
    });
    const second = await analyze({
      cwd: linkedRepo,
      pr: "main...feature",
      nowMs: NOW_MS + 60_000,
      storePaths: linkedStorePaths,
      sessionSource: source(repo),
    });
    const third = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS + 120_000,
      storePaths: mainStorePaths,
      sessionSource: source(linkedRepo),
    });

    assert.deepEqual(second.report, first.report);
    assert.deepEqual(third.report, first.report);
    const { analysis_id: _firstId, created_at_ms: _firstTime,
      ...firstPayload } = first.record;
    const { analysis_id: _secondId, created_at_ms: _secondTime,
      ...secondPayload } = second.record;
    const { analysis_id: _thirdId, created_at_ms: _thirdTime,
      ...thirdPayload } = third.record;
    assert.deepEqual(secondPayload, firstPayload);
    assert.deepEqual(thirdPayload, firstPayload);
    for (const result of [first, second, third]) {
      assert.equal(result.record.unit.repo, mainStorePaths.canonical_repo);
      assert.deepEqual(
        result.record.read_observations?.map(({ path }) => path),
        ["src/value.ts"],
      );
    }
    const database = openStoreDatabase(mainStorePaths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 3);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PR number, PR URL, and explicit range produce equivalent analysis semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-selector-equivalence-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const [baseRefOid, headRefOid] = await Promise.all([
      git(repo, ["rev-parse", "main"]),
      git(repo, ["rev-parse", "feature"]),
    ]);
    const projects = await makeClaudeProjects(root, repo);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const startedAtMs = Date.parse("2026-01-01T00:00:00.000Z");
    const url = "https://github.com/example/ccprof/pull/17";
    const interceptedSelectors: string[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      const selector = args[2];
      if (command === "gh" &&
        args[0] === "pr" && args[1] === "view" &&
        (selector === "17" || selector === url)
      ) {
        interceptedSelectors.push(selector);
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 17,
            url,
            baseRefName: "main",
            baseRefOid,
            headRefName: "feature",
            headRefOid,
            isCrossRepository: false,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          stderr: "",
        };
      }
      if (command === "gh") {
        assert.fail(`unexpected gh command: gh ${args.join(" ")}`);
      }
      return await runCommand(command, args, options);
    };
    const testMap = { mappings: [], caveats: [] };
    const run = async (pr: string) => await analyze({
      cwd: repo,
      pr,
      sinceMs: startedAtMs,
      nowMs: NOW_MS,
      runner,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
      testMap,
      persist: false,
    });

    const numberResult = await run("17");
    const urlResult = await run(url);
    const rangeResult = await run("main...feature");
    const comparable = (result: Awaited<ReturnType<typeof analyze>>) => ({
      window: result.window,
      report: {
        version: result.report.version,
        unit: {
          repo: result.report.unit.repo,
          sessions: result.report.unit.sessions,
        },
        summary: result.report.summary,
        findings: result.report.findings,
        caveats: result.report.caveats,
        skipped_rules: result.report.skipped_rules,
      },
      all_findings: result.allFindings,
      ledger: result.ledger,
      metrics: result.record.metrics,
      command_costs: result.record.command_costs,
      read_observations: result.record.read_observations,
      warnings: result.warnings,
      suppressed_keys: result.suppressedKeys,
    });

    assert.deepEqual(comparable(numberResult), comparable(rangeResult));
    assert.deepEqual(comparable(urlResult), comparable(rangeResult));
    assert.deepEqual(rangeResult.window, {
      started_at_ms: startedAtMs,
      ended_at_ms: NOW_MS,
      start_source: "explicit",
      end_source: "analysis_time",
      completeness: "complete",
    });
    assert.deepEqual(interceptedSelectors, ["17", url]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session branch transition recovers pre-commit work only on broad fallback discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-session-transition-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const transitionAtMs = Date.parse(FEATURE_COMMIT_DATE) - 60_000;
    const common = { session_id: "transition", agent_id: "main", is_sidechain: false,
      confidence: "high" as const, branch: "feature", branch_epoch: 1 };
    const session: Session = {
      session_id: "transition", source: "claude", source_path: join(repo, "transition.jsonl"),
      observed_cwds: [repo], observed_branches: ["feature"], confidence: "high",
      started_at_ms: transitionAtMs, ended_at_ms: transitionAtMs + 40_000, warnings: [],
      events: [
        { ...common, kind: "genuine_user", timestamp_ms: transitionAtMs,
          entry_uuid: "u0", session_ref: "transition#u0", source_index: 0, text: "Start." },
        { ...common, kind: "assistant", timestamp_ms: transitionAtMs + 20_000,
          entry_uuid: "a1", session_ref: "transition#a1", source_index: 1, text: "Working." },
        { ...common, kind: "assistant", timestamp_ms: transitionAtMs + 40_000,
          entry_uuid: "a2", session_ref: "transition#a2", source_index: 2, text: "Ready." },
      ],
    };
    const queries: SessionQuery[] = [];
    const source: SessionSource = {
      contract: CLAUDE_SESSION_SOURCE_CONTRACT,
      discover: async (query) => (queries.push({ ...query }), [session]),
    };
    const noReflogRunner: CommandRunner = async (command, args, options) =>
      command === "git" && args[0] === "reflog"
        ? { code: 1, stdout: "", stderr: "reflog unavailable" }
        : await runCommand(command, args, options);
    const storePaths = await resolveStorePaths(repo, { env: { CCPROF_DATA_DIR: join(root, "data") } });
    const run = async (runner: CommandRunner, sinceMs?: number) => {
      queries.length = 0;
      const result = await analyze({ cwd: repo, pr: "main...feature", nowMs: NOW_MS, runner,
        sessionSource: source, storePaths, persist: false, ...(sinceMs === undefined ? {} : { sinceMs }) });
      return { result, query: queries[0] };
    };

    const broad = await run(noReflogRunner);
    assert.deepEqual([broad.query?.startedAtMs, broad.result.window.started_at_ms,
      broad.result.window.start_source], [0, transitionAtMs, "session_branch_transition"]);
    assert.equal(broad.result.ledger.totals_ms.measured, 40_000);

    const explicitAtMs = transitionAtMs + 20_000;
    const explicit = await run(noReflogRunner, explicitAtMs);
    assert.deepEqual([explicit.query?.startedAtMs, explicit.result.window.start_source],
      [explicitAtMs, "explicit"]);

    const headOid = await git(repo, ["rev-parse", "HEAD"]), reflogAtMs = transitionAtMs + 10_000;
    const reflogRunner: CommandRunner = async (command, args, options) =>
      command === "git" && args[0] === "reflog"
        ? { code: 0, stdout: `${headOid}\0refs/heads/feature@{${reflogAtMs / 1_000}}\0branch: Created from main\0`, stderr: "" }
        : await runCommand(command, args, options);
    const reflog = await run(reflogRunner);
    assert.deepEqual([reflog.query?.startedAtMs, reflog.result.window.start_source],
      [reflogAtMs, "branch_reflog"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a matched session with only one valid timestamp", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-single-timestamp-"));
  try {
    const repo = await makeRepository(root);
    const projects = join(root, "claude-projects");
    await write(
      join(projects, "fixture", "single-timestamp.jsonl"),
      `${JSON.stringify({
        type: "user",
        sessionId: "single-timestamp",
        uuid: "only-event",
        timestamp: "2026-01-01T00:00:30.000Z",
        cwd: repo,
        gitBranch: "feature",
        message: {
          content: "This session has no measurable interval.",
        },
      })}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    await assert.rejects(
      analyze({
        cwd: repo,
        pr: "main...feature",
        nowMs: NOW_MS,
        sessionSource: new ClaudeSessionSource(projects),
        storePaths,
      }),
      NoAnalyzableTimestampsError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persist: false skips saveAnalysis and saveAdoptions while still returning findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-persist-false-"));
  try {
    const repo = await makeRepository(root);
    const projects = await makeClaudeProjects(root, repo);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const options = {
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
      persist: false,
    } as const;

    const result = await analyze(options);

    assert.ok(
      result.allFindings.length > 0,
      "a hook-driven analysis still surfaces findings in memory",
    );
    const history = await loadAnalyses(storePaths);
    assert.deepEqual(
      history.records,
      [],
      "no analysis record is written to disk when persist is false",
    );
    const adoptions = await loadAdoptions(storePaths);
    assert.deepEqual(
      adoptions.records,
      [],
      "adoption detection is skipped entirely, so nothing is written either",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R008 excludes manifest build/check commands but keeps explicit custom tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-flaky-command-family-"));
  try {
    const repo = await makeRepository(root);
    await write(
      join(repo, "package.json"),
      `${JSON.stringify({
        private: true,
        scripts: {
          test: "node --test",
          build: "tsc",
          check: "tsc --noEmit",
        },
      }, null, 2)}\n`,
    );
    const projects = join(root, "claude-projects");
    const commands = [
      "npm run build",
      "npm run check",
      "make test",
      "make test && touch generated.txt",
    ];
    const rows: object[] = [{
      type: "user",
      sessionId: "command-families",
      uuid: "request",
      timestamp: "2026-01-01T00:00:05.000Z",
      cwd: repo,
      gitBranch: "feature",
      message: { content: "Validate the change." },
    }];
    let seconds = 10;
    const timestamp = (): string =>
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + seconds * 1_000)
        .toISOString();
    for (const [index, command] of commands.entries()) {
      for (const outcome of ["fail", "pass"] as const) {
        const toolUseId = `${outcome}-${index}`;
        rows.push({
          type: "assistant",
          sessionId: "command-families",
          uuid: `assistant-${toolUseId}`,
          timestamp: timestamp(),
          cwd: repo,
          gitBranch: "feature",
          message: {
            id: `message-${toolUseId}`,
            content: [{
              type: "tool_use",
              id: toolUseId,
              name: "Bash",
              input: { command },
            }],
          },
        });
        seconds += 5;
        rows.push({
          type: "user",
          sessionId: "command-families",
          uuid: `result-${toolUseId}`,
          timestamp: timestamp(),
          cwd: repo,
          gitBranch: "feature",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: toolUseId,
              content: outcome === "fail" ? "1 failed" : "1 passed",
              is_error: outcome === "fail",
            }],
          },
        });
      }
    }
    await write(
      join(projects, "fixture", "command-families.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const explicitTestMap = parseExplicitTestMap({
      mappings: [{
        source: ["src/**"],
        tests: ["test/**"],
        commands: ["make test"],
      }],
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
      testMap: {
        ...explicitTestMap,
        mappings: [
          ...explicitTestMap.mappings,
          {
            confidence: "high",
            origin: "explicit",
            caveat: "Unvalidated typed API input used by this regression.",
            source: ["src/**"],
            tests: ["test/**"],
            commands: ["make test && touch generated.txt"],
          },
        ],
      },
    });

    assert.deepEqual(
      result.allFindings
        .filter(({ rule_id }) => rule_id === "R008")
        .flatMap(({ evidence }) =>
          typeof evidence.command === "string" ? [evidence.command] : []
        )
        .sort(),
      ["make test"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function coordinationSession(
  sessionId: string,
  repo: string,
  toolName: string,
): Session {
  const shared = {
    session_id: sessionId,
    agent_id: "main",
    is_sidechain: false,
    confidence: "high" as const,
  };
  const t0 = NOW_MS - 600_000;
  return {
    session_id: sessionId,
    source: "claude",
    source_path: join(repo, `${sessionId}.jsonl`),
    observed_cwds: [repo],
    observed_branches: ["feature"],
    started_at_ms: t0,
    ended_at_ms: t0 + 180_000,
    confidence: "high",
    warnings: [],
    events: [
      {
        ...shared,
        kind: "tool_use",
        timestamp_ms: t0,
        entry_uuid: "read-use",
        session_ref: `${sessionId}#read-use`,
        source_index: 0,
        tool_use_id: "read-1",
        tool_name: "Read",
        input: {},
        paths: ["src/value.ts"],
        edit_fragments: [],
        cwd: repo,
      },
      {
        ...shared,
        kind: "tool_result",
        timestamp_ms: t0 + 60_000,
        entry_uuid: "read-result",
        session_ref: `${sessionId}#read-result`,
        source_index: 1,
        tool_use_id: "read-1",
        status: "success",
        output: "export const value = 2;",
        output_bytes: 24,
        estimated_tokens: 6,
      },
      {
        ...shared,
        kind: "tool_use",
        timestamp_ms: t0 + 120_000,
        entry_uuid: "tool-use",
        session_ref: `${sessionId}#tool-use`,
        source_index: 2,
        tool_use_id: "coord-1",
        tool_name: toolName,
        input: {},
        paths: [],
        edit_fragments: [],
        ...(toolName === "Bash" ? { command: "git status", cwd: repo } : {}),
      },
      {
        ...shared,
        kind: "tool_result",
        timestamp_ms: t0 + 180_000,
        entry_uuid: "tool-result",
        session_ref: `${sessionId}#tool-result`,
        source_index: 3,
        tool_use_id: "coord-1",
        status: "success",
        output: "ok",
        output_bytes: 2,
        estimated_tokens: 1,
      },
    ],
  };
}

test("coordination tools (including unknown mcp__ tools) count as normal time while delegation still invalidates frozen-head reads and truly unknown tools stay unexplained", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-coordination-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const analyzeWith = async (toolName: string, sessionId: string) =>
      await analyze({
        cwd: repo,
        pr: "main...feature",
        nowMs: NOW_MS,
        storePaths,
        sessionSource: {
          contract: CLAUDE_SESSION_SOURCE_CONTRACT,
          discover: async () => [
            coordinationSession(sessionId, repo, toolName),
          ],
        },
      });

    const todo = await analyzeWith("TodoWrite", "todo-session");
    assert.equal(todo.ledger.totals_ms.measured, 180_000);
    assert.equal(todo.ledger.totals_ms.normal, 120_000);
    assert.equal(todo.ledger.totals_ms.unexplained, 60_000);
    assert.equal(todo.record.read_observations?.length, 1);
    assert.equal(todo.record.read_observations?.[0]?.path, "src/value.ts");

    const agent = await analyzeWith("Agent", "agent-session");
    assert.equal(agent.ledger.totals_ms.normal, 120_000);
    assert.deepEqual(agent.record.read_observations, []);

    const mcp = await analyzeWith("mcp__custom__tool", "mcp-session");
    assert.equal(mcp.ledger.totals_ms.normal, 120_000);
    assert.equal(mcp.ledger.totals_ms.unexplained, 60_000);
    assert.equal(mcp.record.read_observations?.length, 1);

    const unknown = await analyzeWith("CustomUnknownTool", "unknown-session");
    assert.equal(unknown.ledger.totals_ms.normal, 60_000);
    assert.equal(unknown.ledger.totals_ms.unexplained, 120_000);

    const vcs = await analyzeWith("Bash", "vcs-session");
    assert.equal(vcs.ledger.totals_ms.normal, 120_000);
    assert.deepEqual(vcs.record.read_observations, []);
    assert.deepEqual(
      vcs.record.command_costs.map(({ command, duration_min }) => ({
        command,
        duration_min,
      })),
      [{ command: "git status", duration_min: 1 }],
    );
    assert.deepEqual(vcs.record.command_costs[0]?.command_identity, {
      repo_relative_cwd: ".",
      normalized_argv: ["git", "status"],
      executor: "shell",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("command costs separate cwd identities, exclude missing identities, and stay deterministic", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-command-costs-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const commandSession = (sessionId: string, cwd?: string): Session => {
      const session = coordinationSession(sessionId, repo, "Bash");
      const command = session.events.find(
        (event) => event.kind === "tool_use" && event.tool_use_id === "coord-1",
      );
      assert.equal(command?.kind, "tool_use");
      if (cwd === undefined) delete command.cwd;
      else command.cwd = cwd;
      return session;
    };
    const sessions = [
      commandSession("api-cost", join(repo, "packages/api")),
      commandSession("web-cost", join(repo, "packages/web")),
      commandSession("missing-cost"),
    ];
    const analyzeSessions = async (ordered: Session[]) => await analyze({
      cwd: repo, pr: "main...feature", nowMs: NOW_MS, storePaths,
      sessionSource: sourceForSessions(ordered), persist: false,
    });

    const forward = await analyzeSessions(sessions);
    const reverse = await analyzeSessions([...sessions].reverse());
    assert.equal(reverse.record.analysis_id, forward.record.analysis_id);
    assert.deepEqual(reverse.record.command_costs, forward.record.command_costs);
    assert.deepEqual(
      forward.record.command_costs.map((cost) => ({
        command: cost.command,
        command_identity: cost.command_identity,
        duration_min: cost.duration_min,
      })),
      ["api", "web"].map((name) => ({
        command: "git status",
        command_identity: {
          repo_relative_cwd: `packages/${name}`,
          normalized_argv: ["git", "status"],
          executor: "shell",
        },
        duration_min: 1,
      })),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function humanWaitSession(sessionId: string, repo: string): Session {
  const shared = {
    session_id: sessionId,
    agent_id: "main",
    is_sidechain: false,
    confidence: "high" as const,
  };
  const t0 = NOW_MS - 600_000;
  const at = (
    kind: "genuine_user" | "assistant",
    entryUuid: string,
    offsetMs: number,
    sourceIndex: number,
    text: string,
  ) => ({
    ...shared,
    kind,
    timestamp_ms: t0 + offsetMs,
    entry_uuid: entryUuid,
    session_ref: `${sessionId}#${entryUuid}`,
    source_index: sourceIndex,
    text,
  });
  return {
    session_id: sessionId,
    source: "claude",
    source_path: join(repo, `${sessionId}.jsonl`),
    observed_cwds: [repo],
    observed_branches: ["feature"],
    started_at_ms: t0,
    ended_at_ms: t0 + 160_000,
    confidence: "high",
    warnings: [],
    events: [
      at("genuine_user", "u0", 0, 0, "Start the task."),
      at("assistant", "a1", 10_000, 1, "Which option should I take?"),
      at("genuine_user", "u1", 70_000, 2, "Take the first option."),
      at("assistant", "a2", 80_000, 3, "Asking a follow-up."),
      {
        ...shared,
        kind: "tool_use",
        timestamp_ms: t0 + 90_000,
        entry_uuid: "ask-use",
        session_ref: `${sessionId}#ask-use`,
        source_index: 4,
        tool_use_id: "ask-1",
        tool_name: "AskUserQuestion",
        input: {},
        paths: [],
        edit_fragments: [],
      },
      {
        ...shared,
        kind: "tool_result",
        timestamp_ms: t0 + 150_000,
        entry_uuid: "ask-result",
        session_ref: `${sessionId}#ask-result`,
        source_index: 5,
        tool_use_id: "ask-1",
        status: "success",
        output: "answered",
        output_bytes: 8,
        estimated_tokens: 2,
      },
      at("assistant", "a3", 160_000, 6, "Continuing with the answer."),
    ],
  };
}

test("turn waits and AskUserQuestion waits land in human_wait_min instead of unexplained", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-human-wait-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: {
        contract: CLAUDE_SESSION_SOURCE_CONTRACT,
        discover: async () => [humanWaitSession("wait-session", repo)],
      },
    });

    assert.equal(result.ledger.totals_ms.measured, 160_000);
    assert.equal(result.ledger.totals_ms.human_wait, 120_000);
    assert.equal(result.report.summary.human_wait_min, 2);
    assert.equal(result.report.summary.unexplained_min, 0.67);
    assert.equal(result.ledger.totals_ms.normal, 0);
    assert.equal(
      result.report.summary.measured_min,
      result.ledger.normal_min +
        result.report.summary.recoverable_min +
        result.report.summary.human_wait_min +
        result.report.summary.unexplained_min,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a multi-branch session only counts head-branch work and avoids false rework", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-window-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const projects = join(root, "claude-projects");
    const row = (value: Record<string, unknown>): string =>
      JSON.stringify({ sessionId: "multi-branch", cwd: repo, ...value });
    const rows = [
      row({
        type: "user",
        uuid: "old-u0",
        timestamp: "2026-01-01T00:01:00.000Z",
        gitBranch: "feature/old",
        message: { role: "user", content: "Work on the previous PR." },
      }),
      row({
        type: "assistant",
        uuid: "old-a1",
        timestamp: "2026-01-01T00:01:10.000Z",
        gitBranch: "feature/old",
        message: {
          id: "old-m1",
          content: [{
            type: "tool_use",
            id: "edit-old",
            name: "Edit",
            input: {
              file_path: "docs/note.md",
              old_string: "",
              new_string: "note that never reaches the current diff",
            },
          }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
      row({
        type: "user",
        uuid: "old-r1",
        timestamp: "2026-01-01T00:01:30.000Z",
        gitBranch: "feature/old",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "edit-old",
            content: "updated",
            is_error: false,
          }],
        },
      }),
      row({
        type: "user",
        uuid: "new-u0",
        timestamp: "2026-01-01T00:10:00.000Z",
        gitBranch: "feature",
        message: { role: "user", content: "Implement the current PR." },
      }),
      row({
        type: "assistant",
        uuid: "new-a1",
        timestamp: "2026-01-01T00:10:10.000Z",
        gitBranch: "feature",
        message: {
          id: "new-m1",
          content: [{
            type: "tool_use",
            id: "read-1",
            name: "Read",
            input: { file_path: "src/value.ts" },
          }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
      row({
        type: "user",
        uuid: "new-r1",
        timestamp: "2026-01-01T00:10:40.000Z",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "read-1",
            content: "export const value = 2;",
            is_error: false,
          }],
        },
      }),
    ];
    await write(
      join(projects, "fixture", "multi-branch.jsonl"),
      `${rows.join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: new ClaudeSessionSource(projects),
    });

    assert.deepEqual(result.report.unit.sessions, ["multi-branch"]);
    assert.equal(
      result.allFindings.some(({ rule_id }) => rule_id === "R001"),
      false,
    );
    assert.equal(result.ledger.totals_ms.measured, 40_000);
    assert.ok(
      result.warnings.some(({ code }) => code === "branch_scoped"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("time between head-branch segments is not counted as the current PR", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-gap-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const projects = join(root, "claude-projects");
    const row = (
      uuid: string,
      at: string,
      branch: string | undefined,
      text: string,
    ): string =>
      JSON.stringify({
        sessionId: "segmented",
        cwd: repo,
        type: "user",
        uuid,
        timestamp: at,
        ...(branch === undefined ? {} : { gitBranch: branch }),
        message: { role: "user", content: text },
      });
    const rows = [
      row("h-1", "2026-01-01T00:05:00.000Z", "feature", "head work"),
      row("h-2", "2026-01-01T00:05:30.000Z", undefined, "still head"),
      row("o-1", "2026-01-01T00:06:00.000Z", "feature/other", "other pr"),
      row("o-2", "2026-01-01T00:07:00.000Z", undefined, "still other"),
      row("h-3", "2026-01-01T00:08:00.000Z", "feature", "back on head"),
      row("h-4", "2026-01-01T00:08:20.000Z", undefined, "finishing"),
    ];
    await write(
      join(projects, "fixture", "segmented.jsonl"),
      `${rows.join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: new ClaudeSessionSource(projects),
    });

    assert.deepEqual(result.report.unit.sessions, ["segmented"]);
    // 30s in the first head segment plus 20s in the second; the other-branch
    // interlude (00:05:30 -> 00:08:00) must not bridge into measured time.
    assert.equal(result.ledger.totals_ms.raw_observed, 50_000);
    assert.equal(result.ledger.totals_ms.measured, 50_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a branch departure visible only on non-event rows still splits the segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-epoch-gap-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const projects = join(root, "claude-projects");
    const userRow = (
      uuid: string,
      at: string,
      branch: string | undefined,
      text: string,
    ): string =>
      JSON.stringify({
        sessionId: "epoch-gap",
        cwd: repo,
        type: "user",
        uuid,
        timestamp: at,
        ...(branch === undefined ? {} : { gitBranch: branch }),
        message: { role: "user", content: text },
      });
    const rows = [
      userRow("h-1", "2026-01-01T00:05:00.000Z", "feature", "head work"),
      userRow("h-2", "2026-01-01T00:05:30.000Z", undefined, "still head"),
      // The other-branch interlude is visible only on a non-event system row.
      JSON.stringify({
        sessionId: "epoch-gap",
        cwd: repo,
        type: "system",
        uuid: "sys-other",
        timestamp: "2026-01-01T00:06:00.000Z",
        gitBranch: "feature/other",
      }),
      userRow("h-3", "2026-01-01T00:08:00.000Z", "feature", "back on head"),
      userRow("h-4", "2026-01-01T00:08:20.000Z", undefined, "finishing"),
    ];
    await write(
      join(projects, "fixture", "epoch-gap.jsonl"),
      `${rows.join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: new ClaudeSessionSource(projects),
    });

    assert.deepEqual(result.report.unit.sessions, ["epoch-gap"]);
    // 30s before and 20s after the departure; the 00:05:30 -> 00:08:00 span
    // spent on the other branch must not be bridged into this PR.
    assert.equal(result.ledger.totals_ms.raw_observed, 50_000);
    assert.equal(result.ledger.totals_ms.measured, 50_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an other-branch sidechain does not split the main agent's head segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-branch-sidechain-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const projects = join(root, "claude-projects");
    const mainRow = (
      uuid: string,
      at: string,
      branch: string | undefined,
      text: string,
    ): string =>
      JSON.stringify({
        sessionId: "side-mix",
        cwd: repo,
        type: "user",
        uuid,
        timestamp: at,
        ...(branch === undefined ? {} : { gitBranch: branch }),
        message: { role: "user", content: text },
      });
    const sideRow = (uuid: string, at: string, branch?: string): string =>
      JSON.stringify({
        sessionId: "side-mix",
        cwd: repo,
        type: "user",
        uuid,
        timestamp: at,
        isSidechain: true,
        agentId: "side",
        ...(branch === undefined ? {} : { gitBranch: branch }),
        message: { role: "user", content: `sidechain ${uuid}` },
      });
    const rows = [
      mainRow("m-1", "2026-01-01T00:05:00.000Z", "feature", "head work"),
      mainRow("m-2", "2026-01-01T00:05:30.000Z", undefined, "continues"),
      sideRow("s-1", "2026-01-01T00:06:00.000Z", "feature/other"),
      sideRow("s-2", "2026-01-01T00:07:00.000Z"),
      mainRow("m-3", "2026-01-01T00:08:00.000Z", undefined, "still head"),
      mainRow("m-4", "2026-01-01T00:08:20.000Z", undefined, "finish"),
    ];
    await write(
      join(projects, "fixture", "side-mix.jsonl"),
      `${rows.join("\n")}\n`,
    );
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: new ClaudeSessionSource(projects),
    });

    assert.deepEqual(result.report.unit.sessions, ["side-mix"]);
    // The main agent stays on the head branch from 00:05:00 to 00:08:20, so
    // its 200s span must stay whole; the sidechain's other-branch time is
    // excluded and must add nothing.
    assert.equal(result.ledger.totals_ms.raw_observed, 200_000);
    assert.equal(result.ledger.totals_ms.measured, 200_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyze detects and persists a CLAUDE.md adoption of a prior PR's suggestion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-"));
  try {
    const repo = await makeRepository(root);
    const projects = await makeClaudeProjects(root, repo);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    // Seed a finding from a *different* PR so it counts as prior history:
    // adoption tracking is a cross-PR signal, not an intra-PR rerun signal.
    const priorFindingKey = "seed-r005-deploy-checklist";
    const priorSuggestion = "Explain the deploy checklist steps in CLAUDE.md.";
    await saveAnalysis(storePaths, {
      analysis_id: "history-adoption-seed",
      created_at_ms: NOW_MS - 5_000,
      unit: {
        repo,
        pr_ref: "main...prior-pr",
        sessions: ["prior-session"],
      },
      summary: seedSummary(),
      findings: [{
        finding_key: priorFindingKey,
        rule_id: "R005",
        title: "Independent tool calls ran serially",
        classification: "behavior",
        cause: null,
        scope: "claude_md",
        confidence: "medium",
        evidence: { session_refs: ["prior-session#u0"], interval_ids: [] },
        fix_recipe: { suggestion: priorSuggestion, verify: "ccprof --json" },
        caveats: [],
        recoverable: { min: 3, bound: "point" },
      }],
      metrics: {},
      command_costs: [],
    });

    const options = {
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
    } as const;

    const first = await analyze(options);
    assert.deepEqual(
      first.adoptions,
      [],
      "no CLAUDE.md commit exists yet, so nothing can be adopted",
    );
    const storedBeforeFix = await loadAdoptions(storePaths);
    assert.deepEqual(storedBeforeFix.records, []);

    // Address the suggestion by editing CLAUDE.md after recorded_at_ms.
    await write(
      join(repo, "CLAUDE.md"),
      "# Team notes\n\n## Deploy checklist\nFollow the steps before merging.\n",
    );
    await git(repo, ["add", "CLAUDE.md"]);
    await git(repo, ["commit", "-m", "docs: add deploy checklist"], {
      GIT_AUTHOR_DATE: "2026-01-01T00:59:58.000Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:59:58.000Z",
    });
    const fixCommit = await git(repo, ["rev-parse", "HEAD"]);

    const second = await analyze(options);
    const adopted = second.adoptions.find(
      ({ finding_key }) => finding_key === priorFindingKey,
    );
    assert.ok(adopted, "the seeded suggestion must be reported as adopted");
    assert.equal(adopted?.method, "claude_md_edit");
    assert.equal(adopted?.evidence.path, "CLAUDE.md");
    assert.equal(adopted?.evidence.commit, fixCommit);
    assert.equal(adopted?.rule_id, "R005");
    assert.equal(adopted?.scope, "claude_md");
    assert.equal(adopted?.detected_at_ms, NOW_MS);
    assert.deepEqual(
      second.adoptions.map(({ finding_key }) => finding_key),
      [...second.adoptions]
        .map(({ finding_key }) => finding_key)
        .sort((left, right) => left.localeCompare(right)),
      "adoptions must be sorted by finding_key",
    );

    const storedAfterFix = await loadAdoptions(storePaths);
    assert.deepEqual(
      storedAfterFix.records.map(({ finding_key }) => finding_key),
      [priorFindingKey],
      "the adoption must be persisted to the adoptions store",
    );

    const third = await analyze(options);
    assert.equal(
      third.adoptions.filter(({ finding_key }) => finding_key === priorFindingKey).length,
      1,
      "a rerun must not duplicate an already-recorded adoption",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("propagates the underlying source error, not NoMatchingSessionsError, when every source found nothing and one threw", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-source-error-empty-"));
  try {
    const repo = await makeRepository(root);
    const claudeProjects = await makeMalformedClaudeProjects(root);
    const emptyCodexSessions = join(root, "codex-sessions-empty");
    await mkdir(emptyCodexSessions, { recursive: true });
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    // No sessionSource is injected here on purpose: this exercises
    // defaultSessionSource's CombinedSessionSource([claude, codex]) wiring,
    // with the Claude arm forced to fail and the Codex arm contributing
    // nothing, so the combined result is empty.
    await assert.rejects(
      analyze({
        cwd: repo,
        pr: "main...feature",
        nowMs: NOW_MS,
        storePaths,
        claudeProjectsDirectory: claudeProjects,
        codexSessionsDirectory: emptyCodexSessions,
      }),
      (error: unknown) => {
        assert.ok(
          error instanceof ClaudeDiscoveryError,
          "the underlying discovery error must propagate as-is, not be swallowed",
        );
        assert.ok(
          !(error instanceof NoMatchingSessionsError),
          "a real source failure must not be masked as NoMatchingSessionsError",
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial source failure warns and rejects surviving transition evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-source-error-partial-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const anchorAtMs = Date.parse(FEATURE_COMMIT_DATE);
    const transitionAtMs = anchorAtMs - 60_000;
    const failingPath = join(root, "failed-codex-source.jsonl");
    const base = hookEventSession("transition", repo);
    const transition: Session = { ...base, started_at_ms: transitionAtMs,
      ended_at_ms: anchorAtMs + 1_000,
      events: [transitionAtMs, anchorAtMs, anchorAtMs + 1_000]
        .map((timestamp_ms, index) => ({ ...base.events[index === 0 ? 0 : 1]!,
          timestamp_ms, entry_uuid: `e${index}`, session_ref: `transition#e${index}`,
          source_index: index, branch: "feature", branch_epoch: 1 })) };
    const claudeDiscover = ClaudeSessionSource.prototype.discover;
    const codexDiscover = CodexSessionSource.prototype.discover;
    ClaudeSessionSource.prototype.discover = async () => [transition];
    CodexSessionSource.prototype.discover = async () => {
      throw new ClaudeDiscoveryError([{ code: "source_read_error",
        message: "Could not read a source.", source_path: failingPath }]);
    };
    try {
      const result = await analyze({ cwd: repo, pr: "main...feature",
        nowMs: NOW_MS, storePaths, persist: false });
      assert.equal(result.window.start_source, "commit_anchor_lookback");
      assert.equal(result.window.started_at_ms, anchorAtMs);
      assert.deepEqual(result.report.unit.sessions, ["transition"]);
      const warning = result.warnings.find(({ code }) => code === "session_source_error")?.message ?? "";
      assert.ok(warning.startsWith("Claude session discovery failed for one or more sources."));
      assert.ok(warning.includes(failingPath));
    } finally {
      ClaudeSessionSource.prototype.discover = claudeDiscover;
      CodexSessionSource.prototype.discover = codexDiscover;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial source failure creates a distinct snapshot for an otherwise identical record", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-source-error-snapshot-"));
  try {
    const repo = await makeRepository(root);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const session = hookEventSession("source-identity", repo);
    const failingPath = join(root, "failed-codex-source.jsonl");
    const claudeDiscover = ClaudeSessionSource.prototype.discover;
    const codexDiscover = CodexSessionSource.prototype.discover;
    ClaudeSessionSource.prototype.discover = async () => [session];
    CodexSessionSource.prototype.discover = async () => [];
    try {
      const options = { cwd: repo, pr: "main...feature",
        sinceMs: NOW_MS - 20 * 60_000, storePaths } as const;
      const healthy = await analyze({ ...options, nowMs: NOW_MS });
      CodexSessionSource.prototype.discover = async () => {
        throw new ClaudeDiscoveryError([{ code: "source_read_error",
          message: "Could not read a source.", source_path: failingPath }]);
      };
      const partial = await analyze({ ...options, nowMs: NOW_MS + 60_000 });
      assert.ok(partial.warnings.some(
        ({ code }) => code === "session_source_error",
      ));
      const { analysis_id: _healthyId, created_at_ms: _healthyTime,
        ...healthyPayload } = healthy.record;
      const { analysis_id: _partialId, created_at_ms: _partialTime,
        ...partialPayload } = partial.record;
      assert.deepEqual(partialPayload, healthyPayload);

      const database = openStoreDatabase(storePaths);
      try {
        assert.equal(database.prepare(
          "SELECT count(*) FROM analysis_snapshots",
        ).pluck().get(), 2);
        assert.equal(database.prepare(
          "SELECT count(*) FROM analysis_executions",
        ).pluck().get(), 2);
      } finally {
        database.close();
      }
    } finally {
      ClaudeSessionSource.prototype.discover = claudeDiscover;
      CodexSessionSource.prototype.discover = codexDiscover;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains eligible evidence with partial coverage in a mixed Codex+Claude session set", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-skipped-rules-"));
  try {
    const repo = await makeRepository(root);
    const claudeProjects = await makeClaudeProjects(root, repo);
    const codexSessions = await makeCodexSessions(root, repo, "feature");
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      claudeProjectsDirectory: claudeProjects,
      codexSessionsDirectory: codexSessions,
    });

    // Sanity check: both sources actually contributed a session, so the
    // capability mix (full Claude session + Codex session without
    // token_usage) is really in play below.
    assert.deepEqual(result.report.unit.sessions, [
      "codex-integration",
      "e2e-session",
    ]);

    const contextBloat = result.allFindings.filter(
      ({ rule_id }) => rule_id === "R007",
    );
    assert.ok(contextBloat.length > 0);
    assert.ok(contextBloat.every(({ evidence }) =>
      evidence.session_refs.every((ref) => !ref.startsWith("codex-integration#"))
    ));
    assert.deepEqual(
      result.report.rule_coverage?.find(({ rule_id }) => rule_id === "R007"),
      {
        rule_id: "R007",
        eligible_sessions: 1,
        total_sessions: 2,
        status: "partial",
        missing_capabilities: ["token_usage"],
        completeness: 0.5,
        truncated: true,
      },
    );
    assert.equal(result.report.skipped_rules, undefined);

    const skipWarnings = result.warnings.filter(
      (warning) => warning.code === "rule_skipped_missing_capability",
    );
    assert.deepEqual(
      skipWarnings.map((warning) => warning.message).sort(),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full-capability (Claude-only) analyses omit skipped_rules and emit no capability-skip warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-no-skipped-rules-"));
  try {
    const repo = await makeRepository(root);
    const projects = await makeClaudeProjects(root, repo);
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      sessionSource: new ClaudeSessionSource(projects),
      storePaths,
    });

    assert.equal(result.report.skipped_rules, undefined);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result.report, "skipped_rules"),
      "skipped_rules must be entirely omitted, not present-but-empty",
    );
    assert.deepEqual(
      result.warnings.filter(
        (warning) => warning.code === "rule_skipped_missing_capability",
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A minimal two-event session (just enough for `buildTimeline` to form an
 * analyzable interval) used by the hook-events wiring tests below, where
 * only `session_id` / `ended_at_ms` matter. */
function hookEventSession(sessionId: string, repo: string): Session {
  const shared = {
    session_id: sessionId,
    agent_id: "main",
    is_sidechain: false,
    confidence: "high" as const,
  };
  const t0 = NOW_MS - 600_000;
  const endedAtMs = t0 + 60_000;
  return {
    session_id: sessionId,
    source: "claude",
    source_path: join(repo, `${sessionId}.jsonl`),
    observed_cwds: [repo],
    observed_branches: ["feature"],
    started_at_ms: t0,
    ended_at_ms: endedAtMs,
    confidence: "high",
    warnings: [],
    events: [
      {
        ...shared,
        kind: "genuine_user",
        timestamp_ms: t0,
        entry_uuid: "u0",
        session_ref: `${sessionId}#u0`,
        source_index: 0,
        text: "Start the task.",
      },
      {
        ...shared,
        kind: "assistant",
        timestamp_ms: endedAtMs,
        entry_uuid: "a1",
        session_ref: `${sessionId}#a1`,
        source_index: 1,
        text: "Done.",
      },
    ],
  };
}

test("repository config digest is legacy-compatible and ignores $schema", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-config-digest-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repo = await realpath(await makeRepository(root));
  const storePaths = await resolveStorePaths(repo, {
    env: { CCPROF_DATA_DIR: join(root, "data") },
  });
  const session = hookEventSession("config-digest-session", repo);
  const run = async (nowMs: number) => await analyze({
    cwd: repo,
    pr: "main...feature",
    nowMs,
    idleThresholdMs: 123_000,
    storePaths,
    sessionSource: sourceForSessions([session]),
  });

  const absent = await run(NOW_MS);
  await write(
    join(repo, ".ccprof", "config.json"),
    '{"$schema":"https://schema-a.invalid/config.json","schema_version":1}\n',
  );
  const schemaA = await run(NOW_MS + 60_000);
  await write(
    join(repo, ".ccprof", "config.json"),
    '{"$schema":"https://schema-b.invalid/config.json","schema_version":1}\n',
  );
  const schemaB = await run(NOW_MS + 120_000);

  const manifest = await discoverManifestTestMap(repo);
  assert.equal(manifest.mappings.length, 1);
  const mapping = manifest.mappings[0];
  assert.ok(mapping);
  const sortedUnique = (values: readonly string[]): string[] =>
    [...new Set(values.filter((value) => value !== ""))].sort(
      (left, right) => left.localeCompare(right),
    );
  const legacyDigest = analysisDigest("analysis-config-v1", {
    idle_threshold_ms: 123_000,
    mappings: [{
      source: sortedUnique(mapping.source),
      tests: sortedUnique(mapping.tests),
      commands: sortedUnique(mapping.commands),
      confidence: mapping.confidence,
      origin: mapping.origin,
      caveat: mapping.caveat,
    }],
    caveats: sortedUnique(manifest.caveats),
    external_tool_names: [],
  });

  const database = openStoreDatabase(storePaths);
  try {
    const digestFor = (executionId: string): unknown => {
      const row = database.prepare(`SELECT s.record_json
        FROM analysis_executions e JOIN analysis_snapshots s USING (snapshot_id)
        WHERE e.execution_id = ?`).get(executionId) as
        { record_json: string } | undefined;
      assert.ok(row);
      const envelope = JSON.parse(row.record_json) as {
        identity: { config_digest?: unknown };
      };
      return envelope.identity.config_digest;
    };
    const absentDigest = digestFor(absent.record.analysis_id);
    const schemaADigest = digestFor(schemaA.record.analysis_id);
    const schemaBDigest = digestFor(schemaB.record.analysis_id);
    assert.equal(absentDigest, legacyDigest);
    assert.notEqual(schemaADigest, absentDigest);
    assert.equal(schemaBDigest, schemaADigest);
    assert.equal(database.prepare(
      "SELECT count(*) FROM analysis_snapshots",
    ).pluck().get(), 2);
    assert.equal(database.prepare(
      "SELECT count(*) FROM analysis_executions",
    ).pluck().get(), 3);
  } finally {
    database.close();
  }
});

test("a hook-events.jsonl file with a matching, in-window Stop row is read without a warning and measurably extends the timeline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-inwindow-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const extendByMs = 5 * 60_000;

    const baselineStorePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data-baseline") },
    });
    const baselineSession = hookEventSession("hook-session", repo);
    const baseline = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths: baselineStorePaths,
      sessionSource: sourceForSessions([baselineSession]),
      persist: false,
    });

    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const session = hookEventSession("hook-session", repo);
    await write(
      storePaths.hook_events_path,
      `${JSON.stringify({
        received_at_ms: session.ended_at_ms + extendByMs,
        session_id: session.session_id,
        hook_event_name: "Stop",
      })}\n`,
    );

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: sourceForSessions([session]),
      persist: false,
    });

    assert.deepEqual(
      result.warnings.filter((warning) => warning.code.startsWith("hook_events")),
      [],
    );

    // The hook-recorded Stop row must actually extend measured time by the
    // gap it corroborates, not just parse cleanly - this is the point of
    // Session.verified_ended_at_ms feeding a synthetic timeline tail.
    assert.equal(
      result.ledger.totals_ms.measured,
      baseline.ledger.totals_ms.measured + extendByMs,
    );
    assert.equal(
      result.report.summary.measured_min,
      baseline.report.summary.measured_min + extendByMs / 60_000,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hook Stop rows respect both frozen boundaries and unique session attribution", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-end-boundary-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const windowStartMs = NOW_MS - 600_000;
    const analyzeStopAt = async (
      receivedAtMs: number,
      dataDir: string,
      discovered?: Session[],
    ) => {
      const storePaths = await resolveStorePaths(repo, {
        env: { CCPROF_DATA_DIR: join(root, dataDir) },
      });
      const session = hookEventSession("hook-session", repo);
      await write(
        storePaths.hook_events_path,
        `${JSON.stringify({
          received_at_ms: receivedAtMs,
          session_id: session.session_id,
          hook_event_name: "Stop",
        })}\n`,
      );
      return await analyze({
        cwd: repo,
        pr: "main...feature",
        sinceMs: windowStartMs,
        nowMs: NOW_MS,
        storePaths,
        sessionSource: sourceForSessions(discovered ?? [session]),
        persist: false,
      });
    };

    const afterBoundary = await analyzeStopAt(NOW_MS + 1, "data-after");
    assert.equal(afterBoundary.window.ended_at_ms, NOW_MS);
    assert.equal(afterBoundary.ledger.totals_ms.measured, 60_000);

    const beforeBoundary = await analyzeStopAt(windowStartMs - 1, "data-before");
    assert.equal(beforeBoundary.window.started_at_ms, windowStartMs);
    assert.equal(beforeBoundary.ledger.totals_ms.measured, 60_000);

    const atBoundary = await analyzeStopAt(NOW_MS, "data-at");
    assert.equal(atBoundary.window.ended_at_ms, NOW_MS);
    assert.equal(atBoundary.ledger.totals_ms.measured, 10 * 60_000);

    const claude = hookEventSession("hook-session", repo);
    const collision = await analyzeStopAt(NOW_MS, "data-collision", [
      claude,
      { ...claude, source: "codex", source_path: join(repo, "codex.jsonl") },
    ]);
    assert.equal(collision.ledger.totals_ms.measured, 60_000);
    assert.deepEqual(
      collision.report.sources?.map((source) => ({
        adapter_id: source.adapter_id,
        adapter_version: source.adapter_version,
        source_kind: source.source_kind,
      })),
      [
        {
          adapter_id: "claude",
          adapter_version: "1.0.0",
          source_kind: "claude_transcript_jsonl",
        },
        {
          adapter_id: "codex",
          adapter_version: "1.0.0",
          source_kind: "codex_rollout_jsonl",
        },
      ],
    );

    const preStartCollision: Session = {
      ...claude,
      source: "codex",
      source_path: join(repo, "codex-before.jsonl"),
      started_at_ms: windowStartMs - 2,
      ended_at_ms: windowStartMs - 1,
      events: claude.events.map((event, index) => ({
        ...event, timestamp_ms: windowStartMs - 2 + index,
      })),
    };
    const slicedCollision = await analyzeStopAt(
      NOW_MS, "data-sliced-collision", [claude, preStartCollision],
    );
    assert.equal(slicedCollision.ledger.totals_ms.measured, 60_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Stop row more than 30 minutes past ended_at_ms is read without a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-toolate-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const session = hookEventSession("hook-session", repo);
    await write(
      storePaths.hook_events_path,
      `${JSON.stringify({
        received_at_ms: session.ended_at_ms + 31 * 60_000,
        session_id: session.session_id,
        hook_event_name: "Stop",
      })}\n`,
    );

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: sourceForSessions([session]),
    });

    assert.deepEqual(
      result.warnings.filter((warning) => warning.code.startsWith("hook_events")),
      [],
    );
    // An out-of-window row must not extend measured time: the session's
    // own two events span exactly one minute, unmodified.
    assert.equal(result.ledger.totals_ms.measured, 60_000);
    assert.equal(result.report.summary.measured_min, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Stop row for an unrelated session_id is read without a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-mismatch-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const session = hookEventSession("hook-session", repo);
    await write(
      storePaths.hook_events_path,
      `${JSON.stringify({
        received_at_ms: session.ended_at_ms + 5 * 60_000,
        session_id: "unrelated-session",
        hook_event_name: "Stop",
      })}\n`,
    );

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: sourceForSessions([session]),
    });

    assert.deepEqual(
      result.warnings.filter((warning) => warning.code.startsWith("hook_events")),
      [],
    );
    // A row keyed to a different session_id must not extend this session's
    // measured time.
    assert.equal(result.ledger.totals_ms.measured, 60_000);
    assert.equal(result.report.summary.measured_min, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analysis proceeds unchanged when hook-events.jsonl is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-absent-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const session = hookEventSession("hook-session", repo);

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: sourceForSessions([session]),
    });

    assert.deepEqual(
      result.warnings.filter((warning) => warning.code.startsWith("hook_events")),
      [],
    );
    assert.equal(result.report.unit.sessions.length, 1);
    assert.equal(result.ledger.totals_ms.measured, 60_000);
    assert.equal(result.report.summary.measured_min, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt hook-events.jsonl line degrades to one aggregate warning instead of failing analysis", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-events-corrupt-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const session = hookEventSession("hook-session", repo);
    await write(
      storePaths.hook_events_path,
      ["{not valid json", JSON.stringify({ session_id: "hook-session" })].join(
        "\n",
      ) + "\n",
    );

    const result = await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs: NOW_MS,
      storePaths,
      sessionSource: sourceForSessions([session]),
    });

    const hookWarnings = result.warnings.filter(
      (warning) => warning.code === "hook_events_invalid_rows",
    );
    assert.equal(hookWarnings.length, 1);
    assert.match(hookWarnings[0]?.message ?? "", /^2 hook event rows /u);
    assert.equal(hookWarnings[0]?.source, storePaths.hook_events_path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hook input completeness creates a new snapshot even when malformed rows do not change analysis output", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-hook-snapshot-completeness-"));
  try {
    const repo = await realpath(await makeRepository(root));
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    });
    const run = async (nowMs: number) => await analyze({
      cwd: repo,
      pr: "main...feature",
      nowMs,
      storePaths,
      sessionSource: sourceForSessions([
        hookEventSession("hook-session", repo),
      ]),
    });

    const first = await run(NOW_MS);
    await run(NOW_MS + 60_000);
    let database = openStoreDatabase(storePaths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 1);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 2);
    } finally {
      database.close();
    }

    await write(storePaths.hook_events_path, "{malformed\n");
    const incomplete = await run(NOW_MS + 120_000);
    assert.ok(incomplete.warnings.some(
      ({ code }) => code === "hook_events_invalid_rows",
    ));
    const { analysis_id: _firstId, created_at_ms: _firstTime, ...firstPayload } =
      first.record;
    const { analysis_id: _incompleteId, created_at_ms: _incompleteTime,
      ...incompletePayload } = incomplete.record;
    assert.deepEqual(incompletePayload, firstPayload);

    database = openStoreDatabase(storePaths);
    try {
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_snapshots",
      ).pluck().get(), 2);
      assert.equal(database.prepare(
        "SELECT count(*) FROM analysis_executions",
      ).pluck().get(), 3);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixed-window analysis is invariant to high-impact events outside the snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-window-metamorphic-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repo = await realpath(await makeRepository(root));
  const startedAtMs = NOW_MS - 600_000;
  const storePaths = await resolveStorePaths(repo, {
    env: { CCPROF_DATA_DIR: join(root, "data") },
  });
  const stable = coordinationSession("window-session", repo, "Bash");
  stable.events = stable.events.map((event) =>
    event.kind === "tool_use" && event.tool_use_id === "coord-1"
      ? { ...event, command: "npm test" }
      : event
  );
  const common = { session_id: stable.session_id, agent_id: "main",
    is_sidechain: false, confidence: "high" as const };
  const outside: Session["events"] = [
    { ...common, kind: "tool_use", timestamp_ms: startedAtMs - 20_000,
      entry_uuid: "pre-command", session_ref: "window-session#pre-command",
      source_index: 0, tool_use_id: "pre", tool_name: "Bash", input: {},
      paths: [], edit_fragments: [], command: "npm test" },
    { ...common, kind: "tool_result", timestamp_ms: startedAtMs - 10_000,
      entry_uuid: "pre-result", session_ref: "window-session#pre-result",
      source_index: 1, tool_use_id: "pre", status: "success",
      output: "x".repeat(100_000), output_bytes: 100_000, estimated_tokens: 25_000 },
    { ...common, kind: "compaction", timestamp_ms: NOW_MS + 1,
      entry_uuid: "post-compact", session_ref: "window-session#post-compact",
      source_index: 10, summary: "future compaction", estimated_tokens: 99_999 },
    { ...common, kind: "tool_use", timestamp_ms: NOW_MS + 2,
      entry_uuid: "post-edit", session_ref: "window-session#post-edit",
      source_index: 11, tool_use_id: "post", tool_name: "Edit", input: {},
      paths: ["src/value.ts"], edit_fragments: ["export const value = 999;"] },
    { ...common, kind: "tool_result", timestamp_ms: NOW_MS + 3,
      entry_uuid: "post-result", session_ref: "window-session#post-result",
      source_index: 12, tool_use_id: "post", status: "success", output: "updated",
      output_bytes: 7, estimated_tokens: 2 },
    { ...common, kind: "assistant", timestamp_ms: NOW_MS + 4,
      entry_uuid: "post-correction", session_ref: "window-session#post-correction",
      source_index: 13, text: "Actually, rewrite everything." },
  ];
  const expanded: Session = { ...stable, started_at_ms: startedAtMs - 20_000,
    ended_at_ms: NOW_MS + 4, verified_ended_at_ms: NOW_MS + 5,
    events: [outside[0]!, outside[1]!, ...stable.events, ...outside.slice(2)] };
  const run = async (session: Session) => await analyze({
    cwd: repo, pr: "main...feature", sinceMs: startedAtMs, nowMs: NOW_MS,
    storePaths, sessionSource: sourceForSessions([session]),
    testMap: { mappings: [], caveats: [] }, persist: false,
  });

  const baseline = await run(stable);
  const changed = await run(expanded);
  const comparable = (value: typeof baseline) => ({ window: value.window,
    report: value.report, findings: value.allFindings, ledger: value.ledger,
    command_costs: value.record.command_costs,
    read_observations: value.record.read_observations });
  assert.deepEqual(comparable(changed), comparable(baseline));
  const intervals = [changed.ledger.normalIntervals, changed.ledger.unexplainedIntervals,
    changed.ledger.humanWaitIntervals, changed.ledger.idleIntervals,
    ...changed.ledger.attributions.map(({ intervals }) => intervals)].flat();
  assert.ok(intervals.every(({ start_ms, end_ms }) =>
    start_ms >= startedAtMs && end_ms <= NOW_MS));
  await assert.rejects(run({ ...stable, events: outside }), NoMatchingSessionsError);
});
