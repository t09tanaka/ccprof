import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AnalysisSummary,
  Finding,
} from "../src/core/model.js";
import { detectChronicCost } from "../src/rules/chronic-cost.js";
import {
  computeBaseline,
  loadAnalyses,
  makeAnalysisRecord,
  saveAnalysis,
  type AnalysisRecord,
} from "../src/store/analyses.js";
import {
  applyDismissals,
  dismissalDecision,
  loadDismissals,
  saveDismissal,
} from "../src/store/dismissals.js";
import {
  canonicalRepoPath,
  repoHash,
  resolveStorePaths,
  type StorePaths,
} from "../src/store/paths.js";

const summary: AnalysisSummary = {
  measured_min: 100,
  idle_excluded_min: 10,
  estimated_floor_min: 70,
  recoverable_min: 30,
  unexplained_min: 5,
  baseline: null,
};

function finding(
  key: string,
  command = "npm test",
  recoverableMin = 10,
): Finding {
  return {
    finding_key: key,
    rule_id: "R002",
    title: "Repeated command",
    classification: "behavior",
    cause: null,
    scope: "this_pr",
    confidence: "high",
    evidence: {
      session_refs: [`session#${key}`],
      interval_ids: [`R002:${key}`],
      command,
      duration_ms: recoverableMin * 60_000,
    },
    recoverable: { min: recoverableMin, bound: "point" },
    fix_recipe: {
      suggestion: "Run an affected-only test command.",
      verify: command,
    },
    caveats: [],
  };
}

function record(
  id: string,
  createdAtMs: number,
  options: {
    measuredMin?: number;
    command?: string;
    commandMin?: number;
    metric?: number;
    includeCommand?: boolean;
  } = {},
): AnalysisRecord {
  const measuredMin = options.measuredMin ?? 100;
  const command = options.command ?? "npm test";
  return makeAnalysisRecord({
    analysis_id: id,
    created_at_ms: createdAtMs,
    unit: {
      repo: "/repo",
      pr_ref: `main...${id}`,
      sessions: [`session-${id}`],
    },
    summary: { ...summary, measured_min: measuredMin },
    findings: [finding(`finding-${id}`, command, options.commandMin ?? 10)],
    metrics: {
      human_wait_ratio: options.metric ?? createdAtMs,
    },
    command_costs: options.includeCommand === false
      ? []
      : [{
          command,
          duration_min: options.commandMin ?? 10,
          session_refs: [`session-${id}#run`],
        }],
  });
}

