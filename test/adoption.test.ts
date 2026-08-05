import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { AnalysisSummary, Finding } from "../src/core/model.js";

import {
  detectability,
  detectAdoptions,
  findingFingerprint,
  suggestionKeywords,
  type AdoptionCandidateFinding,
} from "../src/analysis/adoption.js";
import { makeAnalysisRecord } from "../src/store/analyses.js";
import {
  runCommand,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "../src/git/client.js";

interface Call {
  command: string;
  args: string[];
  options: CommandOptions | undefined;
}

function fakeRunner(
  respond: (call: Call) => CommandResult,
): { calls: Call[]; runner: CommandRunner } {
  const calls: Call[] = [];
  return {
    calls,
    runner: async (command, args, options) => {
      const call = { command, args: [...args], options };
      calls.push(call);
      return respond(call);
    },
  };
}

async function git(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const result = await runCommand("git", args, { cwd, env, timeoutMs: 10_000 });
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function makeRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.name", "ccprof test"]);
  await git(repo, ["config", "user.email", "ccprof@example.invalid"]);
  return repo;
}

async function commit(
  repo: string,
  files: Record<string, string>,
  message: string,
  isoDate: string,
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await write(join(repo, path), content);
  }
  await git(repo, ["add", ...Object.keys(files)]);
  await git(repo, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  });
  return git(repo, ["rev-parse", "HEAD"]);
}

