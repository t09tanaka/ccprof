import assert from "node:assert/strict";
import test from "node:test";

import { analyze } from "../src/core/analyze.js";
import type { Session, SessionCapability } from "../src/core/model.js";
import { deriveSourceDescriptor } from "../src/core/source-descriptor.js";
import type { CommandRunner } from "../src/git/client.js";
import { ClaudeSessionSource } from "../src/sources/claude/discover.js";
import { CombinedSessionSource } from "../src/sources/combined.js";
import { CodexSessionSource } from "../src/sources/codex/discover.js";
import {
  CLAUDE_SESSION_SOURCE_CONTRACT,
  CODEX_SESSION_SOURCE_CONTRACT,
  SessionSourceValidationError,
  validateSessionSource,
  type SessionQuery,
  type SessionSource,
  type SessionSourceContract,
  type SessionSourceValidationCode,
} from "../src/sources/session-source.js";

const ALL_CAPABILITIES = [
  "approvals",
  "branch_rows",
  "edit_fragments",
  "sidechains",
  "token_usage",
  "tool_timestamps",
] as const satisfies readonly SessionCapability[];

const QUERY: SessionQuery = {
  repoRoot: "/repo",
  headBranch: "feature",
  startedAtMs: 0,
  endedAtMs: 1_000,
};

function session(
  overrides: Partial<Session> = {},
): Session {
  return {
    session_id: "session-1",
    source: "claude",
    source_path: "/logs/session-1.jsonl",
    observed_cwds: ["/repo"],
    observed_branches: ["feature"],
    started_at_ms: 100,
    ended_at_ms: 200,
    confidence: "high",
    events: [],
    warnings: [],
    ...overrides,
  };
}

function declaration(
  overrides: Partial<SessionSourceContract> = {},
): SessionSourceContract {
  return {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    capabilities: ALL_CAPABILITIES,
    ...overrides,
  };
}

function source(
  sessions: readonly Session[] = [session()],
  contract: unknown = declaration(),
): SessionSource {
  return {
    contract: contract as SessionSourceContract,
    discover: async () => [...sessions],
  } as unknown as SessionSource;
}

function assertSourceError(
  action: () => unknown,
  code: SessionSourceValidationCode,
  canary = "SECRET_CANARY",
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SessionSourceValidationError);
    const sourceError = error as Error & { code: SessionSourceValidationCode };
    assert.equal(sourceError.code, code);
    assert.equal(sourceError.name, "SessionSourceValidationError");
    assert.equal(sourceError.message, `invalid session source: ${code}`);
    assert.equal(sourceError.message.includes(canary), false);
    return true;
  });
}

async function assertAsyncSourceError(
  action: () => Promise<unknown>,
  code: SessionSourceValidationCode,
  canary = "SECRET_CANARY",
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof SessionSourceValidationError);
    const sourceError = error as Error & { code: SessionSourceValidationCode };
    assert.equal(sourceError.code, code);
    assert.equal(sourceError.name, "SessionSourceValidationError");
    assert.equal(sourceError.message, `invalid session source: ${code}`);
    assert.equal(sourceError.message.includes(canary), false);
    return true;
  });
}

test("built-in SessionSource v2 contracts are exact, canonical, and immutable", () => {
  assert.deepEqual(CLAUDE_SESSION_SOURCE_CONTRACT, {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    capabilities: ALL_CAPABILITIES,
  });
  assert.deepEqual(CODEX_SESSION_SOURCE_CONTRACT, {
    adapter_id: "codex",
    adapter_version: "1.0.0",
    capabilities: ["edit_fragments", "tool_timestamps"],
  });
  for (const contract of [
    CLAUDE_SESSION_SOURCE_CONTRACT,
    CODEX_SESSION_SOURCE_CONTRACT,
  ]) {
    assert.deepEqual(Object.keys(contract), [
      "adapter_id",
      "adapter_version",
      "capabilities",
    ]);
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(contract.capabilities), true);
  }
  const claude = new ClaudeSessionSource("/tmp/claude-contract-test");
  const codex = new CodexSessionSource({
    sessionsDirectory: "/tmp/codex-contract-test",
    env: {},
  });
  assert.equal(
    (claude as unknown as { contract: unknown }).contract,
    CLAUDE_SESSION_SOURCE_CONTRACT,
  );
  assert.equal(
    (codex as unknown as { contract: unknown }).contract,
    CODEX_SESSION_SOURCE_CONTRACT,
  );
  assert.deepEqual(
    validateSessionSource(claude).contract,
    CLAUDE_SESSION_SOURCE_CONTRACT,
  );
  assert.deepEqual(
    validateSessionSource(codex).contract,
    CODEX_SESSION_SOURCE_CONTRACT,
  );
});

