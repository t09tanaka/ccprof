# Composite Event Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent event, invocation, and R003 token evidence from colliding when different source adapters or source files reuse session, agent, and tool-use identifiers.

**Architecture:** Introduce one non-persisted `EventIdentity` contract and one collision-safe, tagged tuple encoder in `src/core/event-identity.ts`. Sessions remain source-adapter inputs exactly as they are today; `buildTimeline()` enriches internal actions from `Session.source`, `Session.source_path`, and each `NormalizedEvent`, then downstream correlation projects the full identity to the session lane, agent lane, or invocation domain as needed. Full event identity, including `source_index`, is retained for dedupe and selected-result token lookup; invocation matching deliberately omits only `source_index`.

**Tech Stack:** TypeScript 5.9, Node.js 20+ built-in test runner, existing ccprof timeline/rule pipeline.

---

## Approved design and boundaries

- `EventIdentity` has exactly `source_adapter_id`, `source_instance_id`, `session_id`, `agent_id`, optional `tool_use_id`, and `source_index`.
- `source_adapter_id` is copied from `Session.source`; `source_instance_id` is copied from `Session.source_path`. Event text, result output, compaction summaries, command text, and edit fragments never participate in identity encoding.
- The canonical encoder uses a versioned JSON tuple with an explicit optional-value tag. This avoids delimiter collisions for NUL, Unicode, an absent tool ID, and an explicitly empty tool ID.
- Domain projection helpers provide full-event, invocation, agent, and session-lane keys. Consumers do not concatenate identity fields themselves.
- Timeline actions carry the use/start event identity and, for a valid paired tool result, the exact selected result identity. These fields are analysis-only: Report v2, Store records, finding keys, snapshot digests, and schemas do not change.
- Existing external and test `Session` literals remain valid. Low-level synthetic `TimelineAction` test fixtures may omit identities and use the helper's deterministic unattributed fallback, while every production action emitted by `buildTimeline()` is fully enriched.
- Only evidence-correlation keys in timeline, analyze, diff matcher, context bloat, flaky test, rediscovery, and directly affected rework/serial-slack grouping change. Command identity, report contracts, capabilities, policy, stats, SourceDescriptor, and Store work are excluded.

## Edge cases fixed before implementation

- Two adapters may emit the same `source_path`, `session_id`, `agent_id`, and `tool_use_id`; they must not pair.
- Two source paths may otherwise emit identical identifiers; their events and token estimates remain distinct.
- Tool uses and results have different `source_index` values but share one invocation projection.
- Multiple candidate results retain distinct full identities; only the result selected by timeline pairing supplies R003 tokens.
- Reversing session input order produces byte-for-byte equivalent timeline/candidate ordering.
- A tool use without a valid result retains the existing zero-duration action and missing-result caveat and has no selected-result identity.

### Task 1: Add the identity contract and canonical projections

**Files:**
- Create: `src/core/event-identity.ts`
- Modify: `src/core/model.ts`
- Create: `test/event-identity.test.ts`

- [ ] **Step 1: Write focused identity tests**

```ts
const identity = eventIdentity(session, toolResult);
assert.deepEqual(identity, {
  source_adapter_id: "claude",
  source_instance_id: "/logs/session.jsonl",
  session_id: "session",
  agent_id: "agent",
  tool_use_id: "call",
  source_index: 7,
});
assert.notEqual(encodeEventIdentity(identity), encodeEventIdentity({ ...identity, source_index: 8 }));
assert.equal(encodeInvocationIdentity(identity), encodeInvocationIdentity({ ...identity, source_index: 8 }));
assert.notEqual(
  encodeEventIdentity({ ...identity, tool_use_id: undefined }),
  encodeEventIdentity({ ...identity, tool_use_id: "" }),
);
```

Also vary each remaining field independently, compare NUL-shifted field pairs, compare distinct Unicode/lone-surrogate values, and assert secret event output is absent from both the identity object and encoded key.

- [ ] **Step 2: Delegate RED verification**

Run: `npm test -- --test-name-pattern='EventIdentity|event identity'`

Expected: FAIL because `src/core/event-identity.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal identity module**

```ts
export interface EventIdentity {
  source_adapter_id: string;
  source_instance_id: string;
  session_id: string;
  agent_id: string;
  tool_use_id?: string;
  source_index: number;
}