async function temporaryStore(
  callback: (paths: StorePaths, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-store-test-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    const paths = await resolveStorePaths(repo, {
      env: { CCPROF_DATA_DIR: join(root, "data") },
      home_dir: join(root, "home"),
    });
    await callback(paths, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
}

test("canonicalRepoPath resolves a linked git worktree to the main worktree's repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-worktree-canon-"));
  try {
    const mainRepo = join(root, "main");
    await mkdir(mainRepo);
    git(["init", "-q"], mainRepo);
    git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"], mainRepo);

    const worktreePath = join(root, "worktree");
    git(["worktree", "add", "-q", "-b", "worktree-branch", worktreePath], mainRepo);

    const expected = (await realpath(mainRepo)).normalize("NFC");
    assert.equal(await canonicalRepoPath(mainRepo), expected);
    assert.equal(await canonicalRepoPath(worktreePath), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonicalRepoPath unifies worktrees of a separate-git-dir repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-separate-gitdir-canon-"));
  try {
    const mainRepo = join(root, "main");
    const gitDir = join(root, "shared-git-dir");
    await mkdir(mainRepo);
    git(["init", "-q", `--separate-git-dir=${gitDir}`], mainRepo);
    git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-q", "-m", "init"], mainRepo);

    const worktreePath = join(root, "worktree");
    git(["worktree", "add", "-q", "-b", "separate-worktree-branch", worktreePath], mainRepo);

    assert.equal(
      await canonicalRepoPath(worktreePath),
      await canonicalRepoPath(mainRepo),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonicalRepoPath falls back to a realpath when the directory is not a git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-non-git-canon-"));
  try {
    const plain = join(root, "not-a-repo");
    await mkdir(plain);
    const expected = (await realpath(plain)).normalize("NFC");
    assert.equal(await canonicalRepoPath(plain), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store paths hash the canonical repository and honor data-root precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-path-test-"));
  try {
    const repo = join(root, "repo");
    const alias = join(root, "repo-alias");
    await mkdir(repo);
    await symlink(repo, alias);
    const canonical = await realpath(repo);
    assert.equal(await canonicalRepoPath(alias), canonical.normalize("NFC"));
    assert.equal(
      repoHash(canonical),
      createHash("sha256").update(canonical).digest("hex"),
    );

    const explicit = await resolveStorePaths(alias, {
      env: {
        CCPROF_DATA_DIR: join(root, "explicit"),
        XDG_DATA_HOME: join(root, "xdg"),
      },
      home_dir: join(root, "home"),
    });
    assert.equal(
      explicit.repo_dir,
      join(root, "explicit", repoHash(canonical)),
    );

    const xdg = await resolveStorePaths(repo, {
      env: { XDG_DATA_HOME: join(root, "xdg") },
      home_dir: join(root, "home"),
    });
    assert.equal(xdg.repo_dir, join(root, "xdg", "ccprof", repoHash(canonical)));

    const fallback = await resolveStorePaths(repo, {
      env: {},
      home_dir: join(root, "home"),
    });
    assert.equal(
      fallback.repo_dir,
      join(root, "home", ".local", "share", "ccprof", repoHash(canonical)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analysis records are immutable, complete, atomically indexed, and stably ordered", async () => {
  await temporaryStore(async (paths) => {
    const later = record("later", 200);
    const earlier = record("earlier", 100);
    assert.deepEqual((await saveAnalysis(paths, later)).warnings, []);
    assert.deepEqual((await saveAnalysis(paths, earlier)).warnings, []);

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(
      loaded.records.map(({ analysis_id }) => analysis_id),
      ["earlier", "later"],
    );
    assert.deepEqual(loaded.records[1]?.findings, later.findings);
    assert.equal(loaded.records[1]?.findings.length, 1);

    const index = JSON.parse(await readFile(paths.history_index_path, "utf8")) as {
      analyses: { analysis_id: string }[];
    };
    assert.deepEqual(
      index.analyses.map(({ analysis_id }) => analysis_id),
      ["earlier", "later"],
    );
    const files = [
      ...(await readdir(paths.repo_dir)),
      ...(await readdir(paths.analyses_dir)),
    ];
    assert.equal(files.some((path) => path.endsWith(".tmp")), false);
  });
});

test("corrupt indexes rebuild from immutable records and corrupt records are skipped", async () => {
  await temporaryStore(async (paths) => {
    await saveAnalysis(paths, record("good", 100));
    await writeFile(paths.history_index_path, "{not json", "utf8");
    await writeFile(join(paths.analyses_dir, "broken.json"), "{bad", "utf8");
    await writeFile(
      join(paths.analyses_dir, "null-finding.json"),
      JSON.stringify({
        ...record("null-finding", 200),
        findings: [null],
      }),
      "utf8",
    );
    await writeFile(
      join(paths.analyses_dir, "bad-evidence.json"),
      JSON.stringify({
        ...record("bad-evidence", 300),
        findings: [{
          ...finding("bad-evidence"),
          evidence: null,
        }],
      }),
      "utf8",
    );

    const loaded = await loadAnalyses(paths);
    assert.deepEqual(
      loaded.records.map(({ analysis_id }) => analysis_id),
      ["good"],
    );
    assert.ok(
      loaded.warnings.some(({ code }) => code === "corrupt_history_index"),
    );
    assert.ok(
      loaded.warnings.some(({ code }) => code === "corrupt_analysis_record"),
    );
    assert.equal(
      loaded.warnings.filter(
        ({ code }) => code === "corrupt_analysis_record",
      ).length,
      3,
    );
  });
});

test("analysis write failures return warnings without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-write-failure-"));
  try {
    const blockingFile = join(root, "blocked");
    await writeFile(blockingFile, "not a directory", "utf8");
    const paths: StorePaths = {
      canonical_repo: "/repo",
      repo_hash: "hash",
      root_dir: root,
      repo_dir: blockingFile,
      analyses_dir: join(blockingFile, "analyses"),
      history_index_path: join(blockingFile, "index.json"),
      dismissals_path: join(blockingFile, "dismissals.json"),
    };
    const result = await saveAnalysis(paths, record("write-failure", 100));
    assert.equal(result.record.analysis_id, "write-failure");
    assert.ok(result.warnings.some(({ code }) => code === "analysis_write_failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline uses only the previous ten analyses and stays null below three", () => {
  const histories = Array.from({ length: 12 }, (_, index) =>
    record(`history-${String(index + 1).padStart(2, "0")}`, index + 1, {
      metric: index + 1,
    })
  );
  const current = record("current", 20, { metric: 99 });

  assert.equal(computeBaseline(current, histories.slice(0, 2)), null);
  const baseline = computeBaseline(current, [...histories, current]);
  assert.ok(baseline !== null);
  assert.equal(baseline.prs, 10);
  assert.deepEqual(
    baseline.notable.find(({ metric }) => metric === "human_wait_ratio"),
    { metric: "human_wait_ratio", value: 99, baseline: 7.5 },
  );
});

test("dismissals expire exactly at 14 days and revive only strictly over twice strength", () => {
  const day = 24 * 60 * 60 * 1_000;
  const dismissal = {
    schema_version: 1 as const,
    finding_key: "finding-a",
    target: "npm test",
    dismissed_at_ms: 1_000,
    strength_min: 10,
    reason: "Not worth changing yet.",
  };

  assert.equal(
    dismissalDecision(dismissal, 20, 1_000 + (14 * day) - 1).suppressed,
    true,
  );
  assert.equal(
    dismissalDecision(dismissal, 20, 1_000 + (14 * day)).suppressed,
    false,
  );
  assert.equal(
    dismissalDecision(dismissal, 20, 1_000 + (14 * day) + 1).suppressed,
    false,
  );
  assert.equal(
    dismissalDecision(dismissal, 20, 1_001).suppressed,
    true,
  );
  const revived = dismissalDecision(dismissal, 20.01, 1_001);
  assert.equal(revived.suppressed, false);
  assert.equal(revived.revived, true);
  assert.match(revived.caveat ?? "", /Not worth changing yet\./u);

  const applied = applyDismissals(
    [finding("finding-a", "npm test", 20.01)],
    [dismissal],
    1_001,
  );
  assert.equal(applied.findings.length, 1);
  assert.match(applied.findings[0]?.caveats[0] ?? "", /Previously dismissed/u);
});

test("dismissals persist reasons and report write failures as warnings", async () => {
  await temporaryStore(async (paths, root) => {
    const saved = await saveDismissal(paths, {
      finding_key: "finding-a",
      target: "npm test",
      dismissed_at_ms: 1_000,
      strength_min: 10,
      reason: "Local trade-off.",
    });
    assert.deepEqual(saved.warnings, []);
    const loaded = await loadDismissals(paths);
    assert.equal(loaded.records[0]?.reason, "Local trade-off.");

    const blockingFile = join(root, "dismissal-block");
    await writeFile(blockingFile, "not a directory", "utf8");
    const blocked: StorePaths = {
      ...paths,
      repo_dir: blockingFile,
      dismissals_path: join(blockingFile, "dismissals.json"),
    };
    const failed = await saveDismissal(blocked, {
      finding_key: "finding-b",
      target: "cargo test",
      dismissed_at_ms: 2_000,
      strength_min: 5,
    });
    assert.ok(
      failed.warnings.some(({ code }) => code === "dismissal_write_failed"),
    );
  });
});

test("R006 requires five histories, presence in three, and a 30 percent cost ratio", () => {
  const qualifying = Array.from({ length: 5 }, (_, index) =>
    record(`r006-${index}`, index, {
      commandMin: index < 3 ? 50 : 0,
      includeCommand: index < 3,
    })
  );
  const findings = detectChronicCost(qualifying);
  assert.equal(findings.length, 1);
  const chronic = findings[0];
  assert.ok(chronic !== undefined);
  assert.equal(chronic.rule_id, "R006");
  assert.equal(chronic.classification, "repo");
  assert.equal(chronic.scope, "separate_issue");
  assert.equal(chronic.target, "npm test");
  assert.equal(chronic.evidence.history_count, 5);
  assert.equal(chronic.evidence.presence_count, 3);
  assert.equal(chronic.evidence.cost_ratio, 0.3);
  assert.equal(chronic.evidence.minimum_history_count, 5);
  assert.equal(chronic.evidence.minimum_presence_count, 3);
  assert.equal(chronic.evidence.minimum_cost_ratio, 0.3);
  assert.equal(chronic.recoverable.bound, "upper");

  assert.deepEqual(detectChronicCost(qualifying.slice(0, 4)), []);
  assert.deepEqual(
    detectChronicCost(
      qualifying.map((entry, index) =>
        index < 2 ? entry : record(`presence-${index}`, index, {
          includeCommand: false,
        })
      ),
    ),
    [],
  );
  assert.deepEqual(
    detectChronicCost(
      Array.from({ length: 5 }, (_, index) =>
        record(`ratio-${index}`, index, {
          commandMin: index < 3 ? 49.99 : 0,
          includeCommand: index < 3,
        })
      ),
    ),
    [],
  );
});

test("R006 defensively ignores malformed finding evidence at its boundary", () => {
  const histories = Array.from({ length: 5 }, (_, index) =>
    record(`defensive-${index}`, index, {
      commandMin: index < 3 ? 50 : 0,
      includeCommand: index < 3,
    })
  );
  histories[0] = {
    ...histories[0] as AnalysisRecord,
    findings: [null] as unknown as Finding[],
  };
  histories[1] = {
    ...histories[1] as AnalysisRecord,
    findings: [{
      ...finding("bad-evidence"),
      evidence: null,
    }] as unknown as Finding[],
  };

  assert.equal(detectChronicCost(histories).length, 1);
});
