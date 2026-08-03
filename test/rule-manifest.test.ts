import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CliUsageError,
  parseCliArgs,
  runCli,
  USAGE,
  type CliHandlers,
} from "../src/cli.js";
import {
  ALL_SESSION_CAPABILITIES,
  findingCompatibilityMetadata,
  hasValidFindingCompatibilityMetadata,
  type Finding,
  type ReportV2,
  type RuleId,
} from "../src/core/model.js";
import { renderJsonReport } from "../src/reporters/json.js";
import { projectReportPrivacy } from "../src/reporters/privacy.js";
import { RULE_REQUIRED_CAPABILITIES } from "../src/rules/capabilities.js";
import {
  listRuleManifests,
  ruleManifest,
  RuleManifestValidationError,
  type RuleManifest,
  validateRuleManifestCatalog,
  withRuleManifest,
} from "../src/rules/manifest.js";
import {
  findingKey,
  findingKeyForCompatibility,
} from "../src/rules/shared.js";
import { analysisDigest, makeAnalysisRecord } from "../src/store/analyses.js";
import { applyDismissals } from "../src/store/dismissals.js";

const SOURCES = ["claude", "codex"] as const;

const EXPECTED: RuleManifest[] = [
  {
    id: "R001",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: ["edit_fragments"],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "union",
    evidence_schema: "ccprof://rules/R001/evidence/v1",
    policy_risk: "medium",
  },
  {
    id: "R002",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "union",
    evidence_schema: "ccprof://rules/R002/evidence/v1",
    policy_risk: "low",
  },
  {
    id: "R003",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "union",
    evidence_schema: "ccprof://rules/R003/evidence/v1",
    policy_risk: "low",
  },
  {
    id: "R004",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "policy_latency",
    default_mode: "observe_only",
    aggregation_policy: "never_aggregate",
    evidence_schema: "ccprof://rules/R004/evidence/v1",
    policy_risk: "high",
  },
  {
    id: "R005",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: ["tool_timestamps"],
    supported_sources: [...SOURCES],
    impact_kind: "resource_cost",
    default_mode: "enabled",
    aggregation_policy: "max",
    evidence_schema: "ccprof://rules/R005/evidence/v1",
    policy_risk: "medium",
  },
  {
    id: "R006",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "resource_cost",
    default_mode: "enabled",
    aggregation_policy: "max",
    evidence_schema: "ccprof://rules/R006/evidence/v1",
    policy_risk: "medium",
  },
  {
    id: "R007",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: ["token_usage"],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "max",
    evidence_schema: "ccprof://rules/R007/evidence/v1",
    policy_risk: "low",
  },
  {
    id: "R008",
    version: "1.0.0",
    compatibility_epoch: 1,
    required_capabilities: [],
    supported_sources: [...SOURCES],
    impact_kind: "critical_path_latency",
    default_mode: "enabled",
    aggregation_policy: "union",
    evidence_schema: "ccprof://rules/R008/evidence/v1",
    policy_risk: "medium",
  },
];

const FIELDS = [
  "id",
  "version",
  "compatibility_epoch",
  "required_capabilities",
  "supported_sources",
  "impact_kind",
  "default_mode",
  "aggregation_policy",
  "evidence_schema",
  "policy_risk",
];

function catalog(): Array<Record<string, unknown>> {
  return structuredClone(EXPECTED) as unknown as Array<Record<string, unknown>>;
}

function invalid(
  mutate: (value: Array<Record<string, unknown>>) => void,
): unknown {
  const value = catalog();
  mutate(value);
  return value;
}

function manifestError(
  value: unknown,
  code: string,
  index?: number,
  field?: string,
): void {
  assert.throws(
    () => validateRuleManifestCatalog(value),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const failure = error as Error & {
        code?: unknown;
        index?: unknown;
        field?: unknown;
      };
      assert.equal(failure.constructor, RuleManifestValidationError);
      assert.equal(failure.code, code);
      assert.equal(failure.index, index);
      assert.equal(failure.field, field);
      assert.match(failure.message, /invalid rule manifest/u);
      return true;
    },
  );
}

