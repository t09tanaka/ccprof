import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalRecommendationDecision,
  canonicalRuleSafetySnapshot,
  commandPatternMatches,
  compareUtf8,
  createDecisionBudget,
  normalizeCommandPattern,
  resolveRuleSafetyPolicy,
  resourceDomainDecision,
  RuleSafetyPolicyValidationError,
  safeCanonicalCommand,
  snapshotApprovalRulePolicy,
  snapshotEffectiveRuleSafetyPolicy,
  snapshotRepositoryApprovalRulePolicy,
  snapshotResourceDomains,
  type ApprovalRulePolicy,
  type EffectiveRuleSafetyPolicy,
  type RepositoryApprovalRulePolicy,
  type ResourceDomainPolicy,
} from "../src/policy/rule-safety.js";
import { analysisDigest } from "../src/store/analyses.js";

function assertInvalid(
  action: () => unknown,
  canaries: readonly string[] = [],
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RuleSafetyPolicyValidationError);
    assert.equal(error.message, "invalid rule safety policy");
    for (const canary of canaries) {
      assert.equal(error.message.includes(canary), false);
    }
    return true;
  });
}

function resolvedPolicy(
  organizationApproval?: ApprovalRulePolicy,
  organizationDomains?: ResourceDomainPolicy[],
  repositoryApproval?: RepositoryApprovalRulePolicy,
  repositoryDomains?: ResourceDomainPolicy[],
): EffectiveRuleSafetyPolicy {
  const useDefaults = arguments.length === 0;
  return resolveRuleSafetyPolicy(
    useDefaults
      ? { safe_patterns: ["npm *"], allow_rule_recommendation: true }
      : organizationApproval,
    useDefaults
      ? [{
          match: ["npm *"],
          domain: "node-workspace",
          parallel_safe: true,
        }]
      : (organizationDomains ?? []),
    repositoryApproval,
    repositoryDomains,
  );
}

test("normalizes bounded literal-wildcard patterns deterministically", () => {
  assert.equal(normalizeCommandPattern("  npm\t test  "), "npm test");
  assert.equal(normalizeCommandPattern("rg *** src"), "rg * src");
  assert.equal(normalizeCommandPattern("e\u0301"), "é");
  assert.equal(normalizeCommandPattern("a\n\r\tb"), "a b");
  assert.equal(normalizeCommandPattern("*a".repeat(16)), "*a".repeat(16));

  assertInvalid(() => normalizeCommandPattern(""));
  assertInvalid(() => normalizeCommandPattern(" \t\n "));
  assertInvalid(() => normalizeCommandPattern("npm\0test"));
  assertInvalid(() => normalizeCommandPattern("*a".repeat(17)));
});

test("checks raw and normalized pattern UTF-8 byte limits", () => {
  assert.equal(normalizeCommandPattern("a".repeat(256)), "a".repeat(256));
  assert.equal(normalizeCommandPattern("é".repeat(128)), "é".repeat(128));

  assertInvalid(() => normalizeCommandPattern("a".repeat(257)));
  assertInvalid(() => normalizeCommandPattern("é".repeat(129)));

  // This raw form is 258 bytes but NFC would shrink it to 172 bytes. Rejection
  // proves that the raw byte boundary is checked before normalization.
  assertInvalid(() => normalizeCommandPattern("e\u0301".repeat(86)));

  // U+0344 expands under NFC, so this starts at exactly 256 bytes but exceeds
  // the limit only after normalization.
  const expandsUnderNfc = "\u0344".repeat(128);
  assert.equal(Buffer.byteLength(expandsUnderNfc), 256);
  assert.ok(Buffer.byteLength(expandsUnderNfc.normalize("NFC")) > 256);
  assertInvalid(() => normalizeCommandPattern(expandsUnderNfc));
});

test("matches whole commands with literal regex punctuation and a shared budget", () => {
  assert.equal(commandPatternMatches(
    "npm test",
    "npm *",
    createDecisionBudget(),
  ), true);
  assert.equal(commandPatternMatches(
    "npm test extra",
    "npm test",
    createDecisionBudget(),
  ), false);
  assert.equal(commandPatternMatches(
    "rg [a].(x)+?^$",
    "rg [a].(x)+?^$",
    createDecisionBudget(),
  ), true);
  assert.equal(commandPatternMatches(
    "prefix npm test suffix",
    "npm test",
    createDecisionBudget(),
  ), false);
  assert.equal(commandPatternMatches(
    "npm test",
    "npm test *",
    createDecisionBudget(),
  ), false);

  const exact = { remaining: 1, exhausted: false };
  assert.equal(commandPatternMatches("a", "a", exact), true);
  assert.deepEqual(exact, { remaining: 0, exhausted: false });

  const exhausted = { remaining: 1, exhausted: false };
  assert.equal(commandPatternMatches("aa", "aa", exhausted), false);
  assert.deepEqual(exhausted, { remaining: 0, exhausted: true });
});

