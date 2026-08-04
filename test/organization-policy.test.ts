import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
  loadRepositoryConfig,
  loadRepositoryPolicyPreferences,
  RepositoryConfigError,
} from "../src/analysis/repository-config.js";
import { runCli, type CliHandlers } from "../src/cli.js";
import { runAnalyzeCommand } from "../src/commands/analyze.js";
import { runStatsCommand } from "../src/commands/stats.js";
import type { AnalyzeOptions } from "../src/core/analyze.js";
import type { ReportV2 } from "../src/core/model.js";
import {
  canonicalOrganizationPolicy,
  loadConfiguredOrganizationPolicy,
  OrganizationPolicyError,
  parseOrganizationPolicy,
  resolveEffectivePolicy,
  resolveRepositoryPolicy,
  type EffectivePolicy,
  type OrganizationPolicy,
  type PolicyRequest,
  type RepositoryPolicyPreferences,
} from "../src/policy/organization-policy.js";
import {
  resolveRuleSafetyPolicy,
  type ApprovalRulePolicy,
  type EffectiveRuleSafetyPolicy,
  type RepositoryApprovalRulePolicy,
  type ResourceDomainPolicy,
} from "../src/policy/rule-safety.js";
import { renderJsonReport } from "../src/reporters/json.js";
import type { PrivacyProfile } from "../src/reporters/privacy.js";

const ENVIRONMENT_KEYS = {
  organization: "CCPROF_ORGANIZATION",
  policy: "CCPROF_ORGANIZATION_POLICY_PATH",
  signature: "CCPROF_ORGANIZATION_POLICY_SIGNATURE_PATH",
  publicKey: "CCPROF_ORGANIZATION_POLICY_PUBLIC_KEY_PATH",
} as const;

function policy(
  overrides: Partial<OrganizationPolicy> = {},
): OrganizationPolicy {
  return {
    policy_schema_version: 1,
    organization: "example-corp",
    minimum_privacy: "strict",
    allow_raw: false,
    allow_advisory: false,
    allow_export: true,
    raw_retention_days_max: 14,
    required_source_coverage: 0.9,
    ...overrides,
  };
}

type OrganizationPolicyWithRuleSafety = OrganizationPolicy & {
  approval_policy?: ApprovalRulePolicy;
  resource_domains?: ResourceDomainPolicy[];
};

type RepositoryPolicyWithRuleSafety = RepositoryPolicyPreferences & {
  approval_policy?: RepositoryApprovalRulePolicy;
  resource_domains?: ResourceDomainPolicy[];
};

type EffectivePolicyWithRuleSafety = EffectivePolicy & {
  rule_safety?: EffectiveRuleSafetyPolicy;
};

function ruleSafetyPolicy(
  overrides: Partial<OrganizationPolicyWithRuleSafety> = {},
): OrganizationPolicyWithRuleSafety {
  return {
    ...policy(),
    approval_policy: {
      safe_patterns: ["npm test"],
      allow_rule_recommendation: true,
    },
    resource_domains: [{
      match: ["npm test"],
      domain: "validation",
      parallel_safe: true,
    }],
    ...overrides,
  };
}

function policyWithCanonicalBytes(
  targetBytes: number,
): OrganizationPolicyWithRuleSafety {
  const resourceDomains = Array.from({ length: 8 }, (_, domainIndex) => ({
    match: Array.from(
      { length: 32 },
      (_, patternIndex) => `p${domainIndex}-${patternIndex}-`,
    ),
    domain: `domain-${domainIndex}`,
    parallel_safe: domainIndex % 2 === 0,
  }));
  const value = ruleSafetyPolicy({ resource_domains: resourceDomains });
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(value));
  assert.ok(remaining >= 0);
  for (const domain of resourceDomains) {
    for (let index = 0; index < domain.match.length; index += 1) {
      const pattern = domain.match[index] as string;
      const capacity = 256 - Buffer.byteLength(pattern);
      const added = Math.min(capacity, remaining);
      domain.match[index] = `${pattern}${"x".repeat(added)}`;
      remaining -= added;
    }
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(value)), targetBytes);
  return value;
}

function assertRuntimeConstraintAnnotation(value: unknown): void {
  assert.ok(Array.isArray(value));
  const annotation = value.join(" ");
  for (const constraint of [
    /UTF-8.*byte/iu,
    /NFC.*whitespace/iu,
    /duplicate/iu,
    /descriptor.*proxy/iu,
    /canonical.*payload.*byte/iu,
    /tuple.*order/iu,
    /monotonic.*merge/iu,
  ]) {
    assert.match(annotation, constraint);
  }
}

function report(repoRoot: string): ReportV2 {
  return {
    version: 2,
    unit: {
      repo: repoRoot,
      pr_ref: "private-feature",
      sessions: ["private-session"],
    },
    summary: {
      measured_min: 1,
      idle_excluded_min: 0,
      estimated_floor_min: 1,
      recoverable_min: 0,
      human_wait_min: 0,
      unexplained_min: 1,
      baseline: null,
    },
    findings: [],
    caveats: [],
  };
}

function effectivePolicy(
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

function assertPolicyError(
  error: unknown,
  code: OrganizationPolicyError["code"],
  canaries: readonly string[] = [],
): boolean {
  assert.ok(error instanceof OrganizationPolicyError);
  const policyError = error as OrganizationPolicyError;
  assert.equal(policyError.code, code);
  assert.match(policyError.message, /^organization policy /u);
  for (const canary of canaries) {
    assert.equal(policyError.message.includes(canary), false);
  }
  return true;
}

interface SignedPolicyFixture {
  root: string;
  policyPath: string;
  signaturePath: string;
  publicKeyPath: string;
  privateKeyPem: string;
  environment: NodeJS.ProcessEnv;
  value: OrganizationPolicy;
}

async function signedPolicyFixture(
  t: TestContext,
  value: OrganizationPolicy = policy(),
): Promise<SignedPolicyFixture> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-org-policy-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const policyPath = join(root, "organization-policy.json");
  const signaturePath = join(root, "organization-policy.sig");
  const publicKeyPath = join(root, "organization-policy.pub.pem");
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({
    type: "pkcs8",
    format: "pem",
  }).toString();
  await Promise.all([
    writeFile(policyPath, `${JSON.stringify(value, null, 2)}\n`, "utf8"),
    writeFile(
      signaturePath,
      `${sign(null, canonicalOrganizationPolicy(value), keys.privateKey)
        .toString("base64")}\n`,
      "utf8",
    ),
    writeFile(
      publicKeyPath,
      keys.publicKey.export({ type: "spki", format: "pem" }),
    ),
  ]);
  return {
    root,
    policyPath,
    signaturePath,
    publicKeyPath,
    privateKeyPem,
    environment: {
      [ENVIRONMENT_KEYS.organization]: value.organization,
      [ENVIRONMENT_KEYS.policy]: policyPath,
      [ENVIRONMENT_KEYS.signature]: signaturePath,
      [ENVIRONMENT_KEYS.publicKey]: publicKeyPath,
    },
    value,
  };
}

function cliHandlers(
  overrides: Partial<Pick<CliHandlers, "analyze" | "stats">> = {},
): CliHandlers {
  return {
    analyze: overrides.analyze ?? (async () => ({
      stdout: "analyzed\n",
      warnings: [],
    })),
    stats: overrides.stats ?? (async () => ({
      stdout: "stats\n",
      warnings: [],
    })),
    dismiss: async () => ({ stdout: "dismissed\n", warnings: [] }),
    explain: async () => ({ stdout: "explained\n", warnings: [] }),
    hookEvent: async () => ({ stdout: "", warnings: [] }),
    hooks: async () => ({ stdout: "hooks\n", warnings: [] }),
  };
}

