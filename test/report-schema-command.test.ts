import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import {
  CliUsageError,
  parseCliArgs,
  runCli,
  type CliRuntime,
  USAGE,
} from "../src/cli.js";
import type { ReportV2 } from "../src/core/model.js";
import { renderJsonReport } from "../src/reporters/json.js";

type JsonObject = Record<string, unknown>;
type SchemaRuntime = CliRuntime & {
  readReportV3Schema?: () => string;
};

const REPORT_V3_REQUIRED = [
  "schema_version",
  "producer",
  "analysis",
  "work_unit",
  "window",
  "sources",
  "policy",
  "summary",
  "findings",
  "rule_coverage",
  "diagnostics",
];

const FINDING_REQUIRED = [
  "finding_id",
  "finding_key",
  "rule",
  "classification",
  "scope",
  "impact",
  "confidence",
  "evidence",
  "recipe",
];

const RUNTIME_CONSTRAINTS = [
  "window.started_at_ms <= window.ended_at_ms <= analysis.created_at_ms.",
  "For each finding, impact.lower_ms <= impact.upper_ms, and optional impact.expected_ms lies inclusively between them.",
  "findings.returned === findings.items.length, findings.total >= findings.returned, and findings.truncated is true if and only if fewer than total findings are returned.",
  "finding_id values are unique within a report. Their instance-identity derivation is distinct from the stable recurrence semantics of finding_key.",
  "A rule's compatibility_epoch equals the major component of its SemVer version.",
  "producer.ruleset_version is a real calendar date and identifies the effective manifest set used by the report.",
  "Coverage entries are unique and canonical by rule_id, contain exactly the rules selected by the effective manifest, and obey eligible_sessions <= total_sessions.",
  "Coverage is full exactly when eligible equals total; completeness is 1 for 0/0, otherwise eligible divided by total; missing capabilities are the canonical sorted unique runtime projection; truncation reflects the actual analysis window and admitted evidence.",
  "Per-source files_parsed <= files_discovered and rows_accepted <= rows_seen; all source coverage is measured rather than synthesized.",
  "confirmed_recoverable_ms <= possible_recoverable_upper_ms <= measured_ms.",
  "Analysis/snapshot/digest identities use their documented canonical runtime derivations, and logical repository identity, build SHA, Git OIDs, and source coverage come from authoritative inputs. Missing values make Report v3 emission unavailable; path hashes, all-zero values, empty sentinels, and other fabricated substitutes are forbidden.",
];

function jsonObject(value: unknown, label: string): JsonObject {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonObject;
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(
    Array.isArray(value) && value.every((item) => typeof item === "string"),
    `${label} must be a string array`,
  );
  return value as string[];
}