test("orders strings by locale-independent UTF-8 bytes", () => {
  assert.ok(compareUtf8("z", "ä") < 0);
  assert.ok(compareUtf8("ä", "z") > 0);
  assert.equal(compareUtf8("same", "same"), 0);

  const values = ["ä", "z", "a", "é", "e\u0301"];
  const actual = values.map((value) => value.normalize("NFC")).sort(compareUtf8);
  const expected = values
    .map((value) => value.normalize("NFC"))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  assert.deepEqual(actual, expected);
});

test("snapshots approval contracts with closed keys and normalized ordering", () => {
  assert.deepEqual(snapshotApprovalRulePolicy({
    safe_patterns: ["ä", " npm\t test ", "z"],
    allow_rule_recommendation: true,
  }), {
    safe_patterns: ["npm test", "z", "ä"],
    allow_rule_recommendation: true,
  });
  assert.deepEqual(snapshotRepositoryApprovalRulePolicy({
    allow_rule_recommendation: false,
  }), {
    allow_rule_recommendation: false,
  });
  assert.deepEqual(snapshotRepositoryApprovalRulePolicy({
    safe_patterns: ["npm *"],
  }), {
    safe_patterns: ["npm *"],
  });

  assertInvalid(() => snapshotApprovalRulePolicy({
    safe_patterns: ["npm test", " npm\t test "],
    allow_rule_recommendation: true,
  }));
  assertInvalid(() => snapshotApprovalRulePolicy({
    safe_patterns: ["npm test"],
    allow_rule_recommendation: true,
    extra: true,
  }));
  assert.deepEqual(snapshotRepositoryApprovalRulePolicy({}), {});
});

test("enforces approval pattern count boundaries", () => {
  const sixtyFour = Array.from({ length: 64 }, (_, index) => `npm test ${index}`);
  assert.equal(snapshotApprovalRulePolicy({
    safe_patterns: sixtyFour,
    allow_rule_recommendation: true,
  }).safe_patterns.length, 64);
  assertInvalid(() => snapshotApprovalRulePolicy({
    safe_patterns: [...sixtyFour, "npm test 64"],
    allow_rule_recommendation: true,
  }));
});

test("orders resource entries by the full tuple and rejects exact duplicates", () => {
  const snapshot = snapshotResourceDomains([
    { match: ["npm test"], domain: "z", parallel_safe: true },
    {
      match: ["npm test", " cargo\t test "],
      domain: "a",
      parallel_safe: true,
    },
    { match: ["npm test"], domain: "a", parallel_safe: true },
    { match: ["npm test"], domain: "a", parallel_safe: false },
  ]);
  assert.deepEqual(snapshot, [
    {
      match: ["cargo test", "npm test"],
      domain: "a",
      parallel_safe: true,
    },
    { match: ["npm test"], domain: "a", parallel_safe: false },
    { match: ["npm test"], domain: "a", parallel_safe: true },
    { match: ["npm test"], domain: "z", parallel_safe: true },
  ]);

  assertInvalid(() => snapshotResourceDomains([
    {
      match: ["npm test", "cargo test"],
      domain: "build",
      parallel_safe: true,
    },
    {
      match: [" cargo\t test ", " npm test "],
      domain: "build",
      parallel_safe: true,
    },
  ]));
  assertInvalid(() => snapshotResourceDomains([{
    match: ["npm test", " npm\t test "],
    domain: "build",
    parallel_safe: true,
  }]));
});

test("enforces resource-domain structural and size boundaries", () => {
  const domains = Array.from({ length: 64 }, (_, index) => ({
    match: [`npm test ${index}`],
    domain: `domain-${index}`,
    parallel_safe: index % 2 === 0,
  }));
  assert.equal(snapshotResourceDomains(domains).length, 64);
  assertInvalid(() => snapshotResourceDomains([
    ...domains,
    { match: ["npm test extra"], domain: "domain-64", parallel_safe: true },
  ]));

  const patterns = Array.from({ length: 32 }, (_, index) => `npm test ${index}`);
  assert.equal(snapshotResourceDomains([{
    match: patterns,
    domain: "a".repeat(64),
    parallel_safe: true,
  }])[0]?.match.length, 32);
  assertInvalid(() => snapshotResourceDomains([{
    match: [...patterns, "npm test 32"],
    domain: "build",
    parallel_safe: true,
  }]));
  assertInvalid(() => snapshotResourceDomains([{
    match: ["npm test"],
    domain: "a".repeat(65),
    parallel_safe: true,
  }]));

  for (const domain of ["", "Upper", "-leading", "space value", "a/b"]) {
    assertInvalid(() => snapshotResourceDomains([{
      match: ["npm test"],
      domain,
      parallel_safe: true,
    }]));
  }
});

