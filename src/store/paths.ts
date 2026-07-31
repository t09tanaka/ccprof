import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

export interface StorePathOptions {
  env?: NodeJS.ProcessEnv;
  home_dir?: string;
}

export interface StorePaths {
  canonical_repo: string;
  repo_hash: string;
  root_dir: string;
  repo_dir: string;
  analyses_dir: string;
  history_index_path: string;
  dismissals_path: string;
}

function withoutTrailingSeparators(path: string): string {
  const root = parse(path).root;
  if (path === root) return path;
  return path.replace(/[\\/]+$/u, "");
}

function normalizedAbsolute(path: string): string {
  return withoutTrailingSeparators(resolve(path)).normalize("NFC");
}

/**
 * Resolves symlinks when the repository exists. A normalized absolute fallback
 * keeps error reporting and test injection deterministic for missing paths.
 */
export async function canonicalRepoPath(repoRoot: string): Promise<string> {
  const absolute = normalizedAbsolute(repoRoot);
  try {
    return withoutTrailingSeparators(await realpath(absolute)).normalize("NFC");
  } catch {
    return absolute;
  }
}

export function repoHash(canonicalRepo: string): string {
  return createHash("sha256")
    .update(withoutTrailingSeparators(canonicalRepo).normalize("NFC"))
    .digest("hex");
}

function configuredDataRoot(
  options: StorePathOptions,
): string {
  const env = options.env ?? process.env;
  const explicit = env.CCPROF_DATA_DIR?.trim();
  if (explicit !== undefined && explicit !== "") {
    return normalizedAbsolute(explicit);
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg !== undefined && xdg !== "") {
    return join(normalizedAbsolute(xdg), "ccprof");
  }
  const configuredHome = options.home_dir?.trim();
  const home = configuredHome !== undefined && configuredHome !== ""
    ? configuredHome
    : homedir();
  return join(normalizedAbsolute(home), ".local", "share", "ccprof");
}

export async function resolveStorePaths(
  repoRoot: string,
  options: StorePathOptions = {},
): Promise<StorePaths> {
  const canonicalRepo = await canonicalRepoPath(repoRoot);
  const hash = repoHash(canonicalRepo);
  const rootDir = configuredDataRoot(options);
  const repoDir = join(rootDir, hash);
  return {
    canonical_repo: canonicalRepo,
    repo_hash: hash,
    root_dir: rootDir,
    repo_dir: repoDir,
    analyses_dir: join(repoDir, "analyses"),
    history_index_path: join(repoDir, "index.json"),
    dismissals_path: join(repoDir, "dismissals.json"),
  };
}