function baseCandidate(
  overrides: Partial<AdoptionCandidateFinding> = {},
): AdoptionCandidateFinding {
  return {
    finding_key: "finding-1",
    rule_id: "R001",
    scope: "claude_md",
    suggestion: "Add a lint step to CLAUDE.md before merging changes",
    recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

// --- suggestionKeywords -----------------------------------------------

test("suggestionKeywords is deterministic: normalizes, dedupes, sorts, and caps at 8", () => {
  const suggestion =
    "Run the Linter linter again! Running running tests, tests, and more Tests. abc ab a";
  const first = suggestionKeywords(suggestion);
  const second = suggestionKeywords(suggestion);
  assert.deepEqual(first, second);
  // "abc" has length 3, "ab"/"a" too short; all kept tokens length >= 4.
  assert.ok(first.every((token) => token.length >= 4));
  // dedupe: "linter"/"running"/"tests" collapse regardless of case/punctuation
  assert.equal(new Set(first).size, first.length);
  // sorted ascending
  assert.deepEqual(first, [...first].sort());
  assert.ok(first.length <= 8);
  // "Tests." keeps its trailing period (a "." is a token character, not a
  // separator, so path-like suggestions such as "src/foo.ts" stay intact)
  // and is therefore distinct from the comma-terminated "tests" tokens.
  assert.deepEqual(first, ["again", "linter", "more", "running", "tests", "tests."]);
});

test("suggestionKeywords splits on non letter/number/underscore/dot/slash/dash and caps at 8 entries", () => {
  const words = Array.from({ length: 12 }, (_, index) => `word${String(index).padStart(2, "0")}`);
  const keywords = suggestionKeywords(words.join(", "));
  assert.equal(keywords.length, 8);
  assert.deepEqual(keywords, [...keywords].sort());
});

test("suggestionKeywords sorts non-ASCII tokens by code point, not locale collation, and caps at 8", () => {
  // Nine distinct 4-character CJK ideograph tokens at consecutive code
  // points (U+4E00..U+4E08). A locale-aware comparator (e.g. `localeCompare`
  // under a non-root/non-"en" locale) can reorder these relative to a plain
  // code-point comparison, so asserting the exact expected order guards
  // against regressing to a non-deterministic sort.
  const tokensByCodePoint = Array.from({ length: 9 }, (_, index) =>
    String.fromCodePoint(0x4e00 + index).repeat(4)
  );
  const shuffledOrder = [8, 3, 0, 6, 1, 7, 4, 2, 5];
  const shuffledSuggestion = shuffledOrder
    .map((index) => String.fromCodePoint(0x4e00 + index).repeat(4))
    .join(" ");

  const keywords = suggestionKeywords(shuffledSuggestion);

  assert.deepEqual(keywords, tokensByCodePoint.slice(0, 8));
});

// --- findingFingerprint -------------------------------------------------

test("findingFingerprint is stable for identical input and changes with any field", () => {
  const finding = {
    scope: "claude_md" as const,
    rule_id: "R001" as const,
    fix_recipe: { suggestion: "  Add   a lint step.  ", verify: "npm test" },
    target: "src/a.ts",
  };
  const first = findingFingerprint(finding);
  const second = findingFingerprint({
    ...finding,
    fix_recipe: { ...finding.fix_recipe },
  });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);

  assert.notEqual(first, findingFingerprint({ ...finding, scope: "this_pr" }));
  assert.notEqual(first, findingFingerprint({ ...finding, rule_id: "R002" }));
  assert.notEqual(first, findingFingerprint({ ...finding, target: "src/b.ts" }));
  assert.notEqual(
    first,
    findingFingerprint({
      ...finding,
      fix_recipe: { ...finding.fix_recipe, suggestion: "Add a different step." },
    }),
  );
  assert.equal(
    first,
    findingFingerprint({
      ...finding,
      fix_recipe: { ...finding.fix_recipe, suggestion: "Add a lint step." },
    }),
    "whitespace normalization should not change the fingerprint",
  );
});

test("findingFingerprint treats a missing target as an empty string", () => {
  const withoutTarget = findingFingerprint({
    scope: "this_pr",
    rule_id: "R003",
    fix_recipe: { suggestion: "do the thing", verify: "" },
  });
  const withEmptyTarget = findingFingerprint({
    scope: "this_pr",
    rule_id: "R003",
    fix_recipe: { suggestion: "do the thing", verify: "" },
    target: "",
  });
  assert.equal(withoutTarget, withEmptyTarget);
});

test("findingFingerprint preserves the exact legacy digest for instruction resources", () => {
  const shared = {
    rule_id: "R001" as const,
    target: "src/a.ts",
    fix_recipe: { suggestion: "  Add   a lint step.  ", verify: "npm test" },
  };
  const legacy = findingFingerprint({ ...shared, scope: "claude_md" });
  const canonical = findingFingerprint({
    ...shared,
    scope: "instruction_resource",
  });

  assert.equal(canonical, legacy);
  assert.equal(
    canonical,
    "fbe029e3ac7575f5b1953a86eacff4af9164196a77fb4187cc61d9c8339581fc",
  );
});

test("findingFingerprint rejects malformed scope identities without echoing content", () => {
  for (const scope of [
    "INSTRUCTION_RESOURCE",
    " instruction_resource",
    "instruction_resource ",
    "instruction_resource\0must-not-leak",
    "must-not-leak",
  ]) {
    assert.throws(
      () => findingFingerprint({
        scope,
        rule_id: "R001",
        fix_recipe: { suggestion: "Add a lint step.", verify: "" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "invalid finding scope: invalid_finding_scope");
        assert.doesNotMatch(error.message, /must-not-leak/u);
        return true;
      },
    );
  }
});

test("legacy finding normalization preserves adoption and compatibility identity", () => {
  const legacy: Finding = {
    finding_key: "stable-adoption-key",
    rule_id: "R002",
    rule_version: "1.0.0",
    compatibility_epoch: 1,
    title: "Repeated command",
    target: "src/a.ts",
    classification: "behavior",
    cause: null,
    scope: "claude_md",
    confidence: "high",
    evidence: { session_refs: ["s1#e1"], interval_ids: ["R002:e1"] },
    recoverable: { min: 2, bound: "point" },
    fix_recipe: {
      suggestion: "Add the focused command to CLAUDE.md.",
      verify: "npm test",
    },
    caveats: [],
  };
  const summary: AnalysisSummary = {
    measured_min: 2,
    idle_excluded_min: 0,
    estimated_floor_min: 2,
    recoverable_min: 0,
    human_wait_min: 0,
    unexplained_min: 2,
    baseline: null,
  };
  const normalized = makeAnalysisRecord({
    analysis_id: "identity-roundtrip",
    created_at_ms: 1,
    unit: { repo: "/repo", pr_ref: "main...feature", sessions: ["s1"] },
    summary,
    findings: [legacy],
  }).findings[0];

  assert.ok(normalized !== undefined);
  assert.equal(normalized.finding_key, legacy.finding_key);
  assert.equal(normalized.rule_version, legacy.rule_version);
  assert.equal(normalized.compatibility_epoch, legacy.compatibility_epoch);
  assert.equal(findingFingerprint(normalized), findingFingerprint(legacy));
});

// --- detectability --------------------------------------------------------

test("detectability normalizes legacy and canonical instruction-resource scopes", () => {
  assert.equal(
    detectability({ scope: "claude_md", rule_id: "R001" }),
    "instruction_resource",
  );
  assert.equal(
    detectability({ scope: "instruction_resource", rule_id: "R001" }),
    "instruction_resource",
  );
});

test("detectability routes R008 or separate_issue with a resolvable target to target_file", () => {
  assert.equal(
    detectability({ scope: "separate_issue", rule_id: "R002", target: "src/a.ts" }),
    "target_file",
  );
  assert.equal(
    detectability({ scope: "this_pr", rule_id: "R008", target: "src/a.ts" }),
    "target_file",
  );
});

test("detectability is undetectable for this_pr scope, missing target, or unresolvable target", () => {
  assert.equal(
    detectability({ scope: "this_pr", rule_id: "R001" }),
    "undetectable",
  );
  assert.equal(
    detectability({ scope: "separate_issue", rule_id: "R002" }),
    "undetectable",
  );
  assert.equal(
    detectability({ scope: "separate_issue", rule_id: "R002", target: "../outside" }),
    "undetectable",
  );
  assert.equal(
    detectability({ scope: "separate_issue", rule_id: "R002", target: "/etc/passwd" }),
    "undetectable",
  );
});

// --- detectAdoptions: claude_md ------------------------------------------

test("detectAdoptions canonicalizes legacy and neutral candidates for fixed CLAUDE.md evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-claudemd-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "CLAUDE.md": "# Project rules\n\nBe nice.\n" },
      "base",
      "2025-12-31T00:00:00.000Z",
    );
    const candidate = baseCandidate({
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      suggestion: "Add a lint step before merging changes",
    });
    const canonicalCandidate = baseCandidate({
      finding_key: "finding-canonical",
      scope: "instruction_resource",
      recorded_at_ms: candidate.recorded_at_ms,
      suggestion: candidate.suggestion,
    });
    const adoptCommit = await commit(
      repo,
      { "CLAUDE.md": "# Project rules\n\nBe nice.\nAdd a lint step before merging.\n" },
      "adopt suggestion",
      "2026-01-02T00:00:00.000Z",
    );

    const result = await detectAdoptions({
      repoRoot: repo,
      candidates: [candidate, canonicalCandidate],
      detectedAtMs: Date.parse("2026-01-03T00:00:00.000Z"),
    });

    assert.deepEqual(result.warnings, []);
    assert.equal(result.adoptions.length, 2);
    const [adoption, canonicalAdoption] = result.adoptions;
    assert.equal(adoption?.finding_key, candidate.finding_key);
    assert.equal(adoption?.rule_id, candidate.rule_id);
    assert.equal(adoption?.scope, "instruction_resource");
    assert.equal(adoption?.method, "instruction_resource_edit");
    assert.equal(adoption?.detected_at_ms, Date.parse("2026-01-03T00:00:00.000Z"));
    assert.equal(adoption?.evidence.commit, adoptCommit);
    assert.equal(adoption?.evidence.path, "CLAUDE.md");
    assert.equal(
      adoption?.fingerprint,
      findingFingerprint({
        scope: "instruction_resource",
        rule_id: candidate.rule_id,
        fix_recipe: { suggestion: candidate.suggestion, verify: "" },
        ...(candidate.target === undefined ? {} : { target: candidate.target }),
      }),
    );
    assert.deepEqual(canonicalAdoption, {
      ...adoption,
      finding_key: canonicalCandidate.finding_key,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectAdoptions is deterministic across repeated runs against the same repo state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-determinism-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "CLAUDE.md": "# Project rules\n" },
      "base",
      "2025-12-31T00:00:00.000Z",
    );
    const candidate = baseCandidate({
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      suggestion: "Add a lint step before merging changes",
    });
    await commit(
      repo,
      { "CLAUDE.md": "# Project rules\nAdd a lint step before merging.\n" },
      "adopt suggestion",
      "2026-01-02T00:00:00.000Z",
    );

    const options = {
      repoRoot: repo,
      candidates: [candidate],
      detectedAtMs: Date.parse("2026-01-03T00:00:00.000Z"),
    };
    const first = await detectAdoptions(options);
    const second = await detectAdoptions(options);
    assert.deepEqual(first, second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectAdoptions does not detect a claude_md adoption when matching edits predate recorded_at_ms", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-too-old-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "CLAUDE.md": "# Project rules\nAdd a lint step before merging.\n" },
      "base already has the suggestion text",
      "2025-01-01T00:00:00.000Z",
    );
    const candidate = baseCandidate({
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      suggestion: "Add a lint step before merging changes",
    });

    const result = await detectAdoptions({
      repoRoot: repo,
      candidates: [candidate],
      detectedAtMs: Date.parse("2026-01-03T00:00:00.000Z"),
    });

    assert.deepEqual(result.adoptions, []);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectAdoptions does not detect a claude_md adoption when the later commit lacks matching keywords", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-no-keyword-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "CLAUDE.md": "# Project rules\n" },
      "base",
      "2025-12-31T00:00:00.000Z",
    );
    const candidate = baseCandidate({
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      suggestion: "Add a lint step before merging changes",
    });
    await commit(
      repo,
      { "CLAUDE.md": "# Project rules\nSomething entirely unrelated.\n" },
      "unrelated edit",
      "2026-01-02T00:00:00.000Z",
    );

    const result = await detectAdoptions({
      repoRoot: repo,
      candidates: [candidate],
      detectedAtMs: Date.parse("2026-01-03T00:00:00.000Z"),
    });

    assert.deepEqual(result.adoptions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectAdoptions never adopts via claude_md when the suggestion has no keywords of length >= 4", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-empty-keywords-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "CLAUDE.md": "# Project rules\n" },
      "base",
      "2025-12-31T00:00:00.000Z",
    );
    const candidate = baseCandidate({
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      suggestion: "do it ok",
    });
    assert.deepEqual(suggestionKeywords(candidate.suggestion), []);
    await commit(
      repo,
      { "CLAUDE.md": "# Project rules\nDo it ok now, always.\n" },
      "edit after recorded_at_ms",
      "2026-01-02T00:00:00.000Z",
    );

    const result = await detectAdoptions({
      repoRoot: repo,
      candidates: [candidate],
      detectedAtMs: Date.parse("2026-01-03T00:00:00.000Z"),
    });

    assert.deepEqual(result.adoptions, []);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectAdoptions attributes claude_md evidence to the oldest qualifying commit, not the newest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-claudemd-oldest-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "CLAUDE.md": "# Project rules\n\nBe nice.\n" },
      "base",
      "2025-12-31T00:00:00.000Z",
    );
    const candidate = baseCandidate({
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
      suggestion: "Add a lint step before merging changes",
    });
    const olderQualifying = await commit(
      repo,
      { "CLAUDE.md": "# Project rules\n\nBe nice.\nAdd a lint step before merging.\n" },
      "adopt suggestion (older, qualifies)",
      "2026-01-02T00:00:00.000Z",
    );
    await commit(
      repo,
      {
        "CLAUDE.md":
          "# Project rules\n\nBe nice.\nAdd a lint step before merging.\nDocument the lint step for reviewers.\n",
      },
      "adopt suggestion further (newer, also qualifies)",
      "2026-01-03T00:00:00.000Z",
    );

    const result = await detectAdoptions({
      repoRoot: repo,
      candidates: [candidate],
      detectedAtMs: Date.parse("2026-01-04T00:00:00.000Z"),
    });

    assert.equal(result.adoptions.length, 1);
    assert.equal(result.adoptions[0]?.evidence.commit, olderQualifying);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- detectAdoptions: target_file -----------------------------------------

