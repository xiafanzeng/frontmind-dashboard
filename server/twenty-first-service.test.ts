import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthServiceError } from "./auth-service";
import { encryptPresalesApiKey } from "./presales-service";
import {
  TwentyFirstClient,
  TwentyFirstToolContractError,
  TWENTY_FIRST_ACTIVE_OPERATION_STATUSES,
  assertTwentyFirstJsonDepth,
  buildTwentyFirstToolArguments,
  deleteTwentyFirstApiCredential,
  finalizePendingTwentyFirstCredentialRevocations,
  decryptTwentyFirstApiKey,
  encryptTwentyFirstApiKey,
  hasActiveTwentyFirstConsumers,
  projectTwentyFirstToolPayload,
  validateTwentyFirstApiKeyInput,
} from "./twenty-first-service";

const originalMasterKey = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;

describe("21st credential encryption", () => {
  beforeEach(() => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      randomBytes(32).toString("base64");
  });

  afterEach(() => {
    if (originalMasterKey === undefined) {
      delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY = originalMasterKey;
    }
  });

  it("round-trips without persisting plaintext and binds AAD to the 21st slot", () => {
    const id = randomUUID();
    const apiKey = "21st_sk_secret-that-must-stay-server-side";
    const encrypted = encryptTwentyFirstApiKey(id, apiKey);

    expect(Object.values(encrypted).join(" ")).not.toContain(apiKey);
    expect(decryptTwentyFirstApiKey({ id, ...encrypted })).toBe(apiKey);
    expect(() =>
      decryptTwentyFirstApiKey({ id: randomUUID(), ...encrypted }),
    ).toThrowError(AuthServiceError);
  });

  it("keeps Website and 21st ciphertext in different AAD domains", () => {
    const id = randomUUID();
    const apiKey = "shared-looking-secret-value";
    const website = encryptPresalesApiKey(id, apiKey);
    const twentyFirst = encryptTwentyFirstApiKey(id, apiKey);

    expect(website.encryptedKey).not.toBe(twentyFirst.encryptedKey);
    expect(() => decryptTwentyFirstApiKey({ id, ...website })).toThrowError(
      AuthServiceError,
    );
  });

  it("rejects empty and control-character values before any network request", () => {
    expect(() => validateTwentyFirstApiKeyInput("short")).toThrowError(
      AuthServiceError,
    );
    expect(() =>
      validateTwentyFirstApiKeyInput("21st_sk_valid\u0000suffix"),
    ).toThrowError(AuthServiceError);
    expect(validateTwentyFirstApiKeyInput("  21st_sk_valid  ")).toBe(
      "21st_sk_valid",
    );
  });

  it("bounds provider JSON depth independently from the byte limit", () => {
    let value: unknown = "leaf";
    for (let index = 0; index < 34; index += 1) value = { child: value };
    expect(() => assertTwentyFirstJsonDepth(value)).toThrowError(
      AuthServiceError,
    );
    expect(() => assertTwentyFirstJsonDepth({ tools: [] })).not.toThrow();
  });

  it("does not classify the system-wide 21st slot as a shared user Manus Key", () => {
    const source = readFileSync(
      resolve(process.cwd(), "server/auth-service.ts"),
      "utf8",
    );
    const sharedKeyFunction = source.slice(
      source.indexOf("export async function isUpstreamApiKeyShared"),
      source.indexOf("export async function recordUpstreamResource"),
    );
    expect(sharedKeyFunction).toContain(
      'eq(presalesApiCredentials.slot, "website")',
    );
  });
});

function jsonRpcResponse(id: string | number, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createMcpFetch(tools: string[]) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id?: string | number;
      method: string;
    };
    if (body.method === "initialize") {
      return jsonRpcResponse(body.id!, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "21st-test", version: "1.0.0" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return jsonRpcResponse(body.id!, {
        tools: tools.map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      });
    }
    throw new Error(`unexpected MCP method: ${body.method}`);
  });
}

