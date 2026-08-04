import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { types as utilTypes } from "node:util";
import type Database from "better-sqlite3";
import type { SourceAdapterId } from "../core/source-descriptor.js";
import { canonicalJson } from "./legacy-json.js";
import {
  SourceEvidenceCacheError,
  type SourceEvidenceCacheErrorCode,
} from "./source-evidence-cache.js";
export interface SourceDiscoveryRoot {
  root_identity: string;
  adapter_id: SourceAdapterId;
  canonical_root: string;
  cursor: number;
  capability: "stable_directory_token" | "full_scan_required";
  tree_json: string;
  tree_digest: string;
  observed_at_ms: number;
  completeness: "complete" | "partial";
  sensitivity: "sensitive";
  retention_class: "source_metadata";
}
export type SourceDiscoveryCommitResult =
  | "inserted" | "updated" | "unchanged" | "stale" | "conflict";
type Row = Record<string, unknown>;
interface Token { device: string; inode: string; mtime_ns: string; ctime_ns: string }
const FIELDS = [
  "root_identity", "adapter_id", "canonical_root", "cursor", "capability",
  "tree_json", "tree_digest", "observed_at_ms", "completeness",
  "sensitivity", "retention_class",
] as const satisfies readonly (keyof SourceDiscoveryRoot)[];
const COLUMNS = FIELDS.join(", ");
const PARAMETERS = FIELDS.map((field) => `@${field}`).join(", ");
const UPDATE = FIELDS.filter((field) => field !== "root_identity")
  .map((field) => `${field} = excluded.${field}`).join(", ");