test("validated sources normalize explicit capabilities without mutating adapter values", async () => {
  const omitted = session();
  const reordered = session({
    session_id: "session-2",
    source_path: "/logs/session-2.jsonl",
    capabilities: ["tool_timestamps", "edit_fragments"],
  });
  const input = [omitted, reordered];
  const validated = validateSessionSource(source(input));

  const discovered = await validated.discover(QUERY);

  assert.notEqual(discovered, input);
  assert.notEqual(discovered[0], omitted);
  assert.notEqual(discovered[1], reordered);
  assert.equal(omitted.capabilities, undefined);
  assert.deepEqual(reordered.capabilities, [
    "tool_timestamps",
    "edit_fragments",
  ]);
  assert.deepEqual(discovered[0]?.capabilities, ALL_CAPABILITIES);
  assert.deepEqual(discovered[1]?.capabilities, [
    "edit_fragments",
    "tool_timestamps",
  ]);
  assert.equal(Object.isFrozen(discovered[0]?.capabilities), true);
  assert.equal(Object.isFrozen(discovered[1]?.capabilities), true);
  assert.deepEqual(
    deriveSourceDescriptor(discovered[1]!),
    deriveSourceDescriptor({
      ...reordered,
      capabilities: ["edit_fragments", "tool_timestamps"],
    }),
  );
});

test("missing, extra, hidden, symbol, and accessor contract fields fail closed", () => {
  let discoverCalls = 0;
  assertSourceError(
    () => validateSessionSource({
      discover: async () => {
        discoverCalls += 1;
        return [];
      },
    }),
    "invalid_shape",
  );

  const extra = { ...declaration(), extra: "SECRET_CANARY" };
  assertSourceError(() => validateSessionSource(source([], extra)), "unknown_field");

  const hidden = { ...declaration() } as SessionSourceContract & {
    hidden?: string;
  };
  Object.defineProperty(hidden, "hidden", { value: "SECRET_CANARY" });
  assertSourceError(() => validateSessionSource(source([], hidden)), "unknown_field");

  const symbol = { ...declaration() } as SessionSourceContract & {
    [key: symbol]: string;
  };
  symbol[Symbol("SECRET_CANARY")] = "SECRET_CANARY";
  assertSourceError(() => validateSessionSource(source([], symbol)), "unknown_field");

  let fieldReads = 0;
  const accessor = { ...declaration() } as Record<string, unknown>;
  Object.defineProperty(accessor, "adapter_id", {
    enumerable: true,
    get: () => {
      fieldReads += 1;
      throw new Error("SECRET_CANARY");
    },
  });
  assertSourceError(() => validateSessionSource(source([], accessor)), "invalid_shape");
  assert.equal(fieldReads, 0);
  assert.equal(discoverCalls, 0);
});

test("Proxy sources, contracts, and capability arrays fail without invoking traps", () => {
  let traps = 0;
  const hostile = <T extends object>(value: T): T => new Proxy(value, {
    get: () => {
      traps += 1;
      throw new Error("SECRET_CANARY get");
    },
    getOwnPropertyDescriptor: () => {
      traps += 1;
      throw new Error("SECRET_CANARY descriptor");
    },
    getPrototypeOf: () => {
      traps += 1;
      throw new Error("SECRET_CANARY prototype");
    },
    ownKeys: () => {
      traps += 1;
      throw new Error("SECRET_CANARY keys");
    },
  });

  assertSourceError(
    () => validateSessionSource(hostile(source([]))),
    "invalid_shape",
  );
  assertSourceError(
    () => validateSessionSource(source([], hostile(declaration()))),
    "invalid_shape",
  );
  assertSourceError(
    () => validateSessionSource(source([], {
      ...declaration(),
      capabilities: hostile([...ALL_CAPABILITIES]),
    })),
    "invalid_capability",
  );
  assert.equal(traps, 0);
});

