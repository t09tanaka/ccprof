import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  lstat,
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
  canonicalOrganizationPolicy,
  loadConfiguredOrganizationPolicy,
  OrganizationPolicyError,
  parseOrganizationPolicy,
  resolveEffectivePolicy,
  type OrganizationPolicy,
} from "../src/policy/organization-policy.js";

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
    assert.doesNotMatch(policyError.message, new RegExp(canary, "u"));
  }
  return true;
}

interface SignedPolicyFixture {
  root: string;
  policyPath: string;
  signaturePath: string;
  publicKeyPath: string;
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
    environment: {
      [ENVIRONMENT_KEYS.organization]: value.organization,
      [ENVIRONMENT_KEYS.policy]: policyPath,
      [ENVIRONMENT_KEYS.signature]: signaturePath,
      [ENVIRONMENT_KEYS.publicKey]: publicKeyPath,
    },
    value,
  };
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
    "kill_switches",
  ]);
  const killSwitches = schema.properties?.kill_switches as {
    additionalProperties?: unknown;
    required?: unknown;
  };
  assert.equal(killSwitches.additionalProperties, false);
  assert.deepEqual(killSwitches.required, ["raw", "advisory", "export"]);
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

test("trust loading rejects a path identity change during the read", async (t) => {
  const fixture = await signedPolicyFixture(t);
  type Lstat = typeof lstat;
  const cjsRequire = createRequire(import.meta.url);
  const promises = cjsRequire("node:fs/promises") as { lstat: Lstat };
  const originalLstat = promises.lstat;
  let policyStats = 0;
  const changingLstat = (async (...args: Parameters<Lstat>) => {
    const stat = await originalLstat(...args);
    if (String(args[0]) !== fixture.policyPath || ++policyStats === 1) {
      return stat;
    }
    return new Proxy(stat, {
      get(target, property) {
        if (property === "ino") {
          return typeof target.ino === "bigint"
            ? target.ino + 1n
            : target.ino + 1;
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Lstat;

  try {
    promises.lstat = changingLstat;
    syncBuiltinESMExports();
    await assert.rejects(
      loadConfiguredOrganizationPolicy(fixture.environment),
      (error: unknown) => assertPolicyError(
        error,
        "policy_unreadable",
        [fixture.policyPath],
      ),
    );
  } finally {
    promises.lstat = originalLstat;
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
  });
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
