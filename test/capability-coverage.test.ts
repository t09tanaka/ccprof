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
import { join } from "node:path";
import test from "node:test";

import { analyze, ruleSessionLanes } from "../src/core/analyze.js";
import {
  ALL_SESSION_CAPABILITIES,
  type RuleId,
  type RuleCoverage,
  type ReportV2,
  type Session,
  type SessionCapability,
} from "../src/core/model.js";
import {
  RULE_REQUIRED_CAPABILITIES,
  ruleCoverage,
} from "../src/rules/capabilities.js";
import { runCommand } from "../src/git/client.js";
import { renderJsonReport } from "../src/reporters/json.js";
import { renderMarkdownReport } from "../src/reporters/markdown.js";
import { projectReportPrivacy } from "../src/reporters/privacy.js";
import { renderTtyReport } from "../src/reporters/tty.js";
import { parseClaudeTranscript } from "../src/sources/claude/parser.js";
import { loadAnalyses } from "../src/store/analyses.js";
import { resolveStorePaths } from "../src/store/paths.js";
import { openStoreDatabase } from "../src/store/sqlite.js";

const NOW_MS = Date.parse("2026-01-01T01:00:00.000Z");

function session(options: {
  id: string;
  source?: Session["source"];
  capabilities?: readonly SessionCapability[];
  warningCode?: string;
}): Session {
  const source = options.source ?? "claude";
  return {
    session_id: options.id,
    source,
    source_path: `/private/${source}/${options.id}.jsonl`,
    observed_cwds: ["/repo"],
    observed_branches: ["main"],
    started_at_ms: 1,
    ended_at_ms: 2,
    confidence: "high",
    events: [],
    warnings: options.warningCode === undefined
      ? []
      : [{
        code: options.warningCode,
        message: "SECRET parser detail",
        source_path: "/private/SECRET.jsonl",
        session_ref: "SECRET-session",
      }],
    ...(options.capabilities === undefined
      ? {}
      : { capabilities: options.capabilities }),
  };
}

function coverage(
  entries: readonly RuleCoverage[],
  ruleId: RuleCoverage["rule_id"],
): RuleCoverage {
  const entry = entries.find(({ rule_id }) => rule_id === ruleId);
  assert.ok(entry);
  return entry;
}

test("ruleCoverage emits the exact deterministic R001-R008 contract", () => {
  const limited = ALL_SESSION_CAPABILITIES.filter(
    (capability) => capability !== "token_usage",
  );
  const result = ruleCoverage([
    session({ id: "claude-full" }),
    session({ id: "codex-limited", source: "codex", capabilities: limited }),
  ]);

  assert.deepEqual(
    result.map(({ rule_id }) => rule_id),
    ["R001", "R002", "R003", "R004", "R005", "R006", "R007", "R008"],
  );
  for (const entry of result) {
    assert.deepEqual(Object.keys(entry), [
      "rule_id",
      "eligible_sessions",
      "total_sessions",
      "status",
      "missing_capabilities",
      "completeness",
      "truncated",
    ], entry.rule_id);
  }
  assert.deepEqual(coverage(result, "R007"), {
    rule_id: "R007",
    eligible_sessions: 1,
    total_sessions: 2,
    status: "partial",
    missing_capabilities: ["token_usage"],
    completeness: 0.5,
    truncated: false,
  });
  for (const entry of result.filter(({ rule_id }) => rule_id !== "R007")) {
    assert.equal(entry.eligible_sessions, 2, entry.rule_id);
    assert.equal(entry.total_sessions, 2, entry.rule_id);
    assert.equal(entry.status, "full", entry.rule_id);
    assert.deepEqual(entry.missing_capabilities, [], entry.rule_id);
    assert.equal(entry.completeness, 1, entry.rule_id);
    assert.equal(entry.truncated, false, entry.rule_id);
  }
});

test("ruleCoverage handles zero eligible and required-empty rules", () => {
  const result = ruleCoverage([
    session({ id: "limited", source: "codex", capabilities: [] }),
  ]);

  assert.deepEqual(coverage(result, "R001"), {
    rule_id: "R001",
    eligible_sessions: 0,
    total_sessions: 1,
    status: "partial",
    missing_capabilities: ["edit_fragments"],
    completeness: 0,
    truncated: false,
  });
  assert.deepEqual(coverage(result, "R005").missing_capabilities, [
    "tool_timestamps",
  ]);
  assert.deepEqual(coverage(result, "R007").missing_capabilities, [
    "token_usage",
  ]);
  assert.deepEqual(coverage(result, "R006"), {
    rule_id: "R006",
    eligible_sessions: 1,
    total_sessions: 1,
    status: "full",
    missing_capabilities: [],
    completeness: 1,
    truncated: false,
  });
});

