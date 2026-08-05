import assert from "node:assert/strict";
import test from "node:test";

import { AnalysisBudgetMeter } from "../src/analysis/budgets.js";
import { sliceSessionsToAnalysisWindow } from "../src/analysis/window.js";
import {
  analyze,
  ruleSessionLanes,
} from "../src/core/analyze.js";
import type {
  Session,
  SessionCapability,
} from "../src/core/model.js";
import type { CommandRunner } from "../src/git/client.js";
import {
  CAPABILITY_DESCRIPTOR_SCHEMA_ID,
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_DESCRIPTOR_VERSION,
  CAPABILITY_UNDECLARED_STATE,
  type CapabilityDescriptorV1,
} from "../src/protocol/capability-descriptor.js";
import {
  legacyCapabilitiesToDescriptor,
} from "../src/protocol/legacy-capability-descriptor.js";
import { ruleCoverage } from "../src/rules/capabilities.js";
import {
  SessionSourceValidationError,
  admitSessionEventPrefix,
  validateSessionSource,
  type SessionQuery,
  type SessionSource,
  type SessionSourceContract,
  type SessionSourceValidationCode,
} from "../src/sources/session-source.js";

const LEGACY_ID = (id: SessionCapability): string =>
  `ccprof.dev/capabilities/${id}`;

type MutableDeclaration = {
  id: string;
  legacy_id?: string;
  version?: string;
  version_range?: string;
  requirement: "required" | "optional";
  state: string;
  evidence: { quality: string; provenance: string };
  timestamp_precision: string;
};

type MutableDescriptor = {
  $schema: string;
  schema_version: number;
  descriptor_version: string;
  undeclared_capability_state: string;
  capabilities: MutableDeclaration[];
};

type NormalizedContractProbe = {
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly capabilities: readonly SessionCapability[];
  readonly capability_descriptor: CapabilityDescriptorV1;
};

type RawSession = Omit<Session, "capability_descriptor"> & {
  capability_descriptor?: unknown;
};

type NormalizedSessionProbe = Session & {
  readonly capabilities: readonly SessionCapability[];
  readonly capability_descriptor: CapabilityDescriptorV1;
};

const SESSION_ALL_CAPABILITIES = [
  "approvals",
  "branch_rows",
  "edit_fragments",
  "sidechains",
  "token_usage",
  "tool_timestamps",
] as const satisfies readonly SessionCapability[];

const SESSION_QUERY: SessionQuery = {
  repoRoot: "/repo",
  headBranch: "feature",
  startedAtMs: 0,
  endedAtMs: 1_000,
};

function supported(
  id: string,
  overrides: Partial<MutableDeclaration> = {},
): MutableDeclaration {
  return {
    id,
    version: CAPABILITY_DESCRIPTOR_VERSION,
    requirement: "optional",
    state: "supported_partial",
    evidence: { quality: "partial", provenance: "adapter_declared" },
    timestamp_precision: "not_applicable",
    ...overrides,
  };
}

function unsupported(
  id: string,
  state: "unsupported" | "unknown",
): MutableDeclaration {
  return state === "unsupported"
    ? supported(id, {
      state,
      evidence: { quality: "none", provenance: "adapter_declared" },
      timestamp_precision: "not_applicable",
    })
    : supported(id, {
      state,
      evidence: { quality: "unknown", provenance: "unknown" },
      timestamp_precision: "unknown",
    });
}

function supportedRange(id: string, versionRange: string): MutableDeclaration {
  const result = supported(id);
  delete result.version;
  result.version_range = versionRange;
  return result;
}

function descriptor(
  capabilities: MutableDeclaration[],
): MutableDescriptor {
  return {
    $schema: CAPABILITY_DESCRIPTOR_SCHEMA_ID,
    schema_version: CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
    descriptor_version: CAPABILITY_DESCRIPTOR_VERSION,
    undeclared_capability_state: CAPABILITY_UNDECLARED_STATE,
    capabilities,
  };
}