test("rejects hostile objects without invoking traps or leaking content", () => {
  const canary = "POLICY_CANARY_9f5c4e";
  let getterCalls = 0;
  const accessor: Record<string, unknown> = {
    allow_rule_recommendation: true,
  };
  Object.defineProperty(accessor, "safe_patterns", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return [canary];
    },
  });
  assertInvalid(() => snapshotApprovalRulePolicy(accessor), [canary]);
  assert.equal(getterCalls, 0);

  let proxyTrapCalls = 0;
  const proxy = new Proxy({
    safe_patterns: [canary],
    allow_rule_recommendation: true,
  }, {
    ownKeys: () => {
      proxyTrapCalls += 1;
      throw new Error(canary);
    },
  });
  assertInvalid(() => snapshotApprovalRulePolicy(proxy), [canary]);
  assert.equal(proxyTrapCalls, 0);

  const revocable = Proxy.revocable({
    safe_patterns: [canary],
    allow_rule_recommendation: true,
  }, {});
  revocable.revoke();
  assertInvalid(() => snapshotApprovalRulePolicy(revocable.proxy), [canary]);

  const sparse = new Array<string>(1);
  assertInvalid(() => snapshotApprovalRulePolicy({
    safe_patterns: sparse,
    allow_rule_recommendation: true,
  }));

  let arrayTrapCalls = 0;
  const proxiedPatterns = new Proxy([canary], {
    getOwnPropertyDescriptor: () => {
      arrayTrapCalls += 1;
      throw new Error(canary);
    },
  });
  assertInvalid(() => snapshotApprovalRulePolicy({
    safe_patterns: proxiedPatterns,
    allow_rule_recommendation: true,
  }), [canary]);
  assert.equal(arrayTrapCalls, 0);

  const symbol = Symbol(canary);
  const symbolKeyed = {
    safe_patterns: ["npm test"],
    allow_rule_recommendation: true,
    [symbol]: canary,
  };
  assertInvalid(() => snapshotApprovalRulePolicy(symbolKeyed), [canary]);

  class PolicySubclass {
    readonly safe_patterns = ["npm test"];
    readonly allow_rule_recommendation = true;
  }
  assertInvalid(() => snapshotApprovalRulePolicy(new PolicySubclass()));

  let entryGetterCalls = 0;
  const entry: Record<string, unknown> = {
    match: ["npm test"],
    parallel_safe: true,
  };
  Object.defineProperty(entry, "domain", {
    enumerable: true,
    get: () => {
      entryGetterCalls += 1;
      return canary;
    },
  });
  assertInvalid(() => snapshotResourceDomains([entry]), [canary]);
  assert.equal(entryGetterCalls, 0);

  const sparseDomains = new Array<ResourceDomainPolicy>(1);
  assertInvalid(() => snapshotResourceDomains(sparseDomains));

  const symbolEntry = {
    match: ["npm test"],
    domain: "node",
    parallel_safe: true,
    [Symbol(canary)]: canary,
  };
  assertInvalid(() => snapshotResourceDomains([symbolEntry]), [canary]);
});

test("recognizes only independently safe bare commands", () => {
  const allowed = new Map<string, string>([
    ["npm test", "npm test"],
    ["npm run build", "npm run build"],
    ["pnpm check", "pnpm check"],
    ["yarn build", "yarn build"],
    ["bun test test/a.test.ts", "bun test test/a.test.ts"],
    ["cargo test crate_name", "cargo test crate_name"],
    ["cargo build --release", "cargo build --release"],
    ["cargo check", "cargo check"],
    ["pytest tests/test_a.py", "pytest tests/test_a.py"],
    ["python3 -m pytest -q", "python3 -m pytest -q"],
    ["rg TODO src", "rg TODO src"],
    ["cat package.json", "cat package.json"],
    ["git show HEAD", "git show HEAD"],
    ["git diff --check", "git diff --check"],
    ["node --test", "node --test"],
    ["node --test test/a.test.js", "node --test test/a.test.js"],
  ]);
  for (const [raw, canonical] of allowed) {
    assert.equal(safeCanonicalCommand(raw), canonical, raw);
  }

  const denied = [
    "rm -rf .",
    "unknown-tool inspect",
    "npm install",
    "npm publish",
    "cargo run",
    "git checkout main",
    "git commit -m nope",
    "git push",
    "git clean -fdx",
    "FOO=1 npm test",
    "env npm test",
    "command npm test",
    "npm test > result.txt",
    "npm test 2>&1",
    "npm test && touch sentinel",
    "npm test | tee result.txt",
    "npm test\ntouch sentinel",
    "npm $(printf test)",
    "/tmp/npm test",
    "./cargo test",
    "../bin/rg TODO",
    "C:\\tools\\npm.cmd test",
    "C:/tools/npm.cmd test",
    "node script.js",
    "node -e console.log(1)",
  ];
  for (const raw of denied) {
    assert.equal(safeCanonicalCommand(raw), undefined, raw);
  }
});

test("normalizes only the fixed bare Windows launcher aliases", () => {
  const allowed = new Map<string, string>([
    ["NPM.CMD test", "npm test"],
    ["pnpm.cmd run check", "pnpm run check"],
    ["YARN.CMD build", "yarn build"],
    ["BUN.EXE test", "bun test"],
    ["cargo.exe check", "cargo check"],
    ["GIT.EXE show HEAD", "git show HEAD"],
    ["RG.EXE TODO src", "rg TODO src"],
    ["NODE.EXE --test", "node --test"],
    ["node.exe --test test/a.test.js", "node --test test/a.test.js"],
  ]);
  for (const [raw, canonical] of allowed) {
    assert.equal(safeCanonicalCommand(raw), canonical, raw);
  }

  for (const raw of [
    "npm.bat test",
    "npm.exe test",
    "cargo.cmd test",
    "rg.cmd TODO",
    "unknown.cmd test",
    "unknown.exe test",
    "node.exe script.js",
    "node.exe -e console.log(1)",
    ".\\npm.cmd test",
    "C:\\tools\\node.exe --test",
  ]) {
    assert.equal(safeCanonicalCommand(raw), undefined, raw);
  }
});