test("ruleCoverage defines empty input as finite full coverage", () => {
  for (const entry of ruleCoverage([])) {
    assert.equal(entry.eligible_sessions, 0, entry.rule_id);
    assert.equal(entry.total_sessions, 0, entry.rule_id);
    assert.equal(entry.status, "full", entry.rule_id);
    assert.deepEqual(entry.missing_capabilities, [], entry.rule_id);
    assert.equal(entry.completeness, 1, entry.rule_id);
    assert.ok(Number.isFinite(entry.completeness), entry.rule_id);
    assert.equal(entry.truncated, false, entry.rule_id);
  }
});

test("ruleCoverage is order-independent and undefined capabilities remain full", () => {
  const sessions = [
    session({ id: "legacy" }),
    session({
      id: "limited",
      source: "codex",
      capabilities: ["edit_fragments", "tool_timestamps"],
    }),
  ];
  assert.deepEqual(ruleCoverage(sessions), ruleCoverage([...sessions].reverse()));
  assert.equal(coverage(ruleCoverage([sessions[0]!]), "R007").status, "full");
});

test("ruleCoverage computes non-binary ratios and canonical missing unions", () => {
  const mutableRequirements = RULE_REQUIRED_CAPABILITIES as Record<
    RuleId,
    readonly SessionCapability[]
  >;
  const original = mutableRequirements.R001;
  mutableRequirements.R001 = ["tool_timestamps", "edit_fragments"];
  try {
    const result = coverage(ruleCoverage([
      session({ id: "eligible" }),
      session({ id: "missing-edit", capabilities: ["tool_timestamps"] }),
      session({ id: "missing-time", capabilities: ["edit_fragments"] }),
    ]), "R001");
    assert.equal(result.eligible_sessions, 1);
    assert.equal(result.total_sessions, 3);
    assert.equal(result.status, "partial");
    assert.deepEqual(result.missing_capabilities, [
      "edit_fragments",
      "tool_timestamps",
    ]);
    assert.equal(result.completeness, 1 / 3);
    assert.ok(Number.isFinite(result.completeness));
  } finally {
    mutableRequirements.R001 = original;
  }
});