async function temporaryRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-policy-repository-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRepositoryConfig(
  repoRoot: string,
  value: unknown,
): Promise<void> {
  const path = join(repoRoot, ".ccprof", "config.json");
  await mkdir(join(repoRoot, ".ccprof"), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("published organization policy schema is closed and exact", async () => {
  const schema = JSON.parse(await readFile(
    resolve(process.cwd(), "schemas/organization-policy.schema.json"),
    "utf8",
  )) as {
    additionalProperties?: unknown;
    required?: unknown;
    properties?: Record<string, unknown>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "policy_schema_version",
    "organization",
    "minimum_privacy",
    "allow_raw",
    "allow_advisory",
    "allow_export",
    "raw_retention_days_max",
    "required_source_coverage",
  ]);
  assert.deepEqual(Object.keys(schema.properties ?? {}), [
    "$schema",
    "policy_schema_version",
    "organization",
    "minimum_privacy",
    "allow_raw",
    "allow_advisory",
    "allow_export",
    "raw_retention_days_max",
    "required_source_coverage",
    "approval_policy",
    "resource_domains",
    "kill_switches",
  ]);
  const approval = schema.properties?.approval_policy as {
    additionalProperties?: unknown;
    required?: unknown;
    properties?: Record<string, {
      type?: unknown;
      minItems?: unknown;
      maxItems?: unknown;
      items?: Record<string, unknown>;
    }>;
  };
  assert.equal(approval.additionalProperties, false);
  assert.deepEqual(approval.required, [
    "safe_patterns",
    "allow_rule_recommendation",
  ]);
  assert.equal(approval.properties?.safe_patterns?.type, "array");
  assert.equal(approval.properties?.safe_patterns?.maxItems, 64);
  assert.equal(approval.properties?.safe_patterns?.items?.maxLength, 256);
  assert.equal(
    approval.properties?.allow_rule_recommendation?.type,
    "boolean",
  );

  const domains = schema.properties?.resource_domains as {
    type?: unknown;
    maxItems?: unknown;
    items?: {
      additionalProperties?: unknown;
      required?: unknown;
      properties?: Record<string, {
        type?: unknown;
        minItems?: unknown;
        maxItems?: unknown;
        maxLength?: unknown;
        pattern?: unknown;
        items?: Record<string, unknown>;
      }>;
    };
  };
  assert.equal(domains.type, "array");
  assert.equal(domains.maxItems, 64);
  assert.equal(domains.items?.additionalProperties, false);
  assert.deepEqual(domains.items?.required, [
    "match",
    "domain",
    "parallel_safe",
  ]);
  assert.equal(domains.items?.properties?.match?.minItems, 1);
  assert.equal(domains.items?.properties?.match?.maxItems, 32);
  assert.equal(domains.items?.properties?.match?.items?.maxLength, 256);
  assert.equal(domains.items?.properties?.domain?.maxLength, 64);
  assert.equal(
    domains.items?.properties?.domain?.pattern,
    "^[a-z0-9][a-z0-9._-]{0,63}$",
  );
  assert.equal(domains.items?.properties?.parallel_safe?.type, "boolean");
  const killSwitches = schema.properties?.kill_switches as {
    additionalProperties?: unknown;
    required?: unknown;
  };
  assert.equal(killSwitches.additionalProperties, false);
  assert.deepEqual(killSwitches.required, ["raw", "advisory", "export"]);
});

test("repository config schema publishes a closed optional policy section", async () => {
  const schema = JSON.parse(await readFile(
    resolve(process.cwd(), "schemas/config.schema.json"),
    "utf8",
  )) as {
    properties?: {
      policy?: {
        additionalProperties?: unknown;
        required?: unknown;
        properties?: Record<string, unknown>;
      };
    };
  };
  const policySchema = schema.properties?.policy;
  assert.equal(policySchema?.additionalProperties, false);
  assert.deepEqual(policySchema?.required, []);
  assert.deepEqual(Object.keys(policySchema?.properties ?? {}), [
    "minimum_privacy",
    "allow_raw",
    "allow_advisory",
    "allow_export",
    "raw_retention_days_max",
    "required_source_coverage",
    "approval_policy",
    "resource_domains",
  ]);
  const approval = policySchema?.properties?.approval_policy as {
    additionalProperties?: unknown;
    required?: unknown;
    properties?: Record<string, { type?: unknown }>;
  };
  assert.equal(approval.additionalProperties, false);
  assert.deepEqual(approval.required, []);
  assert.equal(approval.properties?.safe_patterns?.type, "array");
  assert.equal(
    approval.properties?.allow_rule_recommendation?.type,
    "boolean",
  );

  const domains = policySchema?.properties?.resource_domains as {
    type?: unknown;
    maxItems?: unknown;
    items?: { additionalProperties?: unknown; required?: unknown };
  };
  assert.equal(domains.type, "array");
  assert.equal(domains.maxItems, 64);
  assert.equal(domains.items?.additionalProperties, false);
  assert.deepEqual(domains.items?.required, [
    "match",
    "domain",
    "parallel_safe",
  ]);
});

test("policy schemas annotate their runtime-only rule safety constraints", async () => {
  const organizationSchema = JSON.parse(await readFile(
    resolve(process.cwd(), "schemas/organization-policy.schema.json"),
    "utf8",
  )) as {
    properties?: Record<string, {
      "x-ccprof-runtime-constraints"?: unknown;
      items?: { "x-ccprof-runtime-constraints"?: unknown };
    }>;
  };
  const repositorySchema = JSON.parse(await readFile(
    resolve(process.cwd(), "schemas/config.schema.json"),
    "utf8",
  )) as {
    properties?: {
      policy?: {
        properties?: Record<string, {
          "x-ccprof-runtime-constraints"?: unknown;
          items?: { "x-ccprof-runtime-constraints"?: unknown };
        }>;
      };
    };
  };
  for (const properties of [
    organizationSchema.properties,
    repositorySchema.properties?.policy?.properties,
  ]) {
    assertRuntimeConstraintAnnotation(
      properties?.approval_policy?.["x-ccprof-runtime-constraints"],
    );
    assertRuntimeConstraintAnnotation(
      properties?.resource_domains?.items?.[
        "x-ccprof-runtime-constraints"
      ],
    );
  }
});

test("README documents the signed organization policy operator contract", async () => {
  const readme = await readFile(resolve(process.cwd(), "README.md"), "utf8");

  for (const setting of Object.values(ENVIRONMENT_KEYS)) {
    assert.ok(readme.includes(setting), `README is missing ${setting}`);
  }
  for (const field of [
    "policy_schema_version",
    "organization",
    "minimum_privacy",
    "allow_raw",
    "allow_advisory",
    "allow_export",
    "raw_retention_days_max",
    "required_source_coverage",
    "approval_policy",
    "resource_domains",
    "kill_switches",
  ]) {
    assert.ok(readme.includes(field), `README is missing ${field}`);
  }

  assert.ok(readme.includes("schemas/organization-policy.schema.json"));
  assert.ok(readme.includes("openssl pkeyutl -sign -rawin"));
  assert.match(readme, /canonical.*JSON/isu);
  assert.match(readme, /strongest.*privacy/isu);
  assert.match(readme, /logical AND/iu);
  assert.match(readme, /minimum.*retention/isu);
  assert.match(readme, /maximum.*source coverage/isu);
  assert.match(readme, /all four.*absent.*ungoverned/isu);
  assert.match(readme, /fail(?:s)? closed/iu);
  assert.match(readme, /not yet consumed.*allow_export/isu);
  assert.match(readme, /not yet consumed.*raw_retention_days_max/isu);
  assert.match(readme, /not yet consumed.*required_source_coverage/isu);
  assert.ok(readme.includes("x-ccprof-runtime-constraints"));
  assert.match(readme, /UTF-8.*NFC.*duplicate/isu);
  assert.match(readme, /canonical.*65,536.*byte/isu);
  assert.match(readme, /repository.*tighten.*rule/isu);
});

test("the npm package includes both policy schemas", async () => {
  const manifest = JSON.parse(await readFile(
    resolve(process.cwd(), "package.json"),
    "utf8",
  )) as { files?: unknown };
  assert.ok(Array.isArray(manifest.files));
  assert.ok(manifest.files.includes("schemas"));

  for (const schema of [
    "schemas/config.schema.json",
    "schemas/organization-policy.schema.json",
  ]) {
    const contents = await readFile(resolve(process.cwd(), schema), "utf8");
    assert.doesNotThrow(() => JSON.parse(contents));
  }
});

test("repository policy preferences preserve the existing config result", async (t) => {
  const repoRoot = await temporaryRepository(t);
  assert.deepEqual(await loadRepositoryPolicyPreferences(repoRoot), {});
  assert.deepEqual(await loadRepositoryConfig(repoRoot), {
    mappings: [],
    caveats: [],
  });

  await writeRepositoryConfig(repoRoot, {
    schema_version: 1,
    policy: {
      minimum_privacy: "balanced",
      allow_raw: false,
      allow_advisory: true,
      allow_export: false,
      raw_retention_days_max: 0,
      required_source_coverage: 1,
    },
  });

  assert.deepEqual(await loadRepositoryConfig(repoRoot), {
    mappings: [],
    caveats: [],
    config_schema_version: 1,
  });
  const preferences = await loadRepositoryPolicyPreferences(repoRoot);
  assert.deepEqual(preferences, {
    minimum_privacy: "balanced",
    allow_raw: false,
    allow_advisory: true,
    allow_export: false,
    raw_retention_days_max: 0,
    required_source_coverage: 1,
  });
  preferences.minimum_privacy = "raw";
  assert.equal(
    (await loadRepositoryPolicyPreferences(repoRoot)).minimum_privacy,
    "balanced",
  );
});

test("repository policy preferences are independently optional", async (t) => {
  const fields = {
    minimum_privacy: "strict",
    allow_raw: false,
    allow_advisory: false,
    allow_export: false,
    raw_retention_days_max: Number.MAX_SAFE_INTEGER,
    required_source_coverage: 0,
  } as const;
  for (const [key, value] of Object.entries(fields)) {
    const repoRoot = await temporaryRepository(t);
    await writeRepositoryConfig(repoRoot, {
      schema_version: 1,
      policy: { [key]: value },
    });
    assert.deepEqual(await loadRepositoryPolicyPreferences(repoRoot), {
      [key]: value,
    });
  }
});

test("repository rule safety preferences are optional, normalized, and isolated", async (t) => {
  const repoRoot = await temporaryRepository(t);
  await writeRepositoryConfig(repoRoot, {
    schema_version: 1,
    policy: {
      approval_policy: {
        safe_patterns: [" npm\t test ", "cargo check"],
        allow_rule_recommendation: false,
      },
      resource_domains: [
        { match: ["npm test"], domain: "z", parallel_safe: true },
        { match: [" cargo\t check "], domain: "a", parallel_safe: false },
      ],
    },
  });

  const expected: RepositoryPolicyWithRuleSafety = {
    approval_policy: {
      safe_patterns: ["cargo check", "npm test"],
      allow_rule_recommendation: false,
    },
    resource_domains: [
      { match: ["cargo check"], domain: "a", parallel_safe: false },
      { match: ["npm test"], domain: "z", parallel_safe: true },
    ],
  };
  const preferences = await loadRepositoryPolicyPreferences(repoRoot) as
    RepositoryPolicyWithRuleSafety;
  assert.deepEqual(preferences, expected);
  preferences.approval_policy?.safe_patterns?.push("mutated");
  preferences.resource_domains?.[0]?.match.push("mutated");
  assert.deepEqual(
    await loadRepositoryPolicyPreferences(repoRoot),
    expected,
  );

  for (const [approvalPolicy, expectedApproval] of [
    [{}, {}],
    [{ safe_patterns: [" npm\t test "] }, { safe_patterns: ["npm test"] }],
    [
      { allow_rule_recommendation: false },
      { allow_rule_recommendation: false },
    ],
  ] as const) {
    const optionalRoot = await temporaryRepository(t);
    await writeRepositoryConfig(optionalRoot, {
      schema_version: 1,
      policy: { approval_policy: approvalPolicy },
    });
    assert.deepEqual(
      await loadRepositoryPolicyPreferences(optionalRoot),
      { approval_policy: expectedApproval },
    );
  }
});

test("repository rule safety validation enforces runtime bounds content-free", async (t) => {
  const sentinel = "CCPROF_PRIVATE_RULE_POLICY_c31f8a";
  const sixtyFour = Array.from({ length: 64 }, (_, index) => `npm test ${index}`);
  const thirtyTwo = Array.from({ length: 32 }, (_, index) => `npm test ${index}`);
  const validRoot = await temporaryRepository(t);
  await writeRepositoryConfig(validRoot, {
    schema_version: 1,
    policy: {
      approval_policy: {
        safe_patterns: ["é".repeat(128)],
        allow_rule_recommendation: true,
      },
      resource_domains: [],
    },
  });
  assert.equal(
    (await loadRepositoryPolicyPreferences(validRoot) as
      RepositoryPolicyWithRuleSafety).approval_policy?.safe_patterns?.[0],
    "é".repeat(128),
  );

  const invalidPolicies: readonly unknown[] = [
    { approval_policy: { [sentinel]: true } },
    {
      approval_policy: {
        safe_patterns: [...sixtyFour, "npm test 64"],
        allow_rule_recommendation: true,
      },
    },
    {
      approval_policy: {
        safe_patterns: ["é".repeat(128) + "a"],
        allow_rule_recommendation: true,
      },
    },
    {
      approval_policy: {
        safe_patterns: ["\u0344".repeat(128)],
        allow_rule_recommendation: true,
      },
    },
    {
      approval_policy: {
        safe_patterns: ["*a".repeat(17)],
        allow_rule_recommendation: true,
      },
    },
    {
      resource_domains: Array.from({ length: 65 }, (_, index) => ({
        match: [`npm test ${index}`],
        domain: `domain-${index}`,
        parallel_safe: true,
      })),
    },
    {
      resource_domains: [{
        match: [...thirtyTwo, "npm test 32"],
        domain: "validation",
        parallel_safe: true,
      }],
    },
    {
      resource_domains: [{
        match: [],
        domain: "validation",
        parallel_safe: true,
      }],
    },
    {
      resource_domains: [{
        match: ["npm test"],
        domain: "Invalid/Domain",
        parallel_safe: true,
      }],
    },
    {
      resource_domains: [{
        match: ["npm test"],
        domain: "a".repeat(65),
        parallel_safe: true,
      }],
    },
    {
      resource_domains: [{
        match: [sentinel, ` ${sentinel} `],
        domain: "validation",
        parallel_safe: true,
      }],
    },
  ];
  for (const value of invalidPolicies) {
    const repoRoot = await temporaryRepository(t);
    await writeRepositoryConfig(repoRoot, {
      schema_version: 1,
      policy: value,
    });
    await assert.rejects(
      loadRepositoryPolicyPreferences(repoRoot),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryConfigError);
        assert.equal(
          error.message,
          ".ccprof/config.json: policy contains invalid values",
        );
        assert.equal(error.message.includes(sentinel), false);
        return true;
      },
    );
  }
});

