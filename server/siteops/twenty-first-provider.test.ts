import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type {
  KnowledgeBaseSnapshot,
  SiteOperation,
  SiteProject,
} from "../../drizzle/schema";
import type { SiteBrief } from "../../shared/siteops";
import type { TwentyFirstReadOnlySession } from "../twenty-first-service";
import {
  createTwentyFirstSiteOpsProviderHandler,
  type TwentyFirstBoardPersistenceInput,
  type TwentyFirstProviderContext,
} from "./twenty-first-provider";
import {
  fetchPinnedPublicHttps,
  fetchSafeVisualPreview,
  isPublicPreviewAddress,
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
      workflowVersion: "1.1.0",
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

  it("runs the real 10/6/2 catalog funnel and persists only the prompt-free safe projection", async () => {
    const secret = "21st_sk_never-persist-this-secret";
    const rawPrompt =
      "RAW_PROVIDER_PROMPT responsive modular hero neutral sans light canvas short transition";
    const rawCode = "RAW_PROVIDER_CODE export default function Secret() {}";
    const searchCalls: Array<{ query: string; limit: number }> = [];
    const detailCalls: string[] = [];
    let searchIndex = 0;
    const rolePrefixes = ["foundation", "section", "motion"];
    const counts = [10, 6, 2];
    const session: TwentyFirstReadOnlySession = {
      search: vi.fn(async (query, limit) => {
        const role = rolePrefixes[searchIndex]!;
        const count = counts[searchIndex]!;
        searchIndex += 1;
        searchCalls.push({ query, limit });
        return {
          results: Array.from({ length: count }, (_, index) => {
            const id = `${role}-${index + 1}`;
            return {
              id,
              name: `${role} candidate ${index + 1}`,
              sourceUrl: `https://21st.dev/community/components/${id}`,
              previewUrl: `https://cdn.example.test/${id}.png`,
            };
          }),
        };
      }),
      getComponent: vi.fn(async (providerItemId) => {
        detailCalls.push(providerItemId);
        return {
          data: {
            id: providerItemId,
            prompt: rawPrompt,
            code: rawCode,
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
    const persistArtifact = vi.fn(async (input: {
      kind: string;
      buffer: Buffer;
    }) => {
      const row = {
        kind: input.kind,
        buffer: Buffer.from(input.buffer),
        id: randomUUID(),
        contentSha256: sha256(input.buffer),
      };
      artifacts.push(row);
      return row as never;
    });
    let persisted: TwentyFirstBoardPersistenceInput | null = null;
    const persistBoard = vi.fn(
      async (_db: unknown, input: TwentyFirstBoardPersistenceInput) => {
        persisted = input;
        return {
          batchId: "55555555-5555-4555-8555-555555555555",
          candidateCount: input.mirroredCandidates.length,
          selectionBundleHash:
            input.selectionBundleArtifact.contentSha256,
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
        actual: { searched: 18, promptRetrieved: 12, presented: 9 },
      },
    });
    expect(searchCalls.map((call) => call.limit)).toEqual([10, 6, 2]);
    expect(searchCalls).toHaveLength(3);
    expect(detailCalls).toHaveLength(12);
    expect(detailCalls.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, index) => `foundation-${index + 1}`),
    );
    expect(persisted).not.toBeNull();
    expect(persisted!.mirroredCandidates).toHaveLength(9);
    expect(persisted!.selectionBundle.candidates.map((item) => item.label)).toEqual(
      ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
    );
    const persistedText = JSON.stringify(persisted);
    const artifactText = Buffer.concat(
      artifacts.map((artifact) => artifact.buffer),
    ).toString("utf8");
    for (const sensitive of [secret, rawPrompt, rawCode]) {
      expect(persistedText).not.toContain(sensitive);
      expect(artifactText).not.toContain(sensitive);
    }
    expect(artifacts.filter((artifact) => artifact.kind === "21st-visual-preview"))
      .toHaveLength(9);
    expect(artifacts.filter((artifact) => artifact.kind === "21st-selection-bundle"))
      .toHaveLength(1);
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
      code: "ZERO_VISUAL_CANDIDATES",
    });
    expect(persistArtifact).not.toHaveBeenCalled();
    expect(persistBoard).not.toHaveBeenCalled();
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
  });

  it("rejects embedded private IPv4 across IPv6 transition formats", () => {
    expect(isPublicPreviewAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicPreviewAddress("::ffff:a9fe:a9fe")).toBe(false);
    expect(isPublicPreviewAddress("::ffff:0a00:0001")).toBe(false);
    expect(isPublicPreviewAddress("64:ff9b::7f00:1")).toBe(false);
    expect(isPublicPreviewAddress("93.184.216.34")).toBe(true);
    expect(isPublicPreviewAddress("2001:4860:4860::8888")).toBe(true);
  });

  it("re-resolves every pinned redirect and rejects a private next hop", async () => {
    const resolveImpl = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]);
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
    const resolveImpl = vi.fn().mockResolvedValue([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/final" } }),
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
    expect(
      transport.mock.calls.map(([call]) => call.url.toString()),
    ).toEqual([
      "https://example.com/start",
      "https://example.com/final",
    ]);
  });
});
