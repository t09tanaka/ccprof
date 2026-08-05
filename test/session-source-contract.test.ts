import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AnalysisBudgetMeter } from "../src/analysis/budgets.js";
import { applyHookEvents } from "../src/analysis/hook-events.js";
import { buildTimeline } from "../src/analysis/timeline.js";
import { sliceSessionsToAnalysisWindow } from "../src/analysis/window.js";
import {
  analyze,
  deriveSessionBranchTransitionAtMs,
} from "../src/core/analyze.js";
import {
  encodeEventIdentity,
  eventIdentity,
} from "../src/core/event-identity.js";
import type {
  NormalizedEvent,
  Session,
  SessionCapability,
} from "../src/core/model.js";
import {
  SourceDescriptorValidationError,
  deriveSourceDescriptor,
  validateSourceDescriptor,
} from "../src/core/source-descriptor.js";
import { CANONICAL_SOURCE_ADAPTER_IDS } from "../src/core/source-identity.js";
import type { CommandRunner } from "../src/git/client.js";
import { legacyCapabilitiesToDescriptor } from
  "../src/protocol/legacy-capability-descriptor.js";
import { ClaudeSessionSource } from "../src/sources/claude/discover.js";
import { CombinedSessionSource } from "../src/sources/combined.js";
import { CodexSessionSource } from "../src/sources/codex/discover.js";
import {
  CLAUDE_SESSION_SOURCE_CONTRACT,
  CODEX_SESSION_SOURCE_CONTRACT,
  SessionSourceValidationError,
  admitSessionEventPrefix,
  validateSessionSource,
  type SessionQuery,
  type SessionSource,
  type SessionSourceContract,
  type SessionSourceValidationCode,
} from "../src/sources/session-source.js";
import { analysisDigest } from "../src/store/analyses.js";

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
const CANONICAL_CLAUDE = CANONICAL_SOURCE_ADAPTER_IDS.claude;
const CANONICAL_CODEX = CANONICAL_SOURCE_ADAPTER_IDS.codex;

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

function eventBase(sourceIndex: number) {
  return {
    timestamp_ms: 100 + sourceIndex,
    session_id: "session-1",
    entry_uuid: `entry-${sourceIndex}`,
    session_ref: `session-1#entry-${sourceIndex}`,
    source_index: sourceIndex,
    agent_id: "main",
    is_sidechain: false,
    confidence: "high" as const,
    event_identity: {
      source_adapter_id: "claude",
      source_instance_id: "/logs/session-1.jsonl",
      session_id: "session-1",
      agent_id: "main",
      source_index: sourceIndex,
    },
    parent_uuid: "parent",
    branch: "feature",
    branch_epoch: 0,
  };
}