test("repository policy validation is closed, bounded, and content-free", async (t) => {
  const sentinel = "CCPROF_PRIVATE_REPOSITORY_POLICY_817ca2";
  const invalidPolicies: readonly unknown[] = [
    null,
    [],
    sentinel,
    { [sentinel]: true },
    { minimum_privacy: "RAW" },
    { allow_raw: sentinel },
    { allow_advisory: 1 },
    { allow_export: null },
    { raw_retention_days_max: -1 },
    { raw_retention_days_max: 1.5 },
    { raw_retention_days_max: Number.MAX_SAFE_INTEGER + 1 },
    { required_source_coverage: -Number.EPSILON },
    { required_source_coverage: 1 + Number.EPSILON },
  ];

  for (const value of invalidPolicies) {
    const repoRoot = await temporaryRepository(t);
    await writeRepositoryConfig(repoRoot, {
      schema_version: 1,
      policy: value,
    });
    await assert.rejects(
      loadRepositoryPolicyPreferences(repoRoot),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryConfigError);
        assert.match(error.message, /^\.ccprof\/config\.json:/u);
        assert.equal(error.message.includes(sentinel), false);
        assert.equal(error.message.includes(repoRoot), false);
        return true;
      },
    );
  }
});

test("organization policy parser returns the exact validated contract", () => {
  const parsed = parseOrganizationPolicy(JSON.stringify({
    $schema: "https://example.invalid/organization-policy.schema.json",
    ...policy({
      minimum_privacy: "balanced",
      allow_raw: true,
      allow_advisory: true,
      allow_export: false,
      raw_retention_days_max: 0,
      required_source_coverage: 1,
      kill_switches: { raw: false, advisory: true, export: false },
    }),
  }));

  assert.deepEqual(parsed, {
    policy_schema_version: 1,
    organization: "example-corp",
    minimum_privacy: "balanced",
    allow_raw: true,
    allow_advisory: true,
    allow_export: false,
    raw_retention_days_max: 0,
    required_source_coverage: 1,
    kill_switches: { raw: false, advisory: true, export: false },
  });

  (parsed.kill_switches as { advisory: boolean }).advisory = false;
  assert.equal(
    parseOrganizationPolicy(JSON.stringify(policy({
      kill_switches: { raw: false, advisory: true, export: false },
    }))).kill_switches?.advisory,
    true,
  );
});