const ROOT_ID = /^root-[a-f0-9]{64}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const POSITIVE = /^[1-9][0-9]*$/u;
const NONNEGATIVE = /^(?:0|[1-9][0-9]*)$/u;
export const MAX_DISCOVERY_TREE_BYTES = 8 * 1024 * 1024;
const MAX_DISCOVERY_ENTRIES = 100_000;
const MAX_DISCOVERY_DEPTH = 64;
const ENTRY_KINDS = ["file", "directory", "symlink", "other"] as const;
const FULL_SCAN_REASONS = [
  "platform", "node", "filesystem", "root_identity", "directory_identity",
  "timestamp", "uncertain",
] as const;
function fail(code: SourceEvidenceCacheErrorCode): never {
  throw new SourceEvidenceCacheError(code);
}
function exact(
  value: unknown,
  fields: readonly string[],
  shape: SourceEvidenceCacheErrorCode = "invalid_shape",
): Row {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) return fail(shape);
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return fail(shape);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { return fail(shape); }
  const allowed = new Set<PropertyKey>(fields);
  if (Reflect.ownKeys(descriptors).some((key) => !allowed.has(key))) {
    return fail("unknown_field");
  }
  const result: Row = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true) return fail(shape);
    result[field] = descriptor.value;
  }
  return result;
}
function array(
  value: unknown,
  maximumLength = Number.MAX_SAFE_INTEGER,
): unknown[] {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    !Array.isArray(value)) return fail("invalid_state");
  let descriptors: PropertyDescriptorMap;
  let lengthValue: number;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return fail("invalid_state");
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (length === undefined || !("value" in length) ||
      !Number.isSafeInteger(length.value) || length.value < 0 ||
      length.value > maximumLength) return fail("invalid_state");
    lengthValue = length.value as number;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
      PropertyDescriptorMap;
  } catch { return fail("invalid_state"); }
  if (Reflect.ownKeys(descriptors).length !== lengthValue + 1) {
    return fail("invalid_state");
  }
  return Array.from({ length: lengthValue }, (_, index) => {
    const descriptor = descriptors[index.toString()];
    if (descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true) return fail("invalid_state");
    return descriptor.value;
  });
}
function text(value: unknown): string {
  if (typeof value !== "string" || value === "" || value.includes("\0")) {
    return fail("invalid_text");
  }
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail("invalid_integer");
  }
  return value;
}
function decimal(value: unknown, positive: boolean): string {
  if (typeof value !== "string" ||
    !(positive ? POSITIVE : NONNEGATIVE).test(value)) return fail("invalid_state");
  return value;
}
function ordered(values: readonly string[]): void {
  if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
    fail("invalid_state");
  }
}
function relativePath(value: unknown): string {
  if (value === "") return "";
  const path = text(value);
  const parts = path.split("/");
  if (isAbsolute(path) || path.includes("\\") ||
    parts.length > MAX_DISCOVERY_DEPTH ||
    parts.some((part) => part === "" || part === "." || part === "..")) {
    return fail("invalid_state");
  }
  return path;
}
function token(value: unknown): Token {
  const row = exact(value, ["device", "inode", "mtime_ns", "ctime_ns"], "invalid_state");
  return {
    device: decimal(row.device, true),
    inode: decimal(row.inode, true),
    mtime_ns: decimal(row.mtime_ns, false),
    ctime_ns: decimal(row.ctime_ns, false),
  };
}
function entries(value: unknown, maximumCount: number): Row[] {
  const result = array(value, maximumCount).map((candidate) => {
    const row = exact(candidate, ["name", "kind"], "invalid_state");
    const name = text(row.name);
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\") ||
      !ENTRY_KINDS.includes(row.kind as typeof ENTRY_KINDS[number])) {
      return fail("invalid_state");
    }
    return { name, kind: row.kind };
  });
  ordered(result.map((entry) => entry.name as string));
  return result;
}
function directories(value: unknown): { rows: Row[]; rootToken: Token } {
  const candidates = array(value, MAX_DISCOVERY_ENTRIES);
  let totalEntries = candidates.length;
  const rows = candidates.map((candidate) => {
    const row = exact(candidate, ["relative_path", "token", "entries"], "invalid_state");
    const normalizedPath = relativePath(row.relative_path);
    const normalizedToken = token(row.token);
    const normalizedEntries = entries(
      row.entries,
      MAX_DISCOVERY_ENTRIES - totalEntries,
    );
    totalEntries += normalizedEntries.length;
    return {
      relative_path: normalizedPath,
      token: normalizedToken,
      entries: normalizedEntries,
    };
  });
  if (rows.length === 0 || rows[0]!.relative_path !== "") return fail("invalid_state");
  ordered(rows.map((row) => row.relative_path as string));
  return { rows, rootToken: rows[0]!.token as Token };
}
function capability(value: unknown, root: string, rootToken: Token): Row {
  const kind = exact(value, ["kind", ...(exactKind(value) === "stable_directory_token"
    ? ["evidence"] : ["reason"])], "invalid_state");
  if (kind.kind === "full_scan_required") {
    if (!FULL_SCAN_REASONS.includes(kind.reason as typeof FULL_SCAN_REASONS[number])) {
      return fail("invalid_state");
    }
    return { kind: "full_scan_required", reason: kind.reason };
  }
  if (kind.kind !== "stable_directory_token") return fail("invalid_state");
  const evidence = exact(kind.evidence, [
    "kind", "platform", "node_major", "filesystem_type", "canonical_root",
    "root_device", "root_inode",
  ], "invalid_state");
  if (evidence.kind !== "darwin-apfs-v1" || evidence.platform !== "darwin" ||
    (evidence.node_major !== 22 && evidence.node_major !== 24) ||
    evidence.filesystem_type !== "26") return fail("invalid_state");
  const device = decimal(evidence.root_device, true);
  const inode = decimal(evidence.root_inode, true);
  if (evidence.canonical_root !== root || device !== rootToken.device ||
    inode !== rootToken.inode) return fail("foreign_binding");
  return { kind: "stable_directory_token", evidence: {
    kind: "darwin-apfs-v1", platform: "darwin", node_major: evidence.node_major,
    filesystem_type: "26", canonical_root: root,
    root_device: device, root_inode: inode,
  } };
}
function exactKind(value: unknown): unknown {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) ||
    Array.isArray(value)) return fail("invalid_state");
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return fail("invalid_state");
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
    if (descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true) return fail("invalid_state");
    return descriptor.value;
  } catch { return fail("invalid_state"); }
}
function tree(value: unknown, root: string): Row {
  const row = exact(value, ["schema_version", "capability", "directories"], "invalid_state");
  if (row.schema_version !== 1) return fail("invalid_state");
  const normalized = directories(row.directories);
  const normalizedCapability = capability(
    row.capability,
    root,
    normalized.rootToken,
  );
  if (normalizedCapability.kind === "stable_directory_token") {
    for (const directory of normalized.rows) {
      const directoryToken = directory.token as unknown as Token;
      if (!POSITIVE.test(directoryToken.mtime_ns) ||
        !POSITIVE.test(directoryToken.ctime_ns)) return fail("invalid_state");
      if (directoryToken.device !== normalized.rootToken.device) {
        return fail("foreign_binding");
      }
    }
  }
  return { schema_version: 1,
    capability: normalizedCapability,
    directories: normalized.rows };
}
function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(`ccprof\0${domain}\0`)
    .update(canonicalJson(value)).digest("hex");
}
function unsigned(root: SourceDiscoveryRoot): Omit<SourceDiscoveryRoot, "tree_digest"> {
  const { tree_digest: _digest, ...value } = root;
  return value;
}
export function validateSourceDiscoveryRoot(value: unknown): SourceDiscoveryRoot {
  const row = exact(value, FIELDS);
  if (typeof row.root_identity !== "string" || !ROOT_ID.test(row.root_identity)) {
    return fail("invalid_text");
  }
  const adapter = row.adapter_id === "claude" || row.adapter_id === "codex"
    ? row.adapter_id : fail("invalid_state");
  const canonicalRoot = text(row.canonical_root);
  if (!isAbsolute(canonicalRoot)) return fail("invalid_text");
  const cap = row.capability === "stable_directory_token" ||
      row.capability === "full_scan_required" ? row.capability : fail("invalid_state");
  if (row.sensitivity !== "sensitive" || row.retention_class !== "source_metadata") {
    return fail("foreign_binding");
  }
  const treeJson = row.tree_json;
  if (typeof treeJson !== "string" || treeJson === "") return fail("invalid_text");
  if (Buffer.byteLength(treeJson, "utf8") > MAX_DISCOVERY_TREE_BYTES) {
    return fail("invalid_state");
  }
  if (typeof row.tree_digest !== "string" || !SHA256.test(row.tree_digest)) {
    return fail("invalid_hash");
  }
  const result: SourceDiscoveryRoot = {
    root_identity: row.root_identity, adapter_id: adapter, canonical_root: canonicalRoot,
    cursor: integer(row.cursor), capability: cap, tree_json: treeJson,
    tree_digest: row.tree_digest, observed_at_ms: integer(row.observed_at_ms),
    completeness: row.completeness === "complete" || row.completeness === "partial"
      ? row.completeness : fail("invalid_state"),
    sensitivity: "sensitive", retention_class: "source_metadata",
  };
  if (result.tree_digest !== `sha256:${digest("source-discovery-tree-v1", unsigned(result))}`) {
    return fail("digest_mismatch");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(result.tree_json) as unknown; }
  catch { return fail("invalid_state"); }
  const normalized = tree(parsed, canonicalRoot);
  if (result.tree_json !== canonicalJson(normalized)) return fail("invalid_state");
  if (normalized.capability !== null &&
    (normalized.capability as Row).kind !== cap) return fail("foreign_binding");
  const expectedIdentity = `root-${digest("source-discovery-root-identity-v1", {
    adapter_id: adapter, canonical_root: canonicalRoot,
  })}`;
  if (result.root_identity !== expectedIdentity) return fail("foreign_binding");
  return result;
}
export function getSourceDiscoveryRoot(
  database: Database.Database,
  rootIdentity: unknown,
): SourceDiscoveryRoot | undefined {
  if (typeof rootIdentity !== "string" || !ROOT_ID.test(rootIdentity)) {
    return fail("invalid_text");
  }
  const row = database.prepare(
    `SELECT ${COLUMNS} FROM source_discovery_roots WHERE root_identity = ?`,
  ).get(rootIdentity);
  if (row === undefined) return undefined;
  try { return validateSourceDiscoveryRoot(row); }
  catch { return undefined; }
}
export function commitSourceDiscoveryRoot(
  database: Database.Database,
  value: unknown,
): SourceDiscoveryCommitResult {
  const candidate = validateSourceDiscoveryRoot(value);
  return database.transaction((): SourceDiscoveryCommitResult => {
    const current = getSourceDiscoveryRoot(database, candidate.root_identity);
    if (current !== undefined) {
      if (candidate.cursor < current.cursor) return "stale";
      if (candidate.cursor === current.cursor) {
        return FIELDS.every((field) => current[field] === candidate[field])
          ? "unchanged" : "conflict";
      }
      if (candidate.observed_at_ms <= current.observed_at_ms ||
        candidate.completeness === "partial") {
        return fail("progress_regression");
      }
    }
    database.prepare(`INSERT INTO source_discovery_roots(${COLUMNS})
      VALUES (${PARAMETERS}) ON CONFLICT(root_identity) DO UPDATE SET ${UPDATE}`)
      .run(candidate as unknown as Row);
    return current === undefined ? "inserted" : "updated";
  }).immediate();
}