function richSession(): Session {
  return session({
    capabilities: [...ALL_CAPABILITIES],
    verified_ended_at_ms: 201,
    events: [{
      ...eventBase(0),
      kind: "genuine_user",
      text: "Please inspect this.",
    }, {
      ...eventBase(1),
      kind: "assistant",
      text: "Inspecting.",
      message_id: "message-1",
      input_tokens: 10,
      output_tokens: 5,
    }, {
      ...eventBase(2),
      kind: "tool_use",
      event_identity: {
        ...eventBase(2).event_identity,
        tool_use_id: "tool-1",
      },
      tool_use_id: "tool-1",
      tool_name: "Read",
      input: {
        path: "src/index.ts",
        options: { line: 1 },
        flags: [true, null, "safe"],
      },
      paths: ["src/index.ts"],
      edit_fragments: ["replacement"],
      command: "inspect",
      cwd: "/repo",
      approval: { required: true, reason: "read permission" },
    }, {
      ...eventBase(3),
      kind: "tool_result",
      event_identity: {
        ...eventBase(3).event_identity,
        tool_use_id: "tool-1",
      },
      tool_use_id: "tool-1",
      status: "success",
      status_evidence: {
        status: "success",
        source: "explicit_status",
        confidence: "high",
      },
      output: "ok",
      output_bytes: 2,
      estimated_tokens: 1,
      exit_code: 0,
    }, {
      ...eventBase(4),
      kind: "compaction",
      summary: "Earlier work.",
      estimated_tokens: 3,
    }],
    warnings: [{
      code: "partial_row",
      message: "A row was skipped.",
      source_path: "/logs/session-1.jsonl",
      line: 7,
      session_ref: "session-1#entry-4",
    }],
  });
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

function discoveryOf(value: unknown): Promise<Session[]> {
  return validateSessionSource({
    contract: declaration(),
    discover: async () => value,
  } as unknown as SessionSource).discover(QUERY);
}

test("descriptor-backed built-in contracts preserve their legacy projections", () => {
  assert.deepEqual(CLAUDE_SESSION_SOURCE_CONTRACT, {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    capabilities: ALL_CAPABILITIES,
    capability_descriptor: legacyCapabilitiesToDescriptor(ALL_CAPABILITIES),
  });
  assert.deepEqual(CODEX_SESSION_SOURCE_CONTRACT, {
    adapter_id: "codex",
    adapter_version: "1.0.0",
    capabilities: ["edit_fragments", "tool_timestamps"],
    capability_descriptor: legacyCapabilitiesToDescriptor([
      "edit_fragments",
      "tool_timestamps",
    ]),
  });
  for (const contract of [
    CLAUDE_SESSION_SOURCE_CONTRACT,
    CODEX_SESSION_SOURCE_CONTRACT,
  ]) {
    const capabilityDescriptor = (contract as unknown as {
      readonly capability_descriptor: ReturnType<
        typeof legacyCapabilitiesToDescriptor
      >;
    }).capability_descriptor;
    assert.deepEqual(Object.keys(contract), [
      "adapter_id",
      "adapter_version",
      "capabilities",
      "capability_descriptor",
    ]);
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(contract.capabilities), true);
    assert.equal(Object.isFrozen(capabilityDescriptor), true);
    assert.equal(Object.isFrozen(capabilityDescriptor.capabilities), true);
    for (const capability of capabilityDescriptor.capabilities) {
      assert.equal(Object.isFrozen(capability), true);
      assert.equal(Object.isFrozen(capability.evidence), true);
    }
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
    { ...CLAUDE_SESSION_SOURCE_CONTRACT, adapter_id: CANONICAL_CLAUDE },
  );
  assert.deepEqual(
    validateSessionSource(codex).contract,
    { ...CODEX_SESSION_SOURCE_CONTRACT, adapter_id: CANONICAL_CODEX },
  );
});

