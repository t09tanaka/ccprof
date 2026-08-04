import {
  createPrivateKey,
  createPublicKey,
  verify,
} from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  type FileHandle,
} from "node:fs/promises";
import { types as utilTypes } from "node:util";

import { loadRepositoryPolicyPreferences } from
  "../analysis/repository-config.js";
import type { PrivacyProfile } from "../reporters/privacy.js";

const POLICY_MAX_BYTES = 64 * 1024;
const SIGNATURE_MAX_BYTES = 1024;
const PUBLIC_KEY_MAX_BYTES = 16 * 1024;

const POLICY_KEYS = new Set([
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
const KILL_SWITCH_KEYS = new Set(["raw", "advisory", "export"]);
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const ENVIRONMENT_KEYS = {
  organization: "CCPROF_ORGANIZATION",
  policy: "CCPROF_ORGANIZATION_POLICY_PATH",
  signature: "CCPROF_ORGANIZATION_POLICY_SIGNATURE_PATH",
  publicKey: "CCPROF_ORGANIZATION_POLICY_PUBLIC_KEY_PATH",
} as const;

export interface OrganizationPolicyKillSwitches {
  raw: boolean;
  advisory: boolean;
  export: boolean;
}

export interface OrganizationPolicy {
  policy_schema_version: 1;
  organization: string;
  minimum_privacy: PrivacyProfile;
  allow_raw: boolean;
  allow_advisory: boolean;
  allow_export: boolean;
  raw_retention_days_max: number;
  required_source_coverage: number;
  kill_switches?: OrganizationPolicyKillSwitches;
}

export interface RepositoryPolicyPreferences {
  minimum_privacy?: PrivacyProfile;
  allow_raw?: boolean;
  allow_advisory?: boolean;
  allow_export?: boolean;
  raw_retention_days_max?: number;
  required_source_coverage?: number;
}

export interface PolicyRequest {
  privacy: PrivacyProfile;
  advisory: boolean;
}

export type RepositoryPolicyResolver = (
  repoRoot: string,
  request: PolicyRequest,
) => Promise<EffectivePolicy>;

export interface EffectivePolicy {
  governed: boolean;
  organization?: string;
  privacy: PrivacyProfile;
  allow_raw: boolean;
  allow_advisory: boolean;
  advisory_enabled: boolean;
  allow_export: boolean;
  raw_retention_days_max?: number;
  required_source_coverage: number;
}

export type OrganizationPolicyErrorCode =
  | "incomplete_configuration"
  | "policy_unreadable"
  | "signature_unreadable"
  | "public_key_unreadable"
  | "invalid_policy"
  | "untrusted_policy";

const ERROR_MESSAGES: Readonly<Record<OrganizationPolicyErrorCode, string>> = {
  incomplete_configuration:
    "organization policy configuration is incomplete",
  policy_unreadable: "organization policy cannot be read",
  signature_unreadable: "organization policy signature cannot be read",
  public_key_unreadable: "organization policy public key cannot be read",
  invalid_policy: "organization policy is invalid",
  untrusted_policy: "organization policy is untrusted",
};

export class OrganizationPolicyError extends Error {
  readonly code: OrganizationPolicyErrorCode;

  constructor(code: OrganizationPolicyErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OrganizationPolicyError";
    this.code = code;
  }
}

function invalid(): never {
  throw new OrganizationPolicyError("invalid_policy");
}

function captureClosedObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  try {
    if (
      typeof value !== "object" || value === null ||
      utilTypes.isProxy(value) || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      invalid();
    }
    const captured: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowedKeys.has(key)) invalid();
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined || !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        invalid();
      }
      captured[key] = descriptor.value;
    }
    return captured;
  } catch (error) {
    if (error instanceof OrganizationPolicyError) throw error;
    invalid();
  }
}

function privacyProfile(value: unknown): value is PrivacyProfile {
  return value === "strict" || value === "balanced" || value === "raw";
}

function snapshotKillSwitches(
  value: unknown,
): OrganizationPolicyKillSwitches | undefined {
  if (value === undefined) return undefined;
  const captured = captureClosedObject(value, KILL_SWITCH_KEYS);
  const raw = captured.raw;
  const advisory = captured.advisory;
  const exportAllowed = captured.export;
  if (
    typeof raw !== "boolean" ||
    typeof advisory !== "boolean" ||
    typeof exportAllowed !== "boolean"
  ) {
    invalid();
  }
  return {
    raw,
    advisory,
    export: exportAllowed,
  };
}

