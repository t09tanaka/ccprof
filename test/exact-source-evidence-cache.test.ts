import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir, mkdtemp, open, realpath, rename, rm, stat, symlink, utimes, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Session } from "../src/core/model.js";
import {
  projectClaudeParserState, readClaudeParserState,
} from "../src/sources/claude/parser.js";
import {
  projectCodexParserState, readCodexParserState,
} from "../src/sources/codex/parser.js";
import { ExactSourceEvidenceCache } from
  "../src/sources/exact-source-evidence-cache.js";
import {
  createSourceEvidencePair, sourceEvidenceIdentity,
} from "../src/store/source-evidence-cache.js";
import { resolveStorePaths, type StorePaths } from "../src/store/paths.js";
import { openStoreDatabase } from "../src/store/sqlite.js";

const OBSERVED_AT_MS = Date.parse("2026-08-05T00:00:00.000Z");
const at = (second: number) =>
  new Date(Date.UTC(2026, 7, 5, 0, 0, second)).toISOString();
const claude = (cwd: string, id: string, second: number) => JSON.stringify({
  sessionId: id, cwd, gitBranch: "feature/cache", type: "user",
  uuid: `${id}-${second}`, timestamp: at(second),
  message: { role: "user", content: `message-${second}` },
});
const codex = (second: number, type: string, payload: object) =>
  JSON.stringify({ timestamp: at(second), type, payload });
const sha256 = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

interface Fixture {
  root: string; repo: string; sourceRoot: string; sourcePath: string;
  paths: StorePaths;
}
interface CacheWarning { code: string; message: string }

async function fixture(t: TestContext, raw = ""): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ccprof-exact-evidence-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const sourceRoot = join(root, "sources");
  await mkdir(repo); await mkdir(sourceRoot);
  const sourcePath = join(sourceRoot, "source.jsonl");
  await writeFile(sourcePath, raw);
  const paths = await resolveStorePaths(repo, {
    env: { CCPROF_DATA_DIR: join(root, "data") },
  });
  return { root, repo, sourceRoot, sourcePath, paths };
}

function rows(
  paths: StorePaths,
  table: "source_catalog" | "source_evidence_cache" =
    "source_evidence_cache",
): number {
  const database = openStoreDatabase(paths);
  try {
    return (database.prepare(`SELECT count(*) count FROM ${table}`)
      .get() as { count: number }).count;
  } finally { database.close(); }
}

function consumer(value: Fixture, warnings: CacheWarning[] = [], root = value.repo) {
  return new ExactSourceEvidenceCache({
    storePaths: value.paths, eligibilityRoot: root,
    observedAtMs: OBSERVED_AT_MS,
    onWarning: (warning: CacheWarning) => warnings.push(warning),
  });
}

async function consumeClaude(
  value: Fixture,
  options: {
    cache?: ExactSourceEvidenceCache; endedAtMs?: number;
    readState?: typeof readClaudeParserState;
  } = {},
) {
  return await (options.cache ?? consumer(value)).consume({
    adapterId: "claude", sourceRoot: value.sourceRoot,
    sourcePath: value.sourcePath, readState: options.readState ?? readClaudeParserState,
    projectState: projectClaudeParserState,
    ...(options.endedAtMs === undefined ? {} : { endedAtMs: options.endedAtMs }),
  });
}

test("Store identity/pair factory owns exact bindings", async (t) => {
  const value = await fixture(t);
  const path = await realpath(value.sourcePath);
  const identity = sourceEvidenceIdentity("claude", path);
  assert.match(identity, /^source-[a-f0-9]{64}$/u);
  assert.notEqual(identity, sourceEvidenceIdentity("codex", path));
  const handle = await open(path, "r");
  const read = await readClaudeParserState({ sourcePath: path, fileHandle: handle });
  await handle.close();
  const facts = await stat(path);
  const pair = createSourceEvidencePair({
    adapterId: "claude", canonicalPath: path,
    repositoryIdentity: value.paths.repo_hash,
    eligibilityIdentity: "1".repeat(64), observedAtMs: OBSERVED_AT_MS,
    observation: { device: facts.dev, inode: facts.ino, mtimeMs: facts.mtimeMs,
      sizeBytes: 0, prefixHash: sha256(""), suffixHash: sha256(""),
      contentRevision: sha256("") },
    parserState: read.state,
    evidence: { sessions: [], warnings: [], negativeReason: "empty" },
  });
  assert.equal(pair.catalog.source_identity, identity);
  assert.equal(pair.cache.source_identity, identity);
});