test("validated sources canonicalize identity and capabilities without mutating adapter values", async () => {
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
  assert.equal(omitted.source, "claude");
  assert.deepEqual(reordered.capabilities, [
    "tool_timestamps",
    "edit_fragments",
  ]);
  assert.deepEqual(discovered[0]?.capabilities, ALL_CAPABILITIES);
  assert.equal(discovered[0]?.source, CANONICAL_CLAUDE);
  assert.equal(discovered[1]?.source, CANONICAL_CLAUDE);
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

test("validated discovery accepts legacy and canonical built-in spellings", async () => {
  const cases = [
    ["claude", "claude"],
    ["claude", CANONICAL_CLAUDE],
    [CANONICAL_CLAUDE, "claude"],
    [CANONICAL_CLAUDE, CANONICAL_CLAUDE],
  ] as const;
  for (const [contractAdapter, resultAdapter] of cases) {
    const raw = session({ source: resultAdapter });
    const validated = validateSessionSource(source(
      [raw],
      declaration({ adapter_id: contractAdapter }),
    ));
    const [discovered] = await validated.discover(QUERY);

    assert.equal(validated.contract.adapter_id, CANONICAL_CLAUDE);
    assert.equal(discovered?.source, CANONICAL_CLAUDE);
    assert.equal(raw.source, resultAdapter);
  }

  const validatedCodex = validateSessionSource(source(
    [session({ source: "codex" })],
    {
      ...CODEX_SESSION_SOURCE_CONTRACT,
      adapter_id: CANONICAL_CODEX,
    },
  ));
  assert.equal(validatedCodex.contract.adapter_id, CANONICAL_CODEX);
  assert.equal((await validatedCodex.discover(QUERY))[0]?.source, CANONICAL_CODEX);
});

test("canonicalization keeps unsupported adapters and mismatches fail-closed", async () => {
  for (const adapter_id of ["other", "dev.example/adapters/dummy-agent"]) {
    assertSourceError(
      () => validateSessionSource(source([], declaration({ adapter_id }))),
      "unknown_adapter",
      adapter_id,
    );
  }

  for (const sourceId of ["codex", CANONICAL_CODEX, "dev.example/adapters/dummy-agent"]) {
    const candidate = validateSessionSource(source(
      [session({ source: sourceId })],
      declaration({ adapter_id: CANONICAL_CLAUDE }),
    ));
    await assertAsyncSourceError(
      () => candidate.discover(QUERY),
      "adapter_mismatch",
      sourceId,
    );
  }
});

test("supplied event identities compare canonically and snapshot legacy v1", async () => {
  for (const suppliedAdapterId of ["claude", CANONICAL_CLAUDE]) {
    const raw = richSession();
    for (const event of raw.events) {
      if (event.event_identity !== undefined) {
        event.event_identity.source_adapter_id = suppliedAdapterId;
      }
    }

    const [discovered] = await discoveryOf([raw]);

    assert.equal(discovered?.source, CANONICAL_CLAUDE);
    assert.deepEqual(
      discovered?.events.map((event) => event.event_identity?.source_adapter_id),
      ["claude", "claude", "claude", "claude", "claude"],
    );
  }
});

test("canonical sessions preserve Event Identity and Source Descriptor v1 bytes", () => {
  const legacy = richSession();
  const canonical = { ...legacy, source: CANONICAL_CLAUDE };
  const legacyIdentity = eventIdentity(legacy, legacy.events[0]!);
  const canonicalIdentity = eventIdentity(canonical, canonical.events[0]!);

  assert.deepEqual(canonicalIdentity, legacyIdentity);
  assert.equal(
    encodeEventIdentity(canonicalIdentity),
    encodeEventIdentity(legacyIdentity),
  );
  assert.deepEqual(
    deriveSourceDescriptor(canonical),
    deriveSourceDescriptor(legacy),
  );
});

test("Source Descriptor v1 validation rejects canonical adapter spelling", () => {
  const descriptor = deriveSourceDescriptor(richSession());
  const canonical = { ...descriptor, adapter_id: CANONICAL_CLAUDE };

  assert.throws(() => validateSourceDescriptor(canonical), (error: unknown) => {
    assert.ok(error instanceof SourceDescriptorValidationError);
    assert.equal(error.code, "unknown_adapter");
    assert.equal(error.message, "invalid source descriptor: unknown_adapter");
    return true;
  });
});

test("all matching source spellings preserve persisted audit identity", async () => {
  const baseRunner = analysisRunner();
  const runner: CommandRunner = async (command, args, options) =>
    args[0] === "--no-pager" && (args[1] === "diff" || args[1] === "log")
      ? { code: 0, stdout: "", stderr: "" }
      : baseRunner(command, args, options);
  const forms = [
    ["claude", "claude"],
    ["claude", CANONICAL_CLAUDE],
    [CANONICAL_CLAUDE, "claude"],
    [CANONICAL_CLAUDE, CANONICAL_CLAUDE],
  ] as const;
  const audits: Array<{
    source_digest: string;
    snapshot_id: string;
    deterministic_digest: string;
  }> = [];
  let referenceWindow: Awaited<ReturnType<typeof analyze>>["window"] | undefined;
  for (const [contractAdapter, resultAdapter] of forms) {
    const result = await analyze({
      cwd: "/repo",
      pr: "main...feature",
      sinceMs: 0,
      nowMs: 1_000,
      runner,
      persist: false,
      sessionSource: source([session({
        source: resultAdapter,
        events: [{
          ...eventBase(0),
          kind: "assistant",
          text: "Working.",
        }, {
          ...eventBase(1),
          kind: "assistant",
          text: "Done.",
        }],
      })], declaration({ adapter_id: contractAdapter })),
    });
    const snapshot = result.audit_identity.snapshot_identity;
    assert.ok("source_digest" in snapshot);
    audits.push({
      source_digest: snapshot.source_digest,
      snapshot_id: result.audit_identity.snapshot_id,
      deterministic_digest: result.audit_identity.deterministic_digest,
    });
    referenceWindow ??= result.window;
  }

  const [validated] = await validateSessionSource(source([session({
    events: [{
      ...eventBase(0),
      kind: "assistant",
      text: "Working.",
    }, {
      ...eventBase(1),
      kind: "assistant",
      text: "Done.",
    }],
  })])).discover(QUERY);
  const [sliced] = sliceSessionsToAnalysisWindow(
    [validated!],
    referenceWindow!,
  );
  const { source_path: _sourcePath, ...rest } = sliced!;
  const legacyProjected = {
    ...rest,
    source: "claude",
    observed_cwds: ["."],
    capabilities: [...sliced!.capabilities!].sort(),
    events: sliced!.events,
    warnings: [],
  };
  const legacySourceDigest = analysisDigest("analysis-source-v1", {
    sessions: [legacyProjected],
    discovery_failures: [],
    hook_warnings: [],
  });

  assert.equal(audits[0]?.source_digest, legacySourceDigest);
  for (const audit of audits.slice(1)) assert.deepEqual(audit, audits[0]);
});

test("canonical Claude sessions retain transition, hook, and verified-tail semantics", () => {
  const canonical = richSession();
  canonical.source = CANONICAL_CLAUDE;
  delete canonical.verified_ended_at_ms;
  canonical.events[0]!.branch_epoch = 1;

  assert.equal(
    deriveSessionBranchTransitionAtMs([canonical], "feature", 1_000),
    canonical.events[0]!.timestamp_ms,
  );

  const [hooked] = applyHookEvents([canonical], [{
    received_at_ms: 250,
    session_id: canonical.session_id,
    hook_event_name: "Stop",
  }]);
  assert.equal(hooked?.ended_at_ms, 250);
  assert.equal(hooked?.verified_ended_at_ms, 250);
  assert.ok(
    buildTimeline([hooked!]).actions.some((action) =>
      action.action_id.endsWith(":verified_end")
    ),
  );
});

test("canonical Claude sessions retain one-based warning lines under truncation", () => {
  const candidate = session({
    source: CANONICAL_CLAUDE,
    events: [{
      ...eventBase(0),
      kind: "assistant",
      text: "First",
    }, {
      ...eventBase(1),
      kind: "assistant",
      text: "Second",
    }],
    warnings: [{
      code: "line-one",
      message: "first line",
      source_path: "/logs/session-1.jsonl",
      line: 1,
    }, {
      code: "line-two",
      message: "second line",
      source_path: "/logs/session-1.jsonl",
      line: 2,
    }],
  });
  const [admitted] = admitSessionEventPrefix(
    [candidate],
    new AnalysisBudgetMeter({ ...BUDGETS, max_input_events: 1 }, STEADY_CLOCK),
  );

  assert.deepEqual(admitted?.warnings.map(({ code }) => code), ["line-one"]);
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
    "invalid_result",
  );
  assert.equal(prototypeReads, 0);
});

test("discovery rejects incomplete, inexact, accessor, and mistyped Session records", async () => {
  const requiredFields = [
    "session_id",
    "source",
    "source_path",
    "observed_cwds",
    "observed_branches",
    "started_at_ms",
    "ended_at_ms",
    "confidence",
    "events",
    "warnings",
  ] as const;
  for (const field of requiredFields) {
    const candidate = { ...session() } as Record<string, unknown>;
    delete candidate[field];
    await assertAsyncSourceError(
      () => discoveryOf([candidate]),
      "invalid_result",
    );
  }

  await assertAsyncSourceError(
    () => discoveryOf([{ ...session(), extra: "SECRET_CANARY" }]),
    "invalid_result",
  );

  const invalidFields: readonly [keyof Session, unknown][] = [
    ["session_id", 1],
    ["source", "other"],
    ["source_path", null],
    ["observed_cwds", "/repo"],
    ["observed_branches", "feature"],
    ["started_at_ms", Number.NaN],
    ["ended_at_ms", Number.POSITIVE_INFINITY],
    ["verified_ended_at_ms", Number.MAX_SAFE_INTEGER + 1],
    ["confidence", "certain"],
    ["events", {}],
    ["warnings", {}],
    ["capabilities", "approvals"],
  ];
  for (const [field, value] of invalidFields) {
    const candidate = session();
    (candidate as unknown as Record<string, unknown>)[field] = value;
    await assertAsyncSourceError(
      () => discoveryOf([candidate]),
      field === "source"
        ? "adapter_mismatch"
        : field === "capabilities"
          ? "invalid_capability"
          : "invalid_result",
    );
  }

  let reads = 0;
  for (const field of requiredFields) {
    const candidate = { ...session() } as Record<string, unknown>;
    Object.defineProperty(candidate, field, {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error(`SECRET_CANARY ${field}`);
      },
    });
    await assertAsyncSourceError(
      () => discoveryOf([candidate]),
      "invalid_result",
    );
  }
  assert.equal(reads, 0);
});