test("ruleCoverage truncation uses only admitted parser codes and partial windows", () => {
  const full = session({ id: "full" });
  const limited = session({
    id: "limited",
    source: "codex",
    capabilities: ["edit_fragments", "tool_timestamps"],
    warningCode: "parser_line_budget_exceeded",
  });
  const complete = ruleCoverage([full, limited]);

  assert.equal(coverage(complete, "R001").truncated, true);
  assert.equal(coverage(complete, "R005").truncated, true);
  assert.equal(
    coverage(complete, "R007").truncated,
    false,
    "an ineligible warning must not contaminate the admitted R007 lane",
  );
  assert.ok(!JSON.stringify(complete).includes("SECRET"));

  const unrelated = ruleCoverage([
    session({ id: "unrelated", warningCode: "invalid_json" }),
  ]);
  assert.ok(unrelated.every(({ truncated }) => truncated === false));

  const partialWindow = ruleCoverage([full, limited], "partial");
  assert.ok(partialWindow.every(({ truncated }) => truncated === true));

  for (const warningCode of [
    "parser_file_budget_exceeded",
    "parser_line_budget_exceeded",
    "parser_node_budget_exceeded",
    "parser_depth_budget_exceeded",
    "parser_byte_budget_exceeded",
    "parser_warning_budget_exceeded",
    "parser_content_truncated",
  ]) {
    const entries = ruleCoverage([
      session({ id: warningCode, warningCode }),
    ]);
    assert.ok(entries.every(({ truncated }) => truncated), warningCode);
  }

  const zeroEligible = coverage(ruleCoverage([
    session({
      id: "zero-eligible",
      capabilities: [],
      warningCode: "parser_file_budget_exceeded",
    }),
  ]), "R007");
  assert.equal(zeroEligible.eligible_sessions, 0);
  assert.equal(zeroEligible.truncated, false);
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await runCommand("git", args, {
    cwd,
    env: {
      GIT_AUTHOR_DATE: "2026-01-01T00:20:00.000Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:20:00.000Z",
    },
    timeoutMs: 10_000,
  });
  assert.equal(result.code, 0, result.stderr);
}

async function repository(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "ccprof test"]);
  await git(repo, ["config", "user.email", "ccprof@example.invalid"]);
  await writeFile(join(repo, "package.json"), "{\"private\":true}\n");
  await writeFile(join(repo, "README.md"), "# fixture\n");
  await writeFile(join(repo, "src/value.ts"), "export const value = 1;\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["switch", "-c", "feature"]);
  await writeFile(join(repo, "src/value.ts"), "export const value = 2;\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "feature"]);
  return await realpath(repo);
}

async function fixtureSession(root: string, repo: string): Promise<Session> {
  const fixture = await readFile(
    join(process.cwd(), "test/fixtures/e2e/session.jsonl"),
    "utf8",
  );
  const path = join(root, "claude-session.jsonl");
  const reworkRows = [
    {
      type: "assistant", sessionId: "e2e-session", uuid: "extra-edit",
      timestamp: "2026-01-01T00:02:42.000Z", cwd: repo,
      gitBranch: "feature", message: { id: "extra-edit-message", content: [{
        type: "tool_use", id: "extra-edit-use", name: "Edit",
        input: { file_path: "src/value.ts",
          old_string: "export const value = 2;",
          new_string: "export const temporaryValue = 999;" },
      }] },
    },
    {
      type: "user", sessionId: "e2e-session", uuid: "extra-edit-result",
      timestamp: "2026-01-01T00:02:48.000Z", cwd: repo,
      gitBranch: "feature", message: { content: [{ type: "tool_result",
        tool_use_id: "extra-edit-use", content: "updated", is_error: false }] },
    },
  ].map((row) => JSON.stringify(row));
  await writeFile(path, fixture
    .replaceAll("__REPO_ROOT__", JSON.stringify(repo).slice(1, -1))
    .replace("__LARGE_OUTPUT__", "x".repeat(200_004))
    .split("\n")
    .flatMap((line) => line.includes('"uuid":"a6"')
      ? [...reworkRows, line]
      : [line])
    .join("\n"));
  const parsed = (await parseClaudeTranscript(path))[0];
  assert.ok(parsed);
  return relabelSession(parsed, "claude-eligible", "claude");
}

function relabelSession(
  value: Session,
  id: string,
  source: Session["source"],
  capabilities?: readonly SessionCapability[],
): Session {
  return {
    ...value,
    session_id: id,
    source,
    source_path: `/private/${source}/${id}.jsonl`,
    events: value.events.map((event) => ({
      ...event,
      session_id: id,
      session_ref: `${id}#${event.entry_uuid}`,
    })),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

async function analyzeSessions(
  root: string,
  repo: string,
  sessions: readonly Session[],
) {
  return await analyze({
    cwd: repo,
    pr: "main...feature",
    sinceMs: NOW_MS - 2 * 60 * 60_000,
    nowMs: NOW_MS,
    sessionSource: { discover: async () => [...sessions] },
    storePaths: await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
    }),
    persist: false,
  });
}

test("mixed Claude and Codex lanes retain eligible R001 and R007 evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-capability-mixed-"));
  try {
    const repo = await repository(root);
    const eligible = await fixtureSession(root, repo);
    const limited = relabelSession(
      eligible,
      "codex-limited",
      "codex",
      ["tool_timestamps"],
    );
    const result = await analyzeSessions(root, repo, [limited, eligible]);

    assert.deepEqual(coverage(result.report.rule_coverage ?? [], "R006"), {
      rule_id: "R006",
      eligible_sessions: 2,
      total_sessions: 2,
      status: "full",
      missing_capabilities: [],
      completeness: 1,
      truncated: false,
    });
    assert.ok(
      !result.report.skipped_rules?.some(({ rule_id }) => rule_id === "R006"),
    );

    for (const ruleId of ["R001", "R007"] as const) {
      const entry = coverage(result.report.rule_coverage ?? [], ruleId);
      assert.equal(entry.eligible_sessions, 1);
      assert.equal(entry.total_sessions, 2);
      assert.equal(entry.status, "partial");
      assert.equal(entry.completeness, 0.5);
      assert.ok(
        !result.report.skipped_rules?.some(({ rule_id }) => rule_id === ruleId),
      );
      const findings = result.allFindings.filter(({ rule_id }) =>
        rule_id === ruleId
      );
      assert.ok(findings.length > 0, `${ruleId} eligible evidence was lost`);
      assert.ok(findings.every(({ evidence }) =>
        evidence.session_refs.every((ref) => !ref.startsWith("codex-limited#"))
      ));
    }

    const zero = await analyzeSessions(root, repo, [limited]);
    assert.deepEqual(
      zero.report.skipped_rules?.filter(({ rule_id }) =>
        rule_id === "R001" || rule_id === "R007"
      ),
      [
        { rule_id: "R001", missing: ["edit_fragments"] },
        { rule_id: "R007", missing: ["token_usage"] },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function serialReadSession(
  repo: string,
  id: string,
  source: Session["source"],
  capabilities: readonly SessionCapability[],
): Session {
  const base = NOW_MS - 30 * 60_000;
  const common = {
    session_id: id,
    agent_id: "root",
    is_sidechain: false,
    confidence: "high" as const,
  };
  const events: Session["events"] = [
    { ...common, kind: "tool_use", timestamp_ms: base, entry_uuid: "use-a",
      session_ref: `${id}#use-a`, source_index: 0, tool_use_id: "read-a",
      tool_name: "Read", input: { file_path: "README.md" },
      paths: [join(repo, "README.md")], edit_fragments: [], cwd: repo },
    { ...common, kind: "tool_result", timestamp_ms: base + 100,
      entry_uuid: "result-a", session_ref: `${id}#result-a`, source_index: 1,
      tool_use_id: "read-a", status: "success", output: "value",
      output_bytes: 5, estimated_tokens: 2 },
    { ...common, kind: "tool_use", timestamp_ms: base + 100,
      entry_uuid: "use-b", session_ref: `${id}#use-b`, source_index: 2,
      tool_use_id: "read-b", tool_name: "Read",
      input: { file_path: "package.json" }, paths: [join(repo, "package.json")],
      edit_fragments: [], cwd: repo },
    { ...common, kind: "tool_result", timestamp_ms: base + 410,
      entry_uuid: "result-b", session_ref: `${id}#result-b`, source_index: 3,
      tool_use_id: "read-b", status: "success", output: "package",
      output_bytes: 7, estimated_tokens: 2 },
  ];
  return {
    session_id: id,
    source,
    source_path: `/private/${source}/${id}.jsonl`,
    observed_cwds: [repo],
    observed_branches: ["feature"],
    started_at_ms: base,
    ended_at_ms: base + 410,
    confidence: "high",
    events,
    warnings: [],
    capabilities,
  };
}

test("ruleSessionLanes excludes ineligible sessions before evidence building", () => {
  const eligible = session({ id: "eligible" });
  const limited = session({
    id: "limited",
    source: "codex",
    capabilities: ["tool_timestamps"],
  });
  const lanes = ruleSessionLanes([limited, eligible]);

  assert.deepEqual(lanes.R001.map(({ session_id }) => session_id), ["eligible"]);
  assert.deepEqual(lanes.R007.map(({ session_id }) => session_id), ["eligible"]);
  assert.deepEqual(lanes.R005.map(({ session_id }) => session_id), [
    "limited",
    "eligible",
  ]);
  assert.deepEqual(lanes.R006.map(({ session_id }) => session_id), [
    "limited",
    "eligible",
  ]);
});

test("R005 receives only tool-timestamp-capable session actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-capability-r005-"));
  try {
    const repo = await repository(root);
    const eligible = serialReadSession(repo, "eligible", "claude", [
      "tool_timestamps",
    ]);
    const ineligible = serialReadSession(repo, "ineligible", "codex", []);
    const result = await analyzeSessions(root, repo, [ineligible, eligible]);
    const entry = coverage(result.report.rule_coverage ?? [], "R005");
    assert.equal(entry.eligible_sessions, 1);
    assert.equal(entry.status, "partial");
    const findings = result.allFindings.filter(({ rule_id }) =>
      rule_id === "R005"
    );
    assert.ok(findings.length > 0, "eligible serial reads must remain detectable");
    assert.ok(findings.every(({ evidence }) =>
      evidence.session_refs.every((ref) => !ref.startsWith("ineligible#"))
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function outputCoverage(): RuleCoverage[] {
  return [
    {
      rule_id: "R001",
      eligible_sessions: 1,
      total_sessions: 2,
      status: "partial",
      missing_capabilities: ["edit_fragments"],
      completeness: 0.5,
      truncated: true,
    },
    {
      rule_id: "R006",
      eligible_sessions: 2,
      total_sessions: 2,
      status: "full",
      missing_capabilities: [],
      completeness: 1,
      truncated: false,
    },
    {
      rule_id: "R007",
      eligible_sessions: 0,
      total_sessions: 2,
      status: "partial",
      missing_capabilities: ["token_usage"],
      completeness: 0,
      truncated: false,
    },
  ];
}

function outputReport(includeCoverage = true): ReportV2 {
  return {
    version: 2,
    unit: { repo: "/private/repo", pr_ref: "main...feature", sessions: [] },
    summary: {
      measured_min: 0,
      idle_excluded_min: 0,
      estimated_floor_min: 0,
      recoverable_min: 0,
      human_wait_min: 0,
      unexplained_min: 0,
      baseline: null,
    },
    findings: [],
    caveats: [],
    ...(includeCoverage ? { rule_coverage: outputCoverage() } : {}),
    skipped_rules: [{ rule_id: "R007", missing: ["token_usage"] }],
  };
}

test("JSON and human reporters publish deterministic rule coverage", () => {
  const report = outputReport();
  const before = structuredClone(report);
  const json = renderJsonReport(report);
  const parsed = JSON.parse(json) as ReportV2;

  assert.deepEqual(parsed.rule_coverage, outputCoverage());
  for (const entry of parsed.rule_coverage ?? []) {
    assert.deepEqual(Object.keys(entry), [
      "rule_id",
      "eligible_sessions",
      "total_sessions",
      "status",
      "missing_capabilities",
      "completeness",
      "truncated",
    ]);
  }
  assert.ok(json.indexOf('"caveats"') < json.indexOf('"rule_coverage"'));
  assert.ok(json.indexOf('"rule_coverage"') < json.indexOf('"skipped_rules"'));
  assert.deepEqual(report, before);

  report.rule_coverage = [...(report.rule_coverage ?? [])].reverse();
  const reversedBefore = structuredClone(report);
  const expected =
    "Rule coverage: R001 1/2 partial (missing edit_fragments; truncated), " +
    "R006 2/2 full, R007 0/2 partial (missing token_usage).";
  const tty = renderTtyReport(report, { color: false });
  const markdown = renderMarkdownReport(report);
  assert.ok(tty.includes(expected));
  assert.ok(markdown.includes(expected));
  assert.doesNotMatch(tty, /Skipped rules/u);
  assert.doesNotMatch(markdown, /Skipped rules/u);
  assert.deepEqual(report, reversedBefore);
});

test("privacy clones coverage facts while raw preserves report identity", () => {
  const report = outputReport();
  const before = structuredClone(report);
  const strict = projectReportPrivacy(report, "strict");
  const balanced = projectReportPrivacy(report, "balanced");

  assert.deepEqual(strict.rule_coverage, report.rule_coverage);
  assert.deepEqual(balanced.rule_coverage, report.rule_coverage);
  assert.notEqual(strict.rule_coverage, report.rule_coverage);
  assert.notEqual(strict.rule_coverage?.[0], report.rule_coverage?.[0]);
  assert.notEqual(
    strict.rule_coverage?.[0]?.missing_capabilities,
    report.rule_coverage?.[0]?.missing_capabilities,
  );
  assert.notEqual(balanced.rule_coverage, report.rule_coverage);
  assert.notEqual(balanced.rule_coverage?.[0], report.rule_coverage?.[0]);
  assert.notEqual(
    balanced.rule_coverage?.[0]?.missing_capabilities,
    report.rule_coverage?.[0]?.missing_capabilities,
  );
  strict.rule_coverage?.[0]?.missing_capabilities.push("tool_timestamps");
  balanced.rule_coverage?.[0]?.missing_capabilities.push("approvals");
  assert.deepEqual(report, before);
  assert.equal(projectReportPrivacy(report, "raw"), report);
});

test("legacy reports without coverage retain reporter bytes and skip fallback", () => {
  const absent = outputReport(false);
  const explicitUndefined = outputReport(false);
  Object.defineProperty(explicitUndefined, "rule_coverage", {
    value: undefined,
    enumerable: true,
  });

  assert.equal(
    renderJsonReport(absent),
    `${JSON.stringify(absent, null, 2)}\n`,
  );
  assert.equal(renderJsonReport(explicitUndefined), renderJsonReport(absent));
  assert.equal(
    renderTtyReport(explicitUndefined, { color: false }),
    renderTtyReport(absent, { color: false }),
  );
  assert.equal(renderMarkdownReport(explicitUndefined), renderMarkdownReport(absent));
  assert.match(
    renderTtyReport(absent, { color: false }),
    /Skipped rules \(source lacks required data\): R007 \(token_usage\)/u,
  );

  const strict = projectReportPrivacy(absent, "strict");
  const balanced = projectReportPrivacy(absent, "balanced");
  assert.deepEqual(strict, balanced);
  for (const projected of [strict, balanced]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(projected, "rule_coverage"),
      false,
    );
    assert.deepEqual(Object.keys(projected), [
      "version",
      "unit",
      "summary",
      "findings",
      "caveats",
      "skipped_rules",
    ]);
  }
});

test("legacy stored analysis without coverage remains readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-capability-legacy-"));
  try {
    const repo = await repository(root);
    const sourceSession = await fixtureSession(root, repo);
    const legacyRecord = (await analyzeSessions(root, repo, [sourceSession])).record;
    const storePaths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "legacy-data") },
    });
    await mkdir(storePaths.analyses_dir, { recursive: true });
    await writeFile(
      join(storePaths.analyses_dir, `${legacyRecord.analysis_id}.json`),
      `${JSON.stringify(legacyRecord, null, 2)}\n`,
    );

    const loaded = await loadAnalyses(storePaths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.records, [legacyRecord]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(loaded.records[0], "rule_coverage"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function persistedPolicyDigest(
  root: string,
  repo: string,
  sourceSession: Session,
  dataDirectory: string,
): Promise<string> {
  const storePaths = await resolveStorePaths(repo, {
    env: { CCPROF_DATA_DIR: join(root, dataDirectory) },
  });
  const result = await analyze({
    cwd: repo,
    pr: "main...feature",
    sinceMs: NOW_MS - 2 * 60 * 60_000,
    nowMs: NOW_MS,
    sessionSource: { discover: async () => [sourceSession] },
    storePaths,
  });
  const database = openStoreDatabase(storePaths);
  try {
    const row = database.prepare(`SELECT s.record_json
      FROM analysis_executions e JOIN analysis_snapshots s USING (snapshot_id)
      WHERE e.execution_id = ?`).get(result.record.analysis_id) as
      { record_json: string } | undefined;
    assert.ok(row);
    const envelope = JSON.parse(row.record_json) as {
      identity: { policy_digest?: unknown };
    };
    assert.match(String(envelope.identity.policy_digest), /^[0-9a-f]{64}$/u);
    return String(envelope.identity.policy_digest);
  } finally {
    database.close();
  }
}

test("snapshot policy digest changes with capability coverage and truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-capability-snapshot-"));
  try {
    const repo = await repository(root);
    const full = await fixtureSession(root, repo);
    const partial = relabelSession(
      full,
      full.session_id,
      full.source,
      ["tool_timestamps"],
    );
    const truncated: Session = {
      ...full,
      warnings: [{
        code: "parser_line_budget_exceeded",
        message: "SECRET parser text",
        source_path: "/private/SECRET-session.jsonl",
      }],
    };
    const [fullDigest, partialDigest, truncatedDigest] = await Promise.all([
      persistedPolicyDigest(root, repo, full, "data-full"),
      persistedPolicyDigest(root, repo, partial, "data-partial"),
      persistedPolicyDigest(root, repo, truncated, "data-truncated"),
    ]);

    assert.notEqual(partialDigest, fullDigest);
    assert.notEqual(truncatedDigest, fullDigest);
    assert.notEqual(truncatedDigest, partialDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