function source(contract: unknown): SessionSource {
  return {
    contract: contract as SessionSourceContract,
    discover: async () => [],
  };
}

function normalize(contract: unknown): NormalizedContractProbe {
  return validateSessionSource(source(contract)).contract as unknown as
    NormalizedContractProbe;
}

function assertSourceError(
  action: () => unknown,
  code: SessionSourceValidationCode = "invalid_capability",
  canary = "SECRET_CANARY",
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SessionSourceValidationError);
    assert.equal(error.code, code);
    assert.equal(error.name, "SessionSourceValidationError");
    assert.equal(error.message, `invalid session source: ${code}`);
    assert.equal(error.message.includes(canary), false);
    return true;
  });
}

function contract(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    adapter_id: "claude",
    adapter_version: "1.0.0",
    ...overrides,
  };
}

function assertDeeplyFrozen(value: NormalizedContractProbe): void {
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.capabilities), true);
  assert.equal(Object.isFrozen(value.capability_descriptor), true);
  assert.equal(Object.isFrozen(value.capability_descriptor.capabilities), true);
  for (const declaration of value.capability_descriptor.capabilities) {
    assert.equal(Object.isFrozen(declaration), true);
    assert.equal(Object.isFrozen(declaration.evidence), true);
  }
}

function mutableDescriptor(
  value: CapabilityDescriptorV1,
): MutableDescriptor {
  return descriptor(value.capabilities.map((entry) => ({
    id: entry.id,
    ...(entry.legacy_id === undefined
      ? {}
      : { legacy_id: entry.legacy_id }),
    ...(entry.version === undefined
      ? { version_range: entry.version_range }
      : { version: entry.version }),
    requirement: entry.requirement,
    state: entry.state,
    evidence: { ...entry.evidence },
    timestamp_precision: entry.timestamp_precision,
  })));
}

function sessionDescriptorWithNeutral(
  capabilities: readonly SessionCapability[] = SESSION_ALL_CAPABILITIES,
): MutableDescriptor {
  const result = mutableDescriptor(
    legacyCapabilitiesToDescriptor(capabilities),
  );
  result.capabilities.push(supported(
    "dummy.example/capabilities/neutral_signal",
    {
      state: "supported_exact",
      evidence: { quality: "exact", provenance: "producer_declared" },
    },
  ));
  return result;
}

function sessionEvent(
  sourceIndex: number,
  sessionId = "session-1",
): Session["events"][number] {
  return {
    kind: "assistant",
    timestamp_ms: 100 + sourceIndex,
    session_id: sessionId,
    entry_uuid: `entry-${sourceIndex}`,
    session_ref: `${sessionId}#entry-${sourceIndex}`,
    source_index: sourceIndex,
    agent_id: "main",
    is_sidechain: false,
    confidence: "high",
    text: sourceIndex === 0 ? "Working." : "Done.",
  };
}

function rawSession(overrides: Partial<RawSession> = {}): RawSession {
  const sessionId = overrides.session_id ?? "session-1";
  return {
    session_id: sessionId,
    source: "claude",
    source_path: "/logs/session-1.jsonl",
    observed_cwds: ["/repo"],
    observed_branches: ["feature"],
    started_at_ms: 100,
    ended_at_ms: 101,
    confidence: "high",
    events: [sessionEvent(0, sessionId), sessionEvent(1, sessionId)],
    warnings: [],
    ...overrides,
  };
}

function discoveringSource(
  sourceContract: unknown,
  sessions: readonly RawSession[],
): SessionSource {
  return {
    contract: sourceContract as SessionSourceContract,
    discover: async () => [...sessions] as unknown as Session[],
  };
}

async function discoverNormalized(
  sourceContract: unknown,
  sessions: readonly RawSession[],
): Promise<{
  source: ReturnType<typeof validateSessionSource>;
  sessions: NormalizedSessionProbe[];
}> {
  const validated = validateSessionSource(
    discoveringSource(sourceContract, sessions),
  );
  return {
    source: validated,
    sessions: await validated.discover(SESSION_QUERY) as
      NormalizedSessionProbe[],
  };
}