test("discovery passively rejects hostile nested Session containers", async () => {
  let traps = 0;
  const hostile = <T extends object>(value: T): T => new Proxy(value, {
    get: () => {
      traps += 1;
      throw new Error("SECRET_CANARY nested get");
    },
    getOwnPropertyDescriptor: () => {
      traps += 1;
      throw new Error("SECRET_CANARY nested descriptor");
    },
    getPrototypeOf: () => {
      traps += 1;
      throw new Error("SECRET_CANARY nested prototype");
    },
    ownKeys: () => {
      traps += 1;
      throw new Error("SECRET_CANARY nested keys");
    },
  });
  const mutateEvent = (
    kind: NormalizedEvent["kind"],
    update: (event: Record<string, unknown>) => void,
  ): Session => {
    const candidate = richSession();
    const event = candidate.events.find((entry) => entry.kind === kind)!;
    update(event as unknown as Record<string, unknown>);
    return candidate;
  };
  const hostileEvent = richSession();
  hostileEvent.events[0] = hostile(hostileEvent.events[0]!);
  const hostileWarning = richSession();
  hostileWarning.warnings[0] = revokedProxy(hostileWarning.warnings[0]!);
  const hostileCases: readonly [Session, SessionSourceValidationCode][] = [
    [session({ observed_cwds: hostile(["/repo"]) }), "invalid_result"],
    [session({ observed_branches: revokedProxy(["feature"]) }), "invalid_result"],
    [session({ events: hostile(richSession().events) }), "invalid_result"],
    [session({ warnings: revokedProxy(richSession().warnings) }), "invalid_result"],
    [
      session({ capabilities: hostile([...ALL_CAPABILITIES]) }),
      "invalid_capability",
    ],
    [hostileEvent, "invalid_result"],
    [hostileWarning, "invalid_result"],
    [mutateEvent("assistant", (event) => {
      event.event_identity = hostile(event.event_identity as object);
    }), "invalid_result"],
    [mutateEvent("tool_use", (event) => {
      event.input = revokedProxy(event.input as object);
    }), "invalid_result"],
    [mutateEvent("tool_result", (event) => {
      event.status_evidence = hostile(event.status_evidence as object);
    }), "invalid_result"],
    [mutateEvent("tool_use", (event) => {
      event.approval = revokedProxy(event.approval as object);
    }), "invalid_result"],
  ];
  for (const [candidate, code] of hostileCases) {
    await assertAsyncSourceError(
      () => discoveryOf([candidate]),
      code,
    );
  }

  const accessorCases: Session[] = [];
  const accessorArray = <T>(value: T[]): T[] => {
    Object.defineProperty(value, "0", {
      enumerable: true,
      get: () => {
        traps += 1;
        throw new Error("SECRET_CANARY nested array accessor");
      },
    });
    return value;
  };
  accessorCases.push(
    session({ observed_cwds: accessorArray(["/repo"]) }),
    session({ observed_branches: accessorArray(["feature"]) }),
    session({ events: accessorArray(richSession().events) }),
    session({ warnings: accessorArray(richSession().warnings) }),
    session({ capabilities: accessorArray([...ALL_CAPABILITIES]) }),
  );
  const accessorRecord = (
    record: object,
    field: string,
  ): void => {
    Object.defineProperty(record, field, {
      enumerable: true,
      get: () => {
        traps += 1;
        throw new Error(`SECRET_CANARY nested ${field} accessor`);
      },
    });
  };
  accessorCases.push(
    mutateEvent("genuine_user", (event) => {
      accessorRecord(event, "timestamp_ms");
    }),
    mutateEvent("assistant", (event) => {
      accessorRecord(event.event_identity as object, "agent_id");
    }),
    mutateEvent("tool_use", (event) => {
      accessorRecord(event.input as object, "path");
    }),
    mutateEvent("tool_result", (event) => {
      accessorRecord(event.status_evidence as object, "status");
    }),
    mutateEvent("tool_use", (event) => {
      accessorRecord(event.approval as object, "required");
    }),
  );
  const accessorWarning = richSession();
  Object.defineProperty(accessorWarning.warnings[0]!, "code", {
    enumerable: true,
    get: () => {
      traps += 1;
      throw new Error("SECRET_CANARY nested warning accessor");
    },
  });
  accessorCases.push(accessorWarning);
  for (const [index, candidate] of accessorCases.entries()) {
    await assertAsyncSourceError(
      () => discoveryOf([candidate]),
      index === 4 ? "invalid_capability" : "invalid_result",
    );
  }
  assert.equal(traps, 0);
});