function dereference(root: JsonObject, value: unknown): JsonObject {
  let current = jsonObject(value, "schema node");
  const seen = new Set<string>();
  while (typeof current.$ref === "string") {
    const reference = current.$ref;
    assert.match(reference, /^#\//u);
    assert.ok(!seen.has(reference), `cyclic direct reference: ${reference}`);
    seen.add(reference);
    let target: unknown = root;
    for (const segment of reference.slice(2).split("/")) {
      target = jsonObject(target, reference)[
        segment.replaceAll("~1", "/").replaceAll("~0", "~")
      ];
    }
    current = jsonObject(target, reference);
  }
  return current;
}

function property(
  root: JsonObject,
  parent: JsonObject,
  name: string,
): JsonObject {
  const properties = jsonObject(parent.properties, "properties");
  return dereference(root, properties[name]);
}

function assertClosedObjects(value: unknown, path = "#"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClosedObjects(item, `${path}/${index}`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const node = value as JsonObject;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes("object")) {
    assert.equal(
      node.additionalProperties,
      false,
      `${path} must reject undeclared object keys`,
    );
  }
  for (const [key, child] of Object.entries(node)) {
    assertClosedObjects(child, `${path}/${key}`);
  }
}

function reportV3Fixture(): JsonObject {
  return {
    schema_version: 3,
    producer: {
      name: "ccprof",
      version: "1.0.0",
      build_sha: "a".repeat(40),
      ruleset_version: "2026-08-04",
    },
    analysis: {
      analysis_id: "analysis",
      snapshot_id: "snapshot",
      created_at_ms: 2,
      deterministic_digest: `sha256:${"a".repeat(64)}`,
    },
    work_unit: {
      repository_id: "repository",
      pr_ref: "main...head",
      base_oid: "a".repeat(40),
      head_oid: "b".repeat(40),
      merge_base_oid: "c".repeat(40),
      workspace_ids: [],
    },
    window: {
      started_at_ms: 0,
      ended_at_ms: 1,
      start_source: "explicit",
      end_source: "analysis_time",
      completeness: "complete",
    },
    sources: [{
      adapter_id: "claude",
      adapter_version: "1.0.0",
      schema_fingerprint: `sha256:${"d".repeat(64)}`,
      capabilities: [],
      coverage: {
        files_discovered: 0,
        files_parsed: 0,
        rows_seen: 0,
        rows_accepted: 0,
        events_emitted: 0,
      },
    }],
    policy: {
      schema_version: 1,
      digest: `sha256:${"e".repeat(64)}`,
      privacy_profile: "strict",
    },
    summary: {
      critical_path: {
        measured_ms: 0,
        confirmed_recoverable_ms: 0,
        possible_recoverable_upper_ms: 0,
        human_wait_ms: 0,
        unexplained_ms: 0,
      },
      resource_cost: {
        tool_runtime_ms: 0,
        estimated_input_tokens: 0,
        estimated_output_tokens: 0,
      },
    },
    findings: {
      total: 1,
      returned: 1,
      truncated: false,
      items: [{
        finding_id: "finding-id",
        finding_key: "finding-key",
        rule: { id: "R001", version: "1.0.0", compatibility_epoch: 1 },
        classification: "classification",
        scope: "this_pr",
        impact: { kind: "critical_path_latency", lower_ms: 0, upper_ms: 0 },
        confidence: { evidence: "high", causal: "high", source_completeness: 1 },
        evidence: {},
        recipe: {
          kind: "proposal",
          trust: "untrusted",
          suggestion: "suggestion",
          verification: null,
        },
      }],
    },
    rule_coverage: [{
      rule_id: "R001",
      eligible_sessions: 0,
      total_sessions: 0,
      status: "full",
      missing_capabilities: [],
      completeness: 1,
      truncated: false,
    }],
    diagnostics: { warning_counts: {} },
  };
}

function fixtureSource(report: JsonObject): JsonObject {
  return jsonObject((report.sources as unknown[])[0], "fixture source");
}

function fixtureFinding(report: JsonObject): JsonObject {
  const findings = jsonObject(report.findings, "fixture findings");
  return jsonObject((findings.items as unknown[])[0], "fixture finding");
}

function fixtureCoverage(report: JsonObject): JsonObject {
  return jsonObject((report.rule_coverage as unknown[])[0], "fixture coverage");
}

async function capture(
  args: readonly string[],
  overrides: Omit<SchemaRuntime, "stdout" | "stderr"> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const runtime: SchemaRuntime = {
    ...overrides,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  };
  const code = await runCli(args, runtime);
  return { code, stdout, stderr };
}

test("schema command accepts only report-v3 and preserves help precedence", async () => {
  assert.deepEqual(parseCliArgs(["schema", "report-v3"]), {
    kind: "schema",
    target: "report-v3",
  });

  const invalid = [
    ["schema"],
    ["schema", "report-v2"],
    ["schema", "report-v3", "report-v3"],
    ["schema", "report-v3", "extra"],
    ["schema", "report-v3", "--json"],
    ["schema", "report-v3", "--version"],
    ["schema", "--version"],
  ];
  for (const args of invalid) {
    assert.throws(() => parseCliArgs(args), CliUsageError, args.join(" "));
    let reads = 0;
    const result = await capture(args, {
      readReportV3Schema: () => {
        reads += 1;
        return "{}";
      },
    });
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.equal(reads, 0, args.join(" "));
    assert.match(result.stderr, /^ccprof:/u, args.join(" "));
    assert.match(result.stderr, /Usage: ccprof/u, args.join(" "));
  }

  for (const args of [
    ["schema", "--help"],
    ["schema", "report-v2", "-h"],
    ["schema", "report-v3", "--help"],
  ]) {
    assert.deepEqual(parseCliArgs(args), { kind: "help" }, args.join(" "));
    const result = await capture(args);
    assert.deepEqual(result, { code: 0, stdout: USAGE, stderr: "" });
  }
});

test("schema command is static and canonicalizes output before writing", async () => {
  let stdout = "";
  let stderr = "";
  let reads = 0;
  const runtime = {
    readReportV3Schema: () => {
      reads += 1;
      return ` { "z": 1, "properties": { "schema_version": { "const": 3 } } }\n\n`;
    },
    stdout: (value: string) => {
      stdout += value;
    },
    stderr: (value: string) => {
      stderr += value;
    },
  } as SchemaRuntime;
  for (const key of [
    "cwd",
    "ci",
    "handlers",
    "loadOrganizationPolicy",
  ] as const) {
    Object.defineProperty(runtime, key, {
      get(): never {
        throw new Error(`schema command touched ${key}`);
      },
    });
  }

  assert.equal(await runCli(["schema", "report-v3"], runtime), 0);
  assert.equal(await runCli(["schema", "report-v3"], runtime), 0);
  const once = `{
  "z": 1,
  "properties": {
    "schema_version": {
      "const": 3
    }
  }
}\n`;
  assert.equal(stdout, `${once}${once}`);
  assert.equal(stderr, "");
  assert.equal(reads, 2);
});

test("schema read and parse failures return 5 without partial stdout", async () => {
  const scenarios: Array<{ name: string; read: () => string }> = [
    {
      name: "missing",
      read: () => {
        throw new Error("PRIVATE_SCHEMA_PATH does not exist");
      },
    },
    { name: "malformed", read: () => `{ "PRIVATE_SCHEMA_VALUE":` },
    { name: "wrong contract", read: () => "{}" },
  ];

  for (const scenario of scenarios) {
    let reads = 0;
    const result = await capture(["schema", "report-v3"], {
      readReportV3Schema: () => {
        reads += 1;
        return scenario.read();
      },
    });
    assert.equal(result.code, 5, scenario.name);
    assert.equal(result.stdout, "", scenario.name);
    assert.equal(reads, 1, scenario.name);
    assert.match(result.stderr, /^ccprof:/u, scenario.name);
    assert.doesNotMatch(result.stderr, /PRIVATE_SCHEMA/u, scenario.name);
  }
});

test("published Report v3 schema is closed and carries the audited contract", async () => {
  const raw = await readFile(
    resolve(process.cwd(), "schemas/report-v3.schema.json"),
    "utf8",
  );
  const schema = jsonObject(JSON.parse(raw), "report v3 schema");

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(
    schema.$id,
    "https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/report-v3.schema.json",
  );
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(stringArray(schema.required, "root required"), REPORT_V3_REQUIRED);
  assert.equal(property(schema, schema, "schema_version").const, 3);
  assert.deepEqual(
    stringArray(schema["x-ccprof-runtime-constraints"], "runtime constraints"),
    RUNTIME_CONSTRAINTS,
  );
  assertClosedObjects(schema);

  const producer = property(schema, schema, "producer");
  const semver = property(schema, producer, "version");
  const gitOid = property(schema, producer, "build_sha");
  const analysis = property(schema, schema, "analysis");
  const sha256 = property(schema, analysis, "deterministic_digest");
  for (const [definition, accepted, rejected] of [
    [semver, "1.2.3-alpha.1+build.5", "01.2.3"],
    [gitOid, "a".repeat(40), "a".repeat(41)],
    [gitOid, "b".repeat(64), "B".repeat(64)],
    [sha256, `sha256:${"c".repeat(64)}`, "c".repeat(64)],
  ] as const) {
    const pattern = String(definition.pattern);
    assert.match(accepted, new RegExp(pattern, "u"));
    assert.doesNotMatch(rejected, new RegExp(pattern, "u"));
  }

  const findings = property(schema, schema, "findings");
  const items = jsonObject(findings.properties, "findings properties").items;
  const findingArray = dereference(schema, items);
  const finding = dereference(schema, findingArray.items);
  assert.deepEqual(stringArray(finding.required, "finding required"), FINDING_REQUIRED);

  const rule = property(schema, finding, "rule");
  assert.deepEqual(stringArray(rule.required, "rule required"), [
    "id",
    "version",
    "compatibility_epoch",
  ]);
  const epoch = property(schema, rule, "compatibility_epoch");
  assert.equal(epoch.type, "integer");
  assert.equal(epoch.minimum, 1);
  assert.equal(epoch.maximum, Number.MAX_SAFE_INTEGER);

  const impact = property(schema, finding, "impact");
  const lowerMs = property(schema, impact, "lower_ms");
  assert.equal(lowerMs.type, "integer");
  assert.equal(lowerMs.minimum, 0);
  assert.equal(lowerMs.maximum, Number.MAX_SAFE_INTEGER);
  const confidence = property(schema, finding, "confidence");
  const completeness = property(schema, confidence, "source_completeness");
  assert.equal(completeness.minimum, 0);
  assert.equal(completeness.maximum, 1);

  const sourceItems = dereference(
    schema,
    property(schema, schema, "sources").items,
  );
  assert.deepEqual(stringArray(sourceItems.required, "source required"), [
    "adapter_id",
    "adapter_version",
    "schema_fingerprint",
    "capabilities",
    "coverage",
  ]);
  const ruleCoverageItems = dereference(
    schema,
    property(schema, schema, "rule_coverage").items,
  );
  assert.deepEqual(stringArray(ruleCoverageItems.required, "coverage required"), [
    "rule_id",
    "eligible_sessions",
    "total_sessions",
    "status",
    "missing_capabilities",
    "completeness",
    "truncated",
  ]);
});

test("published Report v3 schema accepts canonical identities with legacy compatibility", async () => {
  const raw = await readFile(
    resolve(process.cwd(), "schemas/report-v3.schema.json"),
    "utf8",
  );
  const schema = jsonObject(JSON.parse(raw), "report v3 schema");
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  ajv.addKeyword("x-ccprof-runtime-constraints");
  const validate = ajv.compile(schema);
  const assertValid = (report: JsonObject, label: string): void => {
    assert.equal(validate(report), true, `${label}: ${JSON.stringify(validate.errors)}`);
  };
  const assertInvalid = (report: JsonObject, label: string): void => {
    assert.equal(validate(report), false, label);
  };

  assert.equal(
    schema.$id,
    "https://raw.githubusercontent.com/t09tanaka/ccprof/main/schemas/report-v3.schema.json",
  );
  assert.equal(property(schema, schema, "schema_version").const, 3);
  const findings = property(schema, schema, "findings");
  const finding = dereference(
    schema,
    dereference(
      schema,
      jsonObject(findings.properties, "findings properties").items,
    ).items,
  );
  assert.deepEqual(property(schema, finding, "scope").enum, [
    "this_pr",
    "separate_issue",
    "claude_md",
    "instruction_resource",
  ]);

  const source = dereference(schema, property(schema, schema, "sources").items);
  const sourceCapabilities = jsonObject(
    property(schema, source, "capabilities"),
    "source capabilities",
  );
  const coverage = dereference(
    schema,
    property(schema, schema, "rule_coverage").items,
  );
  const missingCapabilities = jsonObject(
    property(schema, coverage, "missing_capabilities"),
    "missing capabilities",
  );
  assert.equal(
    jsonObject(sourceCapabilities.items, "source capability items").$ref,
    "#/$defs/capability",
  );
  assert.equal(
    jsonObject(missingCapabilities.items, "missing capability items").$ref,
    "#/$defs/capability",
  );

  for (const scope of [
    "this_pr",
    "separate_issue",
    "claude_md",
    "instruction_resource",
  ]) {
    const report = reportV3Fixture();
    fixtureFinding(report).scope = scope;
    assertValid(report, `scope ${scope}`);
  }

  for (const adapterId of [
    "claude",
    "codex",
    "dummy-agent",
    "ccprof.dev/adapters/claude",
    "dev.example.agent/adapters/dummy-agent",
    "ccprof.dev/adapters/claude/v1",
  ]) {
    const report = reportV3Fixture();
    fixtureSource(report).adapter_id = adapterId;
    assertValid(report, `adapter ${adapterId}`);
  }

  const overlongAdapterId = `a.a/${Array.from(
    { length: 4 },
    () => "a".repeat(64),
  ).join("/")}`;
  for (const adapterId of [
    "CCprof.dev/adapters/claude",
    "ccprof.dev/adapters/Claude",
    "ccprof..dev/adapters/claude",
    "ccprof.dev//adapters/claude",
    "ccprof.dev/adapters/",
    overlongAdapterId,
  ]) {
    const report = reportV3Fixture();
    fixtureSource(report).adapter_id = adapterId;
    assertInvalid(report, `malformed adapter ${adapterId}`);
  }

  const legacyCapabilities = [
    "tool_timestamps",
    "token_usage",
    "sidechains",
    "branch_rows",
    "edit_fragments",
    "approvals",
  ];
  const canonicalCapabilities = [
    "ccprof.dev/capabilities/tool_timestamps",
    "dev.example.agent/capabilities/dummy-agent",
  ];
  for (const capabilities of [legacyCapabilities, canonicalCapabilities]) {
    for (const location of ["source", "coverage"] as const) {
      const report = reportV3Fixture();
      if (location === "source") {
        fixtureSource(report).capabilities = capabilities;
      } else {
        fixtureCoverage(report).missing_capabilities = capabilities;
      }
      assertValid(report, `${location} capabilities ${capabilities.join(",")}`);
    }
  }

  const overlongCapability = `a.a/capabilities/${"a".repeat(240)}`;
  for (const capability of [
    "unknown_capability",
    "CCprof.dev/capabilities/tool_timestamps",
    "ccprof.dev/capabilities/Tool_timestamps",
    "ccprof..dev/capabilities/tool_timestamps",
    "ccprof.dev//capabilities/tool_timestamps",
    "ccprof.dev/not-capabilities/tool_timestamps",
    "ccprof.dev/capabilities/",
    "ccprof.dev/capabilities/tool_timestamps/extra",
    overlongCapability,
  ]) {
    for (const location of ["source", "coverage"] as const) {
      const report = reportV3Fixture();
      if (location === "source") {
        fixtureSource(report).capabilities = [capability];
      } else {
        fixtureCoverage(report).missing_capabilities = [capability];
      }
      assertInvalid(report, `malformed ${location} capability ${capability}`);
    }
  }
});

test("built schema command works from an arbitrary cwd and a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-report-schema-"));
  try {
    const builtCli = resolve(process.cwd(), ".test-dist/src/cli.js");
    const linkedCli = join(root, "ccprof");
    await symlink(builtCli, linkedCli);

    const outputs: string[] = [];
    for (const executable of [builtCli, linkedCli]) {
      const result = spawnSync(
        process.execPath,
        [executable, "schema", "report-v3"],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /\n$/u);
      assert.doesNotMatch(result.stdout, /\n\n$/u);
      assert.equal(
        jsonObject(
          jsonObject(
            jsonObject(JSON.parse(result.stdout), "schema").properties,
            "schema properties",
          ).schema_version,
          "schema version",
        ).const,
        3,
      );
      outputs.push(result.stdout);
    }
    assert.equal(outputs[0], outputs[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishing the v3 schema does not switch Report v2 JSON", () => {
  const report: ReportV2 = {
    version: 2,
    unit: { repo: "/repo", pr_ref: "main...feature", sessions: [] },
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
  };
  assert.equal(
    renderJsonReport(report),
    `{
  "version": 2,
  "unit": {
    "repo": "/repo",
    "pr_ref": "main...feature",
    "sessions": []
  },
  "summary": {
    "measured_min": 0,
    "idle_excluded_min": 0,
    "estimated_floor_min": 0,
    "recoverable_min": 0,
    "human_wait_min": 0,
    "unexplained_min": 0,
    "baseline": null
  },
  "findings": [],
  "caveats": []
}\n`,
  );
});
