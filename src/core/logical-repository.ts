import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";

export interface TrustedProviderRepository {
  provider: string;
  host: string;
  repository_id: string;
}

export interface LogicalRepositoryRemote {
  name: string;
  fetch_url: string;
  explicit_identity?: boolean;
}

export interface LogicalRepositoryIdentityInput {
  trusted_provider?: TrustedProviderRepository;
  remotes?: readonly LogicalRepositoryRemote[];
  offline_uuid?: string;
  local_path?: string;
}

export type LogicalRepositoryIdentityResult =
  | {
      status: "available";
      logical_repository_id: `sha256:${string}`;
      source: "provider" | "remote" | "offline" | "local_path";
      portability: "portable" | "local_only";
    }
  | {
      status: "unavailable";
      reason:
        | "invalid_provider"
        | "invalid_remote"
        | "ambiguous_remote"
        | "invalid_offline_uuid"
        | "invalid_local_path"
        | "no_identity";
    };

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const RFC_4122_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isBoundedValue(value: string, maximumLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    !CONTROL_CHARACTER.test(value)
  );
}

function identityDigest(tuple: readonly unknown[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("ccprof\0logical-repository-v1\0")
    .update(JSON.stringify(tuple))
    .digest("hex")}`;
}

function normalizeHost(host: string): string | undefined {
  if (!isBoundedValue(host, 253) || /[@/:\\?#]/u.test(host)) return undefined;
  const normalized = domainToASCII(host).toLowerCase();
  if (
    !isBoundedValue(normalized, 253) ||
    normalized === "." ||
    normalized.startsWith(".") ||
    normalized.includes("..")
  ) {
    return undefined;
  }
  return normalized;
}

function resolveProvider(
  repository: TrustedProviderRepository,
): LogicalRepositoryIdentityResult {
  const { provider, host, repository_id: repositoryId } = repository;
  const normalizedHost = normalizeHost(host);
  if (
    !isBoundedValue(provider, 64) ||
    normalizedHost === undefined ||
    !isBoundedValue(repositoryId, 512)
  ) {
    return { status: "unavailable", reason: "invalid_provider" };
  }
  return {
    status: "available",
    logical_repository_id: identityDigest([
      "provider",
      provider.toLowerCase(),
      normalizedHost,
      repositoryId,
    ]),
    source: "provider",
    portability: "portable",
  };
}

function resolveOffline(uuid: string): LogicalRepositoryIdentityResult {
  if (!RFC_4122_UUID.test(uuid)) {
    return { status: "unavailable", reason: "invalid_offline_uuid" };
  }
  return {
    status: "available",
    logical_repository_id: identityDigest(["offline_uuid", uuid.toLowerCase()]),
    source: "offline",
    portability: "portable",
  };
}

function normalizeLocalPath(path: string): string | undefined {
  if (!isBoundedValue(path, 2048)) return undefined;
  const windowsPath = /^[a-z]:[\\/]/iu.test(path);
  if (!path.startsWith("/") && !windowsPath && !/^\\\\/u.test(path)) {
    return undefined;
  }
  let normalized = path.normalize("NFC").replaceAll("\\", "/");
  if (windowsPath) {
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  }
  const rootLength = windowsPath ? 3 : 1;
  while (normalized.length > rootLength && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function resolveLocal(path: string): LogicalRepositoryIdentityResult {
  const normalized = normalizeLocalPath(path);
  if (normalized === undefined) {
    return { status: "unavailable", reason: "invalid_local_path" };
  }
  return {
    status: "available",
    logical_repository_id: identityDigest(["local_path", normalized]),
    source: "local_path",
    portability: "local_only",
  };
}

export function resolveLogicalRepositoryIdentity(
  input: LogicalRepositoryIdentityInput,
): LogicalRepositoryIdentityResult {
  if (input.trusted_provider !== undefined) {
    return resolveProvider(input.trusted_provider);
  }
  if (input.remotes !== undefined && input.remotes.length > 0) {
    return { status: "unavailable", reason: "invalid_remote" };
  }
  if (input.offline_uuid !== undefined) return resolveOffline(input.offline_uuid);
  if (input.local_path !== undefined) return resolveLocal(input.local_path);
  return { status: "unavailable", reason: "no_identity" };
}
