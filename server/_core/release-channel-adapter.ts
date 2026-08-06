import {
  releasePresentation,
  validateReleaseChannelRuntimeEnvironment,
} from "../../scripts/release-channel.mjs";

declare const __FRONTMIND_RELEASE_CHANNEL__: string | undefined;

type RuntimeIdentity = {
  buildSourceSha: string;
  releaseChannel: string;
};

type HeaderWriter = {
  setHeader(name: string, value: string): unknown;
};

const compiledReleaseChannel =
  typeof __FRONTMIND_RELEASE_CHANNEL__ === "string"
    ? __FRONTMIND_RELEASE_CHANNEL__.trim().toLowerCase()
    : "";

export const applicationReleaseChannel = compiledReleaseChannel;

export function assertReleaseChannelIdentity(
  runtimeIdentity: RuntimeIdentity,
  applicationBuildSha: string | null,
  releaseChannel = compiledReleaseChannel,
) {
  if (runtimeIdentity.buildSourceSha !== applicationBuildSha) {
    throw new Error("FRONTMIND_RUNTIME_BUILD_SOURCE_SHA_MISMATCH");
  }
  if (
    !releaseChannel ||
    runtimeIdentity.releaseChannel !== releaseChannel ||
    releaseChannel !== releasePresentation.releaseChannel
  ) {
    throw new Error("FRONTMIND_RUNTIME_RELEASE_CHANNEL_MISMATCH");
  }
}

export function validateReleaseRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
  applicationBuildSha: string | null,
) {
  const runtimeIdentity = validateReleaseChannelRuntimeEnvironment(env);
  assertReleaseChannelIdentity(runtimeIdentity, applicationBuildSha);
  return runtimeIdentity;
}

export function applyReleaseChannelHeaders(response: HeaderWriter) {
  if (releasePresentation.preventIndexing) {
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
}