test("detectAdoptions detects a target_file adoption when the target is edited after recorded_at_ms", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-target-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "src/flaky.test.ts": "// flaky test\n" },
      "base",
      "2025-12-31T00:00:00.000Z",
    );
    const candidate = baseCandidate({
      scope: "separate_issue",
      rule_id: "R008",
      target: "src/flaky.test.ts",
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    const fixCommit = await commit(
      repo,
      { "src/flaky.test.ts": "// fixed flaky test\n" },
      "fix flaky test",
      "2026-01-02T00:00:00.000Z",
    );

    const result = await detectAdoptions({
      repoRoot: repo,
      candidates: [candidate],
      detectedAtMs: Date.parse("2026-01-03T00:00:00.000Z"),
    });

    assert.equal(result.adoptions.length, 1);
    const [adoption] = result.adoptions;
    assert.equal(adoption?.method, "target_file_edit");
    assert.equal(adoption?.evidence.commit, fixCommit);
    assert.equal(adoption?.evidence.path, "src/flaky.test.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectAdoptions attributes target_file evidence to the oldest qualifying commit, not the newest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-target-oldest-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "src/flaky.test.ts": "// flaky test\n" },
      "base",
      "2025-12-31T00:00:00.000Z",
    );
    const candidate = baseCandidate({
      scope: "separate_issue",
      rule_id: "R008",
      target: "src/flaky.test.ts",
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    const olderFix = await commit(
      repo,
      { "src/flaky.test.ts": "// fixed flaky test (attempt 1)\n" },
      "fix flaky test (older, qualifies)",
      "2026-01-02T00:00:00.000Z",
    );
    await commit(
      repo,
      { "src/flaky.test.ts": "// fixed flaky test (attempt 2)\n" },
      "fix flaky test again (newer, also qualifies)",
      "2026-01-03T00:00:00.000Z",
    );

    const result = await detectAdoptions({
      repoRoot: repo,
      candidates: [candidate],
      detectedAtMs: Date.parse("2026-01-04T00:00:00.000Z"),
    });

    assert.equal(result.adoptions.length, 1);
    assert.equal(result.adoptions[0]?.evidence.commit, olderFix);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectAdoptions does not let a target's pathspec magic/fnmatch match unrelated committed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-target-pathspec-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "src/foo.ts": "// original\n" },
      "base",
      "2025-12-31T00:00:00.000Z",
    );
    // "sr?/foo.ts" is accepted by normalizeRepoPath (only `*` is rejected
    // outside glob mode) but, without `:(literal)`, git's pathspec magic
    // would fnmatch the `?` against "src/foo.ts" and treat the edit below
    // as evidence of adoption for a target that was never actually touched.
    const candidate = baseCandidate({
      scope: "separate_issue",
      rule_id: "R008",
      target: "sr?/foo.ts",
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    await commit(
      repo,
      { "src/foo.ts": "// edited after recorded_at_ms\n" },
      "edit unrelated file that fnmatch would have matched",
      "2026-01-02T00:00:00.000Z",
    );

    const result = await detectAdoptions({
      repoRoot: repo,
      candidates: [candidate],
      detectedAtMs: Date.parse("2026-01-03T00:00:00.000Z"),
    });

    assert.deepEqual(result.adoptions, []);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectAdoptions finds no target_file adoption when the target was never edited afterward", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-adoption-target-untouched-"));
  try {
    const repo = await makeRepo(root);
    await commit(
      repo,
      { "src/flaky.test.ts": "// flaky test\n" },
      "base",
      "2025-12-31T00:00:00.000Z",
    );
    const candidate = baseCandidate({
      scope: "separate_issue",
      rule_id: "R008",
      target: "src/flaky.test.ts",
      recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
    });

    const result = await detectAdoptions({
      repoRoot: repo,
      candidates: [candidate],
      detectedAtMs: Date.parse("2026-01-03T00:00:00.000Z"),
    });

    assert.deepEqual(result.adoptions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- detectAdoptions: undetectable ----------------------------------------

test("detectAdoptions skips this_pr candidates without running git", async () => {
  const fixture = fakeRunner(() => {
    throw new Error("git should not be invoked for undetectable candidates");
  });
  const candidate = baseCandidate({
    scope: "this_pr",
    rule_id: "R001",
  });

  const result = await detectAdoptions({
    repoRoot: "/repo",
    candidates: [candidate],
    runner: fixture.runner,
    detectedAtMs: 0,
  });

  assert.deepEqual(result.adoptions, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(fixture.calls, []);
});

// --- detectAdoptions: git failures ----------------------------------------

test("detectAdoptions reports adoption_detection_failed and skips claude_md candidates when git fails", async () => {
  const fixture = fakeRunner(() => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }));
  const candidate = baseCandidate();

  const result = await detectAdoptions({
    repoRoot: "/repo",
    candidates: [candidate],
    runner: fixture.runner,
    detectedAtMs: 0,
  });

  assert.deepEqual(result.adoptions, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, "adoption_detection_failed");
});

test("detectAdoptions reports adoption_detection_failed and skips claude_md candidates when git output is truncated", async () => {
  const fixture = fakeRunner(() => ({
    code: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: true,
  }));
  const candidate = baseCandidate();

  const result = await detectAdoptions({
    repoRoot: "/repo",
    candidates: [candidate],
    runner: fixture.runner,
    detectedAtMs: 0,
  });

  assert.deepEqual(result.adoptions, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, "adoption_detection_failed");
  assert.match(result.warnings[0]?.message ?? "", /truncat/u);
});

test("detectAdoptions reports adoption_detection_failed and skips a target_file candidate when git times out", async () => {
  const fixture = fakeRunner(() => ({
    code: 124,
    stdout: "",
    stderr: "",
    timedOut: true,
  }));
  const candidate = baseCandidate({
    scope: "separate_issue",
    rule_id: "R008",
    target: "src/a.ts",
    recorded_at_ms: 0,
  });

  const result = await detectAdoptions({
    repoRoot: "/repo",
    candidates: [candidate],
    runner: fixture.runner,
    detectedAtMs: 0,
  });

  assert.deepEqual(result.adoptions, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, "adoption_detection_failed");
  assert.match(result.warnings[0]?.message ?? "", /timed out/u);
});

test("detectAdoptions reports adoption_detection_failed and skips only the failing target_file candidate", async () => {
  const okOid = "a".repeat(40);
  const okSeconds = Math.floor(Date.parse("2026-01-02T00:00:00.000Z") / 1_000);
  const fixture = fakeRunner(({ args }) => {
    if (args.includes(":(literal)src/ok.ts")) {
      return { code: 0, stdout: `${okOid}\x00${okSeconds}\n`, stderr: "" };
    }
    return { code: 128, stdout: "", stderr: "fatal: bad revision" };
  });
  const failing = baseCandidate({
    finding_key: "finding-fail",
    scope: "separate_issue",
    rule_id: "R008",
    target: "src/broken.ts",
    recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
  });
  const ok = baseCandidate({
    finding_key: "finding-ok",
    scope: "separate_issue",
    rule_id: "R008",
    target: "src/ok.ts",
    recorded_at_ms: Date.parse("2026-01-01T00:00:00.000Z"),
  });

  const result = await detectAdoptions({
    repoRoot: "/repo",
    candidates: [failing, ok],
    runner: fixture.runner,
    detectedAtMs: 0,
  });

  assert.equal(result.adoptions.length, 1);
  assert.equal(result.adoptions[0]?.finding_key, "finding-ok");
  assert.equal(result.adoptions[0]?.evidence.commit, okOid);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, "adoption_detection_failed");
});