test("organization rule safety policy is normalized and deeply snapshotted", () => {
  const parsed = parseOrganizationPolicy(JSON.stringify(ruleSafetyPolicy({
    approval_policy: {
      safe_patterns: [" npm\t test ", "cargo check"],
      allow_rule_recommendation: true,
    },
    resource_domains: [
      { match: ["npm test"], domain: "z", parallel_safe: true },
      { match: [" cargo\t check "], domain: "a", parallel_safe: false },
    ],
  }))) as OrganizationPolicyWithRuleSafety;
  assert.deepEqual(parsed.approval_policy, {
    safe_patterns: ["cargo check", "npm test"],
    allow_rule_recommendation: true,
  });
  assert.deepEqual(parsed.resource_domains, [
    { match: ["cargo check"], domain: "a", parallel_safe: false },
    { match: ["npm test"], domain: "z", parallel_safe: true },
  ]);

  parsed.approval_policy?.safe_patterns.push("mutated");
  parsed.resource_domains?.[0]?.match.push("mutated");
  const fresh = parseOrganizationPolicy(
    JSON.stringify(ruleSafetyPolicy()),
  ) as OrganizationPolicyWithRuleSafety;
  assert.deepEqual(fresh.approval_policy?.safe_patterns, ["npm test"]);
  assert.deepEqual(fresh.resource_domains?.[0]?.match, ["npm test"]);
});

test("organization rule safety validation enforces runtime bounds content-free", () => {
  const sentinel = "CCPROF_PRIVATE_SIGNED_RULE_POLICY_70cb4d";
  const sixtyFour = Array.from({ length: 64 }, (_, index) => `npm test ${index}`);
  const thirtyTwo = Array.from({ length: 32 }, (_, index) => `npm test ${index}`);
  const accepted = parseOrganizationPolicy(JSON.stringify(ruleSafetyPolicy({
    approval_policy: {
      safe_patterns: ["é".repeat(128)],
      allow_rule_recommendation: true,
    },
  }))) as OrganizationPolicyWithRuleSafety;
  assert.equal(accepted.approval_policy?.safe_patterns[0], "é".repeat(128));

  const invalidPolicies: readonly unknown[] = [
    ruleSafetyPolicy({
      approval_policy: {
        safe_patterns: ["npm test"],
        allow_rule_recommendation: true,
        [sentinel]: true,
      } as ApprovalRulePolicy,
    }),
    ruleSafetyPolicy({
      approval_policy: {
        safe_patterns: [...sixtyFour, "npm test 64"],
        allow_rule_recommendation: true,
      },
    }),
    ruleSafetyPolicy({
      approval_policy: {
        safe_patterns: ["é".repeat(128) + "a"],
        allow_rule_recommendation: true,
      },
    }),
    ruleSafetyPolicy({
      approval_policy: {
        safe_patterns: ["\u0344".repeat(128)],
        allow_rule_recommendation: true,
      },
    }),
    ruleSafetyPolicy({
      approval_policy: {
        safe_patterns: ["*a".repeat(17)],
        allow_rule_recommendation: true,
      },
    }),
    ruleSafetyPolicy({
      resource_domains: Array.from({ length: 65 }, (_, index) => ({
        match: [`npm test ${index}`],
        domain: `domain-${index}`,
        parallel_safe: true,
      })),
    }),
    ruleSafetyPolicy({
      resource_domains: [{
        match: [...thirtyTwo, "npm test 32"],
        domain: "validation",
        parallel_safe: true,
      }],
    }),
    ruleSafetyPolicy({
      resource_domains: [{
        match: [],
        domain: "validation",
        parallel_safe: true,
      }],
    }),
    ruleSafetyPolicy({
      resource_domains: [{
        match: ["npm test"],
        domain: "a".repeat(65),
        parallel_safe: true,
      }],
    }),
    ruleSafetyPolicy({
      resource_domains: [{
        match: [sentinel, ` ${sentinel} `],
        domain: "validation",
        parallel_safe: true,
      }],
    }),
  ];
  for (const value of invalidPolicies) {
    assert.throws(
      () => parseOrganizationPolicy(JSON.stringify(value)),
      (error: unknown) => assertPolicyError(
        error,
        "invalid_policy",
        [sentinel],
      ),
    );
  }
});

test("organization policy validation is closed, bounded, and content-free", () => {
  const sentinel = "CCPROF_PRIVATE_POLICY_SENTINEL_92f73b";
  const cases: readonly unknown[] = [
    "{",
    null,
    [],
    { ...policy(), [sentinel]: true },
    { ...policy(), policy_schema_version: 2 },
    { ...policy(), organization: `${sentinel}/invalid` },
    { ...policy(), organization: "-invalid" },
    { ...policy(), minimum_privacy: "RAW" },
    { ...policy(), allow_raw: sentinel },
    { ...policy(), allow_advisory: 1 },
    { ...policy(), allow_export: null },
    { ...policy(), raw_retention_days_max: -1 },
    { ...policy(), raw_retention_days_max: 1.5 },
    { ...policy(), raw_retention_days_max: Number.MAX_SAFE_INTEGER + 1 },
    { ...policy(), required_source_coverage: -Number.EPSILON },
    { ...policy(), required_source_coverage: 1 + Number.EPSILON },
    { ...policy(), kill_switches: { raw: false, advisory: false } },
    {
      ...policy(),
      kill_switches: {
        raw: false,
        advisory: false,
        export: false,
        [sentinel]: true,
      },
    },
  ];

  for (const value of cases) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    assert.throws(
      () => parseOrganizationPolicy(text),
      (error: unknown) => assertPolicyError(
        error,
        "invalid_policy",
        [sentinel],
      ),
    );
  }

  assert.equal(
    parseOrganizationPolicy(JSON.stringify(policy({
      raw_retention_days_max: Number.MAX_SAFE_INTEGER,
      required_source_coverage: 0,
    }))).raw_retention_days_max,
    Number.MAX_SAFE_INTEGER,
  );
});

test("canonical policy bytes use fixed semantic order and exclude $schema", () => {
  const parsed = parseOrganizationPolicy(JSON.stringify({
    required_source_coverage: 0.9,
    allow_export: true,
    $schema: "https://private.example.invalid/schema.json",
    organization: "example-corp",
    raw_retention_days_max: 14,
    allow_advisory: false,
    minimum_privacy: "strict",
    allow_raw: false,
    policy_schema_version: 1,
    kill_switches: { export: true, advisory: false, raw: true },
  }));

  assert.equal(
    canonicalOrganizationPolicy(parsed).toString("utf8"),
    '{"policy_schema_version":1,"organization":"example-corp",' +
      '"minimum_privacy":"strict","allow_raw":false,' +
      '"allow_advisory":false,"allow_export":true,' +
      '"raw_retention_days_max":14,"required_source_coverage":0.9,' +
      '"kill_switches":{"raw":true,"advisory":false,"export":true}}',
  );
});

test("canonical signed rule safety fields append in fixed semantic order", () => {
  const parsed = parseOrganizationPolicy(JSON.stringify({
    resource_domains: [
      { parallel_safe: true, domain: "z", match: ["npm test"] },
      { parallel_safe: false, domain: "a", match: [" cargo\t check "] },
    ],
    required_source_coverage: 0.9,
    allow_export: true,
    $schema: "https://private.example.invalid/schema.json",
    organization: "example-corp",
    raw_retention_days_max: 14,
    approval_policy: {
      allow_rule_recommendation: true,
      safe_patterns: [" npm\t test ", "cargo check"],
    },
    allow_advisory: false,
    minimum_privacy: "strict",
    allow_raw: false,
    policy_schema_version: 1,
    kill_switches: { export: true, advisory: false, raw: true },
  }));

  assert.equal(
    canonicalOrganizationPolicy(parsed).toString("utf8"),
    '{"policy_schema_version":1,"organization":"example-corp",' +
      '"minimum_privacy":"strict","allow_raw":false,' +
      '"allow_advisory":false,"allow_export":true,' +
      '"raw_retention_days_max":14,"required_source_coverage":0.9,' +
      '"approval_policy":{"safe_patterns":["cargo check","npm test"],' +
      '"allow_rule_recommendation":true},' +
      '"resource_domains":[' +
      '{"match":["cargo check"],"domain":"a","parallel_safe":false},' +
      '{"match":["npm test"],"domain":"z","parallel_safe":true}],' +
      '"kill_switches":{"raw":true,"advisory":false,"export":true}}',
  );
});

test("canonical signed payload has an independent exact 64 KiB ceiling", () => {
  const exact = policyWithCanonicalBytes(65_536);
  const tooLarge = policyWithCanonicalBytes(65_537);
  assert.equal(canonicalOrganizationPolicy(exact).byteLength, 65_536);
  assert.throws(
    () => canonicalOrganizationPolicy(tooLarge),
    (error: unknown) => assertPolicyError(error, "invalid_policy"),
  );
});

