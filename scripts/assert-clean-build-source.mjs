import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function changedSourcePaths(repositoryRoot) {
  const sourcePathspec = ["--", ".", ":(exclude)dist", ":(exclude)dist/**"];
  const groups = [
    git(repositoryRoot, ["diff", "--name-only", ...sourcePathspec]),
    git(repositoryRoot, ["diff", "--cached", "--name-only", ...sourcePathspec]),
    git(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      ...sourcePathspec,
    ]),
  ];
  return Array.from(
    new Set(groups.flatMap((value) => value.split("\n")).filter(Boolean)),
  ).sort();
}

export function changedArtifactPaths(repositoryRoot) {
  const artifactPathspec = ["--", "dist"];
  const groups = [
    git(repositoryRoot, ["diff", "--name-only", ...artifactPathspec]),
    git(repositoryRoot, [
      "diff",
      "--cached",
      "--name-only",
      ...artifactPathspec,
    ]),
    git(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      ...artifactPathspec,
    ]),
  ];
  return Array.from(
    new Set(groups.flatMap((value) => value.split("\n")).filter(Boolean)),
  ).sort();
}

export function changedWorktreePaths(repositoryRoot) {
  return Array.from(
    new Set([
      ...changedSourcePaths(repositoryRoot),
      ...changedArtifactPaths(repositoryRoot),
    ]),
  ).sort();
}

function normalizedFullSha(value, errorCode) {
  const sha = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error(errorCode);
  return sha;
}

/**
 * The public production-build entrance is intentionally stricter than its
 * internal stages. It must see a completely clean Git worktree, including
 * tracked, staged and untracked dist paths, before it is allowed to recreate
 * the exact repository dist directory.
 */
export function assertCleanProductionReleaseWorktree(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot || path.resolve(import.meta.dirname, ".."),
  );
  const sha = assertCleanProductionBuildSource({
    ...options,
    repositoryRoot,
  });
  const dirtyPaths = changedWorktreePaths(repositoryRoot);
  if (dirtyPaths.length > 0) {
    throw new Error(
      `BUILD_RELEASE_WORKTREE_NOT_CLEAN:${dirtyPaths.slice(0, 20).join(",")}`,
    );
  }
  return sha;
}

/**
 * Approval runs execute at the dist-only approval commit F. Platform checkout
 * variables must identify F, while explicit artifact source variables keep
 * identifying the source commit S embedded in dist.
 */
export function assertCleanProductionApprovalSource(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot || path.resolve(import.meta.dirname, ".."),
  );
  const approvalSha = normalizedFullSha(
    options.approvalSha || git(repositoryRoot, ["rev-parse", "HEAD"]),
    "BUILD_APPROVAL_SHA_INVALID",
  );
  const buildSourceSha = normalizedFullSha(
    options.buildSourceSha,
    "BUILD_ARTIFACT_SOURCE_SHA_INVALID",
  );
  const repositorySha = normalizedFullSha(
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    "BUILD_APPROVAL_SHA_INVALID",
  );
  if (repositorySha !== approvalSha) {
    throw new Error("BUILD_APPROVAL_COMMIT_MISMATCH");
  }

  const env = options.env || {};
  if (!env.FRONTMIND_APPROVED_RELEASE_SHA) {
    throw new Error("BUILD_APPROVAL_ENV_SHA_REQUIRED");
  }
  if (
    normalizedFullSha(
      env.FRONTMIND_APPROVED_RELEASE_SHA,
      "BUILD_APPROVAL_ENV_SHA_INVALID",
    ) !== approvalSha
  ) {
    throw new Error("BUILD_APPROVAL_ENV_SHA_MISMATCH");
  }
  for (const value of [
    env.GITHUB_SHA,
    env.COMMIT_SHA,
    env.RENDER_GIT_COMMIT,
    env.RAILWAY_GIT_COMMIT_SHA,
  ].filter(Boolean)) {
    if (
      normalizedFullSha(value, "BUILD_APPROVAL_ENV_SHA_INVALID") !== approvalSha
    ) {
      throw new Error("BUILD_APPROVAL_ENV_SHA_MISMATCH");
    }
  }
  for (const value of [env.FRONTMIND_BUILD_SHA, env.BUILD_SHA].filter(
    Boolean,
  )) {
    if (
      normalizedFullSha(value, "BUILD_SOURCE_ENV_SHA_INVALID") !==
      buildSourceSha
    ) {
      throw new Error("BUILD_SOURCE_COMMIT_MISMATCH");
    }
  }

  const dirtySourcePaths = changedSourcePaths(repositoryRoot);
  if (dirtySourcePaths.length > 0) {
    throw new Error(
      `BUILD_SOURCE_NOT_COMMITTED:${dirtySourcePaths.slice(0, 20).join(",")}`,
    );
  }
  const dirtyArtifactPaths = changedArtifactPaths(repositoryRoot);
  if (dirtyArtifactPaths.length > 0) {
    throw new Error(
      `BUILD_APPROVAL_ARTIFACT_NOT_COMMITTED:${dirtyArtifactPaths
        .slice(0, 20)
        .join(",")}`,
    );
  }
  return approvalSha;
}

/**
 * Production artifacts must describe an immutable source commit. `dist/` is
 * deliberately allowed to differ because it is generated in the second
 * release commit; every source, migration, test and Skill file must already be
 * committed before Vite reads `git rev-parse HEAD` for version.json.
 */
export function assertCleanProductionBuildSource(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot || path.resolve(import.meta.dirname, ".."),
  );
  const repositorySha = normalizedFullSha(
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    "BUILD_SOURCE_COMMIT_INVALID",
  );
  const expectedBuildSha = normalizedFullSha(
    options.expectedBuildSha || repositorySha,
    "BUILD_SOURCE_EXPECTED_SHA_INVALID",
  );
  if (repositorySha !== expectedBuildSha) {
    throw new Error("BUILD_SOURCE_COMMIT_MISMATCH");
  }
  const env = options.env || {};
  const requestedShas = [
    env.FRONTMIND_BUILD_SHA,
    env.BUILD_SHA,
    env.COMMIT_SHA,
    env.RENDER_GIT_COMMIT,
    env.RAILWAY_GIT_COMMIT_SHA,
    env.GITHUB_SHA,
  ]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  for (const requestedSha of requestedShas) {
    if (!/^[a-f0-9]{40}$/u.test(requestedSha)) {
      throw new Error("BUILD_SOURCE_ENV_SHA_INVALID");
    }
    if (requestedSha !== expectedBuildSha) {
      throw new Error("BUILD_SOURCE_COMMIT_MISMATCH");
    }
  }
  const dirtyPaths = changedSourcePaths(repositoryRoot);
  if (dirtyPaths.length > 0) {
    throw new Error(
      `BUILD_SOURCE_NOT_COMMITTED:${dirtyPaths.slice(0, 20).join(",")}`,
    );
  }
  return repositorySha;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const sha = assertCleanProductionBuildSource({ env: process.env });
    console.log(`BUILD_SOURCE_COMMITTED=${sha}`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "BUILD_SOURCE_CHECK_FAILED",
    );
    process.exitCode = 1;
  }
}
