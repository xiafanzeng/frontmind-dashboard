import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertCleanProductionApprovalSource,
  assertCleanProductionBuildSource,
  assertCleanProductionReleaseWorktree,
} from "./assert-clean-build-source.mjs";
import {
  assertBuildArtifactLineage,
  readBuildArtifactManifest,
  verifyBuildArtifactManifest,
  writeBuildArtifactIdentity,
  writeBuildArtifactManifest,
} from "./build-artifact-identity.mjs";
import { recreateEmptyProductionBuildRoot } from "./production-build-root.mjs";
import {
  createRuntimeReleaseArtifactVerifier,
  verifyRuntimeReleaseArtifact,
} from "./runtime-artifact-integrity.mjs";

const temporaryRepositories: string[] = [];

function git(repositoryRoot: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository() {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "frontmind-dashboard-release-"),
  );
  temporaryRepositories.push(repositoryRoot);
  git(repositoryRoot, ["init", "-q"]);
  git(repositoryRoot, ["config", "user.email", "release@example.invalid"]);
  git(repositoryRoot, ["config", "user.name", "Release Test"]);
  await mkdir(path.join(repositoryRoot, "dist"));
  await writeFile(path.join(repositoryRoot, "source.ts"), "export {};\n");
  await writeFile(path.join(repositoryRoot, "dist", "index.js"), "old\n");
  git(repositoryRoot, ["add", "-A"]);
  git(repositoryRoot, ["commit", "-qm", "fixture source"]);
  return repositoryRoot;
}