async function assertAsyncSourceError(
  action: () => Promise<unknown>,
  code: SessionSourceValidationCode,
  canary = "SECRET_CANARY",
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof SessionSourceValidationError);
    assert.equal(error.code, code);
    assert.equal(error.name, "SessionSourceValidationError");
    assert.equal(error.message, `invalid session source: ${code}`);
    assert.equal(error.message.includes(canary), false);
    return true;
  });
}

function assertSessionDescriptorFrozen(
  value: CapabilityDescriptorV1,
): void {
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.capabilities), true);
  for (const declaration of value.capabilities) {
    assert.equal(Object.isFrozen(declaration), true);
    assert.equal(Object.isFrozen(declaration.evidence), true);
  }
}

function sessionAnalysisRunner(): CommandRunner {
  return async (_command, args) => {
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
    if (
      args[0] === "--no-pager" &&
      (args[1] === "diff" || args[1] === "log")
    ) {
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unavailable" };
  };
}

function laneSessionIds(
  lanes: ReturnType<typeof ruleSessionLanes>,
): Record<string, string[]> {
  return Object.fromEntries(Object.entries(lanes).map(
    ([ruleId, sessions]) => [
      ruleId,
      sessions.map(({ session_id }) => session_id),
    ],
  ));
}

test("legacy-only contracts gain a detached descriptor and keep their projection", () => {
  const capabilities: SessionCapability[] = ["approvals", "tool_timestamps"];
  const normalized = normalize(contract({ capabilities }));

  assert.deepEqual(normalized.capabilities, capabilities);
  assert.deepEqual(
    normalized.capability_descriptor,
    legacyCapabilitiesToDescriptor(capabilities),
  );
  assert.notEqual(normalized.capabilities, capabilities);
  assertDeeplyFrozen(normalized);

  capabilities.length = 0;
  assert.deepEqual(normalized.capabilities, ["approvals", "tool_timestamps"]);
});

test("descriptor-only contracts project supported legacy IDs and preserve neutral IDs", () => {
  const neutralId = "dummy.example/capabilities/neutral_signal";
  const input = descriptor([
    supported(LEGACY_ID("tool_timestamps")),
    unsupported(LEGACY_ID("edit_fragments"), "unknown"),
    supported(neutralId, {
      state: "supported_exact",
      evidence: { quality: "exact", provenance: "producer_declared" },
    }),
    supported(LEGACY_ID("token_usage"), {
      state: "supported_estimated",
      evidence: { quality: "estimated", provenance: "observed" },
    }),
    unsupported(LEGACY_ID("branch_rows"), "unsupported"),
    supported(LEGACY_ID("approvals")),
  ]);

  const normalized = normalize(contract({ capability_descriptor: input }));

  assert.deepEqual(normalized.capabilities, [
    "approvals",
    "token_usage",
    "tool_timestamps",
  ]);
  assert.deepEqual(
    normalized.capability_descriptor.capabilities.map(({ id }) => id),
    [
      "ccprof.dev/capabilities/approvals",
      "ccprof.dev/capabilities/branch_rows",
      "ccprof.dev/capabilities/edit_fragments",
      "ccprof.dev/capabilities/token_usage",
      "ccprof.dev/capabilities/tool_timestamps",
      neutralId,
    ],
  );
  assert.equal(
    normalized.capability_descriptor.capabilities.some(({ id }) => id === neutralId),
    true,
  );
  assertDeeplyFrozen(normalized);
});

test("dual contracts require exact projection agreement without adapter inference", () => {
  const matching = descriptor([
    supported(LEGACY_ID("approvals")),
    unsupported(LEGACY_ID("branch_rows"), "unsupported"),
    supported("dummy.example/capabilities/neutral_signal"),
  ]);
  const normalized = normalize(contract({
    capabilities: ["approvals"],
    capability_descriptor: matching,
  }));
  assert.deepEqual(normalized.capabilities, ["approvals"]);

  assertSourceError(() => normalize(contract({
    capabilities: ["approvals"],
    capability_descriptor: descriptor([
      unsupported(LEGACY_ID("approvals"), "unknown"),
    ]),
  })));
  assertSourceError(() => normalize(contract({
    capabilities: [],
    capability_descriptor: descriptor([
      supported(LEGACY_ID("approvals")),
    ]),
  })));
});

test("unsupported, unknown, unmatched, and range-only declarations do not project", () => {
  const normalized = normalize(contract({
    capability_descriptor: descriptor([
      unsupported(LEGACY_ID("approvals"), "unsupported"),
      unsupported(LEGACY_ID("branch_rows"), "unknown"),
      supported(LEGACY_ID("edit_fragments"), {
        version: "2.0.0",
      }),
      supportedRange(LEGACY_ID("sidechains"), "^1.0.0"),
      supported("dummy.example/capabilities/neutral_signal"),
    ]),
  }));

  assert.deepEqual(normalized.capabilities, []);
  assert.equal(normalized.capability_descriptor.capabilities.length, 5);
});

test("normalization is deterministic, detached, deeply frozen, and repeatable", () => {
  const firstEntry = supported(LEGACY_ID("tool_timestamps"));
  const secondEntry = supported(LEGACY_ID("approvals"));
  const mutable = descriptor([firstEntry, secondEntry]);
  const forward = normalize(contract({ capability_descriptor: mutable }));
  const reverse = normalize(contract({
    capability_descriptor: descriptor([secondEntry, firstEntry]),
  }));

  assert.equal(
    JSON.stringify(forward.capability_descriptor),
    JSON.stringify(reverse.capability_descriptor),
  );
  assert.deepEqual(
    forward.capability_descriptor.capabilities.map(({ id }) => id),
    [LEGACY_ID("approvals"), LEGACY_ID("tool_timestamps")],
  );

  firstEntry.id = "dummy.example/capabilities/mutated";
  firstEntry.evidence.quality = "none";
  mutable.capabilities.length = 0;
  mutable.descriptor_version = "9.9.9";
  assert.deepEqual(forward.capabilities, ["approvals", "tool_timestamps"]);
  assert.deepEqual(
    forward.capability_descriptor.capabilities.map(({ id }) => id),
    [LEGACY_ID("approvals"), LEGACY_ID("tool_timestamps")],
  );

  const once = validateSessionSource(source({
    adapter_id: "claude",
    adapter_version: "1.0.0",
    capability_descriptor: reverse.capability_descriptor,
  }));
  const twice = validateSessionSource(once);
  const onceContract = once.contract as unknown as NormalizedContractProbe;
  const twiceContract = twice.contract as unknown as NormalizedContractProbe;
  assert.deepEqual(twiceContract, onceContract);
  assert.notEqual(twiceContract, onceContract);
  assert.notEqual(
    twiceContract.capability_descriptor,
    onceContract.capability_descriptor,
  );
  assertDeeplyFrozen(twiceContract);
});

test("malformed and hostile capability representations fail with fixed errors", () => {
  assertSourceError(() => normalize(contract({})));
  assertSourceError(() => normalize(contract({ capabilities: undefined })));
  assertSourceError(() => normalize(contract({ capability_descriptor: undefined })));
  assertSourceError(() => normalize(contract({ capabilities: [
    "approvals",
    "approvals",
  ] })));
  assertSourceError(() => normalize(contract({ capabilities: [
    "tool_timestamps",
    "approvals",
  ] })));

  const invalidDescriptors: unknown[] = [
    { ...descriptor([supported(LEGACY_ID("approvals"))]), extra: "SECRET_CANARY" },
    descriptor([
      supported(LEGACY_ID("approvals")),
      supported(LEGACY_ID("approvals")),
    ]),
    descriptor([supported(LEGACY_ID("approvals"), {
      state: "supported_exact",
      evidence: { quality: "none", provenance: "adapter_declared" },
    })]),
  ];
  for (const invalid of invalidDescriptors) {
    assertSourceError(() => normalize(contract({ capability_descriptor: invalid })));
  }

  let traps = 0;
  const hostile = new Proxy(descriptor([supported(LEGACY_ID("approvals"))]), {
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
  assertSourceError(() => normalize(contract({ capability_descriptor: hostile })));

  const nestedHostile = new Proxy(supported(LEGACY_ID("approvals")), {
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
  assertSourceError(() => normalize(contract({
    capability_descriptor: descriptor([nestedHostile]),
  })));

  const revocable = Proxy.revocable(
    descriptor([supported(LEGACY_ID("approvals"))]),
    {},
  );
  revocable.revoke();
  assertSourceError(() => normalize(contract({
    capability_descriptor: revocable.proxy,
  })));

  let reads = 0;
  const accessor = supported(LEGACY_ID("approvals")) as MutableDeclaration &
    Record<string, unknown>;
  Object.defineProperty(accessor, "state", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("SECRET_CANARY getter");
    },
  });
  assertSourceError(() => normalize(contract({
    capability_descriptor: descriptor([accessor]),
  })));
  assert.equal(traps, 0);
  assert.equal(reads, 0);
});

test("legacy-only, descriptor-only, and consistent dual contracts yield explicit normalized sessions", async () => {
  const legacyDescriptor = legacyCapabilitiesToDescriptor(
    SESSION_ALL_CAPABILITIES,
  );
  const contracts = [
    contract({ capabilities: SESSION_ALL_CAPABILITIES }),
    contract({ capability_descriptor: legacyDescriptor }),
    contract({
      capabilities: SESSION_ALL_CAPABILITIES,
      capability_descriptor: legacyDescriptor,
    }),
  ];

  const results = await Promise.all(contracts.map((value) =>
    discoverNormalized(value, [rawSession()])
  ));
  const shapes = results.map(({ sessions: [normalized] }) => ({
    capabilities: normalized?.capabilities,
    capability_descriptor: normalized?.capability_descriptor,
  }));

  assert.deepEqual(shapes, [shapes[0], shapes[0], shapes[0]]);
  for (const { source: validated, sessions: [normalized] } of results) {
    assert.ok(normalized);
    assert.deepEqual(normalized.capabilities, SESSION_ALL_CAPABILITIES);
    assert.equal(
      normalized.capability_descriptor,
      validated.contract.capability_descriptor,
    );
  }
});

test("normalized sessions keep neutral declarations without projecting them into legacy capabilities", async () => {
  const sourceDescriptor = sessionDescriptorWithNeutral([
    "approvals",
    "tool_timestamps",
  ]);
  const result = await discoverNormalized(contract({
    capability_descriptor: sourceDescriptor,
  }), [rawSession()]);
  const normalized = result.sessions[0]!;

  assert.deepEqual(normalized.capabilities, ["approvals", "tool_timestamps"]);
  assert.deepEqual(
    normalized.capability_descriptor.capabilities.map(({ id }) => id),
    [
      LEGACY_ID("approvals"),
      LEGACY_ID("branch_rows"),
      LEGACY_ID("edit_fragments"),
      LEGACY_ID("sidechains"),
      LEGACY_ID("token_usage"),
      LEGACY_ID("tool_timestamps"),
      "dummy.example/capabilities/neutral_signal",
    ],
  );
  assert.equal(
    normalized.capability_descriptor.capabilities.find(({ id }) =>
      id === LEGACY_ID("edit_fragments")
    )?.state,
    "unsupported",
  );
});

test("per-session legacy subsets stay narrow while the descriptor stays the full contract", async () => {
  const sourceDescriptor = sessionDescriptorWithNeutral();
  const result = await discoverNormalized(contract({
    capabilities: SESSION_ALL_CAPABILITIES,
    capability_descriptor: sourceDescriptor,
  }), [
    rawSession({ session_id: "absent" }),
    rawSession({
      session_id: "subset",
      source_path: "/logs/subset.jsonl",
      capabilities: ["tool_timestamps", "approvals"],
    }),
    rawSession({
      session_id: "empty",
      source_path: "/logs/empty.jsonl",
      capabilities: [],
    }),
  ]);

  assert.deepEqual(result.sessions.map(({ capabilities }) => capabilities), [
    SESSION_ALL_CAPABILITIES,
    ["approvals", "tool_timestamps"],
    [],
  ]);
  for (const normalized of result.sessions) {
    assert.equal(
      normalized.capability_descriptor,
      result.source.contract.capability_descriptor,
    );
    assert.equal(Object.isFrozen(normalized.capabilities), true);
    assert.equal(
      normalized.capability_descriptor.capabilities.length,
      sourceDescriptor.capabilities.length,
    );
  }
});

test("matching reordered session descriptors use the normalized contract object", async () => {
  const sourceDescriptor = sessionDescriptorWithNeutral();
  const reordered = mutableDescriptor(
    sourceDescriptor as unknown as CapabilityDescriptorV1,
  );
  reordered.capabilities.reverse();
  const result = await discoverNormalized(contract({
    capabilities: SESSION_ALL_CAPABILITIES,
    capability_descriptor: sourceDescriptor,
  }), [rawSession({ capability_descriptor: reordered })]);
  const normalized = result.sessions[0]!;

  assert.equal(
    normalized.capability_descriptor,
    result.source.contract.capability_descriptor,
  );
  assert.notEqual(normalized.capability_descriptor, reordered);
  assertSessionDescriptorFrozen(normalized.capability_descriptor);
});

test("every canonical session descriptor difference fails closed", async () => {
  const sourceDescriptor = sessionDescriptorWithNeutral();
  const variants: Array<[string, (value: MutableDescriptor) => void]> = [
    ["unknown declaration removed", (value) => {
      value.capabilities = value.capabilities.filter(({ id }) =>
        id !== "dummy.example/capabilities/neutral_signal"
      );
    }],
    ["unknown declaration id", (value) => {
      value.capabilities.at(-1)!.id =
        "dummy.example/capabilities/other_signal";
    }],
    ["state and evidence quality", (value) => {
      const neutral = value.capabilities.at(-1)!;
      neutral.state = "supported_partial";
      neutral.evidence.quality = "partial";
    }],
    ["declaration version", (value) => {
      value.capabilities.at(-1)!.version = "1.0.1";
    }],
    ["version contract", (value) => {
      const neutral = value.capabilities.at(-1)!;
      delete neutral.version;
      neutral.version_range = "^1.0.0";
    }],
    ["requirement", (value) => {
      value.capabilities.at(-1)!.requirement = "required";
    }],
    ["legacy id", (value) => {
      value.capabilities.at(-1)!.legacy_id = "neutral_signal";
    }],
    ["timestamp precision", (value) => {
      value.capabilities.at(-1)!.timestamp_precision = "millisecond";
    }],
    ["evidence provenance", (value) => {
      value.capabilities.at(-1)!.evidence.provenance = "adapter_declared";
    }],
    ["descriptor version", (value) => {
      value.descriptor_version = "2.0.0";
    }],
  ];

  for (const [label, mutate] of variants) {
    const candidate = mutableDescriptor(
      sourceDescriptor as unknown as CapabilityDescriptorV1,
    );
    mutate(candidate);
    await assertAsyncSourceError(
      () => discoverNormalized(contract({
        capabilities: SESSION_ALL_CAPABILITIES,
        capability_descriptor: sourceDescriptor,
      }), [rawSession({ capability_descriptor: candidate })]),
      "invalid_capability",
      label,
    );
  }
});

test("hostile session descriptor values never invoke user code", async () => {
  const sourceDescriptor = sessionDescriptorWithNeutral();
  const run = (value: unknown) => discoverNormalized(contract({
    capabilities: SESSION_ALL_CAPABILITIES,
    capability_descriptor: sourceDescriptor,
  }), [rawSession({ capability_descriptor: value })]);
  let traps = 0;
  const hostile = new Proxy(sessionDescriptorWithNeutral(), {
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
  await assertAsyncSourceError(() => run(hostile), "invalid_capability");

  const nestedHostile = sessionDescriptorWithNeutral();
  nestedHostile.capabilities[0] = new Proxy(
    nestedHostile.capabilities[0]!,
    {
      get: () => {
        traps += 1;
        throw new Error("SECRET_CANARY nested get");
      },
      ownKeys: () => {
        traps += 1;
        throw new Error("SECRET_CANARY nested keys");
      },
    },
  );
  await assertAsyncSourceError(
    () => run(nestedHostile),
    "invalid_capability",
  );

  const revocable = Proxy.revocable(sessionDescriptorWithNeutral(), {});
  revocable.revoke();
  await assertAsyncSourceError(
    () => run(revocable.proxy),
    "invalid_capability",
  );

  let reads = 0;
  const accessor = sessionDescriptorWithNeutral();
  Object.defineProperty(accessor.capabilities[0]!.evidence, "quality", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("SECRET_CANARY accessor");
    },
  });
  await assertAsyncSourceError(() => run(accessor), "invalid_capability");

  const outerAccessor = rawSession() as RawSession & Record<string, unknown>;
  Object.defineProperty(outerAccessor, "capability_descriptor", {
    enumerable: true,
    get: () => {
      reads += 1;
      throw new Error("SECRET_CANARY outer accessor");
    },
  });
  await assertAsyncSourceError(
    () => discoverNormalized(contract({
      capabilities: SESSION_ALL_CAPABILITIES,
      capability_descriptor: sourceDescriptor,
    }), [outerAccessor]),
    "invalid_result",
  );
  assert.equal(traps, 0);
  assert.equal(reads, 0);
});

test("normalized session descriptors are detached, deeply frozen, and revalidation-safe", async () => {
  const rawContractDescriptor = sessionDescriptorWithNeutral();
  const rawSessionDescriptor = mutableDescriptor(
    rawContractDescriptor as unknown as CapabilityDescriptorV1,
  );
  const rawCapabilities: SessionCapability[] = ["approvals"];
  const raw = rawSession({
    capabilities: rawCapabilities,
    capability_descriptor: rawSessionDescriptor,
  });
  const once = validateSessionSource(discoveringSource(contract({
    capabilities: SESSION_ALL_CAPABILITIES,
    capability_descriptor: rawContractDescriptor,
  }), [raw]));
  const onceSession = (await once.discover(SESSION_QUERY))[0] as
    NormalizedSessionProbe;
  const twice = validateSessionSource(once);
  const twiceSession = (await twice.discover(SESSION_QUERY))[0] as
    NormalizedSessionProbe;

  assert.deepEqual(twiceSession, onceSession);
  assert.notEqual(twiceSession, onceSession);
  assert.equal(
    twiceSession.capability_descriptor,
    twice.contract.capability_descriptor,
  );
  assert.notEqual(
    twiceSession.capability_descriptor,
    onceSession.capability_descriptor,
  );
  assertSessionDescriptorFrozen(onceSession.capability_descriptor);
  assertSessionDescriptorFrozen(twiceSession.capability_descriptor);

  rawCapabilities.length = 0;
  rawSessionDescriptor.capabilities.length = 0;
  rawContractDescriptor.capabilities.length = 0;
  assert.deepEqual(onceSession.capabilities, ["approvals"]);
  assert.equal(
    onceSession.capability_descriptor.capabilities.length,
    SESSION_ALL_CAPABILITIES.length + 1,
  );
});

test("window and budget transformations preserve descriptor identity and freeze", async () => {
  const result = await discoverNormalized(contract({
    capabilities: SESSION_ALL_CAPABILITIES,
    capability_descriptor: sessionDescriptorWithNeutral(),
  }), [rawSession()]);
  const normalized = result.sessions[0]!;
  const [windowed] = sliceSessionsToAnalysisWindow([normalized], {
    started_at_ms: 100,
    ended_at_ms: 101,
    start_source: "explicit",
    end_source: "explicit",
    completeness: "complete",
  }) as NormalizedSessionProbe[];
  const meter = new AnalysisBudgetMeter({
    max_input_bytes: 1_000,
    max_input_events: 1,
    max_wall_ms: 1_000,
    max_cpu_ms: 1_000,
    max_output_bytes: 1_000,
    max_source_items: 1,
  }, { wall_ms: () => 0, cpu_ms: () => 0 });
  const [budgeted] = admitSessionEventPrefix(
    [normalized],
    meter,
  ) as NormalizedSessionProbe[];

  assert.equal(
    windowed?.capability_descriptor,
    normalized.capability_descriptor,
  );
  assert.equal(
    budgeted?.capability_descriptor,
    normalized.capability_descriptor,
  );
  assertSessionDescriptorFrozen(windowed!.capability_descriptor);
  assertSessionDescriptorFrozen(budgeted!.capability_descriptor);
  assert.equal(budgeted?.events.length, 1);
});

test("neutral descriptor metadata leaves rule, report, record, and audit identities unchanged", async () => {
  const legacyContract = contract({
    capabilities: SESSION_ALL_CAPABILITIES,
  });
  const neutralContract = contract({
    capabilities: SESSION_ALL_CAPABILITIES,
    capability_descriptor: sessionDescriptorWithNeutral(),
  });
  const legacySource = validateSessionSource(
    discoveringSource(legacyContract, [rawSession()]),
  );
  const neutralSource = validateSessionSource(
    discoveringSource(neutralContract, [rawSession()]),
  );
  const legacySessions = await legacySource.discover(SESSION_QUERY);
  const neutralSessions = await neutralSource.discover(SESSION_QUERY);

  assert.deepEqual(ruleCoverage(neutralSessions), ruleCoverage(legacySessions));
  assert.deepEqual(
    laneSessionIds(ruleSessionLanes(neutralSessions)),
    laneSessionIds(ruleSessionLanes(legacySessions)),
  );

  const baseOptions = {
    cwd: "/repo",
    pr: "main...feature",
    sinceMs: 0,
    nowMs: 1_000,
    runner: sessionAnalysisRunner(),
    persist: false,
  } as const;
  const legacy = await analyze({
    ...baseOptions,
    sessionSource: discoveringSource(legacyContract, [rawSession()]),
  });
  const neutral = await analyze({
    ...baseOptions,
    sessionSource: discoveringSource(neutralContract, [rawSession()]),
  });
  const legacySnapshot = legacy.audit_identity.snapshot_identity;
  const neutralSnapshot = neutral.audit_identity.snapshot_identity;
  assert.ok("source_digest" in legacySnapshot);
  assert.ok("source_digest" in neutralSnapshot);

  assert.deepEqual(neutral.report.sources, legacy.report.sources);
  assert.deepEqual(neutral.report.rule_coverage, legacy.report.rule_coverage);
  assert.deepEqual(neutral.report, legacy.report);
  assert.deepEqual(neutral.record, legacy.record);
  assert.equal(neutralSnapshot.source_digest, legacySnapshot.source_digest);
  assert.equal(
    neutral.audit_identity.snapshot_id,
    legacy.audit_identity.snapshot_id,
  );
  assert.equal(
    neutral.audit_identity.deterministic_digest,
    legacy.audit_identity.deterministic_digest,
  );
});