describe("TwentyFirstClient", () => {
  it("only initializes and lists tools with x-api-key, then projects capabilities", async () => {
    const fetchImpl = createMcpFetch(["search", "get_component", "get_usage"]);
    const result = await new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
    }).inspectCapabilities("21st_sk_test_secret");

    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://21st.dev/api/mcp",
      capabilities: {
        search: true,
        getComponent: true,
        getUsage: true,
        getTheme: false,
      },
      server: { name: "21st-test", version: "1.0.0" },
    });
    const methods = fetchImpl.mock.calls
      .filter(([, init]) => init?.body !== undefined)
      .map(([, init]) => JSON.parse(String(init?.body)).method);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(methods).not.toContain("tools/call");
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("x-api-key")).toBe(
        "21st_sk_test_secret",
      );
    }
  });

  it("bounds capability discovery to three pages and one hundred tools", async () => {
    const cursors: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method: string;
        params?: { cursor?: string };
      };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id!, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "21st-test", version: "1.0.0" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        cursors.push(body.params?.cursor);
        const page = cursors.length;
        const tools = Array.from({ length: 34 }, (_, index) => ({
          name:
            page === 3 && index === 0 ? "search" : `page_${page}_tool_${index}`,
          inputSchema: { type: "object", properties: {} },
        }));
        return jsonRpcResponse(body.id!, {
          tools,
          nextCursor: `cursor-${page}`,
        });
      }
      throw new Error(`unexpected MCP method: ${body.method}`);
    });

    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({ capabilities: { search: true } });
    expect(cursors).toEqual([undefined, "cursor-1", "cursor-2"]);
  });

  it("accepts a search-only catalog connection and projects optional tools honestly", async () => {
    const fetchImpl = createMcpFetch(["search"]);
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({
      ok: true,
      capabilities: {
        search: true,
        getComponent: false,
        getUsage: false,
        getTheme: false,
      },
    });
  });

  it("fails closed when the required search tool is missing", async () => {
    const fetchImpl = createMcpFetch(["get_component"]);
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
  });

  it("maps authentication failures without reflecting the secret", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("denied", { status: 401 }),
    );
    const error = await new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
    })
      .inspectCapabilities("21st_sk_do-not-reflect")
      .catch((value) => value);

    expect(error).toMatchObject({ code: "INVALID_CREDENTIAL" });
    expect(String(error.message)).not.toContain("21st_sk_do-not-reflect");
  });

  it("discovers live schemas and calls only search/get_component with their advertised keys", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method: string;
        params?: { name: string; arguments: Record<string, unknown> };
      };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id!, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "21st-test", version: "1.0.0" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        return jsonRpcResponse(body.id!, {
          tools: [
            {
              name: "search",
              inputSchema: {
                type: "object",
                properties: {
                  searchQuery: { type: "string" },
                  pageSize: { type: "integer", minimum: 1, maximum: 18 },
                  type: { type: "string", enum: ["component", "theme"] },
                },
                required: ["searchQuery"],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: "get_component",
              inputSchema: {
                type: "object",
                properties: { id: { type: "number" } },
                required: ["id"],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: "generate",
              inputSchema: {
                type: "object",
                properties: { prompt: { type: "string" } },
              },
            },
          ],
        });
      }
      if (body.method === "tools/call" && body.params) {
        calls.push(body.params);
        const payload =
          body.params.name === "search"
            ? { results: [{ id: 143 }] }
            : {
                id: 143,
                name: "Responsive editorial hero",
                description: "Light canvas and neutral sans",
                previewUrl: "https://cdn.example.test/143.png",
                componentCode: "RAW_PROVIDER_CODE",
              };
        return jsonRpcResponse(body.id!, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: false,
        });
      }
      throw new Error(`unexpected MCP method: ${body.method}`);
    });
    const client = new TwentyFirstClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1_000,
      totalTimeoutMs: 5_000,
    });
    const output = await client.withReadOnlySession(
      "21st_sk_test_secret",
      async (session) => ({
        search: await session.search({
          query: "B2B analytics landing page",
          type: "component",
          limit: 10,
        }),
        detail: await session.getComponent!(143),
      }),
    );

    expect(output).toEqual({
      search: { results: [{ id: 143 }] },
      detail: {
        id: 143,
        name: "Responsive editorial hero",
        description: "Light canvas and neutral sans",
        previewUrl: "https://cdn.example.test/143.png",
        componentCode: "RAW_PROVIDER_CODE",
      },
    });
    expect(calls).toEqual([
      {
        name: "search",
        arguments: {
          searchQuery: "B2B analytics landing page",
          pageSize: 10,
          type: "component",
        },
      },
      {
        name: "get_component",
        arguments: { id: 143 },
      },
    ]);
    expect(calls.map((call) => call.name)).not.toContain("generate");
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get("x-api-key")).toBe(
        "21st_sk_test_secret",
      );
    }
  });

  it("preserves provider ID primitives required by the advertised schema", () => {
    const numericTool = {
      name: "get_component",
      inputSchema: {
        type: "object" as const,
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    };
    expect(
      buildTwentyFirstToolArguments({
        operation: "get_component",
        tool: numericTool,
        value: 143,
      }),
    ).toEqual({ id: 143 });
    expect(() =>
      buildTwentyFirstToolArguments({
        operation: "get_component",
        tool: numericTool,
        value: "143",
      }),
    ).toThrow(TwentyFirstToolContractError);
  });

  it("derives required component type and bounded limit from the live search schema", () => {
    const tool = {
      name: "search",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string" },
          type: { type: "string" },
          limit: { type: "integer", minimum: 2, maximum: 5 },
        },
        required: ["query", "type", "limit"],
      },
    };
    expect(
      buildTwentyFirstToolArguments({
        operation: "search",
        tool,
        value: "企业官网 hero",
        limit: 10,
      }),
    ).toEqual({ query: "企业官网 hero", type: "component", limit: 5 });
    expect(() =>
      buildTwentyFirstToolArguments({
        operation: "search",
        tool: {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              ...tool.inputSchema.properties,
              type: { type: "string", enum: ["theme"] },
            },
          },
        },
        value: "hero",
        limit: 5,
      }),
    ).toThrow(TwentyFirstToolContractError);
  });

  it("prefers structured results and uses bounded JSON text only as fallback", () => {
    expect(
      projectTwentyFirstToolPayload({
        structuredContent: { results: [{ id: 1 }] },
        content: [
          { type: "text", text: JSON.stringify({ results: [{ id: 2 }] }) },
        ],
      }),
    ).toEqual({ results: [{ id: 1 }] });
    expect(
      projectTwentyFirstToolPayload({
        structuredContent: { status: "ok" },
        content: [
          { type: "text", text: JSON.stringify({ results: [{ id: 143 }] }) },
        ],
      }),
    ).toEqual({ results: [{ id: 143 }] });
    expect(
      projectTwentyFirstToolPayload({
        structuredContent: { status: "ok" },
        content: [
          {
            type: "text",
            text: JSON.stringify({ data: { results: [{ id: 144 }] } }),
          },
          {
            type: "text",
            text: JSON.stringify({ payload: { results: [{ id: 145 }] } }),
          },
        ],
      }),
    ).toEqual({ results: [{ id: 144 }, { id: 145 }] });
    expect(
      projectTwentyFirstToolPayload({
        structuredContent: { status: "safe-fallback" },
        content: [{ type: "text", text: "x".repeat(1_000_001) }],
      }),
    ).toEqual({ status: "safe-fallback" });
  });

  it("honors Retry-After once with a bounded delay for a read-only request", async () => {
    let listAttempts = 0;
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: string | number;
        method: string;
      };
      if (body.method === "initialize") {
        return jsonRpcResponse(body.id!, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "21st-test", version: "1.0.0" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") {
        listAttempts += 1;
        if (listAttempts === 1) {
          return new Response("busy", {
            status: 429,
            headers: { "retry-after": "99" },
          });
        }
        return jsonRpcResponse(body.id!, {
          tools: ["search", "get_component"].map((name) => ({
            name,
            inputSchema: { type: "object", properties: {} },
          })),
        });
      }
      throw new Error(`unexpected MCP method: ${body.method}`);
    });
    await expect(
      new TwentyFirstClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000,
        maxRetryAfterMs: 50,
        sleep,
      }).inspectCapabilities("21st_sk_test_secret"),
    ).resolves.toMatchObject({ ok: true });
    expect(listAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(50);
  });
});

