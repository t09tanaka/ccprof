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
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
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
  if (!isBoundedValue(host, 253) || /[%@/:\\?#]/u.test(host)) return undefined;
  const undotted = host.endsWith(".") ? host.slice(0, -1) : host;
  const normalized = domainToASCII(undotted).toLowerCase();
  if (
    !isBoundedValue(normalized, 253) ||
    !normalized.split(".").every((label) => DNS_LABEL.test(label))
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

type RemoteTuple = readonly ["remote", string, number | null, string];

function normalizeRemotePath(path: string, host: string): string | undefined {
  let normalized: string;
  try {
    normalized = decodeURIComponent(path).normalize("NFC");
  } catch {
    return undefined;
  }
  normalized = normalized.replace(/^\/+|\/+$/gu, "");
  if (
    normalized === "" ||
    CONTROL_CHARACTER.test(normalized) ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    return undefined;
  }
  normalized = normalized.replace(/\.git$/iu, "");
  if (normalized === "") return undefined;
  return host === "github.com" || host === "gitlab.com"
    ? normalized.toLowerCase()
    : normalized;
}

function canonicalRemote(remote: LogicalRepositoryRemote): RemoteTuple | undefined {
  const raw = remote.fetch_url;
  if (
    !isBoundedValue(raw, 2048) ||
    raw.includes("\\") ||
    /^[a-z]:\//iu.test(raw) ||
    /%2f|%5c/iu.test(raw)
  ) {
    return undefined;
  }
  try {
    if (CONTROL_CHARACTER.test(decodeURIComponent(raw))) return undefined;
  } catch {
    return undefined;
  }

  let host: string | undefined;
  let port: number | null = null;
  let path: string;
  const urlParts = /^(https|ssh):\/\/([^/?#]*)(\/[^?#]*)?(?:[?#].*)?$/iu.exec(raw);
  if (urlParts !== null) {
    const scheme = urlParts[1]!.toLowerCase();
    const authority = urlParts[2]!;
    if (authority.slice(authority.lastIndexOf("@") + 1).includes("%")) {
      return undefined;
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return undefined;
    }
    host = normalizeHost(parsed.hostname);
    const parsedPort = parsed.port;
    if (parsedPort !== "" && !(scheme === "ssh" && parsedPort === "22")) {
      port = Number(parsedPort);
    }
    path = urlParts[3] ?? "";
  } else {
    if (raw.includes("://") || /^(?:file|https?|ssh|git):/iu.test(raw)) {
      return undefined;
    }
    const scp = /^(?:[^@/:]+@)?([^@/:]+):([^?#]*)(?:[?#].*)?$/u.exec(raw);
    if (scp === null) return undefined;
    host = normalizeHost(scp[1]!);
    path = scp[2]!;
  }
  if (host === undefined) return undefined;
  const repositoryPath = normalizeRemotePath(path, host);
  return repositoryPath === undefined
    ? undefined
    : ["remote", host, port, repositoryPath];
}

function remoteResult(tuple: RemoteTuple): LogicalRepositoryIdentityResult {
  return {
    status: "available",
    logical_repository_id: identityDigest(tuple),
    source: "remote",
    portability: "portable",
  };
}

function resolveRemotes(
  remotes: readonly LogicalRepositoryRemote[],
): LogicalRepositoryIdentityResult {
  if (
    remotes.length > 32 ||
    remotes.some(
      ({ name, fetch_url: url, explicit_identity: flag }) =>
        !isBoundedValue(name, 128) || !isBoundedValue(url, 2048) || (flag !== undefined && typeof flag !== "boolean"),
    )
  ) {
    return { status: "unavailable", reason: "invalid_remote" };
  }
  const explicit = remotes.filter(({ explicit_identity: value }) => value === true);
  if (explicit.length > 1) {
    return { status: "unavailable", reason: "ambiguous_remote" };
  }
  const origins = explicit.length === 0
    ? remotes.filter(({ name }) => name === "origin")
    : [];
  if (origins.length > 1) {
    return { status: "unavailable", reason: "ambiguous_remote" };
  }
  const selected = explicit[0] ?? origins[0];
  if (selected !== undefined) {
    const tuple = canonicalRemote(selected);
    return tuple === undefined
      ? { status: "unavailable", reason: "invalid_remote" }
      : remoteResult(tuple);
  }
  const tuples = remotes.map(canonicalRemote);
  if (tuples.some((tuple) => tuple === undefined)) {
    return { status: "unavailable", reason: "invalid_remote" };
  }
  const encoded = tuples.map((tuple) => JSON.stringify(tuple));
  if (new Set(encoded).size !== 1) {
    return { status: "unavailable", reason: "ambiguous_remote" };
  }
  return remoteResult(tuples[0]!);
}

function normalizeLocalPath(path: string): string | undefined {
  if (!isBoundedValue(path, 2048)) return undefined;
  const windowsPath = /^[a-z]:[\\/]/iu.test(path);
  const uncPath = path.startsWith("\\\\") || path.startsWith("//");
  const posixPath = path.startsWith("/") && !uncPath;
  if (
    (!posixPath && !windowsPath && !uncPath) ||
    (posixPath && path.includes("\\"))
  ) {
    return undefined;
  }
  let normalized = path.normalize("NFC").replaceAll("\\", "/");
  if (uncPath) {
    const [server, share] = normalized.slice(2).split("/");
    if (server === "" || share === undefined || share === "") return undefined;
  }
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
  let reason: "invalid_provider" | "invalid_remote" | "invalid_offline_uuid" | "invalid_local_path" = "invalid_provider";
  try {
    const provider = input.trusted_provider;
    if (provider !== undefined) return resolveProvider(provider);
    reason = "invalid_remote";
    const remotes = input.remotes;
    if (remotes !== undefined && !Array.isArray(remotes)) return { status: "unavailable", reason };
    if (remotes !== undefined && remotes.length > 0) return resolveRemotes(remotes);
    reason = "invalid_offline_uuid";
    const uuid = input.offline_uuid;
    if (uuid !== undefined) return resolveOffline(uuid);
    reason = "invalid_local_path";
    const path = input.local_path;
    if (path !== undefined) return resolveLocal(path);
    return { status: "unavailable", reason: "no_identity" };
  } catch {
    return { status: "unavailable", reason };
  }
}
