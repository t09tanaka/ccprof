import {
  createPublicKey,
  verify,
} from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  type FileHandle,
} from "node:fs/promises";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertClosedObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invalid();
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) invalid();
}

function privacyProfile(value: unknown): value is PrivacyProfile {
  return value === "strict" || value === "balanced" || value === "raw";
}

function snapshotKillSwitches(
  value: unknown,
): OrganizationPolicyKillSwitches | undefined {
  if (value === undefined) return undefined;
  assertClosedObject(value, KILL_SWITCH_KEYS);
  if (
    typeof value.raw !== "boolean" ||
    typeof value.advisory !== "boolean" ||
    typeof value.export !== "boolean"
  ) {
    invalid();
  }
  return {
    raw: value.raw,
    advisory: value.advisory,
    export: value.export,
  };
}

function snapshotPolicy(value: unknown): OrganizationPolicy {
  assertClosedObject(value, POLICY_KEYS);
  if (
    value.policy_schema_version !== 1 ||
    typeof value.organization !== "string" ||
    !ORGANIZATION.test(value.organization) ||
    !privacyProfile(value.minimum_privacy) ||
    typeof value.allow_raw !== "boolean" ||
    typeof value.allow_advisory !== "boolean" ||
    typeof value.allow_export !== "boolean" ||
    typeof value.raw_retention_days_max !== "number" ||
    !Number.isSafeInteger(value.raw_retention_days_max) ||
    value.raw_retention_days_max < 0 ||
    typeof value.required_source_coverage !== "number" ||
    !Number.isFinite(value.required_source_coverage) ||
    value.required_source_coverage < 0 ||
    value.required_source_coverage > 1 ||
    (value.$schema !== undefined &&
      (typeof value.$schema !== "string" || value.$schema.trim() === ""))
  ) {
    invalid();
  }
  const killSwitches = snapshotKillSwitches(value.kill_switches);
  return {
    policy_schema_version: 1,
    organization: value.organization,
    minimum_privacy: value.minimum_privacy,
    allow_raw: value.allow_raw,
    allow_advisory: value.allow_advisory,
    allow_export: value.allow_export,
    raw_retention_days_max: value.raw_retention_days_max,
    required_source_coverage: value.required_source_coverage,
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
    const content = await handle.readFile();
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
  const organization = input.organization;
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