test("rejects rg preprocessors and git grep pagers through every decision path", () => {
  const pagerOption = "--open-files-in-pager";
  const pagerAbbreviations = Array.from(
    { length: pagerOption.length - "--op".length + 1 },
    (_, index) => pagerOption.slice(0, "--op".length + index),
  ).flatMap((option) => [option, `${option}=sh`]);
  const dangerous = [
    "rg --pre cat TODO src",
    "rg --pre=cat TODO src",
    "git grep -O TODO",
    "git grep -Oless TODO",
    "git grep -nO TODO",
    "git grep -nOsh TODO",
    "git grep --open-files-in-pager TODO",
    "git grep --open-files-in-pager=less TODO",
    "git grep --open-files-in-page=sh TODO",
    ...pagerAbbreviations.map((option) => `git grep ${option} TODO`),
  ];
  const wildcard = resolvedPolicy(
    { safe_patterns: ["*"], allow_rule_recommendation: true },
    [{ match: ["*"], domain: "read-only", parallel_safe: true }],
  );
  for (const raw of dangerous) {
    assert.equal(safeCanonicalCommand(raw), undefined, raw);
    assert.deepEqual(approvalRecommendationDecision([raw], wildcard), {
      kind: "evaluated",
      commands: [{ allowed: false }],
    }, raw);
    assert.deepEqual(resourceDomainDecision([raw], wildcard), {
      kind: "investigation_candidate",
    }, raw);
  }
});

test("rejects shell and environment expansion regardless of quote provenance", () => {
  const dangerous = [
    "npm test -- $HOME",
    "npm test -- '${HOME}'",
    "npm test -- '$HOME'",
    "npm test -- '$?'",
    "npm test -- '%TEMP%'",
    "npm test -- \"%TEMP%\"",
    "npm test -- '!TEMP!'",
    "npm test -- \"!TEMP!\"",
  ];
  const wildcard = resolvedPolicy(
    { safe_patterns: ["*"], allow_rule_recommendation: true },
    [{ match: ["*"], domain: "validation", parallel_safe: true }],
  );
  for (const raw of dangerous) {
    assert.equal(safeCanonicalCommand(raw), undefined, raw);
    assert.deepEqual(approvalRecommendationDecision([raw], wildcard), {
      kind: "evaluated",
      commands: [{ allowed: false }],
    }, raw);
    assert.deepEqual(resourceDomainDecision([raw], wildcard), {
      kind: "investigation_candidate",
    }, raw);
  }
});

test("rejects Windows expansion and composite syntax through every decision path", () => {
  const dangerous = [
    "npm test -- !foo",
    "npm test -- !!",
    "npm test -- %0",
    "npm test -- %*",
    "npm test -- %~dp0",
    "npm test -- %~f1",
    "npm test -- %%A",
    "npm.cmd test 'x&calc'",
    "npm.cmd test x\\&calc",
  ];
  const wildcard = resolvedPolicy(
    { safe_patterns: ["*"], allow_rule_recommendation: true },
    [{ match: ["*"], domain: "validation", parallel_safe: true }],
  );
  for (const raw of dangerous) {
    assert.equal(safeCanonicalCommand(raw), undefined, raw);
    assert.deepEqual(approvalRecommendationDecision([raw], wildcard), {
      kind: "evaluated",
      commands: [{ allowed: false }],
    }, raw);
    assert.deepEqual(resourceDomainDecision([raw], wildcard), {
      kind: "investigation_candidate",
    }, raw);
  }
});

test("rejects cross-shell composite provenance for plain Windows launchers", () => {
  const dangerous = [
    "npm test 'x&calc'",
    "npm test x\\&calc",
    "pnpm test 'x&calc'",
    "pnpm test x\\&calc",
  ];
  const wildcard = resolvedPolicy(
    { safe_patterns: ["*"], allow_rule_recommendation: true },
    [{ match: ["*"], domain: "validation", parallel_safe: true }],
  );
  for (const raw of dangerous) {
    assert.equal(safeCanonicalCommand(raw), undefined, raw);
    assert.deepEqual(approvalRecommendationDecision([raw], wildcard), {
      kind: "evaluated",
      commands: [{ allowed: false }],
    }, raw);
    assert.deepEqual(resourceDomainDecision([raw], wildcard), {
      kind: "investigation_candidate",
    }, raw);
  }
});

test("rejects Windows caret provenance through every decision path", () => {
  const raw = "npm.cmd test ^\"x&calc^\"";
  const wildcard = resolvedPolicy(
    { safe_patterns: ["*"], allow_rule_recommendation: true },
    [{ match: ["*"], domain: "validation", parallel_safe: true }],
  );
  assert.equal(safeCanonicalCommand(raw), undefined);
  assert.deepEqual(approvalRecommendationDecision([raw], wildcard), {
    kind: "evaluated",
    commands: [{ allowed: false }],
  });
  assert.deepEqual(resourceDomainDecision([raw], wildcard), {
    kind: "investigation_candidate",
  });
});