function finding(ruleId: RuleId = "R001", target = "npm test"): Finding {
  return {
    finding_key: findingKey(ruleId, target),
    rule_id: ruleId,
    title: "Repeated test command",
    target,
    classification: "behavior",
    cause: null,
    scope: "this_pr",
    confidence: "high",
    evidence: {
      session_refs: ["session-private"],
      interval_ids: ["interval-private"],
    },
    recoverable: { min: 1, bound: "point" },
    fix_recipe: { suggestion: "Run the focused test", verify: "npm test" },
    caveats: [],
  };
}

function reportWith(oneFinding: Finding): ReportV2 {
  return {
    version: 2,
    unit: { repo: "/private/repository", pr_ref: "feature/private", sessions: ["session-private"] },
    summary: {
      measured_min: 1,
      idle_excluded_min: 0,
      estimated_floor_min: 1,
      recoverable_min: 1,
      human_wait_min: 0,
      unexplained_min: 0,
      baseline: null,
    },
    findings: [oneFinding],
    caveats: [],
  };
}

const FORBIDDEN_HANDLERS = new Proxy({} as CliHandlers, {
  get() { throw new Error("rules CLI must not invoke command handlers"); },
});

test("the built-in manifest registers the exact R001-R008 contracts", () => {
  const manifests = listRuleManifests();
  assert.deepEqual(manifests, EXPECTED);
  assert.deepEqual(manifests.map(({ id }) => id), [
    "R001", "R002", "R003", "R004", "R005", "R006", "R007", "R008",
  ]);
  for (const manifest of manifests) {
    assert.deepEqual(Object.keys(manifest), FIELDS);
    assert.deepEqual(ruleManifest(manifest.id), manifest);
  }
});

test("manifest list, lookup, and validator results cannot mutate the registry", () => {
  const first = listRuleManifests();
  first.reverse();
  first[0]?.required_capabilities.push("approvals");
  first[0]?.supported_sources.reverse();
  const selected = ruleManifest("R001");
  selected.required_capabilities.length = 0;
  const validated = validateRuleManifestCatalog([...EXPECTED].reverse());
  validated[0]?.required_capabilities.push("approvals");

  assert.deepEqual(listRuleManifests(), EXPECTED);
  assert.deepEqual(ruleManifest("R001"), EXPECTED[0]);
  assert.deepEqual(
    validateRuleManifestCatalog([...EXPECTED].reverse()),
    EXPECTED,
  );
});

test("manifest validation fails closed with actionable deterministic codes", () => {
  manifestError({}, "invalid_catalog");
  manifestError(invalid((value) => { value[0] = null as never; }), "invalid_entry", 0);
  manifestError(invalid((value) => { delete value[0]?.version; }), "missing_field", 0, "version");
  manifestError(invalid((value) => { value[0]!.extra = true; }), "unknown_field", 0, "extra");
  manifestError(invalid((value) => { value[1]!.id = " r001 "; }), "duplicate_id", 1, "id");
  manifestError(invalid((value) => { value[0]!.id = " r001 "; }), "invalid_rule_id", 0, "id");
  manifestError(invalid((value) => { value[0]!.id = "R999"; }), "unknown_rule_id", 0, "id");
  manifestError(EXPECTED.slice(0, -1), "missing_rule_id", undefined, "R008");
  manifestError(invalid((value) => { value[0]!.version = "01.0.0"; }), "invalid_version", 0, "version");
  manifestError(invalid((value) => { value[0]!.compatibility_epoch = 0; }), "invalid_epoch", 0, "compatibility_epoch");
  manifestError(invalid((value) => { value[0]!.version = "2.0.0"; }), "version_epoch_mismatch", 0, "compatibility_epoch");
  manifestError(invalid((value) => { value[0]!.required_capabilities = ["unknown"]; }), "invalid_capability", 0, "required_capabilities");
  manifestError(invalid((value) => { value[0]!.required_capabilities = ["approvals", "edit_fragments"]; }), "invalid_capability", 0, "required_capabilities");
  manifestError(invalid((value) => { value[0]!.supported_sources = ["other"]; }), "invalid_source", 0, "supported_sources");
  manifestError(invalid((value) => { value[0]!.supported_sources = ["codex", "claude"]; }), "invalid_source", 0, "supported_sources");
  manifestError(invalid((value) => { value[0]!.impact_kind = "time"; }), "invalid_impact_kind", 0, "impact_kind");
  manifestError(invalid((value) => { value[0]!.default_mode = "on"; }), "invalid_mode", 0, "default_mode");
  manifestError(invalid((value) => { value[0]!.aggregation_policy = "average"; }), "invalid_aggregation_policy", 0, "aggregation_policy");
  manifestError(invalid((value) => { value[0]!.evidence_schema = "R001"; }), "invalid_evidence_schema", 0, "evidence_schema");
  manifestError(invalid((value) => { value[0]!.policy_risk = "critical"; }), "invalid_policy_risk", 0, "policy_risk");
});