test("discovery validates exact nested records, safe counts, and enums", async () => {
  const invalidSessions: Session[] = [];
  const withEvent = (
    kind: NormalizedEvent["kind"],
    update: (event: Record<string, unknown>) => void,
  ): void => {
    const candidate = richSession();
    update(
      candidate.events.find((event) => event.kind === kind)! as unknown as
        Record<string, unknown>,
    );
    invalidSessions.push(candidate);
  };

  const requiredEventFields = [
    ["genuine_user", "text"],
    ["assistant", "text"],
    ["tool_use", "tool_use_id"],
    ["tool_use", "tool_name"],
    ["tool_use", "input"],
    ["tool_use", "paths"],
    ["tool_use", "edit_fragments"],
    ["tool_result", "tool_use_id"],
    ["tool_result", "status"],
    ["tool_result", "output"],
    ["tool_result", "output_bytes"],
    ["tool_result", "estimated_tokens"],
    ["compaction", "summary"],
  ] as const;
  for (const [kind, field] of requiredEventFields) {
    withEvent(kind, (event) => delete event[field]);
  }
  for (const field of [
    "timestamp_ms",
    "session_id",
    "entry_uuid",
    "session_ref",
    "source_index",
    "agent_id",
    "is_sidechain",
    "confidence",
    "kind",
  ] as const) {
    withEvent("genuine_user", (event) => delete event[field]);
  }

  for (const [field, value] of [
    ["timestamp_ms", Number.NaN],
    ["source_index", -1],
    ["branch_epoch", Number.MAX_SAFE_INTEGER + 1],
    ["confidence", "certain"],
    ["is_sidechain", 1],
    ["kind", "other"],
  ] as const) {
    withEvent("genuine_user", (event) => event[field] = value);
  }
  withEvent("genuine_user", (event) => event.extra = "SECRET_CANARY");
  withEvent("assistant", (event) => event.input_tokens = -1);
  withEvent("assistant", (event) => event.output_tokens = Number.POSITIVE_INFINITY);
  withEvent("tool_use", (event) => event.paths = [1]);
  withEvent("tool_use", (event) => event.edit_fragments = [null]);
  withEvent("tool_use", (event) => event.input = { nested: undefined });
  withEvent("tool_use", (event) => {
    event.approval = { required: true, extra: "SECRET_CANARY" };
  });
  withEvent("tool_use", (event) => {
    event.approval = { required: "yes" };
  });
  withEvent("tool_use", (event) => {
    event.approval = {};
  });
  withEvent("tool_result", (event) => event.status = "done");
  withEvent("tool_result", (event) => event.output_bytes = -1);
  withEvent("tool_result", (event) => event.estimated_tokens = 1.5);
  withEvent("tool_result", (event) => event.exit_code = Number.NaN);
  withEvent("tool_result", (event) => {
    event.status_evidence = {
      status: "success",
      source: "other",
      confidence: "high",
    };
  });
  withEvent("tool_result", (event) => {
    event.status_evidence = {
      status: "success",
      source: "explicit_status",
      confidence: "high",
      extra: "SECRET_CANARY",
    };
  });
  withEvent("tool_result", (event) => {
    event.status_evidence = {
      status: "success",
      source: "explicit_status",
    };
  });
  withEvent("compaction", (event) => event.estimated_tokens = -1);
  withEvent("assistant", (event) => {
    event.event_identity = {
      source_adapter_id: "claude",
      source_instance_id: "/logs/session-1.jsonl",
      session_id: "session-1",
      agent_id: "main",
      source_index: Number.POSITIVE_INFINITY,
    };
  });
  withEvent("assistant", (event) => {
    event.event_identity = {
      ...(event.event_identity as object),
      extra: "SECRET_CANARY",
    };
  });
  withEvent("assistant", (event) => {
    const identity = event.event_identity as Record<string, unknown>;
    delete identity.agent_id;
  });

  const invalidWarningLine = richSession();
  invalidWarningLine.warnings[0]!.line = 1.5;
  invalidSessions.push(invalidWarningLine);
  const invalidWarningExtra = richSession();
  (invalidWarningExtra.warnings[0] as unknown as Record<string, unknown>).extra =
    "SECRET_CANARY";
  invalidSessions.push(invalidWarningExtra);
  const invalidWarningOptional = richSession();
  (invalidWarningOptional.warnings[0] as unknown as Record<string, unknown>)
    .session_ref = 1;
  invalidSessions.push(invalidWarningOptional);
  for (const field of ["code", "message", "source_path"] as const) {
    const candidate = richSession();
    delete (candidate.warnings[0] as unknown as Record<string, unknown>)[field];
    invalidSessions.push(candidate);
  }

  for (const candidate of invalidSessions) {
    await assertAsyncSourceError(
      () => discoveryOf([candidate]),
      "invalid_result",
    );
  }
});

