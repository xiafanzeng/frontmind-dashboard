import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import type {
  KnowledgeBaseSnapshot,
  SiteOperation,
  SiteProject,
} from "../../drizzle/schema";
import type { SiteBrief } from "../../shared/siteops";
import {
  TwentyFirstToolContractError,
  type TwentyFirstReadOnlySession,
} from "../twenty-first-service";
import {
  createTwentyFirstSiteOpsProviderHandler,
  type TwentyFirstBoardPersistenceInput,
  type TwentyFirstProviderContext,
} from "./twenty-first-provider";
import {
  fetchPinnedPublicHttps,
  fetchSafeVisualPreview,
  isPublicPreviewAddress,
  lookupForPinnedPreviewAddress,
  pinnedHttpsFetch,
  pinnedPreviewRequestOptions,
  responseFromPinnedPreviewIncoming,
  samePreviewAddress,
} from "./remote-preview";

const credentialId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";

function operation(): SiteOperation {
  const now = new Date();
  return {
    id: operationId,
    projectId,
    userId: 7,
    conversationTurnId: null,
    buildId: null,
    kind: "visual_search",
    status: "running",
    clientRequestId: "request-visual-search",
    inputHash: "a".repeat(64),
    input: {
      knowledgeSnapshotId: snapshotId,
      credentialId,
      credentialVersion: 3,
      workflowVersion: "1.3.0",
    },
    provider: "21st",
    providerOperationId: null,
    providerTaskId: null,
    leaseOwner: "lease",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    attempt: 1,
    result: null,
    errorCode: null,
    errorMessage: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function providerContext(): TwentyFirstProviderContext {
  const now = new Date();
  const brief: SiteBrief = {
    companyName: "FrontMind",
    primaryLanguage: "zh-CN",
    contacts: [],
    offerings: ["GEO Analytics"],
    audience: ["B2B marketing teams"],
    conversionGoal: "Book a demo",
    routes: [
      {
        id: "home",
        slug: "/",
        title: "Home",
        sourceDocumentIds: ["doc-1"],
      },
    ],
    verifiedFacts: [],
    publicAssetIds: [],
    unknowns: [],
  };
  return {
    project: {
      id: projectId,
      userId: 7,
      conversationId: "siteops:7",
      currentKnowledgeSnapshotId: snapshotId,
      currentBuildId: null,
      globalLiveDeploymentId: null,
      mainlandLiveDeploymentId: null,
      primaryLanguage: "zh-CN",
      canonicalHostname: null,
      status: "visual_searching",
      brief,
      revision: 4,
      createdAt: now,
      updatedAt: now,
    } satisfies SiteProject,
    snapshot: {
      id: snapshotId,
      userId: 7,
      version: 2,
      sourceFileName: "frontmind.zip",
      sourceConversationId: null,
      sourceBuildId: null,
      sourceBuildRevision: null,
      sourceTaskId: null,
      sourceArtifactHash: null,
      archiveHash: "b".repeat(64),
      maintenanceTicketId: null,
      documents: [],
      assets: [],
      documentCount: 0,
      imageCount: 0,
      characterCount: 0,
      totalBytes: 1,
      status: "active",
      createdByUserId: 7,
      createdAt: now,
    } satisfies KnowledgeBaseSnapshot,
    brief,
    existingBoard: null,
  };
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("21st SiteOps provider", () => {
  it("reuses a board already committed for the same leased operation", async () => {
    const getCredential = vi.fn();
    const client = { withReadOnlySession: vi.fn() };
    const persistArtifact = vi.fn();
    const persistBoard = vi.fn();
    const context = providerContext();
    context.existingBoard = {
      batchId: "55555555-5555-4555-8555-555555555555",
      candidateCount: 7,
      selectionBundleHash: "c".repeat(64),
    };
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => context,
      getCredential,
      client,
      persistArtifact: persistArtifact as never,
      persistBoard,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: {
        batchId: "55555555-5555-4555-8555-555555555555",
        candidateCount: 7,
      },
    });
    expect(getCredential).not.toHaveBeenCalled();
    expect(client.withReadOnlySession).not.toHaveBeenCalled();
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(persistBoard).not.toHaveBeenCalled();
  });

  it("runs the real numeric-ID 5/5/6/2 search-only funnel without component code", async () => {
    const secret = "21st_sk_never-persist-this-secret";
    const rawCode = "RAW_PROVIDER_CODE export default function Secret() {}";
    const searchCalls: Array<{
      query: string;
      type: "component";
      limit: number;
    }> = [];
    const detailCalls: Array<string | number> = [];
    let searchIndex = 0;
    const counts = [5, 5, 6, 2];
    let nextId = 1;
    const session: TwentyFirstReadOnlySession = {
      search: vi.fn(async (input) => {
        const count = counts[searchIndex]!;
        searchIndex += 1;
        searchCalls.push(input);
        return {
          results: Array.from({ length: count }, (_, index) => {
            const id = nextId++;
            return {
              id,
              name: `Responsive modular hero ${id}`,
              description: "Light canvas, neutral sans, short transition",
              previewUrl: `https://cdn.example.test/${id}.png`,
              videoUrl: `https://cdn.example.test/${id}.mp4`,
              installCommand: "npx 21st add forbidden",
              componentCode: rawCode,
              demoCode: "RAW_DEMO_CODE",
            };
          }),
        };
      }),
      getComponent: vi.fn(async (providerItemId) => {
        detailCalls.push(providerItemId);
        return {
          data: {
            id: providerItemId,
            componentId: providerItemId,
            name: `Responsive modular hero ${providerItemId}`,
            description: "Light canvas, neutral sans, short transition",
            previewUrl: `https://cdn.example.test/${providerItemId}.png`,
            componentCode: rawCode,
            demoCode: "RAW_DEMO_CODE",
            installCommand: "npx 21st add forbidden",
          },
        };
      }),
    };
    const client = {
      withReadOnlySession: vi.fn(
        async <T>(
          apiKey: string,
          use: (active: TwentyFirstReadOnlySession) => Promise<T>,
        ) => {
          expect(apiKey).toBe(secret);
          return use(session);
        },
      ),
    };
    const artifacts: Array<{
      kind: string;
      buffer: Buffer;
      id: string;
      contentSha256: string;
    }> = [];
    const persistArtifact = vi.fn(
      async (input: { kind: string; buffer: Buffer }) => {
        const row = {
          kind: input.kind,
          buffer: Buffer.from(input.buffer),
          id: randomUUID(),
          contentSha256: sha256(input.buffer),
        };
        artifacts.push(row);
        return row as never;
      },
    );
    let persisted: TwentyFirstBoardPersistenceInput | null = null;
    const persistBoard = vi.fn(
      async (_db: unknown, input: TwentyFirstBoardPersistenceInput) => {
        persisted = input;
        return {
          batchId: "55555555-5555-4555-8555-555555555555",
          candidateCount: input.mirroredCandidates.length,
          selectionBundleHash: input.selectionBundleArtifact.contentSha256,
        };
      },
    );
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: secret,
      }),
      client,
      fetchPreview: vi.fn(async ({ url }) => {
        const buffer = Buffer.from(`safe-preview:${url}`, "utf8");
        return {
          finalUrl: url,
          mimeType: "image/png",
          buffer,
          width: 1200,
          height: 800,
          sha256: sha256(buffer),
        };
      }),
      persistArtifact: persistArtifact as never,
      persistBoard,
    });

    const result = await handler({
      operation: operation(),
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      projectStatus: "awaiting_visual_selection",
      result: {
        candidateCount: 9,
        actual: {
          searched: 18,
          shortlisted: 12,
          mirrored: 12,
          presented: 9,
        },
      },
    });
    expect(searchCalls.map((call) => call.limit)).toEqual([5, 5, 6, 2]);
    expect(searchCalls.every((call) => call.type === "component")).toBe(true);
    expect(searchCalls).toHaveLength(4);
    expect(detailCalls).toHaveLength(0);
    expect(persisted).not.toBeNull();
    expect(persisted!.mirroredCandidates).toHaveLength(9);
    expect(persisted!.selectionBundle).toMatchObject({
      schemaVersion: 2,
      searchTarget: 18,
      shortlistTarget: 12,
      displayTarget: 9,
    });
    expect(
      persisted!.selectionBundle.candidates.map((item) => item.label),
    ).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
    expect(persisted!.selectionBundle.supportingCandidates).toHaveLength(2);
    expect(persisted!.selectionBundle.candidates[0]).toMatchObject({
      providerItemKey: "n:1",
      visualEvidence: {
        evidenceKind: "catalog_metadata_preview_v1",
        providerItemKey: "n:1",
        taxonomyDerivationVersion: "catalog-metadata-preview-v1",
      },
    });
    const persistedText = JSON.stringify(persisted);
    const artifactText = Buffer.concat(
      artifacts.map((artifact) => artifact.buffer),
    ).toString("utf8");
    for (const sensitive of [secret, rawCode, "RAW_DEMO_CODE", "npx 21st"]) {
      expect(persistedText).not.toContain(sensitive);
      expect(artifactText).not.toContain(sensitive);
    }
    expect(
      artifacts.filter((artifact) => artifact.kind === "21st-visual-preview"),
    ).toHaveLength(12);
    expect(
      artifacts.filter((artifact) => artifact.kind === "21st-selection-bundle"),
    ).toHaveLength(1);
  });

  it("rejects producer drift before database or provider access", async () => {
    const getDb = vi.fn();
    const client = { withReadOnlySession: vi.fn() };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createTwentyFirstSiteOpsProviderHandler({ getDb, client });
    const drifted = operation();
    drifted.input = {
      ...drifted.input,
      manusCredentialId: "55555555-5555-4555-8555-555555555555",
    };

    await expect(
      handler({
        operation: drifted,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "VISUAL_OPERATION_CONTRACT_MISMATCH",
    });
    expect(getDb).not.toHaveBeenCalled();
    expect(client.withReadOnlySession).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[SiteOps21st] visual_search_failed",
      expect.objectContaining({
        operationId,
        projectId,
        stage: "validate_operation",
      }),
    );
    log.mockRestore();
  });

  it("classifies MCP schema drift and redacts the active credential in logs", async () => {
    const secret = "21st_sk_log-redaction-sentinel";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: secret,
      }),
      client: {
        withReadOnlySession: async () => {
          const error = new TwentyFirstToolContractError();
          error.message = `${error.message}: ${secret}`;
          throw error;
        },
      },
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "attention_required",
      code: "MCP_CONTRACT_INCOMPATIBLE",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(log).toHaveBeenCalledWith(
      "[SiteOps21st] visual_search_failed",
      expect.objectContaining({ stage: "mcp_retrieval" }),
    );
    log.mockRestore();
  });

  it("fails honestly when the real catalog yields no candidate", async () => {
    const persistArtifact = vi.fn();
    const persistBoard = vi.fn();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            search: async () => ({ results: [] }),
            getComponent: async () => {
              throw new Error("must not retrieve an empty pool");
            },
          }),
      },
      persistArtifact: persistArtifact as never,
      persistBoard,
    });

    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "MCP_SEARCH_EMPTY",
    });
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(persistBoard).not.toHaveBeenCalled();
  });

  it("distinguishes missing preview references from an empty catalog", async () => {
    let id = 0;
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            search: async () => ({
              results: [{ id: ++id, name: `Catalog item ${id}` }],
            }),
          }),
      },
    });
    await expect(
      handler({
        operation: operation(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "NO_SAFE_PREVIEW_REFERENCES",
      result: { normalizedUnique: 4, withPreviewReference: 0 },
    });
  });

  it("reports aggregate mirror diagnostics without leaking preview URLs", async () => {
    let id = 0;
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({
            search: async () => {
              const itemId = ++id;
              return {
                results: [
                  {
                    id: itemId,
                    name: `Catalog item ${itemId}`,
                    previewUrl: `https://cdn.example.test/${itemId}.png?token=secret`,
                  },
                ],
              };
            },
          }),
      },
      fetchPreview: vi.fn(async () => {
        throw new Error("PREVIEW_FETCH_FAILED");
      }),
    });
    const result = await handler({
      operation: operation(),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "failed",
      code: "PREVIEW_MIRROR_FAILED",
      result: {
        mirrorAttempted: 4,
        mirrorSucceeded: 0,
        rejectedByReason: { http: 4 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("maps an outer abort to VISUAL_SEARCH_TIMEOUT", async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = createTwentyFirstSiteOpsProviderHandler({
      getDb: async () => ({ fake: "db" }),
      loadContext: async () => providerContext(),
      getCredential: async () => ({
        id: credentialId,
        version: 3,
        fingerprint: "fingerprint",
        apiKey: "21st_sk_test_secret",
      }),
      client: {
        withReadOnlySession: async (_apiKey, use) =>
          use({ search: async () => ({ results: [] }) }),
      },
    });
    await expect(
      handler({ operation: operation(), signal: controller.signal }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "VISUAL_SEARCH_TIMEOUT",
    });
  });

  it("rejects private preview addresses before making an HTTP request", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchSafeVisualPreview({
        url: "https://127.0.0.1/private.png",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("PREVIEW_URL_PRIVATE_ADDRESS");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isPublicPreviewAddress("fec0::1")).toBe(false);
  });

  it("returns the Node 22 lookup array shape and disables automatic family selection", async () => {
    const selected = { address: "93.184.216.34", family: 4 as const };
    const options = pinnedPreviewRequestOptions({
      url: new URL("https://example.com/image.png?X-Amz-Signature=memory-only"),
      selected,
      signal: new AbortController().signal,
      headers: {},
    });
    expect(options).toMatchObject({
      agent: false,
      family: 4,
      autoSelectFamily: false,
      servername: "example.com",
    });
    const lookup = lookupForPinnedPreviewAddress(selected) as any;
    await expect(
      new Promise((resolve, reject) =>
        lookup(
          "example.com",
          { all: true },
          (error: Error | null, addresses: unknown) =>
            error ? reject(error) : resolve(addresses),
        ),
      ),
    ).resolves.toEqual([selected]);
    await expect(
      new Promise((resolve, reject) =>
        lookup(
          "example.com",
          { all: false },
          (error: Error | null, address: string, family: number) =>
            error ? reject(error) : resolve({ address, family }),
        ),
      ),
    ).resolves.toEqual(selected);
  });

  it.each([204, 205, 304])(
    "constructs a bodyless Response for HTTP %s without throwing",
    (status) => {
      const incoming = Object.assign(Readable.from([]), {
        statusCode: status,
        statusMessage: "No Body",
        headers: { "x-preview": "ok" },
      });
      const response = responseFromPinnedPreviewIncoming(incoming as never);
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.headers.get("x-preview")).toBe("ok");
    },
  );

  it("tries at most three pinned public addresses and stops after a response", async () => {
    const addresses = [
      { address: "1.1.1.1", family: 4 as const },
      { address: "8.8.8.8", family: 4 as const },
      { address: "9.9.9.9", family: 4 as const },
      { address: "208.67.222.222", family: 4 as const },
    ];
    const requestImpl = vi.fn(
      async ({ selected }: { selected: (typeof addresses)[number] }) => {
        if (selected.address !== "9.9.9.9") {
          const error = Object.assign(new Error("connect failed"), {
            code: "ECONNREFUSED",
          });
          throw error;
        }
        return new Response("ok", { status: 200 });
      },
    );
    await expect(
      pinnedHttpsFetch(
        {
          url: new URL("https://example.com/image.png"),
          addresses,
          signal: new AbortController().signal,
          headers: {},
        },
        requestImpl as never,
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(
      requestImpl.mock.calls.map(([input]) => input.selected.address),
    ).toEqual(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
  });

  it("treats an exact peer mismatch as terminal and normalizes mapped IPv4", async () => {
    expect(samePreviewAddress("93.184.216.34", "::ffff:5db8:d822")).toBe(true);
    const requestImpl = vi.fn(async () => {
      throw new Error("PREVIEW_CONNECTED_ADDRESS_UNSAFE");
    });
    await expect(
      pinnedHttpsFetch(
        {
          url: new URL("https://example.com/image.png"),
          addresses: [
            { address: "1.1.1.1", family: 4 },
            { address: "8.8.8.8", family: 4 },
          ],
          signal: new AbortController().signal,
          headers: {},
        },
        requestImpl as never,
      ),
    ).rejects.toThrow("PREVIEW_CONNECTED_ADDRESS_UNSAFE");
    expect(requestImpl).toHaveBeenCalledTimes(1);
  });

  it("normalizes provider images to metadata-free PNG before hashing", async () => {
    const upstream = await sharp({
      create: {
        width: 120,
        height: 60,
        channels: 3,
        background: { r: 24, g: 48, b: 96 },
      },
    })
      .withMetadata({ comment: "provider-private-metadata" })
      .png()
      .toBuffer();
    const result = await fetchSafeVisualPreview({
      url: "https://preview.example.com/example.png",
      resolveImpl: vi
        .fn()
        .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]) as never,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(upstream, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ) as unknown as typeof fetch,
    });

    expect(result.mimeType).toBe("image/png");
    expect((await sharp(result.buffer).metadata()).format).toBe("png");
    expect(result.buffer.toString("utf8")).not.toContain(
      "provider-private-metadata",
    );
    expect(result.sha256).toBe(sha256(result.buffer));
    expect(result.visualSignals.dominantHex).toMatch(/^#[a-f0-9]{6}$/u);
    expect(result.visualSignals.brightness).toBeLessThan(96);
  });

  it("rejects embedded private IPv4 across IPv6 transition formats", () => {
    expect(isPublicPreviewAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicPreviewAddress("::ffff:a9fe:a9fe")).toBe(false);
    expect(isPublicPreviewAddress("::ffff:0a00:0001")).toBe(false);
    expect(isPublicPreviewAddress("64:ff9b::7f00:1")).toBe(false);
    expect(isPublicPreviewAddress("::ffff:5db8:d822")).toBe(true);
    expect(isPublicPreviewAddress("93.184.216.34")).toBe(true);
    expect(isPublicPreviewAddress("2001:4860:4860::8888")).toBe(true);
  });

  it("re-resolves every pinned redirect and rejects a private next hop", async () => {
    const resolveImpl = vi
      .fn()
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const transport = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/internal" },
      }),
    );

    await expect(
      fetchPinnedPublicHttps({
        url: "https://example.com/start",
        signal: new AbortController().signal,
        maxRedirects: 2,
        resolveImpl: resolveImpl as never,
        transport,
      }),
    ).rejects.toThrow("PREVIEW_URL_PRIVATE_ADDRESS");
    expect(resolveImpl).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });

  it("keeps an ESA-style pinned redirect on the exact allowed origin", async () => {
    const resolveImpl = vi
      .fn()
      .mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }]);
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/final?signature=redirect-secret" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await fetchPinnedPublicHttps({
      url: "https://example.com/start",
      allowedOrigin: "https://example.com",
      signal: new AbortController().signal,
      maxRedirects: 2,
      resolveImpl: resolveImpl as never,
      transport,
    });

    expect(result.finalUrl.toString()).toBe("https://example.com/final");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.map(([call]) => call.url.toString())).toEqual([
      "https://example.com/start",
      "https://example.com/final?signature=redirect-secret",
    ]);
  });
});