test("unknown adapter versions and malformed capabilities use stable errors", () => {
  const invalid = [
    [declaration({ adapter_id: "other" as "claude" }), "unknown_adapter"],
    [declaration({ adapter_version: "2.0.0" as "1.0.0" }), "unsupported_version"],
    [declaration({ capabilities: ["other" as SessionCapability] }), "invalid_capability"],
    [declaration({ capabilities: ["approvals", "approvals"] }), "invalid_capability"],
    [declaration({ capabilities: ["tool_timestamps", "approvals"] }), "invalid_capability"],
    [declaration({ capabilities: Object.assign(new Array(1), { length: 1 }) }), "invalid_capability"],
  ] as const;
  for (const [contract, code] of invalid) {
    assertSourceError(
      () => validateSessionSource(source([], contract)),
      code,
    );
  }
});

test("contract and discover accessors are rejected without being evaluated", () => {
  let reads = 0;
  const contractGetter = {
    discover: async (): Promise<Session[]> => [],
  } as Record<string, unknown>;
  Object.defineProperty(contractGetter, "contract", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("SECRET_CANARY contract");
    },
  });
  assertSourceError(
    () => validateSessionSource(contractGetter),
    "invalid_shape",
  );

  const discoverGetter = { contract: declaration() } as Record<string, unknown>;
  Object.defineProperty(discoverGetter, "discover", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("SECRET_CANARY discover");
    },
  });
  assertSourceError(
    () => validateSessionSource(discoverGetter),
    "invalid_discover",
  );
  assertSourceError(
    () => validateSessionSource({ contract: declaration(), discover: 1 }),
    "invalid_discover",
  );
  assert.equal(reads, 0);
});

test("discovery results fail closed before invalid sessions reach consumers", async () => {
  const cases: readonly [unknown, SessionSourceValidationCode][] = [
    [{}, "invalid_result"],
    [new Proxy([session()], {}), "invalid_result"],
    [[new Proxy(session(), {})], "invalid_result"],
    [[session({ source: "codex" })], "adapter_mismatch"],
    [[session({ capabilities: ["other" as SessionCapability] })], "invalid_capability"],
  ];
  for (const [result, code] of cases) {
    const candidate = validateSessionSource({
      contract: declaration(),
      discover: async () => result,
    } as unknown as SessionSource);
    await assertAsyncSourceError(() => candidate.discover(QUERY), code);
  }

  const subset = validateSessionSource(source([
    session({ capabilities: ["token_usage"] }),
  ], declaration({ capabilities: ["approvals"] })));
  await assertAsyncSourceError(
    () => subset.discover(QUERY),
    "invalid_capability",
  );

  let sourceReads = 0;
  const accessorSession = session() as Session & Record<string, unknown>;
  Object.defineProperty(accessorSession, "source", {
    enumerable: true,
    get: () => {
      sourceReads += 1;
      throw new Error("SECRET_CANARY session source");
    },
  });
  const accessorResult = validateSessionSource(source([accessorSession]));
  await assertAsyncSourceError(
    () => accessorResult.discover(QUERY),
    "invalid_result",
  );
  assert.equal(sourceReads, 0);
});

test("CombinedSessionSource rejects an invalid leaf before any discovery starts", () => {
  let calls = 0;
  const healthy = source([]);
  const invalid = {
    discover: async () => {
      calls += 1;
      return [];
    },
  } as unknown as SessionSource;

  assertSourceError(
    () => new CombinedSessionSource([healthy, invalid]),
    "invalid_shape",
  );
  assert.equal(calls, 0);
});

test("analyze rejects a legacy injected source before invoking discover", async () => {
  const runner: CommandRunner = async (_command, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { code: 0, stdout: "/repo\n", stderr: "" };
    }
    if (args[0] === "rev-parse") {
      const oid = (args.at(-1)?.startsWith("main") === true ? "a" : "b")
        .repeat(40);
      return { code: 0, stdout: `${oid}\n`, stderr: "" };
    }
    if (args[0] === "merge-base") {
      return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    }
    if (args[0] === "log") {
      return { code: 0, stdout: "1\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unavailable" };
  };
  let discoverCalls = 0;

  await assertAsyncSourceError(() => analyze({
    cwd: "/repo",
    pr: "main...feature",
    sinceMs: 0,
    nowMs: 1_000,
    runner,
    persist: false,
    sessionSource: {
      discover: async () => {
        discoverCalls += 1;
        return [];
      },
    } as unknown as SessionSource,
  }), "invalid_shape");
  assert.equal(discoverCalls, 0);
});