test("rejects active ripgrep decompressor flags without consuming literals", () => {
  const dangerous = [
    "rg -z TODO src",
    "rg -nz TODO src",
    "rg -nzi TODO src",
    "rg --search-zip TODO src",
  ];
  const safe = [
    "rg --no-search-zip TODO src",
    "rg -- -z src",
    "rg -- --search-zip src",
  ];
  const wildcard = resolvedPolicy(
    { safe_patterns: ["*"], allow_rule_recommendation: true },
    [{ match: ["*"], domain: "read-only", parallel_safe: true }],
  );
  for (const raw of dangerous) {
    assert.equal(safeCanonicalCommand(raw), undefined, raw);
    assert.deepEqual(approvalRecommendationDecision([raw], wildcard), {
      kind: "evaluated",
      commands: [{ allowed: false }],
    }, raw);
    assert.deepEqual(resourceDomainDecision([raw], wildcard), {
      kind: "investigation_candidate",
    }, raw);
  }
  for (const raw of safe) {
    assert.equal(safeCanonicalCommand(raw), raw, raw);
    assert.deepEqual(approvalRecommendationDecision([raw], wildcard), {
      kind: "evaluated",
      commands: [{ allowed: true, canonical_command: raw }],
    }, raw);
    assert.deepEqual(resourceDomainDecision([raw], wildcard), {
      kind: "parallel_safe",
      domain: "read-only",
    }, raw);
  }
});

test("rejects every bounded external-helper option abbreviation", () => {
  const textconv = "--textconv";
  const extGrep = "--ext-grep";
  const textconvAbbreviations = Array.from(
    { length: textconv.length - "--textc".length + 1 },
    (_, index) => textconv.slice(0, "--textc".length + index),
  );
  const extGrepAbbreviations = Array.from(
    { length: extGrep.length - "--ext-".length + 1 },
    (_, index) => extGrep.slice(0, "--ext-".length + index),
  );
  const dangerous = [
    "rg --hostname-bin hostname TODO src",
    "rg --hostname-bin=hostname TODO src",
    ...textconvAbbreviations.flatMap((option) => [
      `git grep ${option} TODO`,
      `git grep ${option}=true TODO`,
    ]),
    ...extGrepAbbreviations.map((option) => `git grep ${option} TODO`),
  ];
  const wildcard = resolvedPolicy(
    { safe_patterns: ["*"], allow_rule_recommendation: true },
    [{ match: ["*"], domain: "read-only", parallel_safe: true }],
  );
  for (const raw of dangerous) {
    assert.equal(safeCanonicalCommand(raw), undefined, raw);
    assert.deepEqual(approvalRecommendationDecision([raw], wildcard), {
      kind: "evaluated",
      commands: [{ allowed: false }],
    }, raw);
    assert.deepEqual(resourceDomainDecision([raw], wildcard), {
      kind: "investigation_candidate",
    }, raw);
  }
});

test("rejects unpaired UTF-16 before NFC and UTF-8 canonicalization", () => {
  for (const invalidUnicode of [
    "\ud800",
    "\udfff",
    "before\ud800after",
    "before\udfffafter",
  ]) {
    assertInvalid(() => normalizeCommandPattern(invalidUnicode));
    assertInvalid(() => compareUtf8(invalidUnicode, "valid"));
    assertInvalid(() => snapshotApprovalRulePolicy({
      safe_patterns: [invalidUnicode],
      allow_rule_recommendation: true,
    }));
    assertInvalid(() => snapshotResourceDomains([{
      match: [invalidUnicode],
      domain: "validation",
      parallel_safe: true,
    }]));
    assert.equal(
      safeCanonicalCommand(`npm test -- ${invalidUnicode}`),
      undefined,
    );
  }
});

test("keeps supplementary Unicode policy digests invariant under reversal", () => {
  const patterns = ["npm test 😀", "npm test 𐀀", "npm test 🧪"];
  const forward = resolveRuleSafetyPolicy(
    { safe_patterns: patterns, allow_rule_recommendation: true },
    patterns.map((pattern, index) => ({
      match: [pattern],
      domain: `unicode-${index}`,
      parallel_safe: index % 2 === 0,
    })),
  );
  const reverse = resolveRuleSafetyPolicy(
    { safe_patterns: [...patterns].reverse(), allow_rule_recommendation: true },
    patterns.map((pattern, index) => ({
      match: [pattern],
      domain: `unicode-${index}`,
      parallel_safe: index % 2 === 0,
    })).reverse(),
  );
  assert.deepEqual(
    canonicalRuleSafetySnapshot(reverse),
    canonicalRuleSafetySnapshot(forward),
  );
  assert.equal(
    analysisDigest(
      "effective-rule-safety-v1",
      canonicalRuleSafetySnapshot(reverse),
    ),
    analysisDigest(
      "effective-rule-safety-v1",
      canonicalRuleSafetySnapshot(forward),
    ),
  );
});