test("configured policy verifies a genuine detached Ed25519 signature", async (t) => {
  const fixture = await signedPolicyFixture(t, policy({
    kill_switches: { raw: false, advisory: false, export: false },
  }));
  assert.deepEqual(
    await loadConfiguredOrganizationPolicy(fixture.environment),
    fixture.value,
  );

  assert.equal(await loadConfiguredOrganizationPolicy({}), undefined);
});

test("configured rule safety policy verifies a genuine Ed25519 signature", async (t) => {
  const value = ruleSafetyPolicy({
    kill_switches: { raw: false, advisory: false, export: false },
  });
  const fixture = await signedPolicyFixture(t, value);
  assert.deepEqual(
    await loadConfiguredOrganizationPolicy(fixture.environment),
    value,
  );
});

test("trusted public key input rejects matching private key material", async (t) => {
  const fixture = await signedPolicyFixture(t);
  await writeFile(fixture.publicKeyPath, fixture.privateKeyPem, "utf8");

  await assert.rejects(
    loadConfiguredOrganizationPolicy(fixture.environment),
    (error: unknown) => assertPolicyError(
      error,
      "untrusted_policy",
      [fixture.privateKeyPem, fixture.publicKeyPath],
    ),
  );
});

test("partial governed configuration fails closed without echoing values", async () => {
  const sentinel = "CCPROF_PRIVATE_TRUST_PATH_57ac2d";
  for (const key of Object.values(ENVIRONMENT_KEYS)) {
    await assert.rejects(
      loadConfiguredOrganizationPolicy({ [key]: sentinel }),
      (error: unknown) => assertPolicyError(
        error,
        "incomplete_configuration",
        [sentinel],
      ),
    );
    await assert.rejects(
      loadConfiguredOrganizationPolicy({ [key]: "   " }),
      (error: unknown) => assertPolicyError(
        error,
        "incomplete_configuration",
      ),
    );
  }
});

test("configured trust files are bounded regular files and never fall back", async (t) => {
  const fixture = await signedPolicyFixture(t);
  const sentinel = "CCPROF_PRIVATE_FILE_SENTINEL_cab149";

  await rm(fixture.policyPath);
  await assert.rejects(
    loadConfiguredOrganizationPolicy(fixture.environment),
    (error: unknown) => assertPolicyError(
      error,
      "policy_unreadable",
      [fixture.policyPath, sentinel],
    ),
  );

  await writeFile(fixture.policyPath, "x".repeat(65_537), "utf8");
  await assert.rejects(
    loadConfiguredOrganizationPolicy(fixture.environment),
    (error: unknown) => assertPolicyError(
      error,
      "policy_unreadable",
      [fixture.policyPath],
    ),
  );

  const realPolicyPath = join(fixture.root, sentinel);
  await writeFile(realPolicyPath, JSON.stringify(fixture.value), "utf8");
  await rm(fixture.policyPath);
  await symlink(realPolicyPath, fixture.policyPath);
  await assert.rejects(
    loadConfiguredOrganizationPolicy(fixture.environment),
    (error: unknown) => assertPolicyError(
      error,
      "policy_unreadable",
      [fixture.policyPath, realPolicyPath, sentinel],
    ),
  );
});

test("signed policy raw bytes accept 65,536 and reject 65,537 content-free", async (t) => {
  const fixture = await signedPolicyFixture(t);
  const serialized = Buffer.from(JSON.stringify(fixture.value), "utf8");
  const exact = Buffer.concat([
    serialized,
    Buffer.alloc(65_536 - serialized.byteLength, 0x20),
  ]);
  assert.equal(exact.byteLength, 65_536);
  await writeFile(fixture.policyPath, exact);
  assert.deepEqual(
    await loadConfiguredOrganizationPolicy(fixture.environment),
    fixture.value,
  );

  await writeFile(fixture.policyPath, Buffer.concat([exact, Buffer.from(" ")]));
  await assert.rejects(
    loadConfiguredOrganizationPolicy(fixture.environment),
    (error: unknown) => assertPolicyError(
      error,
      "policy_unreadable",
      [fixture.policyPath, fixture.value.organization],
    ),
  );
});

test("signature and public key enforce equivalent missing, size, and symlink guards", async (t) => {
  const cases = [
    {
      label: "signature",
      path: (fixture: SignedPolicyFixture) => fixture.signaturePath,
      maxBytes: 1024,
      code: "signature_unreadable" as const,
    },
    {
      label: "public-key",
      path: (fixture: SignedPolicyFixture) => fixture.publicKeyPath,
      maxBytes: 16 * 1024,
      code: "public_key_unreadable" as const,
    },
  ];

  for (const definition of cases) {
    const missing = await signedPolicyFixture(t);
    const missingPath = definition.path(missing);
    await rm(missingPath);
    await assert.rejects(
      loadConfiguredOrganizationPolicy(missing.environment),
      (error: unknown) => assertPolicyError(
        error,
        definition.code,
        [missingPath],
      ),
    );

    const oversized = await signedPolicyFixture(t);
    const oversizedPath = definition.path(oversized);
    await writeFile(
      oversizedPath,
      Buffer.alloc(definition.maxBytes + 1),
    );
    await assert.rejects(
      loadConfiguredOrganizationPolicy(oversized.environment),
      (error: unknown) => assertPolicyError(
        error,
        definition.code,
        [oversizedPath],
      ),
    );

    const linked = await signedPolicyFixture(t);
    const linkedPath = definition.path(linked);
    const externalPath = join(linked.root, `external-${definition.label}`);
    await writeFile(externalPath, await readFile(linkedPath));
    await rm(linkedPath);
    await symlink(externalPath, linkedPath);
    await assert.rejects(
      loadConfiguredOrganizationPolicy(linked.environment),
      (error: unknown) => assertPolicyError(
        error,
        definition.code,
        [linkedPath, externalPath],
      ),
    );
  }
});

