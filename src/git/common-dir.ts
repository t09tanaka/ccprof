import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Resolves symlinks when the path exists. A resolved-but-unverified fallback
 * keeps callers deterministic for paths that do not (yet) exist on disk.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Walks upward from `start` looking for a `.git` entry (directory or file).
 * Returns the marker's path, or undefined if none is found before the
 * filesystem root.
 */
export async function findGitMarker(start: string): Promise<string | undefined> {
  let current = start;
  try {
    if (!(await lstat(current)).isDirectory()) {
      current = dirname(current);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") current = dirname(current); else return undefined;
  }

  while (true) {
    const marker = join(current, ".git");
    try {
      await lstat(marker);
      return marker;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

/**
 * Resolves the git directory shared across a repository's main checkout and
 * any linked worktrees. For a main worktree this is the `.git` directory
 * itself; for a linked worktree it is resolved via the `gitdir:` marker file
 * and, when present, the `commondir` file inside that per-worktree git
 * directory. Older/synthetic worktrees without a `commondir` file are
 * identified from the standard `<git-dir>/worktrees/<name>` layout.
 */
export async function commonGitDirectory(
  start: string,
): Promise<string | undefined> {
  const marker = await findGitMarker(start);
  if (marker === undefined) {
    return undefined;
  }
  const markerStat = await lstat(marker);
  if (markerStat.isDirectory()) {
    return canonicalPath(marker);
  }

  let markerText: string;
  try {
    markerText = await readFile(marker, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+?)\s*$/im.exec(markerText);
  const gitDirText = match?.[1];
  if (gitDirText === undefined) {
    return undefined;
  }
  const gitDir = await canonicalPath(
    isAbsolute(gitDirText)
      ? gitDirText
      : resolve(dirname(marker), gitDirText),
  );

  try {
    const commonDirText = (await readFile(join(gitDir, "commondir"), "utf8"))
      .trim();
    if (commonDirText.length > 0) {
      return canonicalPath(resolve(gitDir, commonDirText));
    }
  } catch {
    // Older/synthetic worktrees can be identified from the standard layout.
  }
  const worktreesDirectory = dirname(gitDir);
  if (worktreesDirectory.endsWith(`${sep}worktrees`)) {
    return canonicalPath(dirname(worktreesDirectory));
  }
  return gitDir;
}
