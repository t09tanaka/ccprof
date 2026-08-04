import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const DOCUMENT_PATHS = [
  "README.md",
  ".claude/commands/retro.md",
  "integrations/pr-skill-snippet.md",
] as const;

async function readDocument(path: string): Promise<string> {
  return (await readFile(resolve(process.cwd(), path), "utf8")).replace(
    /\r\n/gu,
    "\n",
  );
}

test("documentation uses only the installed ccprof command", async () => {
  const documents = await Promise.all(
    DOCUMENT_PATHS.map(async (path) => ({
      path,
      text: await readDocument(path),
    })),
  );

  for (const document of documents) {
    assert.match(document.text, /\bccprof\b/u, document.path);
    assert.doesNotMatch(document.text, /\bnpx\s+ccprof\b/u, document.path);
  }
});

test("documentation is written in English", async () => {
  const documents = await Promise.all(
    DOCUMENT_PATHS.map(async (path) => ({
      path,
      text: await readDocument(path),
    })),
  );

  for (const document of documents) {
    assert.doesNotMatch(
      document.text,
      /[぀-ヿ㐀-䶿一-鿿]/u,
      `${document.path} contains non-English text`,
    );
  }
});

test("README documents the complete direct CLI and analysis contract", async () => {
  const readme = await readDocument("README.md");

  for (const expected of [
    "npm install --global ccprof",
    "npm link",
    "\nccprof\n",
    "ccprof --pr",
    "ccprof --pr 123 --json",
    "ccprof --pr main...feature --md",
    "ccprof stats",
    "ccprof stats --json",
    "ccprof dismiss <finding-key>",
    "--idle-threshold",
    "--test-map",
    "--since",
    "--commit-lookback",
    "RFC3339",
    "explicit timezone",
    "\"version\": 2",
    "unexplained_min",
    "finding_key",
    "this_pr",
    "separate_issue",
    "claude_md",
    "CCPROF_DATA_DIR",
    "Claude Code",
    "R001",
    "R008",
    "npm run build",
    "npm test",
    "npm run typecheck",
  ]) {
    assert.ok(readme.includes(expected), `README is missing ${expected}`);
  }

  assert.match(readme, /locally.*never\s+sends?\s+or\s+uploads?/isu);
  assert.match(readme, /away\s+time.*excluded/isu);
  assert.match(readme, /timestamps\s+are\s+log\s+write\s+times.*not\s+the\s+exact/isu);
  assert.match(readme, /14\s*days/iu);
  assert.match(readme, /2×/u);
  assert.match(readme, /Phase\s*1/u);
  assert.match(
    readme,
    /--since.*takes precedence.*--commit-lookback/isu,
  );
});