test("rejects over-limit raw commands before safety classification", () => {
  const prefix = "npm test -- ";
  const exact = `${prefix}${"a".repeat(4_096 - Buffer.byteLength(prefix))}`;
  assert.equal(Buffer.byteLength(exact), 4_096);
  assert.equal(safeCanonicalCommand(exact), exact);
  assert.equal(safeCanonicalCommand(`${exact}a`), undefined);

  const multibytePrefix = "npm test -- ";
  const multibyte = `${multibytePrefix}${"é".repeat(2_043)}`;
  assert.ok(Buffer.byteLength(multibyte) > 4_096);
  assert.equal(safeCanonicalCommand(multibyte), undefined);
});

test("resolves approval authorization as an organization/repository intersection", () => {
  const effective = resolvedPolicy(
    { safe_patterns: ["npm *", "cargo *"], allow_rule_recommendation: true },
    [],
    { safe_patterns: ["npm test"] },
  );
  assert.deepEqual(approvalRecommendationDecision([
    "npm test",
    "npm run build",
    "cargo test",
    "rm -rf .",
    undefined,
  ], effective), {
    kind: "evaluated",
    commands: [
      { allowed: true, canonical_command: "npm test" },
      { allowed: false },
      { allowed: false },
      { allowed: false },
      { allowed: false },
    ],
  });

  assert.deepEqual(approvalRecommendationDecision(["npm test"], undefined), {
    kind: "denied",
  });
  assert.deepEqual(approvalRecommendationDecision(["npm test"], resolvedPolicy(
    undefined,
    [],
    { safe_patterns: ["npm test"], allow_rule_recommendation: true },
  )), {
    kind: "denied",
  });
  assert.deepEqual(approvalRecommendationDecision(["npm test"], resolvedPolicy(
    { safe_patterns: ["npm test"], allow_rule_recommendation: false },
    [],
    { allow_rule_recommendation: true },
  )), {
    kind: "denied",
  });
  assert.deepEqual(approvalRecommendationDecision(["npm test"], resolvedPolicy(
    { safe_patterns: ["npm test"], allow_rule_recommendation: true },
    [],
    { allow_rule_recommendation: false },
  )), {
    kind: "denied",
  });

  const wildcard = resolvedPolicy(
    { safe_patterns: ["*"], allow_rule_recommendation: true },
    [{ match: ["*"], domain: "all", parallel_safe: true }],
  );
  assert.deepEqual(approvalRecommendationDecision([
    "rm -rf .",
    "/tmp/npm test",
    "C:\\tools\\npm.cmd test",
  ], wildcard), {
    kind: "evaluated",
    commands: [
      { allowed: false },
      { allowed: false },
      { allowed: false },
    ],
  });
  for (const raw of [
    "rm -rf .",
    "/tmp/npm test",
    "C:\\tools\\npm.cmd test",
  ]) {
    assert.deepEqual(resourceDomainDecision([raw], wildcard), {
      kind: "investigation_candidate",
    }, raw);
  }
});

test("resolves resource domains monotonically and fail-closed", () => {
  const organization = [
    { match: ["cargo *"], domain: "rust", parallel_safe: true },
    { match: ["npm *"], domain: "node", parallel_safe: true },
  ];
  assert.deepEqual(resourceDomainDecision(
    ["npm test", "npm run build"],
    resolvedPolicy(undefined, organization),
  ), { kind: "parallel_safe", domain: "node" });
  assert.deepEqual(resourceDomainDecision(
    ["npm test"],
    resolvedPolicy(undefined, [{
      match: ["npm *"],
      domain: "node",
      parallel_safe: false,
    }]),
  ), { kind: "parallel_unsafe", domain: "node" });
  assert.deepEqual(resourceDomainDecision(
    ["npm test"],
    resolvedPolicy(undefined, [{
      match: ["npm *"],
      domain: "node",
      parallel_safe: true,
    }], undefined, [{
      match: ["npm test"],
      domain: "node",
      parallel_safe: false,
    }]),
  ), { kind: "parallel_unsafe", domain: "node" });
  assert.deepEqual(resourceDomainDecision(
    ["npm test"],
    resolvedPolicy(undefined, [{
      match: ["npm *"],
      domain: "node",
      parallel_safe: false,
    }], undefined, [{
      match: ["npm test"],
      domain: "node",
      parallel_safe: true,
    }]),
  ), { kind: "parallel_unsafe", domain: "node" });

  for (const [label, commands, effective] of [
    ["no policy", ["npm test"], undefined],
    ["missing command", [undefined], resolvedPolicy()],
    ["unsafe command", ["rm -rf ."], resolvedPolicy(undefined, [{
      match: ["*"], domain: "all", parallel_safe: true,
    }])],
    ["cross-domain", ["npm test", "cargo test"], resolvedPolicy(
      undefined,
      organization,
    )],
    ["repository missing", ["npm test"], resolvedPolicy(
      undefined,
      [{ match: ["npm *"], domain: "node", parallel_safe: true }],
      undefined,
      [{ match: ["cargo *"], domain: "rust", parallel_safe: true }],
    )],
    ["repository disagreement", ["npm test"], resolvedPolicy(
      undefined,
      [{ match: ["npm *"], domain: "node", parallel_safe: true }],
      undefined,
      [{ match: ["npm *"], domain: "other", parallel_safe: true }],
    )],
  ] as const) {
    assert.deepEqual(resourceDomainDecision(commands, effective), {
      kind: "investigation_candidate",
    }, label);
  }
});