test("manifest validation rejects valid-looking deviations from every rule contract", () => {
  for (const [index, expected] of EXPECTED.entries()) {
    manifestError(invalid((value) => {
      value[index]!.supported_sources = [];
    }), "invalid_source", index, "supported_sources");
    manifestError(invalid((value) => {
      value[index]!.impact_kind = "evidence_only";
    }), "invalid_impact_kind", index, "impact_kind");
    manifestError(invalid((value) => {
      value[index]!.default_mode = "disabled";
    }), "invalid_mode", index, "default_mode");
    manifestError(invalid((value) => {
      value[index]!.aggregation_policy = "sum";
    }), "invalid_aggregation_policy", index, "aggregation_policy");
    manifestError(invalid((value) => {
      value[index]!.policy_risk = expected.policy_risk === "high" ? "low" : "high";
    }), "invalid_policy_risk", index, "policy_risk");
  }
});

test("manifest validation snapshots accessor-backed inputs before returning them", () => {
  const value = catalog();
  let reads = 0;
  Object.defineProperty(value[0]!, "supported_sources", {
    configurable: true,
    enumerable: true,
    get: () => reads++ === 0 ? ["claude", "codex"] : [],
  });

  assert.deepEqual(validateRuleManifestCatalog(value), EXPECTED);
});

test("the capability compatibility map is derived exactly from manifests", () => {
  assert.deepEqual(
    RULE_REQUIRED_CAPABILITIES,
    Object.fromEntries(EXPECTED.map((entry) => [
      entry.id,
      entry.required_capabilities,
    ])),
  );
  assert.ok(Object.isFrozen(RULE_REQUIRED_CAPABILITIES));
  for (const capabilities of Object.values(RULE_REQUIRED_CAPABILITIES)) {
    assert.ok(Object.isFrozen(capabilities));
  }
  assert.deepEqual(
    [...new Set(Object.values(RULE_REQUIRED_CAPABILITIES).flat())].sort(),
    ["edit_fragments", "token_usage", "tool_timestamps"],
  );
  assert.ok(
    Object.values(RULE_REQUIRED_CAPABILITIES).flat().every((capability) =>
      ALL_SESSION_CAPABILITIES.includes(capability)
    ),
  );
});

test("epoch one preserves legacy finding keys while later epochs isolate series", () => {
  const target = "npm test";
  const legacy = createHash("sha256")
    .update(`R002\0${target}`)
    .digest("hex");
  assert.equal(findingKey("R002", target), legacy);
  assert.equal(findingKeyForCompatibility("R002", target, 1), legacy);
  assert.notEqual(findingKeyForCompatibility("R002", target, 2), legacy);
  assert.equal(
    findingKeyForCompatibility("R002", target, 2),
    findingKeyForCompatibility("R002", `  ${target}  `, 2),
  );
  assert.throws(
    () => findingKeyForCompatibility("R002", target, 0),
    /compatibility epoch must be a positive safe integer/u,
  );
});

