import type { BuildArtifactManifest } from "./build-artifact-identity.mjs";

export interface RuntimeReleaseArtifactIdentity {
  approvalSha: string;
  buildSourceSha: string;
  expectedRootSha256: string;
  actualRootSha256: string;
  manifest: BuildArtifactManifest;
}

export function verifyRuntimeReleaseArtifact(
  buildRoot: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    buildSourceSha?: string | null;
    approvalSha?: string;
    expectedRootSha256?: string;
  },
): Promise<RuntimeReleaseArtifactIdentity>;

export function createRuntimeReleaseArtifactVerifier(
  buildRoot: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    buildSourceSha?: string | null;
    approvalSha?: string;
    expectedRootSha256?: string;
    ttlMs?: number;
    clock?: () => number;
    verifyArtifact?: typeof verifyRuntimeReleaseArtifact;
  },
): (request?: { force?: boolean }) => Promise<RuntimeReleaseArtifactIdentity>;