async function populateReleaseArtifact(repositoryRoot: string) {
  const distRoot = path.join(repositoryRoot, "dist");
  await mkdir(path.join(distRoot, "public", "assets"), { recursive: true });
  await mkdir(path.join(distRoot, "private-workflows", "fixture.skill"), {
    recursive: true,
  });
  await writeFile(path.join(distRoot, "index.js"), "server\n");
  await writeFile(path.join(distRoot, "pdf-prepare-worker.js"), "worker\n");
  await writeFile(
    path.join(distRoot, "verify-presales-file-roundtrip.js"),
    "verifier\n",
  );
  await writeFile(path.join(distRoot, "public", "index.html"), "<html />\n");
  await writeFile(
    path.join(distRoot, "public", "assets", "entry.js"),
    "client\n",
  );
  await writeFile(
    path.join(distRoot, "public", "assets", "entry.css"),
    "body {}\n",
  );
  await writeFile(
    path.join(distRoot, "private-workflows", "fixture.skill", "SKILL.md"),
    "# Skill\n",
  );
  return distRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Dashboard production release identity", () => {
  it("requires a completely clean tracked, staged and untracked dist before the formal build", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    expect(
      assertCleanProductionReleaseWorktree({ repositoryRoot, env: {} }),
    ).toBe(sourceSha);

    await writeFile(path.join(repositoryRoot, "dist", "index.js"), "dirty\n");
    expect(() =>
      assertCleanProductionReleaseWorktree({ repositoryRoot, env: {} }),
    ).toThrow(/BUILD_RELEASE_WORKTREE_NOT_CLEAN:dist\/index\.js/u);

    git(repositoryRoot, ["add", "dist/index.js"]);
    expect(() =>
      assertCleanProductionReleaseWorktree({ repositoryRoot, env: {} }),
    ).toThrow(/BUILD_RELEASE_WORKTREE_NOT_CLEAN:dist\/index\.js/u);

    git(repositoryRoot, ["restore", "--staged", "--worktree", "dist/index.js"]);
    await writeFile(path.join(repositoryRoot, "dist", "untracked.js"), "x\n");
    expect(() =>
      assertCleanProductionReleaseWorktree({ repositoryRoot, env: {} }),
    ).toThrow(/BUILD_RELEASE_WORKTREE_NOT_CLEAN:dist\/untracked\.js/u);
  });

  it("recreates only the exact non-symlink repository dist root", async () => {
    const repositoryRoot = await createRepository();
    const distRoot = path.join(repositoryRoot, "dist");
    await recreateEmptyProductionBuildRoot({
      repositoryRoot,
      buildRoot: distRoot,
    });
    await expect(access(path.join(distRoot, "index.js"))).rejects.toThrow();

    await expect(
      recreateEmptyProductionBuildRoot({
        repositoryRoot,
        buildRoot: path.join(repositoryRoot, "not-dist"),
      }),
    ).rejects.toThrow("BUILD_RELEASE_DIST_TARGET_UNSAFE");

    await rm(distRoot, { recursive: true, force: true });
    await symlink(path.join(repositoryRoot, "source.ts"), distRoot);
    await expect(
      recreateEmptyProductionBuildRoot({ repositoryRoot, buildRoot: distRoot }),
    ).rejects.toThrow("BUILD_RELEASE_DIST_TARGET_IS_SYMLINK");
  });

  it("binds build-time environment identities to S", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    expect(
      assertCleanProductionBuildSource({
        repositoryRoot,
        env: {
          FRONTMIND_BUILD_SHA: sourceSha,
          BUILD_SHA: sourceSha.toUpperCase(),
          GITHUB_SHA: sourceSha,
          COMMIT_SHA: sourceSha,
        },
      }),
    ).toBe(sourceSha);
    expect(() =>
      assertCleanProductionBuildSource({
        repositoryRoot,
        env: { FRONTMIND_BUILD_SHA: "abc123" },
      }),
    ).toThrow("BUILD_SOURCE_ENV_SHA_INVALID");
    expect(() =>
      assertCleanProductionBuildSource({
        repositoryRoot,
        env: { FRONTMIND_BUILD_SHA: sourceSha, GITHUB_SHA: "f".repeat(40) },
      }),
    ).toThrow("BUILD_SOURCE_COMMIT_MISMATCH");
  });

  it("creates a single whole-dist manifest and rejects pre/post approval tampering", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const distRoot = await populateReleaseArtifact(repositoryRoot);
    await writeBuildArtifactIdentity(distRoot, sourceSha);
    const manifest = await writeBuildArtifactManifest(distRoot, sourceSha);
    await expect(
      writeBuildArtifactManifest(distRoot, sourceSha),
    ).rejects.toThrow("BUILD_ARTIFACT_MANIFEST_ALREADY_EXISTS");
    expect(manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "build-source.json",
        "index.js",
        "pdf-prepare-worker.js",
        "verify-presales-file-roundtrip.js",
        "public/index.html",
        "public/assets/entry.js",
        "public/assets/entry.css",
        "private-workflows/fixture.skill/SKILL.md",
      ]),
    );
    await expect(
      verifyBuildArtifactManifest(distRoot, {
        expectedBuildSourceSha: sourceSha,
      }),
    ).resolves.toMatchObject({ rootSha256: manifest.rootSha256 });

    await writeFile(
      path.join(distRoot, "public", "assets", "entry.js"),
      "tamper\n",
    );
    await expect(verifyBuildArtifactManifest(distRoot)).rejects.toThrow(
      "BUILD_ARTIFACT_BYTES_MISMATCH",
    );
  });

  it("rejects replaced manifests, extra files and untrusted source identity", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const distRoot = await populateReleaseArtifact(repositoryRoot);
    await writeBuildArtifactIdentity(distRoot, sourceSha);
    await writeBuildArtifactManifest(distRoot, sourceSha);

    await writeFile(path.join(distRoot, "injected.js"), "injected\n");
    await expect(verifyBuildArtifactManifest(distRoot)).rejects.toThrow(
      "BUILD_ARTIFACT_BYTES_MISMATCH",
    );
    await rm(path.join(distRoot, "injected.js"));
    await expect(
      verifyBuildArtifactManifest(distRoot, {
        expectedBuildSourceSha: "f".repeat(40),
      }),
    ).rejects.toThrow("BUILD_ARTIFACT_SOURCE_SHA_MISMATCH");

    const manifest = await readBuildArtifactManifest(distRoot);
    await writeFile(
      path.join(distRoot, "artifact-manifest.json"),
      JSON.stringify({ ...manifest, rootSha256: "0".repeat(64) }),
    );
    await expect(readBuildArtifactManifest(distRoot)).rejects.toThrow(
      "BUILD_ARTIFACT_MANIFEST_ROOT_MISMATCH",
    );
  });

  it("requires strict S to F ancestry with one or more dist-only changes", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repositoryRoot, "dist", "index.js"), "built\n");
    git(repositoryRoot, ["add", "dist"]);
    git(repositoryRoot, ["commit", "-qm", "artifact approval F"]);
    const approvalSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    expect(
      assertBuildArtifactLineage({
        repositoryRoot,
        approvalSha,
        buildSourceSha: sourceSha,
      }),
    ).toMatchObject({ approvalSha, buildSourceSha: sourceSha });

    expect(() =>
      assertBuildArtifactLineage({
        repositoryRoot,
        approvalSha: sourceSha,
        buildSourceSha: sourceSha,
      }),
    ).toThrow("BUILD_APPROVAL_MUST_DIFFER_FROM_SOURCE");

    git(repositoryRoot, ["commit", "--allow-empty", "-qm", "empty approval"]);
    expect(() =>
      assertBuildArtifactLineage({
        repositoryRoot,
        approvalSha: git(repositoryRoot, ["rev-parse", "HEAD"]),
        buildSourceSha: approvalSha,
      }),
    ).toThrow("BUILD_APPROVAL_HAS_NO_ARTIFACT_CHANGES");
  });

  it("rejects non-dist approval changes and unrelated history", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    await writeFile(
      path.join(repositoryRoot, "source.ts"),
      "export const x=1;\n",
    );
    git(repositoryRoot, ["add", "source.ts"]);
    git(repositoryRoot, ["commit", "-qm", "source drift"]);
    expect(() =>
      assertBuildArtifactLineage({
        repositoryRoot,
        approvalSha: git(repositoryRoot, ["rev-parse", "HEAD"]),
        buildSourceSha: sourceSha,
      }),
    ).toThrow(/BUILD_APPROVAL_CONTAINS_SOURCE_CHANGES:source\.ts/u);

    const tree = git(repositoryRoot, ["rev-parse", `${sourceSha}^{tree}`]);
    const unrelated = git(repositoryRoot, [
      "commit-tree",
      tree,
      "-m",
      "unrelated",
    ]);
    expect(() =>
      assertBuildArtifactLineage({
        repositoryRoot,
        approvalSha: unrelated,
        buildSourceSha: sourceSha,
      }),
    ).toThrow("BUILD_ARTIFACT_SOURCE_NOT_APPROVAL_ANCESTOR");
  });

  it("rejects source paths touched and later reverted anywhere between S and F", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    await writeFile(
      path.join(repositoryRoot, "source.ts"),
      "export const transient=true;\n",
    );
    git(repositoryRoot, ["add", "source.ts"]);
    git(repositoryRoot, ["commit", "-qm", "transient source drift"]);
    git(repositoryRoot, ["restore", `--source=${sourceSha}`, "source.ts"]);
    git(repositoryRoot, ["add", "source.ts"]);
    git(repositoryRoot, ["commit", "-qm", "revert source drift"]);
    await writeFile(path.join(repositoryRoot, "dist", "index.js"), "built\n");
    git(repositoryRoot, ["add", "dist"]);
    git(repositoryRoot, ["commit", "-qm", "artifact approval"]);

    expect(() =>
      assertBuildArtifactLineage({
        repositoryRoot,
        approvalSha: git(repositoryRoot, ["rev-parse", "HEAD"]),
        buildSourceSha: sourceSha,
      }),
    ).toThrow(/BUILD_APPROVAL_CONTAINS_SOURCE_CHANGES:source\.ts/u);
  });

  it("requires approval CI identities to name F and source identities to name S", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repositoryRoot, "dist", "index.js"), "built\n");
    git(repositoryRoot, ["add", "dist"]);
    git(repositoryRoot, ["commit", "-qm", "approval"]);
    const approvalSha = git(repositoryRoot, ["rev-parse", "HEAD"]);

    expect(
      assertCleanProductionApprovalSource({
        repositoryRoot,
        approvalSha,
        buildSourceSha: sourceSha,
        env: {
          FRONTMIND_APPROVED_RELEASE_SHA: approvalSha,
          GITHUB_SHA: approvalSha,
          COMMIT_SHA: approvalSha,
          FRONTMIND_BUILD_SHA: sourceSha,
          BUILD_SHA: sourceSha,
        },
      }),
    ).toBe(approvalSha);
    expect(() =>
      assertCleanProductionApprovalSource({
        repositoryRoot,
        approvalSha,
        buildSourceSha: sourceSha,
        env: {
          FRONTMIND_APPROVED_RELEASE_SHA: approvalSha,
          GITHUB_SHA: sourceSha,
        },
      }),
    ).toThrow("BUILD_APPROVAL_ENV_SHA_MISMATCH");
    expect(() =>
      assertCleanProductionApprovalSource({
        repositoryRoot,
        approvalSha,
        buildSourceSha: sourceSha,
        env: {
          FRONTMIND_APPROVED_RELEASE_SHA: approvalSha,
          GITHUB_SHA: approvalSha,
          FRONTMIND_BUILD_SHA: approvalSha,
        },
      }),
    ).toThrow("BUILD_SOURCE_COMMIT_MISMATCH");
    expect(() =>
      assertCleanProductionApprovalSource({
        repositoryRoot,
        approvalSha,
        buildSourceSha: sourceSha,
        env: { FRONTMIND_APPROVED_RELEASE_SHA: sourceSha },
      }),
    ).toThrow("BUILD_APPROVAL_ENV_SHA_MISMATCH");
    expect(() =>
      assertCleanProductionApprovalSource({
        repositoryRoot,
        approvalSha,
        buildSourceSha: sourceSha,
        env: {},
      }),
    ).toThrow("BUILD_APPROVAL_ENV_SHA_REQUIRED");
  });

  it("requires the independent runtime root and a distinct F", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const distRoot = await populateReleaseArtifact(repositoryRoot);
    await writeBuildArtifactIdentity(distRoot, sourceSha);
    const manifest = await writeBuildArtifactManifest(distRoot, sourceSha);
    const approvalSha = "f".repeat(40);

    await expect(
      verifyRuntimeReleaseArtifact(distRoot, {
        buildSourceSha: sourceSha,
        approvalSha,
        env: {},
      }),
    ).rejects.toThrow("FRONTMIND_EXPECTED_ARTIFACT_ROOT_SHA256_REQUIRED");
    await expect(
      verifyRuntimeReleaseArtifact(distRoot, {
        buildSourceSha: sourceSha,
        approvalSha: sourceSha,
        expectedRootSha256: manifest.rootSha256,
      }),
    ).rejects.toThrow("FRONTMIND_APPROVED_RELEASE_SHA_MUST_DIFFER_FROM_SOURCE");
    await expect(
      verifyRuntimeReleaseArtifact(distRoot, {
        buildSourceSha: sourceSha,
        approvalSha,
        expectedRootSha256: "e".repeat(64),
      }),
    ).rejects.toThrow("FRONTMIND_ARTIFACT_EXTERNAL_ROOT_MISMATCH");
    await expect(
      verifyRuntimeReleaseArtifact(distRoot, {
        buildSourceSha: sourceSha,
        approvalSha,
        expectedRootSha256: manifest.rootSha256,
      }),
    ).resolves.toMatchObject({
      approvalSha,
      buildSourceSha: sourceSha,
      expectedRootSha256: manifest.rootSha256,
      actualRootSha256: manifest.rootSha256,
    });
  });

  it("coalesces concurrent health verification and caches success for a bounded TTL", async () => {
    let now = 1_000;
    let calls = 0;
    let releaseFirst: ((value: unknown) => void) | undefined;
    const firstResult = {
      approvalSha: "f".repeat(40),
      buildSourceSha: "e".repeat(40),
      expectedRootSha256: "d".repeat(64),
      actualRootSha256: "d".repeat(64),
      manifest: { schemaVersion: 1, files: [] },
    };
    const verifier = createRuntimeReleaseArtifactVerifier("dist", {
      ttlMs: 5_000,
      clock: () => now,
      verifyArtifact: async () => {
        calls += 1;
        if (calls === 1) {
          return await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        return firstResult;
      },
    });

    const concurrent = Array.from({ length: 20 }, () => verifier());
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst?.(firstResult);
    expect(await Promise.all(concurrent)).toEqual(
      Array.from({ length: 20 }, () => firstResult),
    );
    expect(calls).toBe(1);

    now += 4_999;
    await expect(verifier()).resolves.toBe(firstResult);
    expect(calls).toBe(1);
    now += 1;
    await expect(verifier()).resolves.toBe(firstResult);
    expect(calls).toBe(2);
  });

  it("detects changed dist bytes on the first health verification after TTL", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const distRoot = await populateReleaseArtifact(repositoryRoot);
    await writeBuildArtifactIdentity(distRoot, sourceSha);
    const manifest = await writeBuildArtifactManifest(distRoot, sourceSha);
    let now = 10_000;
    const verifier = createRuntimeReleaseArtifactVerifier(distRoot, {
      buildSourceSha: sourceSha,
      approvalSha: "f".repeat(40),
      expectedRootSha256: manifest.rootSha256,
      ttlMs: 5_000,
      clock: () => now,
    });

    await expect(verifier({ force: true })).resolves.toMatchObject({
      actualRootSha256: manifest.rootSha256,
    });
    await writeFile(
      path.join(distRoot, "index.js"),
      "tampered after startup\n",
    );
    now += 4_999;
    await expect(verifier()).resolves.toMatchObject({
      actualRootSha256: manifest.rootSha256,
    });
    now += 1;
    await expect(verifier()).rejects.toThrow("BUILD_ARTIFACT_BYTES_MISMATCH");
  });
});