test("README documents the complete rule-safety and compatibility boundary", async () => {
  const readme = await readDocument("README.md");
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const jsonExamples = [...readme.matchAll(
    /```json\n([\s\S]*?)\n```/gu,
  )].map((match) => JSON.parse(match[1] ?? "") as unknown);
  const signed = jsonExamples.find((value) =>
    isRecord(value) && value.organization === "example-corp" &&
    value.policy_schema_version === 1
  );
  assert.ok(isRecord(signed), "README needs a valid signed-policy JSON example");
  assert.deepEqual(signed.approval_policy, {
    safe_patterns: ["cargo test", "npm test"],
    allow_rule_recommendation: true,
  });
  assert.deepEqual(signed.resource_domains, [
    {
      match: ["npm run build", "npm test"],
      domain: "node-workspace",
      parallel_safe: false,
    },
    {
      match: ["cat *", "git show *", "rg *"],
      domain: "read-only",
      parallel_safe: true,
    },
  ]);

  const repository = jsonExamples.find((value) => {
    if (!isRecord(value) || !isRecord(value.policy)) return false;
    return isRecord(value.policy.approval_policy) &&
      Array.isArray(value.policy.resource_domains);
  });
  assert.ok(
    isRecord(repository) && isRecord(repository.policy),
    "README needs a valid repository tightening-policy JSON example",
  );
  assert.equal(Object.hasOwn(repository.policy, "organization"), false);
  assert.ok(isRecord(repository.policy.approval_policy));
  assert.ok(Array.isArray(repository.policy.resource_domains));

  const contracts: Array<[label: string, pattern: RegExp]> = [
    [
      "R004 observe-only warning",
      /\bR004\b[\s\S]{0,400}\bobserve[- ]only\b[\s\S]{0,400}(?:not|never)[\s\S]{0,120}(?:confirmed|proven)\s+recoverable/iu,
    ],
    [
      "signed-policy absence denies rule recommendations",
      /(?:no|without|absence of)(?: an?)? signed (?:organization )?policy[\s\S]{0,240}(?:deny|never authoriz)/iu,
    ],
    [
      "repository patterns are an intersection",
      /repository (?:approval )?patterns?[\s\S]{0,180}(?:additional )?intersection/iu,
    ],
    [
      "resource-domain multi-match ambiguity",
      /(?:multiple|more than one) matching (?:resource-domain )?entr(?:y|ies)[\s\S]{0,180}ambiguous/iu,
    ],
    [
      "same-domain entries remain ambiguous",
      /(?:same|one) domain[\s\S]{0,180}(?:still|remain|is) ambiguous/iu,
    ],
    [
      "structural JSON Schema contract",
      /JSON Schema[\s\S]{0,180}structural contract/iu,
    ],
    [
      "authoritative runtime semantic supplement",
      /x-ccprof-runtime-constraints[\s\S]{0,240}authoritative runtime semantic supplement/iu,
    ],
    [
      "no exact schema/runtime parity claim",
      /(?:does not|do not|is not)[\s\S]{0,120}exact schema(?:\/| and )runtime parity/iu,
    ],
    [
      "locale-independent full-tuple ordering",
      /locale-independent UTF-8 byte comparator[\s\S]{0,180}full tuple/iu,
    ],
    [
      "exact duplicate tuples are rejected",
      /exact duplicate tuple[\s\S]{0,120}reject/iu,
    ],
    [
      "raw signed-file limit",
      /raw signed (?:policy )?file[\s\S]{0,100}65,?536(?:-| )byte/iu,
    ],
    [
      "canonical payload limit",
      /canonical (?:signed )?policy payload[\s\S]{0,100}65,?536(?:-| )byte/iu,
    ],
    [
      "pattern and raw-command UTF-8 preflights",
      /pattern[\s\S]{0,100}256(?:-| )byte[\s\S]{0,220}raw command[\s\S]{0,100}4,?096(?:-| )byte/iu,
    ],
    [
      "shared decision limits",
      /64 actions[\s\S]{0,160}32 distinct (?:raw )?commands[\s\S]{0,160}65,?536(?:-| )step/iu,
    ],
    [
      "bare executable enforcement",
      /raw first token[\s\S]{0,180}bare executable[\s\S]{0,240}(?:Unix|Windows)[\s\S]{0,180}path[\s\S]{0,100}reject/iu,
    ],
    [
      "unsupported Windows suffixes",
      /\.bat[\s\S]{0,180}unsupported[\s\S]{0,180}(?:arbitrary|generic) suffix/iu,
    ],
    [
      "node test-only handling",
      /`node`[\s\S]{0,80}`node\.exe`[\s\S]{0,180}(?:next token|only)[\s\S]{0,80}`--test`/iu,
    ],
    [
      "non-regex matching",
      /patterns?[\s\S]{0,180}(?:without|never|does not)[\s\S]{0,80}(?:RegExp|regular expression)/iu,
    ],
    [
      "no shell or glob execution",
      /(?:never|does not)[\s\S]{0,120}(?:invoke|execute)[\s\S]{0,80}(?:shell|filesystem glob)/iu,
    ],
    [
      "R004 point-zero behavior",
      /\bR004\b[\s\S]{0,300}zero duration[\s\S]{0,180}point(?:-zero| zero)[\s\S]{0,180}harmless observation/iu,
    ],
    [
      "neutral R005 title",
      /Path-disjoint tool calls ran serially/u,
    ],
    [
      "R005 unsafe language",
      /parallel_unsafe[\s\S]{0,240}no parallel invocation is recommended/iu,
    ],
    [
      "outer policy digest is the only persisted policy identity",
      /Store[\s\S]{0,240}only[\s\S]{0,100}outer[\s\S]{0,100}`?policy_digest`?[\s\S]{0,100}persist/iu,
    ],
    [
      "inner policy material is never persisted",
      /never persists?[\s\S]{0,180}policy patterns[\s\S]{0,220}effective (?:policy )?snapshot[\s\S]{0,220}inner (?:rule-safety digest|ruleSafetyDigest)/iu,
    ],
    [
      "complete resource-domain contract entries are never persisted",
      /never persists?[\s\S]{0,260}complete resource-domain contract entries/iu,
    ],
    [
      "only the selected resource-domain identifier may remain in finding evidence",
      /only[\s\S]{0,80}selected `?resource_domain`? identifier[\s\S]{0,120}(?:retained|persisted|stored|appear)[\s\S]{0,140}authorized Finding evidence/iu,
    ],
    [
      "authorized finding evidence remains available",
      /authorized Finding evidence[\s\S]{0,220}canonical commands[\s\S]{0,180}`?resource_domain`?/u,
    ],
    [
      "legacy epoch-one compatibility",
      /(?:explicit )?epoch-1[\s\S]{0,180}legacy findings?[\s\S]{0,180}readable[\s\S]{0,160}(?:without|no) (?:migration|backfill)/iu,
    ],
  ];
  for (const [label, pattern] of contracts) {
    assert.match(readme, pattern, label);
  }

  for (const [launcher, executable] of ([
    ["npm.cmd", "npm"],
    ["pnpm.cmd", "pnpm"],
    ["yarn.cmd", "yarn"],
    ["bun.exe", "bun"],
    ["cargo.exe", "cargo"],
    ["git.exe", "git"],
    ["node.exe", "node"],
    ["rg.exe", "rg"],
  ] as const)) {
    assert.match(
      readme,
      new RegExp(
        "`" + launcher.replace(".", "\\.") +
          "`\\s*(?:->|→|maps to)\\s*`" + executable + "`",
        "u",
      ),
      `README is missing the fixed ${launcher} launcher mapping`,
    );
  }
});

test("retro command fixes only this_pr findings and never creates issues automatically", async () => {
  const retro = await readDocument(".claude/commands/retro.md");

  assert.ok(retro.includes("ccprof --pr --json"));
  assert.ok(retro.includes("scope: this_pr"));
  assert.match(retro, /do\s+not\s+create\s+an\s+Issue\s+or\s+another\s+PR\s+automatically/isu);
  assert.match(retro, /separate_issue|claude_md/u);
});

test("PR integration runs after creation and keeps Markdown posting opt-in", async () => {
  const snippet = await readDocument("integrations/pr-skill-snippet.md");

  assert.ok(snippet.includes("gh pr create"));
  assert.ok(snippet.includes("ccprof --pr --json"));
  assert.ok(snippet.includes("ccprof --pr --md"));
  assert.ok(
    snippet.indexOf("gh pr create") < snippet.indexOf("ccprof --pr --json"),
  );
  assert.match(snippet, /only\s+after\s+the\s+PR\s+has\s+been\s+created\s+successfully/isu);
  assert.match(snippet, /\*\*explicit\s+opt-in\*\*/isu);
  assert.match(snippet, /do\s+not\s+create\s+an\s+Issue\s+automatically/isu);
});