test("fresh cold/warm consumers read 1 -> 0 and reproject endedAt", async (t) => {
  const value = await fixture(t);
  await writeFile(value.sourcePath, `${[
    claude(value.repo, "window", 1), claude(value.repo, "window", 4),
  ].join("\n")}\n`);
  let reads = 0;
  const reader: typeof readClaudeParserState = async (options) => {
    reads += 1; return await readClaudeParserState(options);
  };
  const early = await consumeClaude(value, {
    endedAtMs: Date.parse(at(2)), readState: reader,
  });
  const warm = await consumeClaude(value, {
    endedAtMs: Date.parse(at(2)), readState: reader,
  });
  const later = await consumeClaude(value, {
    endedAtMs: Date.parse(at(5)), readState: reader,
  });
  assert.equal(reads, 1);
  assert.deepEqual(warm, early);
  assert.equal(early.sessions[0]?.events.length, 1);
  assert.equal(later.sessions[0]?.events.length, 2);
  assert.equal(rows(value.paths), 1);
});

test("same metadata with changed bytes misses exact revision", async (t) => {
  const value = await fixture(t);
  const first = `${claude(value.repo, "replace-a", 1)}\n`;
  const second = `${claude(value.repo, "replace-b", 1)}\n`;
  assert.equal(Buffer.byteLength(first), Buffer.byteLength(second));
  await writeFile(value.sourcePath, first);
  const before = await stat(value.sourcePath);
  let reads = 0;
  const reader: typeof readClaudeParserState = async (options) => {
    reads += 1; return await readClaudeParserState(options);
  };
  await consumeClaude(value, { readState: reader });
  await writeFile(value.sourcePath, second);
  await utimes(value.sourcePath, before.atime, before.mtime);
  const replaced = await consumeClaude(value, { readState: reader });
  assert.equal(reads, 2);
  assert.equal(replaced.sessions[0]?.session_id, "replace-b");
});

test("warning-free negatives reuse; warning and mixed evidence never commit", async (t) => {
  const cases = [
    { raw: "", expectedReads: 1, expectedRows: 1 },
    { raw: "{malformed\n", expectedReads: 2, expectedRows: 0 },
  ];
  for (const item of cases) {
    const value = await fixture(t, item.raw);
    let reads = 0;
    const readState: typeof readClaudeParserState = async (options) => {
      reads += 1; return await readClaudeParserState(options);
    };
    await consumeClaude(value, { readState });
    await consumeClaude(value, { readState });
    assert.equal(reads, item.expectedReads);
    assert.equal(rows(value.paths), item.expectedRows);
  }
  const mixed = await fixture(t);
  await writeFile(mixed.sourcePath, `${[
    claude(mixed.repo, "local", 1),
    claude(join(mixed.root, "foreign"), "foreign", 2),
  ].join("\n")}\n`);
  let reads = 0;
  const readState: typeof readClaudeParserState = async (options) => {
    reads += 1; return await readClaudeParserState(options);
  };
  const cold = await consumeClaude(mixed, { readState });
  assert.deepEqual(await consumeClaude(mixed, { readState }), cold);
  assert.equal(reads, 2); assert.equal(rows(mixed.paths), 0);
});

test("all-other-repository evidence persists a reusable negative", async (t) => {
  const value = await fixture(t, `${claude("/other/repository", "other", 1)}\n`);
  let reads = 0;
  const readState: typeof readClaudeParserState = async (options) => {
    reads += 1; return await readClaudeParserState(options);
  };
  assert.deepEqual(await consumeClaude(value, { readState }),
    await consumeClaude(value, { readState }));
  assert.equal(reads, 1);
  assert.equal(rows(value.paths), 1);
  const database = openStoreDatabase(value.paths);
  try {
    const { payload_json } = database.prepare(
      "SELECT payload_json FROM source_evidence_cache",
    ).get() as { payload_json: string };
    assert.equal(JSON.parse(payload_json).reason, "other-repository-only");
  } finally { database.close(); }
});