describe("21st credential revocation guard", () => {
  it("does not retain a key for a terminal attention-required search", () => {
    expect(TWENTY_FIRST_ACTIVE_OPERATION_STATUSES).not.toContain(
      "attention_required",
    );
  });

  function executorWithQueryResults(results: unknown[][]) {
    let cursor = 0;
    return {
      select: vi.fn(() => {
        const result = results[cursor++] ?? [];
        const chain = {
          from: () => chain,
          where: () => chain,
          limit: () => chain,
          for: async () => result,
        };
        return chain;
      }),
    };
  }

  it("blocks revocation for a non-terminal 21st provider operation", async () => {
    const executor = executorWithQueryResults([[{ id: "operation" }], [], []]);
    await expect(
      hasActiveTwentyFirstConsumers([randomUUID()], executor),
    ).resolves.toBe(true);
  });

  it("allows revocation after provider operations and credential-bound builds are terminal", async () => {
    const executor = executorWithQueryResults([[], [], []]);
    await expect(
      hasActiveTwentyFirstConsumers([randomUUID()], executor),
    ).resolves.toBe(false);
  });

  it("defers revocation while a published board awaits customer selection", async () => {
    const executor = executorWithQueryResults([[], [], [{ id: "board" }]]);
    await expect(
      hasActiveTwentyFirstConsumers([randomUUID()], executor),
    ).resolves.toBe(true);
  });

  function revocationExecutor() {
    const updates: Record<string, unknown>[] = [];
    const selectChain = {
      from: () => selectChain,
      where: () => selectChain,
      for: async () => [
        { id: "active-credential", status: "active" },
        { id: "retired-credential", status: "retired" },
      ],
    };
    const updateChain = {
      set: (value: Record<string, unknown>) => {
        updates.push(value);
        return updateChain;
      },
      where: async () => undefined,
    };
    return {
      executor: {
        select: () => selectChain,
        update: () => updateChain,
      },
      updates,
    };
  }

  it("marks every retained version pending instead of shredding a live task key", async () => {
    const { executor, updates } = revocationExecutor();
    await expect(
      deleteTwentyFirstApiCredential(async () => true, executor),
    ).resolves.toEqual({ deleted: false, pending: true });
    expect(updates).toEqual([
      expect.objectContaining({ validationStatus: "invalid" }),
    ]);
    expect(updates[0]).not.toHaveProperty("encryptedKey");
  });

  it("cryptoshreds active and retired slot versions when no task consumes them", async () => {
    const { executor, updates } = revocationExecutor();
    await expect(
      deleteTwentyFirstApiCredential(async () => false, executor),
    ).resolves.toEqual({ deleted: true, pending: false });
    expect(updates).toEqual([
      expect.objectContaining({
        status: "deleted",
        validationStatus: "unverified",
        encryptedKey: expect.any(String),
        encryptionIv: expect.any(String),
        encryptionAuthTag: expect.any(String),
      }),
    ]);
  });

  it("automatically shreds only credentials already marked for revocation", async () => {
    const { executor, updates } = revocationExecutor();
    await expect(
      finalizePendingTwentyFirstCredentialRevocations(
        async () => false,
        executor,
      ),
    ).resolves.toEqual({ deleted: 2, pending: false });
    expect(updates).toEqual([
      expect.objectContaining({
        status: "deleted",
        encryptedKey: expect.any(String),
      }),
    ]);
  });
});
