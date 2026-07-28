import { describe, expect, it } from "vitest";

import {
  isPrivateUpstreamCollectionRequest,
  publicUpstreamPayload,
} from "./manus-proxy";

describe("isPrivateUpstreamCollectionRequest", () => {
  it.each([
    ["GET", "/v1/tasks"],
    ["HEAD", "/v1/tasks"],
    ["GET", "/v1/responses"],
    ["HEAD", "/v1/responses/"],
    ["GET", "/v1/files?limit=20"],
    ["HEAD", "/v1/files?after=file-1"],
  ])("blocks %s access to private collection %s", (method, targetPath) => {
    expect(isPrivateUpstreamCollectionRequest(method, targetPath)).toBe(true);
  });

  it.each([
    ["GET", "/v1/tasks/task-1"],
    ["HEAD", "/v1/responses/response-1"],
    ["GET", "/v1/files/file-1"],
    ["GET", "/v1/files/file-1/content"],
    ["POST", "/v1/tasks"],
    ["POST", "/v1/responses"],
    ["POST", "/v1/files"],
  ])("allows %s access to scoped endpoint %s", (method, targetPath) => {
    expect(isPrivateUpstreamCollectionRequest(method, targetPath)).toBe(false);
  });
});

describe("publicUpstreamPayload", () => {
  it("strips nested auth fields and exact current credentials", () => {
    const credential = "sentinel-proxy-credential-do-not-expose";
    const result = publicUpstreamPayload(
      {
        id: "task-safe",
        API_KEY: credential,
        output: [
          {
            type: "message",
            content: `safe prefix ${credential} suffix`,
            nested: {
              Authorization: `Bearer ${credential}`,
              Cookie: `session=${credential}`,
              accessToken: "another-token",
            },
          },
        ],
      },
      credential,
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      id: "task-safe",
      output: [
        {
          type: "message",
          content: "safe prefix [REDACTED] suffix",
          nested: {},
        },
      ],
    });
    expect(serialized).not.toContain(credential);
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("cookie");
    expect(serialized.toLowerCase()).not.toContain("token");
    expect(serialized.toLowerCase()).not.toContain("api_key");
  });
});
