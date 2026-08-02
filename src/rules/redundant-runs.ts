import { classifyCommand } from "../analysis/command.js";
import {
  commandIdentityKey,
  formatCommandIdentityTarget,
} from "../analysis/command-identity.js";
import type {
  CommandIdentity,
  MatchedAction,
} from "../core/model.js";
import {
  createFindingCandidate,
  findingKey,
  minimumConfidence,
  orderedActions,
  recoverableClaim,
  sortedUnique,
} from "./shared.js";

function normalizedCommand(action: MatchedAction): string | undefined {
  if (
    action.kind !== "tool" ||
    action.normalized_command === undefined ||
    action.normalized_command.trim() === ""
  ) {
    return undefined;
  }
  return action.normalized_command;
}

function recipeFor(command: string, identity: CommandIdentity) {
  const descriptor = classifyCommand(command);
  const executable = descriptor.tokens[0] ?? "";
  const affected =
    descriptor.ecosystem === "node" && executable !== ""
      ? `${executable} run test:affected`
      : descriptor.ecosystem === "cargo"
        ? "cargo test <affected-target>"
        : descriptor.ecosystem === "pytest"
          ? "pytest <affected-test-path>"
          : "an affected-only or targeted command";
  return {
    suggestion:
      `Use ${affected} for scoped edits in repository-relative CWD \`${identity.repo_relative_cwd}\`, then keep \`${command}\` as the final full validation.`,
    verify: command,
  };
}

function r002FindingKey(identity: CommandIdentity): string {
  const encoded = Buffer.from(commandIdentityKey(identity), "utf8").toString("hex");
  return findingKey("R002", `command-identity:${encoded}`);
}

export function detectRedundantRuns(
  actions: readonly MatchedAction[],
) {
  const tools = orderedActions(actions).filter(
    (action) =>
      normalizedCommand(action) !== undefined &&
      action.command_identity !== undefined,
  );
  const redundantByIdentity = new Map<
    string,
    { identity: CommandIdentity; redundant: MatchedAction[] }
  >();
  for (const action of tools) {
    const identity = action.command_identity;
    if (identity === undefined || action.match !== "redundant_run") continue;
    const key = commandIdentityKey(identity);
    const group = redundantByIdentity.get(key);
    if (group === undefined) {
      redundantByIdentity.set(key, { identity, redundant: [action] });
    } else {
      group.redundant.push(action);
    }
  }

  return [...redundantByIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([identityKey, { identity, redundant }]) => {
      const allRuns = tools.filter(
        (action) =>
          action.command_identity !== undefined &&
          commandIdentityKey(action.command_identity) === identityKey,
      );
      const firstRun = allRuns[0];
      const command = firstRun === undefined ? undefined : normalizedCommand(firstRun);
      if (command === undefined) return [];
      const baseTarget = formatCommandIdentityTarget(identity, command);
      const target = identity.executor === "native-tool"
        ? `${baseTarget} [native-tool]`
        : baseTarget;
      const recoverable = recoverableClaim("R002", target, redundant);
      if (recoverable.estimated_ms === 0) return [];
      const descriptor = classifyCommand(command);
      const candidate = createFindingCandidate({
        rule_id: "R002",
        title: "Redundant test or build runs",
        classification: "behavior",
        cause: null,
        scope: "this_pr",
        confidence: minimumConfidence(
          redundant.flatMap((action) => [
            action.confidence,
            action.match_confidence,
          ]),
        ),
        target,
        evidence: {
          session_refs: sortedUnique(
            allRuns.flatMap((action) => action.session_refs),
          ),
          interval_ids: recoverable.intervals.map(
            (interval) => interval.interval_id,
          ),
          command,
          command_identity: {
            repo_relative_cwd: identity.repo_relative_cwd,
            normalized_argv: [...identity.normalized_argv],
            executor: identity.executor,
          },
          count: allRuns.length,
          irrelevant_count: redundant.length,
          duration_ms: recoverable.estimated_ms,
          paths: sortedUnique(redundant.flatMap((action) => action.paths)),
          relevance: "irrelevant",
          prior_success_required: descriptor.scope !== "targeted",
          prior_success_proven: descriptor.scope !== "targeted",
          prior_success_basis: "matcher-classification",
        },
        recoverable,
        fix_recipe: recipeFor(command, identity),
        caveats: sortedUnique([
          ...redundant.flatMap((action) => action.caveats),
          ...(recoverable.bound === "upper"
            ? ["At least one run overlapped another agent, so recoverable time is an upper bound."]
            : []),
        ]),
      });
      return [{ ...candidate, finding_key: r002FindingKey(identity) }];
    });
}
