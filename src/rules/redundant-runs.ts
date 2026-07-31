import { classifyCommand } from "../analysis/command.js";
import type { MatchedAction } from "../core/model.js";
import {
  createFindingCandidate,
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

function recipeFor(command: string) {
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
      `Use ${affected} for scoped edits, then keep \`${command}\` as the final full validation.`,
    verify: command,
  };
}

export function detectRedundantRuns(
  actions: readonly MatchedAction[],
) {
  const tools = orderedActions(actions).filter(
    (action) => normalizedCommand(action) !== undefined,
  );
  const redundantByCommand = new Map<string, MatchedAction[]>();
  for (const action of tools) {
    const command = normalizedCommand(action);
    if (command === undefined || action.match !== "redundant_run") continue;
    const group = redundantByCommand.get(command);
    if (group === undefined) redundantByCommand.set(command, [action]);
    else group.push(action);
  }

  return [...redundantByCommand.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([command, redundant]) => {
      const allRuns = tools.filter(
        (action) => normalizedCommand(action) === command,
      );
      const recoverable = recoverableClaim("R002", command, redundant);
      if (recoverable.estimated_ms === 0) return [];
      const descriptor = classifyCommand(command);
      return [createFindingCandidate({
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
        target: command,
        evidence: {
          session_refs: sortedUnique(
            allRuns.flatMap((action) => action.session_refs),
          ),
          interval_ids: recoverable.intervals.map(
            (interval) => interval.interval_id,
          ),
          command,
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
        fix_recipe: recipeFor(command),
        caveats: sortedUnique([
          ...redundant.flatMap((action) => action.caveats),
          ...(recoverable.bound === "upper"
            ? ["At least one run overlapped another agent, so recoverable time is an upper bound."]
            : []),
        ]),
      })];
    });
}