test("treats multiple matching entries as ambiguous even within one domain", () => {
  const effective = resolvedPolicy(undefined, [
    { match: ["npm *"], domain: "node", parallel_safe: true },
    { match: ["npm test"], domain: "node", parallel_safe: true },
  ]);
  assert.deepEqual(resourceDomainDecision(["npm test"], effective), {
    kind: "investigation_candidate",
  });

  const repositoryAmbiguous = resolvedPolicy(
    undefined,
    [{ match: ["npm *"], domain: "node", parallel_safe: true }],
    undefined,
    [
      { match: ["npm *"], domain: "node", parallel_safe: true },
      { match: ["npm test"], domain: "node", parallel_safe: true },
    ],
  );
  assert.deepEqual(resourceDomainDecision(["npm test"], repositoryAmbiguous), {
    kind: "investigation_candidate",
  });
});

test("keeps resource decisions invariant under action and policy permutations", () => {
  const left = resolvedPolicy(undefined, [
    { match: ["cargo *"], domain: "rust", parallel_safe: true },
    { match: ["npm *"], domain: "node", parallel_safe: true },
  ]);
  const right = resolvedPolicy(undefined, [
    { match: ["npm *"], domain: "node", parallel_safe: true },
    { match: ["cargo *"], domain: "rust", parallel_safe: true },
  ]);
  assert.deepEqual(
    resourceDomainDecision(["npm test", "npm run build"], left),
    resourceDomainDecision(["npm run build", "npm test"], right),
  );
});

test("enforces whole-decision action and distinct-command caps", () => {
  const effective = resolvedPolicy();
  const repeated = Array.from({ length: 64 }, () => "npm test");
  const approval = approvalRecommendationDecision(repeated, effective);
  assert.equal(approval.kind, "evaluated");
  if (approval.kind === "evaluated") {
    assert.equal(approval.commands.length, 64);
    assert.ok(approval.commands.every((entry) => entry.allowed));
  }
  assert.deepEqual(resourceDomainDecision(repeated, effective), {
    kind: "parallel_safe",
    domain: "node-workspace",
  });

  assert.deepEqual(approvalRecommendationDecision(
    [...repeated, "npm test"],
    effective,
  ), { kind: "denied" });
  assert.deepEqual(resourceDomainDecision(
    [...repeated, "npm test"],
    effective,
  ), { kind: "investigation_candidate" });

  const thirtyTwo = Array.from(
    { length: 32 },
    (_, index) => `npm test -- case-${index}`,
  );
  assert.equal(
    approvalRecommendationDecision(thirtyTwo, effective).kind,
    "evaluated",
  );
  assert.deepEqual(resourceDomainDecision(thirtyTwo, effective), {
    kind: "parallel_safe",
    domain: "node-workspace",
  });

  const thirtyThree = [...thirtyTwo, "npm test -- case-32"];
  assert.deepEqual(approvalRecommendationDecision(thirtyThree, effective), {
    kind: "denied",
  });
  assert.deepEqual(resourceDomainDecision(thirtyThree, effective), {
    kind: "investigation_candidate",
  });
});

test("fails the complete decision when the shared matcher budget is exhausted", () => {
  const prefix = "npm test -- ";
  const command = `${prefix}${"a".repeat(4_096 - Buffer.byteLength(prefix))}`;
  const expensiveMisses = Array.from(
    { length: 16 },
    (_, index) => `*never-${index.toString().padStart(2, "0")}`,
  );
  const effective = resolvedPolicy(
    {
      safe_patterns: [...expensiveMisses, "npm *"],
      allow_rule_recommendation: true,
    },
    [
      ...expensiveMisses.map((pattern) => ({
        match: [pattern],
        domain: "node-workspace",
        parallel_safe: true,
      })),
      {
        match: ["npm *"],
        domain: "node-workspace",
        parallel_safe: true,
      },
    ],
  );

  assert.deepEqual(approvalRecommendationDecision([command], effective), {
    kind: "denied",
  });
  assert.deepEqual(resourceDomainDecision([command], effective), {
    kind: "investigation_candidate",
  });
});

test("allows exactly 65,536 matcher steps and rejects the next step", () => {
  const budget = createDecisionBudget();
  for (let step = 0; step < 65_536; step += 1) {
    assert.equal(commandPatternMatches("a", "a", budget), true, String(step));
  }
  assert.deepEqual(budget, { remaining: 0, exhausted: false });
  assert.equal(commandPatternMatches("a", "a", budget), false);
  assert.deepEqual(budget, { remaining: 0, exhausted: true });
});

