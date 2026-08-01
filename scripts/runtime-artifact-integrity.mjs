import path from "node:path";
import { verifyBuildArtifactManifest } from "./build-artifact-identity.mjs";

function requiredSha256(value, errorCode) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(errorCode);
  return normalized;
}

function requiredGitSha(value, errorCode) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(errorCode);
  return normalized;
}

/**
 * Verify every dist byte against the co-located manifest and against an
 * independently injected artifact root. The external root prevents a replaced
 * bundle and a replaced manifest from blessing one another.
 */
export async function verifyRuntimeReleaseArtifact(buildRoot, options = {}) {
  const env = options.env || process.env;
  const buildSourceSha = requiredGitSha(
    options.buildSourceSha,
    "FRONTMIND_RUNTIME_BUILD_SOURCE_SHA_INVALID",
  );
  const approvalSha = requiredGitSha(
    options.approvalSha || env.FRONTMIND_APPROVED_RELEASE_SHA,
    "FRONTMIND_APPROVED_RELEASE_SHA_REQUIRED",
  );
  if (approvalSha === buildSourceSha) {
    throw new Error("FRONTMIND_APPROVED_RELEASE_SHA_MUST_DIFFER_FROM_SOURCE");
  }
  const expectedRootSha256 = requiredSha256(
    options.expectedRootSha256 || env.FRONTMIND_EXPECTED_ARTIFACT_ROOT_SHA256,
    "FRONTMIND_EXPECTED_ARTIFACT_ROOT_SHA256_REQUIRED",
  );
  const manifest = await verifyBuildArtifactManifest(path.resolve(buildRoot), {
    expectedBuildSourceSha: buildSourceSha,
  });
  if (manifest.rootSha256 !== expectedRootSha256) {
    throw new Error("FRONTMIND_ARTIFACT_EXTERNAL_ROOT_MISMATCH");
  }
  return {
    approvalSha,
    buildSourceSha,
    expectedRootSha256,
    actualRootSha256: manifest.rootSha256,
    manifest,
  };
}

/**
 * Production health checks share one full-artifact verifier. Startup uses a
 * forced pass; subsequent health/readiness calls coalesce concurrent work and
 * reuse either success or failure for a short bounded TTL. This keeps the
 * tamper-detection window bounded without allowing public health traffic to
 * turn recursive hashing of dist into an I/O amplification vector.
 */
export function createRuntimeReleaseArtifactVerifier(buildRoot, options = {}) {
  const resolvedBuildRoot = path.resolve(buildRoot);
  const ttlMs = Number(options.ttlMs ?? 5_000);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 60_000) {
    throw new Error("FRONTMIND_ARTIFACT_VERIFY_TTL_INVALID");
  }
  const clock = options.clock || Date.now;
  const verifyArtifact = options.verifyArtifact || verifyRuntimeReleaseArtifact;
  const verificationOptions = {
    env: options.env,
    buildSourceSha: options.buildSourceSha,
    approvalSha: options.approvalSha,
    expectedRootSha256: options.expectedRootSha256,
  };
  let cached;
  let inFlight;

  return async function verifyCurrentReleaseArtifact(request = {}) {
    const now = clock();
    if (
      !request.force &&
      cached &&
      Number.isFinite(now) &&
      now >= cached.checkedAtMs &&
      now - cached.checkedAtMs < ttlMs
    ) {
      if (!cached.ok) throw cached.error;
      return cached.result;
    }
    if (inFlight) return inFlight;

    inFlight = Promise.resolve()
      .then(() => verifyArtifact(resolvedBuildRoot, verificationOptions))
      .then(
        (result) => {
          cached = {
            checkedAtMs: clock(),
            ok: true,
            result,
          };
          return result;
        },
        (error) => {
          cached = {
            checkedAtMs: clock(),
            ok: false,
            error,
          };
          throw error;
        },
      )
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