function snapshotPolicy(value: unknown): OrganizationPolicy {
  const captured = captureClosedObject(value, POLICY_KEYS);
  const schema = captured.$schema;
  const policySchemaVersion = captured.policy_schema_version;
  const organization = captured.organization;
  const minimumPrivacy = captured.minimum_privacy;
  const allowRaw = captured.allow_raw;
  const allowAdvisory = captured.allow_advisory;
  const allowExport = captured.allow_export;
  const rawRetentionDaysMax = captured.raw_retention_days_max;
  const requiredSourceCoverage = captured.required_source_coverage;
  if (
    policySchemaVersion !== 1 ||
    typeof organization !== "string" || !ORGANIZATION.test(organization) ||
    !privacyProfile(minimumPrivacy) ||
    typeof allowRaw !== "boolean" ||
    typeof allowAdvisory !== "boolean" ||
    typeof allowExport !== "boolean" ||
    typeof rawRetentionDaysMax !== "number" ||
    !Number.isSafeInteger(rawRetentionDaysMax) || rawRetentionDaysMax < 0 ||
    typeof requiredSourceCoverage !== "number" ||
    !Number.isFinite(requiredSourceCoverage) || requiredSourceCoverage < 0 ||
    requiredSourceCoverage > 1 ||
    (schema !== undefined &&
      (typeof schema !== "string" || schema.trim() === ""))
  ) {
    invalid();
  }
  const killSwitches = snapshotKillSwitches(captured.kill_switches);
  return {
    policy_schema_version: 1,
    organization,
    minimum_privacy: minimumPrivacy,
    allow_raw: allowRaw,
    allow_advisory: allowAdvisory,
    allow_export: allowExport,
    raw_retention_days_max: rawRetentionDaysMax,
    required_source_coverage: requiredSourceCoverage,
    ...(killSwitches === undefined
      ? {}
      : { kill_switches: killSwitches }),
  };
}

export function parseOrganizationPolicy(text: string): OrganizationPolicy {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    invalid();
  }
  return snapshotPolicy(value);
}

export function canonicalOrganizationPolicy(
  policy: OrganizationPolicy,
): Buffer {
  const value = snapshotPolicy(policy);
  return Buffer.from(JSON.stringify(value), "utf8");
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function readBounded(
  handle: FileHandle,
  maxBytes: number,
  code: Extract<
    OrganizationPolicyErrorCode,
    "policy_unreadable" | "signature_unreadable" | "public_key_unreadable"
  >,
): Promise<Buffer> {
  const content = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const { bytesRead } = await handle.read(
      content,
      total,
      remaining,
      null,
    );
    if (bytesRead === 0) return content.subarray(0, total);
    total += bytesRead;
    if (total > maxBytes) throw new OrganizationPolicyError(code);
  }
  throw new OrganizationPolicyError(code);
}

async function readTrustFile(
  path: string,
  maxBytes: number,
  code: Extract<
    OrganizationPolicyErrorCode,
    "policy_unreadable" | "signature_unreadable" | "public_key_unreadable"
  >,
): Promise<Buffer> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch {
    throw new OrganizationPolicyError(code);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw new OrganizationPolicyError(code);
  }

  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new OrganizationPolicyError(code);
  }

  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameSnapshot(before, opened) ||
      opened.size > maxBytes
    ) {
      throw new OrganizationPolicyError(code);
    }
    const content = await readBounded(handle, maxBytes, code);
    const after = await lstat(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      !sameSnapshot(opened, after) ||
      content.byteLength > maxBytes
    ) {
      throw new OrganizationPolicyError(code);
    }
    return content;
  } catch (error) {
    if (error instanceof OrganizationPolicyError) throw error;
    throw new OrganizationPolicyError(code);
  } finally {
    try {
      await handle.close();
    } catch {
      throw new OrganizationPolicyError(code);
    }
  }
}

function configuredPaths(environment: NodeJS.ProcessEnv):
  | {
      organization: string;
      policy: string;
      signature: string;
      publicKey: string;
    }
  | undefined {
  const values = {
    organization: environment[ENVIRONMENT_KEYS.organization],
    policy: environment[ENVIRONMENT_KEYS.policy],
    signature: environment[ENVIRONMENT_KEYS.signature],
    publicKey: environment[ENVIRONMENT_KEYS.publicKey],
  };
  const configured = Object.values(values).filter(
    (value) => value !== undefined,
  ).length;
  if (configured === 0) return undefined;
  const organization = values.organization;
  const policy = values.policy;
  const signature = values.signature;
  const publicKey = values.publicKey;
  if (
    configured !== 4 || organization === undefined ||
    policy === undefined || signature === undefined || publicKey === undefined ||
    organization.trim() === "" || policy.trim() === "" ||
    signature.trim() === "" || publicKey.trim() === ""
  ) {
    throw new OrganizationPolicyError("incomplete_configuration");
  }
  return { organization, policy, signature, publicKey };
}

