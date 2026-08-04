# Logical Repository Identity Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure, privacy-preserving resolver for a portable logical repository ID without changing the path-bound Store or source-evidence cache identities.

**Architecture:** A new standalone core module accepts already-obtained provider, fetch-remote, offline UUID, and canonical local-path inputs. It selects exactly one source in priority order, normalizes it into a typed tuple, and hashes `ccprof\0logical-repository-v1\0` plus the tuple JSON with SHA-256. Results expose only the opaque digest, source class, and portability; invalid or ambiguous higher-priority input fails closed instead of falling through.

**Tech Stack:** TypeScript, Node.js `crypto`/`url`/`path`, Node test runner.

---

## Scope and edge cases

- Keep `StorePaths.repo_hash`, SQLite schemas, source-evidence cache binding, Report v2, and Report v3 producers unchanged.
- Provider assignment wins only when explicitly supplied; a remote is never promoted into a provider assignment.
- An invalid supplied higher-priority identity fails closed. It never silently falls through to an offline UUID or local path.
- Remote choice is deterministic: exactly one `explicit_identity` remote, otherwise exactly one `origin`, otherwise all candidates must normalize to one identical identity. Multiple explicit/origin candidates and distinct normalized candidates are unavailable.
- Remote normalization accepts HTTPS, SSH URL, and SCP-like fetch syntax; strips userinfo, query, and fragment; normalizes IDNA/lowercase hosts and default ports; unifies scheme spelling; applies known-provider path casing; and removes trailing slash/`.git`.
- Local/file URLs, relative/absolute filesystem paths, Windows drive paths, control characters, backslashes, and percent-encoded path separators fail closed.
- Offline identity must be an explicit RFC 4122 UUID. The resolver does not create or persist one.
- Local-path fallback is visibly `local_only`, so a future Report v3 producer can reject it. No raw URL, path, provider ID, or UUID appears in the result.

## File map

- Create `src/core/logical-repository.ts`: public input/result types, selection, normalization, and digesting.
- Create `test/logical-repository.test.ts`: contract, priority, equivalence, rejection, ambiguity, and privacy tests.
- Create `docs/superpowers/plans/2026-08-05-logical-repository-id.md`: this design and TDD execution record.

### Task 1: Define the resolver contract with failing tests

**Files:**
- Create: `test/logical-repository.test.ts`
- Create: `src/core/logical-repository.ts`

- [ ] **Step 1: Write the provider, priority, and privacy tests**

Use this public contract in the test imports:

```ts
import {
  resolveLogicalRepositoryIdentity,
  type LogicalRepositoryIdentityInput,
} from "../src/core/logical-repository.js";
```

Construct the provider expectation from the fixed wire encoding:

```ts
const expected = `sha256:${createHash("sha256")
  .update("ccprof\0logical-repository-v1\0")
  .update(JSON.stringify(["provider", "github", "github.com", "NODE_123"]))
  .digest("hex")}`;

assert.deepEqual(resolveLogicalRepositoryIdentity({
  trusted_provider: {
    provider: "GitHub",
    host: "GITHUB.COM",
    repository_id: "NODE_123",
  },
}), {
  status: "available",
  logical_repository_id: expected,
  source: "provider",
  portability: "portable",
});
```

Also assert that provider wins over every lower source, an invalid supplied provider is unavailable, result JSON contains none of the raw inputs, explicit UUIDs normalize case, local fallback is `local_only`, and missing input is unavailable.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --test-name-pattern='logical repository'`

Expected: FAIL because `src/core/logical-repository.ts` does not exist.

- [ ] **Step 3: Add only the public types and provider/offline/local resolution**

Define these shapes exactly:

```ts
export interface TrustedProviderRepository {
  provider: string;
  host: string;
  repository_id: string;
}

export interface LogicalRepositoryRemote {
  name: string;
  fetch_url: string;
  explicit_identity?: boolean;
}

export interface LogicalRepositoryIdentityInput {
  trusted_provider?: TrustedProviderRepository;
  remotes?: readonly LogicalRepositoryRemote[];
  offline_uuid?: string;
  local_path?: string;
}

export type LogicalRepositoryIdentityResult =
  | {
    status: "available";
    logical_repository_id: `sha256:${string}`;
    source: "provider" | "remote" | "offline" | "local_path";
    portability: "portable" | "local_only";
  }
  | {
    status: "unavailable";
    reason:
      | "invalid_provider"
      | "invalid_remote"
      | "ambiguous_remote"
      | "invalid_offline_uuid"
      | "invalid_local_path"
      | "no_identity";
  };
