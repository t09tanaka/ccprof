import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

import { commonGitDirectory } from "../git/common-dir.js";

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
 * Resolves symlinks for a path that is expected to exist. A normalized
 * absolute fallback keeps error reporting and test injection deterministic
 * for missing paths.
 */
async function realpathOrAbsolute(path: string): Promise<string> {
  try {
    return withoutTrailingSeparators(await realpath(path)).normalize("NFC");
  } catch {
    return normalizedAbsolute(path);
  }
}

/**
 * Resolves the canonical identity used to key the on-disk store. When
 * `repoRoot` sits inside a git repository, the shared git common directory
 * keys the store so that every linked `git worktree` shares one store with
 * the main checkout, including separate-git-dir and bare layouts. The common
 * directory maps to its parent for the conventional `<repo>/.git` layout so
 * the stored identity stays the repository root. Non-git directories
 * (including the temp dirs used in tests) fall back to a realpath of
 * `repoRoot` itself.
 */
export async function canonicalRepoPath(repoRoot: string): Promise<string> {
  const absolute = normalizedAbsolute(repoRoot);
  const gitDirectory = await commonGitDirectory(absolute);
  if (gitDirectory !== undefined) {
    return realpathOrAbsolute(
      basename(gitDirectory) === ".git"
        ? dirname(gitDirectory)
        : gitDirectory,
    );
  }
  return realpathOrAbsolute(absolute);
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