test("trust loading never uses an unbounded readFile after the size snapshot", async (t) => {
  const fixture = await signedPolicyFixture(t);
  type OpenFile = typeof open;
  const cjsRequire = createRequire(import.meta.url);
  const promises = cjsRequire("node:fs/promises") as { open: OpenFile };
  const originalOpen = promises.open;
  let unboundedReadCalled = false;
  const instrumentedOpen = (async (...args: Parameters<OpenFile>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === fixture.policyPath) {
      handle.readFile = (async () => {
        unboundedReadCalled = true;
        return Buffer.alloc(65_537);
      }) as typeof handle.readFile;
    }
    return handle;
  }) as OpenFile;

  try {
    promises.open = instrumentedOpen;
    syncBuiltinESMExports();
    assert.deepEqual(
      await loadConfiguredOrganizationPolicy(fixture.environment),
      fixture.value,
    );
    assert.equal(unboundedReadCalled, false);
  } finally {
    promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("bounded trust reads reuse one allocation across one-byte short reads", async (t) => {
  const fixture = await signedPolicyFixture(t);
  type OpenFile = typeof open;
  const cjsRequire = createRequire(import.meta.url);
  const promises = cjsRequire("node:fs/promises") as { open: OpenFile };
  const originalOpen = promises.open;
  const backingStores = new Set<unknown>();
  const offsets: number[] = [];
  const instrumentedOpen = (async (...args: Parameters<OpenFile>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === fixture.signaturePath) {
      const originalRead = handle.read.bind(handle) as (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>;
      handle.read = (async (...readArgs: unknown[]) => {
        const [buffer, offset, length, position] = readArgs as [
          Buffer,
          number,
          number,
          number | null,
        ];
        backingStores.add(buffer.buffer);
        offsets.push(offset);
        return await originalRead(
          buffer,
          offset,
          Math.min(length, 1),
          position,
        );
      }) as typeof handle.read;
    }
    return handle;
  }) as OpenFile;

  try {
    promises.open = instrumentedOpen;
    syncBuiltinESMExports();
    assert.deepEqual(
      await loadConfiguredOrganizationPolicy(fixture.environment),
      fixture.value,
    );
    assert.ok(offsets.length > 64);
    assert.equal(backingStores.size, 1);
    assert.ok(new Set(offsets).size > 64);
  } finally {
    promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("trust loading rejects a file change during the read", async (t) => {
  const fixture = await signedPolicyFixture(t);
  const changedContent = Buffer.concat([
    await readFile(fixture.policyPath),
    Buffer.from(" "),
  ]);
  type OpenFile = typeof open;
  const cjsRequire = createRequire(import.meta.url);
  const promises = cjsRequire("node:fs/promises") as { open: OpenFile };
  const originalOpen = promises.open;
  let changed = false;
  const instrumentedOpen = (async (...args: Parameters<OpenFile>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === fixture.policyPath) {
      const originalRead = handle.read.bind(handle) as (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>;
      handle.read = (async (...readArgs: unknown[]) => {
        const [buffer, offset, length, position] = readArgs as [
          Buffer,
          number,
          number,
          number | null,
        ];
        const result = await originalRead(buffer, offset, length, position);
        if (!changed && result.bytesRead > 0) {
          changed = true;
          await writeFile(fixture.policyPath, changedContent);
        }
        return result;
      }) as typeof handle.read;
    }
    return handle;
  }) as OpenFile;

  try {
    promises.open = instrumentedOpen;
    syncBuiltinESMExports();
    await assert.rejects(
      loadConfiguredOrganizationPolicy(fixture.environment),
      (error: unknown) => assertPolicyError(
        error,
        "policy_unreadable",
        [fixture.policyPath],
      ),
    );
    assert.equal(changed, true);
  } finally {
    promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("invalid and untrusted policy material has content-free failures", async (t) => {
  const fixture = await signedPolicyFixture(t);
  const sentinel = "CCPROF_PRIVATE_MATERIAL_SENTINEL_11fead";

  await writeFile(fixture.policyPath, `{\"${sentinel}\":true}`, "utf8");
  await assert.rejects(
    loadConfiguredOrganizationPolicy(fixture.environment),
    (error: unknown) => assertPolicyError(
      error,
      "invalid_policy",
      [sentinel, fixture.policyPath],
    ),
  );

  const fresh = await signedPolicyFixture(t);
  await assert.rejects(
    loadConfiguredOrganizationPolicy({
      ...fresh.environment,
      [ENVIRONMENT_KEYS.organization]: sentinel,
    }),
    (error: unknown) => assertPolicyError(
      error,
      "untrusted_policy",
      [sentinel, fresh.value.organization],
    ),
  );

  for (const invalidSignature of [
    sentinel,
    "_".repeat(86),
    Buffer.alloc(63).toString("base64"),
    `${Buffer.alloc(64).toString("base64")} trailing`,
  ]) {
    await writeFile(fresh.signaturePath, invalidSignature, "utf8");
    await assert.rejects(
      loadConfiguredOrganizationPolicy(fresh.environment),
      (error: unknown) => assertPolicyError(
        error,
        "untrusted_policy",
        [invalidSignature, fresh.signaturePath],
      ),
    );
  }
});

test("wrong keys, algorithms, and modified policies never verify", async (t) => {
  const wrongKey = await signedPolicyFixture(t);
  const replacement = generateKeyPairSync("ed25519").publicKey.export({
    type: "spki",
    format: "pem",
  });
  await writeFile(wrongKey.publicKeyPath, replacement);
  await assert.rejects(
    loadConfiguredOrganizationPolicy(wrongKey.environment),
    (error: unknown) => assertPolicyError(error, "untrusted_policy"),
  );

  const wrongAlgorithm = await signedPolicyFixture(t);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
    .export({ type: "spki", format: "pem" });
  await writeFile(wrongAlgorithm.publicKeyPath, rsa);
  await assert.rejects(
    loadConfiguredOrganizationPolicy(wrongAlgorithm.environment),
    (error: unknown) => assertPolicyError(error, "untrusted_policy"),
  );

  const modified = await signedPolicyFixture(t);
  await writeFile(
    modified.policyPath,
    JSON.stringify({ ...modified.value, allow_export: false }),
    "utf8",
  );
  await assert.rejects(
    loadConfiguredOrganizationPolicy(modified.environment),
    (error: unknown) => assertPolicyError(error, "untrusted_policy"),
  );
});

test("canonicalization rejects hostile objects with content-free deterministic errors", () => {
  const sentinel = "CCPROF_HOSTILE_POLICY_SENTINEL_d16fc2";
  const assertHostile = (value: unknown): void => {
    assert.throws(
      () => canonicalOrganizationPolicy(value as OrganizationPolicy),
      (error: unknown) => assertPolicyError(
        error,
        "invalid_policy",
        [sentinel],
      ),
    );
  };

  let topLevelGetterCalls = 0;
  const changingTopLevel = { ...policy() } as Record<string, unknown>;
  Object.defineProperty(changingTopLevel, "allow_raw", {
    enumerable: true,
    configurable: true,
    get() {
      topLevelGetterCalls += 1;
      if (topLevelGetterCalls > 1) throw new Error(sentinel);
      return true;
    },
  });
  assertHostile(changingTopLevel);
  assert.equal(topLevelGetterCalls, 0);

  let nestedGetterCalls = 0;
  const changingSwitches = {
    raw: false,
    advisory: false,
    export: false,
  } as Record<string, unknown>;
  Object.defineProperty(changingSwitches, "advisory", {
    enumerable: true,
    configurable: true,
    get() {
      nestedGetterCalls += 1;
      throw new Error(sentinel);
    },
  });
  assertHostile({ ...policy(), kill_switches: changingSwitches });
  assert.equal(nestedGetterCalls, 0);

  let approvalGetterCalls = 0;
  const changingApproval = {
    allow_rule_recommendation: true,
  } as Record<string, unknown>;
  Object.defineProperty(changingApproval, "safe_patterns", {
    enumerable: true,
    get() {
      approvalGetterCalls += 1;
      throw new Error(sentinel);
    },
  });
  assertHostile(ruleSafetyPolicy({
    approval_policy: changingApproval as unknown as ApprovalRulePolicy,
  }));
  assert.equal(approvalGetterCalls, 0);

  const hostileDomain = new Proxy({
    match: ["npm test"],
    domain: "validation",
    parallel_safe: true,
  }, {
    ownKeys() {
      throw new Error(sentinel);
    },
  });
  assertHostile(ruleSafetyPolicy({ resource_domains: [hostileDomain] }));

  assertHostile(Object.assign(Object.create({ sentinel }), policy()));
  assertHostile(new Proxy(policy(), {
    ownKeys() {
      throw new Error(sentinel);
    },
  }));

  const revoked = Proxy.revocable(policy(), {});
  revoked.revoke();
  assertHostile(revoked.proxy);
});

test("organization constraints cannot be weakened by repository or CLI", () => {
  assert.deepEqual(resolveEffectivePolicy({
    organization: policy(),
    repository: {
      minimum_privacy: "raw",
      allow_raw: true,
      allow_advisory: true,
      allow_export: true,
      raw_retention_days_max: 30,
      required_source_coverage: 0.2,
    },
    request: { privacy: "raw", advisory: true },
  }), {
    governed: true,
    organization: "example-corp",
    privacy: "strict",
    allow_raw: false,
    allow_advisory: false,
    advisory_enabled: false,
    allow_export: true,
    raw_retention_days_max: 14,
    required_source_coverage: 0.9,
    rule_safety: { organization_resource_domains: [] },
  });
});

test("repository preferences and CLI can only tighten organization policy", () => {
  assert.deepEqual(resolveEffectivePolicy({
    organization: policy({
      minimum_privacy: "raw",
      allow_raw: true,
      allow_advisory: true,
      allow_export: true,
      raw_retention_days_max: 30,
      required_source_coverage: 0.25,
    }),
    repository: {
      minimum_privacy: "balanced",
      allow_raw: false,
      allow_advisory: false,
      allow_export: false,
      raw_retention_days_max: 7,
      required_source_coverage: 0.75,
    },
    request: { privacy: "strict", advisory: true },
  }), {
    governed: true,
    organization: "example-corp",
    privacy: "strict",
    allow_raw: false,
    allow_advisory: false,
    advisory_enabled: false,
    allow_export: false,
    raw_retention_days_max: 7,
    required_source_coverage: 0.75,
    rule_safety: { organization_resource_domains: [] },
  });
});

test("signed administrative kill switches override every lower layer", () => {
  assert.deepEqual(resolveEffectivePolicy({
    organization: policy({
      minimum_privacy: "raw",
      allow_raw: true,
      allow_advisory: true,
      allow_export: true,
      kill_switches: { raw: true, advisory: true, export: true },
    }),
    repository: {
      minimum_privacy: "raw",
      allow_raw: true,
      allow_advisory: true,
      allow_export: true,
    },
    request: { privacy: "raw", advisory: true },
  }), {
    governed: true,
    organization: "example-corp",
    privacy: "balanced",
    allow_raw: false,
    allow_advisory: false,
    advisory_enabled: false,
    allow_export: false,
    raw_retention_days_max: 14,
    required_source_coverage: 0.9,
    rule_safety: { organization_resource_domains: [] },
  });
});

test("rule safety resolution is signed-only, monotonic, and mutation isolated", () => {
  const organization = ruleSafetyPolicy({
    approval_policy: {
      safe_patterns: ["npm *", "cargo *"],
      allow_rule_recommendation: true,
    },
    resource_domains: [
      { match: ["npm *"], domain: "node", parallel_safe: true },
      { match: ["cargo *"], domain: "rust", parallel_safe: true },
    ],
  });
  const repository: RepositoryPolicyWithRuleSafety = {
    approval_policy: {
      safe_patterns: [" npm\t test "],
      allow_rule_recommendation: false,
    },
    resource_domains: [{
      match: ["npm test"],
      domain: "node",
      parallel_safe: false,
    }],
  };
  const resolved = resolveEffectivePolicy({
    organization,
    repository,
    request: { privacy: "strict", advisory: false },
  }) as EffectivePolicyWithRuleSafety;
  assert.deepEqual(resolved.rule_safety, {
    approval: {
      allow_rule_recommendation: false,
      organization_safe_patterns: ["cargo *", "npm *"],
      repository_safe_patterns: ["npm test"],
    },
    organization_resource_domains: [
      { match: ["npm *"], domain: "node", parallel_safe: true },
      { match: ["cargo *"], domain: "rust", parallel_safe: true },
    ],
    repository_resource_domains: [{
      match: ["npm test"],
      domain: "node",
      parallel_safe: false,
    }],
  });

  organization.approval_policy?.safe_patterns.push("mutated");
  organization.resource_domains?.[0]?.match.push("mutated");
  repository.approval_policy?.safe_patterns?.push("mutated");
  repository.resource_domains?.[0]?.match.push("mutated");
  assert.deepEqual(resolved.rule_safety, {
    approval: {
      allow_rule_recommendation: false,
      organization_safe_patterns: ["cargo *", "npm *"],
      repository_safe_patterns: ["npm test"],
    },
    organization_resource_domains: [
      { match: ["npm *"], domain: "node", parallel_safe: true },
      { match: ["cargo *"], domain: "rust", parallel_safe: true },
    ],
    repository_resource_domains: [{
      match: ["npm test"],
      domain: "node",
      parallel_safe: false,
    }],
  });

  const repositoryOnly = resolveEffectivePolicy({
    repository: {
      approval_policy: {
        safe_patterns: ["*"],
        allow_rule_recommendation: true,
      },
      resource_domains: [{
        match: ["*"],
        domain: "everything",
        parallel_safe: true,
      }],
    } as RepositoryPolicyWithRuleSafety,
    request: { privacy: "raw", advisory: true },
  }) as EffectivePolicyWithRuleSafety;
  assert.equal(Object.hasOwn(repositoryOnly, "rule_safety"), false);
});

test("rule safety resolution rejects hostile repository preferences without reads", () => {
  const sentinel = "CCPROF_HOSTILE_REPOSITORY_RULE_POLICY_523f7a";
  let getterCalls = 0;
  const repository = {} as Record<string, unknown>;
  Object.defineProperty(repository, "approval_policy", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(sentinel);
    },
  });
  assert.throws(
    () => resolveEffectivePolicy({
      organization: ruleSafetyPolicy(),
      repository: repository as unknown as RepositoryPolicyWithRuleSafety,
      request: { privacy: "strict", advisory: false },
    }),
    (error: unknown) => assertPolicyError(
      error,
      "invalid_policy",
      [sentinel],
    ),
  );
  assert.equal(getterCalls, 0);
});

test("ungoverned policy resolution preserves current CLI defaults", () => {
  assert.deepEqual(resolveEffectivePolicy({
    request: { privacy: "raw", advisory: true },
  }), {
    governed: false,
    privacy: "raw",
    allow_raw: true,
    allow_advisory: true,
    advisory_enabled: true,
    allow_export: true,
    required_source_coverage: 0,
  });

  assert.deepEqual(resolveEffectivePolicy({
    repository: {
      minimum_privacy: "balanced",
      allow_raw: false,
      raw_retention_days_max: 0,
      required_source_coverage: 1,
    },
    request: { privacy: "raw", advisory: false },
  }), {
    governed: false,
    privacy: "balanced",
    allow_raw: false,
    allow_advisory: true,
    advisory_enabled: false,
    allow_export: true,
    raw_retention_days_max: 0,
    required_source_coverage: 1,
  });
});

test("repository policy resolver composes signed and repository layers", async (t) => {
  const repoRoot = await temporaryRepository(t);
  const organization = await signedPolicyFixture(t);
  await writeRepositoryConfig(repoRoot, {
    schema_version: 1,
    policy: {
      minimum_privacy: "raw",
      allow_raw: true,
      allow_advisory: true,
      allow_export: true,
      raw_retention_days_max: 30,
      required_source_coverage: 0.1,
    },
  });

  assert.deepEqual(await resolveRepositoryPolicy(
    repoRoot,
    { privacy: "raw", advisory: true },
    organization.environment,
  ), {
    governed: true,
    organization: "example-corp",
    privacy: "strict",
    allow_raw: false,
    allow_advisory: false,
    advisory_enabled: false,
    allow_export: true,
    raw_retention_days_max: 14,
    required_source_coverage: 0.9,
    rule_safety: { organization_resource_domains: [] },
  });
});

test("analyze shares one cached effective rule policy with core and rendering", async (t) => {
  const repoRoot = await temporaryRepository(t);
  const canonicalRepo = join(repoRoot, "canonical-report-repository");
  const ruleSafety = resolveRuleSafetyPolicy(
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
  const resolved = effectivePolicy({
    privacy: "balanced",
    rule_safety: ruleSafety,
  });
  let resolverCalls = 0;
  let capturedOptions: AnalyzeOptions | undefined;
  let resolvedRepo = "";

  await runAnalyzeCommand({
    cwd: repoRoot,
    format: "json",
    color: false,
    privacy: "raw",
  }, {
    analyze: async (options) => {
      capturedOptions = options;
      const callback = options.resolveRuleSafetyPolicy;
      assert.ok(callback !== undefined);
      assert.strictEqual(await callback(canonicalRepo), ruleSafety);
      return { report: report(canonicalRepo), warnings: [] };
    },
    resolvePolicy: async (repo) => {
      resolverCalls += 1;
      resolvedRepo = repo;
      return resolved;
    },
  });

  assert.equal(capturedOptions?.cwd, repoRoot);
  assert.equal(resolvedRepo, canonicalRepo);
  assert.equal(resolverCalls, 1);
});

test("analyze applies effective privacy and denies advisory before spawning", async (t) => {
  const repoRoot = await temporaryRepository(t);
  const rawReport = report(repoRoot);
  const privateWarning = "/private/policy/warning";
  let runnerCalls = 0;
  let resolvedRepo = "";
  let resolvedRequest: PolicyRequest | undefined;
  const output = await runAnalyzeCommand({
    cwd: repoRoot,
    format: "json",
    color: false,
    privacy: "raw",
    advisory: true,
  }, {
    analyze: async () => ({
      report: rawReport,
      warnings: [{
        code: "private_policy_warning",
        message: privateWarning,
        source: privateWarning,
      }],
    }),
    resolvePolicy: async (resolved: string, request: PolicyRequest) => {
      resolvedRepo = resolved;
      resolvedRequest = request;
      return effectivePolicy({
        governed: true,
        organization: "example-corp",
        privacy: "strict",
        allow_raw: false,
        allow_advisory: false,
        advisory_enabled: false,
      });
    },
    runCommand: async () => {
      runnerCalls += 1;
      return { code: 0, stdout: "must not run", stderr: "" };
    },
  });

  assert.equal(resolvedRepo, repoRoot);
  assert.deepEqual(resolvedRequest, { privacy: "raw", advisory: true });
  assert.equal(runnerCalls, 0);
  assert.equal(output.stdout.includes(repoRoot), false);
  assert.deepEqual(output.warnings, [
    "[private_policy_warning] 1 warning",
    "[policy_advisory_disabled] Advisory execution is disabled by active policy.",
  ]);
  assert.doesNotMatch(output.warnings.join("\n"), /private\/policy/u);
});

test("stats applies the same effective privacy floor before warning projection", async (t) => {
  const repoRoot = await temporaryRepository(t);
  const canonicalRepo = join(repoRoot, "canonical-main");
  const privatePath = "/private/stats/policy-warning";
  let resolvedRepo = "";
  let resolvedRequest: PolicyRequest | undefined;
  const output = await runStatsCommand({
    cwd: repoRoot,
    json: true,
    privacy: "raw",
  }, {
    resolveRepoRoot: async () => repoRoot,
    resolvePolicy: async (resolved: string, request: PolicyRequest) => {
      resolvedRepo = resolved;
      resolvedRequest = request;
      return effectivePolicy({ privacy: "strict" });
    },
    resolveStorePaths: async () => ({
      canonical_repo: canonicalRepo,
      repo_hash: "hash",
      root_dir: repoRoot,
      repo_dir: repoRoot,
      analyses_dir: repoRoot,
      history_index_path: join(repoRoot, "history"),
      dismissals_path: join(repoRoot, "dismissals"),
      adoptions_path: join(repoRoot, "adoptions"),
      hook_events_path: join(repoRoot, "hooks"),
    }),
    loadAnalyses: async () => ({
      records: [],
      warnings: [{
        code: "private_stats_warning",
        message: privatePath,
        path: privatePath,
      }],
    }),
    loadAdoptions: async () => ({ records: [], warnings: [] }),
  });

  assert.equal(resolvedRepo, canonicalRepo);
  assert.deepEqual(resolvedRequest, { privacy: "raw", advisory: false });
  assert.deepEqual(output.warnings, ["[private_stats_warning] 1 warning"]);
  assert.doesNotMatch(output.warnings.join("\n"), /private\/stats/u);
});

test("CLI preloads the signed privacy floor before analyze parsing", async (t) => {
  const repoRoot = await temporaryRepository(t);
  const privatePath = "/private/parser/organization-policy-canary";
  const scenarios = [
    {
      label: "minimum strict",
      organization: policy({
        minimum_privacy: "strict",
        allow_raw: true,
      }),
      hidden: true,
    },
    {
      label: "raw denied",
      organization: policy({
        minimum_privacy: "raw",
        allow_raw: false,
      }),
      hidden: false,
    },
    {
      label: "raw kill switch",
      organization: policy({
        minimum_privacy: "raw",
        allow_raw: true,
        kill_switches: { raw: true, advisory: false, export: false },
      }),
      hidden: false,
    },
  ] as const;

  for (const scenario of scenarios) {
    let stderr = "";
    let loads = 0;
    const runtime = {
      cwd: repoRoot,
      ci: false,
      handlers: cliHandlers(),
      loadOrganizationPolicy: async () => {
        loads += 1;
        return scenario.organization;
      },
      stdout: (_value: string): void => undefined,
      stderr: (value: string): void => {
        stderr += value;
      },
    };
    const code = await runCli([
      "--privacy=raw",
      `--unknown=${privatePath}`,
    ], runtime);

    assert.equal(code, 2, scenario.label);
    assert.equal(loads, 1, scenario.label);
    assert.equal(stderr.includes(privatePath), false, scenario.label);
    if (scenario.hidden) {
      assert.match(
        stderr,
        /analysis failed \(details hidden by strict privacy\)/u,
        scenario.label,
      );
    } else {
      assert.match(stderr, /\[path\]/u, scenario.label);
    }
  }
});

test("CLI signed privacy floor covers analyze and stats operational errors", async (t) => {
  const repoRoot = await temporaryRepository(t);
  const quiet = (_value: string): void => undefined;
  const scenarios = [
    {
      label: "analyze core",
      args: ["--json", "--privacy=raw"],
      handlers: cliHandlers({
        analyze: async () => {
          throw new Error("core failed at /private/core/policy-canary");
        },
      }),
      canary: "/private/core/policy-canary",
    },
    {
      label: "stats store",
      args: ["stats", "--json", "--privacy=raw"],
      handlers: cliHandlers({
        stats: async () => {
          throw new Error("store failed at /private/store/policy-canary");
        },
      }),
      canary: "/private/store/policy-canary",
    },
  ] as const;

  for (const scenario of scenarios) {
    let stderr = "";
    const runtime = {
      cwd: repoRoot,
      ci: false,
      handlers: scenario.handlers,
      loadOrganizationPolicy: async () => policy({
        minimum_privacy: "strict",
        allow_raw: true,
      }),
      stdout: quiet,
      stderr: (value: string): void => {
        stderr += value;
      },
    };
    const code = await runCli(scenario.args, runtime);

    assert.equal(code, 5, scenario.label);
    assert.match(
      stderr,
      /analysis failed \(details hidden by strict privacy\)/u,
      scenario.label,
    );
    assert.equal(stderr.includes(scenario.canary), false);
  }
});

test("commands publish fully resolved privacy before downstream work", async (t) => {
  const repoRoot = await temporaryRepository(t);
  const canonicalRepo = join(repoRoot, "canonical-main");
  const resolved: Array<["analyze" | "stats", PrivacyProfile]> = [];

  const analyzeDependencies = {
    analyze: async () => ({ report: report(repoRoot), warnings: [] }),
    resolvePolicy: async () => effectivePolicy({ privacy: "strict" }),
    onPrivacyResolved: (privacy: PrivacyProfile): void => {
      resolved.push(["analyze", privacy]);
    },
  };
  await runAnalyzeCommand({
    cwd: repoRoot,
    format: "json",
    color: false,
    privacy: "raw",
  }, analyzeDependencies);

  const statsDependencies = {
    resolveRepoRoot: async () => repoRoot,
    resolveStorePaths: async () => ({
      canonical_repo: canonicalRepo,
      repo_hash: "hash",
      root_dir: repoRoot,
      repo_dir: repoRoot,
      analyses_dir: repoRoot,
      history_index_path: join(repoRoot, "history"),
      dismissals_path: join(repoRoot, "dismissals"),
      adoptions_path: join(repoRoot, "adoptions"),
      hook_events_path: join(repoRoot, "hooks"),
    }),
    resolvePolicy: async () => effectivePolicy({ privacy: "strict" }),
    onPrivacyResolved: (privacy: PrivacyProfile): void => {
      resolved.push(["stats", privacy]);
    },
    loadAnalyses: async () => {
      throw new Error("store failed after policy resolution");
    },
    loadAdoptions: async () => ({ records: [], warnings: [] }),
  };
  await assert.rejects(
    runStatsCommand({
      cwd: repoRoot,
      json: true,
      privacy: "raw",
    }, statsDependencies),
    /store failed after policy resolution/u,
  );

  assert.deepEqual(resolved, [
    ["analyze", "strict"],
    ["stats", "strict"],
  ]);
});

test("CLI policy preload preserves custom handler arity and skips other commands", async () => {
  let loads = 0;
  let analyzeArguments = -1;
  const customAnalyze = async (
    ...values: Parameters<CliHandlers["analyze"]>
  ) => {
    analyzeArguments = values.length;
    return { stdout: "ok\n", warnings: [] };
  };
  const policyLoader = async (): Promise<OrganizationPolicy> => {
    loads += 1;
    return policy({ minimum_privacy: "raw", allow_raw: true });
  };
  const quiet = (_value: string): void => undefined;

  const analyzeRuntime = {
    handlers: cliHandlers({ analyze: customAnalyze }),
    loadOrganizationPolicy: policyLoader,
    stdout: quiet,
    stderr: quiet,
  };
  assert.equal(await runCli(["--json"], analyzeRuntime), 0);
  assert.equal(loads, 1);
  assert.equal(analyzeArguments, 1);

  const otherRuntime = {
    handlers: cliHandlers(),
    loadOrganizationPolicy: policyLoader,
    stdout: quiet,
    stderr: quiet,
  };
  assert.equal(await runCli(["dismiss", "finding-key"], otherRuntime), 0);
  assert.equal(await runCli(["--help"], otherRuntime), 0);
  assert.equal(await runCli(["--version"], otherRuntime), 0);
  assert.equal(loads, 1);
});

test("ungoverned analyze output remains byte-identical", async (t) => {
  const repoRoot = await temporaryRepository(t);
  const rawReport = report(repoRoot);
  const output = await runAnalyzeCommand({
    cwd: repoRoot,
    format: "json",
    color: false,
    privacy: "raw",
  }, {
    analyze: async () => ({ report: rawReport, warnings: [] }),
    resolvePolicy: async (_resolved: string, request: PolicyRequest) =>
      resolveEffectivePolicy({ request }),
  });

  assert.equal(output.stdout, renderJsonReport(rawReport));
  assert.deepEqual(output.warnings, []);
});