```

Hash canonical tuples with:

```ts
function identityDigest(tuple: readonly unknown[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("ccprof\0logical-repository-v1\0")
    .update(JSON.stringify(tuple))
    .digest("hex")}`;
}
```

Provider tuple is `["provider", normalizedProvider, normalizedHost, repositoryId]`; offline tuple is `["offline_uuid", lowerUuid]`; local tuple is `["local_path", normalizedAbsolutePath]`. Validate bounded nonempty strings and reject control/NUL data. Provider and host are lowercase/IDNA-normalized while the opaque provider repository ID preserves case. Local paths must already be absolute, are NFC-normalized, use `/` separators, trim non-root trailing separators, and lower only a Windows drive letter.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern='logical repository'`

Expected: all provider/offline/local contract tests PASS.

- [ ] **Step 5: Commit the first TDD slice**

```bash
git add src/core/logical-repository.ts test/logical-repository.test.ts docs/superpowers/plans/2026-08-05-logical-repository-id.md
git commit -m "feat: define logical repository identity"
```

### Task 2: Resolve canonical fetch remotes

**Files:**
- Modify: `test/logical-repository.test.ts`
- Modify: `src/core/logical-repository.ts`

- [ ] **Step 1: Write remote equivalence and selection tests**

Assert that these fetch URLs produce the same remote ID:

```ts
const equivalent = [
  "https://user:secret@GITHUB.com:443/Owner/Repo.git?token=secret#fragment",
  "ssh://git@github.com:22/owner/repo/",
  "git@github.com:owner/repo.git",
];
```

Assert GitHub path case folds while an unknown host preserves path case; Unicode and punycode host spelling is equal; a custom port changes identity. Assert selection precedence with `explicit_identity: true`, then a single `origin`, then canonical-equal candidates. Assert two explicit candidates, two origins, or distinct candidates return `ambiguous_remote`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --test-name-pattern='logical repository remote'`

Expected: FAIL because supplied remotes are not yet resolved.

- [ ] **Step 3: Implement minimal remote parsing and choice**

Normalize a remote into the fixed tuple:

```ts
["remote", normalizedHost, normalizedPortOrNull, normalizedRepositoryPath]
```

Accept only `https:`, `ssh:`, and SCP-like `user@host:path` syntax. Strip URL username/password/search/hash by never including them in the tuple. Remove protocol default ports (`443` for HTTPS and `22` for SSH); preserve a custom numeric port. Convert the hostname with `domainToASCII`, lowercase it, and fail if conversion is empty. Decode the path after rejecting `%2f` and `%5c`, normalize NFC, reject dot segments and controls, remove leading/trailing separators and one terminal `.git`, and fold path case only for `github.com` and `gitlab.com`.

Select one candidate in this order:

```ts
const explicit = remotes.filter((remote) => remote.explicit_identity === true);
// exactly one explicit; otherwise exactly one origin; otherwise every remote
// must parse and serialize to the same tuple
```

If `remotes` is present and nonempty but selection or normalization fails, return unavailable and do not consult UUID/path inputs.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern='logical repository remote'`

Expected: all remote equivalence and selection tests PASS.

- [ ] **Step 5: Commit the remote slice**

```bash
git add src/core/logical-repository.ts test/logical-repository.test.ts
git commit -m "feat: canonicalize logical repository remotes"
```

### Task 3: Harden rejection boundaries and verify scope

**Files:**
- Modify: `test/logical-repository.test.ts`
- Modify: `src/core/logical-repository.ts`

- [ ] **Step 1: Write fail-closed tests**

Table-test `file:///tmp/repo`, `/tmp/repo`, `../repo`, `C:\\repo`, `https://host/a%2Frepo`, `ssh://host/a%5Crepo`, raw/decoded controls, backslashes, unsupported schemes, empty repository paths, invalid UUIDs, oversized inputs, malformed provider hosts, and invalid selected remotes. Verify each returns the matching unavailable reason and never falls through to lower inputs.

- [ ] **Step 2: Run the rejection tests and verify RED**

Run: `npm test -- --test-name-pattern='logical repository rejects'`

Expected: at least one case FAIL because its boundary is not implemented.

- [ ] **Step 3: Add the minimal missing validation**

Use fixed limits (`32` remotes, `64` provider name, `253` host, `512` provider ID, `2048` URL/path), reject getters only if field capture itself throws, and return unavailable instead of throwing for malformed user input. Do not add persistence, Git command execution, configuration loading, migration, or Report integration.

- [ ] **Step 4: Run focused and full verification**

Run: `npm test -- --test-name-pattern='logical repository'`

Expected: focused suite PASS.

Then delegate `npm run check` and `npm run build` to a test worker. Expected: all checks PASS with no warnings from the new module.

- [ ] **Step 5: Check final scope and commit**

Verify no more than 3 files changed and production changes stay under 300 lines:

```bash
git diff --stat origin/main...HEAD
git diff --numstat origin/main...HEAD -- src
git diff --check origin/main...HEAD
```

Then commit any remaining hardening change without amend:

```bash
git add src/core/logical-repository.ts test/logical-repository.test.ts docs/superpowers/plans/2026-08-05-logical-repository-id.md
git commit -m "test: harden logical repository identity"
```

### Task 4: Review, local CI, and PR lifecycle

**Files:**
- Review only; no planned production files.

- [ ] **Step 1: Run spec compliance review**

Confirm every requirement and explicit non-goal in this plan against `origin/main...HEAD`. Any gap is returned to the implementer with a new failing test before a fix.

- [ ] **Step 2: Run code quality/security review**

Review canonicalization aliasing, credential leakage, fail-open fallback, Unicode/percent encoding, cross-platform paths, and output stability. Fix only P0-P2 issues caused by this change, test first, in a new commit.

- [ ] **Step 3: Rebase and run local GitHub Actions**

Fetch and rebase onto the latest `origin/main` if it moved. Delegate `/run-github-actions-locally` Phase 1 and every returned Phase 2 execution unit. All applicable local jobs must pass before push.

- [ ] **Step 4: Complete and merge the PR**

Push, create a PR to `main`, run `ccprof --pr --json` when available, monitor remote checks and independent review in parallel, and resolve code-caused failures or actionable P0-P2 feedback with new TDD commits. Once green and approved, merge with a merge commit under the user's standing authorization.

- [ ] **Step 5: Clean up**

After merge, execute `/worktree-pr-flow:cleanup`, remove `.worktrees/logical-repository-id` and local `feature/logical-repository-id`, update the main checkout, and report the PR URL, merge commit, verification, review, and cleanup result.