test("new findings publish manifest compatibility metadata without mutating inputs", () => {
  for (const manifest of EXPECTED) {
    const input = finding(manifest.id);
    const before = structuredClone(input);
    const decorated = withRuleManifest(input);

    assert.notEqual(decorated, input);
    assert.deepEqual(input, before);
    assert.equal(decorated.rule_version, manifest.version);
    assert.equal(decorated.compatibility_epoch, manifest.compatibility_epoch);
  }
});

test("Store records preserve new metadata and legacy findings remain readable", () => {
  const legacy = finding("R002");
  const decorated = withRuleManifest(finding("R001"));
  const common = {
    created_at_ms: 1,
    unit: { repo: "repo-id", pr_ref: "pr-ref", sessions: ["session-id"] },
    summary: reportWith(legacy).summary,
  };
  const current = makeAnalysisRecord({ ...common, findings: [decorated] });
  const old = makeAnalysisRecord({ ...common, findings: [legacy] });

  assert.equal(current.findings[0]?.rule_version, "1.0.0");
  assert.equal(current.findings[0]?.compatibility_epoch, 1);
  assert.deepEqual(old.findings[0], legacy);
  assert.equal(Object.hasOwn(old.findings[0] ?? {}, "rule_version"), false);
  assert.equal(Object.hasOwn(old.findings[0] ?? {}, "compatibility_epoch"), false);
});

test("Report v2 privacy keeps static metadata and never invents it for legacy findings", () => {
  const legacyReport = reportWith(finding("R002"));
  const legacyJson = JSON.parse(renderJsonReport(legacyReport)) as ReportV2;
  for (const report of [
    legacyJson,
    projectReportPrivacy(legacyReport, "strict"),
    projectReportPrivacy(legacyReport, "balanced"),
  ]) {
    assert.equal(Object.hasOwn(report.findings[0] ?? {}, "rule_version"), false);
    assert.equal(Object.hasOwn(report.findings[0] ?? {}, "compatibility_epoch"), false);
  }

  const currentReport = reportWith(withRuleManifest(finding("R001")));
  for (const profile of ["strict", "balanced"] as const) {
    const projected = projectReportPrivacy(currentReport, profile);
    assert.equal(projected.findings[0]?.rule_version, "1.0.0");
    assert.equal(projected.findings[0]?.compatibility_epoch, 1);
    assert.doesNotMatch(JSON.stringify(projected), /session-private|\/private\/repository/u);
  }
  assert.equal(projectReportPrivacy(currentReport, "raw"), currentReport);
});

