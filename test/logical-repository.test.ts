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

test("logical repository remote canonicalizes equivalent fetch syntaxes", () => {
  const expected = {
    status: "available",
    logical_repository_id: digest(["remote", "github.com", null, "owner/repo"]),
    source: "remote",
    portability: "portable",
  };
  const equivalent = [
    "https://user:secret@GITHUB.com:443/Owner/Repo.git?token=secret#fragment",
    "ssh://git@github.com:22/owner/repo/",
    "git@github.com:owner/repo.git",
    "github.com:owner/repo.git",
  ];

  for (const fetch_url of equivalent) {
    assert.deepEqual(
      resolveLogicalRepositoryIdentity({
        remotes: [{ name: "origin", fetch_url }],
      }),
      expected,
    );
  }
});

test("logical repository remote applies only known-provider path case rules", () => {
  for (const host of ["github.com", "gitlab.com"]) {
    const upper = resolveLogicalRepositoryIdentity({
        remotes: [{ name: "origin", fetch_url: `https://${host}/Owner/Repo` }],
      });
    const lower = resolveLogicalRepositoryIdentity({
        remotes: [{ name: "origin", fetch_url: `https://${host}/owner/repo` }],
      });
    assert.equal(upper.status, "available");
    assert.deepEqual(upper, lower);
  }
  assert.notDeepEqual(
    resolveLogicalRepositoryIdentity({
      remotes: [
        { name: "origin", fetch_url: "https://code.example/Owner/Repo" },
      ],
    }),
    resolveLogicalRepositoryIdentity({
      remotes: [
        { name: "origin", fetch_url: "https://code.example/owner/repo" },
      ],
    }),
  );
});

test("logical repository remote normalizes IDNA hosts and NFC paths", () => {
  const unicode = resolveLogicalRepositoryIdentity({
      remotes: [
        {
          name: "origin",
          fetch_url: "https://B\u00dcCHER.example./Cafe\u0301/Repo.git",
        },
      ],
    });
  const ascii = resolveLogicalRepositoryIdentity({
      remotes: [
        {
          name: "origin",
          fetch_url: "git@xn--bcher-kva.example:Caf\u00e9/Repo",
        },
      ],
    });
  assert.deepEqual(unicode, {
    status: "available",
    logical_repository_id: digest([
      "remote",
      "xn--bcher-kva.example",
      null,
      "Caf\u00e9/Repo",
    ]),
    source: "remote",
    portability: "portable",
  });
  assert.deepEqual(unicode, ascii);
});

test("logical repository remote strips default ports and preserves custom ports", () => {
  const defaultPort = resolveLogicalRepositoryIdentity({
    remotes: [
      { name: "origin", fetch_url: "https://example.com:443/Owner/Repo" },
    ],
  });
  const omittedPort = resolveLogicalRepositoryIdentity({
    remotes: [
      { name: "origin", fetch_url: "https://example.com/Owner/Repo" },
    ],
  });
  const customPort = resolveLogicalRepositoryIdentity({
    remotes: [
      { name: "origin", fetch_url: "https://example.com:8443/Owner/Repo" },
    ],
  });

  assert.deepEqual(defaultPort, omittedPort);
  assert.equal(defaultPort.status, "available");
  assert.notDeepEqual(customPort, omittedPort);
});

test("logical repository remote explicit selection beats origin and other remotes", () => {
  const selected = "https://example.com/selected/repo";
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      remotes: [
        { name: "origin", fetch_url: "https://example.com/origin/repo" },
        { name: "upstream", fetch_url: selected, explicit_identity: true },
        { name: "broken", fetch_url: "file:///private/repo" },
      ],
    }),
    {
      status: "available",
      logical_repository_id: digest([
        "remote",
        "example.com",
        null,
        "selected/repo",
      ]),
      source: "remote",
      portability: "portable",
    },
  );
});

test("logical repository remote origin selection beats other remotes", () => {
  const selected = "https://example.com/origin/repo";
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      remotes: [
        { name: "upstream", fetch_url: "not-a-fetch-url" },
        { name: "origin", fetch_url: selected },
      ],
    }),
    {
      status: "available",
      logical_repository_id: digest([
        "remote",
        "example.com",
        null,
        "origin/repo",
      ]),
      source: "remote",
      portability: "portable",
    },
  );
});

test("logical repository remote accepts canonical-equal unselected candidates", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      remotes: [
        {
          name: "primary",
          fetch_url: "https://github.com/Owner/Repo.git",
        },
        { name: "upstream", fetch_url: "git@github.com:owner/repo" },
      ],
    }),
    {
      status: "available",
      logical_repository_id: digest(["remote", "github.com", null, "owner/repo"]),
      source: "remote",
      portability: "portable",
    },
  );
});

test("logical repository remote reports ambiguous selections", () => {
  const url = (path: string) => `https://example.com/${path}`;
  const cases: LogicalRepositoryIdentityInput[] = [
    {
      remotes: [
        { name: "a", fetch_url: url("a"), explicit_identity: true },
        { name: "b", fetch_url: url("b"), explicit_identity: true },
      ],
    },
    {
      remotes: [
        { name: "origin", fetch_url: url("a") },
        { name: "origin", fetch_url: url("b") },
      ],
    },
    {
      remotes: [
        { name: "one", fetch_url: url("a") },
        { name: "two", fetch_url: url("b") },
      ],
    },
  ];

  for (const input of cases) {
    assert.deepEqual(resolveLogicalRepositoryIdentity(input), {
      status: "unavailable",
      reason: "ambiguous_remote",
    });
  }
});

