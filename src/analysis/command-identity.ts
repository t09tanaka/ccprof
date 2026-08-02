import { posix, win32 } from "node:path";

import type { CommandDescriptor } from "./command.js";
import type {
  CommandExecutor,
  CommandIdentity,
} from "../core/model.js";

type PathFlavor = "posix" | "windows";

function pathFlavor(value: string): PathFlavor | undefined {
  if (/^(?:[A-Za-z]:[\\/]|\\\\[^\\])/u.test(value)) return "windows";
  return value.startsWith("/") ? "posix" : undefined;
}

export function deriveRepoRelativeCwd(
  repoRoot: string | undefined,
  cwd: string | undefined,
): string | undefined {
  if (repoRoot === undefined || cwd === undefined) return undefined;
  const flavor = pathFlavor(repoRoot);
  if (flavor === undefined || pathFlavor(cwd) !== flavor) return undefined;
  const paths = flavor === "windows" ? win32 : posix;
  if (!paths.isAbsolute(repoRoot) || !paths.isAbsolute(cwd)) return undefined;
  const relative = paths.relative(paths.resolve(repoRoot), paths.resolve(cwd));
  if (relative === "") return ".";
  if (
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  ) {
    return undefined;
  }
  return flavor === "windows" ? relative.replaceAll("\\", "/") : relative;
}

export function buildCommandIdentity(
  repoRoot: string | undefined,
  cwd: string | undefined,
  descriptor: CommandDescriptor,
  executor: CommandExecutor = "shell",
): CommandIdentity | undefined {
  if (
    descriptor.opaque ||
    descriptor.tokens.length === 0 ||
    descriptor.tokens[0] === ""
  ) {
    return undefined;
  }
  const repoRelativeCwd = deriveRepoRelativeCwd(repoRoot, cwd);
  return repoRelativeCwd === undefined
    ? undefined
    : {
        repo_relative_cwd: repoRelativeCwd,
        normalized_argv: [...descriptor.tokens],
        executor,
      };
}

export function commandIdentityKey(identity: CommandIdentity): string {
  return JSON.stringify([
    identity.repo_relative_cwd,
    identity.normalized_argv,
    identity.executor,
  ]);
}

export function formatCommandIdentityTarget(
  identity: CommandIdentity,
  normalizedCommand: string,
): string {
  return `${identity.repo_relative_cwd} :: ${normalizedCommand}`;
}