test("validated discovery returns a fully detached Session snapshot", async () => {
  const original = richSession();
  const expected = structuredClone(original);
  expected.source = CANONICAL_CLAUDE;
  const [snapshot] = await discoveryOf([original]);
  assert.ok(snapshot);

  assert.notEqual(snapshot, original);
  assert.notEqual(snapshot.observed_cwds, original.observed_cwds);
  assert.notEqual(snapshot.observed_branches, original.observed_branches);
  assert.notEqual(snapshot.capabilities, original.capabilities);
  assert.notEqual(snapshot.events, original.events);
  assert.notEqual(snapshot.warnings, original.warnings);
  for (let index = 0; index < original.events.length; index += 1) {
    assert.notEqual(snapshot.events[index], original.events[index]);
    assert.notEqual(
      snapshot.events[index]!.event_identity,
      original.events[index]!.event_identity,
    );
  }
  const originalUse = original.events[2]!;
  const snapshotUse = snapshot.events[2]!;
  assert.equal(originalUse.kind, "tool_use");
  assert.equal(snapshotUse.kind, "tool_use");
  assert.notEqual(snapshotUse.input, originalUse.input);
  assert.notEqual(snapshotUse.input.options, originalUse.input.options);
  assert.notEqual(snapshotUse.input.flags, originalUse.input.flags);
  assert.notEqual(snapshotUse.paths, originalUse.paths);
  assert.notEqual(snapshotUse.edit_fragments, originalUse.edit_fragments);
  assert.notEqual(snapshotUse.approval, originalUse.approval);
  const originalResult = original.events[3]!;
  const snapshotResult = snapshot.events[3]!;
  assert.equal(originalResult.kind, "tool_result");
  assert.equal(snapshotResult.kind, "tool_result");
  assert.notEqual(snapshotResult.status_evidence, originalResult.status_evidence);
  assert.notEqual(snapshot.warnings[0], original.warnings[0]);

  original.session_id = "mutated";
  original.observed_cwds.push("/other");
  original.observed_branches.push("other");
  (original.capabilities as SessionCapability[]).push("approvals");
  original.events.push({ ...original.events[0]!, entry_uuid: "new-entry" });
  original.events[0]!.timestamp_ms = 999;
  original.events[0]!.event_identity!.agent_id = "mutated";
  (originalUse.input.options as { line: number }).line = 999;
  (originalUse.input.flags as unknown[]).push("mutated");
  originalUse.paths.push("other.ts");
  originalUse.edit_fragments.push("mutated");
  originalUse.approval!.reason = "mutated";
  originalResult.status_evidence!.source = "none";
  original.warnings.push({
    code: "mutated",
    message: "mutated",
    source_path: "/mutated",
  });
  original.warnings[0]!.message = "mutated";

  assert.deepEqual(snapshot, expected);
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
      outputProjector: async () => ({
        format: "json",
        render: () => ({ output: "" }),
      }),
      sessionSource: throwing,
    });
    assert.equal(
      result.report.analysis_budget?.truncation_reason,
      "source_failure",
    );
  }
  assert.equal(traps, 0);
});

test("max_output_bytes takes precedence over a concurrent source_failure", async () => {
  const throwing: SessionSource = {
    contract: CLAUDE_SESSION_SOURCE_CONTRACT,
    discover: async () => {
      throw new Error("SECRET_CANARY source failure");
    },
  };
  const result = await analyze({
    cwd: "/repo",
    pr: "main...feature",
    sinceMs: 0,
    nowMs: 1_000,
    runner: analysisRunner(),
    persist: false,
    budgets: { ...BUDGETS, max_output_bytes: 1 },
    budgetClock: STEADY_CLOCK,
    outputProjector: async () => ({
      format: "json",
      render: () => ({ output: "xx" }),
    }),
    sessionSource: throwing,
  });

  assert.equal(
    result.report.analysis_budget?.truncation_reason,
    "max_output_bytes",
  );
  assert.equal(result.report.analysis_budget?.completeness, "partial");
  assert.equal(result.report.analysis_budget?.consumed.output_bytes, 0);
  assert.equal(result.report.analysis_budget?.observed.output_bytes, 2);
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
