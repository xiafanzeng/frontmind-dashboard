import { afterEach, describe, expect, it } from "vitest";

import {
  bindDownloadUrlToProject,
  createSignedDownloadToken,
  resolveDownloadProjectContext,
  resolveDownloadTokenSecret,
  verifySignedDownloadToken,
} from "./signed-download-token";

const originalEnvironment = {
  nodeEnv: process.env.NODE_ENV,
  dedicatedSecret: process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET,
  jwtSecret: process.env.JWT_SECRET,
};

afterEach(() => {
  if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment.nodeEnv;
  if (originalEnvironment.dedicatedSecret === undefined) {
    delete process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET;
  } else {
    process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET =
      originalEnvironment.dedicatedSecret;
  }
  if (originalEnvironment.jwtSecret === undefined)
    delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalEnvironment.jwtSecret;
});

describe("signed cross-instance download tokens", () => {
  it("verifies on another instance and preserves the exact project binding", () => {
    const secret = "shared-download-secret-that-is-long-enough-123456";
    const token = createSignedDownloadToken(
      {
        kind: "owned_file",
        userId: 42,
        fileId: "folder/中文 # file.pdf",
        credentialId: "credential-v3",
        projectAssignmentId: "project-assignment-a",
        exp: 20_000,
      },
      { secret },
    );

    expect(
      verifySignedDownloadToken(token, "owned_file", {
        // A separate process uses only the shared secret and token bytes.
        secret,
        now: 10_000,
      }),
    ).toMatchObject({
      userId: 42,
      fileId: "folder/中文 # file.pdf",
      credentialId: "credential-v3",
      projectAssignmentId: "project-assignment-a",
    });
  });

  it("requires all current-project signals to match and binds native URLs", () => {
    const bound = bindDownloadUrlToProject(
      "/api/frontmind/download/signed-token",
      "project 中文/#a",
    );
    expect(bound).toBe(
      "/api/frontmind/download/signed-token?projectAssignmentId=project%20%E4%B8%AD%E6%96%87%2F%23a",
    );
    expect(
      resolveDownloadProjectContext({
        query: "project-a",
        header: "project-a",
      }),
    ).toBe("project-a");
    expect(() =>
      resolveDownloadProjectContext({
        middleware: "project-a",
        query: "project-b",
      }),
    ).toThrowError(expect.objectContaining({ code: "DOWNLOAD_TOKEN_INVALID" }));
    expect(() =>
      resolveDownloadProjectContext({ query: ["project-a", "project-b"] }),
    ).toThrowError(expect.objectContaining({ code: "DOWNLOAD_TOKEN_INVALID" }));
  });

  it("fails closed at production startup without a strong shared secret", () => {
    process.env.NODE_ENV = "production";
    delete process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET;
    delete process.env.JWT_SECRET;
    expect(() => resolveDownloadTokenSecret()).toThrowError(
      expect.objectContaining({ code: "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE" }),
    );

    process.env.FRONTMIND_DOWNLOAD_TOKEN_SECRET = "too-short";
    expect(() => resolveDownloadTokenSecret()).toThrowError(
      expect.objectContaining({ code: "DOWNLOAD_TOKEN_SECRET_UNAVAILABLE" }),
    );
  });
});