test("discards an authorized prefix when a later action exhausts the budget", () => {
  const prefix = "npm test -- z";
  const expensive = `${prefix}${"a".repeat(
    4_096 - Buffer.byteLength(prefix),
  )}`;
  const expensiveMisses = Array.from(
    { length: 16 },
    (_, index) => `npm *never-${index.toString().padStart(2, "0")}`,
  );
  const effective = resolvedPolicy(
    {
      safe_patterns: [
        "cargo test",
        ...expensiveMisses,
        "npm test -- z*",
      ],
      allow_rule_recommendation: true,
    },
    [
      {
        match: ["cargo test"],
        domain: "validation",
        parallel_safe: true,
      },
      ...expensiveMisses.map((pattern) => ({
        match: [pattern],
        domain: "validation",
        parallel_safe: true,
      })),
      {
        match: ["npm test -- z*"],
        domain: "validation",
        parallel_safe: true,
      },
    ],
  );

  assert.deepEqual(
    approvalRecommendationDecision(["cargo test", expensive], effective),
    { kind: "denied" },
  );
  assert.deepEqual(
    resourceDomainDecision(["cargo test", expensive], effective),
    { kind: "investigation_candidate" },
  );
});

test("snapshots effective values defensively and canonicalizes equivalent input", () => {
  const approval: ApprovalRulePolicy = {
    safe_patterns: ["npm *", "cargo *"],
    allow_rule_recommendation: true,
  };
  const domains: ResourceDomainPolicy[] = [
    { match: ["npm *"], domain: "node", parallel_safe: true },
    { match: ["cargo *"], domain: "rust", parallel_safe: false },
  ];
  const repositoryApproval: RepositoryApprovalRulePolicy = {
    safe_patterns: ["npm test"],
  };
  const repositoryDomains: ResourceDomainPolicy[] = [{
    match: ["npm test"],
    domain: "node",
    parallel_safe: false,
  }];

  const effective = resolveRuleSafetyPolicy(
    approval,
    domains,
    repositoryApproval,
    repositoryDomains,
  );
  const snapshot = snapshotEffectiveRuleSafetyPolicy(effective);
  const canonicalBefore = canonicalRuleSafetySnapshot(snapshot);

  approval.safe_patterns[0] = "rm *";
  domains[0]!.match[0] = "rm *";
  repositoryApproval.safe_patterns![0] = "rm *";
  repositoryDomains[0]!.match[0] = "rm *";
  assert.deepEqual(canonicalRuleSafetySnapshot(snapshot), canonicalBefore);

  effective.approval!.organization_safe_patterns[0] = "mutated *";
  effective.organization_resource_domains[0]!.match[0] = "mutated *";
  effective.approval!.repository_safe_patterns![0] = "mutated *";
  effective.repository_resource_domains![0]!.match[0] = "mutated *";
  assert.deepEqual(canonicalRuleSafetySnapshot(snapshot), canonicalBefore);

  const reordered = resolveRuleSafetyPolicy(
    { safe_patterns: ["cargo *", "npm *"], allow_rule_recommendation: true },
    [
      { match: ["cargo *"], domain: "rust", parallel_safe: false },
      { match: ["npm *"], domain: "node", parallel_safe: true },
    ],
    { safe_patterns: ["npm test"] },
    [{ match: ["npm test"], domain: "node", parallel_safe: false }],
  );
  assert.deepEqual(
    canonicalRuleSafetySnapshot(reordered),
    canonicalBefore,
  );

  const stableApproval: ApprovalRulePolicy = {
    safe_patterns: ["cargo *", "npm *"],
    allow_rule_recommendation: true,
  };
  const stableDomains: ResourceDomainPolicy[] = [
    { match: ["cargo *"], domain: "rust", parallel_safe: false },
    { match: ["npm *"], domain: "node", parallel_safe: true },
  ];
  const mutableResult = resolveRuleSafetyPolicy(
    stableApproval,
    stableDomains,
    { safe_patterns: ["npm test"] },
    [{ match: ["npm test"], domain: "node", parallel_safe: false }],
  );
  mutableResult.approval!.organization_safe_patterns[0] = "rm *";
  mutableResult.organization_resource_domains[0]!.match[0] = "rm *";
  const fresh = resolveRuleSafetyPolicy(
    stableApproval,
    stableDomains,
    { safe_patterns: ["npm test"] },
    [{ match: ["npm test"], domain: "node", parallel_safe: false }],
  );
  assert.deepEqual(canonicalRuleSafetySnapshot(fresh), canonicalBefore);
});

test("rejects hostile effective snapshots without reading policy content", () => {
  const canary = "EFFECTIVE_CANARY_37ac";
  let getterCalls = 0;
  const value: Record<string, unknown> = {
    organization_resource_domains: [],
  };
  Object.defineProperty(value, "approval", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return canary;
    },
  });
  assertInvalid(() => snapshotEffectiveRuleSafetyPolicy(value), [canary]);
  assert.equal(getterCalls, 0);

  const proxy = new Proxy({ organization_resource_domains: [] }, {
    ownKeys: () => {
      throw new Error(canary);
    },
  });
  assertInvalid(() => snapshotEffectiveRuleSafetyPolicy(proxy), [canary]);
});
