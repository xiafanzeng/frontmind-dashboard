import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import axios from "axios";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import manusProxy, {
  MAX_EXTERNAL_DOWNLOAD_BYTES,
  isPrivateUpstreamCollectionRequest,
  isPublicFilePayloadRequest,
  isPublicTaskPayloadRequest,
  publicUpstreamFilePayload,
  publicUpstreamPayload,
  publicUpstreamTaskPayload,
  readBoundedExternalDownload,
} from "./manus-proxy";

async function withManusProxyServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use("/api/frontmind", manusProxy);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/frontmind`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("preserves every SigV4 query parameter only for a scoped file payload", () => {
    const signedUrl =
      "https://uploads.example.test/object.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260730%2Fcn-north-1%2Fs3%2Faws4_request&X-Amz-Date=20260730T010203Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=abcdef0123456789";
    const result = publicUpstreamFilePayload(
      {
        id: "file-safe",
        filename: "Logo.png",
        upload_url: signedUrl,
        Authorization: "Bearer must-not-leak",
      },
      "current-api-key",
    ) as Record<string, unknown>;

    expect(result.upload_url).toBe(signedUrl);
    expect(result).not.toHaveProperty("Authorization");
    expect(isPublicFilePayloadRequest("POST", "/v1/files")).toBe(true);
    expect(
      isPublicFilePayloadRequest("GET", "/v1/files/file-safe"),
    ).toBe(true);
    expect(isPublicFilePayloadRequest("GET", "/v1/files")).toBe(false);
  });
});

describe("proxy upload", () => {
  it("forwards the complete signed URL and never exposes upstream XML errors", async () => {
    const signedUrl =
      "https://uploads.example.test/object.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260730%2Fcn-north-1%2Fs3%2Faws4_request&X-Amz-Signature=abcdef0123456789";
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 400,
      data: '<?xml version="1.0"?><Error><Code>AuthorizationQueryParametersError</Code></Error>',
    });

    await withManusProxyServer(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/proxy-upload?target=${encodeURIComponent(signedUrl)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Original-Content-Type": "image/png",
          },
          body: new Uint8Array([1, 2, 3]),
        },
      );
      const responseText = await response.text();

      expect(response.status).toBe(400);
      expect(responseText).toContain("上传地址无效或已失效");
      expect(responseText).not.toContain(
        "AuthorizationQueryParametersError",
      );
    });

    expect(put).toHaveBeenCalledWith(
      signedUrl,
      expect.anything(),
      expect.objectContaining({
        maxRedirects: 0,
        headers: expect.objectContaining({ "Content-Type": "image/png" }),
      }),
    );
  });
});

describe("public task payload boundary", () => {
  it.each([
    ["GET", "/v1/tasks/task-1"],
    ["HEAD", "/v1/tasks/task-1?include=output"],
    ["GET", "/v1/responses/response-1/"],
    ["POST", "/v1/tasks"],
    ["POST", "/v1/responses/"],
  ])("recognizes %s %s as a task response", (method, targetPath) => {
    expect(isPublicTaskPayloadRequest(method, targetPath)).toBe(true);
  });

  it.each([
    ["GET", "/v1/files/file-1"],
    ["POST", "/v1/files"],
    ["DELETE", "/v1/tasks/task-1"],
    ["GET", "/v1/tasks/task-1/content"],
  ])("does not apply task shaping to %s %s", (method, targetPath) => {
    expect(isPublicTaskPayloadRequest(method, targetPath)).toBe(false);
  });

  it("allows result fields but removes echoed private request context at every nesting level", () => {
    const credential = "sentinel-task-credential-do-not-expose";
    const privateSentinel = "PRIVATE-SKILL-KNOWLEDGE-SENTINEL";
    const result = publicUpstreamTaskPayload(
      {
        id: "task-safe",
        task_id: "task-safe",
        status: "running",
        model: "FrontMind-Pro",
        prompt: privateSentinel,
        input: { text: privateSentinel },
        system: privateSentinel,
        instructions: { private: privateSentinel },
        knowledge_base: { content: privateSentinel },
        metadata: {
          credit_usage: "12",
          task_url: "https://example.test/task-safe",
          prompt: privateSentinel,
          nested: { instructions: privateSentinel },
          privateKnowledge: privateSentinel,
        },
        output: [
          {
            id: "message-safe",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "public answer" }],
            prompt: privateSentinel,
            input: privateSentinel,
            system: privateSentinel,
            instructions: privateSentinel,
            knowledge: privateSentinel,
          },
          {
            id: "reasoning-safe",
            type: "reasoning",
            summary: [
              {
                type: "summary_text",
                text: "public progress",
                instructions: privateSentinel,
              },
            ],
          },
          {
            id: "call-safe",
            type: "function_call",
            name: "public_tool",
            arguments: JSON.stringify({ prompt: privateSentinel }),
            input: privateSentinel,
            action: {
              type: "navigate",
              url: "https://example.test/",
              instructions: privateSentinel,
            },
          },
          {
            id: "input-secret",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: privateSentinel }],
          },
          {
            id: "system-secret",
            type: "instructions",
            content: [{ type: "output_text", text: privateSentinel }],
          },
        ],
        usage: {
          input_tokens: 123,
          output_tokens: 45,
          prompt: privateSentinel,
        },
        progress: {
          stage: "collecting",
          visited_links: 7,
          instructions: privateSentinel,
        },
        API_KEY: credential,
      },
      credential,
    );
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      id: "task-safe",
      task_id: "task-safe",
      status: "running",
      model: "FrontMind-Pro",
      metadata: {
        credit_usage: "12",
        task_url: "https://example.test/task-safe",
      },
      output: [
        {
          id: "message-safe",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "public answer" }],
        },
        {
          id: "reasoning-safe",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "public progress" }],
        },
        {
          id: "call-safe",
          type: "function_call",
          name: "public_tool",
          action: {
            type: "navigate",
            url: "https://example.test/",
          },
        },
      ],
      usage: {
        input_tokens: 123,
        output_tokens: 45,
      },
      progress: {
        stage: "collecting",
        visited_links: 7,
      },
    });
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain('"input"');
    expect(serialized).not.toContain('"system"');
    expect(serialized).not.toContain('"instructions"');
    expect(serialized).not.toContain('"knowledge_base"');
  });

  it("preserves top-level assistant text without exposing request-shaped output", () => {
    const credential = "sentinel-task-credential-do-not-expose";
    const privateSentinel = "PRIVATE-REQUEST-CONTEXT-SENTINEL";
    const result = publicUpstreamTaskPayload(
      {
        id: "task-safe",
        status: "completed",
        output: [
          ...["message", "output_message", "output_text", "text"].map(
            (type, index) => ({
              id: `assistant-${index}`,
              type,
              role: "assistant",
              output_text: `public output_text ${index}`,
              content: `public content ${index}`,
              prompt: privateSentinel,
              input: privateSentinel,
              system: privateSentinel,
              instructions: privateSentinel,
            }),
          ),
          {
            id: "user-secret",
            type: "message",
            role: "user",
            output_text: privateSentinel,
            content: privateSentinel,
          },
          {
            id: "system-secret",
            type: "output_message",
            role: "system",
            output_text: privateSentinel,
            content: privateSentinel,
          },
          {
            id: "instruction-secret",
            type: "instructions",
            role: "assistant",
            output_text: privateSentinel,
            content: privateSentinel,
          },
          {
            id: "reasoning-safe",
            type: "reasoning",
            role: "assistant",
            output_text: privateSentinel,
            content: privateSentinel,
            summary: [{ type: "summary_text", text: "public progress" }],
          },
          {
            id: "assistant-value-shape",
            type: "output_text",
            role: "assistant",
            output_text: { value: "public value-shaped output_text" },
          },
          {
            id: "assistant-untyped-string-content",
            role: "assistant",
            content: "public untyped assistant content",
          },
          {
            id: "assistant-nested-value-shape",
            type: "output_message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                output_text: { value: "public nested value-shaped text" },
              },
            ],
          },
        ],
        prompt: privateSentinel,
        input: privateSentinel,
        system: privateSentinel,
        instructions: privateSentinel,
        API_KEY: credential,
      },
      credential,
    );

    expect(result).toEqual({
      id: "task-safe",
      status: "completed",
      output: [
        ...["message", "output_message", "output_text", "text"].map(
          (type, index) => ({
            id: `assistant-${index}`,
            type,
            role: "assistant",
            output_text: `public output_text ${index}`,
            content: `public content ${index}`,
          }),
        ),
        {
          id: "reasoning-safe",
          type: "reasoning",
          role: "assistant",
          summary: [{ type: "summary_text", text: "public progress" }],
        },
        {
          id: "assistant-value-shape",
          type: "output_text",
          role: "assistant",
          output_text: { value: "public value-shaped output_text" },
        },
        {
          id: "assistant-untyped-string-content",
          role: "assistant",
          content: "public untyped assistant content",
        },
        {
          id: "assistant-nested-value-shape",
          type: "output_message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "public nested value-shaped text",
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain('"input"');
    expect(serialized).not.toContain('"system"');
    expect(serialized).not.toContain('"instructions"');
    expect(serialized).not.toContain("user-secret");
    expect(serialized).not.toContain("system-secret");
    expect(serialized).not.toContain("instruction-secret");
  });
});

describe("external download size boundary", () => {
  it("rejects an oversized declared Content-Length with 413 before reading", async () => {
    const credentialSentinel = "SIGNED-CREDENTIAL-MUST-NOT-LEAK";
    const source = Readable.from([Buffer.from("must not be consumed")]);
    const destroySpy = vi.spyOn(source, "destroy");
    vi.spyOn(axios, "get").mockResolvedValueOnce({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(MAX_EXTERNAL_DOWNLOAD_BYTES + 1),
      },
      data: source,
    } as any);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await withManusProxyServer(async (baseUrl) => {
      const target = `https://files.example.test/archive.bin?signature=${credentialSentinel}`;
      const response = await fetch(
        `${baseUrl}/proxy-download?url=${encodeURIComponent(target)}`,
      );
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body).toEqual({
        error: {
          message: "文件超过允许的下载大小",
          code: "EXTERNAL_DOWNLOAD_TOO_LARGE",
        },
      });
      expect(JSON.stringify(body)).not.toContain(credentialSentinel);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(
        credentialSentinel,
      );
      expect(destroySpy).toHaveBeenCalled();
    });
  });

  it("rejects a chunked response that crosses the actual byte cap with 413", async () => {
    const credentialSentinel = "CHUNKED-CREDENTIAL-MUST-NOT-LEAK";
    const chunk = Buffer.alloc(1024 * 1024);
    async function* chunks() {
      const count = Math.floor(MAX_EXTERNAL_DOWNLOAD_BYTES / chunk.length) + 1;
      for (let index = 0; index < count; index += 1) {
        yield chunk;
      }
    }
    const source = Readable.from(chunks());
    vi.spyOn(axios, "get").mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      data: source,
    } as any);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await withManusProxyServer(async (baseUrl) => {
      const target = `https://files.example.test/chunked.bin?signature=${credentialSentinel}`;
      const response = await fetch(
        `${baseUrl}/proxy-download?url=${encodeURIComponent(target)}`,
      );
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.error?.code).toBe("EXTERNAL_DOWNLOAD_TOO_LARGE");
      expect(JSON.stringify(body)).not.toContain(credentialSentinel);
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(
        credentialSentinel,
      );
    });
  });

  it("accepts a chunked response exactly at a smaller test cap", async () => {
    await expect(
      readBoundedExternalDownload(
        Readable.from([Buffer.from("1234"), Buffer.from("5678")]),
        {},
        8,
      ),
    ).resolves.toEqual(Buffer.from("12345678"));
  });
});
