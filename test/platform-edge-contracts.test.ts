import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GitContextError,
  resolvePrContext,
} from "../src/git/pr-context.js";
import {
  canonicalRepoPath,
  repoHash,
} from "../src/store/paths.js";

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}

test("mixed-case aliases share canonical identity on a case-insensitive filesystem", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-case-contract-"));
  try {
    const mixedCase = join(root, "MiXeD-RePo");
    const alternateCase = join(root, "mIxEd-rEpO");
    await mkdir(mixedCase);

    try {
      await realpath(alternateCase);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        t.skip("filesystem is case-sensitive");
        return;
      }
      throw error;
    }

    const mixedIdentity = await canonicalRepoPath(mixedCase);
    const alternateIdentity = await canonicalRepoPath(alternateCase);
    assert.equal(alternateIdentity, mixedIdentity);
    assert.equal(repoHash(alternateIdentity), repoHash(mixedIdentity));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an actual NFD-named directory canonicalizes and hashes as NFC", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-unicode-contract-"));
  try {
    const nfdName = "caf\u00e9-repo".normalize("NFD");
    const nfdPath = join(root, nfdName);
    await mkdir(nfdPath);

    const canonicalFromNfd = await canonicalRepoPath(nfdPath);
    const canonicalFromNfc = await canonicalRepoPath(nfdPath.normalize("NFC"));
    assert.equal(canonicalFromNfd, canonicalFromNfc);
    assert.equal(canonicalFromNfd, canonicalFromNfd.normalize("NFC"));
    assert.equal(
      repoHash(canonicalFromNfd),
      repoHash(canonicalFromNfd.normalize("NFD")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real bare repository fails PR context resolution at show-toplevel", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccprof-bare-contract-"));
  try {
    const bareRepo = join(root, "repository.git");
    git(["init", "--bare", "--quiet", bareRepo], root);

    await assert.rejects(
      resolvePrContext({
        cwd: bareRepo,
        input: "main...HEAD",
        includeBranchReflog: false,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GitContextError);
        assert.match(
          error.message,
          /git rev-parse --show-toplevel failed with exit/u,
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
