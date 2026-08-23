import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  coverageForTarget,
  createEsaSiteOpsProviderHandler,
  packageEsaStaticAssets,
  type EsaDirectApi,
} from "./esa-provider";

const operation = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000002",
  userId: 7,
  kind: "deploy",
  input: {},
  result: null,
  providerOperationId: null,
  leaseOwner: "lease-1",
} as const;

const previousEnabled = process.env.FRONTMIND_ESA_ENABLED;
const previousInstanceId = process.env.FRONTMIND_ESA_INSTANCE_ID;
const previousAccessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
const previousAccessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;

function enableEsaTestRuntime() {
  process.env.FRONTMIND_ESA_ENABLED = "1";
  process.env.FRONTMIND_ESA_INSTANCE_ID = "esa-test-instance";
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = "test-access-key-id";
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = "test-access-key-secret";
}

afterEach(() => {
  if (previousEnabled === undefined) delete process.env.FRONTMIND_ESA_ENABLED;
  else process.env.FRONTMIND_ESA_ENABLED = previousEnabled;
  if (previousInstanceId === undefined)
    delete process.env.FRONTMIND_ESA_INSTANCE_ID;
  else process.env.FRONTMIND_ESA_INSTANCE_ID = previousInstanceId;
  if (previousAccessKeyId === undefined)
    delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  else process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = previousAccessKeyId;
  if (previousAccessKeySecret === undefined)
    delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  else process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = previousAccessKeySecret;
  vi.restoreAllMocks();
});

