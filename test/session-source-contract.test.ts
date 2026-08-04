import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AnalysisBudgetMeter } from "../src/analysis/budgets.js";
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

const BUDGETS = {
  max_input_bytes: 1_000,
  max_input_events: 100,
  max_wall_ms: 1_000,
  max_cpu_ms: 1_000,
  max_output_bytes: 1_000,
  max_source_items: 100,
};

const STEADY_CLOCK = { wall_ms: () => 0, cpu_ms: () => 0 };

function analysisRunner(onCall: () => void = () => {}): CommandRunner {
  return async (_command, args) => {
    onCall();
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
}

function revokedProxy<T extends object>(value: T): T {
  const revocable = Proxy.revocable(value, {});
  revocable.revoke();
  return revocable.proxy;
}

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
  assertSourceError(
    () => validateSessionSource(revokedProxy(source([]))),
    "invalid_shape",
  );
  assertSourceError(
    () => validateSessionSource(source([], revokedProxy(declaration()))),
    "invalid_shape",
  );
  assertSourceError(
    () => validateSessionSource(source([], {
      ...declaration(),
      capabilities: revokedProxy([...ALL_CAPABILITIES]),
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
    [revokedProxy([session()]), "invalid_result"],
    [[new Proxy(session(), {})], "invalid_result"],
    [[revokedProxy(session())], "invalid_result"],
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

  let prototypeReads = 0;
  const inherited = new Proxy({}, {
    get: () => {
      prototypeReads += 1;
      throw new Error("SECRET_CANARY inherited source");
    },
  });
  const protoSession = {} as Record<string, unknown>;
  Object.defineProperty(protoSession, "__proto__", {
    enumerable: true,
    value: inherited,
  });
  const protoResult = validateSessionSource({
    contract: declaration(),
    discover: async () => [protoSession],
  } as unknown as SessionSource);
  await assertAsyncSourceError(
    () => protoResult.discover(QUERY),
    "adapter_mismatch",
  );
  assert.equal(prototypeReads, 0);
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

test("CombinedSessionSource propagates invalid discovery output in every budget mode", async () => {
  const invalid = source([session({ source: "codex" })]);
  await assertAsyncSourceError(
    () => new CombinedSessionSource([invalid]).discover(QUERY),
    "adapter_mismatch",
  );
  await assertAsyncSourceError(
    () => new CombinedSessionSource([invalid]).discover({
      ...QUERY,
      analysisBudgetMeter: new AnalysisBudgetMeter(BUDGETS, STEADY_CLOCK),
    }),
    "adapter_mismatch",
  );
});

test("ordinary hostile discovery errors remain isolated without trap evaluation", async () => {
  let traps = 0;
  const hostilePrototype = new Proxy({}, {
    getPrototypeOf: () => {
      traps += 1;
      throw new Error("SECRET_CANARY thrown prototype");
    },
  });
  const hostileError = new Proxy(new Error("SECRET_CANARY thrown error"), {
    getPrototypeOf: () => {
      traps += 1;
      throw new Error("SECRET_CANARY thrown proxy");
    },
  });
  const thrownValues: readonly unknown[] = [
    hostileError,
    Object.create(hostilePrototype),
    revokedProxy(new Error("SECRET_CANARY revoked error")),
    new SessionSourceValidationError("adapter_mismatch"),
  ];
  for (const thrown of thrownValues) {
    const failures: unknown[] = [];
    const throwing: SessionSource = {
      contract: CLAUDE_SESSION_SOURCE_CONTRACT,
      discover: async () => Promise.reject(thrown),
    };
    assert.deepEqual(
      await new CombinedSessionSource(
        [throwing],
        (error) => failures.push(error),
      ).discover(QUERY),
      [],
    );
    assert.equal(failures[0], thrown);
    assert.deepEqual(
      await new CombinedSessionSource([throwing]).discover({
        ...QUERY,
        analysisBudgetMeter: new AnalysisBudgetMeter(BUDGETS, STEADY_CLOCK),
      }),
      [],
    );
  }
  assert.equal(traps, 0);
});

test("budgeted analyze isolates hostile and forged discovery errors", async () => {
  let traps = 0;
  const hostileError = new Proxy(new Error("SECRET_CANARY analyze error"), {
    getPrototypeOf: () => {
      traps += 1;
      throw new Error("SECRET_CANARY analyze trap");
    },
  });
  for (const thrown of [
    hostileError,
    new SessionSourceValidationError("adapter_mismatch"),
  ]) {
    const throwing: SessionSource = {
      contract: CLAUDE_SESSION_SOURCE_CONTRACT,
      discover: async () => Promise.reject(thrown),
    };
    const result = await analyze({
      cwd: "/repo",
      pr: "main...feature",
      sinceMs: 0,
      nowMs: 1_000,
      runner: analysisRunner(),
      persist: false,
      budgets: BUDGETS,
      budgetClock: STEADY_CLOCK,
      sessionSource: throwing,
    });
    assert.equal(
      result.report.analysis_budget?.truncation_reason,
      "source_failure",
    );
  }
  assert.equal(traps, 0);
});

test("analyze uses a captured CombinedSessionSource discovery method", async () => {
  const baseRunner = analysisRunner();
  const runner: CommandRunner = async (command, args, options) =>
    args[0] === "--no-pager" && (args[1] === "diff" || args[1] === "log")
      ? { code: 0, stdout: "", stderr: "" }
      : baseRunner(command, args, options);
  const combined = new CombinedSessionSource([source([session({
    events: [{
      kind: "assistant",
      timestamp_ms: 150,
      session_id: "session-1",
      entry_uuid: "assistant-1",
      session_ref: "session-1#assistant-1",
      source_index: 0,
      agent_id: "main",
      is_sidechain: false,
      confidence: "high",
      text: "Working.",
    }, {
      kind: "assistant",
      timestamp_ms: 200,
      session_id: "session-1",
      entry_uuid: "assistant-2",
      session_ref: "session-1#assistant-2",
      source_index: 1,
      agent_id: "main",
      is_sidechain: false,
      confidence: "high",
      text: "Done.",
    }],
  })])]);
  const original = CombinedSessionSource.prototype.discover;
  let replacementCalls = 0;
  try {
    CombinedSessionSource.prototype.discover = async () => {
      replacementCalls += 1;
      throw new Error("SECRET_CANARY replaced Combined discover");
    };
    const result = await analyze({
      cwd: "/repo",
      pr: "main...feature",
      sinceMs: 0,
      nowMs: 1_000,
      runner,
      persist: false,
      sessionSource: combined,
    });
    assert.deepEqual(result.report.unit.sessions, ["session-1"]);
    assert.equal(replacementCalls, 0);
  } finally {
    CombinedSessionSource.prototype.discover = original;
  }
});

test("analyze rejects hostile CombinedSessionSource injections before effects", async () => {
  let discoverCalls = 0;
  let runnerCalls = 0;
  let proxyTraps = 0;
  class HostileCombinedSessionSource extends CombinedSessionSource {
    override async discover(_query: SessionQuery): Promise<Session[]> {
      discoverCalls += 1;
      return [];
    }
  }
  const shadowed = new CombinedSessionSource([source([])]);
  Object.defineProperty(shadowed, "discover", {
    value: async () => {
      discoverCalls += 1;
      return [];
    },
  });
  const proxied = new Proxy(new CombinedSessionSource([source([])]), {
    getPrototypeOf: () => {
      proxyTraps += 1;
      throw new Error("SECRET_CANARY combined prototype");
    },
  });
  const candidates: readonly CombinedSessionSource[] = [
    new HostileCombinedSessionSource([source([])]),
    shadowed,
    proxied,
  ];
  for (const sessionSource of candidates) {
    await assertAsyncSourceError(() => analyze({
      cwd: "/repo",
      pr: "main...feature",
      sinceMs: 0,
      nowMs: 1_000,
      runner: analysisRunner(() => runnerCalls += 1),
      persist: false,
      sessionSource,
    }), "invalid_shape");
  }
  assert.equal(discoverCalls, 0);
  assert.equal(runnerCalls, 0);
  assert.equal(proxyTraps, 0);
});

test("budgeted analyze propagates invalid discovery output", async () => {
  await assertAsyncSourceError(() => analyze({
    cwd: "/repo",
    pr: "main...feature",
    sinceMs: 0,
    nowMs: 1_000,
    runner: analysisRunner(),
    persist: false,
    budgets: BUDGETS,
    budgetClock: STEADY_CLOCK,
    sessionSource: source([session({ source: "codex" })]),
  }), "adapter_mismatch");
});

test("analyze rejects a legacy injected source before an exhausted budget can report", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-invalid-source-"));
  let discoverCalls = 0;
  let runnerCalls = 0;
  try {
    await assertAsyncSourceError(() => analyze({
      cwd: "/repo",
      pr: "main...feature",
      sinceMs: 0,
      nowMs: 1_000,
      runner: analysisRunner(() => runnerCalls += 1),
      persist: true,
      storePaths: {
        canonical_repo: "/repo",
        repo_hash: "repo-hash",
        root_dir: root,
        repo_dir: join(root, "repo"),
        analyses_dir: join(root, "repo", "analyses"),
        history_index_path: join(root, "repo", "index.json"),
        dismissals_path: join(root, "repo", "dismissals.json"),
        adoptions_path: join(root, "repo", "adoptions.json"),
        hook_events_path: join(root, "repo", "hook-events.jsonl"),
      },
      budgets: { ...BUDGETS, max_wall_ms: 0 },
      budgetClock: {
        wall_ms: (() => {
          let reads = 0;
          return () => reads++;
        })(),
        cpu_ms: () => 0,
      },
      sessionSource: {
        discover: async () => {
          discoverCalls += 1;
          return [];
        },
      } as unknown as SessionSource,
    }), "invalid_shape");
    assert.equal(discoverCalls, 0);
    assert.equal(runnerCalls, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