function detachedSignature(content: Buffer): Buffer {
  const text = content.toString("utf8").trim();
  if (!STANDARD_BASE64.test(text)) {
    throw new OrganizationPolicyError("untrusted_policy");
  }
  const signature = Buffer.from(text, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== text) {
    throw new OrganizationPolicyError("untrusted_policy");
  }
  return signature;
}

export async function loadConfiguredOrganizationPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<OrganizationPolicy | undefined> {
  const configured = configuredPaths(environment);
  if (configured === undefined) return undefined;

  const policyContent = await readTrustFile(
    configured.policy,
    POLICY_MAX_BYTES,
    "policy_unreadable",
  );
  const signatureContent = await readTrustFile(
    configured.signature,
    SIGNATURE_MAX_BYTES,
    "signature_unreadable",
  );
  const publicKeyContent = await readTrustFile(
    configured.publicKey,
    PUBLIC_KEY_MAX_BYTES,
    "public_key_unreadable",
  );
  const policy = parseOrganizationPolicy(policyContent.toString("utf8"));
  if (policy.organization !== configured.organization) {
    throw new OrganizationPolicyError("untrusted_policy");
  }

  try {
    createPrivateKey(publicKeyContent);
    throw new OrganizationPolicyError("untrusted_policy");
  } catch (error) {
    if (error instanceof OrganizationPolicyError) throw error;
  }

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(publicKeyContent);
  } catch {
    throw new OrganizationPolicyError("untrusted_policy");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new OrganizationPolicyError("untrusted_policy");
  }

  let trusted = false;
  try {
    trusted = verify(
      null,
      canonicalOrganizationPolicy(policy),
      publicKey,
      detachedSignature(signatureContent),
    );
  } catch (error) {
    if (error instanceof OrganizationPolicyError) throw error;
  }
  if (!trusted) throw new OrganizationPolicyError("untrusted_policy");
  return snapshotPolicy(policy);
}

const PRIVACY_STRENGTH: Readonly<Record<PrivacyProfile, number>> = {
  raw: 0,
  balanced: 1,
  strict: 2,
};

function strongestPrivacy(
  values: readonly (PrivacyProfile | undefined)[],
): PrivacyProfile {
  return values.reduce<PrivacyProfile>(
    (strongest, value) =>
      value !== undefined &&
        PRIVACY_STRENGTH[value] > PRIVACY_STRENGTH[strongest]
        ? value
        : strongest,
    "raw",
  );
}

export function resolveEffectivePolicy(input: {
  organization?: OrganizationPolicy;
  repository?: RepositoryPolicyPreferences;
  request: PolicyRequest;
}): EffectivePolicy {
  const organization = input.organization === undefined
    ? undefined
    : snapshotPolicy(input.organization);
  const repository = input.repository;
  const rawKilled = organization?.kill_switches?.raw === true;
  const advisoryKilled = organization?.kill_switches?.advisory === true;
  const exportKilled = organization?.kill_switches?.export === true;
  const allowRaw = (organization?.allow_raw ?? true) &&
    (repository?.allow_raw ?? true) && !rawKilled;
  const allowAdvisory = (organization?.allow_advisory ?? true) &&
    (repository?.allow_advisory ?? true) && !advisoryKilled;
  const allowExport = (organization?.allow_export ?? true) &&
    (repository?.allow_export ?? true) && !exportKilled;
  let privacy = strongestPrivacy([
    organization?.minimum_privacy,
    repository?.minimum_privacy,
    input.request.privacy,
  ]);
  if (!allowRaw && privacy === "raw") privacy = "balanced";
  const retentionValues = [
    organization?.raw_retention_days_max,
    repository?.raw_retention_days_max,
  ].filter((value): value is number => value !== undefined);
  const rawRetentionDaysMax = retentionValues.length === 0
    ? undefined
    : Math.min(...retentionValues);
  return {
    governed: organization !== undefined,
    ...(organization === undefined
      ? {}
      : { organization: organization.organization }),
    privacy,
    allow_raw: allowRaw,
    allow_advisory: allowAdvisory,
    advisory_enabled: allowAdvisory && input.request.advisory,
    allow_export: allowExport,
    ...(rawRetentionDaysMax === undefined
      ? {}
      : { raw_retention_days_max: rawRetentionDaysMax }),
    required_source_coverage: Math.max(
      organization?.required_source_coverage ?? 0,
      repository?.required_source_coverage ?? 0,
    ),
  };
}

export async function resolveRepositoryPolicy(
  repoRoot: string,
  request: PolicyRequest,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EffectivePolicy> {
  const [organization, repository] = await Promise.all([
    loadConfiguredOrganizationPolicy(environment),
    loadRepositoryPolicyPreferences(repoRoot),
  ]);
  return resolveEffectivePolicy({
    ...(organization === undefined ? {} : { organization }),
    repository,
    request,
  });
}