test("logical repository remote fails closed for an invalid selected candidate", () => {
  const cases: LogicalRepositoryIdentityInput[] = [
    {
      remotes: [
        { name: "chosen", fetch_url: "file:///private/repo", explicit_identity: true },
        { name: "origin", fetch_url: "https://example.com/valid/repo" },
      ],
    },
    {
      remotes: [
        { name: "other", fetch_url: "https://example.com/valid/repo" },
        { name: "origin", fetch_url: "not-a-fetch-url" },
      ],
    },
    {
      remotes: [
        { name: "one", fetch_url: "https://example.com/valid/repo" },
        { name: "two", fetch_url: "file:///private/repo" },
      ],
    },
  ];

  for (const input of cases) {
    assert.deepEqual(resolveLogicalRepositoryIdentity(input), {
      status: "unavailable",
      reason: "invalid_remote",
    });
  }
});

test("logical repository remote rejects unsafe and non-fetch inputs", () => {
  const invalid = [
    "file:///tmp/repo",
    "http://example.com/repo",
    "git://example.com/repo",
    "/tmp/repo",
    "../repo",
    "C:\\repo",
    "C:/repo",
    "file:/tmp/repo",
    "https:github.com/owner/repo",
    "ssh:host/path",
    "git:host/repo",
    "https://example.com",
    "ssh://git@example.com/",
    "https://example.com/a%2Frepo",
    "ssh://example.com/a%5Crepo",
    "https://example.com/a\\repo",
    "https://example.com/a/../repo",
    "https://example.com/a/%2e%2e/repo",
    "https://example.com/%00repo",
    "https://example.com/repo?value=%00",
    "https://example.com/%ZZ",
    "https://example.com/repo\nsecret",
  ];

  for (const fetch_url of invalid) {
    assert.deepEqual(
      resolveLogicalRepositoryIdentity({
        remotes: [{ name: "origin", fetch_url }],
        offline_uuid: "550e8400-e29b-41d4-a716-446655440000",
        local_path: "/fallback",
      }),
      { status: "unavailable", reason: "invalid_remote" },
    );
  }
});

test("logical repository remote enforces collection and string bounds", () => {
  const valid = "https://example.com/owner/repo";
  const invalidInputs: LogicalRepositoryIdentityInput[] = [
    {
      remotes: Array.from({ length: 33 }, (_, index) => ({
        name: `remote-${index}`,
        fetch_url: valid,
      })),
    },
    { remotes: [{ name: "", fetch_url: valid }] },
    { remotes: [{ name: "n".repeat(129), fetch_url: valid }] },
    { remotes: [{ name: "bad\nname", fetch_url: valid }] },
    { remotes: [{ name: "origin", fetch_url: "x".repeat(2049) }] },
  ];

  for (const input of invalidInputs) {
    assert.deepEqual(resolveLogicalRepositoryIdentity(input), {
      status: "unavailable",
      reason: "invalid_remote",
    });
  }
});

test("logical repository remote results do not expose credentials or URLs", () => {
  const fetch_url =
    "https://alice:secret@example.com/Private/Repo.git?token=credential#private";
  const json = JSON.stringify(
    resolveLogicalRepositoryIdentity({
      remotes: [{ name: "origin", fetch_url }],
    }),
  );

  assert.equal(json.includes('"source":"remote"'), true);
  for (const secret of [fetch_url, "alice", "secret", "credential", "Private"]) {
    assert.equal(json.includes(secret), false);
  }
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

function throwingGetter(field: string): object {
  return Object.defineProperty({}, field, {
    get() {
      throw new Error("private getter failure");
    },
  });
}

test("logical repository fails closed when the provider input cannot be read", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity(
      throwingGetter("trusted_provider") as LogicalRepositoryIdentityInput,
    ),
    { status: "unavailable", reason: "invalid_provider" },
  );
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      trusted_provider: throwingGetter("provider") as never,
    }),
    { status: "unavailable", reason: "invalid_provider" },
  );
  assert.deepEqual(
    resolveLogicalRepositoryIdentity(null as never),
    { status: "unavailable", reason: "invalid_provider" },
  );
});

test("logical repository fails closed when the remotes input cannot be read", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity(
      throwingGetter("remotes") as LogicalRepositoryIdentityInput,
    ),
    { status: "unavailable", reason: "invalid_remote" },
  );
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      remotes: new Proxy([], {
        get() {
          throw new Error("private collection failure");
        },
      }),
    }),
    { status: "unavailable", reason: "invalid_remote" },
  );
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      remotes: [
        new Proxy({ name: "origin", fetch_url: "https://example.com/repo" }, {
          get() {
            throw new Error("private entry failure");
          },
        }),
      ],
    }),
    { status: "unavailable", reason: "invalid_remote" },
  );
});

test("logical repository rejects malformed remotes without falling through", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity({
      remotes: {} as never,
      offline_uuid: "550e8400-e29b-41d4-a716-446655440000",
      local_path: "/fallback",
    }),
    { status: "unavailable", reason: "invalid_remote" },
  );
});

test("logical repository maps fallback getter failures to their source", () => {
  assert.deepEqual(
    resolveLogicalRepositoryIdentity(
      throwingGetter("offline_uuid") as LogicalRepositoryIdentityInput,
    ),
    { status: "unavailable", reason: "invalid_offline_uuid" },
  );
  assert.deepEqual(
    resolveLogicalRepositoryIdentity(
      throwingGetter("local_path") as LogicalRepositoryIdentityInput,
    ),
    { status: "unavailable", reason: "invalid_local_path" },
  );
});