export function eventIdentity(
  session: Pick<Session, "source" | "source_path">,
  event: NormalizedEvent,
): EventIdentity;
export function encodeEventIdentity(identity: EventIdentity): string;
export function encodeInvocationIdentity(identity: EventIdentity): string;
export function encodeAgentIdentity(identity: EventIdentity): string;
export function encodeSessionIdentity(identity: EventIdentity): string;
export function encodeIdentityScope(
  domain: string,
  identityKey: string,
  ...values: readonly (number | string | undefined)[]
): string;
```

Add optional analysis-only `event_identity` and `result_identity` fields to `TimelineAction` so current action literals remain compatible and `MatchedAction` preserves the correlation metadata through existing spreads.

- [ ] **Step 4: Delegate GREEN verification**

Run: `npm test -- --test-name-pattern='EventIdentity|event identity'`

Expected: PASS with every field, NUL, Unicode, and optional-ID case covered.

### Task 2: Make timeline pairing and action correlation source-safe

**Files:**
- Modify: `src/analysis/timeline.ts`
- Modify: `src/core/analyze.ts`
- Modify: `src/analysis/diff-matcher.ts`
- Modify: `src/rules/context-bloat.ts`
- Modify: `src/rules/flaky-test.ts`
- Modify: `src/rules/rework.ts`
- Modify: `src/rules/serial-slack.ts`
- Modify: `test/timeline.test.ts`

- [ ] **Step 1: Write timeline regressions first**

```ts
const useSession = session([toolUse("shared", 10, 0)]);
const resultSession = {
  ...session([toolResult("shared", 20, 1)]),
  source: "codex" as const,
};
assert.deepEqual(buildTimeline([useSession, resultSession]).toolIntervals, []);
assert.deepEqual(
  buildTimeline([resultSession, useSession]),
  buildTimeline([useSession, resultSession]),
);
```

Use the same `source_path`, session, agent, and tool ID in both sessions so only the adapter field prevents pairing. Extend the duplicate-result test to assert that `result_identity.source_index` is the selected positive result's index, and extend the missing-result test to assert `result_identity === undefined` while the current caveat remains.

- [ ] **Step 2: Delegate RED verification**

Run: `npm test -- --test-name-pattern='source adapter|selected result identity|missing result identity|input order'`

Expected: FAIL because adapter-aware canonical correlation and selected-result identity are absent.

- [ ] **Step 3: Replace only event-evidence keys**

Construct `EventIdentity` while collecting session events. Use full `encodeEventIdentity()` for event dedupe, `encodeSessionIdentity()` for source lanes, `encodeAgentIdentity()` for agent lanes, and `encodeInvocationIdentity()` for tool use/result pairing. Attach the use/start identity and selected valid result identity to timeline actions. In analyze and the listed rules, replace only session/agent/tool string keys used to associate event evidence; leave command identity and unrelated finding/persistence keys intact.

- [ ] **Step 4: Delegate GREEN verification**

Run: `npm test -- --test-name-pattern='source adapter|selected result identity|missing result identity|input order|timeline|context bloat|flaky|rework|serial'`

Expected: PASS, including existing missing-result caveats and duplicate-result selection.

### Task 3: Bind R003 tokens to the selected full result identity

**Files:**
- Modify: `src/core/analyze.ts`
- Modify: `src/rules/rediscovery.ts`
- Modify: `src/rules/capabilities.ts`
- Modify: `test/rules-primary.test.ts`

- [ ] **Step 1: Write the 120-vs-900 canary**

```ts
const selected = { ...baseIdentity, source_instance_id: "/a", source_index: 2 };
const colliding = { ...baseIdentity, source_instance_id: "/b", source_index: 2 };
const finding = detectRediscovery([safeRead, duplicateRead], {
  estimatedTokensByEventIdentity: new Map([
    [encodeEventIdentity(selected), 120],
    [encodeEventIdentity(colliding), 900],
  ]),
});
assert.equal(finding[0]?.evidence.estimated_tokens, 120);
```

Make `duplicateRead.result_identity` equal `selected`; give `safeRead` the same session/agent/tool ID but `colliding` source identity. Add a reversed-input assertion, a selected-duplicate-result assertion, and a missing-result assertion that preserves the existing missing-token-evidence caveat.

- [ ] **Step 2: Delegate RED verification**

Run: `npm test -- --test-name-pattern='120|900|selected result identity|missing token evidence'`

Expected: FAIL because R003 still indexes by bare `tool_use_id`.

- [ ] **Step 3: Replace the token map**

Change `tokenEstimates()` to key every `ToolResultEvent` by `encodeEventIdentity(event.event_identity)`. Rename the option to `estimatedTokensByEventIdentity`, and have R003 collect and sum only distinct `result_identity` keys from claimed reads. Missing/invalid selected-result evidence contributes zero and retains the existing caveat.

- [ ] **Step 4: Delegate GREEN and complete checks**

Run: `npm test -- --test-name-pattern='R003|120|900|selected result identity|missing token evidence'`

Expected: PASS with `estimated_tokens === 120` for the collision canary.

Run: `npm run check`

Expected: PASS for typecheck and the complete test suite.

### Task 4: Commit, local CI, PR, and review

**Files:**
- Include: `docs/superpowers/plans/2026-08-03-composite-event-identity.md`
- Include: all Task 1-3 production and test files
- Exclude: generated `.test-dist/`, `node_modules/`, Store data, Report/schema changes, and all later enterprise-hardening work

- [ ] **Step 1: Commit logical units with Codex coauthor**

```text
docs: plan composite event identity
test: cover composite event identity collisions
fix: use composite identity for event correlation
```

Each commit ends with `Co-Authored-By: Codex <noreply@openai.com>`. Do not amend and do not bypass hooks.

- [ ] **Step 2: Delegate the local GitHub Actions equivalent before push**

The verifier reads the changed paths and `.github/workflows`, then runs each applicable workflow step locally without modifying files. All applicable units must pass before push.

- [ ] **Step 3: Push and open a PR against `main`**

Title: `[Core] fix: isolate event identity across sources`

The PR body records the exact test commands, the analysis-only `TimelineAction` impact, no persisted/report contract change, added tests, and revert-safe rollback.

- [ ] **Step 4: Complete CI and two-stage review**

Monitor all GitHub checks to completion. Independently review spec compliance first, then code quality. Fix only Critical/Important issues introduced by this change, commit without amend, re-run local checks before each logic push, and repeat CI/review until green and approved. Do not merge.

- [ ] **Step 5: Clean up the worktree**

After CI and both reviews are green, verify a clean worktree, zero unpushed commits, and an existing PR; remove `.worktrees/composite-event-identity` and local `feature/composite-event-identity` while leaving the remote branch and open PR intact.