test("stored and private compatibility metadata accepts only a canonical complete pair", () => {
  assert.deepEqual(findingCompatibilityMetadata({}), { valid: true });
  assert.deepEqual(findingCompatibilityMetadata({
    rule_version: "1.0.0",
    compatibility_epoch: 1,
  }), {
    valid: true,
    metadata: { rule_version: "1.0.0", compatibility_epoch: 1 },
  });
  assert.equal(hasValidFindingCompatibilityMetadata({}), true);
  assert.equal(hasValidFindingCompatibilityMetadata({
    rule_version: "1.0.0",
    compatibility_epoch: 1,
  }), true);
  for (const invalid of [
    { rule_version: "1.0.0" },
    { compatibility_epoch: 1 },
    { rule_version: "01.0.0", compatibility_epoch: 1 },
    { rule_version: "2.0.0", compatibility_epoch: 1 },
    { rule_version: "/private/repository/token-secret", compatibility_epoch: 1 },
    { rule_version: "1.0.0", compatibility_epoch: 0 },
  ]) {
    assert.equal(hasValidFindingCompatibilityMetadata(invalid), false);
  }

  const unsafe = reportWith({
    ...finding("R001"),
    rule_version: "/private/repository/token-secret",
    compatibility_epoch: 1,
  });
  const strict = projectReportPrivacy(unsafe, "strict");
  assert.equal(Object.hasOwn(strict.findings[0] ?? {}, "rule_version"), false);
  assert.equal(Object.hasOwn(strict.findings[0] ?? {}, "compatibility_epoch"), false);
  assert.doesNotMatch(JSON.stringify(strict), /token-secret|\/private\/repository/u);

  let changingReads = 0;
  const changing: Record<string, unknown> = { compatibility_epoch: 1 };
  Object.defineProperty(changing, "rule_version", {
    enumerable: true,
    get: () => changingReads++ === 0 ? "1.0.0" : "token-secret",
  });
  assert.equal(hasValidFindingCompatibilityMetadata(changing), false);
  assert.equal(changingReads, 0);

  let throwingReads = 0;
  const throwing: Record<string, unknown> = { compatibility_epoch: 1 };
  Object.defineProperty(throwing, "rule_version", {
    enumerable: true,
    get() {
      throwingReads += 1;
      throw new Error("metadata getter must not run");
    },
  });
  assert.equal(hasValidFindingCompatibilityMetadata(throwing), false);
  assert.equal(throwingReads, 0);

  const accessorFinding = finding("R001");
  Object.defineProperties(accessorFinding, {
    rule_version: {
      enumerable: false,
      get() { throw new Error("private metadata getter must not run"); },
    },
    compatibility_epoch: { enumerable: false, value: 1 },
  });
  const accessorStrict = projectReportPrivacy(reportWith(accessorFinding), "strict");
  assert.equal(Object.hasOwn(accessorStrict.findings[0] ?? {}, "rule_version"), false);
  assert.equal(Object.hasOwn(accessorStrict.findings[0] ?? {}, "compatibility_epoch"), false);

  let metadataGets = 0;
  const lyingFinding = new Proxy(finding("R001"), {
    get(target, property, receiver) {
      if (property === "rule_version" || property === "compatibility_epoch") {
        metadataGets += 1;
        return property === "rule_version" ? "token-secret" : 99;
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === "rule_version") {
        return { configurable: true, enumerable: false, value: "1.0.0" };
      }
      if (property === "compatibility_epoch") {
        return { configurable: true, enumerable: false, value: 1 };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  for (const profile of ["strict", "balanced"] as const) {
    const projected = projectReportPrivacy(reportWith(lyingFinding), profile);
    assert.equal(projected.findings[0]?.rule_version, "1.0.0");
    assert.equal(projected.findings[0]?.compatibility_epoch, 1);
    assert.doesNotMatch(JSON.stringify(projected), /token-secret/u);
  }
  assert.equal(metadataGets, 0);

  const throwingDescriptor = new Proxy(finding("R001"), {
    getOwnPropertyDescriptor(target, property) {
      if (property === "rule_version" || property === "compatibility_epoch") {
        throw new Error("token-secret descriptor trap");
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  assert.deepEqual(findingCompatibilityMetadata(throwingDescriptor), { valid: false });
  for (const profile of ["strict", "balanced"] as const) {
    const projected = projectReportPrivacy(reportWith(throwingDescriptor), profile);
    assert.equal(Object.hasOwn(projected.findings[0] ?? {}, "rule_version"), false);
    assert.equal(Object.hasOwn(projected.findings[0] ?? {}, "compatibility_epoch"), false);
    assert.doesNotMatch(JSON.stringify(projected), /token-secret/u);
  }
});

test("a compatibility epoch change isolates dismissal and adoption identities", () => {
  const target = "npm test";
  const epochOne = findingKeyForCompatibility("R002", target, 1);
  const epochTwo = findingKeyForCompatibility("R002", target, 2);
  const futureFinding: Finding = {
    ...finding("R002", target),
    finding_key: epochTwo,
    rule_version: "2.0.0",
    compatibility_epoch: 2,
  };
  const dismissal = {
    schema_version: 1 as const,
    finding_key: epochOne,
    target,
    dismissed_at_ms: 10,
    strength_min: 1,
  };

  assert.deepEqual(applyDismissals([futureFinding], [dismissal], 11), {
    findings: [futureFinding],
    suppressed_keys: [],
  });
  assert.deepEqual(applyDismissals([
    { ...futureFinding, finding_key: epochOne },
  ], [dismissal], 11).suppressed_keys, [epochOne]);
  assert.equal(new Set([epochOne, epochTwo]).size, 2);
});

test("the ordered manifest contract materially contributes to policy identity", () => {
  const policy = {
    fingerprint: "ccprof-rule-policy-2026-08-04-v2",
    rule_coverage: [],
    skipped_rules: [],
    rule_manifest: listRuleManifests(),
  };
  const changed = structuredClone(policy);
  changed.rule_manifest[0]!.version = "1.0.1";

  assert.deepEqual(policy.rule_manifest.map(({ id }) => id), EXPECTED.map(({ id }) => id));
  assert.equal(
    analysisDigest("analysis-policy-v1", policy),
    analysisDigest("analysis-policy-v1", structuredClone(policy)),
  );
  assert.notEqual(
    analysisDigest("analysis-policy-v1", policy),
    analysisDigest("analysis-policy-v1", changed),
  );
});

test("rules CLI parsing accepts only list and canonical explain commands", () => {
  assert.deepEqual(parseCliArgs(["rules", "list"]), {
    kind: "rules",
    action: "list",
  });
  assert.deepEqual(parseCliArgs(["rules", "explain", "R004"]), {
    kind: "rules",
    action: "explain",
    ruleId: "R004",
  });
  for (const args of [
    ["rules"],
    ["rules", "delete"],
    ["rules", "list", "extra"],
    ["rules", "explain"],
    ["rules", "explain", "R004", "extra"],
    ["rules", "explain", "r004"],
    ["rules", "explain", "R999"],
    ["rules", "list", "--help"],
    ["rules", "explain", "R004", "--version"],
  ]) {
    assert.throws(() => parseCliArgs(args), CliUsageError, args.join(" "));
  }
  assert.match(USAGE, /ccprof rules list/u);
  assert.match(USAGE, /ccprof rules explain <rule-id>/u);
});

test("rules CLI emits deterministic pretty JSON without handlers or private state", async () => {
  const scenarios = [
    { args: ["rules", "list"], expected: EXPECTED },
    { args: ["rules", "explain", "R004"], expected: EXPECTED[3] },
  ] as const;
  for (const { args, expected } of scenarios) {
    for (const stdoutIsTTY of [false, true]) {
      let stdout = "";
      let stderr = "";
      const code = await runCli(args, {
        cwd: "/private/repository/token-secret",
        ci: false,
        handlers: FORBIDDEN_HANDLERS,
        stdoutIsTTY,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });
      assert.equal(code, 0);
      assert.equal(stdout, `${JSON.stringify(expected, null, 2)}\n`);
      assert.equal(stderr, "");
      assert.doesNotMatch(stdout, /private|session|token-secret/u);
    }
  }
});

test("rules CLI rejects unknown input with actionable sanitized usage", async () => {
  for (const args of [
    ["rules", "explain", "R999"],
    ["rules", "explain", "/private/repository/token-secret"],
    ["rules", "delete"],
    ["rules", "list", "extra"],
    ["rules", "list", "--help"],
  ]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      cwd: "/private/repository/token-secret",
      ci: false,
      handlers: FORBIDDEN_HANDLERS,
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    assert.equal(code, 2, args.join(" "));
    assert.equal(stdout, "");
    assert.match(stderr, /^ccprof: .+\nUsage: ccprof/u);
    assert.doesNotMatch(stderr, /\/private\/repository|token-secret/u);
  }
  let unknown = "";
  await runCli(["rules", "explain", "R999"], {
    handlers: FORBIDDEN_HANDLERS,
    stdout: () => undefined,
    stderr: (value) => { unknown += value; },
  });
  assert.match(unknown, /unknown rule id; expected R001.*R008/u);
  assert.doesNotMatch(unknown, /R999/u);
});

test("unknown rule lookup fails without a partial result", () => {
  const messages = [
    "R999",
    "/private/repository/token-secret",
    "ghp_token-secret",
  ].map((id) => {
    try {
      ruleManifest(id);
      assert.fail("unknown rule lookup must throw");
    } catch (error) {
      assert.ok(error instanceof Error);
      return error.message;
    }
  });
  assert.ok(messages.every((message) => message === messages[0]));
  assert.match(messages[0] ?? "", /unknown rule id; expected R001.*R008/u);
  assert.doesNotMatch(messages[0] ?? "", /R999|private|token-secret/u);
});
