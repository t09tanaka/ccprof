import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Session } from "../core/model.js";
import {
  canonicalPath,
  commonGitDirectory,
  findGitMarker,
} from "../git/common-dir.js";

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
}

function toolEventCwds(session: Session): string[] {
  return session.events.flatMap((event) =>
    event.kind === "tool_use" &&
      event.cwd !== undefined &&
      event.cwd !== ""
      ? [event.cwd]
      : []
  );
}

type CwdMapper = (cwd: string) => Promise<string>;

async function mapSessionCwds(
  session: Session,
  mapper: CwdMapper,
): Promise<Session> {
  const distinctCwds = [...new Set([
    ...session.observed_cwds,
    ...toolEventCwds(session),
    ...session.events.flatMap((event) => event.kind === "tool_use"
      ? event.paths.filter(isAbsolute) : []),
  ])];
  const mappedCwds = new Map(
    await Promise.all(
      distinctCwds.map(async (cwd) => [cwd, await mapper(cwd)] as const),
    ),
  );
  const events = session.events.map((event) => event.kind !== "tool_use" ? event : {
    ...event,
    paths: event.paths.map((path) => isAbsolute(path) ? mappedCwds.get(path) ?? path : path),
    ...(event.cwd === undefined || event.cwd === "" ? {}
      : { cwd: mappedCwds.get(event.cwd) ?? event.cwd }),
  });
  return {
    ...session,
    observed_cwds: [...new Set([
      ...session.observed_cwds.map((cwd) => mappedCwds.get(cwd) ?? cwd),
      ...toolEventCwds({ ...session, events }),
    ])],
    events,
  };
}

export async function canonicalizeSessionCwds(
  session: Session,
): Promise<Session> {
  return mapSessionCwds(session, canonicalPath);
}

export async function cwdMatchesRepository(
  repoRoot: string,
  cwds: string[],
): Promise<boolean> {
  if (cwds.some((cwd) => isWithin(repoRoot, cwd))) return true;
  const repoGitDirectory = await commonGitDirectory(repoRoot);
  if (repoGitDirectory === undefined) return false;
  for (const cwd of cwds) {
    if (await commonGitDirectory(cwd) === repoGitDirectory) return true;
  }
  return false;
}

async function rebaseWorktreeCwd(
  cwd: string,
  repoRoot: string,
  repoGitDirectory: string | undefined,
): Promise<string> {
  if (repoGitDirectory === undefined) return cwd;
  const [marker, cwdGitDirectory] = await Promise.all([
    findGitMarker(cwd),
    commonGitDirectory(cwd),
  ]);
  if (
    marker === undefined ||
    cwdGitDirectory === undefined ||
    cwdGitDirectory !== repoGitDirectory
  ) return cwd;
  const worktreeRoot = await canonicalPath(dirname(marker));
  if (!isWithin(worktreeRoot, cwd)) return cwd;
  const relativeCwd = relative(worktreeRoot, cwd);
  if (
    isAbsolute(relativeCwd) ||
    relativeCwd === ".." ||
    relativeCwd.startsWith(`..${sep}`)
  ) return cwd;
  const rebased = await canonicalPath(resolve(repoRoot, relativeCwd));
  return isWithin(repoRoot, rebased) ? rebased : cwd;
}

export async function alignSessionCwdsToRepository(
  session: Session,
  repoRoot: string,
): Promise<Session> {
  const repoGitDirectory = await commonGitDirectory(repoRoot);
  return mapSessionCwds(
    session,
    async (cwd) => rebaseWorktreeCwd(cwd, repoRoot, repoGitDirectory),
  );
}
