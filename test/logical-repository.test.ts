import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  resolveLogicalRepositoryIdentity,
  type LogicalRepositoryIdentityInput,
} from "../src/core/logical-repository.js";

function digest(tuple: readonly unknown[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("ccprof\0logical-repository-v1\0")
    .update(JSON.stringify(tuple))
    .digest("hex")}`;
}

test("logical repository hashes a normalized trusted provider tuple", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      trusted_provider: {
        provider: "GitHub",
        host: "GITHUB.COM",
        repository_id: "NODE_123",
      },
    }),
    {
      status: "available",
      logical_repository_id: digest([
        "provider",
        "github",
        "github.com",
        "NODE_123",
      ]),
      source: "provider",
      portability: "portable",
    },
  );
});

test("logical repository normalizes provider hosts with IDNA", () => {
  const unicode = resolveLogicalRepositoryIdentity({
    trusted_provider: {
      provider: "Forge",
      host: "B\u00dcCHER.EXAMPLE",
      repository_id: "Repo",
    },
  });
  const ascii = resolveLogicalRepositoryIdentity({
    trusted_provider: {
      provider: "forge",
      host: "xn--bcher-kva.example",
      repository_id: "Repo",
    },
  });

  assert.deepEqual(unicode, ascii);
});

test("logical repository normalizes one trailing provider DNS dot", () => {
  const dotted = resolveLogicalRepositoryIdentity({
    trusted_provider: {
      provider: "forge",
      host: "github.com.",
      repository_id: "Repo",
    },
  });
  const plain = resolveLogicalRepositoryIdentity({
    trusted_provider: {
      provider: "forge",
      host: "github.com",
      repository_id: "Repo",
    },
  });

  assert.deepEqual(dotted, plain);
});

test("logical repository rejects encoded and invalid provider DNS labels", () => {
  for (const host of [
    "github%2ecom",
    "bad_label.example",
    "-bad.example",
    "bad-.example",
  ]) {
    assert.deepEqual(
      resolveLogicalRepositoryIdentity({
        trusted_provider: { provider: "forge", host, repository_id: "Repo" },
      }),
      { status: "unavailable", reason: "invalid_provider" },
    );
  }
});

test("logical repository provider wins over every lower-priority source", () => {
  const input: LogicalRepositoryIdentityInput = {
    trusted_provider: {
      provider: "GitHub",
      host: "github.com",
      repository_id: "NODE_123",
    },
    remotes: [{ name: "origin", fetch_url: "not-a-remote" }],
    offline_uuid: "550e8400-e29b-41d4-a716-446655440000",
    local_path: "/private/repository",
  };

  const result = resolveLogicalRepositoryIdentity(input);
  assert.equal(result.status, "available");
  if (result.status !== "available") assert.fail("expected available identity");
  assert.equal(result.source, "provider");
});

test("logical repository invalid supplied provider fails closed", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      trusted_provider: {
        provider: "github",
        host: "user@github.com:443/repo",
        repository_id: "NODE_123",
      },
      offline_uuid: "550e8400-e29b-41d4-a716-446655440000",
      local_path: "/fallback",
    }),
    { status: "unavailable", reason: "invalid_provider" },
  );
});

test("logical repository treats nonempty remotes as invalid in the initial slice", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      remotes: [{ name: "origin", fetch_url: "https://github.com/a/b.git" }],
      offline_uuid: "550e8400-e29b-41d4-a716-446655440000",
      local_path: "/fallback",
    }),
    { status: "unavailable", reason: "invalid_remote" },
  );
});

test("logical repository normalizes an explicit RFC 4122 UUID to lowercase", () => {
  const upper = resolveLogicalRepositoryIdentity({
    offline_uuid: "550E8400-E29B-41D4-A716-446655440000",
  });
  const lower = resolveLogicalRepositoryIdentity({
    remotes: [],
    offline_uuid: "550e8400-e29b-41d4-a716-446655440000",
  });

  assert.deepEqual(upper, lower);
  assert.deepEqual(lower, {
    status: "available",
    logical_repository_id: digest([
      "offline_uuid",
      "550e8400-e29b-41d4-a716-446655440000",
    ]),
    source: "offline",
    portability: "portable",
  });
});

test("logical repository invalid supplied UUID fails closed", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      offline_uuid: "550e8400-e29b-01d4-a716-446655440000",
      local_path: "/fallback",
    }),
    { status: "unavailable", reason: "invalid_offline_uuid" },
  );
});

test("logical repository normalizes absolute local paths as local-only", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({ local_path: "C:\\Repos\\Cafe\u0301\\" }),
    {
      status: "available",
      logical_repository_id: digest(["local_path", "c:/Repos/Caf\u00e9"]),
      source: "local_path",
      portability: "local_only",
    },
  );
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({ local_path: "/srv/repository///" }),
    {
      status: "available",
      logical_repository_id: digest(["local_path", "/srv/repository"]),
      source: "local_path",
      portability: "local_only",
    },
  );
});

test("logical repository rejects supplied relative local paths", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({ local_path: "relative/repository" }),
    { status: "unavailable", reason: "invalid_local_path" },
  );
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({ local_path: "\\repository" }),
    { status: "unavailable", reason: "invalid_local_path" },
  );
});

test("logical repository rejects POSIX backslashes and malformed UNC roots", () => {
  for (const local_path of [
    "/srv/repo\\alias",
    "\\\\server",
    "\\\\server\\",
    "\\\\\\share",
  ]) {
    assert.deepEqual(resolveLogicalRepositoryIdentity({ local_path }), {
      status: "unavailable",
      reason: "invalid_local_path",
    });
  }
});

test("logical repository results do not expose raw identity inputs", () => {
  const secretInputs: LogicalRepositoryIdentityInput[] = [
    {
      trusted_provider: {
        provider: "private-forge",
        host: "secret.example",
        repository_id: "SENSITIVE_REPOSITORY_ID",
      },
    },
    { offline_uuid: "550e8400-e29b-41d4-a716-446655440000" },
    { local_path: "/Users/private/secret-repository" },
  ];
  const secrets = [
    "private-forge",
    "secret.example",
    "SENSITIVE_REPOSITORY_ID",
    "550e8400-e29b-41d4-a716-446655440000",
    "/Users/private/secret-repository",
  ];

  const json = JSON.stringify(
    secretInputs.map(resolveLogicalRepositoryIdentity),
  );
  for (const secret of secrets) assert.equal(json.includes(secret), false);
});

test("logical repository reports no identity when no source is supplied", () => {
  assert.deepEqual(resolveLogicalRepositoryIdentity({}), {
    status: "unavailable",
    reason: "no_identity",
  });
});