describe("direct ESA SiteOps provider", () => {
  it.each([
    ["global_excluding_cn", "overseas"],
    ["mainland_cn", "domestic"],
  ] as const)("maps %s to the exact ESA coverage %s", (target, coverage) => {
    expect(coverageForTarget(target)).toBe(coverage);
  });

  it("does not fabricate a deployment when the direct adapter is disabled", async () => {
    delete process.env.FRONTMIND_ESA_ENABLED;
    const getDb = vi.fn();
    const handler = createEsaSiteOpsProviderHandler({ getDb: getDb as never });

    const result = await handler({
      operation: operation as never,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "attention_required",
      code: "ESA_RUNTIME_DISABLED",
    });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("keeps unexpected ESA failures out of the customer-visible message", async () => {
    enableEsaTestRuntime();
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi
        .fn()
        .mockRejectedValue(
          new Error("internal path /app/private and provider payload"),
        ) as never,
    });

    const result = await handler({
      operation: operation as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "attention_required",
      code: "ESA_PROVIDER_FAILED",
    });
    expect(result.message).not.toContain("/app/private");
    expect(result.message).not.toContain("provider payload");
  });

  it("repackages a frozen dist as ESA assets and adds an exact digest marker", async () => {
    const dist = new JSZip();
    dist.file("index.html", "<!doctype html><title>FrontMind</title>");
    dist.file("assets/app.css", "body{color:#111}");
    const distZip = await dist.generateAsync({ type: "nodebuffer" });
    const hash = "a".repeat(64);

    const packaged = await packageEsaStaticAssets({
      distZip,
      deploymentId: operation.id,
      distHash: hash,
    });
    const parsed = await JSZip.loadAsync(packaged);

    expect(Object.keys(parsed.files).sort()).toEqual([
      "assets/",
      "assets/assets/",
      "assets/assets/app.css",
      "assets/frontmind-deployment.json",
      "assets/index.html",
    ]);
    expect(await parsed.file("assets/index.html")!.async("string")).toContain(
      "FrontMind",
    );
    expect(
      JSON.parse(
        await parsed
          .file("assets/frontmind-deployment.json")!
          .async("string"),
      ),
    ).toEqual({
      schemaVersion: 2,
      deploymentId: operation.id,
      distSha256: hash,
    });
  });

  it("rejects a customer dist that collides with the deployment marker", async () => {
    const dist = new JSZip();
    dist.file("index.html", "ok");
    dist.file("frontmind-deployment.json", "forged");
    const distZip = await dist.generateAsync({ type: "nodebuffer" });

    await expect(
      packageEsaStaticAssets({
        distZip,
        deploymentId: operation.id,
        distHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "ESA_DIST_PATH_INVALID" });
  });

  it("freezes a QA-passed production dist before the first ESA mutation", async () => {
    enableEsaTestRuntime();
    const digest = (value: Buffer | string) =>
      createHash("sha256").update(value).digest("hex");
    const sourceZip = Buffer.from("frozen preview source", "utf8");
    const sourceHash = digest(sourceZip);
    const previewDistHash = "3".repeat(64);
    const productionDist = Buffer.from("production dist", "utf8");
    const productionSource = Buffer.from("production source", "utf8");
    const qaZip = Buffer.from("production qa", "utf8");
    const provenanceJson = Buffer.from("{}\n", "utf8");
    const contract = {
      schemaVersion: 2,
      source: {
        knowledgeSnapshotId: "11000000-0000-4000-8000-000000000011",
        archiveSha256: "4".repeat(64),
        sourceBuildId: null,
        sourceBuildRevision: null,
      },
      workflow: {
        upstreamSha256: "5".repeat(64),
        version: "1.2.0",
        manifestSha256: "6".repeat(64),
        starterVersion: "1.2.0",
        starterSha256: "b".repeat(64),
        componentLibraryVersion: "1.0.0",
        materializerVersion: "1.0.0",
        materializerSha256: "c".repeat(64),
      },
      identity: {
        companyName: "FrontMind Test",
        primaryLanguage: "zh-CN",
        verifiedContacts: [],
      },
      visual: {
        queryHash: "7".repeat(64),
        selectedCandidateId: "sample-B",
        providerItemKey: "n:143",
        visualEvidenceSha256: "8".repeat(64),
        previewSha256: "9".repeat(64),
        supportEvidenceSha256s: [],
        taxonomy: {
          role: "foundation",
          palette: [],
          typography: [],
          layout: [],
          motion: [],
          accessibility: [],
        },
        designSpecHash: "d".repeat(64),
        componentLibraryVersion: "1.0.0",
      },
      routes: [
        {
          id: "home",
          slug: "/",
          title: "首页",
          sourceDocumentIds: ["doc-1"],
        },
      ],
      assets: [],
      seo: {
        siteTitle: "FrontMind Test",
        description: "经过知识来源核验的企业官网。",
        organizationType: "Organization",
        environment: "production",
        canonicalPolicy: "exact_https_origin",
      },
      target: {
        environment: "global_excluding_cn",
        canonicalOrigin: "https://example.com",
      },
      qaPolicyVersion: "siteops-qa-v1",
      specHash: "a".repeat(64),
    };
    const contractJson = Buffer.from(`${JSON.stringify(contract)}\n`, "utf8");
    const output = {
      contractJson,
      contractSha256: digest(contractJson),
      sourceZip: productionSource,
      sourceSha256: digest(productionSource),
      distZip: productionDist,
      distSha256: digest(productionDist),
      qaZip,
      qaSha256: digest(qaZip),
      qaReport: {
        schemaVersion: 1 as const,
        policyVersion: "siteops-qa-v1",
        passed: true as const,
        mode: "production" as const,
        routes: ["/"],
        checks: [
          { id: "production-canonical", passed: true as const, detail: "ok" },
        ],
        browser: {
          lighthouse: {
            performance: 100,
            accessibility: 100,
            bestPractices: 100,
            seo: 100,
            cls: 0,
          },
          axeViolationCount: 0,
          screenshotFiles: ["390.png", "768.png", "1440.png"],
        },
        fileCount: 5,
        totalBytes: productionDist.length,
      },
      provenanceJson,
      provenanceSha256: digest(provenanceJson),
    };
    const deployment: any = {
      id: "12000000-0000-4000-8000-000000000012",
      userId: operation.userId,
      projectId: operation.projectId,
      operationId: operation.id,
      buildId: "13000000-0000-4000-8000-000000000013",
      target: "global_excluding_cn",
      intent: "deploy",
      status: "reserved",
      distLocalAssetId: "14000000-0000-4000-8000-000000000014",
      distHash: previewDistHash,
      verification: null,
    };
    const project = {
      id: operation.projectId,
      userId: operation.userId,
      canonicalHostname: "example.com",
    };
    const build = {
      id: deployment.buildId,
      projectId: operation.projectId,
      userId: operation.userId,
      sourceLocalAssetId: "15000000-0000-4000-8000-000000000015",
      sourceHash,
    };
    const joinedQuery: any = {
      innerJoin: vi.fn(),
      where: vi.fn(() => ({
        limit: vi.fn().mockImplementation(async () => [
          { deployment, project, build },
        ]),
      })),
    };
    joinedQuery.innerJoin.mockReturnValue(joinedQuery);
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => joinedQuery) })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          Object.assign(deployment, values);
          return { where: updateWhere };
        }),
      })),
    };
    const api = {
      getRoutine: vi.fn(),
      createRoutine: vi.fn(),
      listCodeVersions: vi.fn(),
      getCodeVersion: vi.fn(),
      createAssetsCodeVersion: vi.fn(),
      createProductionDeployment: vi.fn(),
      listSites: vi.fn(),
      createSite: vi.fn(),
      updateSiteCoverage: vi.fn(),
      verifySite: vi.fn(),
      getMatchSite: vi.fn(),
      listRelatedRecords: vi.fn(),
      createRelatedRecord: vi.fn(),
      listEdgeRoutineRecords: vi.fn(),
    } satisfies EsaDirectApi;
    const artifactIds = [
      "16000000-0000-4000-8000-000000000016",
      "17000000-0000-4000-8000-000000000017",
      "18000000-0000-4000-8000-000000000018",
      "19000000-0000-4000-8000-000000000019",
      "20000000-0000-4000-8000-000000000020",
    ];
    const persistArtifact = vi.fn(async (input: { buffer: Buffer }) => ({
      id: artifactIds[persistArtifact.mock.calls.length - 1],
      contentSha256: digest(input.buffer),
    }));
    const materializeProduction = vi.fn().mockResolvedValue(output);
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
      readArtifact: vi.fn().mockResolvedValue({
        row: { sizeBytes: sourceZip.length },
        stored: { createReadStream: () => Readable.from(sourceZip) },
      }) as never,
      persistArtifact: persistArtifact as never,
      materializeProduction,
    });

    const signal = new AbortController().signal;
    const result = await handler({
      operation: { ...operation, attempt: 1 } as never,
      signal,
    });

    expect(result).toMatchObject({
      status: "pending",
      result: {
        stage: "production_materialized",
        productionDistHash: output.distSha256,
      },
    });
    expect(materializeProduction).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSourceSha256: sourceHash,
        canonicalOrigin: "https://example.com",
        target: "global_excluding_cn",
        abortSignal: signal,
      }),
    );
    expect(persistArtifact).toHaveBeenCalledTimes(5);
    expect(deployment.distHash).toBe(output.distSha256);
    expect(deployment.distHash).not.toBe(previewDistHash);
    expect(deployment.verification.productionMaterialization).toMatchObject({
      canonicalOrigin: "https://example.com",
      distSha256: output.distSha256,
      qaSha256: output.qaSha256,
    });
    expect(api.getRoutine).not.toHaveBeenCalled();
    expect(api.createRoutine).not.toHaveBeenCalled();
    expect(api.createAssetsCodeVersion).not.toHaveBeenCalled();
  });

  it("reconciles an exact production code version without submitting it again", async () => {
    enableEsaTestRuntime();
    const distHash = "c".repeat(64);
    const sourceHash = "d".repeat(64);
    const sourceLocalAssetId = "40000000-0000-4000-8000-000000000004";
    const distLocalAssetId = "50000000-0000-4000-8000-000000000005";
    const deployment = {
      id: "30000000-0000-4000-8000-000000000003",
      userId: 7,
      projectId: operation.projectId,
      operationId: operation.id,
      buildId: "60000000-0000-4000-8000-000000000006",
      distLocalAssetId,
      distHash,
      target: "global_excluding_cn",
      intent: "deploy",
      verification: {
        productionMaterialization: {
          schemaVersion: 1,
          canonicalOrigin: "https://example.com",
          target: "global_excluding_cn",
          sourceLocalAssetId,
          sourceSha256: sourceHash,
          contractLocalAssetId:
            "70000000-0000-4000-8000-000000000007",
          contractSha256: "e".repeat(64),
          productionSourceLocalAssetId:
            "80000000-0000-4000-8000-000000000008",
          productionSourceSha256: "f".repeat(64),
          distLocalAssetId,
          distSha256: distHash,
          qaLocalAssetId: "90000000-0000-4000-8000-000000000009",
          qaSha256: "1".repeat(64),
          provenanceLocalAssetId:
            "a0000000-0000-4000-8000-00000000000a",
          provenanceSha256: "2".repeat(64),
          qaPolicyVersion: "siteops-qa-v1",
          materializedAt: "2026-08-22T00:00:00.000Z",
        },
      },
    };
    const project = {
      id: operation.projectId,
      userId: 7,
      canonicalHostname: "example.com",
    };
    const build = {
      id: deployment.buildId,
      projectId: operation.projectId,
      userId: 7,
      sourceLocalAssetId,
      sourceHash,
    };
    const getRoutine = vi.fn().mockResolvedValue({
      name: "frontmind-20000000000040008000000000000000",
      hasAssets: true,
      defaultRelatedRecord: null,
      production: {
        deploymentId: "esa-deployment-9",
        codeVersions: [{ codeVersion: "version-9", percentage: 100 }],
      },
    });
    const createProductionDeployment = vi.fn();
    const materializeProduction = vi.fn();
    const updateSiteCoverage = vi.fn();
    const matchedSite = {
      siteId: 99,
      siteName: "example.com",
      status: "active",
      accessType: "CNAME",
      coverage: "global",
      verifyCode: null,
      cnameZone: "example.com.cname-zone.test",
    };
    const api = {
      getRoutine,
      createRoutine: vi.fn(),
      listCodeVersions: vi.fn(),
      getCodeVersion: vi.fn().mockResolvedValue({
        codeVersion: "version-9",
        status: "Available",
        description: null,
        extraInfo: null,
        hasAssets: true,
      }),
      createAssetsCodeVersion: vi.fn(),
      createProductionDeployment,
      listSites: vi.fn(),
      createSite: vi.fn(),
      updateSiteCoverage,
      verifySite: vi.fn(),
      getMatchSite: vi
        .fn()
        .mockResolvedValueOnce(matchedSite)
        .mockResolvedValue({ ...matchedSite, coverage: "overseas" }),
      listRelatedRecords: vi
        .fn()
        .mockResolvedValue([{ recordName: "example.com", siteId: 99 }]),
      createRelatedRecord: vi.fn(),
      listEdgeRoutineRecords: vi.fn(),
    } satisfies EsaDirectApi;
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const joinedQuery: any = {
      innerJoin: vi.fn(),
      where: vi.fn(() => ({
        limit: vi
          .fn()
          .mockResolvedValue([{ deployment, project, build }]),
      })),
    };
    joinedQuery.innerJoin.mockReturnValue(joinedQuery);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => joinedQuery),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: updateWhere })),
      })),
    };
    const html = `${" ".repeat(120)}<link href="https://example.com/" rel="canonical">`;
    const publicHttpsFetch = vi
      .fn()
      .mockResolvedValueOnce(
        {
          response: new Response(
            JSON.stringify({
              schemaVersion: 2,
              deploymentId: deployment.id,
              distSha256: distHash,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
          finalUrl: new URL(
            `https://example.com/frontmind-deployment.json`,
          ),
        },
      )
      .mockResolvedValueOnce(
        {
          response: new Response(html, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
          finalUrl: new URL("https://example.com/"),
        },
      );
    const handler = createEsaSiteOpsProviderHandler({
      getDb: vi.fn().mockResolvedValue(db) as never,
      api,
      materializeProduction,
      publicHttpsFetch: publicHttpsFetch as never,
    });

    const result = await handler({
      operation: {
        ...operation,
        attempt: 3,
        result: { stage: "version_processing", codeVersion: "version-9" },
      } as never,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      providerOperationId: "esa-deployment-9",
      result: { distHash, codeVersion: "version-9" },
    });
    expect(createProductionDeployment).not.toHaveBeenCalled();
    expect(updateSiteCoverage).toHaveBeenCalledWith({
      siteId: 99,
      coverage: "overseas",
    });
    expect(materializeProduction).not.toHaveBeenCalled();
    expect(publicHttpsFetch).toHaveBeenCalledTimes(2);
    expect(publicHttpsFetch.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        url: "https://example.com/frontmind-deployment.json",
        allowedOrigin: "https://example.com",
        maxRedirects: 2,
      }),
      expect.objectContaining({
        url: "https://example.com/",
        allowedOrigin: "https://example.com",
        maxRedirects: 2,
      }),
    ]);
    expect(updateWhere).toHaveBeenCalled();
  });
});