test("root/parser/schema/corrupt bindings and a different path miss", async (t) => {
  const value = await fixture(t);
  await writeFile(value.sourcePath, `${claude(value.repo, "binding", 1)}\n`);
  let reads = 0;
  const readState: typeof readClaudeParserState = async (options) => {
    reads += 1; return await readClaudeParserState(options);
  };
  await consumeClaude(value, { readState });
  const otherRoot = join(value.root, "other"); await mkdir(otherRoot);
  await consumeClaude(value, { cache: consumer(value, [], otherRoot), readState });
  for (const sql of [
    "UPDATE source_catalog SET parser_version='foreign'",
    `UPDATE source_catalog SET schema_fingerprint='sha256:${"f".repeat(64)}'`,
    "UPDATE source_evidence_cache SET payload_json='{corrupt'",
  ]) {
    const database = openStoreDatabase(value.paths); database.exec(sql); database.close();
    await consumeClaude(value, { readState });
  }
  const copy = { ...value, sourcePath: join(value.sourceRoot, "copy.jsonl") };
  await writeFile(copy.sourcePath, `${claude(value.repo, "binding", 1)}\n`);
  await consumeClaude(copy, { readState });
  assert.equal(reads, 6);
});

test("LF/no-LF, Claude multiple sessions, and Codex zero/one remain canonical", async (t) => {
  for (const suffix of ["", "\n"]) {
    const value = await fixture(t);
    await writeFile(value.sourcePath, [
      claude(value.repo, "one", 1), claude(value.repo, "two", 2),
    ].join("\n") + suffix);
    assert.deepEqual(await consumeClaude(value), await consumeClaude(value));
  }
  for (const populated of [false, true]) {
    const value = await fixture(t);
    if (populated) await writeFile(value.sourcePath, `${[
      codex(1, "session_meta", { id: "codex-one", cwd: value.repo }),
      codex(2, "response_item", { type: "message", role: "user", content: "hi" }),
    ].join("\n")}\n`);
    let reads = 0;
    const readState: typeof readCodexParserState = async (options) => {
      reads += 1; return await readCodexParserState(options);
    };
    const consume = () => consumer(value).consume({
      adapterId: "codex", sourceRoot: value.sourceRoot, sourcePath: value.sourcePath,
      readState, projectState: projectCodexParserState,
    }) as Promise<Session | null>;
    assert.deepEqual(await consume(), await consume());
    assert.equal(reads, 1);
    assert.equal(rows(value.paths), 1);
  }
});

test("mutation/path swap/symlink and Store failure preserve cold evidence without publishing", async (t) => {
  for (const mode of ["mutation", "swap", "symlink"] as const) {
    const value = await fixture(t, `${claude("/other", mode, 1)}\n`);
    const before = {
      cache: rows(value.paths), catalog: rows(value.paths, "source_catalog"),
    };
    const held = `${value.sourcePath}.held`;
    const readState: typeof readClaudeParserState = async (options) => {
      const read = await readClaudeParserState(options);
      if (mode === "mutation") await writeFile(value.sourcePath, "changed\n");
      else {
        await rename(value.sourcePath, held);
        if (mode === "swap") await writeFile(value.sourcePath, "replacement\n");
        else await symlink(held, value.sourcePath);
      }
      return read;
    };
    assert.equal((await consumeClaude(value, { readState })).sessions.length, 1);
    assert.deepEqual({
      cache: rows(value.paths), catalog: rows(value.paths, "source_catalog"),
    }, before);
  }
  const failed = await fixture(t, `${claude("/other", "store", 1)}\n`);
  await mkdir(failed.paths.root_dir, { recursive: true });
  await writeFile(failed.paths.repo_dir, "blocked");
  const warnings: CacheWarning[] = [];
  const cold = await consumeClaude(failed, { cache: consumer(failed, warnings) });
  assert.equal(cold.sessions.length, 1);
  assert.deepEqual(warnings.map(({ code }) => code), ["source_cache_unavailable"]);
  assert.equal(JSON.stringify(warnings).includes(failed.sourcePath), false);
});
